#![forbid(unsafe_code)]

use phenix_core::{
    AuthenticationMethodId, BackendCatalog, CallableDescriptor, CallableId, ExecutionId,
    ModelTarget, SessionId,
};
use std::collections::BTreeSet;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::Arc;

/// Concrete representation used to materialize conductor-owned callables for a
/// backend session. This is intentionally distinct from callable semantics:
/// the same `ToolProvision` may be represented natively, through MCP, or by an
/// ACP extension without changing the callable contract itself.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Hash)]
pub enum ToolPresentation {
    Native,
    McpStdio,
    AcpExtension,
}

const TOOL_PRESENTATION_PREFERENCE: [ToolPresentation; 3] = [
    ToolPresentation::Native,
    ToolPresentation::AcpExtension,
    ToolPresentation::McpStdio,
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackendCapabilities {
    /// Every representation this backend can use for conductor-owned callables.
    /// The conductor selects one deterministic presentation per session.
    pub tool_presentations: BTreeSet<ToolPresentation>,
    pub images: bool,
    pub persistent_sessions: bool,
}

impl BackendCapabilities {
    #[must_use]
    pub fn preferred_tool_presentation(&self) -> Option<ToolPresentation> {
        TOOL_PRESENTATION_PREFERENCE
            .into_iter()
            .find(|presentation| self.tool_presentations.contains(presentation))
    }
}

/// Semantic conductor-owned callable provision before backend presentation is
/// selected.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ToolProvision {
    pub callables: Vec<CallableDescriptor>,
}

/// A `ToolProvision` after backend capability negotiation. Construction is
/// private so an empty surface cannot claim a presentation and a populated
/// surface cannot bypass conductor-owned negotiation.
#[derive(Clone, Debug, PartialEq)]
pub struct PreparedToolSurface {
    presentation: Option<ToolPresentation>,
    callables: Vec<CallableDescriptor>,
}

impl PreparedToolSurface {
    #[must_use]
    pub fn presentation(&self) -> Option<ToolPresentation> {
        self.presentation
    }

    #[must_use]
    pub fn callables(&self) -> &[CallableDescriptor] {
        &self.callables
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.callables.is_empty()
    }
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
        let presentation = capabilities.preferred_tool_presentation().ok_or_else(|| {
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
    /// Stable Phenix conversation identity. Backends that advertise
    /// `persistent_sessions` may use this identity to reopen/reuse their native
    /// conversation instead of creating an unrelated conversation per turn.
    pub session_id: SessionId,
    pub model: ModelTarget,
    pub tools: PreparedToolSurface,
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

    fn capabilities(
        presentations: impl IntoIterator<Item = ToolPresentation>,
    ) -> BackendCapabilities {
        BackendCapabilities {
            tool_presentations: presentations.into_iter().collect(),
            images: false,
            persistent_sessions: false,
        }
    }

    #[test]
    fn empty_tool_provision_needs_no_presentation() {
        let surface = ToolProvision::default().prepare(&capabilities([])).unwrap();
        assert_eq!(surface.presentation(), None);
        assert!(surface.is_empty());
        assert!(surface.callables().is_empty());
    }

    #[test]
    fn backend_can_advertise_multiple_presentations_with_deterministic_preference() {
        let supported = capabilities([
            ToolPresentation::McpStdio,
            ToolPresentation::AcpExtension,
            ToolPresentation::Native,
        ]);
        assert_eq!(
            supported.preferred_tool_presentation(),
            Some(ToolPresentation::Native)
        );
        assert_eq!(capabilities([]).preferred_tool_presentation(), None);
    }
}
