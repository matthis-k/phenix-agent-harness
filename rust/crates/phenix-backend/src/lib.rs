#![forbid(unsafe_code)]

use phenix_core::{
    AuthenticationMethodId, BackendCatalog, CallableDescriptor, CallableId, ExecutionId,
    ModelTarget,
};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::Arc;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolHostingCapability {
    Native,
    McpStdio,
    AcpExtension,
    Unsupported,
}

/// Concrete representation used to materialize conductor-owned callables for a
/// backend session. This is intentionally distinct from callable semantics:
/// the same `ToolProvision` may be represented natively, through MCP, or by an
/// ACP extension without changing the callable contract itself.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolPresentation {
    Native,
    McpStdio,
    AcpExtension,
}

impl ToolHostingCapability {
    #[must_use]
    pub fn presentation(&self) -> Option<ToolPresentation> {
        match self {
            Self::Native => Some(ToolPresentation::Native),
            Self::McpStdio => Some(ToolPresentation::McpStdio),
            Self::AcpExtension => Some(ToolPresentation::AcpExtension),
            Self::Unsupported => None,
        }
    }
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

/// A `ToolProvision` after backend capability negotiation. Empty provisions do
/// not require a presentation; non-empty provisions always carry the concrete
/// transport representation chosen before the backend session is opened.
#[derive(Clone, Debug, PartialEq)]
pub struct PreparedToolSurface {
    pub presentation: Option<ToolPresentation>,
    pub callables: Vec<CallableDescriptor>,
}

impl ToolProvision {
    pub fn prepare(
        self,
        capabilities: &BackendCapabilities,
    ) -> Result<PreparedToolSurface, BackendError> {
        if self.callables.is_empty() {
            return Ok(PreparedToolSurface {
                presentation: None,
                callables: self.callables,
            });
        }
        let presentation = capabilities.tool_hosting.presentation().ok_or_else(|| {
            BackendError::Unsupported("backend cannot host conductor-provisioned tools".to_owned())
        })?;
        Ok(PreparedToolSurface {
            presentation: Some(presentation),
            callables: self.callables,
        })
    }
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

/// A materialized backend session may be executing on the conductor execution
/// worker while a frontend request concurrently asks it to cancel. Implementors
/// therefore expose thread-safe shared methods rather than requiring exclusive
/// ownership for the lifetime of a model turn.
pub trait BackendSession: Send + Sync {
    fn execute(
        &self,
        request: BackendExecutionRequest,
        host: &mut dyn BackendHost,
    ) -> Result<(), BackendError>;
    fn cancel(&self, execution_id: &ExecutionId) -> Result<(), BackendError>;
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
    ) -> Result<Arc<dyn BackendSession>, BackendError>;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn capabilities(tool_hosting: ToolHostingCapability) -> BackendCapabilities {
        BackendCapabilities {
            tool_hosting,
            images: false,
            persistent_sessions: false,
        }
    }

    #[test]
    fn empty_tool_provision_needs_no_presentation() {
        let surface = ToolProvision {
            callables: Vec::new(),
        }
        .prepare(&capabilities(ToolHostingCapability::Unsupported))
        .unwrap();
        assert_eq!(surface.presentation, None);
        assert!(surface.callables.is_empty());
    }

    #[test]
    fn tool_presentation_is_selected_from_backend_capability() {
        let surface = ToolProvision {
            callables: vec![CallableDescriptor {
                id: phenix_core::CallableId::parse("echo").unwrap(),
                kind: phenix_core::CallableKind::Tool,
                description: "echo".to_owned(),
                input_schema: serde_json::json!({"type": "object"}),
                output_schema: serde_json::json!({"type": "object"}),
                capabilities: phenix_core::CapabilitySet::default(),
                policy: phenix_core::CallablePolicy::default(),
            }],
        }
        .prepare(&capabilities(ToolHostingCapability::Native))
        .unwrap();
        assert_eq!(surface.presentation, Some(ToolPresentation::Native));
        assert_eq!(surface.callables.len(), 1);
    }

    #[test]
    fn required_tool_surface_rejects_unsupported_backend() {
        let error = ToolProvision {
            callables: vec![CallableDescriptor {
                id: phenix_core::CallableId::parse("echo").unwrap(),
                kind: phenix_core::CallableKind::Tool,
                description: "echo".to_owned(),
                input_schema: serde_json::json!({"type": "object"}),
                output_schema: serde_json::json!({"type": "object"}),
                capabilities: phenix_core::CapabilitySet::default(),
                policy: phenix_core::CallablePolicy::default(),
            }],
        }
        .prepare(&capabilities(ToolHostingCapability::Unsupported))
        .unwrap_err();
        assert!(matches!(error, BackendError::Unsupported(_)));
    }
}
