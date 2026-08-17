#![forbid(unsafe_code)]

mod credentials;
mod oauth;

use credentials::CredentialStore;
use futures::StreamExt;
use genai::chat::{
    ChatMessage, ChatOptions, ChatRequest, ChatStreamEvent, ReasoningEffort, Tool, ToolResponse,
};
use genai::resolver::AuthResolver;
use genai::Client as ProviderClient;
use phenix_backend::{
    Backend, BackendCapabilities, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSession, BackendSessionRequest, PreparedToolSurface, ToolInvocation, ToolPresentation,
};
use phenix_core::{
    AuthenticationMethodDescriptor, AuthenticationMethodId, AuthenticationMethodKind,
    AuthenticationState, BackendCatalog, BackendId, InferenceOptions, ModelDescriptor, ModelId,
    ModelTarget, ProviderId, SessionId,
};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub const BACKEND_ID: &str = "phenix";
const DEFAULT_MODEL: &str = "openai-codex/gpt-5.6";
const MAX_TOOL_ROUNDS: usize = 32;

#[derive(Clone, Debug, Eq, PartialEq)]
struct ModelSelection {
    provider: String,
    model: String,
}

impl ModelSelection {
    fn parse(value: &str) -> Result<Self, BackendError> {
        let (provider, model) = value.split_once('/').ok_or_else(|| {
            BackendError::Protocol(format!(
                "Phenix model selection {value:?} must be provider/model"
            ))
        })?;
        if provider.trim().is_empty() || model.trim().is_empty() {
            return Err(BackendError::Protocol(format!(
                "Phenix model selection {value:?} must be provider/model"
            )));
        }
        Ok(Self {
            provider: provider.to_owned(),
            model: model.to_owned(),
        })
    }

    fn wire_value(&self) -> String {
        format!("{}/{}", self.provider, self.model)
    }

    fn genai_model(&self) -> Result<String, BackendError> {
        let namespace = match self.provider.as_str() {
            "openai" => "openai",
            "openai-codex" | "openai-responses" => "openai_resp",
            "anthropic" => "anthropic",
            "gemini" | "google" => "gemini",
            "opencode" | "opencode-go" => "opencode_go",
            "github-copilot" => "github_copilot",
            "open-router" => "open_router",
            "ollama" => "ollama",
            "ollama-cloud" => "ollama_cloud",
            "deepseek" => "deepseek",
            "groq" => "groq",
            "xai" => "xai",
            other => {
                return Err(BackendError::Unsupported(format!(
                    "unsupported Phenix provider {other:?}"
                )))
            }
        };
        Ok(format!("{namespace}::{}", self.model))
    }

    fn target(&self) -> Result<ModelTarget, BackendError> {
        Ok(ModelTarget {
            backend: BackendId::parse(BACKEND_ID)
                .map_err(|error| BackendError::Protocol(error.to_string()))?,
            provider: ProviderId::parse(self.provider.clone())
                .map_err(|error| BackendError::Protocol(error.to_string()))?,
            model: ModelId::parse(self.model.clone())
                .map_err(|error| BackendError::Protocol(error.to_string()))?,
            inference: InferenceOptions::default(),
        })
    }
}

pub struct PhenixBackend {
    runtime: Arc<tokio::runtime::Runtime>,
    provider: Arc<ProviderClient>,
    codex_provider: Arc<ProviderClient>,
    credentials: CredentialStore,
    models: Vec<ModelSelection>,
    persistent_sessions: BTreeMap<SessionId, Arc<PhenixSession>>,
}

impl PhenixBackend {
    pub fn from_environment() -> Result<Self, BackendError> {
        let credentials = CredentialStore::discover().map_err(BackendError::Protocol)?;
        let resolver_store = credentials.clone();
        let auth_resolver =
            AuthResolver::from_resolver_fn(move |model| resolver_store.auth_for_model(model));
        let provider = ProviderClient::builder()
            .with_auth_resolver(auth_resolver)
            .build();
        let codex_oauth = oauth::CodexOAuth::new(credentials.clone());
        let codex_auth_resolver = AuthResolver::from_resolver_async_fn(
            move |_model| -> std::pin::Pin<
                Box<
                    dyn std::future::Future<
                            Output = Result<
                                Option<genai::resolver::AuthData>,
                                genai::resolver::Error,
                            >,
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
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|error| {
                BackendError::Transport(format!("cannot start Phenix provider runtime: {error}"))
            })?;
        Ok(Self {
            runtime: Arc::new(runtime),
            provider: Arc::new(provider),
            codex_provider: Arc::new(codex_provider),
            credentials,
            models: configured_models()?,
            persistent_sessions: BTreeMap::new(),
        })
    }

    fn validate_request(&self, request: &BackendSessionRequest) -> Result<(), BackendError> {
        if request.model.backend.as_str() != BACKEND_ID {
            return Err(BackendError::Unsupported(format!(
                "Phenix backend cannot serve target backend {}",
                request.model.backend
            )));
        }
        ModelSelection {
            provider: request.model.provider.as_str().to_owned(),
            model: request.model.model.as_str().to_owned(),
        }
        .genai_model()?;
        if !request.tools.is_empty()
            && request.tools.presentation() != Some(ToolPresentation::Native)
        {
            return Err(BackendError::Unsupported(
                "Phenix backend requires native conductor tool presentation".to_owned(),
            ));
        }
        parse_reasoning_effort(request.model.inference.effort.as_deref())?;
        Ok(())
    }

    fn new_session(&self, request: BackendSessionRequest) -> Arc<PhenixSession> {
        Arc::new(PhenixSession {
            runtime: Arc::clone(&self.runtime),
            provider: Arc::clone(&self.provider),
            codex_provider: Arc::clone(&self.codex_provider),
            model: Mutex::new(request.model),
            tools: Mutex::new(request.tools),
            history: Mutex::new(Vec::new()),
            active: Mutex::new(false),
            cancelled: AtomicBool::new(false),
        })
    }
}

impl Backend for PhenixBackend {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            tool_presentations: BTreeSet::from([ToolPresentation::Native]),
            images: false,
            persistent_sessions: true,
        }
    }

    fn catalog(&mut self) -> Result<BackendCatalog, BackendError> {
        let backend = BackendId::parse(BACKEND_ID)
            .map_err(|error| BackendError::Protocol(error.to_string()))?;
        let models = self
            .models
            .iter()
            .map(|selection| {
                Ok(ModelDescriptor {
                    target: selection.target()?,
                    name: selection.wire_value(),
                })
            })
            .collect::<Result<Vec<_>, BackendError>>()?;
        let uses_codex = self
            .models
            .iter()
            .any(|selection| selection.provider == oauth::PROVIDER);
        let codex_authenticated = self
            .credentials
            .resolve(oauth::PROVIDER)
            .map_err(BackendError::Protocol)?
            .is_some();
        let authentication_methods = if uses_codex {
            vec![AuthenticationMethodDescriptor {
                id: AuthenticationMethodId::parse(oauth::PROVIDER)
                    .map_err(|error| BackendError::Protocol(error.to_string()))?,
                backend: backend.clone(),
                provider: ProviderId::parse(oauth::PROVIDER)
                    .map_err(|error| BackendError::Protocol(error.to_string()))?,
                kind: AuthenticationMethodKind::Agent,
                name: "OpenAI Codex (ChatGPT)".to_owned(),
                description: Some("Browser OAuth for ChatGPT subscription access".to_owned()),
                selectable: true,
            }]
        } else {
            Vec::new()
        };
        Ok(BackendCatalog {
            backend,
            models,
            authentication_state: if uses_codex && !codex_authenticated {
                AuthenticationState::Required
            } else if authentication_methods.is_empty() {
                AuthenticationState::NotRequired
            } else {
                AuthenticationState::Authenticated
            },
            authentication_methods,
        })
    }

    fn authenticate(&mut self, method: &AuthenticationMethodId) -> Result<(), BackendError> {
        if method.as_str() != oauth::PROVIDER {
            return Err(BackendError::Unsupported(format!(
                "Phenix backend does not expose authentication method {method}"
            )));
        }
        self.runtime
            .block_on(oauth::login(&self.credentials))
            .map_err(BackendError::Transport)
    }

    fn open_session(
        &mut self,
        request: BackendSessionRequest,
    ) -> Result<Arc<dyn BackendSession>, BackendError> {
        self.validate_request(&request)?;
        Ok(self.new_session(request))
    }

    fn open_persistent_session(
        &mut self,
        session_id: &SessionId,
        request: BackendSessionRequest,
    ) -> Result<Arc<dyn BackendSession>, BackendError> {
        self.validate_request(&request)?;
        if let Some(session) = self.persistent_sessions.get(session_id) {
            session.set_request(request.model, request.tools)?;
            return Ok(session.clone());
        }
        let session = self.new_session(request);
        self.persistent_sessions
            .insert(session_id.clone(), session.clone());
        Ok(session)
    }

    fn close_persistent_session(&mut self, session_id: &SessionId) -> Result<(), BackendError> {
        self.persistent_sessions.remove(session_id);
        Ok(())
    }
}

struct PhenixSession {
    runtime: Arc<tokio::runtime::Runtime>,
    provider: Arc<ProviderClient>,
    codex_provider: Arc<ProviderClient>,
    model: Mutex<ModelTarget>,
    tools: Mutex<PreparedToolSurface>,
    history: Mutex<Vec<ChatMessage>>,
    active: Mutex<bool>,
    cancelled: AtomicBool,
}

impl PhenixSession {
    fn set_request(
        &self,
        model: ModelTarget,
        tools: PreparedToolSurface,
    ) -> Result<(), BackendError> {
        *self
            .model
            .lock()
            .map_err(|_| BackendError::Protocol("Phenix model lock poisoned".to_owned()))? = model;
        *self
            .tools
            .lock()
            .map_err(|_| BackendError::Protocol("Phenix tool lock poisoned".to_owned()))? = tools;
        Ok(())
    }

    async fn execute_turn(
        &self,
        prompt: String,
        host: &mut dyn BackendHost,
    ) -> Result<Vec<ChatMessage>, BackendError> {
        let model = self
            .model
            .lock()
            .map_err(|_| BackendError::Protocol("Phenix model lock poisoned".to_owned()))?
            .clone();
        let tools = self
            .tools
            .lock()
            .map_err(|_| BackendError::Protocol("Phenix tool lock poisoned".to_owned()))?
            .clone();
        let mut history = self
            .history
            .lock()
            .map_err(|_| BackendError::Protocol("Phenix history lock poisoned".to_owned()))?
            .clone();
        history.push(ChatMessage::user(prompt));

        let selection = ModelSelection {
            provider: model.provider.as_str().to_owned(),
            model: model.model.as_str().to_owned(),
        };
        let provider_model = selection.genai_model()?;
        let provider = if selection.provider == oauth::PROVIDER {
            &self.codex_provider
        } else {
            &self.provider
        };
        let tool_definitions = tools
            .callables()
            .iter()
            .map(|descriptor| {
                Tool::new(descriptor.id.as_str())
                    .with_description(descriptor.description.clone())
                    .with_schema(descriptor.input_schema.clone())
            })
            .collect::<Vec<_>>();
        let reasoning_effort = parse_reasoning_effort(model.inference.effort.as_deref())?;

        for _round in 0..MAX_TOOL_ROUNDS {
            if self.cancelled.load(Ordering::Acquire) {
                return Ok(history);
            }
            let request = ChatRequest::new(history.clone()).with_tools(tool_definitions.clone());
            let mut options = ChatOptions::default()
                .with_capture_content(true)
                .with_capture_reasoning_content(true)
                .with_capture_tool_calls(true);
            if let Some(effort) = reasoning_effort.clone() {
                options = options.with_reasoning_effort(effort);
            }
            let mut stream = provider
                .exec_chat_stream(&provider_model, request, Some(&options))
                .await
                .map_err(|error| {
                    BackendError::Transport(format!("provider request failed: {error}"))
                })?;
            let mut captured = None;
            while let Some(event) = stream.stream.next().await {
                if self.cancelled.load(Ordering::Acquire) {
                    return Ok(history);
                }
                match event.map_err(|error| {
                    BackendError::Transport(format!("provider stream failed: {error}"))
                })? {
                    ChatStreamEvent::Chunk(chunk) => {
                        host.emit(BackendEvent::ContentDelta(chunk.content))?;
                    }
                    ChatStreamEvent::ReasoningChunk(chunk) => {
                        host.emit(BackendEvent::ReasoningDelta(chunk.content))?;
                    }
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
                return Ok(history);
            }

            let mut responses = Vec::new();
            for call in tool_calls {
                let descriptor = tools
                    .callables()
                    .iter()
                    .find(|descriptor| descriptor.id.as_str() == call.fn_name)
                    .ok_or_else(|| {
                        BackendError::Protocol(format!(
                            "provider requested unknown Phenix tool {:?}",
                            call.fn_name
                        ))
                    })?;
                let result = host.invoke_tool(ToolInvocation {
                    callable: descriptor.id.clone(),
                    arguments_json: serde_json::to_string(&call.fn_arguments).map_err(|error| {
                        BackendError::Protocol(format!("cannot encode tool arguments: {error}"))
                    })?,
                })?;
                let output = if result.success {
                    result.output
                } else {
                    json!({ "error": result.output }).to_string()
                };
                responses.push(ToolResponse::new(call.call_id, output));
            }
            history.push(ChatMessage::from(responses));
        }

        Err(BackendError::Protocol(format!(
            "provider exceeded {MAX_TOOL_ROUNDS} consecutive tool rounds"
        )))
    }
}

impl BackendSession for PhenixSession {
    fn execute(
        &self,
        request: BackendExecutionRequest,
        host: &mut dyn BackendHost,
    ) -> Result<(), BackendError> {
        {
            let mut active = self
                .active
                .lock()
                .map_err(|_| BackendError::Protocol("Phenix active lock poisoned".to_owned()))?;
            if *active {
                return Err(BackendError::Protocol(
                    "Phenix backend session is already executing".to_owned(),
                ));
            }
            *active = true;
        }
        self.cancelled.store(false, Ordering::Release);
        let result = self
            .runtime
            .block_on(self.execute_turn(request.prompt, host));
        if let Ok(mut active) = self.active.lock() {
            *active = false;
        }
        if let Ok(history) = &result {
            *self
                .history
                .lock()
                .map_err(|_| BackendError::Protocol("Phenix history lock poisoned".to_owned()))? =
                history.clone();
        }
        result.map(|_| ())
    }

    fn cancel(&self, _execution_id: &phenix_core::ExecutionId) -> Result<(), BackendError> {
        self.cancelled.store(true, Ordering::Release);
        Ok(())
    }
}

fn configured_models() -> Result<Vec<ModelSelection>, BackendError> {
    let source = std::env::var("PHENIX_MODELS")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("PHENIX_MODEL").ok())
        .unwrap_or_else(|| DEFAULT_MODEL.to_owned());
    let mut seen = BTreeSet::new();
    let mut models = Vec::new();
    for value in source
        .split([',', ';', '\n'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let selection = ModelSelection::parse(value)?;
        if seen.insert(selection.wire_value()) {
            models.push(selection);
        }
    }
    if models.is_empty() {
        return Err(BackendError::Protocol(
            "Phenix model catalog must contain at least one provider/model".to_owned(),
        ));
    }
    Ok(models)
}

fn parse_reasoning_effort(value: Option<&str>) -> Result<Option<ReasoningEffort>, BackendError> {
    value
        .map(|value| match value {
            "off" | "none" => Ok(ReasoningEffort::None),
            "minimal" => Ok(ReasoningEffort::Minimal),
            "low" => Ok(ReasoningEffort::Low),
            "medium" => Ok(ReasoningEffort::Medium),
            "high" => Ok(ReasoningEffort::High),
            "extra_high" | "xhigh" => Ok(ReasoningEffort::XHigh),
            "max" => Ok(ReasoningEffort::Max),
            other => Err(BackendError::Unsupported(format!(
                "unsupported Phenix reasoning effort {other:?}"
            ))),
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_backend::ToolProvision;

    #[test]
    fn model_identity_preserves_provider_and_model() {
        let selection = ModelSelection::parse("openai-codex/gpt-5.6-sol").unwrap();
        let target = selection.target().unwrap();
        assert_eq!(target.backend.as_str(), BACKEND_ID);
        assert_eq!(target.provider.as_str(), "openai-codex");
        assert_eq!(target.model.as_str(), "gpt-5.6-sol");
        assert_eq!(selection.genai_model().unwrap(), "openai_resp::gpt-5.6-sol");
    }

    #[test]
    fn native_backend_negotiates_native_tools() {
        let capabilities = BackendCapabilities {
            tool_presentations: BTreeSet::from([ToolPresentation::Native]),
            images: false,
            persistent_sessions: true,
        };
        let surface = ToolProvision::default().prepare(&capabilities).unwrap();
        assert!(surface.is_empty());
        assert!(capabilities.persistent_sessions);
    }

    #[test]
    fn reasoning_effort_uses_typed_inference_option() {
        assert!(matches!(
            parse_reasoning_effort(Some("high")),
            Ok(Some(ReasoningEffort::High))
        ));
        assert!(matches!(
            parse_reasoning_effort(Some("unsupported")),
            Err(BackendError::Unsupported(_))
        ));
    }
}
