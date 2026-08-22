use crate::{
    is_terminal, CallableOperation, ConductorError, ConductorRuntime, DomainEvent,
    ExecutionPayload, JournalExecutionPayload,
};
use phenix_core::{
    AttemptGroup, CallableId, CallableKind, ExecutionEventKind, ExecutionId, ExecutionKind,
    ExecutionState, ExecutionSummary, FailureAttemptSummary, OrchestrationFailureDecision,
    OrchestrationFailureDecisionRecord, OrchestrationNodeId,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OrchestrationFailureDecisionRequest {
    Retry,
    ChooseAnotherChild {
        callable: CallableId,
        objective: String,
    },
    Continue,
    Fail,
}

impl ConductorRuntime {
    pub fn decide_orchestration_failure(
        &mut self,
        decider_execution_id: &ExecutionId,
        request: OrchestrationFailureDecisionRequest,
    ) -> Result<Option<ExecutionSummary>, ConductorError> {
        let decider = self
            .executions
            .get(decider_execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(decider_execution_id.clone()))?
            .clone();
        let parent_id = decider.summary.parent_execution.clone().ok_or_else(|| {
            ConductorError::FailureDecisionDenied {
                parent_execution: decider_execution_id.clone(),
                decider_execution: decider_execution_id.clone(),
            }
        })?;
        let failed_child_id = self
            .failed_child_for_interface(decider_execution_id)
            .ok_or_else(|| ConductorError::FailureDecisionDenied {
                parent_execution: parent_id.clone(),
                decider_execution: decider_execution_id.clone(),
            })?;
        let invalid = || ConductorError::InvalidFailureDecision {
            parent_execution: parent_id.clone(),
            failed_child: failed_child_id.clone(),
        };
        if self.orchestration_decisions.contains_key(&failed_child_id)
            || !matches!(
                decider.summary.state,
                ExecutionState::Running | ExecutionState::Completed
            )
        {
            return Err(invalid());
        }
        let failed = self
            .executions
            .get(&failed_child_id)
            .ok_or_else(|| ConductorError::UnknownExecution(failed_child_id.clone()))?
            .clone();
        if failed.summary.state != ExecutionState::Failed {
            return Err(invalid());
        }
        let parent = self
            .executions
            .get(&parent_id)
            .ok_or_else(|| ConductorError::UnknownExecution(parent_id.clone()))?
            .clone();
        if parent.summary.kind != ExecutionKind::Orchestration
            || parent.summary.state != ExecutionState::Running
        {
            return Err(invalid());
        }
        let orchestration_callable = parent.summary.callable.as_ref().ok_or_else(&invalid)?;
        let definition = self
            .callables
            .orchestration(orchestration_callable)?
            .clone();
        if definition.interface_agent.as_ref() != decider.summary.callable.as_ref() {
            return Err(ConductorError::FailureDecisionDenied {
                parent_execution: parent_id,
                decider_execution: decider_execution_id.clone(),
            });
        }

        let recovery = match request {
            OrchestrationFailureDecisionRequest::Retry => {
                let callable = failed.summary.callable.as_ref().ok_or_else(&invalid)?;
                self.ensure_decider_delegates(decider_execution_id, callable)?;
                let recovery = self.create_retry_recovery(&failed_child_id)?;
                self.record_orchestration_failure_decision(OrchestrationFailureDecisionRecord {
                    parent_execution: parent_id.clone(),
                    failed_child: failed_child_id.clone(),
                    decider_execution: Some(decider_execution_id.clone()),
                    decision: OrchestrationFailureDecision::Retry {
                        execution_id: recovery.id.clone(),
                    },
                })?;
                self.announce_recovery_child(&parent_id, &recovery)?;
                Some(recovery)
            }
            OrchestrationFailureDecisionRequest::ChooseAnotherChild {
                callable,
                objective,
            } => {
                if objective.trim().is_empty()
                    || failed.summary.callable.as_ref() == Some(&callable)
                    || definition.interface_agent.as_ref() == Some(&callable)
                {
                    return Err(invalid());
                }
                self.ensure_decider_delegates(decider_execution_id, &callable)?;
                let recovery = self.create_recovery_agent(&parent_id, &callable, objective)?;
                self.record_orchestration_failure_decision(OrchestrationFailureDecisionRecord {
                    parent_execution: parent_id.clone(),
                    failed_child: failed_child_id.clone(),
                    decider_execution: Some(decider_execution_id.clone()),
                    decision: OrchestrationFailureDecision::ChooseAnotherChild {
                        execution_id: recovery.id.clone(),
                    },
                })?;
                self.announce_recovery_child(&parent_id, &recovery)?;
                Some(recovery)
            }
            OrchestrationFailureDecisionRequest::Continue => {
                self.record_orchestration_failure_decision(OrchestrationFailureDecisionRecord {
                    parent_execution: parent_id.clone(),
                    failed_child: failed_child_id.clone(),
                    decider_execution: Some(decider_execution_id.clone()),
                    decision: OrchestrationFailureDecision::Continue,
                })?;
                None
            }
            OrchestrationFailureDecisionRequest::Fail => {
                self.record_orchestration_failure_decision(OrchestrationFailureDecisionRecord {
                    parent_execution: parent_id.clone(),
                    failed_child: failed_child_id.clone(),
                    decider_execution: Some(decider_execution_id.clone()),
                    decision: OrchestrationFailureDecision::Fail,
                })?;
                None
            }
        };
        self.refresh_orchestration(&parent_id)?;
        Ok(recovery)
    }

    fn ensure_decider_delegates(
        &self,
        decider_execution_id: &ExecutionId,
        callable: &CallableId,
    ) -> Result<(), ConductorError> {
        let decider = self
            .executions
            .get(decider_execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(decider_execution_id.clone()))?;
        if decider.authority.callables.contains(callable) {
            Ok(())
        } else {
            Err(ConductorError::DelegationDenied {
                parent_execution: decider_execution_id.clone(),
                callable: callable.clone(),
            })
        }
    }

    fn create_retry_recovery(
        &mut self,
        failed_execution_id: &ExecutionId,
    ) -> Result<ExecutionSummary, ConductorError> {
        let (parent_id, callable, original_goal) = {
            let failed = self
                .executions
                .get(failed_execution_id)
                .ok_or_else(|| ConductorError::UnknownExecution(failed_execution_id.clone()))?;
            let parent_id = failed.summary.parent_execution.clone().ok_or_else(|| {
                ConductorError::InvalidFailureDecision {
                    parent_execution: failed_execution_id.clone(),
                    failed_child: failed_execution_id.clone(),
                }
            })?;
            let callable = failed.summary.callable.clone().ok_or_else(|| {
                ConductorError::InvalidFailureDecision {
                    parent_execution: parent_id.clone(),
                    failed_child: failed_execution_id.clone(),
                }
            })?;
            let ExecutionPayload::Invocation { input } = &failed.payload else {
                return Err(ConductorError::InvalidFailureDecision {
                    parent_execution: parent_id,
                    failed_child: failed_execution_id.clone(),
                });
            };
            (parent_id, callable, input.clone())
        };

        let existing_group = self
            .attempt_groups
            .iter()
            .find(|(_, group)| group.contains_execution(failed_execution_id))
            .map(|(id, group)| (id.clone(), group.clone()));
        let group_id = if let Some((group_id, group)) = existing_group {
            if group.latest_execution() != Some(failed_execution_id) {
                return Err(ConductorError::InvalidFailureDecision {
                    parent_execution: parent_id,
                    failed_child: failed_execution_id.clone(),
                });
            }
            if !group
                .failures
                .iter()
                .any(|failure| failure.execution_id == *failed_execution_id)
            {
                let attempt = group
                    .attempt_for_execution(failed_execution_id)
                    .ok_or_else(|| ConductorError::InvalidFailureDecision {
                        parent_execution: parent_id.clone(),
                        failed_child: failed_execution_id.clone(),
                    })?;
                let failure = self.runtime_failure_summary(failed_execution_id, attempt)?;
                self.record_domain_event(DomainEvent::AttemptFailureRecorded {
                    group_id: group_id.clone(),
                    failure,
                })?;
            }
            group_id
        } else {
            let group_id = self.new_attempt_group_id();
            let first_failure = self.runtime_failure_summary(failed_execution_id, 1)?;
            let group = AttemptGroup::from_first_failure(
                group_id.clone(),
                parent_id.clone(),
                callable.clone(),
                original_goal,
                first_failure,
            );
            self.record_domain_event(DomainEvent::AttemptGroupCreated { group })?;
            group_id
        };

        let context = self
            .attempt_groups
            .get(&group_id)
            .expect("attempt group was recorded before retry")
            .retry_context();
        let serialized = serde_json::to_string(&context)
            .expect("retry context contains only JSON-serializable values");
        let retry_input = format!(
            "Retry the same goal. Use only the compact failure context below; do not infer prior transcript content.

Retry context JSON:
{serialized}"
        );
        let retry = self.create_recovery_agent(&parent_id, &callable, retry_input)?;
        self.record_domain_event(DomainEvent::AttemptRetryStarted {
            group_id,
            execution_id: retry.id.clone(),
        })?;
        Ok(retry)
    }

    fn runtime_failure_summary(
        &self,
        execution_id: &ExecutionId,
        attempt: u32,
    ) -> Result<FailureAttemptSummary, ConductorError> {
        let execution = self
            .executions
            .get(execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?;
        if execution.summary.state != ExecutionState::Failed {
            return Err(ConductorError::InvalidLifecycle(execution_id.clone()));
        }
        let callable = execution
            .summary
            .callable
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_else(|| "execution".to_owned());
        let reason = self
            .events
            .iter()
            .rev()
            .filter(|event| event.execution_id == *execution_id)
            .find_map(|event| match &event.kind {
                ExecutionEventKind::Error { message, .. } => Some(message.clone()),
                _ => None,
            })
            .unwrap_or_else(|| "execution failed".to_owned());
        Ok(FailureAttemptSummary {
            execution_id: execution_id.clone(),
            attempt,
            approach: format!("execute {callable}"),
            failure_at: "execution".to_owned(),
            reason,
            completed_work: Vec::new(),
        })
    }

    fn create_recovery_agent(
        &mut self,
        parent_id: &ExecutionId,
        callable: &CallableId,
        objective: String,
    ) -> Result<ExecutionSummary, ConductorError> {
        let descriptor = self.callables.descriptor(callable)?.clone();
        if descriptor.kind != CallableKind::Agent {
            return Err(crate::CallableRegistryError::WrongKind {
                callable: callable.clone(),
                expected: CallableKind::Agent,
                actual: descriptor.kind,
            }
            .into());
        }
        self.callables.execution_provider(callable)?;
        self.check_callable_policy(parent_id, &descriptor, CallableOperation::StartAgentNode)?;
        let parent = self
            .executions
            .get(parent_id)
            .ok_or_else(|| ConductorError::UnknownExecution(parent_id.clone()))?
            .clone();
        if parent.summary.state != ExecutionState::Running {
            return Err(ConductorError::InvalidLifecycle(parent_id.clone()));
        }
        if !parent.authority.callables.contains(callable) {
            return Err(ConductorError::DelegationDenied {
                parent_execution: parent_id.clone(),
                callable: callable.clone(),
            });
        }
        let child = ExecutionSummary {
            id: self.new_execution_id(),
            session_id: parent.summary.session_id,
            parent_execution: Some(parent.summary.id),
            kind: ExecutionKind::Agent,
            callable: Some(callable.clone()),
            target: parent.summary.target,
            state: ExecutionState::Pending,
        };
        let payload = ExecutionPayload::Invocation { input: objective };
        self.record_domain_event(DomainEvent::ExecutionCreated {
            execution: child.clone(),
            payload: JournalExecutionPayload::from(&payload),
        })?;
        Ok(child)
    }

    fn announce_recovery_child(
        &mut self,
        parent_id: &ExecutionId,
        child: &ExecutionSummary,
    ) -> Result<(), ConductorError> {
        self.push_event(
            parent_id,
            ExecutionEventKind::ChildExecutionStarted {
                child: child.id.clone(),
            },
        )?;
        self.push_event(
            &child.id,
            ExecutionEventKind::ExecutionStateChanged {
                state: ExecutionState::Pending,
            },
        )?;
        Ok(())
    }

    fn record_orchestration_failure_decision(
        &mut self,
        decision: OrchestrationFailureDecisionRecord,
    ) -> Result<(), ConductorError> {
        self.record_domain_event(DomainEvent::OrchestrationDecisionMade {
            decision: decision.clone(),
        })?;
        let parent_execution = decision.parent_execution.clone();
        self.push_event(
            &parent_execution,
            ExecutionEventKind::OrchestrationDecisionMade { decision },
        )?;
        Ok(())
    }

    fn start_failure_interface(
        &mut self,
        parent_id: &ExecutionId,
        failed_child_id: &ExecutionId,
        interface_agent: &CallableId,
    ) -> Result<(), ConductorError> {
        if self.orchestration_interfaces.contains_key(failed_child_id) {
            return Ok(());
        }
        let failed = self
            .executions
            .get(failed_child_id)
            .ok_or_else(|| ConductorError::UnknownExecution(failed_child_id.clone()))?
            .clone();
        let failed_callable = failed
            .summary
            .callable
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_else(|| "unknown".to_owned());
        let context = serde_json::json!({
            "parent_execution": parent_id,
            "failed_child": failed_child_id,
            "failed_callable": failed_callable,
            "state": "failed"
        });
        let objective = format!(
            "Decide how the orchestration should handle this failed child. Use the failure-decision tool exactly once.

Failure context JSON:
{context}"
        );
        let interface = self.create_recovery_agent(parent_id, interface_agent, objective)?;
        self.record_domain_event(DomainEvent::OrchestrationFailureInterfaceStarted {
            parent_execution: parent_id.clone(),
            failed_child: failed_child_id.clone(),
            interface_execution: interface.id.clone(),
        })?;
        self.announce_recovery_child(parent_id, &interface)
    }

    fn record_fallback_fail(
        &mut self,
        parent_id: &ExecutionId,
        failed_child_id: &ExecutionId,
    ) -> Result<(), ConductorError> {
        if !self.orchestration_decisions.contains_key(failed_child_id) {
            self.record_orchestration_failure_decision(OrchestrationFailureDecisionRecord {
                parent_execution: parent_id.clone(),
                failed_child: failed_child_id.clone(),
                decider_execution: None,
                decision: OrchestrationFailureDecision::Fail,
            })?;
        }
        Ok(())
    }

    pub(crate) fn refresh_orchestration(
        &mut self,
        execution_id: &ExecutionId,
    ) -> Result<(), ConductorError> {
        let orchestration = self
            .executions
            .get(execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?
            .summary
            .clone();
        if orchestration.kind != ExecutionKind::Orchestration || is_terminal(&orchestration.state) {
            return Ok(());
        }
        let callable = orchestration
            .callable
            .as_ref()
            .expect("orchestration execution has callable");
        let definition = self.callables.orchestration(callable)?.clone();
        let interface_ids = self
            .orchestration_interfaces
            .iter()
            .filter_map(|(failed, interface)| {
                self.executions
                    .get(failed)
                    .filter(|record| record.summary.parent_execution.as_ref() == Some(execution_id))
                    .map(|_| interface.clone())
            })
            .collect::<BTreeSet<_>>();

        for interface_id in &interface_ids {
            let interface = self
                .executions
                .get(interface_id)
                .expect("recorded failure interface execution exists")
                .summary
                .clone();
            if interface.state == ExecutionState::Failed {
                self.record_fallback_fail(execution_id, interface_id)?;
                if let Some(original) = self.failed_child_for_interface(interface_id) {
                    self.record_fallback_fail(execution_id, &original)?;
                }
                self.set_state(execution_id, ExecutionState::Failed)?;
                return Ok(());
            }
        }

        let failed_children = self
            .executions
            .values()
            .filter(|record| {
                record.summary.parent_execution.as_ref() == Some(execution_id)
                    && record.summary.kind == ExecutionKind::Agent
                    && record.summary.state == ExecutionState::Failed
                    && !interface_ids.contains(&record.summary.id)
            })
            .map(|record| record.summary.id.clone())
            .collect::<Vec<_>>();
        for failed_child in failed_children {
            if self.orchestration_decisions.contains_key(&failed_child) {
                continue;
            }
            let Some(interface_agent) = definition.interface_agent.as_ref() else {
                self.record_fallback_fail(execution_id, &failed_child)?;
                self.set_state(execution_id, ExecutionState::Failed)?;
                return Ok(());
            };
            if let Some(interface_id) = self.orchestration_interfaces.get(&failed_child).cloned() {
                let interface_state = self
                    .executions
                    .get(&interface_id)
                    .expect("recorded failure interface exists")
                    .summary
                    .state
                    .clone();
                if is_terminal(&interface_state) {
                    self.record_fallback_fail(execution_id, &failed_child)?;
                    self.set_state(execution_id, ExecutionState::Failed)?;
                }
                return Ok(());
            }
            self.start_failure_interface(execution_id, &failed_child, interface_agent)?;
            return Ok(());
        }

        let node_states = self.orchestration_node_states(execution_id)?;
        if node_states
            .values()
            .any(|state| *state == ExecutionState::Failed)
        {
            self.set_state(execution_id, ExecutionState::Failed)?;
            return Ok(());
        }
        if node_states
            .values()
            .any(|state| *state == ExecutionState::Cancelled)
        {
            self.set_state(execution_id, ExecutionState::Cancelled)?;
            return Ok(());
        }
        if node_states
            .values()
            .any(|state| *state == ExecutionState::Interrupted)
        {
            self.set_state(execution_id, ExecutionState::Interrupted)?;
            return Ok(());
        }
        self.advance_orchestration(execution_id)
    }

    pub(crate) fn advance_orchestration(
        &mut self,
        execution_id: &ExecutionId,
    ) -> Result<(), ConductorError> {
        let (callable, objective, state) = {
            let execution = self
                .executions
                .get(execution_id)
                .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?;
            let ExecutionPayload::Orchestration { objective } = &execution.payload else {
                return Err(ConductorError::NonModelExecution(execution_id.clone()));
            };
            (
                execution
                    .summary
                    .callable
                    .clone()
                    .expect("orchestration execution has callable"),
                objective.clone(),
                execution.summary.state.clone(),
            )
        };
        if state != ExecutionState::Running {
            return Ok(());
        }
        let definition = self.callables.orchestration(&callable)?.clone();
        let node_states = self.orchestration_node_states(execution_id)?;
        let ready = definition
            .nodes
            .iter()
            .filter(|node| {
                !node_states.contains_key(&node.id)
                    && node.depends_on.iter().all(|dependency| {
                        node_states.get(dependency) == Some(&ExecutionState::Completed)
                    })
            })
            .cloned()
            .collect::<Vec<_>>();
        if !ready.is_empty() {
            for node in ready {
                let node_objective = match node.objective {
                    Some(node_objective) => {
                        format!(
                            "{node_objective}

Orchestration objective:
{objective}"
                        )
                    }
                    None => objective.clone(),
                };
                self.start_agent_with_node(
                    execution_id,
                    &node.callable,
                    node_objective,
                    Some(node.id),
                )?;
            }
            return Ok(());
        }
        if node_states.len() == definition.nodes.len()
            && node_states
                .values()
                .all(|state| *state == ExecutionState::Completed)
        {
            self.set_state(execution_id, ExecutionState::Completed)?;
        }
        Ok(())
    }

    fn orchestration_node_states(
        &self,
        execution_id: &ExecutionId,
    ) -> Result<BTreeMap<OrchestrationNodeId, ExecutionState>, ConductorError> {
        self.executions
            .values()
            .filter(|record| record.summary.parent_execution.as_ref() == Some(execution_id))
            .filter_map(|record| {
                self.orchestration_nodes
                    .get(&record.summary.id)
                    .map(|node_id| (node_id.clone(), record.summary.id.clone()))
            })
            .map(|(node_id, child_id)| {
                self.effective_orchestration_execution_state(&child_id)
                    .map(|state| (node_id, state))
            })
            .collect()
    }

    fn effective_orchestration_execution_state(
        &self,
        execution_id: &ExecutionId,
    ) -> Result<ExecutionState, ConductorError> {
        let mut current = execution_id.clone();
        let mut visited = BTreeSet::new();
        loop {
            if !visited.insert(current.clone()) {
                return Err(ConductorError::InvalidLifecycle(current));
            }
            let state = self
                .executions
                .get(&current)
                .ok_or_else(|| ConductorError::UnknownExecution(current.clone()))?
                .summary
                .state
                .clone();
            if state != ExecutionState::Failed {
                return Ok(state);
            }
            let Some(record) = self.orchestration_decisions.get(&current) else {
                return Ok(ExecutionState::Failed);
            };
            match &record.decision {
                OrchestrationFailureDecision::Retry { execution_id }
                | OrchestrationFailureDecision::ChooseAnotherChild { execution_id } => {
                    current = execution_id.clone();
                }
                OrchestrationFailureDecision::Continue => return Ok(ExecutionState::Completed),
                OrchestrationFailureDecision::Fail => return Ok(ExecutionState::Failed),
            }
        }
    }
}
