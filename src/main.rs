use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use directories::ProjectDirs;
use phenix_workflow_state::WorkflowRepository;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Parser)]
#[command(about = "Generic workflow state storage service")]
struct Cli {
    #[arg(long, global = true)]
    db: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Init,
    CreateSession { name: String },
    CreateTask { session_id: Uuid, title: String },
    ListTasks { session_id: Option<Uuid> },
    RecordEvent {
        task_id: Uuid,
        kind: String,
        message: String,
        #[arg(long, default_value = "{}")]
        payload: serde_json::Value,
    },
    Summarize { session_id: Uuid },
    StdioJson,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
enum StdioRequestMethod {
    Init,
    CreateSession {
        name: String,
    },
    CreateTask {
        session_id: Uuid,
        title: String,
    },
    ListTasks {
        session_id: Option<Uuid>,
    },
    RecordEvent {
        task_id: Uuid,
        kind: String,
        message: String,
        #[serde(default = "empty_object")]
        payload: serde_json::Value,
    },
    Summarize {
        session_id: Uuid,
    },
}

#[derive(Debug, Deserialize)]
struct StdioRequest {
    id: Option<serde_json::Value>,
    #[serde(flatten)]
    method: StdioRequestMethod,
}

#[derive(Debug, Serialize)]
struct StdioResponse {
    id: Option<serde_json::Value>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let db_path = cli.db.unwrap_or_else(default_db_path);
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    }
    let repo = WorkflowRepository::open(&db_path).with_context(|| format!("opening {}", db_path.display()))?;

    match cli.command {
        Command::Init => print_json(json!({ "db": db_path, "initialized": true })),
        Command::CreateSession { name } => print_json(repo.create_session(&name)?),
        Command::CreateTask { session_id, title } => print_json(repo.create_task(session_id, &title)?),
        Command::ListTasks { session_id } => print_json(repo.list_tasks(session_id)?),
        Command::RecordEvent {
            task_id,
            kind,
            message,
            payload,
        } => print_json(repo.record_event(task_id, &kind, &message, payload)?),
        Command::Summarize { session_id } => print_json(repo.summarize(session_id)?),
        Command::StdioJson => run_stdio_json(&repo),
    }
}

fn run_stdio_json(repo: &WorkflowRepository) -> Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<StdioRequest>(&line) {
            Ok(request) => handle_stdio_request(repo, request),
            Err(err) => StdioResponse {
                id: None,
                ok: false,
                result: None,
                error: Some(err.to_string()),
            },
        };
        serde_json::to_writer(&mut stdout, &response)?;
        writeln!(stdout)?;
        stdout.flush()?;
    }
    Ok(())
}

fn handle_stdio_request(repo: &WorkflowRepository, request: StdioRequest) -> StdioResponse {
    let id = request.id;
    let result = match request.method {
        StdioRequestMethod::Init => Ok(json!({ "initialized": true })),
        StdioRequestMethod::CreateSession { name } => repo.create_session(&name).map(|value| json!(value)),
        StdioRequestMethod::CreateTask { session_id, title } => {
            repo.create_task(session_id, &title).map(|value| json!(value))
        }
        StdioRequestMethod::ListTasks { session_id } => repo.list_tasks(session_id).map(|value| json!(value)),
        StdioRequestMethod::RecordEvent {
            task_id,
            kind,
            message,
            payload,
        } => repo
            .record_event(task_id, &kind, &message, payload)
            .map(|value| json!(value)),
        StdioRequestMethod::Summarize { session_id } => repo.summarize(session_id).map(|value| json!(value)),
    };

    match result {
        Ok(value) => StdioResponse {
            id,
            ok: true,
            result: Some(value),
            error: None,
        },
        Err(err) => StdioResponse {
            id,
            ok: false,
            result: None,
            error: Some(err.to_string()),
        },
    }
}

fn print_json(value: impl Serialize) -> Result<()> {
    serde_json::to_writer_pretty(io::stdout().lock(), &value)?;
    println!();
    Ok(())
}

fn default_db_path() -> PathBuf {
    ProjectDirs::from("local", "phenix", "workflow-state")
        .map(|dirs| dirs.data_local_dir().join("workflow-state.sqlite3"))
        .unwrap_or_else(|| PathBuf::from("workflow-state.sqlite3"))
}

fn empty_object() -> serde_json::Value {
    json!({})
}
