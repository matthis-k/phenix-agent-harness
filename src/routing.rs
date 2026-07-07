use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fmt;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use thiserror::Error;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

pub const ROUTING_STATE_VERSION: u32 = 1;
pub const REQUIRED_MANUAL_ROLES: &[&str] = &[
    "planner",
    "architect",
    "worker",
    "verifier",
    "architecture_verifier",
    "failure_analyzer",
    "commit_sync",
    "uiux_designer",
];

#[derive(Debug, Error)]
pub enum RoutingError {
    #[error("unknown routing mode: {0}")]
    UnknownMode(String),
    #[error("invalid routing state: {0}")]
    InvalidState(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type RoutingResult<T> = std::result::Result<T, RoutingError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoutingMode {
    Mixed,
    GptOnly,
    GoOnly,
    FreeOnly,
    Manual,
}

impl RoutingMode {
    pub const ALL: [Self; 5] = [
        Self::Mixed,
        Self::GptOnly,
        Self::GoOnly,
        Self::FreeOnly,
        Self::Manual,
    ];

    pub fn parse(value: &str) -> RoutingResult<Self> {
        match value {
            "mixed" => Ok(Self::Mixed),
            "gpt-only" => Ok(Self::GptOnly),
            "go-only" => Ok(Self::GoOnly),
            "free-only" => Ok(Self::FreeOnly),
            "manual" => Ok(Self::Manual),
            other => Err(RoutingError::UnknownMode(other.to_string())),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mixed => "mixed",
            Self::GptOnly => "gpt-only",
            Self::GoOnly => "go-only",
            Self::FreeOnly => "free-only",
            Self::Manual => "manual",
        }
    }

    pub fn next(self, free_allowed: bool) -> (Self, Option<&'static str>) {
        let next = match self {
            Self::Mixed => Self::GptOnly,
            Self::GptOnly => Self::GoOnly,
            Self::GoOnly if free_allowed => Self::FreeOnly,
            Self::GoOnly => Self::Manual,
            Self::FreeOnly => Self::Manual,
            Self::Manual => Self::Mixed,
        };
        let skipped = matches!(self, Self::GoOnly) && !free_allowed;
        (
            next,
            skipped.then_some(
                "free-only denied for private/secret/D2+/security/main-bound/commit routing context",
            ),
        )
    }
}

impl fmt::Display for RoutingMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Difficulty {
    D0,
    D1,
    D2,
    D3,
}

impl Difficulty {
    pub fn parse(value: &str) -> RoutingResult<Self> {
        match value {
            "D0" | "d0" => Ok(Self::D0),
            "D1" | "d1" => Ok(Self::D1),
            "D2" | "d2" => Ok(Self::D2),
            "D3" | "d3" => Ok(Self::D3),
            other => Err(RoutingError::InvalidState(format!(
                "unknown difficulty: {other}"
            ))),
        }
    }

    pub fn denies_free(self) -> bool {
        matches!(self, Self::D2 | Self::D3)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum Secrecy {
    Public,
    Private,
    Secret,
}

impl Secrecy {
    pub fn parse(value: &str) -> RoutingResult<Self> {
        match value {
            "Public" | "public" => Ok(Self::Public),
            "Private" | "private" => Ok(Self::Private),
            "Secret" | "secret" => Ok(Self::Secret),
            other => Err(RoutingError::InvalidState(format!(
                "unknown secrecy: {other}"
            ))),
        }
    }

    pub fn denies_free(self) -> bool {
        !matches!(self, Self::Public)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoutingContext {
    pub difficulty: Difficulty,
    pub secrecy: Secrecy,
    pub change_kind: String,
    pub target_state: String,
    pub main_bound: bool,
    pub operation: String,
}

impl Default for RoutingContext {
    fn default() -> Self {
        Self {
            difficulty: Difficulty::D1,
            secrecy: Secrecy::Public,
            change_kind: "Unknown".into(),
            target_state: "DevWallet".into(),
            main_bound: false,
            operation: "run".into(),
        }
    }
}

impl RoutingContext {
    pub fn free_denial_reason(&self) -> Option<&'static str> {
        if self.secrecy.denies_free() {
            return Some("free-only denied for Private or Secret secrecy");
        }
        if self.difficulty.denies_free() {
            return Some("free-only denied for D2 or D3 difficulty");
        }
        if matches!(
            self.change_kind.as_str(),
            "Secrets" | "Auth" | "Ci" | "Security"
        ) {
            return Some("free-only denied for security-sensitive change kind");
        }
        if self.main_bound || self.target_state == "MainBound" {
            return Some("free-only denied for MainBound target state");
        }
        if matches!(self.operation.as_str(), "commit" | "sync" | "push") {
            return Some("free-only denied for commit/sync/push operation");
        }
        None
    }

    pub fn free_allowed(&self) -> bool {
        self.free_denial_reason().is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoutingState {
    pub version: u32,
    pub mode: RoutingMode,
    pub updated_at: String,
    pub updated_by: String,
    #[serde(default)]
    pub manual_slots: BTreeMap<String, String>,
    pub last_context: RoutingContext,
}

impl Default for RoutingState {
    fn default() -> Self {
        Self {
            version: ROUTING_STATE_VERSION,
            mode: RoutingMode::Mixed,
            updated_at: now_rfc3339(),
            updated_by: "phenix-route".into(),
            manual_slots: BTreeMap::new(),
            last_context: RoutingContext::default(),
        }
    }
}

impl RoutingState {
    pub fn with_context(&self, context: RoutingContext) -> Self {
        let mut next = self.clone();
        next.last_context = context;
        next.touch();
        next
    }

    pub fn cycle(&self, context: RoutingContext) -> (Self, Option<&'static str>) {
        let (mode, reason) = self.mode.next(context.free_allowed());
        let mut next = self.with_context(context);
        next.mode = mode;
        (next, reason)
    }

    pub fn touch(&mut self) {
        self.version = ROUTING_STATE_VERSION;
        self.updated_at = now_rfc3339();
        self.updated_by = "phenix-route".into();
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SlotResolution {
    pub status: &'static str,
    pub mode: RoutingMode,
    pub selected_slots: BTreeMap<String, String>,
    pub missing_manual_slots: Vec<&'static str>,
    pub denial_reason: Option<&'static str>,
}

pub fn resolve_slots(state: &RoutingState, context: &RoutingContext) -> SlotResolution {
    let strong = matches!(context.difficulty, Difficulty::D2 | Difficulty::D3);
    let gpt = if strong { "gpt-strong" } else { "gpt-normal" };
    let go = if strong { "opencode-go-strong" } else { "opencode-go" };
    let free = "free-normal";
    let commit_sync = "denied-until-explicit-user-request";
    let mut selected_slots = BTreeMap::new();
    let mut status = "ok";
    let mut denial_reason = None;
    let mut missing_manual_slots = Vec::new();

    match state.mode {
        RoutingMode::Mixed => {
            selected_slots.insert("workflow".into(), "unchanged".into());
            selected_slots.insert("planner".into(), gpt.into());
            selected_slots.insert("architect".into(), gpt.into());
            selected_slots.insert("worker".into(), go.into());
            selected_slots.insert("verifier".into(), gpt.into());
            selected_slots.insert("architecture_verifier".into(), gpt.into());
            selected_slots.insert("failure_analyzer".into(), gpt.into());
            selected_slots.insert("commit_sync".into(), commit_sync.into());
            selected_slots.insert("uiux_designer".into(), gpt.into());
        }
        RoutingMode::GptOnly => {
            for role in REQUIRED_MANUAL_ROLES {
                selected_slots.insert((*role).into(), if *role == "commit_sync" { commit_sync } else { gpt }.into());
            }
            selected_slots.insert("workflow".into(), "unchanged".into());
        }
        RoutingMode::GoOnly => {
            for role in REQUIRED_MANUAL_ROLES {
                selected_slots.insert((*role).into(), if *role == "commit_sync" { commit_sync } else { go }.into());
            }
            selected_slots.insert("workflow".into(), "unchanged".into());
        }
        RoutingMode::FreeOnly => {
            if let Some(reason) = context.free_denial_reason() {
                status = "denied";
                denial_reason = Some(reason);
            }
            for role in REQUIRED_MANUAL_ROLES {
                selected_slots.insert((*role).into(), if *role == "commit_sync" { commit_sync } else { free }.into());
            }
            selected_slots.insert("workflow".into(), "unchanged".into());
        }
        RoutingMode::Manual => {
            for role in REQUIRED_MANUAL_ROLES {
                if let Some(slot) = state.manual_slots.get(*role) {
                    selected_slots.insert((*role).into(), slot.clone());
                } else {
                    missing_manual_slots.push(*role);
                }
            }
            selected_slots.insert("workflow".into(), "unchanged".into());
            if !missing_manual_slots.is_empty() {
                status = "incomplete";
            }
        }
    }

    SlotResolution {
        status,
        mode: state.mode,
        selected_slots,
        missing_manual_slots,
        denial_reason,
    }
}

pub fn effective_config(state: &RoutingState, context: &RoutingContext) -> Value {
    let resolution = resolve_slots(state, context);
    let mut agents = Map::new();
    if resolution.status == "ok" {
        for (name, role) in [
            ("phenix-planner", "planner"),
            ("phenix-architect", "architect"),
            ("phenix-worker", "worker"),
            ("phenix-verifier", "verifier"),
            ("phenix-architecture-verifier", "architecture_verifier"),
            ("phenix-commit-sync", "commit_sync"),
            ("failure-analyzer", "failure_analyzer"),
            ("uiux-designer", "uiux_designer"),
        ] {
            if let Some(model) = resolution.selected_slots.get(role) {
                agents.insert(name.into(), json!({ "model": model }));
            }
        }
    }
    json!({
        "$schema": "https://opencode.ai/config.json",
        "agent": agents,
    })
}

pub fn state_path_from_env() -> PathBuf {
    std::env::var_os("XDG_STATE_HOME")
        .map(|p| PathBuf::from(p).join("phenix-agent-harness/routing.json"))
        .unwrap_or_else(|| {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            home.join(".local/state/phenix-agent-harness/routing.json")
        })
}

pub fn read_state(path: &Path) -> (RoutingState, Option<String>) {
    match fs::read_to_string(path) {
        Ok(raw) => match serde_json::from_str::<RoutingState>(&raw) {
            Ok(state) => (state, None),
            Err(err) => (
                RoutingState::default(),
                Some(format!(
                    "invalid route state JSON at {}: {err}; using defaults",
                    path.display()
                )),
            ),
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => (RoutingState::default(), None),
        Err(err) => (
            RoutingState::default(),
            Some(format!(
                "could not read route state at {}: {err}; using defaults",
                path.display()
            )),
        ),
    }
}

pub fn write_state(path: &Path, state: &RoutingState) -> RoutingResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("json.tmp.{}", std::process::id()));
    let bytes = serde_json::to_vec_pretty(state)?;
    {
        let mut file = File::create(&tmp)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    if let Some(parent) = path.parent() {
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    Ok(())
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_d3_skips_free_only() {
        let state = RoutingState {
            mode: RoutingMode::GoOnly,
            ..RoutingState::default()
        };
        let context = RoutingContext {
            difficulty: Difficulty::D3,
            secrecy: Secrecy::Private,
            change_kind: "Workflow".into(),
            target_state: "DevWallet".into(),
            ..RoutingContext::default()
        };
        let (next, reason) = state.cycle(context);
        assert_eq!(next.mode, RoutingMode::Manual);
        assert!(reason.is_some());
    }

    #[test]
    fn mixed_d3_routes_worker_to_go_and_verifier_to_gpt() {
        let state = RoutingState::default();
        let context = RoutingContext {
            difficulty: Difficulty::D3,
            ..RoutingContext::default()
        };
        let slots = resolve_slots(&state, &context);
        assert_eq!(slots.selected_slots["worker"], "opencode-go-strong");
        assert_eq!(slots.selected_slots["verifier"], "gpt-strong");
    }

    #[test]
    fn invalid_json_falls_back_with_warning() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        fs::write(&path, "{").unwrap();
        let (state, warning) = read_state(&path);
        assert_eq!(state.mode, RoutingMode::Mixed);
        assert!(warning.unwrap().contains("invalid route state JSON"));
    }

    #[test]
    fn effective_config_does_not_set_workflow_model() {
        let cfg = effective_config(&RoutingState::default(), &RoutingContext::default());
        assert_eq!(cfg["agent"]["phenix-worker"]["model"], "opencode-go");
        assert!(cfg["agent"].get("phenix-workflow").is_none());
        assert!(cfg.get("mcp").is_none());
    }
}
