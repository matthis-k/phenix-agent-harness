use clap::Parser;
use phenix_conductor::{ConductorError, ConductorRuntime};
use phenix_runtime_api::{
    ClientCommand, ExecutionState, FrontendError, FrontendRequest, FrontendResponse, ServerReply,
};
use std::error::Error;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "phenix-conductor",
    version,
    about = "Phenix application runtime"
)]
struct Arguments {
    /// Working directory associated with the frontend connection.
    #[arg(long, value_name = "DIR")]
    cwd: Option<PathBuf>,
}

fn handle(
    runtime: &mut ConductorRuntime,
    command: ClientCommand,
) -> Result<ServerReply, ConductorError> {
    match command {
        ClientCommand::Initialize => Ok(ServerReply::Initialized {
            snapshot: runtime.snapshot(),
        }),
        ClientCommand::Snapshot => Ok(ServerReply::Snapshot {
            snapshot: runtime.snapshot(),
        }),
        ClientCommand::SessionCreate {
            parent_session,
            name,
            target,
        } => runtime
            .create_session(parent_session, name, target)
            .map(|session| ServerReply::SessionCreated { session }),
        ClientCommand::SessionFork { session_id, name } => runtime
            .fork_session(&session_id, name)
            .map(|session| ServerReply::SessionCreated { session }),
        ClientCommand::Submit {
            session_id,
            target,
            text,
        } => runtime
            .submit(&session_id, target, text)
            .map(|execution| ServerReply::ExecutionStarted { execution }),
        ClientCommand::Cancel { execution_id } => {
            runtime.set_execution_state(&execution_id, ExecutionState::Cancelled)?;
            Ok(ServerReply::Accepted)
        }
    }
}

fn response_for(runtime: &mut ConductorRuntime, request: FrontendRequest) -> FrontendResponse {
    match handle(runtime, request.command) {
        Ok(result) => FrontendResponse {
            id: request.id,
            result: Some(result),
            error: None,
        },
        Err(error) => FrontendResponse {
            id: request.id,
            result: None,
            error: Some(FrontendError {
                code: "conductor_error".to_owned(),
                message: error.to_string(),
            }),
        },
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let arguments = Arguments::parse();
    if let Some(cwd) = arguments.cwd {
        std::env::set_current_dir(cwd)?;
    }

    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut runtime = ConductorRuntime::new();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<FrontendRequest>(&line) {
            Ok(request) => response_for(&mut runtime, request),
            Err(error) => FrontendResponse {
                id: 0,
                result: None,
                error: Some(FrontendError {
                    code: "invalid_request".to_owned(),
                    message: error.to_string(),
                }),
            },
        };
        serde_json::to_writer(&mut stdout, &response)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }

    Ok(())
}
