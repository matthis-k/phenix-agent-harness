use crate::{AcpMethod, EmptyResult, SessionNodeId, SessionTreeId};
use serde::{Deserialize, Serialize};

pub struct NodeSubscribe;

impl AcpMethod for NodeSubscribe {
    const METHOD: &'static str = "_phenix/node/subscribe";
    type Params = NodeSubscriptionParams;
    type Result = EmptyResult;
}

pub struct NodeUnsubscribe;

impl AcpMethod for NodeUnsubscribe {
    const METHOD: &'static str = "_phenix/node/unsubscribe";
    type Params = NodeSubscriptionParams;
    type Result = EmptyResult;
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub struct NodeSubscriptionParams {
    pub tree_id: SessionTreeId,
    pub node_id: SessionNodeId,
}
