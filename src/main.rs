use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use directories::ProjectDirs;
use phenix_agent_comm::{handle_json_rpc, AgentCommRepository};
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
    Tool {
        name: String,
        #[arg(long, default_value = "{}")]
        args: String,
    },
    StdioMcp,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let db_path = cli.db.unwrap_or_else(default_db_path);
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let repo = AgentCommRepository::open(&db_path)
        .with_context(|| format!("opening {}", db_path.display()))?;
    match cli.command {
        Command::Init => print_json(json!({ "db": db_path, "initialized": true })),
        Command::Tool { name, args } => {
            let parsed_args: serde_json::Value = serde_json::from_str(&args)
                .map_err(|e| anyhow::anyhow!("invalid JSON for --args: {} (got: {})", e, args))?;
            print_json(repo.call_tool(&name, parsed_args)?)
        }
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

fn read_message(input: &mut impl BufRead) -> Result<Option<Value>> {
    let mut line = String::new();
    let read = input.read_line(&mut line)?;
    if read == 0 {
        return Ok(None);
    }
    let trimmed = line.trim_end_matches(['\r', '\n']);
    if trimmed.is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(trimmed)?))
}

fn write_message(output: &mut impl Write, value: &Value) -> Result<()> {
    serde_json::to_writer(&mut *output, value)?;
    output.write_all(b"\n")?;
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
