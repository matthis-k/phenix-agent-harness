use agent_client_protocol::schema::v1::{
    AgentCapabilities, CancelNotification, ClientRequest, CloseSessionResponse, ContentBlock,
    ContentChunk, EmbeddedResourceResource, ExtRequest, InitializeResponse, NewSessionResponse,
    PromptCapabilities, PromptRequest, PromptResponse, SessionId, SessionNotification, SessionUpdate,
    StopReason, TextContent, ToolCall, ToolCallStatus, ToolCallUpdate, ToolCallUpdateFields,
};
use agent_client_protocol::{Agent, Client, ConnectionTo, Stdio};
use base64::Engine;
use clap::Parser;
use phenix_acp::{GatewayEvent, SessionCommand, SessionEvent, SessionImage};
use phenix_conductor::{ConductorBootstrap, ConductorRuntime};
use std::error::Error;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

const DEFAULT_CHANNEL_CAPACITY: usize = 1_024;
const PROMPT_POLL_PERIOD: Duration = Duration::from_millis(20);

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
    let runtime =
        ConductorBootstrap::from_json(&source)?.build(&cwd, arguments.channel_capacity)?;
    let runtime = Arc::new(Mutex::new(runtime));
    let request_runtime = Arc::clone(&runtime);
    let cancel_runtime = Arc::clone(&runtime);

    Agent
        .builder()
        .name("phenix-conductor")
        .on_receive_notification(
            async move |cancel: CancelNotification, _connection| {
                lock_runtime(&cancel_runtime)?
                    .cancel_standard_session(&cancel.session_id.to_string())
                    .map(|_| ())
                    .map_err(|error| agent_client_protocol::util::internal_error(error.to_string()))
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: ClientRequest, responder, connection| {
                let response = match request {
                    ClientRequest::InitializeRequest(initialize) => serde_json::to_value(
                        InitializeResponse::new(initialize.protocol_version).agent_capabilities(
                            AgentCapabilities::new().prompt_capabilities(
                                PromptCapabilities::new().image(true).embedded_context(true),
                            ),
                        ),
                    )
                    .map_err(agent_client_protocol::Error::into_internal_error)?,
                    ClientRequest::NewSessionRequest(_request) => {
                        let session = lock_runtime(&request_runtime)?
                            .create_standard_session()
                            .map_err(|error| {
                                agent_client_protocol::util::internal_error(error.to_string())
                            })?;
                        serde_json::to_value(NewSessionResponse::new(session.session_id))
                            .map_err(agent_client_protocol::Error::into_internal_error)?
                    }
                    ClientRequest::PromptRequest(prompt) => serde_json::to_value(
                        handle_prompt(&request_runtime, &connection, prompt).await?,
                    )
                    .map_err(agent_client_protocol::Error::into_internal_error)?,
                    ClientRequest::CloseSessionRequest(close) => {
                        lock_runtime(&request_runtime)?
                            .close_standard_session(&close.session_id.to_string())
                            .map_err(|error| {
                                agent_client_protocol::util::internal_error(error.to_string())
                            })?;
                        serde_json::to_value(CloseSessionResponse::new())
                            .map_err(agent_client_protocol::Error::into_internal_error)?
                    }
                    ClientRequest::ExtMethodRequest(extension) => {
                        let extension = normalize_extension_method(extension);
                        let response = lock_runtime(&request_runtime)?
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

fn lock_runtime(
    runtime: &Arc<Mutex<ConductorRuntime>>,
) -> Result<MutexGuard<'_, ConductorRuntime>, agent_client_protocol::Error> {
    runtime
        .lock()
        .map_err(|_| agent_client_protocol::Error::internal_error())
}

async fn handle_prompt(
    runtime: &Arc<Mutex<ConductorRuntime>>,
    connection: &ConnectionTo<Client>,
    request: PromptRequest,
) -> Result<PromptResponse, agent_client_protocol::Error> {
    let upstream_session = request.session_id;
    let session_id = upstream_session.to_string();
    let command = prompt_command(request.prompt)?;
    let mut events = lock_runtime(runtime)?
        .execute_standard_session(&session_id, command)
        .map_err(|error| agent_client_protocol::util::internal_error(error.to_string()))?;

    loop {
        for event in events {
            if let Some(reason) = project_event(connection, &upstream_session, event)? {
                return Ok(PromptResponse::new(reason));
            }
        }
        if lock_runtime(runtime)?.take_standard_session_cancelled(&session_id) {
            return Ok(PromptResponse::new(StopReason::Cancelled));
        }
        tokio::time::sleep(PROMPT_POLL_PERIOD).await;
        events = lock_runtime(runtime)?
            .execute_standard_session(&session_id, SessionCommand::Poll)
            .map_err(|error| agent_client_protocol::util::internal_error(error.to_string()))?;
    }
}

fn prompt_command(
    prompt: Vec<ContentBlock>,
) -> Result<SessionCommand, agent_client_protocol::Error> {
    let mut text = Vec::new();
    let mut images = Vec::new();
    for block in prompt {
        match block {
            ContentBlock::Text(content) => text.push(content.text),
            ContentBlock::Image(content) => images.push(SessionImage {
                media_type: content.mime_type,
                data: base64::engine::general_purpose::STANDARD
                    .decode(content.data)
                    .map_err(|error| {
                        agent_client_protocol::util::internal_error(format!(
                            "invalid base64 image in ACP prompt: {error}"
                        ))
                    })?,
            }),
            ContentBlock::ResourceLink(link) => {
                text.push(format!("Resource: {}", link.uri));
            }
            ContentBlock::Resource(resource) => match resource.resource {
                EmbeddedResourceResource::TextResourceContents(resource) => {
                    text.push(format!("Resource {}:\n{}", resource.uri, resource.text));
                }
                EmbeddedResourceResource::BlobResourceContents(resource) => {
                    if let Some(media_type) = resource
                        .mime_type
                        .filter(|media_type| media_type.starts_with("image/"))
                    {
                        images.push(SessionImage {
                            media_type,
                            data: base64::engine::general_purpose::STANDARD
                                .decode(resource.blob)
                                .map_err(|error| {
                                    agent_client_protocol::util::internal_error(format!(
                                        "invalid base64 embedded image in ACP prompt: {error}"
                                    ))
                                })?,
                        });
                    } else {
                        text.push(format!("Binary resource: {}", resource.uri));
                    }
                }
                _ => {
                    return Err(agent_client_protocol::util::internal_error(
                        "unsupported embedded ACP resource",
                    ));
                }
            },
            ContentBlock::Audio(_) => {
                return Err(agent_client_protocol::util::internal_error(
                    "audio prompts are not supported by the Phenix conductor",
                ));
            }
            _ => {
                return Err(agent_client_protocol::util::internal_error(
                    "unsupported ACP prompt content",
                ));
            }
        }
    }
    Ok(SessionCommand::Prompt {
        text: text.join("\n\n"),
        images,
    })
}

fn project_event(
    connection: &ConnectionTo<Client>,
    upstream_session: &SessionId,
    event: GatewayEvent,
) -> Result<Option<StopReason>, agent_client_protocol::Error> {
    match event.event {
        SessionEvent::Text { text } => {
            send_update(
                connection,
                upstream_session,
                SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                    TextContent::new(text),
                ))),
            )?;
            Ok(None)
        }
        SessionEvent::Thought { text } => {
            send_update(
                connection,
                upstream_session,
                SessionUpdate::AgentThoughtChunk(ContentChunk::new(ContentBlock::Text(
                    TextContent::new(text),
                ))),
            )?;
            Ok(None)
        }
        SessionEvent::ToolStarted {
            call_id,
            name,
            input_summary,
        } => {
            let tool = ToolCall::new(call_id, name)
                .status(ToolCallStatus::InProgress)
                .raw_input(serde_json::json!({ "summary": input_summary }));
            send_update(
                connection,
                upstream_session,
                SessionUpdate::ToolCall(tool),
            )?;
            Ok(None)
        }
        SessionEvent::ToolUpdated { call_id, output } => {
            let fields = ToolCallUpdateFields::new()
                .status(ToolCallStatus::InProgress)
                .raw_output(serde_json::json!({ "output": output }));
            send_update(
                connection,
                upstream_session,
                SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(call_id, fields)),
            )?;
            Ok(None)
        }
        SessionEvent::ToolFinished {
            call_id,
            succeeded,
            output_summary,
        } => {
            let status = if succeeded {
                ToolCallStatus::Completed
            } else {
                ToolCallStatus::Failed
            };
            let fields = ToolCallUpdateFields::new()
                .status(status)
                .raw_output(serde_json::json!({ "summary": output_summary }));
            send_update(
                connection,
                upstream_session,
                SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(call_id, fields)),
            )?;
            Ok(None)
        }
        SessionEvent::Terminal {
            terminal_id,
            output,
            exit_code,
        } => {
            send_text_update(
                connection,
                upstream_session,
                format!(
                    "Terminal {terminal_id}{}:\n```text\n{output}\n```",
                    exit_code.map_or_else(String::new, |code| format!(" exited with {code}"))
                ),
            )?;
            Ok(None)
        }
        SessionEvent::PermissionRequested {
            request_id,
            title,
            options,
        } => {
            send_text_update(
                connection,
                upstream_session,
                format!(
                    "Permission required ({request_id}): {title}. Options: {}",
                    options.join(", ")
                ),
            )?;
            Ok(None)
        }
        SessionEvent::QueueChanged { .. } => Ok(None),
        SessionEvent::Compacted => {
            send_text_update(connection, upstream_session, "Context compacted.".to_owned())?;
            Ok(None)
        }
        SessionEvent::Completed => Ok(Some(StopReason::EndTurn)),
        SessionEvent::Failed { message } => {
            send_text_update(
                connection,
                upstream_session,
                format!("Phenix downstream failure: {message}"),
            )?;
            Ok(Some(StopReason::Refusal))
        }
        SessionEvent::Cancelled { .. } => Ok(Some(StopReason::Cancelled)),
    }
}

fn send_text_update(
    connection: &ConnectionTo<Client>,
    session_id: &SessionId,
    text: String,
) -> Result<(), agent_client_protocol::Error> {
    send_update(
        connection,
        session_id,
        SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
            TextContent::new(text),
        ))),
    )
}

fn send_update(
    connection: &ConnectionTo<Client>,
    session_id: &SessionId,
    update: SessionUpdate,
) -> Result<(), agent_client_protocol::Error> {
    connection.send_notification(SessionNotification::new(session_id.clone(), update))
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
    use agent_client_protocol::schema::v1::{ImageContent, TextContent};
    use serde_json::value::to_raw_value;

    #[test]
    fn sdk_extension_fallback_is_restored_to_the_wire_method() {
        let params =
            to_raw_value(&serde_json::json!({ "tree_id": "tree-1" })).expect("raw parameters");
        let extension =
            normalize_extension_method(ExtRequest::new("phenix/session_tree/get", params.into()));
        assert_eq!(extension.method.as_ref(), "_phenix/session_tree/get");
    }

    #[test]
    fn standard_acp_prompt_content_maps_to_the_gateway_command() {
        let command = prompt_command(vec![
            ContentBlock::Text(TextContent::new("inspect this")),
            ContentBlock::Image(ImageContent::new("aGVsbG8=", "image/png")),
        ])
        .expect("prompt command");
        assert_eq!(
            command,
            SessionCommand::Prompt {
                text: "inspect this".to_owned(),
                images: vec![SessionImage {
                    media_type: "image/png".to_owned(),
                    data: b"hello".to_vec(),
                }],
            }
        );
    }
}
