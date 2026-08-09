use crate::{
    AcpSessionId, BackendId, DefinitionId, GatewayEvent, ModelId, ObjectiveId, ProviderId, RoleId,
    RouterId, SessionCommand, SessionNodeId, SessionTreeId, WorkflowId,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt::{self, Display, Formatter};

pub trait AcpMethod {
    const METHOD: &'static str;
    type Params: Serialize + DeserializeOwned;
    type Result: Serialize + DeserializeOwned;
}

pub trait AcpNotification {
    const METHOD: &'static str;
    type Params: Serialize + DeserializeOwned;
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct EmptyResult {}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelSelection {
    pub provider: ProviderId,
    pub model: ModelId,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Difficulty {
    D0,
    D1,
    D2,
    D3,
    D4,
}

impl Difficulty {
    pub const ALL: [Self; 5] = [Self::D0, Self::D1, Self::D2, Self::D3, Self::D4];

    pub const fn index(self) -> usize {
        match self {
            Self::D0 => 0,
            Self::D1 => 1,
            Self::D2 => 2,
            Self::D3 => 3,
            Self::D4 => 4,
        }
    }
}

impl Display for Difficulty {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::D0 => "d0",
            Self::D1 => "d1",
            Self::D2 => "d2",
            Self::D3 => "d3",
            Self::D4 => "d4",
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    ExtraHigh,
    Max,
}

impl Display for ThinkingLevel {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::ExtraHigh => "extra_high",
            Self::Max => "max",
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelConfig {
    pub backend: BackendId,
    pub provider: ProviderId,
    pub model: ModelId,
    pub thinking: ThinkingLevel,
}

impl ModelConfig {
    pub fn selection(&self) -> ModelSelection {
        ModelSelection {
            provider: self.provider.clone(),
            model: self.model.clone(),
        }
    }
}

impl Display for ModelConfig {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}/{}/{}/{}",
            self.backend, self.provider, self.model, self.thinking
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionNodeState {
    Created,
    Starting,
    Running,
    WaitingForInput,
    Completed,
    Failed,
    Cancelled,
    Orphaned,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionNodeSnapshot {
    pub id: SessionNodeId,
    pub parent: Option<SessionNodeId>,
    pub role: RoleId,
    pub difficulty: Difficulty,
    pub state: SessionNodeState,
    pub model: ModelConfig,
    pub objective_id: ObjectiveId,
    pub downstream_session: Option<AcpSessionId>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObjectiveState {
    NotStarted,
    WorkInProgress,
    Done,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ObjectiveSnapshot {
    pub id: ObjectiveId,
    pub parent: Option<ObjectiveId>,
    pub title: String,
    pub state: ObjectiveState,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionTreeSnapshot {
    pub id: SessionTreeId,
    pub definition_id: DefinitionId,
    pub root: SessionNodeId,
    pub nodes: Vec<SessionNodeSnapshot>,
    pub objectives: Vec<ObjectiveSnapshot>,
    pub active_workflow: Option<WorkflowId>,
}

pub struct SessionTreeCreate;

impl AcpMethod for SessionTreeCreate {
    const METHOD: &'static str = "_phenix/session_tree/create";
    type Params = SessionTreeCreateParams;
    type Result = SessionTreeCreateResult;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionTreeCreateParams {
    #[serde(default)]
    pub tree_id: Option<SessionTreeId>,
    pub definition_id: DefinitionId,
    pub root_role: RoleId,
    pub difficulty: Difficulty,
    pub objective: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionTreeCreateResult {
    pub tree_id: SessionTreeId,
    pub objective_id: ObjectiveId,
    pub root_node_id: SessionNodeId,
}

pub struct SessionTreeGet;

impl AcpMethod for SessionTreeGet {
    const METHOD: &'static str = "_phenix/session_tree/get";
    type Params = SessionTreeGetParams;
    type Result = SessionTreeSnapshot;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionTreeGetParams {
    pub tree_id: SessionTreeId,
}

pub struct SessionTreeList;

impl AcpMethod for SessionTreeList {
    const METHOD: &'static str = "_phenix/session_tree/list";
    type Params = SessionTreeListParams;
    type Result = SessionTreeListResult;
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionTreeListParams {}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionTreeSummary {
    pub tree_id: SessionTreeId,
    pub definition_id: DefinitionId,
    pub root_session: Option<AcpSessionId>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionTreeListResult {
    pub trees: Vec<SessionTreeSummary>,
}

pub struct SessionTreeClose;

impl AcpMethod for SessionTreeClose {
    const METHOD: &'static str = "_phenix/session_tree/close";
    type Params = SessionTreeCloseParams;
    type Result = EmptyResult;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionTreeCloseParams {
    pub tree_id: SessionTreeId,
}

pub struct WorkflowStart;

impl AcpMethod for WorkflowStart {
    const METHOD: &'static str = "_phenix/workflow/start";
    type Params = WorkflowStartParams;
    type Result = WorkflowStartResult;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkflowStartParams {
    pub tree_id: SessionTreeId,
    pub workflow: WorkflowId,
    #[serde(default)]
    pub difficulty: Option<Difficulty>,
    pub objective: String,
    #[serde(default)]
    pub input: Value,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkflowStartResult {
    pub objective_id: ObjectiveId,
    pub root_node_id: SessionNodeId,
}

pub struct NodeDelegate;

impl AcpMethod for NodeDelegate {
    const METHOD: &'static str = "_phenix/node/delegate";
    type Params = NodeDelegateParams;
    type Result = NodeAttachResult;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NodeDelegateParams {
    pub tree_id: SessionTreeId,
    pub parent_node: SessionNodeId,
    pub role: RoleId,
    #[serde(default)]
    pub difficulty: Option<Difficulty>,
    pub objective: String,
}

pub struct NodeLoad;

impl AcpMethod for NodeLoad {
    const METHOD: &'static str = "_phenix/node/load";
    type Params = NodeLoadParams;
    type Result = NodeAttachResult;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NodeLoadParams {
    pub tree_id: SessionTreeId,
    pub parent_node: SessionNodeId,
    pub role: RoleId,
    #[serde(default)]
    pub difficulty: Option<Difficulty>,
    pub objective: String,
    pub session_id: AcpSessionId,
}

pub struct NodeResume;

impl AcpMethod for NodeResume {
    const METHOD: &'static str = "_phenix/node/resume";
    type Params = NodeResumeParams;
    type Result = NodeAttachResult;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NodeResumeParams {
    pub tree_id: SessionTreeId,
    pub parent_node: SessionNodeId,
    pub role: RoleId,
    #[serde(default)]
    pub difficulty: Option<Difficulty>,
    pub objective: String,
    pub session_id: AcpSessionId,
}

pub struct NodeFork;

impl AcpMethod for NodeFork {
    const METHOD: &'static str = "_phenix/node/fork";
    type Params = NodeForkParams;
    type Result = NodeAttachResult;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NodeForkParams {
    pub tree_id: SessionTreeId,
    pub node_id: SessionNodeId,
    pub objective: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NodeAttachResult {
    pub node_id: SessionNodeId,
}

pub struct NodeExecute;

impl AcpMethod for NodeExecute {
    const METHOD: &'static str = "_phenix/node/execute";
    type Params = NodeExecuteParams;
    type Result = NodeExecuteResult;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NodeExecuteParams {
    pub tree_id: SessionTreeId,
    pub node_id: SessionNodeId,
    pub command: SessionCommand,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NodeExecuteResult {
    pub events: Vec<GatewayEvent>,
}

pub struct NodeCancel;

impl AcpMethod for NodeCancel {
    const METHOD: &'static str = "_phenix/node/cancel";
    type Params = NodeCancelParams;
    type Result = NodeExecuteResult;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NodeCancelParams {
    pub tree_id: SessionTreeId,
    pub node_id: SessionNodeId,
}

pub struct ObjectiveMark;

impl AcpMethod for ObjectiveMark {
    const METHOD: &'static str = "_phenix/objective/mark";
    type Params = ObjectiveMarkParams;
    type Result = EmptyResult;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ObjectiveMarkParams {
    pub tree_id: SessionTreeId,
    pub objective_id: ObjectiveId,
    pub state: ObjectiveState,
}

pub struct RoutingExplain;

impl AcpMethod for RoutingExplain {
    const METHOD: &'static str = "_phenix/routing/explain";
    type Params = RoutingExplainParams;
    type Result = RoutingExplainResult;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RoutingExplainParams {
    pub tree_id: SessionTreeId,
    pub objective: String,
    pub required_role: Option<RoleId>,
    pub difficulty: Difficulty,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RoutingExplainResult {
    pub router: RouterId,
    pub difficulty: Difficulty,
    pub model: ModelConfig,
    pub explanation: String,
}

pub struct NodeEventNotification;

impl AcpNotification for NodeEventNotification {
    const METHOD: &'static str = "_phenix/node/event";
    type Params = NodeEventParams;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NodeEventParams {
    pub event: GatewayEvent,
}

pub struct SessionTreeUpdatedNotification;

impl AcpNotification for SessionTreeUpdatedNotification {
    const METHOD: &'static str = "_phenix/session_tree/updated";
    type Params = SessionTreeUpdatedParams;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionTreeUpdatedParams {
    pub tree: SessionTreeSnapshot,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_method<M: AcpMethod>(expected: &str) {
        assert_eq!(M::METHOD, expected);
    }

    fn assert_notification<N: AcpNotification>(expected: &str) {
        assert_eq!(N::METHOD, expected);
    }

    #[test]
    fn conductor_methods_are_namespaced_and_statically_link_params_to_results() {
        assert_method::<SessionTreeCreate>("_phenix/session_tree/create");
        assert_method::<SessionTreeGet>("_phenix/session_tree/get");
        assert_method::<SessionTreeList>("_phenix/session_tree/list");
        assert_method::<SessionTreeClose>("_phenix/session_tree/close");
        assert_method::<WorkflowStart>("_phenix/workflow/start");
        assert_method::<NodeDelegate>("_phenix/node/delegate");
        assert_method::<NodeLoad>("_phenix/node/load");
        assert_method::<NodeResume>("_phenix/node/resume");
        assert_method::<NodeFork>("_phenix/node/fork");
        assert_method::<NodeExecute>("_phenix/node/execute");
        assert_method::<NodeCancel>("_phenix/node/cancel");
        assert_method::<ObjectiveMark>("_phenix/objective/mark");
        assert_method::<RoutingExplain>("_phenix/routing/explain");
    }

    #[test]
    fn conductor_notifications_are_separate_from_request_response_methods() {
        assert_notification::<NodeEventNotification>("_phenix/node/event");
        assert_notification::<SessionTreeUpdatedNotification>("_phenix/session_tree/updated");
    }

    #[test]
    fn workflow_input_defaults_to_null_for_existing_clients() {
        let decoded: WorkflowStartParams = serde_json::from_value(serde_json::json!({
            "tree_id": "tree-1",
            "workflow": "workflow.implement",
            "objective": "ship"
        }))
        .expect("workflow params");
        assert_eq!(decoded.input, Value::Null);
    }
}
