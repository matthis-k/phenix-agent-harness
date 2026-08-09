use agent_client_protocol::schema::v1::{
    AgentCapabilities, ClientRequest, ContentBlock, ContentChunk, InitializeResponse,
    SessionNotification, SessionUpdate, StopReason, TextContent, ToolCall, ToolCallStatus,
    ToolCallUpdate, ToolCallUpdateFields,
};
use agent_client_protocol::{Agent, Stdio};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::Display;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const CONFIG_ENV: &str = "PHENIX_MOCK_ACP_CONFIG";

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MockConfig {
    backend_id: String,
    default_model: String,
    models: Vec<MockModel>,
    log_path: PathBuf,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MockModel {
    id: String,
    display_name: String,
    response: String,
    #[serde(default)]
    final_response: Option<String>,
    #[serde(default)]
    tool_call: Option<MockToolCall>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MockToolCall {
    name: String,
    input: Value,
}

#[derive(Debug)]
struct MockState {
    config: MockConfig,
    sessions: BTreeMap<String, MockSession>,
    next_session: u64,
    next_tool_call: u64,
}

#[derive(Debug)]
struct MockSession {
    selected_model: String,
    pending_tool: Option<PendingTool>,
}

#[derive(Debug)]
struct PendingTool {
    call_id: String,
    name: String,
}

impl MockState {
    fn from_environment() -> Result<Self, Box<dyn Error>> {
        let source = std::env::var(CONFIG_ENV)
            .map_err(|_| format!("{CONFIG_ENV} is required for the mock ACP agent"))?;
        let config: MockConfig = serde_json::from_str(&source)?;
        if config.models.is_empty() {
            return Err("mock ACP agent requires at least one model".into());
        }
        if !config
            .models
            .iter()
            .any(|model| model.id == config.default_model)
        {
            return Err(format!(
                "default model {:?} is not present in the mock model catalog",
                config.default_model
            )
            .into());
        }
        Ok(Self {
            config,
            sessions: BTreeMap::new(),
            next_session: 1,
            next_tool_call: 1,
        })
    }

    fn create_session(&mut self) -> Result<Value, Box<dyn Error>> {
        let session_id = format!("{}-session-{}", self.config.backend_id, self.next_session);
        self.next_session = self
            .next_session
            .checked_add(1)
            .ok_or("mock session identifiers exhausted")?;
        let selected_model = self.config.default_model.clone();
        self.sessions.insert(
            session_id.clone(),
            MockSession {
                selected_model: selected_model.clone(),
                pending_tool: None,
            },
        );
        self.log(json!({
            "kind": "session_new",
            "backend": self.config.backend_id,
            "session_id": session_id,
            "selected_model": selected_model,
        }))?;
        Ok(json!({
            "sessionId": session_id,
            "configOptions": self.config_options(&selected_model),
        }))
    }

    fn select_config(&mut self, request: Value) -> Result<Value, Box<dyn Error>> {
        let session_id = required_string(&request, "sessionId")?;
        let config_id = required_string(&request, "configId")?;
        let value = required_string(&request, "value")?;
        match config_id.as_str() {
            "model" => {
                if !self
                    .config
                    .models
                    .iter()
                    .any(|candidate| candidate.id == value)
                {
                    return Err(format!("unknown mock model {value:?}").into());
                }
                let session = self
                    .sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| format!("unknown mock session {session_id:?}"))?;
                session.selected_model = value.clone();
                self.log(json!({
                    "kind": "model_selected",
                    "backend": self.config.backend_id,
                    "session_id": session_id,
                    "model": value,
                }))?;
                Ok(json!({
                    "configOptions": self.config_options(&value),
                }))
            }
            "thinking" => {
                if value != "off" {
                    return Err(format!("unsupported mock thinking level {value:?}").into());
                }
                let model = self
                    .sessions
                    .get(&session_id)
                    .ok_or_else(|| format!("unknown mock session {session_id:?}"))?
                    .selected_model
                    .clone();
                Ok(json!({
                    "configOptions": self.config_options(&model),
                }))
            }
            _ => Err(format!("unsupported mock config option {config_id:?}").into()),
        }
    }

    fn prompt(
        &mut self,
        session_id: &str,
        text: String,
    ) -> Result<MockPromptResult, Box<dyn Error>> {
        let selected_model = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("unknown mock session {session_id:?}"))?
            .selected_model
            .clone();
        let model = self
            .config
            .models
            .iter()
            .find(|model| model.id == selected_model)
            .cloned()
            .ok_or_else(|| format!("selected mock model {selected_model:?} disappeared"))?;
        self.log(json!({
            "kind": "prompt_received",
            "backend": self.config.backend_id,
            "session_id": session_id,
            "model": selected_model,
            "text": text,
        }))?;

        if let Some(result) = text.strip_prefix("tool-result:") {
            let pending = self
                .sessions
                .get_mut(session_id)
                .and_then(|session| session.pending_tool.take())
                .ok_or("mock model received a tool result without a pending tool call")?;
            let result = result.trim().to_owned();
            self.log(json!({
                "kind": "tool_completed",
                "backend": self.config.backend_id,
                "session_id": session_id,
                "model": selected_model,
                "tool_call_id": pending.call_id,
                "tool": pending.name,
                "result": result,
            }))?;
            return Ok(MockPromptResult {
                text: model.final_response.unwrap_or(model.response),
                tool_started: None,
                tool_finished: Some((pending.call_id, result)),
            });
        }

        let tool_started = match model.tool_call {
            Some(tool) => {
                let call_id = format!("{}-tool-{}", self.config.backend_id, self.next_tool_call);
                self.next_tool_call = self
                    .next_tool_call
                    .checked_add(1)
                    .ok_or("mock tool-call identifiers exhausted")?;
                self.sessions
                    .get_mut(session_id)
                    .ok_or_else(|| format!("unknown mock session {session_id:?}"))?
                    .pending_tool = Some(PendingTool {
                    call_id: call_id.clone(),
                    name: tool.name.clone(),
                });
                self.log(json!({
                    "kind": "tool_emitted",
                    "backend": self.config.backend_id,
                    "session_id": session_id,
                    "model": selected_model,
                    "tool_call_id": call_id,
                    "tool": tool.name,
                    "input": tool.input,
                }))?;
                Some((call_id, tool))
            }
            None => None,
        };
        Ok(MockPromptResult {
            text: model.response,
            tool_started,
            tool_finished: None,
        })
    }

    fn config_options(&self, current_model: &str) -> Value {
        json!([
            {
                "id": "model",
                "name": "Model",
                "category": "model",
                "type": "select",
                "currentValue": current_model,
                "options": self.config.models.iter().map(|model| json!({
                    "value": model.id,
                    "name": model.display_name,
                })).collect::<Vec<_>>(),
            },
            {
                "id": "thinking",
                "name": "Thinking",
                "category": "thought_level",
                "type": "select",
                "currentValue": "off",
                "options": [{ "value": "off", "name": "Off" }],
            }
        ])
    }

    fn log(&self, event: Value) -> Result<(), Box<dyn Error>> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.config.log_path)?;
        serde_json::to_writer(&mut file, &event)?;
        file.write_all(b"\n")?;
        file.flush()?;
        Ok(())
    }
}

struct MockPromptResult {
    text: String,
    tool_started: Option<(String, MockToolCall)>,
    tool_finished: Option<(String, String)>,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn Error>> {
    let state = Arc::new(Mutex::new(MockState::from_environment()?));
    let request_state = Arc::clone(&state);

    Agent
        .builder()
        .name("phenix-black-box-mock-agent")
        .on_receive_request(
            async move |request: ClientRequest, responder, connection| {
                let response = match request {
                    ClientRequest::InitializeRequest(initialize) => serde_json::to_value(
                        InitializeResponse::new(initialize.protocol_version)
                            .agent_capabilities(AgentCapabilities::new()),
                    )
                    .map_err(internal_error)?,
                    ClientRequest::NewSessionRequest(_) => request_state
                        .lock()
                        .map_err(|_| agent_client_protocol::Error::internal_error())?
                        .create_session()
                        .map_err(internal_error)?,
                    ClientRequest::SetSessionConfigOptionRequest(request) => {
                        let request = serde_json::to_value(request).map_err(internal_error)?;
                        request_state
                            .lock()
                            .map_err(|_| agent_client_protocol::Error::internal_error())?
                            .select_config(request)
                            .map_err(internal_error)?
                    }
                    ClientRequest::PromptRequest(prompt) => {
                        let session_id = prompt.session_id.clone();
                        let text = prompt
                            .prompt
                            .into_iter()
                            .filter_map(|block| match block {
                                ContentBlock::Text(text) => Some(text.text),
                                _ => None,
                            })
                            .collect::<Vec<_>>()
                            .join("\n");
                        let result = request_state
                            .lock()
                            .map_err(|_| agent_client_protocol::Error::internal_error())?
                            .prompt(&session_id.to_string(), text)
                            .map_err(internal_error)?;

                        connection.send_notification(SessionNotification::new(
                            session_id.clone(),
                            SessionUpdate::AgentMessageChunk(ContentChunk::new(
                                ContentBlock::Text(TextContent::new(result.text)),
                            )),
                        ))?;
                        if let Some((call_id, tool)) = result.tool_started {
                            connection.send_notification(SessionNotification::new(
                                session_id.clone(),
                                SessionUpdate::ToolCall(
                                    ToolCall::new(call_id, tool.name)
                                        .status(ToolCallStatus::InProgress)
                                        .raw_input(tool.input),
                                ),
                            ))?;
                        }
                        if let Some((call_id, output)) = result.tool_finished {
                            connection.send_notification(SessionNotification::new(
                                session_id,
                                SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                                    call_id,
                                    ToolCallUpdateFields::new()
                                        .status(ToolCallStatus::Completed)
                                        .raw_output(json!({ "result": output })),
                                )),
                            ))?;
                        }
                        json!({ "stopReason": StopReason::EndTurn })
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

fn internal_error(error: impl Display) -> agent_client_protocol::Error {
    agent_client_protocol::Error::into_internal_error(std::io::Error::other(error.to_string()))
}

fn required_string(value: &Value, key: &str) -> Result<String, Box<dyn Error>> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("missing string field {key:?}").into())
}
