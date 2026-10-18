//! Step-by-step connection checks, so "Test Connection" can say exactly which part
//! failed (reaching the bastion, its host key, SSH sign-in, the database password…)
//! and what to do about it.

use std::future::Future;
use std::time::Instant;

use serde::Serialize;

use crate::{ConnectionProfile, Engine, Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StepStatus {
    Ok,
    Failed,
    /// Not tried because an earlier step failed.
    Skipped,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub label: String,
    pub status: StepStatus,
    /// What happened (the error, or e.g. the server version).
    pub detail: Option<String>,
    /// What to try next, for failed steps.
    pub hint: Option<String>,
    pub ms: Option<u64>,
}

#[derive(Debug, Default)]
pub struct Steps {
    pub list: Vec<Step>,
}

impl Steps {
    /// Run one step and record how it went.
    pub async fn run<T>(
        &mut self,
        label: impl Into<String>,
        fut: impl Future<Output = Result<T>>,
        hint: impl FnOnce(&Error) -> Option<String>,
    ) -> Result<T> {
        let t = Instant::now();
        let r = fut.await;
        let ms = Some(t.elapsed().as_millis() as u64);
        let label = label.into();
        match &r {
            Ok(_) => self.list.push(Step { label, status: StepStatus::Ok, detail: None, hint: None, ms }),
            Err(e) => self.list.push(Step {
                label,
                status: StepStatus::Failed,
                detail: Some(e.to_string()),
                hint: hint(e),
                ms,
            }),
        }
        r
    }

    pub fn ok(&mut self, label: impl Into<String>, detail: Option<String>) {
        self.list.push(Step { label: label.into(), status: StepStatus::Ok, detail, hint: None, ms: None });
    }

    pub fn failed(&mut self, label: impl Into<String>, e: &Error, hint: Option<String>) {
        self.list.push(Step {
            label: label.into(),
            status: StepStatus::Failed,
            detail: Some(e.to_string()),
            hint,
            ms: None,
        });
    }

    /// Mark the planned steps that never ran.
    pub fn skip_rest(&mut self, plan: &[String]) {
        for label in plan.iter().skip(self.list.len()) {
            self.list.push(Step {
                label: label.clone(),
                status: StepStatus::Skipped,
                detail: None,
                hint: None,
                ms: None,
            });
        }
    }
}

// Labels are built in one place so the plan and the executed steps always match.
pub mod label {
    pub fn reach(host: &str, port: u16) -> String {
        format!("Reach {host}:{port}")
    }
    pub fn reach_via(host: &str, port: u16, via: &str) -> String {
        format!("Reach {host}:{port} through {via}")
    }
    pub fn host_key(host: &str) -> String {
        format!("Verify host key of {host}")
    }
    pub fn ssh_sign_in(user: &str, host: &str) -> String {
        format!("Sign in as {user}@{host}")
    }
    pub fn db_from(host: &str, port: u16, via: &str) -> String {
        format!("Reach database {host}:{port} from {via}")
    }
    pub fn db_reach(host: &str, port: u16) -> String {
        format!("Reach database {host}:{port}")
    }
    pub fn db_sign_in(engine: &str, user: &str) -> String {
        format!("Sign in to {engine} as {user}")
    }
    pub fn db_open(db: &str) -> String {
        format!("Open database {db}")
    }
}

pub fn engine_name(e: Engine) -> &'static str {
    match e {
        Engine::Postgres => "PostgreSQL",
        Engine::Mysql => "MySQL",
    }
}

/// Every step a connection goes through, in order.
pub fn plan(p: &ConnectionProfile) -> Vec<String> {
    let mut v = Vec::new();
    let hops = p.network.active_hops();
    for (i, h) in hops.iter().enumerate() {
        v.push(if i == 0 {
            label::reach(&h.host, h.port)
        } else {
            label::reach_via(&h.host, h.port, &hops[i - 1].host)
        });
        v.push(label::host_key(&h.host));
        v.push(label::ssh_sign_in(&h.user, &h.host));
    }
    match hops.last() {
        Some(last) => v.push(label::db_from(&p.host, p.port, &last.host)),
        None => v.push(label::db_reach(&p.host, p.port)),
    }
    v.push(label::db_sign_in(engine_name(p.engine), &p.user));
    if !p.database.is_empty() {
        v.push(label::db_open(&p.database));
    }
    v
}
