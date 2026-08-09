use crate::{
    AcpMethod, Difficulty, EmptyResult, GatewayError, GatewayEvent, NodeAttachResult, NodeCancel,
    NodeDelegate, NodeExecute, NodeExecuteResult, NodeFork, NodeLoad, NodeResume, ObjectiveId,
    ObjectiveMark, PhenixAcpGateway, RoleId, RoutingExplain, RoutingExplainParams, SessionCommand,
    SessionEvent, SessionNodeId, SessionTreeClose, SessionTreeCreate, SessionTreeCreateResult,
    SessionTreeGet, SessionTreeId, SessionTreeList, WorkflowAction, WorkflowGraph, WorkflowId,
    WorkflowMachine, WorkflowStart, WorkflowStartParams, WorkflowStartResult,
};
use agent_client_protocol::schema::v1::{ExtRequest, ExtResponse};
use serde::Serialize;
use serde_json::value::to_raw_value;
use std::collections::{BTreeMap, VecDeque};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::Arc;

/// Owns the aggregate Phenix state and translates typed Phenix ACP extensions
/// into operations over ordinary downstream ACP sessions.
///
/// Workflow policy is evaluated here, above the ACP session boundary. Downstream
/// agents receive only the concrete invoke objective and already-settled typed
/// context. They do not decide graph topology, joins, repairs, aliases or terminal
/// workflow state.
pub struct PhenixConductor {
    gateway: PhenixAcpGateway,
    workflow_graphs: BTreeMap<WorkflowId, WorkflowGraph>,
    workflow_runs: BTreeMap<SessionTreeId, ManagedWorkflowRun>,
}

struct ManagedWorkflowRun {
    workflow_id: WorkflowId,
    objective_id: ObjectiveId,
    root_node_id: SessionNodeId,
    difficulty: Difficulty,
    machine: WorkflowMachine,
    pending_events: BTreeMap<SessionNodeId, VecDeque<GatewayEvent>>,
    finished: bool,
}

impl PhenixConductor {
    pub fn new(gateway: PhenixAcpGateway) -> Self {
        Self::with_workflow_graphs(gateway, BTreeMap::new())
    }

    pub fn with_workflow_graphs(
        gateway: PhenixAcpGateway,
        workflow_graphs: BTreeMap<WorkflowId, WorkflowGraph>,
    ) -> Self {
        Self {
            gateway,
            workflow_graphs,
            workflow_runs: BTreeMap::new(),
        }
    }

    pub fn gateway(&self) -> &PhenixAcpGateway {
        &self.gateway
    }

    pub fn gateway_mut(&mut self) -> &mut PhenixAcpGateway {
        &mut self.gateway
    }

    pub fn into_gateway(self) -> PhenixAcpGateway {
        self.gateway
    }

    pub fn handle_extension(&mut self, request: ExtRequest) -> Result<ExtResponse, ConductorError> {
        match request.method.as_ref() {
            SessionTreeCreate::METHOD => {
                self.dispatch::<SessionTreeCreate, _>(&request, |gateway, params| {
                    let started = match params.tree_id {
                        Some(tree_id) => gateway.create_tree_with_id(
                            tree_id,
                            &params.definition_id,
                            params.root_role,
                            params.difficulty,
                            params.objective,
                        )?,
                        None => gateway.create_tree(
                            &params.definition_id,
                            params.root_role,
                            params.difficulty,
                            params.objective,
                        )?,
                    };
                    Ok(SessionTreeCreateResult {
                        tree_id: started.tree_id,
                        objective_id: started.objective_id,
                        root_node_id: started.root_node_id,
                    })
                })
            }
            SessionTreeGet::METHOD => self
                .dispatch::<SessionTreeGet, _>(&request, |gateway, params| {
                    gateway.snapshot(&params.tree_id)
                }),
            SessionTreeList::METHOD => self
                .dispatch::<SessionTreeList, _>(&request, |gateway, _params| {
                    Ok(gateway.list_trees())
                }),
            SessionTreeClose::METHOD => {
                let params = self.decode::<SessionTreeClose>(&request)?;
                self.workflow_runs.remove(&params.tree_id);
                self.gateway.close_tree(&params.tree_id)?;
                encode_result(SessionTreeClose::METHOD, &EmptyResult {})
            }
            WorkflowStart::METHOD => {
                let params = self.decode::<WorkflowStart>(&request)?;
                let result = self.start_workflow(params)?;
                encode_result(WorkflowStart::METHOD, &result)
            }
            NodeDelegate::METHOD => {
                self.dispatch::<NodeDelegate, _>(&request, |gateway, params| {
                    let node_id = gateway.delegate(
                        &params.tree_id,
                        &params.parent_node,
                        params.role,
                        params.difficulty,
                        params.objective,
                    )?;
                    Ok(NodeAttachResult { node_id })
                })
            }
            NodeLoad::METHOD => self.dispatch::<NodeLoad, _>(&request, |gateway, params| {
                let node_id = gateway.load_session(
                    &params.tree_id,
                    &params.parent_node,
                    params.role,
                    params.difficulty,
                    params.objective,
                    params.session_id,
                )?;
                Ok(NodeAttachResult { node_id })
            }),
            NodeResume::METHOD => self.dispatch::<NodeResume, _>(&request, |gateway, params| {
                let node_id = gateway.resume_session(
                    &params.tree_id,
                    &params.parent_node,
                    params.role,
                    params.difficulty,
                    params.objective,
                    params.session_id,
                )?;
                Ok(NodeAttachResult { node_id })
            }),
            NodeFork::METHOD => self.dispatch::<NodeFork, _>(&request, |gateway, params| {
                let node_id =
                    gateway.fork_node(&params.tree_id, &params.node_id, params.objective)?;
                Ok(NodeAttachResult { node_id })
            }),
            NodeExecute::METHOD => {
                let params = self.decode::<NodeExecute>(&request)?;
                let events = self.execute_node(&params.tree_id, &params.node_id, params.command)?;
                encode_result(NodeExecute::METHOD, &NodeExecuteResult { events })
            }
            NodeCancel::METHOD => {
                let params = self.decode::<NodeCancel>(&request)?;
                let events = self.cancel_node(&params.tree_id, &params.node_id)?;
                encode_result(NodeCancel::METHOD, &NodeExecuteResult { events })
            }
            ObjectiveMark::METHOD => {
                self.dispatch::<ObjectiveMark, _>(&request, |gateway, params| {
                    gateway.mark_objective(&params.tree_id, &params.objective_id, params.state)?;
                    Ok(EmptyResult {})
                })
            }
            RoutingExplain::METHOD => {
                self.dispatch::<RoutingExplain, _>(&request, |gateway, params| {
                    let role = route_role(gateway, &params)?;
                    gateway.explain_route(
                        &params.tree_id,
                        params.objective,
                        role,
                        params.difficulty,
                    )
                })
            }
            method => Err(ConductorError::UnknownMethod(method.to_owned())),
        }
    }

    /// Poll a node while also advancing any conductor-owned workflow in its tree.
    ///
    /// A root subscription is sufficient to keep a workflow moving: all running
    /// invoke states are polled once, while events remain queued under their
    /// actual node IDs until that node is requested/subscribed.
    pub fn poll_node(
        &mut self,
        tree_id: &SessionTreeId,
        node_id: &SessionNodeId,
    ) -> Result<Vec<GatewayEvent>, GatewayError> {
        if !self.workflow_runs.contains_key(tree_id) {
            return self.gateway.execute(tree_id, node_id, SessionCommand::Poll);
        }

        let mut run = self
            .workflow_runs
            .remove(tree_id)
            .ok_or_else(|| GatewayError::Invariant("managed workflow disappeared".to_owned()))?;
        self.poll_running_states(tree_id, &mut run)?;
        self.drive_managed_workflow(tree_id, &mut run)?;
        let events = drain_pending(&mut run, node_id);
        self.workflow_runs.insert(tree_id.clone(), run);
        Ok(events)
    }

    fn start_workflow(
        &mut self,
        params: WorkflowStartParams,
    ) -> Result<WorkflowStartResult, GatewayError> {
        let Some(graph) = self.workflow_graphs.get(&params.workflow).cloned() else {
            return self.gateway.start_workflow(
                &params.tree_id,
                &params.workflow,
                params.difficulty,
                params.objective,
            );
        };
        if self.workflow_runs.contains_key(&params.tree_id) {
            return Err(GatewayError::workflow(format!(
                "tree {} already has a conductor-managed workflow",
                params.tree_id
            )));
        }

        let (objective_id, root_node_id, root_difficulty) = self.gateway.begin_workflow(
            &params.tree_id,
            &params.workflow,
            params.objective.clone(),
        )?;
        let difficulty = params.difficulty.unwrap_or(root_difficulty);
        let machine = match WorkflowMachine::new(graph, params.objective, params.input) {
            Ok(machine) => machine,
            Err(error) => {
                let _ = self.gateway.finish_workflow(
                    &params.tree_id,
                    &params.workflow,
                    &objective_id,
                    false,
                );
                return Err(error);
            }
        };
        let mut run = ManagedWorkflowRun {
            workflow_id: params.workflow,
            objective_id: objective_id.clone(),
            root_node_id: root_node_id.clone(),
            difficulty,
            machine,
            pending_events: BTreeMap::new(),
            finished: false,
        };
        self.drive_managed_workflow(&params.tree_id, &mut run)?;
        let first_node = run
            .machine
            .first_bound_node()
            .unwrap_or_else(|| root_node_id.clone());
        self.workflow_runs.insert(params.tree_id, run);
        Ok(WorkflowStartResult {
            objective_id,
            root_node_id: first_node,
        })
    }

    fn execute_node(
        &mut self,
        tree_id: &SessionTreeId,
        node_id: &SessionNodeId,
        command: SessionCommand,
    ) -> Result<Vec<GatewayEvent>, GatewayError> {
        if !self.workflow_runs.contains_key(tree_id) {
            return self.gateway.execute(tree_id, node_id, command);
        }
        let mut run = self
            .workflow_runs
            .remove(tree_id)
            .ok_or_else(|| GatewayError::Invariant("managed workflow disappeared".to_owned()))?;
        let events = self.gateway.execute(tree_id, node_id, command)?;
        self.observe_if_running(&mut run, node_id, &events)?;
        self.drive_managed_workflow(tree_id, &mut run)?;
        self.workflow_runs.insert(tree_id.clone(), run);
        Ok(events)
    }

    fn cancel_node(
        &mut self,
        tree_id: &SessionTreeId,
        node_id: &SessionNodeId,
    ) -> Result<Vec<GatewayEvent>, GatewayError> {
        if !self.workflow_runs.contains_key(tree_id) {
            return self.gateway.cancel_subtree(tree_id, node_id);
        }
        let mut run = self
            .workflow_runs
            .remove(tree_id)
            .ok_or_else(|| GatewayError::Invariant("managed workflow disappeared".to_owned()))?;
        let events = self.gateway.cancel_subtree(tree_id, node_id)?;
        for event in &events {
            self.observe_if_running(&mut run, &event.node_id, std::slice::from_ref(event))?;
        }
        self.drive_managed_workflow(tree_id, &mut run)?;
        self.workflow_runs.insert(tree_id.clone(), run);
        Ok(events)
    }

    fn poll_running_states(
        &mut self,
        tree_id: &SessionTreeId,
        run: &mut ManagedWorkflowRun,
    ) -> Result<(), GatewayError> {
        if run.finished {
            return Ok(());
        }
        let nodes = run.machine.running_nodes();
        for node_id in nodes {
            let events = self.gateway.execute(tree_id, &node_id, SessionCommand::Poll)?;
            self.observe_if_running(run, &node_id, &events)?;
            queue_events(run, events);
        }
        Ok(())
    }

    fn observe_if_running(
        &self,
        run: &mut ManagedWorkflowRun,
        node_id: &SessionNodeId,
        events: &[GatewayEvent],
    ) -> Result<(), GatewayError> {
        if !run
            .machine
            .running_nodes()
            .iter()
            .any(|running| running == node_id)
        {
            return Ok(());
        }
        let session_events = events
            .iter()
            .map(|event| event.event.clone())
            .collect::<Vec<_>>();
        run.machine.observe(node_id, &session_events)
    }

    fn drive_managed_workflow(
        &mut self,
        tree_id: &SessionTreeId,
        run: &mut ManagedWorkflowRun,
    ) -> Result<(), GatewayError> {
        if run.finished {
            return Ok(());
        }
        loop {
            let actions = run.machine.next_actions()?;
            if actions.is_empty() {
                return Ok(());
            }
            for action in actions {
                match action {
                    WorkflowAction::Invoke {
                        key,
                        role,
                        objective,
                        required: _,
                        context,
                    } => {
                        let node_id = self.gateway.attach_workflow_node(
                            tree_id,
                            &run.workflow_id,
                            &run.objective_id,
                            &run.root_node_id,
                            role,
                            Some(run.difficulty),
                            objective.clone(),
                        )?;
                        run.machine.bind_invoke(&key, node_id.clone())?;
                        let prompt = workflow_prompt(&objective, &context)?;
                        let events = self.gateway.execute(
                            tree_id,
                            &node_id,
                            SessionCommand::Prompt {
                                text: prompt,
                                images: Vec::new(),
                            },
                        )?;
                        self.observe_if_running(run, &node_id, &events)?;
                        queue_events(run, events);
                    }
                    WorkflowAction::Complete(terminal) => {
                        self.gateway.finish_workflow(
                            tree_id,
                            &run.workflow_id,
                            &run.objective_id,
                            terminal.success,
                        )?;
                        let snapshot = self.gateway.snapshot(tree_id)?;
                        let root = snapshot
                            .nodes
                            .iter()
                            .find(|node| node.id == run.root_node_id)
                            .ok_or_else(|| {
                                GatewayError::Invariant(
                                    "managed workflow root node is missing".to_owned(),
                                )
                            })?;
                        if let Some(session_id) = &root.downstream_session {
                            run.pending_events
                                .entry(run.root_node_id.clone())
                                .or_default()
                                .push_back(GatewayEvent {
                                    tree_id: tree_id.clone(),
                                    node_id: run.root_node_id.clone(),
                                    session_id: session_id.clone(),
                                    event: SessionEvent::Text {
                                        text: terminal.summary,
                                    },
                                });
                        }
                        run.finished = true;
                    }
                }
            }
            if run.finished || !run.machine.running_nodes().is_empty() {
                return Ok(());
            }
        }
    }

    fn decode<M: AcpMethod>(&self, request: &ExtRequest) -> Result<M::Params, ConductorError> {
        serde_json::from_str::<M::Params>(request.params.get()).map_err(|source| {
            ConductorError::Decode {
                method: M::METHOD,
                source,
            }
        })
    }

    fn dispatch<M, F>(
        &mut self,
        request: &ExtRequest,
        handler: F,
    ) -> Result<ExtResponse, ConductorError>
    where
        M: AcpMethod,
        F: FnOnce(&mut PhenixAcpGateway, M::Params) -> Result<M::Result, GatewayError>,
    {
        let params = self.decode::<M>(request)?;
        let result = handler(&mut self.gateway, params)?;
        encode_result(M::METHOD, &result)
    }
}

fn workflow_prompt(objective: &str, context: &serde_json::Value) -> Result<String, GatewayError> {
    let context = serde_json::to_string_pretty(context)
        .map_err(|error| GatewayError::workflow(format!("failed to encode workflow context: {error}")))?;
    Ok(format!(
        "{objective}\n\nPhenix workflow context follows. Treat supplied input and predecessor artifacts as authoritative; do not redo an upstream planning or classification step unless this state's objective explicitly asks for it. When the objective specifies a decision/status contract, return a JSON object matching it.\n\n```json\n{context}\n```"
    ))
}

fn queue_events(run: &mut ManagedWorkflowRun, events: Vec<GatewayEvent>) {
    for event in events {
        run.pending_events
            .entry(event.node_id.clone())
            .or_default()
            .push_back(event);
    }
}

fn drain_pending(run: &mut ManagedWorkflowRun, node_id: &SessionNodeId) -> Vec<GatewayEvent> {
    run.pending_events
        .get_mut(node_id)
        .map(|events| events.drain(..).collect())
        .unwrap_or_default()
}

fn route_role(
    gateway: &PhenixAcpGateway,
    params: &RoutingExplainParams,
) -> Result<RoleId, GatewayError> {
    if let Some(role) = &params.required_role {
        return Ok(role.clone());
    }
    let snapshot = gateway.snapshot(&params.tree_id)?;
    snapshot
        .nodes
        .into_iter()
        .find(|node| node.id == snapshot.root)
        .map(|node| node.role)
        .ok_or_else(|| GatewayError::Invariant("session tree root node is missing".to_owned()))
}

fn encode_result<T: Serialize>(
    method: &'static str,
    result: &T,
) -> Result<ExtResponse, ConductorError> {
    let result =
        to_raw_value(result).map_err(|source| ConductorError::Encode { method, source })?;
    Ok(ExtResponse::new(Arc::from(result)))
}

#[derive(Debug)]
pub enum ConductorError {
    UnknownMethod(String),
    Decode {
        method: &'static str,
        source: serde_json::Error,
    },
    Encode {
        method: &'static str,
        source: serde_json::Error,
    },
    Gateway(GatewayError),
}

impl From<GatewayError> for ConductorError {
    fn from(error: GatewayError) -> Self {
        Self::Gateway(error)
    }
}

impl Display for ConductorError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownMethod(method) => write!(formatter, "unknown Phenix ACP method {method}"),
            Self::Decode { method, source } => {
                write!(
                    formatter,
                    "invalid parameters for Phenix ACP method {method}: {source}"
                )
            }
            Self::Encode { method, source } => {
                write!(
                    formatter,
                    "failed to encode Phenix ACP result for {method}: {source}"
                )
            }
            Self::Gateway(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for ConductorError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Decode { source, .. } | Self::Encode { source, .. } => Some(source),
            Self::Gateway(error) => Some(error),
            Self::UnknownMethod(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        decode_extension_response, encode_extension_request, AcpEndpoint, AcpSession,
        AcpSessionFactory, AcpSessionId, BackendDefinition, BackendId, DefinitionId, FixedRouter,
        ModelConfig, ModelId, NodeExecuteParams, ProviderId, RouterId, SessionOpenRequest,
        SessionTreeCreateParams, SessionTreeDefinition, ThinkingLevel, WorkflowCondition,
        WorkflowGraphState, WorkflowJoin, WorkflowStateKind, WorkflowTransition,
    };
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct TestFactory {
        next: Arc<AtomicU64>,
        opens: Arc<Mutex<Vec<SessionOpenRequest>>>,
    }

    impl AcpSessionFactory for TestFactory {
        fn open(&self, request: SessionOpenRequest) -> Result<Box<dyn AcpSession>, GatewayError> {
            self.opens.lock().expect("opens").push(request);
            let sequence = self.next.fetch_add(1, Ordering::Relaxed) + 1;
            Ok(Box::new(TestSession {
                id: AcpSessionId::parse(format!("session-{sequence}"))
                    .map_err(|error| GatewayError::session(error.to_string()))?,
            }))
        }
    }

    struct TestSession {
        id: AcpSessionId,
    }

    impl AcpSession for TestSession {
        fn id(&self) -> &AcpSessionId {
            &self.id
        }

        fn execute(&mut self, command: SessionCommand) -> Result<Vec<SessionEvent>, GatewayError> {
            Ok(match command {
                SessionCommand::Prompt { text, .. } => {
                    let response = if text.contains("review the change") {
                        r#"{"decision":"accept"}"#.to_owned()
                    } else {
                        "done".to_owned()
                    };
                    vec![
                        SessionEvent::Text { text: response },
                        SessionEvent::Completed,
                    ]
                }
                SessionCommand::Cancel => vec![SessionEvent::Cancelled {
                    reason: "cancelled by test".to_owned(),
                }],
                _ => Vec::new(),
            })
        }
    }

    fn configured_conductor(
        workflows: Vec<WorkflowId>,
        graphs: BTreeMap<WorkflowId, WorkflowGraph>,
    ) -> (PhenixConductor, TestFactory) {
        let backend = BackendId::parse("test").expect("backend");
        let router = RouterId::parse("test.router").expect("router");
        let definition_id = DefinitionId::parse("test.definition").expect("definition");
        let mut definition = SessionTreeDefinition::builder(definition_id, router.clone())
            .backend(BackendDefinition::new(
                backend.clone(),
                AcpEndpoint::stdio("test-agent", Vec::new(), BTreeMap::new()).expect("endpoint"),
            ))
            .expect("backend definition");
        for workflow in workflows {
            definition = definition.workflow(workflow).expect("workflow");
        }
        let definition = definition.build().expect("tree definition");
        let model = ModelConfig {
            backend: backend.clone(),
            provider: ProviderId::parse("test-provider").expect("provider"),
            model: ModelId::parse("test-model").expect("model"),
            thinking: ThinkingLevel::Low,
        };
        let factory = TestFactory::default();
        let mut builder = PhenixAcpGateway::builder()
            .definition(definition)
            .expect("definition")
            .router(router, FixedRouter::new(model))
            .expect("router")
            .backend(backend, factory.clone())
            .expect("backend");
        for workflow in graphs.keys() {
            let plan = crate::WorkflowPlan::builder()
                .step(
                    "compat",
                    None::<String>,
                    RoleId::parse("implementer").expect("role"),
                    "compat",
                )
                .expect("step")
                .build()
                .expect("plan");
            builder = builder
                .workflow(workflow.clone(), crate::StaticWorkflow::new(plan).expect("workflow"))
                .expect("register workflow");
        }
        let gateway = builder.build().expect("gateway");
        (
            PhenixConductor::with_workflow_graphs(gateway, graphs),
            factory,
        )
    }

    fn create_tree(conductor: &mut PhenixConductor) -> crate::SessionTreeCreateResult {
        let create = encode_extension_request::<SessionTreeCreate>(&SessionTreeCreateParams {
            tree_id: None,
            definition_id: DefinitionId::parse("test.definition").expect("definition"),
            root_role: RoleId::parse("coordinator").expect("role"),
            difficulty: Difficulty::D1,
            objective: "coordinate the test".to_owned(),
        })
        .expect("create request");
        decode_extension_response::<SessionTreeCreate>(
            conductor.handle_extension(create).expect("create response"),
        )
        .expect("create result")
    }

    #[test]
    fn typed_extension_requests_drive_the_same_gateway_used_for_downstream_acp() {
        let (mut conductor, _) = configured_conductor(Vec::new(), BTreeMap::new());
        let created = create_tree(&mut conductor);
        let execute = encode_extension_request::<NodeExecute>(&NodeExecuteParams {
            tree_id: created.tree_id.clone(),
            node_id: created.root_node_id,
            command: SessionCommand::Prompt {
                text: "hello".to_owned(),
                images: Vec::new(),
            },
        })
        .expect("execute request");
        let executed = decode_extension_response::<NodeExecute>(
            conductor
                .handle_extension(execute)
                .expect("execute response"),
        )
        .expect("execute result");
        assert_eq!(executed.events.len(), 2);
        assert_eq!(conductor.gateway().list_trees().trees.len(), 1);
    }

    #[test]
    fn managed_workflow_skips_planner_when_caller_supplies_plan() {
        let workflow = WorkflowId::parse("workflow.implement").expect("workflow");
        let graph = WorkflowGraph {
            entry: "route-plan".to_owned(),
            states: vec![
                WorkflowGraphState {
                    key: "route-plan".to_owned(),
                    join: WorkflowJoin::Any,
                    required: false,
                    kind: WorkflowStateKind::Decision,
                },
                WorkflowGraphState {
                    key: "plan".to_owned(),
                    join: WorkflowJoin::Any,
                    required: true,
                    kind: WorkflowStateKind::Invoke {
                        role: RoleId::parse("planner").expect("role"),
                        objective: "plan the change".to_owned(),
                    },
                },
                WorkflowGraphState {
                    key: "implement".to_owned(),
                    join: WorkflowJoin::Any,
                    required: true,
                    kind: WorkflowStateKind::Invoke {
                        role: RoleId::parse("implementer").expect("role"),
                        objective: "implement the change".to_owned(),
                    },
                },
                WorkflowGraphState {
                    key: "return".to_owned(),
                    join: WorkflowJoin::Any,
                    required: false,
                    kind: WorkflowStateKind::Return {
                        summary: "done".to_owned(),
                    },
                },
            ],
            transitions: vec![
                WorkflowTransition {
                    from: "route-plan".to_owned(),
                    to: "plan".to_owned(),
                    when: WorkflowCondition::InputMissing {
                        path: "plan".to_owned(),
                    },
                },
                WorkflowTransition {
                    from: "route-plan".to_owned(),
                    to: "implement".to_owned(),
                    when: WorkflowCondition::InputExists {
                        path: "plan".to_owned(),
                    },
                },
                WorkflowTransition {
                    from: "plan".to_owned(),
                    to: "implement".to_owned(),
                    when: WorkflowCondition::Always,
                },
                WorkflowTransition {
                    from: "implement".to_owned(),
                    to: "return".to_owned(),
                    when: WorkflowCondition::Always,
                },
            ],
        };
        let (mut conductor, factory) = configured_conductor(
            vec![workflow.clone()],
            BTreeMap::from([(workflow.clone(), graph)]),
        );
        let created = create_tree(&mut conductor);
        let request = encode_extension_request::<WorkflowStart>(&WorkflowStartParams {
            tree_id: created.tree_id,
            workflow,
            difficulty: None,
            objective: "ship change".to_owned(),
            input: serde_json::json!({"plan": {"steps": ["edit", "test"]}}),
        })
        .expect("workflow start");
        conductor.handle_extension(request).expect("workflow response");
        let roles = factory
            .opens
            .lock()
            .expect("opens")
            .iter()
            .map(|request| request.role.as_str().to_owned())
            .collect::<Vec<_>>();
        assert!(roles.contains(&"coordinator".to_owned()));
        assert!(roles.contains(&"implementer".to_owned()));
        assert!(!roles.contains(&"planner".to_owned()));
    }
}
