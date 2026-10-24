use serde::ser::SerializeStruct;

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Which part of a database connection failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DbStage {
    /// TCP connection to the server.
    Network,
    /// TLS / SSL negotiation or certificate.
    Tls,
    /// User, password or host-based access rules.
    Auth,
    /// The database itself (missing, or no access).
    Database,
}

/// Error text including its causes ("error performing TLS handshake: certificate expired").
pub(crate) fn chain(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut cur = e.source();
    while let Some(c) = cur {
        let part = c.to_string();
        if !s.contains(&part) {
            s.push_str(": ");
            s.push_str(&part);
        }
        cur = c.source();
    }
    s
}

/// What the server said about a failed statement, with every field it sent.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbError {
    /// `postgres` or `mysql`.
    pub engine: &'static str,
    /// MySQL error number (`1054`). Postgres has none; its code is `sqlstate`.
    pub code: Option<u16>,
    /// Five-character SQLSTATE (`42S22`, `42703`).
    pub sqlstate: Option<String>,
    /// Postgres severity (`ERROR`, `FATAL`).
    pub severity: Option<String>,
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
    /// 1-based character position in the statement that was sent (Postgres).
    pub position: Option<u32>,
}

impl std::fmt::Display for DbError {
    /// The way the command-line clients print it:
    /// `ERROR 1054 (42S22): Unknown column 'x' in 'field list'` / `ERROR:  column "x" does not exist`.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match (self.code, &self.sqlstate) {
            (Some(code), Some(state)) => write!(f, "ERROR {code} ({state}): {}", self.message),
            (Some(code), None) => write!(f, "ERROR {code}: {}", self.message),
            _ => write!(f, "{}:  {}", self.severity.as_deref().unwrap_or("ERROR"), self.message),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Config(String),

    #[error("Saved passwords: {0}")]
    Secret(String),

    #[error("SSH {host}: {message}")]
    Ssh { host: String, message: String },

    #[error("{host}:{port} sent key {fingerprint}, which does not match ~/.ssh/known_hosts line {line}.")]
    HostKeyChanged {
        host: String,
        port: u16,
        line: usize,
        fingerprint: String,
        /// The new key in OpenSSH format, passed back to `replace_host_key`.
        key: String,
    },

    /// A database connect failure, with the part that failed.
    #[error("{message}")]
    DbConnect { stage: DbStage, message: String },

    #[error("{0}")]
    Postgres(String),

    #[error("{0}")]
    Mysql(String),

    #[error("Timed out: {0}")]
    Timeout(String),

    /// A connect failure, tagged with the step that failed.
    #[error("{step}: {source}")]
    Step { step: String, hint: Option<String>, source: Box<Error> },

    /// An error reported by the database server for a statement, with its code.
    #[error("{0}")]
    Db(Box<DbError>),

    #[error("This session is closed")]
    NoSession,

    /// The connection dropped: the Mac slept, the network changed, or the server restarted.
    #[error("The connection to the server was lost: {0}")]
    ConnectionLost(String),

    /// The connection dropped while a statement that may change data ran: it is not sent twice.
    #[error("The connection dropped while this ran. Check whether the change was made before running it again.")]
    Interrupted,

    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl Error {
    /// The underlying error, without step context.
    pub fn root(&self) -> &Error {
        match self {
            Error::Step { source, .. } => source.root(),
            e => e,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Error::Step { source, .. } => source.kind(),
            Error::Config(_) => "config",
            Error::Secret(_) => "secret",
            Error::Ssh { .. } => "ssh",
            Error::HostKeyChanged { .. } => "hostKeyChanged",
            Error::Postgres(_) | Error::Mysql(_) | Error::DbConnect { .. } | Error::Db(_) => "database",
            Error::Timeout(_) => "timeout",
            Error::NoSession => "noSession",
            Error::ConnectionLost(_) => "connectionLost",
            Error::Interrupted => "interrupted",
            Error::Io(_) => "io",
        }
    }

    pub(crate) fn ssh(host: &str, e: impl std::fmt::Display) -> Self {
        Error::Ssh { host: host.to_string(), message: e.to_string() }
    }
}

/// Errors cross the Tauri bridge as `{ kind, message, step?, hint?, db?, host?, port?, fingerprint?, key? }`.
impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("Error", 8)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        if let Error::Step { step, hint, .. } = self {
            st.serialize_field("step", step)?;
            st.serialize_field("hint", hint)?;
        }
        if let Error::Db(db) = self.root() {
            st.serialize_field("db", db.as_ref())?;
        }
        if let Error::HostKeyChanged { host, port, fingerprint, key, .. } = self.root() {
            st.serialize_field("host", host)?;
            st.serialize_field("port", port)?;
            st.serialize_field("fingerprint", fingerprint)?;
            st.serialize_field("key", key)?;
        }
        st.end()
    }
}

impl From<tokio_postgres::Error> for Error {
    fn from(e: tokio_postgres::Error) -> Self {
        use tokio_postgres::error::Severity;
        // FATAL ends the session: an admin ended it, the server is shutting down, a timeout hit.
        let ended =
            e.as_db_error().filter(|db| matches!(db.parsed_severity(), Some(Severity::Fatal | Severity::Panic)));
        if let Some(db) = ended {
            return Error::ConnectionLost(db.message().to_string());
        }
        if e.is_closed() {
            return Error::ConnectionLost(chain(&e));
        }
        // Keep everything the server sent: SQLSTATE, detail, hint and where in the statement.
        match e.as_db_error() {
            Some(db) => Error::Db(Box::new(DbError {
                engine: "postgres",
                code: None,
                sqlstate: Some(db.code().code().to_string()),
                severity: Some(db.severity().to_string()),
                message: db.message().to_string(),
                detail: db.detail().map(str::to_owned),
                hint: db.hint().map(str::to_owned),
                position: match db.position() {
                    Some(tokio_postgres::error::ErrorPosition::Original(p)) => Some(*p),
                    _ => None,
                },
            })),
            None => Error::Postgres(chain(&e)),
        }
    }
}

impl From<mysql_async::Error> for Error {
    fn from(e: mysql_async::Error) -> Self {
        match e {
            mysql_async::Error::Server(s) => Error::Db(Box::new(DbError {
                engine: "mysql",
                code: Some(s.code),
                sqlstate: Some(s.state).filter(|st| !st.is_empty()),
                severity: None,
                message: s.message,
                detail: None,
                hint: None,
                position: None,
            })),
            lost @ (mysql_async::Error::Io(_)
            | mysql_async::Error::Driver(mysql_async::DriverError::ConnectionClosed)) => {
                Error::ConnectionLost(lost.to_string())
            }
            other => Error::Mysql(other.to_string()),
        }
    }
}
