use crate::{CallableDescriptor, CallableId, ExecutionId, ModelTarget};
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

/// Conductor-owned tool semantics bound to one backend session.
///
/// Adapters may translate this provision into a native tool API, MCP, or an
/// ACP extension, but they must not reinterpret the callable semantics.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolProvision {
    pub callables: Vec<CallableDescriptor>,
}

impl ToolProvision {
    #[must_use]
    pub fn empty() -> Self {
        Self {
            callables: Vec::new(),
        }
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.callables.is_empty()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackendSessionRequest {
    /// Routing is resolved before reaching a backend adapter. Adapters receive
    /// one concrete target and never implement Phenix routing policy.
    pub model: ModelTarget,
    pub tools: ToolProvision,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackendExecutionRequest {
    pub execution_id: ExecutionId,
    pub prompt: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BackendEvent {
    ContentDelta(String),
    ReasoningDelta(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolInvocation {
    pub callable: CallableId,
    pub arguments_json: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolResult {
    pub output: String,
    pub success: bool,
}

/// Invocation surface supplied by the conductor to a materialized backend
/// session. Streaming output is emitted through `emit`; model-requested tools
/// synchronously re-enter the conductor through `invoke_tool` and receive the
/// conductor-owned result.
pub trait BackendHost {
    fn emit(&mut self, event: BackendEvent) -> Result<(), BackendError>;

    fn invoke_tool(&mut self, invocation: ToolInvocation) -> Result<ToolResult, BackendError>;
}

/// One materialized provider/agent session.
///
/// Backend session identifiers and transport-specific lifecycle remain adapter
/// implementation details. The conductor addresses executions by Phenix IDs.
pub trait BackendSession: Send {
    fn execute(
        &mut self,
        request: BackendExecutionRequest,
        host: &mut dyn BackendHost,
    ) -> Result<(), BackendError>;

    fn cancel(&mut self, execution_id: &ExecutionId) -> Result<(), BackendError>;
}

/// Backend adapters translate provider/protocol mechanics only. They do not own
/// Phenix sessions, workflows, routing, policy or tool semantics.
pub trait Backend: Send {
    fn capabilities(&self) -> BackendCapabilities;

    fn open_session(
        &mut self,
        request: BackendSessionRequest,
    ) -> Result<Box<dyn BackendSession>, BackendError>;
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
            Self::Unsupported(message) => {
                write!(formatter, "unsupported backend operation: {message}")
            }
            Self::Transport(message) => write!(formatter, "backend transport error: {message}"),
            Self::Protocol(message) => write!(formatter, "backend protocol error: {message}"),
        }
    }
}

impl Error for BackendError {}
