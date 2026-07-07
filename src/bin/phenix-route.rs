use anyhow::{bail, Result};
use clap::{Args, Parser, Subcommand};
use phenix_agent_comm::routing::{
    effective_config, read_state, resolve_slots, state_path_from_env, write_state, Difficulty,
    RoutingContext, RoutingMode, RoutingState, Secrecy,
};
use serde_json::json;
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(about = "Manage Phenix agent routing state")]
struct Cli {
    #[arg(long, global = true)]
    state: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Show {
        #[arg(long)]
        json: bool,
    },
    Set {
        mode: String,
        #[command(flatten)]
        context: ContextArgs,
    },
    SetSlot {
        role: String,
        slot: String,
    },
    Cycle {
        #[command(flatten)]
        context: ContextArgs,
        #[arg(long)]
        json: bool,
    },
    Resolve {
        #[command(flatten)]
        context: ContextArgs,
        #[arg(long)]
        json: bool,
        #[arg(long = "opencode-config")]
        opencode_config: bool,
    },
    Reset,
}

#[derive(Debug, Default, Args)]
struct ContextArgs {
    #[arg(long)]
    difficulty: Option<String>,
    #[arg(long)]
    secrecy: Option<String>,
    #[arg(long = "change-kind")]
    change_kind: Option<String>,
    #[arg(long = "target-state")]
    target_state: Option<String>,
    #[arg(long)]
    operation: Option<String>,
    #[arg(long = "main-bound")]
    main_bound: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let path = cli.state.unwrap_or_else(state_path_from_env);
    let (mut state, warning) = read_state(&path);
    match cli.command {
        Command::Show { json } => {
            if json {
                print_json(show_json(&path, &state, warning.as_deref()))
            } else {
                print_show(&path, &state, warning.as_deref())
            }
        }
        Command::Set { mode, context } => {
            state.mode = RoutingMode::parse(&mode)?;
            let context = merge_context(&state.last_context, context)?;
            state.last_context = context;
            state.touch();
            write_state(&path, &state)?;
            print_json(show_json(&path, &state, warning.as_deref()))
        }
        Command::SetSlot { role, slot } => {
            state.manual_slots.insert(role, slot);
            state.touch();
            write_state(&path, &state)?;
            print_json(show_json(&path, &state, warning.as_deref()))
        }
        Command::Cycle { context, json } => {
            let context = merge_context(&state.last_context, context)?;
            let previous_mode = state.mode;
            let (next, free_skip_reason) = state.cycle(context);
            write_state(&path, &next)?;
            let out = json!({
                "status": "cycled",
                "state_path": path,
                "previous_mode": previous_mode,
                "new_mode": next.mode,
                "routing": next,
                "free_skipped": free_skip_reason.is_some(),
                "free_skip_reason": free_skip_reason,
                "restart_required": true,
                "hot_switching_supported": false,
                "selected_slots": resolve_slots(&next, &next.last_context),
                "warning": warning,
            });
            if json {
                print_json(out)
            } else {
                println!("routing: {}", next.mode);
                if let Some(reason) = free_skip_reason {
                    println!("skipped: {reason}");
                }
                println!("restart_required: true");
                Ok(())
            }
        }
        Command::Resolve {
            context,
            json,
            opencode_config,
        } => {
            if !json && !opencode_config {
                bail!("resolve requires --json");
            }
            let context = merge_context(&state.last_context, context)?;
            let resolution = resolve_slots(&state, &context);
            if opencode_config {
                return print_json(effective_config(&state, &context));
            }
            print_json(json!({
                "status": resolution.status,
                "state_path": path,
                "routing": state.with_context(context.clone()),
                "context": context,
                "selected_slots": resolution.selected_slots,
                "missing_manual_slots": resolution.missing_manual_slots,
                "denial_reason": resolution.denial_reason,
                "restart_required": true,
                "hot_switching_supported": false,
                "warning": warning,
            }))
        }
        Command::Reset => {
            let state = RoutingState::default();
            write_state(&path, &state)?;
            print_json(show_json(&path, &state, warning.as_deref()))
        }
    }
}

fn merge_context(base: &RoutingContext, args: ContextArgs) -> Result<RoutingContext> {
    let mut context = base.clone();
    if let Some(value) = args.difficulty {
        context.difficulty = Difficulty::parse(&value)?;
    }
    if let Some(value) = args.secrecy {
        context.secrecy = Secrecy::parse(&value)?;
    }
    if let Some(value) = args.change_kind {
        context.change_kind = value;
    }
    if let Some(value) = args.target_state {
        context.target_state = value;
    }
    if let Some(value) = args.operation {
        context.operation = value;
    }
    if args.main_bound {
        context.main_bound = true;
    }
    Ok(context)
}

fn show_json(path: &PathBuf, state: &RoutingState, warning: Option<&str>) -> serde_json::Value {
    json!({
        "status": "ok",
        "state_path": path,
        "routing": state,
        "selected_slots": resolve_slots(state, &state.last_context),
        "restart_required": true,
        "hot_switching_supported": false,
        "warning": warning,
    })
}

fn print_show(path: &PathBuf, state: &RoutingState, warning: Option<&str>) -> Result<()> {
    println!("routing: {}", state.mode);
    println!("state_path: {}", path.display());
    println!("restart_required: true");
    if let Some(warning) = warning {
        println!("warning: {warning}");
    }
    Ok(())
}

fn print_json(value: serde_json::Value) -> Result<()> {
    serde_json::to_writer_pretty(std::io::stdout().lock(), &value)?;
    println!();
    Ok(())
}
