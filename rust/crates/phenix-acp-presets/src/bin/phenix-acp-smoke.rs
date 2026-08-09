#![forbid(unsafe_code)]

use phenix_acp::acp::schema::v1::{
    AgentCapabilities, InitializeRequest, InitializeResponse, NewSessionRequest,
    NewSessionResponse, PromptRequest, PromptResponse, StopReason,
};
use phenix_acp::acp::{Agent, Result as AcpResult, Stdio};
use phenix_acp::{DefinitionId, Difficulty, RoleId, SessionCommand, SessionEvent};
use phenix_acp_backend::{AcpAgentBackend, AcpBackendConfig};
use phenix_acp_presets::standard_gateway;
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
            async move |initialize: InitializeRequest, responder, _connection| {
                responder.respond(
                    InitializeResponse::new(initialize.protocol_version)
                        .agent_capabilities(AgentCapabilities::new()),
                )
            },
            phenix_acp::acp::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: NewSessionRequest, responder, _connection| {
                let sequence = new_session_ids.fetch_add(1, Ordering::Relaxed);
                responder.respond(NewSessionResponse::new(format!(
                    "fixture-session-{sequence}"
                )))
            },
            phenix_acp::acp::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: PromptRequest, responder, _connection| {
                responder.respond(PromptResponse::new(StopReason::EndTurn))
            },
            phenix_acp::acp::on_receive_request!(),
        )
        .connect_to(Stdio::new())
        .await
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
