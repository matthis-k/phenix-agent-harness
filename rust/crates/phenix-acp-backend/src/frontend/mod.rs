mod projection;

use crate::{AcpGatewayTransport, AcpTreeControl};
use phenix_acp::{
    AcpSessionId, DefinitionId, GatewayError, InteractionResponse, ModelId, ModelSelection,
    PhenixAcpGateway, ProviderId, RoleId, SessionCommand, SessionImage, SessionNodeId,
    SessionTreeId, SessionTreeSnapshot, TreeStartResult,
};
use phenix_runtime_api::{
    AgentBackend, BackendCommand, BackendError, BackendEvent, BackendOutputSender, BackendReply,
    BackendRequest, ExtensionUiResponse, ImageInput, ModelRef, RunId, RuntimeSnapshot, SessionId,
    StreamingBehavior, ThinkingLevel, TranscriptBlock, TranscriptRole,
};
use projection::{gateway_events, node_for_run, node_for_session, project_snapshot};
use std::collections::BTreeMap;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

const POLL_PERIOD: Duration = Duration::from_millis(50);

pub struct GatewayAgentBackend {
    gateway: PhenixAcpGateway,
    transport: AcpGatewayTransport,
    definition_id: DefinitionId,
    tree_id: SessionTreeId,
    root_role: RoleId,
    root_objective: String,
}

impl GatewayAgentBackend {
    pub fn new(
        gateway: PhenixAcpGateway,
        transport: AcpGatewayTransport,
        definition_id: DefinitionId,
        tree_id: SessionTreeId,
        root_role: RoleId,
        root_objective: impl Into<String>,
    ) -> Self {
        Self {
            gateway,
            transport,
            definition_id,
            tree_id,
            root_role,
            root_objective: root_objective.into(),
        }
    }
}

impl AgentBackend for GatewayAgentBackend {
    fn run(
        self: Box<Self>,
        requests: Receiver<BackendRequest>,
        outputs: BackendOutputSender,
    ) -> Result<(), BackendError> {
        let control = self
            .transport
            .control(self.tree_id.clone())
            .map_err(backend_error)?;
        let mut runtime = GatewayFrontendRuntime {
            gateway: self.gateway,
            control,
            definition_id: self.definition_id,
            tree_id: self.tree_id,
            root_role: self.root_role,
            root_objective: self.root_objective,
            root: None,
            transcript_sequence: 1,
            interactions: BTreeMap::new(),
            last_snapshot: None,
        };

        loop {
            match requests.recv_timeout(POLL_PERIOD) {
                Ok(request) => {
                    let shutdown = matches!(&request.command, BackendCommand::Shutdown);
                    let result = runtime.handle(request.command, &outputs);
                    outputs.reply(request.id, result)?;
                    if shutdown {
                        runtime.finish_shutdown()?;
                        return Ok(());
                    }
                    runtime.flush(&outputs)?;
                }
                Err(RecvTimeoutError::Timeout) => runtime.flush(&outputs)?,
                Err(RecvTimeoutError::Disconnected) => {
                    runtime.finish_shutdown()?;
                    return Ok(());
                }
            }
        }
    }
}

struct GatewayFrontendRuntime {
    gateway: PhenixAcpGateway,
    control: AcpTreeControl,
    definition_id: DefinitionId,
    tree_id: SessionTreeId,
    root_role: RoleId,
    root_objective: String,
    root: Option<TreeStartResult>,
    transcript_sequence: u64,
    interactions: BTreeMap<phenix_runtime_api::DialogId, SessionNodeId>,
    last_snapshot: Option<RuntimeSnapshot>,
}

impl GatewayFrontendRuntime {
    fn handle(
        &mut self,
        command: BackendCommand,
        outputs: &BackendOutputSender,
    ) -> Result<BackendReply, BackendError> {
        match command {
            BackendCommand::Initialize { .. } => {
                self.ensure_tree()?;
                let snapshot = self.projected_snapshot()?;
                self.last_snapshot = Some(snapshot.clone());
                Ok(BackendReply::Initialized {
                    capabilities: snapshot.capabilities.clone(),
                    snapshot,
                })
            }
            BackendCommand::SnapshotRequest => {
                Ok(BackendReply::Snapshot(self.projected_snapshot()?))
            }
            BackendCommand::PromptSubmit {
                run_id,
                text,
                images,
                streaming_behavior,
            } => {
                let submitted_text = streaming_behavior.is_none().then(|| text.clone());
                let command = match streaming_behavior {
                    Some(StreamingBehavior::Steer) => SessionCommand::Steer {
                        text,
                        images: session_images(images),
                    },
                    Some(StreamingBehavior::FollowUp) => SessionCommand::FollowUp {
                        text,
                        images: session_images(images),
                    },
                    None => SessionCommand::Prompt {
                        text,
                        images: session_images(images),
                    },
                };
                self.execute_for_run(&run_id, command, outputs)?;
                if let Some(text) = submitted_text {
                    outputs.event(BackendEvent::TranscriptAppended(submitted_prompt_block(
                        &mut self.transcript_sequence,
                        run_id,
                        text,
                    )?))?;
                }
                Ok(BackendReply::Accepted)
            }
            BackendCommand::PromptSteer {
                run_id,
                text,
                images,
            } => {
                self.execute_for_run(
                    &run_id,
                    SessionCommand::Steer {
                        text,
                        images: session_images(images),
                    },
                    outputs,
                )?;
                Ok(BackendReply::Accepted)
            }
            BackendCommand::PromptFollowUp {
                run_id,
                text,
                images,
            } => {
                self.execute_for_run(
                    &run_id,
                    SessionCommand::FollowUp {
                        text,
                        images: session_images(images),
                    },
                    outputs,
                )?;
                Ok(BackendReply::Accepted)
            }
            BackendCommand::ExecutionAbort { run_id } => {
                let node = match run_id {
                    Some(run_id) => self.node_for_run(&run_id)?,
                    None => self.selected_node()?,
                };
                let events = self
                    .gateway
                    .cancel_subtree(&self.tree_id, &node)
                    .map_err(backend_error)?;
                self.emit_gateway_events(events, outputs)?;
                Ok(BackendReply::Accepted)
            }
            BackendCommand::SessionCreate { parent_session } => {
                let parent = match parent_session {
                    Some(parent_session) => {
                        let tree = self.tree_snapshot()?;
                        node_for_session(&tree, &parent_session).ok_or_else(|| {
                            BackendError::InvalidConfiguration(format!(
                                "parent session {parent_session} is not attached to the active Phenix tree"
                            ))
                        })?
                    }
                    None => self.selected_node()?,
                };
                self.gateway
                    .delegate(
                        &self.tree_id,
                        &parent,
                        stock_role()?,
                        "Interactive delegated session",
                    )
                    .map_err(backend_error)?;
                Ok(BackendReply::Accepted)
            }
            BackendCommand::SessionSwitch { session_id } => {
                let tree = self.tree_snapshot()?;
                if node_for_session(&tree, &session_id).is_some() {
                    self.control
                        .submit(BackendCommand::SessionSwitch { session_id })
                        .map_err(backend_error)
                } else {
                    let parent = self.selected_node()?;
                    self.gateway
                        .load_session(
                            &self.tree_id,
                            &parent,
                            stock_role()?,
                            format!("Load persisted session {session_id}"),
                            acp_session_id(&session_id)?,
                        )
                        .map_err(backend_error)?;
                    Ok(BackendReply::Accepted)
                }
            }
            BackendCommand::SessionFork { session_id, .. }
            | BackendCommand::SessionClone { session_id } => {
                let tree = self.tree_snapshot()?;
                let node = node_for_session(&tree, &session_id).ok_or_else(|| {
                    BackendError::InvalidConfiguration(format!(
                        "session {session_id} is not attached to the active Phenix tree"
                    ))
                })?;
                self.gateway
                    .fork_node(&self.tree_id, &node, format!("Fork session {session_id}"))
                    .map_err(backend_error)?;
                Ok(BackendReply::Accepted)
            }
            BackendCommand::SessionRename { session_id, name } => {
                let tree = self.tree_snapshot()?;
                if let Some(node) = node_for_session(&tree, &session_id) {
                    let events = self
                        .gateway
                        .rename_node(&self.tree_id, &node, name)
                        .map_err(backend_error)?;
                    self.emit_gateway_events(events, outputs)?;
                    Ok(BackendReply::Accepted)
                } else {
                    self.control
                        .submit(BackendCommand::SessionRename { session_id, name })
                        .map_err(backend_error)
                }
            }
            BackendCommand::SessionModeSelect { run_id, mode_id } => {
                self.execute_for_run(&run_id, SessionCommand::SetMode { mode_id }, outputs)?;
                Ok(BackendReply::Accepted)
            }
            BackendCommand::ModelSelect { run_id, model } => {
                self.execute_for_run(
                    &run_id,
                    SessionCommand::SetModel {
                        model: model_selection(model)?,
                    },
                    outputs,
                )?;
                Ok(BackendReply::Accepted)
            }
            BackendCommand::ThinkingSelect { run_id, level } => {
                self.execute_for_run(
                    &run_id,
                    SessionCommand::SetThinking {
                        level: thinking_level(level).to_owned(),
                    },
                    outputs,
                )?;
                Ok(BackendReply::Accepted)
            }
            BackendCommand::CompactionStart {
                run_id,
                instructions,
            } => {
                self.execute_for_run(&run_id, SessionCommand::Compact { instructions }, outputs)?;
                Ok(BackendReply::Accepted)
            }
            BackendCommand::CommandInvoke {
                run_id,
                name,
                arguments,
            } => {
                self.execute_for_run(&run_id, SessionCommand::Invoke { name, arguments }, outputs)?;
                Ok(BackendReply::Accepted)
            }
            BackendCommand::ExtensionUiRespond {
                dialog_id,
                response,
            } => {
                let node = match self.interactions.remove(&dialog_id) {
                    Some(node) => node,
                    None => self.selected_node()?,
                };
                let events = self
                    .gateway
                    .execute(
                        &self.tree_id,
                        &node,
                        SessionCommand::RespondInteraction {
                            request_id: dialog_id.to_string(),
                            response: interaction_response(response),
                        },
                    )
                    .map_err(backend_error)?;
                self.emit_gateway_events(events, outputs)?;
                Ok(BackendReply::Accepted)
            }
            BackendCommand::Shutdown => Ok(BackendReply::Completed),
            passthrough => self.control.submit(passthrough).map_err(backend_error),
        }
    }

    fn flush(&mut self, outputs: &BackendOutputSender) -> Result<(), BackendError> {
        for event in self.control.drain_events().map_err(backend_error)? {
            outputs.event(event)?;
        }
        self.ensure_tree()?;
        if self.root.is_some() {
            let nodes = self.tree_snapshot()?.nodes;
            for node in nodes {
                let events = self
                    .gateway
                    .execute(&self.tree_id, &node.id, SessionCommand::Poll)
                    .map_err(backend_error)?;
                self.emit_gateway_events(events, outputs)?;
            }
        }
        self.emit_snapshot_if_changed(outputs)
    }

    fn ensure_tree(&mut self) -> Result<(), BackendError> {
        if self.root.is_some() {
            return Ok(());
        }
        let snapshot = self.control.snapshot().map_err(backend_error)?;
        if snapshot.active_session.is_none() {
            return Ok(());
        }
        let root = self
            .gateway
            .create_tree_with_id(
                self.tree_id.clone(),
                &self.definition_id,
                self.root_role.clone(),
                self.root_objective.clone(),
            )
            .map_err(backend_error)?;
        self.root = Some(root);
        Ok(())
    }

    fn projected_snapshot(&mut self) -> Result<RuntimeSnapshot, BackendError> {
        let backend = self.control.snapshot().map_err(backend_error)?;
        let tree = if self.root.is_some() {
            Some(self.tree_snapshot()?)
        } else {
            None
        };
        project_snapshot(backend, tree.as_ref())
    }

    fn tree_snapshot(&self) -> Result<SessionTreeSnapshot, BackendError> {
        self.gateway.snapshot(&self.tree_id).map_err(backend_error)
    }

    fn selected_node(&mut self) -> Result<SessionNodeId, BackendError> {
        let tree = self.tree_snapshot()?;
        let backend = self.control.snapshot().map_err(backend_error)?;
        match backend.selected_run.as_ref() {
            Some(run_id) => node_for_run(&tree, &backend, run_id),
            None => Ok(tree.root),
        }
    }

    fn node_for_run(&mut self, run_id: &RunId) -> Result<SessionNodeId, BackendError> {
        let tree = self.tree_snapshot()?;
        let backend = self.control.snapshot().map_err(backend_error)?;
        node_for_run(&tree, &backend, run_id)
    }

    fn execute_for_run(
        &mut self,
        run_id: &RunId,
        command: SessionCommand,
        outputs: &BackendOutputSender,
    ) -> Result<(), BackendError> {
        let node = self.node_for_run(run_id)?;
        let events = self
            .gateway
            .execute(&self.tree_id, &node, command)
            .map_err(backend_error)?;
        self.emit_gateway_events(events, outputs)
    }

    fn emit_gateway_events(
        &mut self,
        events: Vec<phenix_acp::GatewayEvent>,
        outputs: &BackendOutputSender,
    ) -> Result<(), BackendError> {
        for event in &events {
            if let phenix_acp::SessionEvent::PermissionRequested { request_id, .. } = &event.event {
                let dialog_id = phenix_runtime_api::DialogId::parse(request_id.clone())
                    .map_err(|error| BackendError::Protocol(error.to_string()))?;
                self.interactions.insert(dialog_id, event.node_id.clone());
            }
        }
        let snapshot = self.projected_snapshot()?;
        for event in gateway_events(events, &snapshot, &mut self.transcript_sequence)? {
            outputs.event(event)?;
        }
        Ok(())
    }

    fn emit_snapshot_if_changed(
        &mut self,
        outputs: &BackendOutputSender,
    ) -> Result<(), BackendError> {
        let snapshot = self.projected_snapshot()?;
        if self.last_snapshot.as_ref() != Some(&snapshot) {
            self.last_snapshot = Some(snapshot.clone());
            outputs.event(BackendEvent::SnapshotChanged(snapshot))?;
        }
        Ok(())
    }

    fn finish_shutdown(&mut self) -> Result<(), BackendError> {
        if self.root.take().is_some() {
            self.gateway
                .close_tree(&self.tree_id)
                .map_err(backend_error)?;
        }
        self.control
            .submit(BackendCommand::Shutdown)
            .map_err(backend_error)?;
        Ok(())
    }
}

fn session_images(images: Vec<ImageInput>) -> Vec<SessionImage> {
    images
        .into_iter()
        .map(|image| SessionImage {
            media_type: image.media_type,
            data: image.bytes,
        })
        .collect()
}

fn model_selection(model: ModelRef) -> Result<ModelSelection, BackendError> {
    Ok(ModelSelection {
        provider: ProviderId::parse(model.provider)
            .map_err(|error| BackendError::InvalidConfiguration(error.to_string()))?,
        model: ModelId::parse(model.model)
            .map_err(|error| BackendError::InvalidConfiguration(error.to_string()))?,
    })
}

fn acp_session_id(session_id: &SessionId) -> Result<AcpSessionId, BackendError> {
    AcpSessionId::parse(session_id.as_str())
        .map_err(|error| BackendError::InvalidConfiguration(error.to_string()))
}

fn stock_role() -> Result<RoleId, BackendError> {
    RoleId::parse("stock").map_err(|error| BackendError::InvalidConfiguration(error.to_string()))
}

fn thinking_level(level: ThinkingLevel) -> &'static str {
    match level {
        ThinkingLevel::Off => "off",
        ThinkingLevel::Minimal => "minimal",
        ThinkingLevel::Low => "low",
        ThinkingLevel::Medium => "medium",
        ThinkingLevel::High => "high",
        ThinkingLevel::ExtraHigh => "extra_high",
        ThinkingLevel::Max => "max",
    }
}

fn interaction_response(response: ExtensionUiResponse) -> InteractionResponse {
    match response {
        ExtensionUiResponse::Selected(value) => InteractionResponse::Selected(value),
        ExtensionUiResponse::Confirmed(value) => InteractionResponse::Confirmed(value),
        ExtensionUiResponse::Text(value) => InteractionResponse::Text(value),
        ExtensionUiResponse::Cancelled => InteractionResponse::Cancelled,
    }
}

fn submitted_prompt_block(
    sequence: &mut u64,
    run_id: RunId,
    text: String,
) -> Result<TranscriptBlock, BackendError> {
    let current = *sequence;
    *sequence = sequence
        .checked_add(1)
        .ok_or_else(|| BackendError::Protocol("transcript IDs exhausted".to_owned()))?;
    Ok(TranscriptBlock {
        id: format!("gateway-transcript-{current}"),
        run_id,
        role: TranscriptRole::User,
        text,
        complete: true,
    })
}

fn backend_error(error: GatewayError) -> BackendError {
    BackendError::Protocol(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepted_prompt_is_visible_as_a_user_transcript_block() {
        let run_id = RunId::parse("run-root").expect("valid run ID");
        let mut sequence = 7;

        let block = submitted_prompt_block(&mut sequence, run_id.clone(), "hello".to_owned())
            .expect("transcript block");

        assert_eq!(sequence, 8);
        assert_eq!(block.id, "gateway-transcript-7");
        assert_eq!(block.run_id, run_id);
        assert_eq!(block.role, TranscriptRole::User);
        assert_eq!(block.text, "hello");
        assert!(block.complete);
    }
}
