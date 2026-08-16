#![forbid(unsafe_code)]

use agent_client_protocol::schema::v1::{
    ContentBlock, ContentChunk, InitializeRequest, NewSessionRequest, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SessionNotification, SessionUpdate, SetSessionConfigOptionRequest, TextContent,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, AcpAgentConfig, Agent, ConnectionTo};
use phenix_backend::{
    Backend, BackendCapabilities, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSession, BackendSessionRequest, ToolHostingCapability,
};
use phenix_core::{BackendId, ModelTarget, ProviderId};
use serde_json::Value;
use std::collections::BTreeMap;
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
                    Ok(WorkerMessage::Done(result)) => {
                        return host_error.map_or(result, Err);
                    }
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

async fn run_turn(
    config: AcpBackendConfig,
    model: ModelTarget,
    prompt: String,
    events: mpsc::Sender<WorkerMessage>,
) -> Result<(), BackendError> {
    let agent = AcpAgent::new(
        AcpAgentConfig::new(config.command.clone())
            .args(config.args.clone())
            .envs(config.env.clone()),
    );
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
            let selection =
                exact_model_selection(&config_options, model.model.as_str()).map_err(|error| {
                    agent_client_protocol::Error::internal_error().data(error.to_string())
                })?;
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
    let options = match serialized_config_options {
        Value::Array(options) => options,
        Value::Null => {
            return Err(BackendError::Unsupported(
                "ACP agent did not advertise a model configuration option".to_owned(),
            ));
        }
        _ => {
            return Err(BackendError::Protocol(
                "ACP session config options did not serialize as an array".to_owned(),
            ));
        }
    };

    let model_option = options
        .iter()
        .find(|option| option.get("category").and_then(Value::as_str) == Some("model"))
        .ok_or_else(|| {
            BackendError::Unsupported(
                "ACP agent did not advertise a model configuration option".to_owned(),
            )
        })?;
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
    use phenix_core::{InferenceOptions, ModelId};
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
        let options = json!([
            {
                "id": "model",
                "category": "model",
                "type": "select",
                "currentValue": "other",
                "options": [
                    {"value": "other", "name": "Other"},
                    {"value": "gpt-5.6-sol", "name": "GPT 5.6 Sol"}
                ]
            }
        ]);
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
    fn grouped_model_options_are_supported_without_name_matching() {
        let options = json!([
            {
                "id": "model",
                "category": "model",
                "currentValue": "a",
                "options": [
                    {"group": "openai", "options": [{"value": "a", "name": "A"}]},
                    {"group": "other", "options": [{"value": "b", "name": "B"}]}
                ]
            }
        ]);
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
