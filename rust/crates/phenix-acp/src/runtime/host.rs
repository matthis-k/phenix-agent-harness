use super::{GatewayError, GatewayEvent, PhenixAcpGateway, SessionCommand, TreeStartResult};
use crate::{
    AcpSessionId, DefinitionId, Difficulty, ObjectiveId, ObjectiveState, RoleId,
    RoutingExplainResult, SessionNodeId, SessionTreeId, SessionTreeListResult, SessionTreeSnapshot,
    WorkflowId, WorkflowStartResult,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GatewayCommand {
    CreateTree {
        definition_id: DefinitionId,
        root_role: RoleId,
        difficulty: Difficulty,
        objective: String,
    },
    StartWorkflow {
        tree_id: SessionTreeId,
        workflow_id: WorkflowId,
        difficulty: Option<Difficulty>,
        objective: String,
    },
    Delegate {
        tree_id: SessionTreeId,
        parent_node: SessionNodeId,
        role: RoleId,
        difficulty: Option<Difficulty>,
        objective: String,
    },
    LoadSession {
        tree_id: SessionTreeId,
        parent_node: SessionNodeId,
        role: RoleId,
        difficulty: Option<Difficulty>,
        objective: String,
        session_id: AcpSessionId,
    },
    ResumeSession {
        tree_id: SessionTreeId,
        parent_node: SessionNodeId,
        role: RoleId,
        difficulty: Option<Difficulty>,
        objective: String,
        session_id: AcpSessionId,
    },
    ForkNode {
        tree_id: SessionTreeId,
        node_id: SessionNodeId,
        objective: String,
    },
    Execute {
        tree_id: SessionTreeId,
        node_id: SessionNodeId,
        command: SessionCommand,
    },
    CancelSubtree {
        tree_id: SessionTreeId,
        node_id: SessionNodeId,
    },
    Snapshot {
        tree_id: SessionTreeId,
    },
    ListTrees,
    ExplainRoute {
        tree_id: SessionTreeId,
        objective: String,
        role: RoleId,
        difficulty: Difficulty,
    },
    MarkObjective {
        tree_id: SessionTreeId,
        objective_id: ObjectiveId,
        state: ObjectiveState,
    },
    CloseTree {
        tree_id: SessionTreeId,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "reply", rename_all = "snake_case")]
pub enum GatewayReply {
    TreeCreated(TreeStartResult),
    WorkflowStarted(WorkflowStartResult),
    NodeCreated { node_id: SessionNodeId },
    Events(Vec<GatewayEvent>),
    Snapshot(SessionTreeSnapshot),
    Trees(SessionTreeListResult),
    Routing(RoutingExplainResult),
    Completed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct GatewayFailure {
    pub code: String,
    pub message: String,
}

impl From<GatewayError> for GatewayFailure {
    fn from(error: GatewayError) -> Self {
        Self {
            code: error.code().to_owned(),
            message: error.to_string(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct GatewayEnvelope {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply: Option<GatewayReply>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<GatewayFailure>,
}

impl PhenixAcpGateway {
    pub fn handle(&mut self, command: GatewayCommand) -> Result<GatewayReply, GatewayError> {
        match command {
            GatewayCommand::CreateTree {
                definition_id,
                root_role,
                difficulty,
                objective,
            } => Ok(GatewayReply::TreeCreated(self.create_tree(
                &definition_id,
                root_role,
                difficulty,
                objective,
            )?)),
            GatewayCommand::StartWorkflow {
                tree_id,
                workflow_id,
                difficulty,
                objective,
            } => Ok(GatewayReply::WorkflowStarted(self.start_workflow(
                &tree_id,
                &workflow_id,
                difficulty,
                objective,
            )?)),
            GatewayCommand::Delegate {
                tree_id,
                parent_node,
                role,
                difficulty,
                objective,
            } => Ok(GatewayReply::NodeCreated {
                node_id: self.delegate(&tree_id, &parent_node, role, difficulty, objective)?,
            }),
            GatewayCommand::LoadSession {
                tree_id,
                parent_node,
                role,
                difficulty,
                objective,
                session_id,
            } => Ok(GatewayReply::NodeCreated {
                node_id: self.load_session(
                    &tree_id,
                    &parent_node,
                    role,
                    difficulty,
                    objective,
                    session_id,
                )?,
            }),
            GatewayCommand::ResumeSession {
                tree_id,
                parent_node,
                role,
                difficulty,
                objective,
                session_id,
            } => Ok(GatewayReply::NodeCreated {
                node_id: self.resume_session(
                    &tree_id,
                    &parent_node,
                    role,
                    difficulty,
                    objective,
                    session_id,
                )?,
            }),
            GatewayCommand::ForkNode {
                tree_id,
                node_id,
                objective,
            } => Ok(GatewayReply::NodeCreated {
                node_id: self.fork_node(&tree_id, &node_id, objective)?,
            }),
            GatewayCommand::Execute {
                tree_id,
                node_id,
                command,
            } => Ok(GatewayReply::Events(
                self.execute(&tree_id, &node_id, command)?,
            )),
            GatewayCommand::CancelSubtree { tree_id, node_id } => Ok(GatewayReply::Events(
                self.cancel_subtree(&tree_id, &node_id)?,
            )),
            GatewayCommand::Snapshot { tree_id } => {
                Ok(GatewayReply::Snapshot(self.snapshot(&tree_id)?))
            }
            GatewayCommand::ListTrees => Ok(GatewayReply::Trees(self.list_trees())),
            GatewayCommand::ExplainRoute {
                tree_id,
                objective,
                role,
                difficulty,
            } => Ok(GatewayReply::Routing(
                self.explain_route(&tree_id, objective, role, difficulty)?,
            )),
            GatewayCommand::MarkObjective {
                tree_id,
                objective_id,
                state,
            } => {
                self.mark_objective(&tree_id, &objective_id, state)?;
                Ok(GatewayReply::Completed)
            }
            GatewayCommand::CloseTree { tree_id } => {
                self.close_tree(&tree_id)?;
                Ok(GatewayReply::Completed)
            }
        }
    }

    pub fn handle_json(&mut self, input: &str) -> String {
        let envelope = match serde_json::from_str::<GatewayCommand>(input) {
            Ok(command) => match self.handle(command) {
                Ok(reply) => GatewayEnvelope {
                    reply: Some(reply),
                    error: None,
                },
                Err(error) => GatewayEnvelope {
                    reply: None,
                    error: Some(GatewayFailure::from(error)),
                },
            },
            Err(error) => GatewayEnvelope {
                reply: None,
                error: Some(GatewayFailure {
                    code: "decode".to_owned(),
                    message: error.to_string(),
                }),
            },
        };
        serde_json::to_string(&envelope).unwrap_or_else(|error| {
            format!(
                "{{\"error\":{{\"code\":\"encode\",\"message\":{:?}}}}}",
                error.to_string()
            )
        })
    }
}
