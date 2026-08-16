use clap::Parser;
use phenix_backend_acp::{AcpBackend, AcpBackendConfig};
use phenix_conductor::{ConductorRuntime, ConductorServer, JsonFileStore};
use phenix_core::{BackendId, ProviderId};
use std::error::Error;
use std::io;
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

    /// Durable conductor checkpoint. If omitted the process is ephemeral.
    #[arg(long, value_name = "FILE")]
    state: Option<PathBuf>,

    /// ACP backend command used by the minimal R9 process wiring.
    #[arg(long, value_name = "PROGRAM")]
    acp_command: Option<PathBuf>,

    /// Phenix backend ID associated with --acp-command.
    #[arg(long, default_value = "acp")]
    acp_backend: String,

    /// Provider ID associated with --acp-command.
    #[arg(long, default_value = "default")]
    acp_provider: String,

    /// Argument forwarded to the configured ACP process. Repeatable.
    #[arg(long = "acp-arg", value_name = "ARG")]
    acp_args: Vec<String>,
}

fn main() -> Result<(), Box<dyn Error>> {
    let arguments = Arguments::parse();
    let cwd = arguments
        .cwd
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let mut server = match arguments.state {
        Some(path) => ConductorServer::load_or_new(JsonFileStore::new(path))?,
        None => ConductorServer::new(ConductorRuntime::new()),
    };

    if let Some(command) = arguments.acp_command {
        let backend_id = BackendId::parse(arguments.acp_backend)?;
        let provider_id = ProviderId::parse(arguments.acp_provider)?;
        let config = AcpBackendConfig::new(backend_id.clone(), provider_id, command, cwd)
            .args(arguments.acp_args);
        server.register_backend(backend_id, Box::new(AcpBackend::new(config)))?;
    }

    let stdin = io::stdin();
    let stdout = io::stdout();
    server.serve_ndjson(stdin.lock(), stdout)?;
    Ok(())
}
