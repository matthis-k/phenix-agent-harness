#![forbid(unsafe_code)]

use agent_client_protocol::schema::v1::{
    AuthMethod, AuthenticateRequest, ContentBlock, ContentChunk, ErrorCode, InitializeRequest,
    NewSessionRequest, PromptRequest, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SessionNotification, SessionUpdate, SetSessionConfigOptionRequest,
    TextContent,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, AcpAgentConfig, Agent, ConnectionTo};
use phenix_backend::{
    Backend, BackendCapabilities, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSession, BackendSessionRequest, ToolHostingCapability,
};
use phenix_core::{
    AuthenticationMethodDescriptor, AuthenticationMethodId, AuthenticationMethodKind,
    AuthenticationState, BackendCatalog, BackendId, InferenceOptions, ModelDescriptor, ModelId,
    ModelTarget, ProviderId,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{mpsc, Arc};
use std::task::{Context, Poll, Wake, Waker};
use std::thread;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcpBackendConfig {
    pub backend: BackendId,
    pub provider: ProviderId,
    pub command: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
}

impl AcpBackendConfig {
    #[must_use]
    pub fn new(
        backend: BackendId,
        provider: ProviderId,
        command: impl Into<PathBuf>,
        cwd: impl Into<PathBuf>,
    ) -> Self {
        Self {
            backend,
            provider,
            command: command.into(),
            args: Vec::new(),
            env: BTreeMap::new(),
            cwd: cwd.into(),
        }
    }

    #[must_use]
    pub fn args(mut self, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    #[must_use]
    pub fn env(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(name.into(), value.into());
        self
    }
}

#[derive(Clone, Debug)]
pub struct AcpBackend {
    config: AcpBackendConfig,
}

impl AcpBackend {
    #[must_use]
    pub fn new(config: AcpBackendConfig) -> Self {
        Self { config }
    }

    #[must_use]
    pub fn config(&self) -> &AcpBackendConfig {
        &self.config
    }
}

impl Backend for AcpBackend {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            tool_hosting: ToolHostingCapability::Unsupported,
            images: false,
            persistent_sessions: false,
        }
    }

    fn catalog(&mut self) -> Result<BackendCatalog, BackendError> {
        block_on(discover_catalog(self.config.clone()))
    }

    fn authenticate(&mut self, method: &AuthenticationMethodId) -> Result<(), BackendError> {
        let catalog = self.catalog()?;
        let descriptor = catalog
            .authentication_methods
            .iter()
            .find(|candidate| candidate.id == *method)
            .ok_or_else(|| {
                BackendError::Unsupported(format!(
                    "ACP agent does not advertise authentication method {method}"
                ))
            })?;
        if !descriptor.selectable {
            return Err(BackendError::Unsupported(format!(
                "ACP authentication method {method} requires a frontend credential/terminal flow"
            )));
        }
        block_on(authenticate_agent(self.config.clone(), method.clone()))
    }

    fn open_session(
        &mut self,
        request: BackendSessionRequest,
    ) -> Result<Box<dyn BackendSession>, BackendError> {
        if request.model.backend != self.config.backend {
            return Err(BackendError::Unsupported(format!(
                "ACP backend {} cannot serve target backend {}",
                self.config.backend, request.model.backend
            )));
        }
        if request.model.provider != self.config.provider {
            return Err(BackendError::Unsupported(format!(
                "ACP backend provider {} cannot serve target provider {}",
                self.config.provider, request.model.provider
            )));
        }
        if request.model.inference.effort.is_some() {
            return Err(BackendError::Unsupported(
                "ACP inference effort mapping is not implemented in R7".to_owned(),
            ));
        }
        if !request.tools.callables.is_empty() {
            return Err(BackendError::Unsupported(
                "ACP conductor-tool provisioning is not implemented in R7".to_owned(),
            ));
        }
        Ok(Box::new(AcpBackendSession {
            config: self.config.clone(),
            model: request.model,
        }))
    }
}

#[derive(Debug)]
struct AcpBackendSession {
    config: AcpBackendConfig,
    model: ModelTarget,
}

impl BackendSession for AcpBackendSession {
    fn execute(
        &mut self,
        request: BackendExecutionRequest,
        host: &mut dyn BackendHost,
    ) -> Result<(), BackendError> {
        let config = self.config.clone();
        let model = self.model.clone();
        let prompt = request.prompt;
        let (tx, rx) = mpsc::channel();

        thread::scope(|scope| {
            let worker_tx = tx.clone();
            scope.spawn(move || {
                let done_tx = worker_tx.clone();
                let result = block_on(run_turn(config, model, prompt, worker_tx));
                let _ = done_tx.send(WorkerMessage::Done(result));
            });
            drop(tx);

            let mut host_error = None;
            loop {
                match rx.recv() {
                    Ok(WorkerMessage::Event(event)) => {
                        if host_error.is_none() {
                            host_error = host.emit(event).err();
                        }
                    }
                    Ok(WorkerMessage::Done(result)) => return host_error.map_or(result, Err),
                    Err(error) => {
                        return Err(host_error.unwrap_or_else(|| {
                            BackendError::Transport(format!(
                                "ACP worker channel closed before completion: {error}"
                            ))
                        }));
                    }
                }
            }
        })
    }

    fn cancel(&mut self, _execution_id: &phenix_core::ExecutionId) -> Result<(), BackendError> {
        Err(BackendError::Unsupported(
            "ACP cancellation requires the persistent session lifecycle introduced after R7"
                .to_owned(),
        ))
    }
}

#[derive(Debug)]
enum WorkerMessage {
    Event(BackendEvent),
    Done(Result<(), BackendError>),
}

async fn discover_catalog(config: AcpBackendConfig) -> Result<BackendCatalog, BackendError> {
    let backend = config.backend.clone();
    let provider = config.provider.clone();
    let cwd = config.cwd.clone();
    let agent = new_agent(&config);

    agent_client_protocol::Client
        .builder()
        .connect_with(agent, move |connection: ConnectionTo<Agent>| async move {
            let initialized = connection
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;
            let authentication_methods =
                normalize_auth_methods(&initialized.auth_methods, &backend, &provider)
                    .map_err(to_acp_error)?;

            match connection
                .send_request(NewSessionRequest::new(cwd))
                .block_task()
                .await
            {
                Ok(session) => {
                    let options = serde_json::to_value(&session.config_options)
                        .map_err(agent_client_protocol::Error::into_internal_error)?;
                    let models =
                        model_descriptors(&options, &backend, &provider).map_err(to_acp_error)?;
                    Ok(BackendCatalog {
                        backend,
                        models,
                        authentication_state: if authentication_methods.is_empty() {
                            AuthenticationState::NotRequired
                        } else {
                            AuthenticationState::Authenticated
                        },
                        authentication_methods,
                    })
                }
                Err(error) if error.code == ErrorCode::AuthRequired => Ok(BackendCatalog {
                    backend,
                    models: Vec::new(),
                    authentication_state: AuthenticationState::Required,
                    authentication_methods,
                }),
                Err(error) => Err(error),
            }
        })
        .await
        .map_err(|error| BackendError::Transport(error.to_string()))
}

async fn authenticate_agent(
    config: AcpBackendConfig,
    method: AuthenticationMethodId,
) -> Result<(), BackendError> {
    let agent = new_agent(&config);
    agent_client_protocol::Client
        .builder()
        .connect_with(agent, move |connection: ConnectionTo<Agent>| async move {
            let initialized = connection
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;
            let advertised = initialized
                .auth_methods
                .iter()
                .find(|candidate| candidate.id().0.as_ref() == method.as_str())
                .ok_or_else(|| {
                    agent_client_protocol::Error::invalid_params()
                        .data(format!("unknown authentication method {method}"))
                })?;
            if !matches!(advertised, AuthMethod::Agent(_)) {
                return Err(agent_client_protocol::Error::invalid_params().data(format!(
                    "authentication method {method} requires client-provided credentials or terminal"
                )));
            }
            connection
                .send_request(AuthenticateRequest::new(method.as_str().to_owned()))
                .block_task()
                .await?;
            Ok(())
        })
        .await
        .map_err(|error| BackendError::Transport(error.to_string()))
}

async fn run_turn(
    config: AcpBackendConfig,
    model: ModelTarget,
    prompt: String,
    events: mpsc::Sender<WorkerMessage>,
) -> Result<(), BackendError> {
    let agent = new_agent(&config);
    let notification_events = events.clone();

    agent_client_protocol::Client
        .builder()
        .on_receive_notification(
            async move |notification: SessionNotification, _connection| {
                if let Some(event) = normalize_update(notification.update) {
                    let _ = notification_events.send(WorkerMessage::Event(event));
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |_request: RequestPermissionRequest, responder, _connection| {
                responder.respond(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Cancelled,
                ))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
            connection
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;

            let session = connection
                .send_request(NewSessionRequest::new(config.cwd))
                .block_task()
                .await?;
            let session_id = session.session_id.clone();
            let config_options = serde_json::to_value(&session.config_options)
                .map_err(agent_client_protocol::Error::into_internal_error)?;
            let selection = exact_model_selection(&config_options, model.model.as_str())
                .map_err(to_acp_error)?;
            if selection.current_value.as_deref() != Some(model.model.as_str()) {
                connection
                    .send_request(SetSessionConfigOptionRequest::new(
                        session_id.clone(),
                        selection.config_id,
                        model.model.as_str(),
                    ))
                    .block_task()
                    .await?;
            }

            connection
                .send_request(PromptRequest::new(
                    session_id,
                    vec![ContentBlock::Text(TextContent::new(prompt))],
                ))
                .block_task()
                .await?;
            Ok(())
        })
        .await
        .map_err(|error| BackendError::Transport(error.to_string()))?;

    Ok(())
}

fn new_agent(config: &AcpBackendConfig) -> AcpAgent {
    AcpAgent::new(
        AcpAgentConfig::new(config.command.clone())
            .args(config.args.clone())
            .envs(config.env.clone()),
    )
}

fn to_acp_error(error: BackendError) -> agent_client_protocol::Error {
    agent_client_protocol::Error::internal_error().data(error.to_string())
}

fn normalize_auth_methods(
    methods: &[AuthMethod],
    backend: &BackendId,
    provider: &ProviderId,
) -> Result<Vec<AuthenticationMethodDescriptor>, BackendError> {
    methods
        .iter()
        .map(|method| {
            let (kind, selectable) = match method {
                AuthMethod::Agent(_) => (AuthenticationMethodKind::Agent, true),
                AuthMethod::EnvVar(_) => (AuthenticationMethodKind::Environment, false),
                AuthMethod::Terminal(_) => (AuthenticationMethodKind::Terminal, false),
                _ => (AuthenticationMethodKind::Agent, false),
            };
            Ok(AuthenticationMethodDescriptor {
                id: AuthenticationMethodId::parse(method.id().0.to_string()).map_err(|_| {
                    BackendError::Protocol(
                        "ACP advertised an empty authentication method id".into(),
                    )
                })?,
                backend: backend.clone(),
                provider: provider.clone(),
                kind,
                name: method.name().to_owned(),
                description: method.description().map(ToOwned::to_owned),
                selectable,
            })
        })
        .collect()
}

fn model_descriptors(
    serialized_config_options: &Value,
    backend: &BackendId,
    provider: &ProviderId,
) -> Result<Vec<ModelDescriptor>, BackendError> {
    let model_option = find_model_option(serialized_config_options)?;
    let select_options = model_option.get("options").ok_or_else(|| {
        BackendError::Protocol("ACP model config is not a select option".to_owned())
    })?;
    let mut values = Vec::new();
    collect_select_values(select_options, &mut values);
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .filter(|(value, _)| seen.insert(value.clone()))
        .map(|(value, name)| {
            let model = ModelId::parse(value).map_err(|_| {
                BackendError::Protocol("ACP advertised an empty model value id".to_owned())
            })?;
            Ok(ModelDescriptor {
                target: ModelTarget {
                    backend: backend.clone(),
                    provider: provider.clone(),
                    model,
                    inference: InferenceOptions::default(),
                },
                name,
            })
        })
        .collect()
}

fn find_model_option(serialized_config_options: &Value) -> Result<&Value, BackendError> {
    let options = serialized_config_options.as_array().ok_or_else(|| {
        BackendError::Protocol(
            "ACP session config options did not serialize as an array".to_owned(),
        )
    })?;
    options
        .iter()
        .find(|option| option.get("category").and_then(Value::as_str) == Some("model"))
        .ok_or_else(|| {
            BackendError::Unsupported(
                "ACP agent did not advertise a model configuration option".to_owned(),
            )
        })
}

fn collect_select_values(value: &Value, output: &mut Vec<(String, String)>) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_select_values(value, output);
            }
        }
        Value::Object(object) => {
            if let Some(value) = object.get("value").and_then(Value::as_str) {
                let name = object.get("name").and_then(Value::as_str).unwrap_or(value);
                output.push((value.to_owned(), name.to_owned()));
            }
            if let Some(options) = object.get("options") {
                collect_select_values(options, output);
            }
        }
        _ => {}
    }
}

fn normalize_update(update: SessionUpdate) -> Option<BackendEvent> {
    match update {
        SessionUpdate::AgentMessageChunk(ContentChunk {
            content: ContentBlock::Text(text),
            ..
        }) => Some(BackendEvent::ContentDelta(text.text)),
        SessionUpdate::AgentThoughtChunk(ContentChunk {
            content: ContentBlock::Text(text),
            ..
        }) => Some(BackendEvent::ReasoningDelta(text.text)),
        _ => None,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ModelSelection {
    config_id: String,
    current_value: Option<String>,
}

fn exact_model_selection(
    serialized_config_options: &Value,
    desired_model: &str,
) -> Result<ModelSelection, BackendError> {
    let model_option = find_model_option(serialized_config_options)?;
    let config_id = model_option
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| BackendError::Protocol("ACP model config is missing its id".to_owned()))?;
    let select_options = model_option.get("options").ok_or_else(|| {
        BackendError::Protocol("ACP model config is not a select option".to_owned())
    })?;
    if !contains_select_value(select_options, desired_model) {
        return Err(BackendError::Unsupported(format!(
            "ACP agent does not advertise exact model value {desired_model}"
        )));
    }
    Ok(ModelSelection {
        config_id: config_id.to_owned(),
        current_value: model_option
            .get("currentValue")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    })
}

fn contains_select_value(value: &Value, desired: &str) -> bool {
    match value {
        Value::Array(values) => values
            .iter()
            .any(|value| contains_select_value(value, desired)),
        Value::Object(object) => {
            object.get("value").and_then(Value::as_str) == Some(desired)
                || object
                    .get("options")
                    .is_some_and(|value| contains_select_value(value, desired))
        }
        _ => false,
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_backend::ToolProvision;
    use serde_json::json;

    fn config() -> AcpBackendConfig {
        AcpBackendConfig::new(
            BackendId::parse("pi-acp").unwrap(),
            ProviderId::parse("openai").unwrap(),
            "pi-acp",
            ".",
        )
    }

    fn model() -> ModelTarget {
        ModelTarget {
            backend: BackendId::parse("pi-acp").unwrap(),
            provider: ProviderId::parse("openai").unwrap(),
            model: ModelId::parse("gpt-5.6-sol").unwrap(),
            inference: InferenceOptions::default(),
        }
    }

    #[test]
    fn exact_model_selection_uses_value_id_not_display_name() {
        let options = json!([{
            "id": "model",
            "category": "model",
            "type": "select",
            "currentValue": "other",
            "options": [
                {"value": "other", "name": "Other"},
                {"value": "gpt-5.6-sol", "name": "GPT 5.6 Sol"}
            ]
        }]);
        assert_eq!(
            exact_model_selection(&options, "gpt-5.6-sol").unwrap(),
            ModelSelection {
                config_id: "model".to_owned(),
                current_value: Some("other".to_owned()),
            }
        );
        assert!(matches!(
            exact_model_selection(&options, "GPT 5.6 Sol"),
            Err(BackendError::Unsupported(_))
        ));
    }

    #[test]
    fn model_catalog_preserves_value_ids_and_display_names() {
        let options = json!([{
            "id": "model",
            "category": "model",
            "currentValue": "a",
            "options": [
                {"group": "openai", "options": [{"value": "a", "name": "Model A"}]},
                {"group": "other", "options": [{"value": "b", "name": "Model B"}]}
            ]
        }]);
        let models = model_descriptors(
            &options,
            &BackendId::parse("pi-acp").unwrap(),
            &ProviderId::parse("openai").unwrap(),
        )
        .unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[1].target.model.as_str(), "b");
        assert_eq!(models[1].name, "Model B");
        assert!(exact_model_selection(&options, "b").is_ok());
    }

    #[test]
    fn backend_rejects_non_exact_target_features_before_spawning() {
        let mut backend = AcpBackend::new(config());
        let mut target = model();
        target.inference.effort = Some("high".to_owned());
        assert!(matches!(
            backend.open_session(BackendSessionRequest {
                model: target,
                tools: ToolProvision { callables: vec![] },
            }),
            Err(BackendError::Unsupported(_))
        ));
    }
}
