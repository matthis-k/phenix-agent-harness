use clap::Parser;
use phenix_backend_acp::{AcpBackend, AcpBackendConfig};
use phenix_backend_native::{PhenixBackend, BACKEND_ID as PHENIX_BACKEND_ID};
use phenix_conductor::{ConductorRuntime, ConductorServer, ContextRegistry, JsonFileStore};
use phenix_core::{BackendId, ProviderId};
use std::error::Error;
use std::io;
use std::path::PathBuf;

mod configuration;
#[cfg(unix)]
mod local_service;
mod workspace;
mod workspace_tools;

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

    /// Application-owned executable configuration rebound for this process.
    #[arg(long, value_name = "FILE")]
    configuration: Option<PathBuf>,

    /// Durable conductor checkpoint. If omitted the process is ephemeral.
    #[arg(long, value_name = "FILE")]
    state: Option<PathBuf>,

    /// Serve reconnectable frontends over this local Unix socket instead of stdio.
    #[arg(long, value_name = "FILE")]
    socket: Option<PathBuf>,

    /// Optional external ACP backend command. The built-in Phenix backend is always registered.
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
    if arguments.socket.is_some() && arguments.state.is_none() {
        return Err("--socket requires --state so the persistent service has durable state".into());
    }

    let cwd = arguments
        .cwd
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let workspace = workspace::Workspace::discover(&cwd)?;
    let mut server = match arguments.state {
        Some(path) => ConductorServer::load_or_new(JsonFileStore::new(path))?,
        None => ConductorServer::new(ConductorRuntime::new()),
    };

    {
        let context = ContextRegistry::discover(workspace.root())?;
        let mut runtime = server.runtime();
        runtime.install_context_registry(context);
        workspace_tools::register(&mut runtime, workspace.root().to_path_buf())?;
    }

    if let Some(path) = arguments.configuration {
        let configuration = configuration::RuntimeConfiguration::load(path)?;
        let mut runtime = server.runtime();
        configuration.apply(&mut runtime)?;
    }

    // Product invariant: a bare conductor is immediately usable. External ACP
    // registrations extend this backend set; they never supply the default.
    let phenix_backend_id = BackendId::parse(PHENIX_BACKEND_ID)?;
    server.register_backend(
        phenix_backend_id,
        Box::new(PhenixBackend::from_environment()?),
    )?;

    if let Some(command) = arguments.acp_command {
        let backend_id = BackendId::parse(arguments.acp_backend)?;
        let provider_id = ProviderId::parse(arguments.acp_provider)?;
        let config = AcpBackendConfig::new(
            backend_id.clone(),
            provider_id,
            command,
            workspace.root().to_path_buf(),
        )
        .args(arguments.acp_args);
        server.register_backend(backend_id, Box::new(AcpBackend::new(config)))?;
    }

    if let Some(socket) = arguments.socket {
        #[cfg(unix)]
        {
            return local_service::serve_unix_socket(server, socket);
        }
        #[cfg(not(unix))]
        {
            let _ = server;
            let _ = socket;
            return Err("--socket is only supported on Unix platforms".into());
        }
    }

    let stdin = io::stdin();
    let stdout = io::stdout();
    server.serve_ndjson(stdin.lock(), stdout)?;
    Ok(())
}
