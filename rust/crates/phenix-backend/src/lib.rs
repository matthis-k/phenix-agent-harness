#![forbid(unsafe_code)]

use phenix_core::{
    AuthenticationMethodId, BackendCatalog, CallableDescriptor, CallableId, ExecutionId,
    ModelTarget,
};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolHostingCapability {
    Native,
    McpStdio,
    AcpExtension,
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackendCapabilities {
    pub tool_hosting: ToolHostingCapability,
    pub images: bool,
    pub persistent_sessions: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolProvision {
    pub callables: Vec<CallableDescriptor>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BackendSessionRequest {
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

pub trait BackendHost {
    fn emit(&mut self, event: BackendEvent) -> Result<(), BackendError>;
    fn invoke_tool(&mut self, invocation: ToolInvocation) -> Result<ToolResult, BackendError>;
}

pub trait BackendSession: Send {
    fn execute(
        &mut self,
        request: BackendExecutionRequest,
        host: &mut dyn BackendHost,
    ) -> Result<(), BackendError>;
    fn cancel(&mut self, execution_id: &ExecutionId) -> Result<(), BackendError>;
}

pub trait Backend: Send {
    fn capabilities(&self) -> BackendCapabilities;

    fn catalog(&mut self) -> Result<BackendCatalog, BackendError> {
        Err(BackendError::Unsupported(
            "backend does not provide model/auth discovery".to_owned(),
        ))
    }

    fn authenticate(&mut self, _method: &AuthenticationMethodId) -> Result<(), BackendError> {
        Err(BackendError::Unsupported(
            "backend does not provide authentication actions".to_owned(),
        ))
    }

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
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported(v) => write!(f, "unsupported backend capability: {v}"),
            Self::Transport(v) => write!(f, "backend transport error: {v}"),
            Self::Protocol(v) => write!(f, "backend protocol error: {v}"),
        }
    }
}
impl Error for BackendError {}
