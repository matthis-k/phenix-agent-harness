use crate::{CallableDescriptor, ExecutionId, ModelTarget};
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolHostingCapability {
    Native,
    McpStdio,
    AcpExtension,
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendCapabilities {
    pub tool_hosting: ToolHostingCapability,
    pub images: bool,
    pub persistent_sessions: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackendRequest {
    pub execution_id: ExecutionId,
    /// Routing is resolved before reaching a backend adapter. Adapters receive
    /// one concrete model target and never implement Phenix routing policy.
    pub model: ModelTarget,
    pub prompt: String,
    pub tools: Vec<CallableDescriptor>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BackendEvent {
    ContentDelta(String),
    ReasoningDelta(String),
    ToolCall {
        name: String,
        arguments_json: String,
    },
    Completed,
}

pub trait BackendEventSink {
    fn emit(&mut self, event: BackendEvent) -> Result<(), BackendError>;
}

/// Backend adapters translate provider/protocol mechanics only. They do not own
/// Phenix sessions, workflows, routing, policy or tool semantics.
pub trait Backend: Send {
    fn capabilities(&self) -> BackendCapabilities;

    fn execute(
        &mut self,
        request: BackendRequest,
        events: &mut dyn BackendEventSink,
    ) -> Result<(), BackendError>;

    fn cancel(&mut self, execution_id: &ExecutionId) -> Result<(), BackendError>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BackendError {
    Unsupported(String),
    Transport(String),
    Protocol(String),
}

impl Display for BackendError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported(message) => write!(formatter, "unsupported backend operation: {message}"),
            Self::Transport(message) => write!(formatter, "backend transport error: {message}"),
            Self::Protocol(message) => write!(formatter, "backend protocol error: {message}"),
        }
    }
}

impl Error for BackendError {}
