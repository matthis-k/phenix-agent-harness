use crate::{CallableOperation, ConductorError, ConductorRuntime, ExecutionPayload};
use phenix_core::{CallableId, ConfigRevisionId, ExecutionId, ExecutionState, SessionId};
use std::fmt::{self, Debug, Display, Formatter};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutionProviderKind {
    Model,
    Native,
    Acp,
    RemotePhenix,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionProviderRequest {
    pub execution_id: ExecutionId,
    pub session_id: SessionId,
    pub parent_execution: Option<ExecutionId>,
    pub callable: CallableId,
    pub config_revision: ConfigRevisionId,
    pub objective: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExecutionProviderEvent {
    ReasoningDelta(String),
    ContentDelta(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExecutionProviderError {
    Unsupported(String),
    Failed(String),
    Protocol(String),
}

impl Display for ExecutionProviderError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported(message) => {
                write!(f, "unsupported execution provider capability: {message}")
            }
            Self::Failed(message) => write!(f, "execution provider failed: {message}"),
            Self::Protocol(message) => write!(f, "execution provider protocol error: {message}"),
        }
    }
}

impl std::error::Error for ExecutionProviderError {}

pub trait ExecutionProviderHost {
    fn emit(&mut self, event: ExecutionProviderEvent) -> Result<(), ExecutionProviderError>;
}

pub trait ExecutionProvider: Send + Sync {
    fn kind(&self) -> ExecutionProviderKind;

    fn execute(
        &self,
        request: &ExecutionProviderRequest,
        host: &mut dyn ExecutionProviderHost,
    ) -> Result<(), ExecutionProviderError>;

    fn cancel(&self, _execution_id: &ExecutionId) -> Result<(), ExecutionProviderError> {
        Err(ExecutionProviderError::Unsupported(
            "provider does not implement cancellation".to_owned(),
        ))
    }
}

#[derive(Clone)]
pub enum ExecutionProviderBinding {
    Model,
    Provider(Arc<dyn ExecutionProvider>),
}

impl ExecutionProviderBinding {
    #[must_use]
    pub fn kind(&self) -> ExecutionProviderKind {
        match self {
            Self::Model => ExecutionProviderKind::Model,
            Self::Provider(provider) => provider.kind(),
        }
    }

    #[must_use]
    pub fn provider(&self) -> Option<&Arc<dyn ExecutionProvider>> {
        match self {
            Self::Model => None,
            Self::Provider(provider) => Some(provider),
        }
    }
}

impl Debug for ExecutionProviderBinding {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExecutionProviderBinding")
            .field("kind", &self.kind())
            .finish_non_exhaustive()
    }
}

impl ConductorRuntime {
    /// Resolve the immutable provider dispatch inputs while the caller holds
    /// the runtime lock. The returned provider/request pair is then safe to
    /// execute after releasing that lock, which keeps frontend cancellation
    /// and event delivery responsive during a blocking provider call.
    pub(crate) fn prepare_provider_execution(
        &self,
        execution_id: &ExecutionId,
    ) -> Result<(Arc<dyn ExecutionProvider>, ExecutionProviderRequest), ConductorError> {
        let (summary, input) = {
            let execution = self
                .executions
                .get(execution_id)
                .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?;
            if execution.summary.state != ExecutionState::Pending {
                return Err(ConductorError::InvalidLifecycle(execution_id.clone()));
            }
            let ExecutionPayload::Invocation { input } = &execution.payload else {
                return Err(ConductorError::NonProviderExecution(execution_id.clone()));
            };
            (execution.summary.clone(), input.clone())
        };
        let callable = summary
            .callable
            .clone()
            .ok_or_else(|| ConductorError::NonProviderExecution(execution_id.clone()))?;
        let descriptor = self.callables.descriptor(&callable)?.clone();
        let binding = self.callables.execution_provider(&callable)?.clone();
        let Some(provider) = binding.provider().cloned() else {
            return Err(ConductorError::NonProviderExecution(execution_id.clone()));
        };
        self.check_callable_policy(
            execution_id,
            &descriptor,
            CallableOperation::DispatchProvider,
        )?;
        let config_revision = self
            .sessions
            .get(&summary.session_id)
            .expect("execution session invariant")
            .summary
            .config_revision
            .clone();
        let request = ExecutionProviderRequest {
            execution_id: execution_id.clone(),
            session_id: summary.session_id,
            parent_execution: summary.parent_execution,
            callable,
            config_revision,
            objective: input,
        };
        Ok((provider, request))
    }
}