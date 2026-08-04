use crate::{
    AcpSessionId, BackendId, DefinitionId, ModelId, ObjectiveId, ProviderId, RoleId, RouterId,
    SessionNodeId, SessionTreeDefinition, SessionTreeId, WorkflowId,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

pub trait AcpMethod {
    const METHOD: &'static str;
    type Params: Serialize;
    type Result: DeserializeOwned;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelSelection {
    pub provider: ProviderId,
    pub model: ModelId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
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
    pub state: SessionNodeState,
    pub backend: BackendId,
    pub downstream_session: Option<AcpSessionId>,
    pub model: Option<ModelSelection>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
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
    pub definition: SessionTreeDefinition,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionTreeCreateResult {
    pub tree_id: SessionTreeId,
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
    pub objective: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkflowStartResult {
    pub objective_id: ObjectiveId,
    pub root_node_id: SessionNodeId,
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
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RoutingExplainResult {
    pub router: RouterId,
    pub backend: BackendId,
    pub model: Option<ModelSelection>,
    pub explanation: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_method<M: AcpMethod>(expected: &str) {
        assert_eq!(M::METHOD, expected);
    }

    #[test]
    fn extension_methods_are_namespaced_and_statically_link_params_to_results() {
        assert_method::<SessionTreeCreate>("_phenix/session_tree/create");
        assert_method::<SessionTreeGet>("_phenix/session_tree/get");
        assert_method::<WorkflowStart>("_phenix/workflow/start");
        assert_method::<RoutingExplain>("_phenix/routing/explain");
    }
}
