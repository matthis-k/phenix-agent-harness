#![forbid(unsafe_code)]

use phenix_acp::acp::schema::v1::{
    AgentCapabilities, ClientRequest, InitializeResponse, PromptResponse, StopReason,
};
use phenix_acp::acp::{Agent, Result as AcpResult, Stdio};
use phenix_acp::{DefinitionId, Difficulty, RoleId, SessionCommand, SessionEvent};
use phenix_acp_backend::{AcpAgentBackend, AcpBackendConfig};
use phenix_acp_presets::standard_gateway;
use serde_json::{json, Value};
use std::env;
use std::error::Error;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const FIXTURE_ARGUMENT: &str = "--fixture";
const CHANNEL_CAPACITY: usize = 128;
const PROMPT_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_PERIOD: Duration = Duration::from_millis(10);

fn main() -> Result<(), Box<dyn Error>> {
    if env::args()
        .skip(1)
        .any(|argument| argument == FIXTURE_ARGUMENT)
    {
        futures::executor::block_on(run_fixture())?;
        return Ok(());
    }
    run_smoke()
}

async fn run_fixture() -> AcpResult<()> {
    let next_session = Arc::new(AtomicU64::new(1));
    let new_session_ids = Arc::clone(&next_session);

    Agent
        .builder()
        .name("phenix-acp-fixture")
        .on_receive_request(
            async move |request: ClientRequest, responder, _connection| {
                let response = match request {
                    ClientRequest::InitializeRequest(initialize) => serde_json::to_value(
                        InitializeResponse::new(initialize.protocol_version)
                            .agent_capabilities(AgentCapabilities::new()),
                    )
                    .map_err(phenix_acp::acp::Error::into_internal_error)?,
                    ClientRequest::NewSessionRequest(_) => {
                        let sequence = new_session_ids.fetch_add(1, Ordering::Relaxed);
                        json!({
                            "sessionId": format!("fixture-session-{sequence}"),
                            "configOptions": fixture_config_options(),
                        })
                    }
                    ClientRequest::SetSessionConfigOptionRequest(request) => json!({
                        "configOptions": fixture_config_options_with(
                            &request.config_id.to_string(),
                            request.value.as_ref(),
                        ),
                    }),
                    ClientRequest::PromptRequest(_) => {
                        serde_json::to_value(PromptResponse::new(StopReason::EndTurn))
                            .map_err(phenix_acp::acp::Error::into_internal_error)?
                    }
                    _ => return Err(phenix_acp::acp::Error::method_not_found()),
                };
                responder.respond(response)
            },
            phenix_acp::acp::on_receive_request!(),
        )
        .connect_to(Stdio::new())
        .await
}

fn fixture_config_options() -> Value {
    fixture_config_options_with("", &Value::Null)
}

fn fixture_config_options_with(config_id: &str, value: &Value) -> Value {
    let selected_model = if config_id == "model" {
        value.as_str().unwrap_or("fixture/fixture-model")
    } else {
        "fixture/fixture-model"
    };
    let selected_thinking = if config_id == "thinking" {
        value.as_str().unwrap_or("medium")
    } else {
        "medium"
    };
    json!([
        {
            "id": "model",
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": selected_model,
            "options": [{
                "value": "fixture/fixture-model",
                "name": "Fixture Model",
            }],
        },
        {
            "id": "thinking",
            "name": "Thinking",
            "category": "thought_level",
            "type": "select",
            "currentValue": selected_thinking,
            "options": [
                { "value": "minimal", "name": "Minimal" },
                { "value": "low", "name": "Low" },
                { "value": "medium", "name": "Medium" },
                { "value": "high", "name": "High" },
                { "value": "max", "name": "Max" }
            ],
        }
    ])
}

fn run_smoke() -> Result<(), Box<dyn Error>> {
    let executable = env::current_exe()?;
    let fixture_command = format!(
        "{} {FIXTURE_ARGUMENT}",
        shell_words::quote(executable.to_string_lossy().as_ref())
    );
    let config = AcpBackendConfig::new(fixture_command, env::current_dir()?)?;
    let factory = AcpAgentBackend::gateway_factory(config, CHANNEL_CAPACITY);
    let mut gateway = standard_gateway(factory)?;

    let definition = DefinitionId::parse("phenix.standard")?;
    let role = RoleId::parse("coordinator")?;
    let started = gateway.create_tree(
        &definition,
        role,
        Difficulty::D2,
        "verify packaged ACP gateway",
    )?;
    let snapshot = gateway.snapshot(&started.tree_id)?;
    let root = snapshot
        .nodes
        .iter()
        .find(|node| node.id == started.root_node_id)
        .ok_or_else(|| io::Error::other("gateway snapshot omitted the root node"))?;
    let downstream_session = root
        .downstream_session
        .as_ref()
        .ok_or_else(|| io::Error::other("root node has no downstream ACP session"))?;

    let mut events = gateway.execute(
        &started.tree_id,
        &started.root_node_id,
        SessionCommand::Prompt {
            text: "complete the fixture turn".to_owned(),
            images: Vec::new(),
        },
    )?;
    let deadline = Instant::now() + PROMPT_TIMEOUT;
    while !events
        .iter()
        .any(|event| matches!(&event.event, SessionEvent::Completed))
    {
        if let Some(message) = events.iter().find_map(|event| match &event.event {
            SessionEvent::Failed { message } => Some(message.as_str()),
            _ => None,
        }) {
            return Err(io::Error::other(format!("fixture prompt failed: {message}")).into());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "fixture prompt did not complete within five seconds",
            )
            .into());
        }
        thread::sleep(POLL_PERIOD);
        events.extend(gateway.execute(
            &started.tree_id,
            &started.root_node_id,
            SessionCommand::Poll,
        )?);
    }

    gateway.close_tree(&started.tree_id)?;
    if !gateway.list_trees().trees.is_empty() {
        return Err(io::Error::other("closed gateway tree remained registered").into());
    }

    println!("phenix: packaged ACP gateway smoke succeeded ({downstream_session})");
    Ok(())
}
