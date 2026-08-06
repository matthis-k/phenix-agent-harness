use agent_client_protocol::schema::v1::{
    AgentCapabilities, ClientRequest, ExtRequest, InitializeResponse,
};
use agent_client_protocol::{Agent, Stdio};
use clap::Parser;
use phenix_conductor::ConductorBootstrap;
use std::error::Error;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const DEFAULT_CHANNEL_CAPACITY: usize = 1_024;

#[derive(Debug, Parser)]
#[command(
    name = "phenix-conductor",
    version,
    about = "Phenix ACP aggregate manager and orchestrator"
)]
struct Arguments {
    /// JSON bootstrap containing immutable definitions and downstream ACP backends.
    #[arg(long, value_name = "FILE")]
    bootstrap: PathBuf,

    /// Working directory passed to downstream ACP agents.
    #[arg(long, value_name = "DIR")]
    cwd: Option<PathBuf>,

    /// Capacity used by each downstream ACP transport.
    #[arg(long, default_value_t = DEFAULT_CHANNEL_CAPACITY)]
    channel_capacity: usize,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn Error>> {
    let arguments = Arguments::parse();
    let source = fs::read_to_string(&arguments.bootstrap)?;
    let cwd = match arguments.cwd {
        Some(cwd) => cwd,
        None => std::env::current_dir()?,
    };
    let conductor =
        ConductorBootstrap::from_json(&source)?.build(&cwd, arguments.channel_capacity)?;
    let conductor = Arc::new(Mutex::new(conductor));
    let request_conductor = Arc::clone(&conductor);

    Agent
        .builder()
        .name("phenix-conductor")
        .on_receive_request(
            async move |request: ClientRequest, responder, _connection| {
                let response = match request {
                    ClientRequest::InitializeRequest(initialize) => serde_json::to_value(
                        InitializeResponse::new(initialize.protocol_version)
                            .agent_capabilities(AgentCapabilities::new()),
                    )
                    .map_err(agent_client_protocol::Error::into_internal_error)?,
                    ClientRequest::ExtMethodRequest(extension) => {
                        let extension = normalize_extension_method(extension);
                        let response = request_conductor
                            .lock()
                            .map_err(|_| agent_client_protocol::Error::internal_error())?
                            .handle_extension(extension)
                            .map_err(|error| {
                                agent_client_protocol::util::internal_error(error.to_string())
                            })?;
                        serde_json::to_value(response)
                            .map_err(agent_client_protocol::Error::into_internal_error)?
                    }
                    _ => return Err(agent_client_protocol::Error::method_not_found()),
                };
                responder.respond(response)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_to(Stdio::new())
        .await?;
    Ok(())
}

fn normalize_extension_method(extension: ExtRequest) -> ExtRequest {
    if extension.method.starts_with('_') {
        extension
    } else {
        ExtRequest::new(format!("_{}", extension.method), extension.params)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::value::to_raw_value;

    #[test]
    fn sdk_extension_fallback_is_restored_to_the_wire_method() {
        let params =
            to_raw_value(&serde_json::json!({ "tree_id": "tree-1" })).expect("raw parameters");
        let extension =
            normalize_extension_method(ExtRequest::new("phenix/session_tree/get", params.into()));
        assert_eq!(extension.method.as_ref(), "_phenix/session_tree/get");
    }
}
