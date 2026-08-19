#![forbid(unsafe_code)]

mod credentials;
mod oauth;
mod providers;

use credentials::{CredentialStore, StoredCredential};
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
    AuthenticationInput, AuthenticationMethodDescriptor, AuthenticationMethodId,
    AuthenticationMethodKind, AuthenticationState, BackendCatalog, BackendId, InferenceEffort,
    InferenceOptions, ModelDescriptor, ModelId, ModelTarget, ProviderId, SessionId,
};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub const BACKEND_ID: &str = "phenix";

fn parse_configured_model(value: &str) -> Result<ModelTarget, BackendError> {
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
    let target = ModelTarget {
        backend: BackendId::parse(BACKEND_ID)
            .map_err(|error| BackendError::Protocol(error.to_string()))?,
        provider: ProviderId::parse(provider)
            .map_err(|error| BackendError::Protocol(error.to_string()))?,
        model: ModelId::parse(model).map_err(|error| BackendError::Protocol(error.to_string()))?,
        inference: InferenceOptions::default(),
    };
    validate_model_target(&target)?;
    Ok(target)
}

fn model_wire_value(target: &ModelTarget) -> String {
    format!("{}/{}", target.provider, target.model)
}

fn validate_model_target(target: &ModelTarget) -> Result<(), BackendError> {
    if target.backend.as_str() != BACKEND_ID {
        return Err(BackendError::Unsupported(format!(
            "Phenix backend cannot serve target backend {}",
            target.backend
        )));
    }
    if providers::is_gateway_provider(&target.provider) {
        providers::validate_gateway_model(&target.provider, &target.model)
    } else {
        providers::genai_model(&target.provider, &target.model).map(|_| ())
    }
}

fn provider_reasoning_effort(effort: &InferenceEffort) -> ReasoningEffort {
    match effort {
        InferenceEffort::None => ReasoningEffort::None,
        InferenceEffort::Minimal => ReasoningEffort::Minimal,
        InferenceEffort::Low => ReasoningEffort::Low,
        InferenceEffort::Medium => ReasoningEffort::Medium,
        InferenceEffort::High => ReasoningEffort::High,
        InferenceEffort::ExtraHigh => ReasoningEffort::XHigh,
        InferenceEffort::Max => ReasoningEffort::Max,
    }
}

fn dispatch_tool_call<T: serde::Serialize + ?Sized>(
    tools: &PreparedToolSurface,
    host: &mut dyn BackendHost,
    fn_name: &str,
    fn_arguments: &T,
) -> Result<String, BackendError> {
    let Some(descriptor) = tools
        .callables()
        .iter()
        .find(|descriptor| descriptor.id.as_str() == fn_name)
    else {
        return Ok(json!({
            "error": format!("unknown or unavailable Phenix tool {fn_name:?}")
        })
        .to_string());
    };
    let arguments_json = match serde_json::to_string(fn_arguments) {
        Ok(arguments) => arguments,
        Err(error) => {
            return Ok(json!({
                "error": format!("cannot encode tool arguments: {error}")
            })
            .to_string())
        }
    };
    match host.invoke_tool(ToolInvocation {
        callable: descriptor.id.clone(),
        arguments_json,
    }) {
        Ok(result) if result.success => Ok(result.output),
        Ok(result) => Ok(json!({ "error": result.output }).to_string()),
        Err(BackendError::Protocol(error)) => {
            Ok(json!({ "error": format!("tool dispatch failed: {error}") }).to_string())
        }
        Err(error) => Err(error),
    }
}

pub struct PhenixBackend {
    runtime: Arc<tokio::runtime::Runtime>,
    provider: Arc<ProviderClient>,
    codex_provider: Arc<ProviderClient>,
    credentials: CredentialStore,
    models: Vec<ModelTarget>,
    max_tool_rounds: Option<NonZeroUsize>,
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
            max_tool_rounds: configured_max_tool_rounds()?,
            persistent_sessions: BTreeMap::new(),
        })
    }

    fn validate_request(&self, request: &BackendSessionRequest) -> Result<(), BackendError> {
        validate_model_target(&request.model)?;
        if !request.tools.is_empty()
            && request.tools.presentation() != Some(ToolPresentation::Native)
        {
            return Err(BackendError::Unsupported(
                "Phenix backend requires native conductor tool presentation".to_owned(),
            ));
        }
        Ok(())
    }

    fn new_session(&self, request: BackendSessionRequest) -> Arc<PhenixSession> {
        Arc::new(PhenixSession {
            runtime: Arc::clone(&self.runtime),
            provider: Arc::clone(&self.provider),
            codex_provider: Arc::clone(&self.codex_provider),
            credentials: self.credentials.clone(),
            model: Mutex::new(request.model),
            tools: Mutex::new(request.tools),
            max_tool_rounds: self.max_tool_rounds,
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
        let auth_providers = self
            .models
            .iter()
            .filter_map(|target| providers::canonical_auth_provider(&target.provider))
            .collect::<BTreeSet<_>>();
        let models = self
            .models
            .iter()
            .map(|target| model_descriptor(&self.credentials, target))
            .collect::<Result<Vec<_>, BackendError>>()?;
        let mut authentication_methods = Vec::new();
        if auth_providers.contains(oauth::PROVIDER) {
            authentication_methods.push(AuthenticationMethodDescriptor {
                id: AuthenticationMethodId::parse(oauth::PROVIDER)
                    .map_err(|error| BackendError::Protocol(error.to_string()))?,
                backend: backend.clone(),
                provider: ProviderId::parse(oauth::PROVIDER)
                    .map_err(|error| BackendError::Protocol(error.to_string()))?,
                kind: AuthenticationMethodKind::Agent,
                name: "OpenAI Codex (ChatGPT OAuth)".to_owned(),
                description: Some("Browser OAuth for ChatGPT subscription access".to_owned()),
                selectable: true,
            });
        }
        for provider in &auth_providers {
            if *provider == oauth::PROVIDER || !providers::is_api_key_auth_provider(provider) {
                continue;
            }
            authentication_methods.push(AuthenticationMethodDescriptor {
                id: AuthenticationMethodId::parse(*provider)
                    .map_err(|error| BackendError::Protocol(error.to_string()))?,
                backend: backend.clone(),
                provider: ProviderId::parse(*provider)
                    .map_err(|error| BackendError::Protocol(error.to_string()))?,
                kind: AuthenticationMethodKind::ApiKey,
                name: providers::environment_name(provider)
                    .expect("known API-key provider has a name")
                    .to_owned(),
                description: providers::environment_description(provider).map(str::to_owned),
                selectable: true,
            });
        }
        let mut any_authenticated = false;
        for provider in &auth_providers {
            if provider_has_valid_auth(&self.credentials, provider)? {
                any_authenticated = true;
                break;
            }
        }
        let authentication_state = if auth_providers.is_empty() {
            AuthenticationState::NotRequired
        } else if any_authenticated {
            // Authentication is provider-specific while the ACP catalog exposes one
            // backend-wide state. Treat the backend as usable once any configured route
            // has credentials, and let the selected provider report its own missing key.
            AuthenticationState::Authenticated
        } else {
            AuthenticationState::Required
        };
        Ok(BackendCatalog {
            backend,
            models,
            authentication_state,
            authentication_methods,
        })
    }

    fn authenticate(&mut self, method: &AuthenticationMethodId) -> Result<(), BackendError> {
        if method.as_str() != oauth::PROVIDER {
            return Err(BackendError::Unsupported(format!(
                "Phenix backend authentication method {method} requires typed authentication input"
            )));
        }
        self.runtime
            .block_on(oauth::login(&self.credentials))
            .map_err(BackendError::Transport)
    }

    fn authenticate_with_input(
        &mut self,
        method: &AuthenticationMethodId,
        input: Option<&AuthenticationInput>,
    ) -> Result<(), BackendError> {
        if method.as_str() == oauth::PROVIDER {
            if input.is_some() {
                return Err(BackendError::Protocol(
                    "OpenAI Codex OAuth does not accept an API-key payload".to_owned(),
                ));
            }
            return self.authenticate(method);
        }
        if !providers::is_api_key_auth_provider(method.as_str()) {
            return Err(BackendError::Unsupported(format!(
                "Phenix backend does not expose authentication method {method}"
            )));
        }
        let Some(AuthenticationInput::ApiKey { secret }) = input else {
            return Err(BackendError::Protocol(format!(
                "Phenix authentication method {method} requires an API key"
            )));
        };
        self.credentials
            .save_api_key(method.as_str(), secret)
            .map_err(BackendError::Protocol)
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
    credentials: CredentialStore,
    model: Mutex<ModelTarget>,
    tools: Mutex<PreparedToolSurface>,
    max_tool_rounds: Option<NonZeroUsize>,
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

        let provider = if model.provider.as_str() == oauth::PROVIDER {
            &self.codex_provider
        } else {
            &self.provider
        };
        let provider_target =
            match providers::gateway_target(&self.credentials, &model.provider, &model.model)? {
                Some(target) => target,
                None => {
                    let provider_model = providers::genai_model(&model.provider, &model.model)?;
                    provider
                        .resolve_service_target(provider_model)
                        .await
                        .map_err(|error| {
                            BackendError::Transport(format!(
                                "cannot resolve provider target for {}: {error}",
                                model_wire_value(&model)
                            ))
                        })?
                }
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
        let reasoning_effort = model
            .inference
            .effort
            .as_ref()
            .map(provider_reasoning_effort);
        let mut tool_rounds = 0usize;

        loop {
            if let Some(limit) = self.max_tool_rounds {
                if tool_rounds >= limit.get() {
                    return Err(BackendError::Protocol(format!(
                        "provider exceeded {limit} consecutive tool rounds"
                    )));
                }
            }
            tool_rounds += 1;
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
                .exec_chat_stream(provider_target.clone(), request, Some(&options))
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
                let output = dispatch_tool_call(&tools, host, &call.fn_name, &call.fn_arguments)?;
                responses.push(ToolResponse::new(call.call_id, output));
            }
            history.push(ChatMessage::from(responses));
        }
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

fn provider_has_valid_auth(
    credentials: &CredentialStore,
    provider: &ProviderId,
) -> Result<bool, BackendError> {
    let Some(provider) = providers::canonical_auth_provider(provider) else {
        // Supported providers without an auth adapter, such as local Ollama,
        // do not require credentials and remain selectable.
        return Ok(true);
    };
    let stored = credentials
        .resolve(provider)
        .map_err(BackendError::Protocol)?;
    if provider == oauth::PROVIDER {
        return Ok(matches!(stored, Some(StoredCredential::OAuth { .. })));
    }
    if providers::is_api_key_auth_provider(provider) {
        let stored_key = matches!(
            stored,
            Some(StoredCredential::ApiKey { ref secret }) if !secret.trim().is_empty()
        );
        return Ok(stored_key || providers::environment_authenticated(provider));
    }
    Ok(false)
}

fn model_descriptor(
    credentials: &CredentialStore,
    target: &ModelTarget,
) -> Result<ModelDescriptor, BackendError> {
    Ok(ModelDescriptor {
        target: target.clone(),
        name: model_wire_value(target),
        selectable: provider_has_valid_auth(credentials, &target.provider)?,
    })
}

fn configured_max_tool_rounds() -> Result<Option<NonZeroUsize>, BackendError> {
    let value = std::env::var("PHENIX_MAX_TOOL_ROUNDS").ok();
    parse_max_tool_rounds(value.as_deref())
}

fn parse_max_tool_rounds(value: Option<&str>) -> Result<Option<NonZeroUsize>, BackendError> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let parsed = value.parse::<usize>().map_err(|error| {
        BackendError::Protocol(format!(
            "PHENIX_MAX_TOOL_ROUNDS must be a positive integer: {error}"
        ))
    })?;
    NonZeroUsize::new(parsed).map(Some).ok_or_else(|| {
        BackendError::Protocol("PHENIX_MAX_TOOL_ROUNDS must be greater than zero".to_owned())
    })
}

fn configured_models() -> Result<Vec<ModelTarget>, BackendError> {
    let source = std::env::var("PHENIX_MODELS")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("PHENIX_MODEL").ok())
        .unwrap_or_else(|| providers::DEFAULT_MODELS.join(","));
    let mut seen = BTreeSet::new();
    let mut models = Vec::new();
    for value in source
        .split([',', ';', '\n'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let target = parse_configured_model(value)?;
        if seen.insert((target.provider.clone(), target.model.clone())) {
            models.push(target);
        }
    }
    if models.is_empty() {
        return Err(BackendError::Protocol(
            "Phenix model catalog must contain at least one provider/model".to_owned(),
        ));
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_backend::{ToolProvision, ToolResult};
    use phenix_core::{
        CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
    };
    use serde_json::json;

    #[test]
    fn model_catalog_marks_provider_auth_selectability() {
        use std::fs;
        use std::time::{SystemTime, UNIX_EPOCH};

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "phenix-model-auth-test-{}-{unique}",
            std::process::id()
        ));
        let credentials = CredentialStore {
            path: root.join("credentials.json"),
        };
        let codex = parse_configured_model("openai-codex/gpt-test").unwrap();
        let local = parse_configured_model("ollama/local-test").unwrap();

        assert!(!model_descriptor(&credentials, &codex).unwrap().selectable);
        assert!(model_descriptor(&credentials, &local).unwrap().selectable);

        credentials
            .save_oauth(
                oauth::PROVIDER,
                StoredCredential::OAuth {
                    access_token: "access".to_owned(),
                    refresh_token: "refresh".to_owned(),
                    id_token: "id".to_owned(),
                    account_id: "account".to_owned(),
                    expires_at: u64::MAX,
                },
            )
            .unwrap();
        assert!(model_descriptor(&credentials, &codex).unwrap().selectable);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn model_identity_remains_nominal_and_rejects_aliases() {
        let target = parse_configured_model("openai-codex/gpt-5.6-sol").unwrap();
        assert_eq!(target.backend.as_str(), BACKEND_ID);
        assert_eq!(target.provider.as_str(), "openai-codex");
        assert_eq!(target.model.as_str(), "gpt-5.6-sol");
        assert_eq!(
            providers::genai_model(&target.provider, &target.model).unwrap(),
            "openai_resp::gpt-5.6-sol"
        );
        for alias in [
            "openai/gpt-5.6-sol",
            "openai-responses/gpt-5.6-sol",
            "google/gemini-test",
            "opencode/model",
            "openrouter/model",
        ] {
            assert!(parse_configured_model(alias).is_err(), "alias {alias}");
        }
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
    fn tool_round_limit_is_opt_in() {
        assert_eq!(parse_max_tool_rounds(None).unwrap(), None);
        assert_eq!(parse_max_tool_rounds(Some("  ")).unwrap(), None);
        assert_eq!(parse_max_tool_rounds(Some("7")).unwrap().unwrap().get(), 7);
        assert!(matches!(
            parse_max_tool_rounds(Some("0")),
            Err(BackendError::Protocol(_))
        ));
        assert!(matches!(
            parse_max_tool_rounds(Some("many")),
            Err(BackendError::Protocol(_))
        ));
    }

    #[test]
    fn reasoning_effort_is_canonical_core_domain() {
        assert_eq!(
            provider_reasoning_effort(&InferenceEffort::High),
            ReasoningEffort::High
        );
        assert_eq!(
            provider_reasoning_effort(&InferenceEffort::ExtraHigh),
            ReasoningEffort::XHigh
        );
    }

    fn test_tool_surface() -> PreparedToolSurface {
        ToolProvision {
            callables: vec![CallableDescriptor {
                id: CallableId::parse("read").unwrap(),
                kind: CallableKind::Tool,
                description: "test read".to_owned(),
                input_schema: json!({"type": "object"}),
                output_schema: json!({"type": "object"}),
                capabilities: CapabilitySet::default(),
                policy: CallablePolicy::default(),
            }],
        }
        .prepare(&BackendCapabilities {
            tool_presentations: BTreeSet::from([ToolPresentation::Native]),
            images: false,
            persistent_sessions: false,
        })
        .unwrap()
    }

    struct TestToolHost {
        result: Result<ToolResult, BackendError>,
        calls: usize,
    }

    impl BackendHost for TestToolHost {
        fn emit(&mut self, _event: BackendEvent) -> Result<(), BackendError> {
            Ok(())
        }

        fn invoke_tool(&mut self, _invocation: ToolInvocation) -> Result<ToolResult, BackendError> {
            self.calls += 1;
            self.result.clone()
        }
    }

    #[test]
    fn faulty_tool_calls_are_returned_to_the_model_and_transport_failures_remain_fatal() {
        let tools = test_tool_surface();
        let mut host = TestToolHost {
            result: Ok(ToolResult {
                output: "missing file".to_owned(),
                success: false,
            }),
            calls: 0,
        };
        let failed =
            dispatch_tool_call(&tools, &mut host, "read", &json!({"path": "missing"})).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&failed).unwrap()["error"],
            "missing file"
        );
        assert_eq!(host.calls, 1);

        let unknown = dispatch_tool_call(&tools, &mut host, "made_up_tool", &json!({})).unwrap();
        assert!(unknown.contains("unknown or unavailable Phenix tool"));
        assert_eq!(host.calls, 1, "unknown tools must not reach the host");

        let mut protocol_host = TestToolHost {
            result: Err(BackendError::Protocol("bad tool request".to_owned())),
            calls: 0,
        };
        let protocol = dispatch_tool_call(&tools, &mut protocol_host, "read", &json!({})).unwrap();
        assert!(protocol.contains("tool dispatch failed"));

        let mut transport_host = TestToolHost {
            result: Err(BackendError::Transport(
                "persistence unavailable".to_owned(),
            )),
            calls: 0,
        };
        assert!(matches!(
            dispatch_tool_call(&tools, &mut transport_host, "read", &json!({})),
            Err(BackendError::Transport(_))
        ));
    }
}
