use crate::{AttemptGroupId, CallableId, ExecutionId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FailureAttemptSummary {
    pub execution_id: ExecutionId,
    pub attempt: u32,
    pub approach: String,
    pub failure_at: String,
    pub reason: String,
    #[serde(default)]
    pub completed_work: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RetryContext {
    pub goal: String,
    pub failures: Vec<FailureAttemptSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AttemptGroup {
    pub id: AttemptGroupId,
    pub parent_execution: ExecutionId,
    pub callable: CallableId,
    pub goal: String,
    pub failures: Vec<FailureAttemptSummary>,
}

impl AttemptGroup {
    #[must_use]
    pub fn from_first_failure(
        id: AttemptGroupId,
        parent_execution: ExecutionId,
        callable: CallableId,
        goal: impl Into<String>,
        first_failure: FailureAttemptSummary,
    ) -> Self {
        Self {
            id,
            parent_execution,
            callable,
            goal: goal.into(),
            failures: vec![first_failure],
        }
    }

    pub fn record_failure(&mut self, failure: FailureAttemptSummary) {
        self.failures.push(failure);
    }

    #[must_use]
    pub fn next_attempt(&self) -> u32 {
        self.failures
            .last()
            .map_or(1, |failure| failure.attempt.saturating_add(1))
    }

    #[must_use]
    pub fn retry_context(&self) -> RetryContext {
        RetryContext {
            goal: self.goal.clone(),
            failures: self.failures.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failure(execution: &str, attempt: u32, at: &str, reason: &str) -> FailureAttemptSummary {
        FailureAttemptSummary {
            execution_id: ExecutionId::parse(execution).unwrap(),
            attempt,
            approach: format!("approach {attempt}"),
            failure_at: at.to_owned(),
            reason: reason.to_owned(),
            completed_work: vec!["earlier work remains relevant".to_owned()],
        }
    }

    #[test]
    fn retry_group_keeps_one_goal_and_failure_timeline() {
        let mut group = AttemptGroup::from_first_failure(
            AttemptGroupId::parse("attempt-group-1").unwrap(),
            ExecutionId::parse("parent").unwrap(),
            CallableId::parse("agent.implement").unwrap(),
            "Implement provider-neutral auth",
            failure(
                "attempt-1",
                1,
                "provider discovery",
                "duplicated auth authority",
            ),
        );
        group.record_failure(failure(
            "attempt-2",
            2,
            "OAuth callback",
            "callback ownership was still duplicated",
        ));

        let context = group.retry_context();
        assert_eq!(context.goal, "Implement provider-neutral auth");
        assert_eq!(context.failures.len(), 2);
        assert_eq!(context.failures[0].failure_at, "provider discovery");
        assert_eq!(context.failures[1].attempt, 2);
        assert_eq!(group.next_attempt(), 3);
    }
}
