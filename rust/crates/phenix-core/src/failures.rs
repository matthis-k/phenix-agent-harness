use crate::ExecutionId;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OrchestrationFailureDecision {
    Retry { execution_id: ExecutionId },
    ChooseAnotherChild { execution_id: ExecutionId },
    Continue,
    Fail,
}

impl OrchestrationFailureDecision {
    #[must_use]
    pub fn recovery_execution(&self) -> Option<&ExecutionId> {
        match self {
            Self::Retry { execution_id } | Self::ChooseAnotherChild { execution_id } => {
                Some(execution_id)
            }
            Self::Continue | Self::Fail => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct OrchestrationFailureDecisionRecord {
    pub parent_execution: ExecutionId,
    pub failed_child: ExecutionId,
    pub decider_execution: Option<ExecutionId>,
    pub decision: OrchestrationFailureDecision,
}
