//! Tauri shell: owns app state and exposes the core crate to the UI as commands.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod menu;

use oneclient_core::edit::RowEdit;
use oneclient_core::link::{parse_link, IncomingConnection};
use oneclient_core::secrets::{ProfileSecrets, SecretField, SecretStore};
use oneclient_core::steps::{Step, StepStatus};
use oneclient_core::{
    tunnel, Canvas, ConnectionProfile, ConnectionStore, DiagramStore, EnvironmentDef, EnvironmentStore, Error,
    HistoryEntry, QueryOutput, QueryStore, SavedQuery, SecretsInput, Session, SessionInfo, TableInfo, TestReport,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

type CmdResult<T> = Result<T, Error>;

struct AppState {
    store: Mutex<ConnectionStore>,
    environments: Mutex<EnvironmentStore>,
    queries: Mutex<QueryStore>,
    diagrams: Mutex<DiagramStore>,
    secrets: SecretStore,
    sessions: RwLock<HashMap<Uuid, Arc<Session>>>,
    /// Connections opened from links: kept in memory only, until the user saves them.
    temp: std::sync::Mutex<HashMap<Uuid, IncomingConnection>>,
    /// Links received but not yet picked up by the window.
    pending: std::sync::Mutex<Vec<LinkEvent>>,
    /// Last link and when, so one link delivered twice at launch opens once.
    last_link: std::sync::Mutex<Option<(String, Instant)>>,
}

/// What the window gets for each received link. Never contains the password.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkEvent {
    profile: Option<ConnectionProfile>,
    error: Option<String>,
}

impl AppState {
    async fn session(&self, id: Uuid) -> CmdResult<Arc<Session>> {
        self.sessions.read().await.get(&id).cloned().ok_or(Error::NoSession)
    }
}

// ---------- Links from other apps ----------

/// Accept a connection link (oneclient://open?url=…, postgresql://…, mysql://…).
fn handle_link(app: &AppHandle, link: &str) {
    let state = app.state::<AppState>();
    {
        let mut last = state.last_link.lock().unwrap();
        if let Some((prev, at)) = last.as_ref() {
            if prev == link && at.elapsed() < Duration::from_secs(3) {
                return;
            }
        }
        *last = Some((link.to_string(), Instant::now()));
    }
    // The link itself is never logged: it may hold a password.
    let event = match parse_link(link) {
        Ok(incoming) => {
            let profile = incoming.profile.clone();
            state.temp.lock().unwrap().insert(profile.id, incoming);
            LinkEvent { profile: Some(profile), error: None }
        }
        Err(e) => LinkEvent { profile: None, error: Some(e.to_string()) },
    };
    state.pending.lock().unwrap().push(event);
    let _ = app.emit("links-pending", ());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Links received so far; the window calls this on start and on the "links-pending" event.
#[tauri::command]
fn take_pending_links(state: State<'_, AppState>) -> Vec<LinkEvent> {
    std::mem::take(&mut *state.pending.lock().unwrap())
}

/// Keep a connection that came from a link: save it with its password.
#[tauri::command]
async fn save_temp_connection(state: State<'_, AppState>, id: Uuid) -> CmdResult<ConnectionProfile> {
    let incoming = state
        .temp
        .lock()
        .unwrap()
        .remove(&id)
        .ok_or_else(|| Error::Config("This connection is already saved or closed".into()))?;
    let profile = incoming.profile;
    let input = SecretsInput { db_password: incoming.db_password, ..Default::default() };
    state.secrets.save(&profile, &input)?;
    state.store.lock().await.upsert(profile.clone())?;
    Ok(profile)
}

// ---------- Environments ----------

#[tauri::command]
async fn list_environments(state: State<'_, AppState>) -> CmdResult<Vec<EnvironmentDef>> {
    Ok(state.environments.lock().await.list().to_vec())
}

/// Save the edited list. Connections in a removed environment move to Local (or the first one).
#[tauri::command]
async fn save_environments(state: State<'_, AppState>, list: Vec<EnvironmentDef>) -> CmdResult<Vec<EnvironmentDef>> {
    let mut envs = state.environments.lock().await;
    envs.save(list)?;
    let known: Vec<String> = envs.list().iter().map(|e| e.id.clone()).collect();
    state.store.lock().await.reassign_environments(&known, &envs.fallback_id())?;
    Ok(envs.list().to_vec())
}

// ---------- Saved connections ----------

#[tauri::command]
async fn list_connections(state: State<'_, AppState>) -> CmdResult<Vec<ConnectionProfile>> {
    let mut list = state.store.lock().await.list().to_vec();
    list.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at).then_with(|| a.name.cmp(&b.name)));
    Ok(list)
}

#[tauri::command]
async fn save_connection(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    secrets: Option<SecretsInput>,
) -> CmdResult<ConnectionProfile> {
    let mut store = state.store.lock().await;
    if let Some(input) = &secrets {
        state.secrets.save(&profile, input)?;
    }
    // Removed hops, or a hop that switched to another sign-in, leave nothing behind.
    state.secrets.prune(&profile)?;
    store.upsert(profile.clone())?;
    Ok(profile)
}

#[tauri::command]
async fn delete_connection(state: State<'_, AppState>, id: Uuid) -> CmdResult<()> {
    if let Some(p) = state.store.lock().await.remove(id)? {
        state.secrets.forget(&p)?;
        state.queries.lock().await.forget(id)?;
        state.diagrams.lock().await.forget(id)?;
    }
    Ok(())
}

/// Saved 1Password references of a connection, shown in the edit sheet.
#[tauri::command]
async fn secret_references(state: State<'_, AppState>, id: Uuid) -> CmdResult<SecretsInput> {
    let store = state.store.lock().await;
    Ok(store.get(id).map(|p| state.secrets.references(p)).unwrap_or_default())
}

/// One saved password of a saved connection, for the show-password button of the edit sheet.
#[tauri::command]
async fn reveal_secret(state: State<'_, AppState>, profile_id: Uuid, field: SecretField) -> CmdResult<Option<String>> {
    if state.store.lock().await.get(profile_id).is_none() {
        return Ok(None);
    }
    Ok(state.secrets.saved_value(profile_id, field))
}

/// Connect with unsaved form values, then disconnect.
#[tauri::command]
async fn test_connection(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    secrets: Option<SecretsInput>,
) -> CmdResult<TestReport> {
    let merged = match state.secrets.merged(&profile, &secrets.unwrap_or_default()).await {
        Ok(m) => m,
        // e.g. the 1Password CLI is missing or a reference is wrong: report it as the first step.
        Err(e) => {
            return Ok(TestReport {
                ok: false,
                steps: vec![Step {
                    label: "Read saved passwords".into(),
                    status: StepStatus::Failed,
                    detail: Some(e.to_string()),
                    hint: None,
                    ms: None,
                }],
                server_version: None,
                hops: profile.network.active_hops().len(),
                elapsed_ms: 0,
                error: Some(e),
            })
        }
    };
    Ok(Session::test(profile, &merged).await)
}

#[tauri::command]
fn trust_host_key(host: String, port: u16, key: String) -> CmdResult<()> {
    tunnel::trust_host_key(&host, port, &key)
}

// ---------- Sessions ----------

#[tauri::command]
async fn open_session(state: State<'_, AppState>, profile_id: Uuid) -> CmdResult<SessionInfo> {
    let temp = state.temp.lock().unwrap().get(&profile_id).cloned();
    let (profile, secrets, saved) = match temp {
        // Opened from a link: the password stays in memory only.
        Some(t) => (t.profile, ProfileSecrets { db_password: t.db_password, ..Default::default() }, false),
        None => {
            let profile = state
                .store
                .lock()
                .await
                .get(profile_id)
                .cloned()
                .ok_or_else(|| Error::Config("This connection no longer exists".into()))?;
            let secrets = state.secrets.load(&profile).await?;
            (profile, secrets, true)
        }
    };
    let session = Session::open(profile, &secrets).await?;
    let info = session.info();
    if saved {
        state.store.lock().await.touch(profile_id)?;
    }
    state.sessions.write().await.insert(session.id, Arc::new(session));
    Ok(info)
}

#[tauri::command]
async fn close_session(state: State<'_, AppState>, session_id: Uuid) -> CmdResult<()> {
    state.sessions.write().await.remove(&session_id);
    Ok(())
}

/// Run SQL. With `record`, the run is kept in the connection's history (query tabs do this;
/// browsing a table doesn't). Connections opened from a link and not saved keep no history.
#[tauri::command]
async fn run_query(
    state: State<'_, AppState>,
    session_id: Uuid,
    sql: String,
    record: Option<bool>,
) -> CmdResult<QueryOutput> {
    let session = state.session(session_id).await?;
    let started = Instant::now();
    let result = session.run(&sql).await;
    let profile_id = session.profile.id;
    if record.unwrap_or(false) && state.store.lock().await.get(profile_id).is_some() {
        let elapsed = started.elapsed().as_millis() as u64;
        let entry = HistoryEntry::of_run(profile_id, &sql, elapsed, &result);
        // The query ran either way; a history that can't be written only costs the entry.
        if let Err(e) = state.queries.lock().await.record(entry) {
            tracing::warn!("query history not saved: {e}");
        }
    }
    result
}

// ---------- History and saved queries ----------

#[tauri::command]
async fn list_history(state: State<'_, AppState>, profile_id: Uuid) -> CmdResult<Vec<HistoryEntry>> {
    Ok(state.queries.lock().await.history(profile_id))
}

#[tauri::command]
async fn delete_history(state: State<'_, AppState>, id: Uuid) -> CmdResult<()> {
    state.queries.lock().await.delete_history(id)
}

#[tauri::command]
async fn clear_history(state: State<'_, AppState>, profile_id: Uuid) -> CmdResult<()> {
    state.queries.lock().await.clear_history(profile_id)
}

#[tauri::command]
async fn list_saved_queries(state: State<'_, AppState>, profile_id: Uuid) -> CmdResult<Vec<SavedQuery>> {
    Ok(state.queries.lock().await.saved(profile_id))
}

#[tauri::command]
async fn save_query(state: State<'_, AppState>, query: SavedQuery) -> CmdResult<SavedQuery> {
    state.queries.lock().await.save(query)
}

#[tauri::command]
async fn delete_saved_query(state: State<'_, AppState>, id: Uuid) -> CmdResult<()> {
    state.queries.lock().await.delete_saved(id)
}

// ---------- Diagram canvases ----------

/// A connection's canvases; `None` when it never had any.
#[tauri::command]
async fn list_canvases(state: State<'_, AppState>, profile_id: Uuid) -> CmdResult<Option<Vec<Canvas>>> {
    state.diagrams.lock().await.list(profile_id)
}

/// Add or update a canvas. Like the history, connections opened from a link and not saved keep none.
#[tauri::command]
async fn save_canvas(state: State<'_, AppState>, profile_id: Uuid, canvas: Canvas) -> CmdResult<Canvas> {
    if state.store.lock().await.get(profile_id).is_none() {
        return Err(Error::Config("Save this connection to keep canvases for it".into()));
    }
    state.diagrams.lock().await.save(profile_id, canvas)
}

#[tauri::command]
async fn delete_canvas(state: State<'_, AppState>, profile_id: Uuid, id: Uuid) -> CmdResult<()> {
    state.diagrams.lock().await.delete(profile_id, id)
}

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum ExportKind {
    Png,
    Svg,
}

/// Save an exported diagram where the user chooses in the save panel. The panel is opened here,
/// so the page never picks the path it writes to. `data` is the SVG text, or the PNG in base64.
/// Returns the path, or `None` when the user cancelled.
#[tauri::command]
async fn export_diagram(app: AppHandle, name: String, kind: ExportKind, data: String) -> CmdResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let (bytes, ext, label) = match kind {
        ExportKind::Svg => (data.into_bytes(), "svg", "SVG image"),
        ExportKind::Png => (
            data_encoding::BASE64.decode(data.as_bytes()).map_err(|e| Error::Config(format!("Not a PNG: {e}")))?,
            "png",
            "PNG image",
        ),
    };
    let safe: String = name.chars().map(|c| if c == '/' || c == ':' || c.is_control() { '-' } else { c }).collect();
    let mut dialog = app.dialog().file().set_title("Export Diagram").set_file_name(format!("{}.{ext}", safe.trim()));
    dialog = dialog.add_filter(label, &[ext]);
    if let Some(w) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&w);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.save_file(move |picked| {
        let _ = tx.send(picked);
    });
    let Some(picked) = rx.await.ok().flatten() else { return Ok(None) };
    let path = picked.into_path().map_err(|e| Error::Config(e.to_string()))?;
    tokio::fs::write(&path, bytes).await?;
    Ok(Some(path.display().to_string()))
}

/// Light, dark or follow macOS: sets the window (title bar, native controls) and the menu checkmark.
#[tauri::command]
fn set_appearance(app: tauri::AppHandle, mode: String) {
    let theme = match mode.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    };
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_theme(theme);
    }
    #[cfg(target_os = "macos")]
    menu::check_appearance(&app, &mode);
}

/// Save cells edited in the results grid.
#[tauri::command]
async fn apply_edits(state: State<'_, AppState>, session_id: Uuid, edits: Vec<RowEdit>) -> CmdResult<u64> {
    state.session(session_id).await?.apply_edits(&edits).await
}

/// The UPDATE statements saving would run, for the confirmation dialog.
#[tauri::command]
async fn preview_edits(state: State<'_, AppState>, session_id: Uuid, edits: Vec<RowEdit>) -> CmdResult<String> {
    let engine = state.session(session_id).await?.profile.engine;
    oneclient_core::edit::preview(engine, &edits)
}

#[tauri::command]
async fn introspect(state: State<'_, AppState>, session_id: Uuid) -> CmdResult<Vec<TableInfo>> {
    state.session(session_id).await?.introspect().await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,russh=warn,tauri_plugin_deep_link=warn".into()),
        )
        .init();

    let mut builder = tauri::Builder::default();
    // A second launch (Windows/Linux pass links this way) hands its link to the running app.
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let store = ConnectionStore::open(&dir)?;
            let secrets = SecretStore::open(&dir)?;
            let environments = EnvironmentStore::open(&dir)?;
            let queries = QueryStore::open(&dir)?;
            let diagrams = DiagramStore::open(&dir)?;
            app.manage(AppState {
                store: Mutex::new(store),
                environments: Mutex::new(environments),
                queries: Mutex::new(queries),
                diagrams: Mutex::new(diagrams),
                secrets,
                sessions: RwLock::new(HashMap::new()),
                temp: Default::default(),
                pending: Default::default(),
                last_link: Default::default(),
            });

            use tauri_plugin_deep_link::DeepLinkExt;
            #[cfg(any(windows, target_os = "linux"))]
            app.deep_link().register_all()?;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handle_link(&handle, url.as_str());
                }
            });
            // Menu bar (macOS keeps one menu bar for the app; other platforms show none).
            #[cfg(target_os = "macos")]
            {
                let (bar, appearance) = menu::build(app.handle())?;
                app.set_menu(bar)?;
                app.manage(appearance);
                app.on_menu_event(|app, event| menu::on_event(app, event.id().as_ref()));
            }

            // Link that launched the app.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    handle_link(app.handle(), url.as_str());
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            take_pending_links,
            list_environments,
            save_environments,
            save_temp_connection,
            list_connections,
            save_connection,
            delete_connection,
            secret_references,
            reveal_secret,
            test_connection,
            trust_host_key,
            open_session,
            close_session,
            run_query,
            list_history,
            delete_history,
            clear_history,
            list_saved_queries,
            save_query,
            delete_saved_query,
            list_canvases,
            save_canvas,
            delete_canvas,
            export_diagram,
            introspect,
            apply_edits,
            set_appearance,
            preview_edits,
        ])
        .run(tauri::generate_context!())
        .expect("error while running 1Client");
}
