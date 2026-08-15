mod credentials;
mod mcp;
mod model;
mod oauth;

use agent_client_protocol::schema::v1::{
    AgentCapabilities, AuthMethod, AuthMethodTerminal, CancelNotification, ClientRequest,
    ContentBlock, ContentChunk, CreateTerminalRequest, InitializeResponse, McpCapabilities,
    McpServer, PromptCapabilities, PromptResponse, ReleaseTerminalRequest, SessionNotification,
    SessionUpdate, StopReason, TerminalOutputRequest, TextContent, ToolCall as AcpToolCall,
    ToolCallStatus, ToolCallUpdate, ToolCallUpdateFields, ToolKind, WaitForTerminalExitRequest,
};
use agent_client_protocol::{Agent, Client as AcpClient, ConnectionTo, Stdio};
use clap::{Args, Subcommand};
use credentials::CredentialStore;
use futures::StreamExt;
use genai::chat::{ChatMessage, ChatOptions, ChatRequest, ChatStreamEvent, Tool, ToolResponse};
use genai::resolver::AuthResolver;
use genai::Client as ProviderClient;
use mcp::AcpTool;
use model::{ModelSelection, ThoughtLevel};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::Display;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

const DEFAULT_MODEL: &str = "openai-codex/gpt-5.6-terra";
const MAX_TOOL_ROUNDS: usize = 32;

#[derive(Debug, Args)]
pub struct RuntimeArguments {
    #[command(subcommand)]
    command: Option<RuntimeCommand>,
}

#[derive(Debug, Subcommand)]
enum RuntimeCommand {
    /// Manage credentials used by the built-in provider adapters.
    Auth(AuthArguments),
}

#[derive(Debug, Args)]
struct AuthArguments {
    #[command(subcommand)]
    command: AuthCommand,
}

#[derive(Debug, Subcommand)]
enum AuthCommand {
    /// Prompt for and securely persist a provider token or API key.
    Login { provider: String },
    /// Remove a persisted provider credential.
    Logout { provider: String },
}

pub async fn run(arguments: RuntimeArguments) -> Result<(), Box<dyn Error>> {
    match arguments.command {
        Some(RuntimeCommand::Auth(arguments)) => run_auth(arguments).await,
        None => serve().await,
    }
}

async fn run_auth(arguments: AuthArguments) -> Result<(), Box<dyn Error>> {
    let store = CredentialStore::discover()?;
    match arguments.command {
        AuthCommand::Login { provider } => {
            let provider = credential_provider(&provider)?;
            if provider == "openai-codex" {
                oauth::login(&store).await?;
            } else {
                let secret = rpassword::prompt_password(format!("{provider} token/API key: "))?;
                store.save_api_key(provider, secret)?;
                println!("Saved credentials for {provider}.");
            }
        }
        AuthCommand::Logout { provider } => {
            let provider = credential_provider(&provider)?;
            if store.remove(provider)? {
                println!("Removed credentials for {provider}.");
            } else {
                println!("No stored credentials for {provider}.");
            }
        }
    }
    Ok(())
}

fn credential_provider(provider: &str) -> Result<&'static str, String> {
    provider_specs()
        .iter()
        .find(|candidate| candidate.id == provider)
        .map(|provider| provider.credential_name)
        .ok_or_else(|| format!("unsupported provider {provider:?}"))
}

async fn serve() -> Result<(), Box<dyn Error>> {
    let credentials = CredentialStore::discover()?;
    let resolver_store = credentials.clone();
    let auth_resolver =
        AuthResolver::from_resolver_fn(move |model| resolver_store.auth_for_model(model));
    let provider = ProviderClient::builder()
        .with_auth_resolver(auth_resolver)
        .build();
    let codex_oauth = oauth::CodexOAuth::new(credentials);
    let codex_auth_resolver = AuthResolver::from_resolver_async_fn(
        move |_model| -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<Option<genai::resolver::AuthData>, genai::resolver::Error>,
                    > + Send,
            >,
        > {
            let codex_oauth = codex_oauth.clone();
            Box::pin(async move {
                codex_oauth
                    .auth_data()
                    .await
                    .map_err(genai::resolver::Error::Custom)
            })
        },
    );
    let codex_provider = ProviderClient::builder()
        .with_auth_resolver(codex_auth_resolver)
        .build();
    let state = Arc::new(RuntimeState {
        provider,
        codex_provider,
        sessions: Mutex::new(BTreeMap::new()),
        next_session: AtomicU64::new(1),
    });
    let request_state = Arc::clone(&state);
    let cancel_state = Arc::clone(&state);

    Agent
        .builder()
        .name("phenix-acp-runtime")
        .on_receive_notification(
            async move |cancel: CancelNotification, _connection| {
                let sessions = lock(&cancel_state.sessions)?;
                if let Some(session) = sessions.get(&cancel.session_id.to_string()) {
                    session.cancelled.store(true, Ordering::Release);
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: ClientRequest, responder, connection| match request {
                ClientRequest::InitializeRequest(initialize) => responder.respond(
                    serde_json::to_value(
                        InitializeResponse::new(initialize.protocol_version)
                            .agent_capabilities(
                                AgentCapabilities::new()
                                    .prompt_capabilities(PromptCapabilities::new())
                                    .mcp_capabilities(McpCapabilities::new().acp(true)),
                            )
                            .auth_methods(auth_methods()),
                    )
                    .map_err(internal_error)?,
                ),
                ClientRequest::NewSessionRequest(request) => {
                    let id = format!(
                        "phenix-runtime-{}",
                        request_state.next_session.fetch_add(1, Ordering::Relaxed)
                    );
                    let model =
                        std::env::var("PHENIX_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_owned());
                    let model = ModelSelection::parse(&model).map_err(internal_error)?;
                    let mcp_servers = request
                        .mcp_servers
                        .into_iter()
                        .filter_map(|server| match server {
                            McpServer::Acp(server) => Some(server.server_id),
                            _ => None,
                        })
                        .collect();
                    lock(&request_state.sessions)?.insert(
                        id.clone(),
                        RuntimeSession {
                            model,
                            thought_level: ThoughtLevel::Medium,
                            history: Vec::new(),
                            mcp_servers,
                            cwd: request.cwd,
                            active: false,
                            cancelled: Arc::new(AtomicBool::new(false)),
                        },
                    );
                    let session = lock(&request_state.sessions)?;
                    let session = session.get(&id).ok_or_else(|| {
                        internal_error("newly created runtime session disappeared")
                    })?;
                    responder.respond(json!({
                        "sessionId": id,
                        "configOptions": config_options(session),
                    }))
                }
                ClientRequest::SetSessionConfigOptionRequest(request) => {
                    let mut sessions = lock(&request_state.sessions)?;
                    let session = sessions
                        .get_mut(&request.session_id.to_string())
                        .ok_or_else(|| internal_error("unknown runtime session"))?;
                    if session.active {
                        return Err(internal_error(
                            "cannot change model configuration during an active prompt",
                        ));
                    }
                    let value = request
                        .value
                        .as_value_id()
                        .ok_or_else(|| {
                            internal_error("runtime config options require a select value")
                        })?
                        .to_string();
                    match request.config_id.to_string().as_str() {
                        "model" => {
                            session.model =
                                ModelSelection::parse(&value).map_err(internal_error)?;
                            session.model.genai_model().map_err(internal_error)?;
                        }
                        "thinking" => {
                            session.thought_level =
                                ThoughtLevel::parse(&value).map_err(internal_error)?;
                        }
                        _ => return Err(internal_error("unknown runtime config option")),
                    }
                    responder.respond(json!({ "configOptions": config_options(session) }))
                }
                ClientRequest::PromptRequest(prompt) => {
                    let state = Arc::clone(&request_state);
                    connection.spawn({
                        let connection = connection.clone();
                        async move {
                            let result = execute_prompt(&state, &connection, prompt).await;
                            match result {
                                Ok(response) => responder.respond(response),
                                Err(error) => responder.respond_with_error(internal_error(error)),
                            }
                        }
                    })?;
                    Ok(())
                }
                ClientRequest::CloseSessionRequest(request) => {
                    let removed =
                        lock(&request_state.sessions)?.remove(&request.session_id.to_string());
                    if removed.is_none() {
                        return Err(internal_error("unknown runtime session"));
                    }
                    responder.respond(json!({}))
                }
                _ => Err(agent_client_protocol::Error::method_not_found()),
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_to(Stdio::new())
        .await?;
    Ok(())
}

struct RuntimeState {
    provider: ProviderClient,
    codex_provider: ProviderClient,
    sessions: Mutex<BTreeMap<String, RuntimeSession>>,
    next_session: AtomicU64,
}

struct RuntimeSession {
    model: ModelSelection,
    thought_level: ThoughtLevel,
    history: Vec<ChatMessage>,
    mcp_servers: Vec<agent_client_protocol::schema::v1::McpServerAcpId>,
    cwd: PathBuf,
    active: bool,
    cancelled: Arc<AtomicBool>,
}

struct ActivePromptGuard {
    state: Arc<RuntimeState>,
    session_id: String,
}

impl Drop for ActivePromptGuard {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.state.sessions.lock() {
            if let Some(session) = sessions.get_mut(&self.session_id) {
                session.active = false;
            }
        }
    }
}

async fn execute_prompt(
    state: &Arc<RuntimeState>,
    connection: &ConnectionTo<AcpClient>,
    prompt: agent_client_protocol::schema::v1::PromptRequest,
) -> Result<Value, String> {
    let session_id = prompt.session_id.to_string();
    let (model, thought_level, mut history, server_ids, cwd, cancelled) = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "runtime state is poisoned")?;
        let session = sessions
            .get_mut(&session_id)
            .ok_or_else(|| format!("unknown runtime session {session_id:?}"))?;
        if session.active {
            return Err("a prompt is already active for this runtime session".to_owned());
        }
        session.active = true;
        session.cancelled.store(false, Ordering::Release);
        (
            session.model.clone(),
            session.thought_level,
            session.history.clone(),
            session.mcp_servers.clone(),
            session.cwd.clone(),
            Arc::clone(&session.cancelled),
        )
    };
    let _guard = ActivePromptGuard {
        state: Arc::clone(state),
        session_id: session_id.clone(),
    };
    let user_text = prompt
        .prompt
        .into_iter()
        .filter_map(|block| match block {
            ContentBlock::Text(text) => Some(text.text),
            ContentBlock::Resource(resource) => serde_json::to_string(&resource).ok(),
            ContentBlock::ResourceLink(link) => Some(link.uri),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    history.push(ChatMessage::user(user_text));

    let mut tools = vec![RuntimeTool::Terminal { cwd }];
    for tool in mcp::connect_tools(connection, &server_ids).await? {
        if tools
            .iter()
            .any(|candidate| candidate.name() == tool.remote_name)
        {
            return Err(format!(
                "MCP tool name {:?} collides with a built-in runtime tool",
                tool.remote_name
            ));
        }
        tools.push(RuntimeTool::Mcp(Box::new(tool)));
    }
    let provider_model = model.genai_model()?;
    for _round in 0..MAX_TOOL_ROUNDS {
        if cancelled.load(Ordering::Acquire) {
            return serde_json::to_value(PromptResponse::new(StopReason::Cancelled))
                .map_err(|error| error.to_string());
        }
        let request =
            ChatRequest::new(history.clone()).with_tools(tools.iter().map(RuntimeTool::definition));
        let options = ChatOptions::default()
            .with_capture_content(true)
            .with_capture_reasoning_content(true)
            .with_capture_tool_calls(true)
            .with_reasoning_effort(thought_level.reasoning_effort());
        let provider = if model.provider == "openai-codex" {
            &state.codex_provider
        } else {
            &state.provider
        };
        let mut stream = provider
            .exec_chat_stream(&provider_model, request, Some(&options))
            .await
            .map_err(|error| provider_request_error(&model, error))?;
        let mut captured = None;
        while let Some(event) = stream.stream.next().await {
            if cancelled.load(Ordering::Acquire) {
                return serde_json::to_value(PromptResponse::new(StopReason::Cancelled))
                    .map_err(|error| error.to_string());
            }
            match event.map_err(|error| format!("provider stream failed: {error}"))? {
                ChatStreamEvent::Chunk(chunk) => send_text(
                    connection,
                    prompt.session_id.clone(),
                    SessionUpdate::AgentMessageChunk,
                    chunk.content,
                )?,
                ChatStreamEvent::ReasoningChunk(chunk) => send_text(
                    connection,
                    prompt.session_id.clone(),
                    SessionUpdate::AgentThoughtChunk,
                    chunk.content,
                )?,
                ChatStreamEvent::End(end) => captured = end.captured_content,
                _ => {}
            }
        }
        let content = captured.unwrap_or_default();
        let tool_calls = content
            .tool_calls()
            .into_iter()
            .cloned()
            .collect::<Vec<_>>();
        history.push(ChatMessage::assistant(content));
        if tool_calls.is_empty() {
            let mut sessions = state
                .sessions
                .lock()
                .map_err(|_| "runtime state is poisoned")?;
            let session = sessions
                .get_mut(&session_id)
                .ok_or_else(|| "runtime session disappeared".to_owned())?;
            session.history = history;
            return serde_json::to_value(PromptResponse::new(StopReason::EndTurn))
                .map_err(|error| error.to_string());
        }
        let mut responses = Vec::new();
        for call in tool_calls {
            let tool = tools
                .iter()
                .find(|tool| tool.name() == call.fn_name)
                .ok_or_else(|| format!("provider requested unknown tool {:?}", call.fn_name))?;
            let result = execute_tool(
                connection,
                prompt.session_id.clone(),
                tool,
                &call.call_id,
                call.fn_arguments.clone(),
            )
            .await?;
            responses.push(ToolResponse::new(call.call_id, result.to_string()));
        }
        history.push(ChatMessage::from(responses));
    }
    Err(format!(
        "provider exceeded {MAX_TOOL_ROUNDS} consecutive tool rounds"
    ))
}

enum RuntimeTool {
    Terminal { cwd: PathBuf },
    Mcp(Box<AcpTool>),
}

impl RuntimeTool {
    fn name(&self) -> &str {
        match self {
            Self::Terminal { .. } => "phenix_terminal",
            Self::Mcp(tool) => &tool.remote_name,
        }
    }

    fn definition(&self) -> Tool {
        match self {
            Self::Terminal { .. } => Tool::new("phenix_terminal")
                .with_description(
                    "Run a shell command in the session workspace. Use ordinary command-line tools to inspect, search, edit, build, and test the project.",
                )
                .with_schema(json!({
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "POSIX shell command to run in the session working directory"
                        }
                    },
                    "required": ["command"],
                    "additionalProperties": false
                })),
            Self::Mcp(tool) => tool.definition.clone(),
        }
    }

    fn kind(&self) -> ToolKind {
        match self {
            Self::Terminal { .. } => ToolKind::Execute,
            Self::Mcp(_) => ToolKind::Other,
        }
    }

    async fn execute(
        &self,
        connection: &ConnectionTo<AcpClient>,
        session_id: agent_client_protocol::schema::v1::SessionId,
        arguments: Value,
    ) -> Result<Value, String> {
        match self {
            Self::Terminal { cwd } => {
                let command = arguments
                    .get("command")
                    .and_then(Value::as_str)
                    .filter(|command| !command.trim().is_empty())
                    .ok_or_else(|| "phenix_terminal requires a non-empty command".to_owned())?;
                let terminal = connection
                    .send_request(
                        CreateTerminalRequest::new(session_id.clone(), "sh")
                            .args(vec!["-lc".to_owned(), command.to_owned()])
                            .cwd(cwd.clone())
                            .output_byte_limit(1_048_576),
                    )
                    .block_task()
                    .await
                    .map_err(|error| format!("cannot start terminal command: {error}"))?;
                let terminal_id = terminal.terminal_id;
                let waited = connection
                    .send_request(WaitForTerminalExitRequest::new(
                        session_id.clone(),
                        terminal_id.clone(),
                    ))
                    .block_task()
                    .await;
                let output = connection
                    .send_request(TerminalOutputRequest::new(
                        session_id.clone(),
                        terminal_id.clone(),
                    ))
                    .block_task()
                    .await;
                let released = connection
                    .send_request(ReleaseTerminalRequest::new(session_id, terminal_id))
                    .block_task()
                    .await;
                let waited =
                    waited.map_err(|error| format!("cannot wait for terminal command: {error}"))?;
                let output = output
                    .map_err(|error| format!("cannot read terminal command output: {error}"))?;
                released.map_err(|error| format!("cannot release terminal command: {error}"))?;
                Ok(json!({
                    "output": output.output,
                    "truncated": output.truncated,
                    "exitStatus": waited.exit_status,
                }))
            }
            Self::Mcp(tool) => mcp::call_tool(connection, tool, arguments).await,
        }
    }
}

async fn execute_tool(
    connection: &ConnectionTo<AcpClient>,
    session_id: agent_client_protocol::schema::v1::SessionId,
    tool: &RuntimeTool,
    call_id: &str,
    arguments: Value,
) -> Result<Value, String> {
    connection
        .send_notification(SessionNotification::new(
            session_id.clone(),
            SessionUpdate::ToolCall(
                AcpToolCall::new(call_id.to_owned(), tool.name().to_owned())
                    .kind(tool.kind())
                    .status(ToolCallStatus::Pending)
                    .raw_input(arguments.clone()),
            ),
        ))
        .map_err(|error| format!("cannot announce tool call: {error}"))?;
    connection
        .send_notification(SessionNotification::new(
            session_id.clone(),
            SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                call_id.to_owned(),
                ToolCallUpdateFields::new().status(ToolCallStatus::InProgress),
            )),
        ))
        .map_err(|error| format!("cannot update tool call: {error}"))?;
    match tool
        .execute(connection, session_id.clone(), arguments)
        .await
    {
        Ok(result) => {
            send_tool_finished(
                connection,
                session_id,
                call_id,
                ToolCallStatus::Completed,
                result.clone(),
            )?;
            Ok(result)
        }
        Err(error) => {
            let result = json!({ "error": error });
            send_tool_finished(
                connection,
                session_id,
                call_id,
                ToolCallStatus::Failed,
                result.clone(),
            )?;
            Ok(result)
        }
    }
}

fn send_tool_finished(
    connection: &ConnectionTo<AcpClient>,
    session_id: agent_client_protocol::schema::v1::SessionId,
    call_id: &str,
    status: ToolCallStatus,
    result: Value,
) -> Result<(), String> {
    connection
        .send_notification(SessionNotification::new(
            session_id,
            SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                call_id.to_owned(),
                ToolCallUpdateFields::new()
                    .status(status)
                    .raw_output(result),
            )),
        ))
        .map_err(|error| format!("cannot finish tool call: {error}"))
}

fn send_text(
    connection: &ConnectionTo<AcpClient>,
    session_id: agent_client_protocol::schema::v1::SessionId,
    update: fn(ContentChunk) -> SessionUpdate,
    text: String,
) -> Result<(), String> {
    connection
        .send_notification(SessionNotification::new(
            session_id,
            update(ContentChunk::new(ContentBlock::Text(TextContent::new(
                text,
            )))),
        ))
        .map_err(|error| format!("cannot stream session update: {error}"))
}

fn config_options(session: &RuntimeSession) -> Value {
    let model = session.model.wire_value();
    json!([
        {
            "id": "model",
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": model,
            "options": [{ "value": model, "name": model }],
        },
        {
            "id": "thinking",
            "name": "Thinking",
            "category": "thought_level",
            "type": "select",
            "currentValue": session.thought_level.as_str(),
            "options": [
                { "value": "off", "name": "Off" },
                { "value": "minimal", "name": "Minimal" },
                { "value": "low", "name": "Low" },
                { "value": "medium", "name": "Medium" },
                { "value": "high", "name": "High" },
                { "value": "extra_high", "name": "Extra high" },
                { "value": "max", "name": "Max" },
            ],
        }
    ])
}

struct ProviderSpec {
    id: &'static str,
    name: &'static str,
    credential_name: &'static str,
    description: &'static str,
}

fn provider_specs() -> &'static [ProviderSpec] {
    &[
        ProviderSpec {
            id: "openai-codex",
            name: "OpenAI Codex (ChatGPT Plus) [OAuth]",
            credential_name: "openai-codex",
            description: "OAuth · ChatGPT subscription access through browser sign-in; no OpenAI API key is used",
        },
        ProviderSpec {
            id: "openai",
            name: "OpenAI [API key]",
            credential_name: "openai",
            description: "API key · OpenAI API billing; this is separate from a ChatGPT subscription",
        },
        ProviderSpec {
            id: "openai-responses",
            name: "OpenAI Responses API [API key]",
            credential_name: "openai_resp",
            description: "API key · OpenAI API billing via a stored credential or OPENAI_API_KEY; ChatGPT OAuth does not apply",
        },
        ProviderSpec {
            id: "anthropic",
            name: "Anthropic [API key]",
            credential_name: "anthropic",
            description: "API key · stored by the Phenix runtime or read from the provider environment variable",
        },
        ProviderSpec {
            id: "gemini",
            name: "Google Gemini [API key]",
            credential_name: "gemini",
            description: "API key · stored by the Phenix runtime or read from the provider environment variable",
        },
        ProviderSpec {
            id: "opencode-go",
            name: "OpenCode Go [API key/token]",
            credential_name: "opencode_go",
            description: "API key or token · stored by the Phenix runtime or read from the provider environment variable",
        },
        ProviderSpec {
            id: "github-copilot",
            name: "GitHub Copilot [token]",
            credential_name: "github_copilot",
            description: "Token · stored by the Phenix runtime or read from the provider environment variable",
        },
        ProviderSpec {
            id: "open-router",
            name: "OpenRouter [API key]",
            credential_name: "open_router",
            description: "API key · stored by the Phenix runtime or read from the provider environment variable",
        },
        ProviderSpec {
            id: "deepseek",
            name: "DeepSeek [API key]",
            credential_name: "deepseek",
            description: "API key · stored by the Phenix runtime or read from the provider environment variable",
        },
        ProviderSpec {
            id: "groq",
            name: "Groq [API key]",
            credential_name: "groq",
            description: "API key · stored by the Phenix runtime or read from the provider environment variable",
        },
        ProviderSpec {
            id: "xai",
            name: "xAI [API key]",
            credential_name: "xai",
            description: "API key · stored by the Phenix runtime or read from the provider environment variable",
        },
    ]
}

fn auth_methods() -> Vec<AuthMethod> {
    provider_specs()
        .iter()
        .map(|provider| {
            AuthMethod::Terminal(
                AuthMethodTerminal::new(provider.id, provider.name)
                    .description(provider.description)
                    .args(vec![
                        "auth".to_owned(),
                        "login".to_owned(),
                        provider.id.to_owned(),
                    ]),
            )
        })
        .collect()
}

fn provider_request_error(model: &ModelSelection, error: impl Display) -> String {
    match model.provider.as_str() {
        "openai-codex" => format!(
            "provider request failed for `{}`: ChatGPT Plus uses OAuth through `openai-codex`; authenticate that provider in Phenix and retry. Cause: {error}",
            model.wire_value()
        ),
        "openai-responses" => format!(
            "provider request failed for `{}`: `openai-responses` uses OpenAI API billing and requires an API key (a saved Phenix credential or OPENAI_API_KEY). ChatGPT Plus OAuth authorizes `openai-codex`, not this provider. Cause: {error}",
            model.wire_value()
        ),
        _ => format!(
            "provider request failed for `{}`: {error}",
            model.wire_value()
        ),
    }
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, agent_client_protocol::Error> {
    mutex
        .lock()
        .map_err(|_| internal_error("runtime state is poisoned"))
}

fn internal_error(error: impl Display) -> agent_client_protocol::Error {
    agent_client_protocol::Error::into_internal_error(std::io::Error::other(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_prompt_is_not_injected() {
        let request = ChatRequest::new(vec![ChatMessage::user("hello")]);
        assert_eq!(request.messages.len(), 1);
    }

    #[test]
    fn every_advertised_auth_method_has_a_real_credential_mapping() {
        for provider in provider_specs() {
            assert_eq!(
                credential_provider(provider.id),
                Ok(provider.credential_name)
            );
        }
    }

    #[test]
    fn auth_catalog_distinguishes_chatgpt_oauth_from_openai_api_keys() {
        let methods = auth_methods();
        let encoded = serde_json::to_string(&methods).expect("encode auth methods");
        assert!(encoded.contains("ChatGPT Plus) [OAuth]"));
        assert!(encoded.contains("OpenAI Responses API [API key]"));
        assert!(encoded.contains("OPENAI_API_KEY"));
    }

    #[test]
    fn api_key_route_failure_explains_that_chatgpt_oauth_is_separate() {
        let model = ModelSelection::parse("openai-responses/gpt-5.6-terra").expect("model");
        let message = provider_request_error(&model, "OPENAI_API_KEY is missing");
        assert!(message.contains("OpenAI API billing"));
        assert!(message.contains("ChatGPT Plus OAuth"));
        assert!(message.contains("openai-codex"));
    }

    #[test]
    fn built_in_terminal_is_small_explicit_and_ready_to_execute() {
        let tool = RuntimeTool::Terminal {
            cwd: PathBuf::from("/workspace"),
        };
        let definition = tool.definition();
        assert_eq!(tool.name(), "phenix_terminal");
        assert_eq!(
            definition
                .schema
                .as_ref()
                .and_then(|schema| schema.get("required")),
            Some(&json!(["command"]))
        );
        assert!(!definition
            .description
            .as_deref()
            .is_some_and(|description| description.contains("permission")));
    }
}
