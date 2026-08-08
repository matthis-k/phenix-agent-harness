use phenix_acp::{
    AcpSessionId, GatewayEvent, ObjectiveState as GatewayObjectiveState, SessionEvent,
    SessionNodeId, SessionNodeState, SessionTreeSnapshot,
};
use phenix_runtime_api::{
    BackendError, BackendEvent, DialogId, ExtensionUiRequest, ModelRef, NotificationLevel,
    ObjectiveId, ObjectiveSource, ObjectiveState, ObjectiveSummary, RunId, RunKind, RunState,
    RuntimeSnapshot, SessionId, ToolCallId, ToolExecutionOutcome, TranscriptBlock, TranscriptRole,
};
use std::collections::BTreeMap;

pub(super) fn project_snapshot(
    backend: RuntimeSnapshot,
    tree: Option<&SessionTreeSnapshot>,
) -> Result<RuntimeSnapshot, BackendError> {
    let Some(tree) = tree else {
        return Ok(backend);
    };

    let mut projected = backend;
    let run_by_node = run_ids_by_node(tree, &projected)?;
    let node_by_run = run_by_node
        .iter()
        .map(|(node, run)| (run.clone(), node.clone()))
        .collect::<BTreeMap<_, _>>();

    for run in &mut projected.runs {
        let Some(node_id) = node_by_run.get(&run.id) else {
            continue;
        };
        let Some(node) = tree.nodes.iter().find(|node| &node.id == node_id) else {
            continue;
        };
        run.parent = node
            .parent
            .as_ref()
            .and_then(|parent| run_by_node.get(parent))
            .cloned();
        run.kind = if node.id == tree.root {
            RunKind::Root
        } else {
            RunKind::Agent
        };
        run.definition_id = node.role.as_str().to_owned();
        run.display_name = node.role.as_str().to_owned();
        run.state = runtime_run_state(&node.state);
        run.model = node.model.as_ref().map(|model| ModelRef {
            provider: model.provider.as_str().to_owned(),
            model: model.model.as_str().to_owned(),
        });
    }

    projected.root_run = run_by_node.get(&tree.root).cloned();
    if projected.selected_run.is_none() {
        projected.selected_run = projected.root_run.clone();
    }
    projected.objectives = tree
        .objectives
        .iter()
        .map(|objective| {
            let creator = tree
                .nodes
                .iter()
                .find(|node| node.objective_id == objective.id)
                .and_then(|node| run_by_node.get(&node.id))
                .cloned()
                .or_else(|| projected.root_run.clone())
                .ok_or_else(|| {
                    BackendError::Protocol(format!(
                        "objective {} has no projected Phenix run",
                        objective.id
                    ))
                })?;
            Ok(ObjectiveSummary {
                id: ObjectiveId::parse(objective.id.as_str())
                    .map_err(|error| BackendError::Protocol(error.to_string()))?,
                root_run_id: projected
                    .root_run
                    .clone()
                    .unwrap_or_else(|| creator.clone()),
                parent: objective
                    .parent
                    .as_ref()
                    .map(|parent| ObjectiveId::parse(parent.as_str()))
                    .transpose()
                    .map_err(|error| BackendError::Protocol(error.to_string()))?,
                created_by_run_id: creator,
                title: objective.title.clone(),
                description: None,
                source: if objective.parent.is_some() {
                    ObjectiveSource::Discovered
                } else {
                    ObjectiveSource::User
                },
                state: runtime_objective_state(&objective.state),
            })
        })
        .collect::<Result<Vec<_>, BackendError>>()?;

    Ok(projected)
}

pub(super) fn node_for_run(
    tree: &SessionTreeSnapshot,
    backend: &RuntimeSnapshot,
    run_id: &RunId,
) -> Result<SessionNodeId, BackendError> {
    run_ids_by_node(tree, backend)?
        .into_iter()
        .find_map(|(node, run)| (run == *run_id).then_some(node))
        .ok_or_else(|| {
            BackendError::InvalidConfiguration(format!(
                "run {run_id} is not attached to the active Phenix session tree"
            ))
        })
}

pub(super) fn node_for_session(
    tree: &SessionTreeSnapshot,
    session_id: &SessionId,
) -> Option<SessionNodeId> {
    tree.nodes.iter().find_map(|node| {
        node.downstream_session
            .as_ref()
            .is_some_and(|downstream| downstream.as_str() == session_id.as_str())
            .then(|| node.id.clone())
    })
}

pub(super) fn run_for_session(
    backend: &RuntimeSnapshot,
    session_id: &AcpSessionId,
) -> Option<RunId> {
    backend
        .sessions
        .iter()
        .find(|session| session.id.as_str() == session_id.as_str())
        .and_then(|session| session.root_run_id.clone())
        .or_else(|| {
            backend
                .runs
                .iter()
                .find(|run| {
                    run.persisted_session
                        .as_ref()
                        .is_some_and(|session| session.as_str() == session_id.as_str())
                })
                .map(|run| run.id.clone())
        })
}

pub(super) fn gateway_events(
    events: Vec<GatewayEvent>,
    backend: &RuntimeSnapshot,
    transcript_sequence: &mut u64,
) -> Result<Vec<BackendEvent>, BackendError> {
    events
        .into_iter()
        .flat_map(|event| {
            let result = gateway_event(event, backend, transcript_sequence);
            match result {
                Ok(events) => events.into_iter().map(Ok).collect::<Vec<_>>(),
                Err(error) => vec![Err(error)],
            }
        })
        .collect()
}

fn gateway_event(
    event: GatewayEvent,
    backend: &RuntimeSnapshot,
    transcript_sequence: &mut u64,
) -> Result<Vec<BackendEvent>, BackendError> {
    let run_id = run_for_session(backend, &event.session_id).ok_or_else(|| {
        BackendError::Protocol(format!(
            "downstream ACP session {} has no projected run",
            event.session_id
        ))
    })?;
    let events =
        match event.event {
            SessionEvent::Text { text } => vec![BackendEvent::TranscriptAppended(
                transcript_block(transcript_sequence, run_id, TranscriptRole::Assistant, text)?,
            )],
            SessionEvent::Thought { text } => vec![BackendEvent::TranscriptAppended(
                transcript_block(transcript_sequence, run_id, TranscriptRole::Thinking, text)?,
            )],
            SessionEvent::ToolStarted {
                call_id,
                name,
                raw_input_json,
                input_summary,
            } => vec![BackendEvent::ToolStarted {
                run_id,
                tool_call_id: ToolCallId::parse(call_id)
                    .map_err(|error| BackendError::Protocol(error.to_string()))?,
                tool_name: name,
                raw_input_json,
                input_summary,
            }],
            SessionEvent::ToolUpdated { call_id, output } => vec![BackendEvent::ToolUpdated {
                run_id,
                tool_call_id: ToolCallId::parse(call_id)
                    .map_err(|error| BackendError::Protocol(error.to_string()))?,
                output,
            }],
            SessionEvent::ToolFinished {
                call_id,
                succeeded,
                output_summary,
            } => vec![BackendEvent::ToolFinished {
                run_id,
                tool_call_id: ToolCallId::parse(call_id)
                    .map_err(|error| BackendError::Protocol(error.to_string()))?,
                outcome: if succeeded {
                    ToolExecutionOutcome::Succeeded
                } else {
                    ToolExecutionOutcome::Failed
                },
                output_summary,
            }],
            SessionEvent::Terminal {
                terminal_id,
                output,
                exit_code,
            } => vec![BackendEvent::StatusChanged {
                key: format!("terminal.{terminal_id}"),
                text: Some(match exit_code {
                    Some(exit_code) => format!("{output}\n[exit {exit_code}]"),
                    None => output,
                }),
            }],
            SessionEvent::PermissionRequested {
                request_id,
                title,
                options,
            } => vec![BackendEvent::ExtensionUiRequested {
                dialog_id: DialogId::parse(request_id)
                    .map_err(|error| BackendError::Protocol(error.to_string()))?,
                request: ExtensionUiRequest::Select { title, options },
            }],
            SessionEvent::QueueChanged {
                steering,
                follow_ups,
            } => vec![BackendEvent::QueueChanged {
                run_id,
                steering,
                follow_ups,
            }],
            SessionEvent::Compacted => vec![BackendEvent::StatusChanged {
                key: format!("run.{run_id}.compaction"),
                text: Some("completed".to_owned()),
            }],
            SessionEvent::Completed => terminal_run_events(backend, &run_id),
            SessionEvent::Failed { message } => {
                let mut events = terminal_run_events(backend, &run_id);
                events.push(BackendEvent::Notification {
                    level: NotificationLevel::Error,
                    message: format!("ACP prompt failed: {message}"),
                });
                events
            }
            SessionEvent::Cancelled { reason } => {
                let mut events = terminal_run_events(backend, &run_id);
                events.push(BackendEvent::Notification {
                    level: NotificationLevel::Information,
                    message: format!("ACP prompt cancelled: {reason}"),
                });
                events
            }
        };
    Ok(events)
}

fn terminal_run_events(backend: &RuntimeSnapshot, run_id: &RunId) -> Vec<BackendEvent> {
    backend
        .runs
        .iter()
        .find(|run| &run.id == run_id)
        .cloned()
        .map(BackendEvent::RunChanged)
        .into_iter()
        .collect()
}

fn run_ids_by_node(
    tree: &SessionTreeSnapshot,
    backend: &RuntimeSnapshot,
) -> Result<BTreeMap<SessionNodeId, RunId>, BackendError> {
    tree.nodes
        .iter()
        .filter_map(|node| {
            node.downstream_session.as_ref().map(|session| {
                run_for_session(backend, session)
                    .map(|run| (node.id.clone(), run))
                    .ok_or_else(|| {
                        BackendError::Protocol(format!(
                            "downstream ACP session {session} has no runtime run"
                        ))
                    })
            })
        })
        .collect()
}

fn transcript_block(
    sequence: &mut u64,
    run_id: RunId,
    role: TranscriptRole,
    text: String,
) -> Result<TranscriptBlock, BackendError> {
    let current = *sequence;
    *sequence = sequence
        .checked_add(1)
        .ok_or_else(|| BackendError::Protocol("transcript IDs exhausted".to_owned()))?;
    Ok(TranscriptBlock {
        id: format!("gateway-transcript-{current}"),
        run_id,
        role,
        text,
        complete: true,
    })
}

fn runtime_run_state(state: &SessionNodeState) -> RunState {
    match state {
        SessionNodeState::Created => RunState::Created,
        SessionNodeState::Starting => RunState::Starting,
        SessionNodeState::Running => RunState::Running,
        SessionNodeState::WaitingForInput => RunState::Waiting,
        SessionNodeState::Completed => RunState::Completed,
        SessionNodeState::Failed => RunState::Failed,
        SessionNodeState::Cancelled => RunState::Cancelled,
        SessionNodeState::Orphaned => RunState::Orphaned,
    }
}

fn runtime_objective_state(state: &GatewayObjectiveState) -> ObjectiveState {
    match state {
        GatewayObjectiveState::NotStarted => ObjectiveState::NotStarted,
        GatewayObjectiveState::WorkInProgress => ObjectiveState::WorkInProgress,
        GatewayObjectiveState::Done => ObjectiveState::Done,
        GatewayObjectiveState::Blocked => ObjectiveState::Blocked,
    }
}
