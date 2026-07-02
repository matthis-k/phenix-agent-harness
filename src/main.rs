use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use directories::ProjectDirs;
use phenix_agent_comm::{tool_descriptions, AgentCommRepository};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(about = "Generic durable agent communication MCP")]
struct Cli {
    #[arg(long, global = true)]
    db: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Init,
    Tool { name: String, #[arg(long, default_value = "{}") ] args: Value },
    StdioMcp,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let db_path = cli.db.unwrap_or_else(default_db_path);
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    }
    let repo = AgentCommRepository::open(&db_path).with_context(|| format!("opening {}", db_path.display()))?;
    match cli.command {
        Command::Init => print_json(json!({ "db": db_path, "initialized": true })),
        Command::Tool { name, args } => print_json(repo.call_tool(&name, args)?),
        Command::StdioMcp => run_mcp(&repo),
    }
}

fn run_mcp(repo: &AgentCommRepository) -> Result<()> {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut output = io::stdout().lock();
    while let Some(request) = read_message(&mut input)? {
        let response = handle_json_rpc(repo, request);
        if !response.is_null() {
            write_message(&mut output, &response)?;
        }
    }
    Ok(())
}

fn handle_json_rpc(repo: &AgentCommRepository, request: Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let result: std::result::Result<Value, String> = match method {
        "initialize" => Ok(json!({
            "protocolVersion": "2024-11-05",
            "serverInfo": {"name": "phenix-agent-comm-mcp", "version": env!("CARGO_PKG_VERSION")},
            "capabilities": {"tools": {}}
        })),
        "notifications/initialized" => return Value::Null,
        "tools/list" => Ok(json!({"tools": tool_descriptions()})),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            repo.call_tool(name, args).map(|value| json!({
                "content": [{"type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string())}],
                "structuredContent": value,
                "isError": false
            })).map_err(|err| err.to_string())
        }
        _ => Err(format!("method not found: {method}")),
    };
    match result {
        Ok(result) => json!({"jsonrpc":"2.0", "id": id, "result": result}),
        Err(err) => json!({"jsonrpc":"2.0", "id": id, "error": {"code": -32000, "message": err.to_string()}}),
    }
}

fn read_message(input: &mut impl BufRead) -> Result<Option<Value>> {
    let mut content_length = None;
    loop {
        let mut line = String::new();
        let read = input.read_line(&mut line)?;
        if read == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("Content-Length:") {
            content_length = Some(value.trim().parse::<usize>()?);
        }
    }
    let len = content_length.context("missing Content-Length header")?;
    let mut body = vec![0_u8; len];
    input.read_exact(&mut body)?;
    Ok(Some(serde_json::from_slice(&body)?))
}

fn write_message(output: &mut impl Write, value: &Value) -> Result<()> {
    let body = serde_json::to_vec(value)?;
    write!(output, "Content-Length: {}\r\n\r\n", body.len())?;
    output.write_all(&body)?;
    output.flush()?;
    Ok(())
}

fn print_json(value: impl Serialize) -> Result<()> {
    serde_json::to_writer_pretty(io::stdout().lock(), &value)?;
    println!();
    Ok(())
}

fn default_db_path() -> PathBuf {
    ProjectDirs::from("local", "phenix", "agent-comm")
        .map(|dirs| dirs.data_local_dir().join("agent-comm.sqlite3"))
        .unwrap_or_else(|| {
            std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
                .join("phenix-agent-comm/agent-comm.sqlite3")
        })
}

#[allow(dead_code)]
fn never_shell() -> Result<()> {
    bail!("this MCP records communication only and does not execute shell commands")
}
