#![forbid(unsafe_code)]

use agent_client_protocol::schema::v1::{
    AgentCapabilities, ConnectMcpRequest, ContentBlock, ContentChunk, DisconnectMcpRequest,
    InitializeRequest, InitializeResponse, McpCapabilities, McpServer, MessageMcpNotification,
    MessageMcpRequest, NewSessionRequest, NewSessionResponse, PromptRequest, PromptResponse,
    SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
    SessionNotification, SessionUpdate, StopReason, TextContent,
};
use agent_client_protocol::{Agent, Stdio};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};
use std::thread;

fn model_options() -> Vec<SessionConfigOption> {
    vec![SessionConfigOption::select(
        "model",
        "Model",
        "fixture-model",
        vec![SessionConfigSelectOption::new(
            "fixture-model",
            "Fixture Model",
        )],
    )
    .category(SessionConfigOptionCategory::Model)]
}

fn params(value: Value) -> Map<String, Value> {
    value
        .as_object()
        .cloned()
        .expect("fixture params are objects")
}

fn response_value(response: agent_client_protocol::schema::v1::MessageMcpResponse) -> Value {
    serde_json::from_str(response.0.get()).expect("fixture MCP response is valid JSON")
}

async fn run() -> Result<(), agent_client_protocol::Error> {
    let next_session = Arc::new(Mutex::new(0_u64));
    let servers = Arc::new(Mutex::new(BTreeMap::<String, String>::new()));

    Agent
        .builder()
        .on_receive_request(
            async |request: InitializeRequest, responder, _connection| {
                responder.respond(
                    InitializeResponse::new(request.protocol_version).agent_capabilities(
                        AgentCapabilities::new().mcp_capabilities(McpCapabilities::new().acp(true)),
                    ),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let next_session = next_session.clone();
                let servers = servers.clone();
                async move |request: NewSessionRequest, responder, _connection| {
                    let server_id = request
                        .mcp_servers
                        .iter()
                        .find_map(|server| match server {
                            McpServer::Acp(server) => Some(server.server_id.0.to_string()),
                            _ => None,
                        })
                        .ok_or_else(|| {
                            agent_client_protocol::Error::invalid_params()
                                .data("fixture requires one ACP MCP server")
                        })?;
                    let session_id = {
                        let mut next_session = next_session.lock().map_err(|_| {
                            agent_client_protocol::Error::internal_error()
                                .data("fixture session counter lock poisoned")
                        })?;
                        *next_session += 1;
                        format!("tool-session-{}", *next_session)
                    };
                    servers
                        .lock()
                        .map_err(|_| {
                            agent_client_protocol::Error::internal_error()
                                .data("fixture MCP server map lock poisoned")
                        })?
                        .insert(session_id.clone(), server_id);
                    responder.respond(
                        NewSessionResponse::new(session_id).config_options(model_options()),
                    )
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let servers = servers.clone();
                async move |request: PromptRequest, responder, connection| {
                    let server_id = servers
                        .lock()
                        .map_err(|_| {
                            agent_client_protocol::Error::internal_error()
                                .data("fixture MCP server map lock poisoned")
                        })?
                        .get(&request.session_id.to_string())
                        .cloned()
                        .ok_or_else(|| {
                            agent_client_protocol::Error::invalid_params()
                                .data("fixture prompt has no ACP MCP server")
                        })?;

                    // A real agent's model/tool loop is independent work while the ACP transport
                    // remains available to dispatch the nested client requests. Model that here by
                    // returning from the Prompt handler immediately and completing its responder
                    // from a worker thread.
                    thread::spawn(move || {
                        let result = block_on(async {
                            let connected = connection
                                .send_request(ConnectMcpRequest::new(server_id))
                                .block_task()
                                .await?;
                            let connection_id = connected.connection_id;
                            let initialized = connection
                                .send_request(
                                    MessageMcpRequest::new(connection_id.clone(), "initialize")
                                        .params(params(json!({
                                            "protocolVersion": "2025-06-18",
                                            "capabilities": {},
                                            "clientInfo": {"name": "phenix-fixture", "version": "0.1.0"}
                                        }))),
                                )
                                .block_task()
                                .await?;
                            let initialized = response_value(initialized);
                            if initialized["serverInfo"]["name"] != "phenix-conductor" {
                                return Err(agent_client_protocol::Error::internal_error()
                                    .data("unexpected Phenix MCP server info"));
                            }
                            connection.send_notification(MessageMcpNotification::new(
                                connection_id.clone(),
                                "notifications/initialized",
                            ))?;

                            let listed = connection
                                .send_request(MessageMcpRequest::new(
                                    connection_id.clone(),
                                    "tools/list",
                                ))
                                .block_task()
                                .await?;
                            let listed = response_value(listed);
                            if listed["tools"][0]["name"] != "phenix.echo"
                                || listed["tools"][0]["inputSchema"]["type"] != "object"
                            {
                                return Err(agent_client_protocol::Error::internal_error()
                                    .data("provisioned callable metadata did not reach fixture"));
                            }

                            let called = connection
                                .send_request(
                                    MessageMcpRequest::new(connection_id.clone(), "tools/call")
                                        .params(params(json!({
                                            "name": "phenix.echo",
                                            "arguments": {"value": "from-acp"}
                                        }))),
                                )
                                .block_task()
                                .await?;
                            let called = response_value(called);
                            if called["isError"] != false
                                || called["content"][0]["text"] != "echo:from-acp"
                            {
                                return Err(agent_client_protocol::Error::internal_error()
                                    .data("unexpected conductor tool result"));
                            }

                            connection
                                .send_request(DisconnectMcpRequest::new(connection_id))
                                .block_task()
                                .await?;
                            connection.send_notification(SessionNotification::new(
                                request.session_id,
                                SessionUpdate::AgentMessageChunk(ContentChunk::new(
                                    ContentBlock::Text(TextContent::new(
                                        "continued:echo:from-acp",
                                    )),
                                )),
                            ))?;
                            responder.respond(PromptResponse::new(StopReason::EndTurn))
                        });
                        if let Err(error) = result {
                            eprintln!("ACP tool bridge fixture prompt failed: {error}");
                        }
                    });
                    Ok(())
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_to(Stdio::new())
        .await
}

struct ThreadWake(thread::Thread);

impl Wake for ThreadWake {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.0.unpark();
    }
}

fn block_on<F: Future>(future: F) -> F::Output {
    let waker = Waker::from(Arc::new(ThreadWake(thread::current())));
    let mut context = Context::from_waker(&waker);
    let mut future: Pin<Box<F>> = Box::pin(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(output) => return output,
            Poll::Pending => thread::park(),
        }
    }
}

fn main() {
    if let Err(error) = block_on(run()) {
        eprintln!("ACP tool bridge fixture failed: {error}");
        std::process::exit(1);
    }
}
