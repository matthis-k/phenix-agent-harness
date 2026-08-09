use crate::ownership::ConductorOwner;
use agent_client_protocol::schema::v1::{
    AgentNotification, ExtNotification, ExtRequest, ExtResponse,
};
use agent_client_protocol::{Client, ConnectionTo};
use phenix_acp::{
    AcpMethod, AcpNotification, EmptyResult, GatewayEvent, NodeCancel, NodeEventNotification,
    NodeEventParams, NodeExecute, NodeExecuteResult, NodeSubscribe, NodeSubscriptionParams,
    NodeUnsubscribe, SessionTreeSnapshot, SessionTreeUpdatedNotification, SessionTreeUpdatedParams,
};
use serde::Serialize;
use serde_json::value::to_raw_value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const SUBSCRIPTION_POLL_PERIOD: Duration = Duration::from_millis(20);

#[derive(Clone, Default)]
pub struct SubscriptionHub {
    state: Arc<Mutex<SubscriptionState>>,
    started: Arc<AtomicBool>,
}

#[derive(Default)]
struct SubscriptionState {
    nodes: BTreeSet<NodeSubscriptionParams>,
    active_standard_prompts: BTreeSet<phenix_acp::SessionTreeId>,
}

impl SubscriptionHub {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start(&self, runtime: Arc<Mutex<ConductorOwner>>, connection: ConnectionTo<Client>) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let hub = self.clone();
        tokio::spawn(async move {
            hub.run(runtime, connection).await;
        });
    }

    pub fn handle_control(
        &self,
        request: &ExtRequest,
        runtime: &Arc<Mutex<ConductorOwner>>,
    ) -> Result<Option<ExtResponse>, agent_client_protocol::Error> {
        match request.method.as_ref() {
            NodeSubscribe::METHOD => {
                let subscription = decode_subscription(request)?;
                validate_subscription(runtime, &subscription)?;
                self.lock_state()?.nodes.insert(subscription);
                encode_response(&EmptyResult {}).map(Some)
            }
            NodeUnsubscribe::METHOD => {
                let subscription = decode_subscription(request)?;
                self.lock_state()?.nodes.remove(&subscription);
                encode_response(&EmptyResult {}).map(Some)
            }
            _ => Ok(None),
        }
    }

    pub fn publish_response(
        &self,
        request: &ExtRequest,
        response: &ExtResponse,
        connection: &ConnectionTo<Client>,
    ) -> Result<(), agent_client_protocol::Error> {
        if !matches!(
            request.method.as_ref(),
            NodeExecute::METHOD | NodeCancel::METHOD
        ) {
            return Ok(());
        }
        let result =
            serde_json::from_str::<NodeExecuteResult>(response.0.get()).map_err(|error| {
                agent_client_protocol::util::internal_error(format!(
                    "invalid conductor node result: {error}"
                ))
            })?;
        for event in result.events {
            self.publish_event_if_subscribed(connection, event)?;
        }
        Ok(())
    }

    pub fn begin_standard_prompt(
        &self,
        session_id: &str,
    ) -> Result<StandardPromptLease, agent_client_protocol::Error> {
        let tree_id = phenix_acp::SessionTreeId::parse(session_id).map_err(|error| {
            agent_client_protocol::util::internal_error(format!(
                "standard ACP session is not a Phenix tree: {error}"
            ))
        })?;
        self.lock_state()?
            .active_standard_prompts
            .insert(tree_id.clone());
        Ok(StandardPromptLease {
            hub: self.clone(),
            tree_id,
        })
    }

    pub fn remove_tree(&self, tree_id: &str) -> Result<(), agent_client_protocol::Error> {
        let tree_id = phenix_acp::SessionTreeId::parse(tree_id).map_err(|error| {
            agent_client_protocol::util::internal_error(format!(
                "standard ACP session is not a Phenix tree: {error}"
            ))
        })?;
        let mut state = self.lock_state()?;
        state.nodes.retain(|node| node.tree_id != tree_id);
        state.active_standard_prompts.remove(&tree_id);
        Ok(())
    }

    async fn run(self, runtime: Arc<Mutex<ConductorOwner>>, connection: ConnectionTo<Client>) {
        let mut last_snapshots = BTreeMap::<phenix_acp::SessionTreeId, SessionTreeSnapshot>::new();
        loop {
            tokio::time::sleep(SUBSCRIPTION_POLL_PERIOD).await;
            let (subscriptions, active_prompts) = match self.subscription_snapshot() {
                Ok(snapshot) => snapshot,
                Err(_) => break,
            };
            if subscriptions.is_empty() {
                continue;
            }

            let mut events = Vec::new();
            let mut snapshots = BTreeMap::new();
            let mut invalid = Vec::new();
            let runtime_result = runtime.lock().map_err(|_| ()).map(|mut runtime| {
                for subscription in &subscriptions {
                    if active_prompts.contains(&subscription.tree_id) {
                        continue;
                    }
                    match runtime.poll_node(&subscription.tree_id, &subscription.node_id) {
                        Ok(polled) => events.extend(polled),
                        Err(_) => {
                            invalid.push(subscription.clone());
                            continue;
                        }
                    }
                    match runtime.snapshot_tree(&subscription.tree_id) {
                        Ok(snapshot) => {
                            snapshots.insert(subscription.tree_id.clone(), snapshot);
                        }
                        Err(_) => invalid.push(subscription.clone()),
                    }
                }
            });
            if runtime_result.is_err() {
                break;
            }
            if !invalid.is_empty() {
                if let Ok(mut state) = self.state.lock() {
                    for subscription in invalid {
                        state.nodes.remove(&subscription);
                    }
                }
            }

            for event in events {
                if self
                    .publish_event_if_subscribed(&connection, event)
                    .is_err()
                {
                    return;
                }
            }
            for (tree_id, snapshot) in snapshots {
                if last_snapshots.get(&tree_id) == Some(&snapshot) {
                    continue;
                }
                last_snapshots.insert(tree_id, snapshot.clone());
                if send_notification::<SessionTreeUpdatedNotification>(
                    &connection,
                    &SessionTreeUpdatedParams { tree: snapshot },
                )
                .is_err()
                {
                    return;
                }
            }
        }
    }

    fn publish_event_if_subscribed(
        &self,
        connection: &ConnectionTo<Client>,
        event: GatewayEvent,
    ) -> Result<(), agent_client_protocol::Error> {
        let subscription = NodeSubscriptionParams {
            tree_id: event.tree_id.clone(),
            node_id: event.node_id.clone(),
        };
        if !self.lock_state()?.nodes.contains(&subscription) {
            return Ok(());
        }
        send_notification::<NodeEventNotification>(connection, &NodeEventParams { event })
    }

    fn subscription_snapshot(
        &self,
    ) -> Result<
        (
            Vec<NodeSubscriptionParams>,
            BTreeSet<phenix_acp::SessionTreeId>,
        ),
        agent_client_protocol::Error,
    > {
        let state = self.lock_state()?;
        Ok((
            state.nodes.iter().cloned().collect(),
            state.active_standard_prompts.clone(),
        ))
    }

    fn lock_state(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, SubscriptionState>, agent_client_protocol::Error> {
        self.state
            .lock()
            .map_err(|_| agent_client_protocol::Error::internal_error())
    }
}

pub struct StandardPromptLease {
    hub: SubscriptionHub,
    tree_id: phenix_acp::SessionTreeId,
}

impl Drop for StandardPromptLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.hub.state.lock() {
            state.active_standard_prompts.remove(&self.tree_id);
        }
    }
}

fn decode_subscription(
    request: &ExtRequest,
) -> Result<NodeSubscriptionParams, agent_client_protocol::Error> {
    serde_json::from_str(request.params.get()).map_err(|error| {
        agent_client_protocol::util::internal_error(format!(
            "invalid {} parameters: {error}",
            request.method
        ))
    })
}

fn validate_subscription(
    runtime: &Arc<Mutex<ConductorOwner>>,
    subscription: &NodeSubscriptionParams,
) -> Result<(), agent_client_protocol::Error> {
    let runtime = runtime
        .lock()
        .map_err(|_| agent_client_protocol::Error::internal_error())?;
    let snapshot = runtime
        .snapshot_tree(&subscription.tree_id)
        .map_err(|error| agent_client_protocol::util::internal_error(error.to_string()))?;
    if snapshot
        .nodes
        .iter()
        .any(|node| node.id == subscription.node_id)
    {
        Ok(())
    } else {
        Err(agent_client_protocol::util::internal_error(format!(
            "node {} is not part of tree {}",
            subscription.node_id, subscription.tree_id
        )))
    }
}

fn encode_response<T: Serialize>(value: &T) -> Result<ExtResponse, agent_client_protocol::Error> {
    let raw = to_raw_value(value).map_err(agent_client_protocol::Error::into_internal_error)?;
    Ok(ExtResponse::new(Arc::from(raw)))
}

fn send_notification<N: AcpNotification>(
    connection: &ConnectionTo<Client>,
    params: &N::Params,
) -> Result<(), agent_client_protocol::Error> {
    let raw = to_raw_value(params).map_err(agent_client_protocol::Error::into_internal_error)?;
    connection.send_notification(AgentNotification::ExtNotification(ExtNotification::new(
        N::METHOD,
        Arc::from(raw),
    )))
}
