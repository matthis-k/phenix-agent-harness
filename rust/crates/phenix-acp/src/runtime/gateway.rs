use super::{
    objective_terminal_state, AcpSession, AcpSessionFactory, GatewayError, GatewayEvent,
    RoutingDecision, RoutingRequest, SessionCommand, SessionOpenKind, SessionOpenRequest,
    SessionRouter, TreeStartResult, Workflow, WorkflowRequest,
};
use crate::{
    conductor_tool_catalog, AcpSessionId, BackendId, DefinitionId, Difficulty, ModelConfig,
    NodeTranscript, ObjectiveId, ObjectiveSnapshot, ObjectiveState, RoleId, RouterId,
    RoutingExplainResult, SessionNodeId, SessionNodeSnapshot, SessionNodeState,
    SessionTreeDefinition, SessionTreeId, SessionTreeListResult, SessionTreeSnapshot,
    SessionTreeSummary, ToolBinding, ToolInvoker, ToolProvision, WorkflowId, WorkflowStartResult,
};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

#[derive(Clone, Default)]
pub struct PhenixAcpGatewayBuilder {
    definitions: BTreeMap<DefinitionId, SessionTreeDefinition>,
    routers: BTreeMap<RouterId, Arc<dyn SessionRouter>>,
    workflows: BTreeMap<WorkflowId, Arc<dyn Workflow>>,
    backends: BTreeMap<BackendId, Arc<dyn AcpSessionFactory>>,
    tool_invoker: Option<Arc<dyn ToolInvoker>>,
    revision: u64,
}

impl PhenixAcpGatewayBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn definition(mut self, definition: SessionTreeDefinition) -> Result<Self, GatewayError> {
        let id = definition.definition_id().clone();
        if self.definitions.insert(id.clone(), definition).is_some() {
            return Err(GatewayError::DuplicateDefinition(id));
        }
        Ok(self)
    }

    pub fn router<R>(mut self, id: RouterId, router: R) -> Result<Self, GatewayError>
    where
        R: SessionRouter,
    {
        if self.routers.insert(id.clone(), Arc::new(router)).is_some() {
            return Err(GatewayError::DuplicateRouter(id));
        }
        Ok(self)
    }

    pub fn workflow<W>(mut self, id: WorkflowId, workflow: W) -> Result<Self, GatewayError>
    where
        W: Workflow,
    {
        if self
            .workflows
            .insert(id.clone(), Arc::new(workflow))
            .is_some()
        {
            return Err(GatewayError::DuplicateWorkflow(id));
        }
        Ok(self)
    }

    pub fn backend<F>(mut self, id: BackendId, backend: F) -> Result<Self, GatewayError>
    where
        F: AcpSessionFactory,
    {
        if self
            .backends
            .insert(id.clone(), Arc::new(backend))
            .is_some()
        {
            return Err(GatewayError::DuplicateBackend(id));
        }
        Ok(self)
    }

    pub fn tool_service(mut self, revision: u64, invoker: Arc<dyn ToolInvoker>) -> Self {
        self.revision = revision;
        self.tool_invoker = Some(invoker);
        self
    }

    pub fn build(self) -> Result<PhenixAcpGateway, GatewayError> {
        if self.definitions.is_empty() {
            return Err(GatewayError::MissingDefinitions);
        }
        for definition in self.definitions.values() {
            if !self.routers.contains_key(definition.router()) {
                return Err(GatewayError::MissingRouter(definition.router().clone()));
            }
            for workflow in definition.workflows() {
                if !self.workflows.contains_key(workflow) {
                    return Err(GatewayError::MissingWorkflow(workflow.clone()));
                }
            }
            for backend in definition.backends() {
                if !self.backends.contains_key(backend.id()) {
                    return Err(GatewayError::MissingBackend(backend.id().clone()));
                }
            }
        }
        Ok(PhenixAcpGateway {
            definitions: self.definitions,
            routers: self.routers,
            workflows: self.workflows,
            backends: self.backends,
            tool_invoker: self.tool_invoker,
            revision: self.revision,
            trees: BTreeMap::new(),
            next_tree: 1,
            next_node: 1,
            next_objective: 1,
        })
    }
}

pub struct PhenixAcpGateway {
    definitions: BTreeMap<DefinitionId, SessionTreeDefinition>,
    routers: BTreeMap<RouterId, Arc<dyn SessionRouter>>,
    workflows: BTreeMap<WorkflowId, Arc<dyn Workflow>>,
    backends: BTreeMap<BackendId, Arc<dyn AcpSessionFactory>>,
    tool_invoker: Option<Arc<dyn ToolInvoker>>,
    revision: u64,
    trees: BTreeMap<SessionTreeId, TreeRuntime>,
    next_tree: u64,
    next_node: u64,
    next_objective: u64,
}

impl PhenixAcpGateway {
    pub fn builder() -> PhenixAcpGatewayBuilder {
        PhenixAcpGatewayBuilder::new()
    }

    pub fn create_tree(
        &mut self,
        definition_id: &DefinitionId,
        root_role: RoleId,
        difficulty: Difficulty,
        objective: impl Into<String>,
    ) -> Result<TreeStartResult, GatewayError> {
        let tree_id = self.allocate_tree_id()?;
        self.create_tree_with_id(tree_id, definition_id, root_role, difficulty, objective)
    }

    pub fn create_tree_with_id(
        &mut self,
        tree_id: SessionTreeId,
        definition_id: &DefinitionId,
        root_role: RoleId,
        difficulty: Difficulty,
        objective: impl Into<String>,
    ) -> Result<TreeStartResult, GatewayError> {
        if self.trees.contains_key(&tree_id) {
            return Err(GatewayError::DuplicateTree(tree_id));
        }
        let objective = objective.into();
        let definition = self
            .definitions
            .get(definition_id)
            .cloned()
            .ok_or_else(|| GatewayError::UnknownDefinition(definition_id.clone()))?;
        let node_id = self.allocate_node_id()?;
        let objective_id = self.allocate_objective_id()?;
        let routing = self.route(
            &definition,
            RoutingRequest {
                tree_id: tree_id.clone(),
                parent_node: None,
                role: root_role.clone(),
                difficulty,
                objective: objective.clone(),
                workflow: None,
                available_backends: backend_ids(&definition),
            },
        )?;
        let request = SessionOpenRequest {
            tree_id: tree_id.clone(),
            node_id: node_id.clone(),
            role: root_role.clone(),
            difficulty,
            objective: objective.clone(),
            model: routing.model.clone(),
            open: SessionOpenKind::New { parent: None },
        };
        let mut session = self.open_session(&definition, request)?;
        if let Err(error) = self.ensure_unique_session(session.id(), &[]) {
            let _ = session.execute(SessionCommand::Close);
            return Err(error);
        }

        let mut objectives = BTreeMap::new();
        objectives.insert(
            objective_id.clone(),
            ObjectiveSnapshot {
                id: objective_id.clone(),
                parent: None,
                title: objective,
                state: ObjectiveState::WorkInProgress,
            },
        );
        let root = NodeRuntime {
            id: node_id.clone(),
            parent: None,
            role: root_role,
            difficulty,
            state: SessionNodeState::Running,
            model: routing.model,
            objective_id: objective_id.clone(),
            events: Vec::new(),
            session,
        };
        let mut nodes = BTreeMap::new();
        nodes.insert(node_id.clone(), root);
        self.trees.insert(
            tree_id.clone(),
            TreeRuntime {
                definition,
                root: node_id.clone(),
                nodes,
                objectives,
                active_workflow: None,
            },
        );
        Ok(TreeStartResult {
            tree_id,
            objective_id,
            root_node_id: node_id,
        })
    }

    pub fn start_workflow(
        &mut self,
        tree_id: &SessionTreeId,
        workflow_id: &WorkflowId,
        difficulty: Option<Difficulty>,
        objective: impl Into<String>,
    ) -> Result<WorkflowStartResult, GatewayError> {
        let objective = objective.into();
        let (definition, root_node, root_session, root_objective, root_difficulty) = {
            let tree = self.tree(tree_id)?;
            if !tree
                .definition
                .workflows()
                .any(|allowed| allowed == workflow_id)
            {
                return Err(GatewayError::WorkflowNotAllowed {
                    definition: tree.definition.definition_id().clone(),
                    workflow: workflow_id.clone(),
                });
            }
            let root = tree.nodes.get(&tree.root).ok_or_else(|| {
                GatewayError::Invariant("session tree root node is missing".to_owned())
            })?;
            (
                tree.definition.clone(),
                tree.root.clone(),
                root.session.id().clone(),
                root.objective_id.clone(),
                root.difficulty,
            )
        };
        let difficulty = difficulty.unwrap_or(root_difficulty);
        let workflow = self
            .workflows
            .get(workflow_id)
            .cloned()
            .ok_or_else(|| GatewayError::MissingWorkflow(workflow_id.clone()))?;
        let plan = workflow.plan(&WorkflowRequest {
            tree_id: tree_id.clone(),
            objective: objective.clone(),
        })?;
        plan.validate()?;

        let workflow_objective = self.allocate_objective_id()?;
        let mut prepared: Vec<PreparedNode> = Vec::with_capacity(plan.steps.len());
        let mut by_key: BTreeMap<String, (SessionNodeId, AcpSessionId, ObjectiveId)> =
            BTreeMap::new();

        for step in plan.steps {
            let (parent_node, parent_session, parent_objective) = match &step.parent {
                Some(parent) => by_key.get(parent).cloned().ok_or_else(|| {
                    GatewayError::InvalidWorkflowPlan(format!(
                        "workflow step {} refers to unknown parent {parent}",
                        step.key
                    ))
                })?,
                None => (
                    root_node.clone(),
                    root_session.clone(),
                    workflow_objective.clone(),
                ),
            };
            let node_id = self.allocate_node_id()?;
            let objective_id = self.allocate_objective_id()?;
            let routing = self.route(
                &definition,
                RoutingRequest {
                    tree_id: tree_id.clone(),
                    parent_node: Some(parent_node.clone()),
                    role: step.role.clone(),
                    difficulty,
                    objective: step.objective.clone(),
                    workflow: Some(workflow_id.clone()),
                    available_backends: backend_ids(&definition),
                },
            )?;
            let request = SessionOpenRequest {
                tree_id: tree_id.clone(),
                node_id: node_id.clone(),
                role: step.role.clone(),
                difficulty,
                objective: step.objective.clone(),
                model: routing.model.clone(),
                open: SessionOpenKind::New {
                    parent: Some(parent_session),
                },
            };
            let session = match self.open_session(&definition, request) {
                Ok(session) => session,
                Err(error) => {
                    close_prepared(&mut prepared);
                    return Err(error);
                }
            };
            if let Err(error) = self.ensure_unique_session(session.id(), &prepared) {
                let mut session = session;
                let _ = session.execute(SessionCommand::Close);
                close_prepared(&mut prepared);
                return Err(error);
            }
            let session_id = session.id().clone();
            by_key.insert(
                step.key,
                (node_id.clone(), session_id, objective_id.clone()),
            );
            prepared.push(PreparedNode {
                node: NodeRuntime {
                    id: node_id,
                    parent: Some(parent_node),
                    role: step.role,
                    difficulty,
                    state: SessionNodeState::Running,
                    model: routing.model,
                    objective_id: objective_id.clone(),
                    events: Vec::new(),
                    session,
                },
                objective: ObjectiveSnapshot {
                    id: objective_id,
                    parent: Some(parent_objective),
                    title: step.objective,
                    state: ObjectiveState::WorkInProgress,
                },
            });
        }

        let first_node = prepared
            .first()
            .map(|prepared| prepared.node.id.clone())
            .ok_or_else(|| {
                GatewayError::InvalidWorkflowPlan(
                    "workflow must contain at least one delegated session".to_owned(),
                )
            })?;
        let tree = self.tree_mut(tree_id)?;
        tree.objectives.insert(
            workflow_objective.clone(),
            ObjectiveSnapshot {
                id: workflow_objective.clone(),
                parent: Some(root_objective),
                title: objective,
                state: ObjectiveState::WorkInProgress,
            },
        );
        for prepared in prepared {
            tree.objectives
                .insert(prepared.objective.id.clone(), prepared.objective);
            tree.nodes.insert(prepared.node.id.clone(), prepared.node);
        }
        tree.active_workflow = Some(workflow_id.clone());
        Ok(WorkflowStartResult {
            objective_id: workflow_objective,
            root_node_id: first_node,
        })
    }

    pub fn delegate(
        &mut self,
        tree_id: &SessionTreeId,
        parent_node: &SessionNodeId,
        role: RoleId,
        difficulty: Option<Difficulty>,
        objective: impl Into<String>,
    ) -> Result<SessionNodeId, GatewayError> {
        self.attach_new_node(
            tree_id,
            parent_node,
            role,
            difficulty,
            objective.into(),
            AttachMode::New,
        )
    }

    pub fn load_session(
        &mut self,
        tree_id: &SessionTreeId,
        parent_node: &SessionNodeId,
        role: RoleId,
        difficulty: Option<Difficulty>,
        objective: impl Into<String>,
        session_id: AcpSessionId,
    ) -> Result<SessionNodeId, GatewayError> {
        self.attach_new_node(
            tree_id,
            parent_node,
            role,
            difficulty,
            objective.into(),
            AttachMode::Load(session_id),
        )
    }

    pub fn resume_session(
        &mut self,
        tree_id: &SessionTreeId,
        parent_node: &SessionNodeId,
        role: RoleId,
        difficulty: Option<Difficulty>,
        objective: impl Into<String>,
        session_id: AcpSessionId,
    ) -> Result<SessionNodeId, GatewayError> {
        self.attach_new_node(
            tree_id,
            parent_node,
            role,
            difficulty,
            objective.into(),
            AttachMode::Resume(session_id),
        )
    }

    pub fn fork_node(
        &mut self,
        tree_id: &SessionTreeId,
        node_id: &SessionNodeId,
        objective: impl Into<String>,
    ) -> Result<SessionNodeId, GatewayError> {
        let (role, difficulty, source_session) = {
            let node = self.node(tree_id, node_id)?;
            (
                node.role.clone(),
                node.difficulty,
                node.session.id().clone(),
            )
        };
        self.attach_new_node(
            tree_id,
            node_id,
            role,
            Some(difficulty),
            objective.into(),
            AttachMode::Fork(source_session),
        )
    }

    pub fn rename_node(
        &mut self,
        tree_id: &SessionTreeId,
        node_id: &SessionNodeId,
        name: impl Into<String>,
    ) -> Result<Vec<GatewayEvent>, GatewayError> {
        self.execute(
            tree_id,
            node_id,
            SessionCommand::Rename { name: name.into() },
        )
    }

    pub fn execute(
        &mut self,
        tree_id: &SessionTreeId,
        node_id: &SessionNodeId,
        command: SessionCommand,
    ) -> Result<Vec<GatewayEvent>, GatewayError> {
        let (session_id, objective_id, events) = {
            let node = self.node_mut(tree_id, node_id)?;
            let session_id = node.session.id().clone();
            let objective_id = node.objective_id.clone();
            let events = node.session.execute(command)?;
            node.events.extend(events.iter().cloned());
            for event in &events {
                match event {
                    super::SessionEvent::Completed => node.state = SessionNodeState::Completed,
                    super::SessionEvent::Failed { .. } => node.state = SessionNodeState::Failed,
                    super::SessionEvent::Cancelled { .. } => {
                        node.state = SessionNodeState::Cancelled
                    }
                    super::SessionEvent::Text { .. }
                    | super::SessionEvent::Thought { .. }
                    | super::SessionEvent::ToolStarted { .. }
                    | super::SessionEvent::ToolUpdated { .. }
                    | super::SessionEvent::ToolFinished { .. }
                    | super::SessionEvent::Terminal { .. }
                    | super::SessionEvent::PermissionRequested { .. }
                    | super::SessionEvent::QueueChanged { .. }
                    | super::SessionEvent::Compacted => {}
                }
            }
            (session_id, objective_id, events)
        };
        if let Some(state) = objective_terminal_state(&events) {
            let tree = self.tree_mut(tree_id)?;
            let objective = tree.objectives.get_mut(&objective_id).ok_or_else(|| {
                GatewayError::Invariant(format!("objective {objective_id} is missing"))
            })?;
            objective.state = state;
        }
        Ok(events
            .into_iter()
            .map(|event| GatewayEvent {
                tree_id: tree_id.clone(),
                node_id: node_id.clone(),
                session_id: session_id.clone(),
                event,
            })
            .collect())
    }

    pub fn cancel_subtree(
        &mut self,
        tree_id: &SessionTreeId,
        node_id: &SessionNodeId,
    ) -> Result<Vec<GatewayEvent>, GatewayError> {
        let mut descendants = {
            let tree = self.tree(tree_id)?;
            if !tree.nodes.contains_key(node_id) {
                return Err(GatewayError::UnknownNode(node_id.clone()));
            }
            tree.nodes
                .keys()
                .filter(|candidate| is_descendant(tree, candidate, node_id))
                .cloned()
                .collect::<Vec<_>>()
        };
        {
            let tree = self.tree(tree_id)?;
            descendants.sort_by_key(|candidate| depth(tree, candidate));
        }
        let mut emitted = Vec::new();
        for descendant in descendants.into_iter().rev() {
            emitted.extend(self.execute(tree_id, &descendant, SessionCommand::Cancel)?);
        }
        Ok(emitted)
    }

    pub fn close_tree(&mut self, tree_id: &SessionTreeId) -> Result<(), GatewayError> {
        let mut tree = self
            .trees
            .remove(tree_id)
            .ok_or_else(|| GatewayError::UnknownTree(tree_id.clone()))?;
        let mut node_ids = tree.nodes.keys().cloned().collect::<Vec<_>>();
        node_ids.sort_by_key(|node_id| depth(&tree, node_id));
        let mut first_error = None;
        for node_id in node_ids.into_iter().rev() {
            let Some(mut node) = tree.nodes.remove(&node_id) else {
                continue;
            };
            if let Err(error) = node.session.execute(SessionCommand::Close) {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    pub fn mark_objective(
        &mut self,
        tree_id: &SessionTreeId,
        objective_id: &ObjectiveId,
        state: ObjectiveState,
    ) -> Result<(), GatewayError> {
        let tree = self.tree_mut(tree_id)?;
        let objective = tree
            .objectives
            .get_mut(objective_id)
            .ok_or_else(|| GatewayError::UnknownObjective(objective_id.clone()))?;
        objective.state = state;
        Ok(())
    }

    pub fn snapshot(&self, tree_id: &SessionTreeId) -> Result<SessionTreeSnapshot, GatewayError> {
        Ok(self.tree(tree_id)?.snapshot(tree_id.clone()))
    }

    pub fn transcript(
        &self,
        tree_id: &SessionTreeId,
        node_id: &SessionNodeId,
    ) -> Result<NodeTranscript, GatewayError> {
        let node = self.node(tree_id, node_id)?;
        Ok(NodeTranscript {
            node_id: node.id.clone(),
            edited_paths: edited_paths(&node.events),
            events: node.events.clone(),
        })
    }

    pub fn list_trees(&self) -> SessionTreeListResult {
        SessionTreeListResult {
            trees: self
                .trees
                .iter()
                .map(|(tree_id, tree)| SessionTreeSummary {
                    tree_id: tree_id.clone(),
                    definition_id: tree.definition.definition_id().clone(),
                    root_session: tree
                        .nodes
                        .get(&tree.root)
                        .map(|node| node.session.id().clone()),
                })
                .collect(),
        }
    }

    pub fn explain_route(
        &self,
        tree_id: &SessionTreeId,
        objective: impl Into<String>,
        role: RoleId,
        difficulty: Difficulty,
    ) -> Result<RoutingExplainResult, GatewayError> {
        let tree = self.tree(tree_id)?;
        let decision = self.route(
            &tree.definition,
            RoutingRequest {
                tree_id: tree_id.clone(),
                parent_node: Some(tree.root.clone()),
                role,
                difficulty,
                objective: objective.into(),
                workflow: tree.active_workflow.clone(),
                available_backends: backend_ids(&tree.definition),
            },
        )?;
        Ok(RoutingExplainResult {
            router: tree.definition.router().clone(),
            difficulty: decision.difficulty,
            model: decision.model,
            explanation: decision.explanation,
        })
    }

    fn attach_new_node(
        &mut self,
        tree_id: &SessionTreeId,
        parent_node: &SessionNodeId,
        role: RoleId,
        difficulty: Option<Difficulty>,
        objective: String,
        mode: AttachMode,
    ) -> Result<SessionNodeId, GatewayError> {
        let (definition, parent_session, parent_objective, parent_difficulty) = {
            let tree = self.tree(tree_id)?;
            let parent = tree
                .nodes
                .get(parent_node)
                .ok_or_else(|| GatewayError::UnknownNode(parent_node.clone()))?;
            (
                tree.definition.clone(),
                parent.session.id().clone(),
                parent.objective_id.clone(),
                parent.difficulty,
            )
        };
        let difficulty = difficulty.unwrap_or(parent_difficulty);
        let node_id = self.allocate_node_id()?;
        let objective_id = self.allocate_objective_id()?;
        let routing = self.route(
            &definition,
            RoutingRequest {
                tree_id: tree_id.clone(),
                parent_node: Some(parent_node.clone()),
                role: role.clone(),
                difficulty,
                objective: objective.clone(),
                workflow: None,
                available_backends: backend_ids(&definition),
            },
        )?;
        let open = match mode {
            AttachMode::New => SessionOpenKind::New {
                parent: Some(parent_session),
            },
            AttachMode::Load(session_id) => SessionOpenKind::Load { session_id },
            AttachMode::Resume(session_id) => SessionOpenKind::Resume { session_id },
            AttachMode::Fork(session_id) => SessionOpenKind::Fork { session_id },
        };
        let request = SessionOpenRequest {
            tree_id: tree_id.clone(),
            node_id: node_id.clone(),
            role: role.clone(),
            difficulty,
            objective: objective.clone(),
            model: routing.model.clone(),
            open,
        };
        let mut session = self.open_session(&definition, request)?;
        if let Err(error) = self.ensure_unique_session(session.id(), &[]) {
            let _ = session.execute(SessionCommand::Close);
            return Err(error);
        }
        let tree = self.tree_mut(tree_id)?;
        tree.objectives.insert(
            objective_id.clone(),
            ObjectiveSnapshot {
                id: objective_id.clone(),
                parent: Some(parent_objective),
                title: objective,
                state: ObjectiveState::WorkInProgress,
            },
        );
        tree.nodes.insert(
            node_id.clone(),
            NodeRuntime {
                id: node_id.clone(),
                parent: Some(parent_node.clone()),
                role,
                difficulty,
                state: SessionNodeState::Running,
                model: routing.model,
                objective_id,
                events: Vec::new(),
                session,
            },
        );
        Ok(node_id)
    }

    fn route(
        &self,
        definition: &SessionTreeDefinition,
        request: RoutingRequest,
    ) -> Result<RoutingDecision, GatewayError> {
        let router = self
            .routers
            .get(definition.router())
            .ok_or_else(|| GatewayError::MissingRouter(definition.router().clone()))?;
        let decision = router.route(&request)?;
        if !definition
            .backends()
            .any(|backend| backend.id() == &decision.model.backend)
        {
            return Err(GatewayError::BackendNotAllowed {
                definition: definition.definition_id().clone(),
                backend: decision.model.backend,
            });
        }
        Ok(decision)
    }

    fn open_session(
        &self,
        definition: &SessionTreeDefinition,
        request: SessionOpenRequest,
    ) -> Result<Box<dyn AcpSession>, GatewayError> {
        let backend = request.model.backend.clone();
        let factory = self
            .backends
            .get(&backend)
            .ok_or(GatewayError::MissingBackend(backend))?;
        let binding = ToolBinding {
            revision: self.revision,
            tree_id: request.tree_id.clone(),
            caller_node: request.node_id.clone(),
            caller_role: request.role.clone(),
        };
        let tools = match &self.tool_invoker {
            Some(invoker) => {
                let descriptors = if matches!(request.open, SessionOpenKind::New { parent: None }) {
                    conductor_tool_catalog()
                } else {
                    Vec::new()
                };
                ToolProvision::new(
                    definition.tools().clone(),
                    descriptors,
                    binding,
                    Arc::clone(invoker),
                )
            }
            None => ToolProvision::without_model_tools(definition.tools().clone(), binding),
        };
        factory.open(request, tools)
    }

    fn ensure_unique_session(
        &self,
        session_id: &AcpSessionId,
        prepared: &[PreparedNode],
    ) -> Result<(), GatewayError> {
        if self.trees.values().any(|tree| {
            tree.nodes
                .values()
                .any(|node| node.session.id() == session_id)
        }) || prepared
            .iter()
            .any(|node| node.node.session.id() == session_id)
        {
            return Err(GatewayError::DuplicateSession(session_id.clone()));
        }
        Ok(())
    }

    fn tree(&self, id: &SessionTreeId) -> Result<&TreeRuntime, GatewayError> {
        self.trees
            .get(id)
            .ok_or_else(|| GatewayError::UnknownTree(id.clone()))
    }

    fn tree_mut(&mut self, id: &SessionTreeId) -> Result<&mut TreeRuntime, GatewayError> {
        self.trees
            .get_mut(id)
            .ok_or_else(|| GatewayError::UnknownTree(id.clone()))
    }

    fn node(
        &self,
        tree_id: &SessionTreeId,
        node_id: &SessionNodeId,
    ) -> Result<&NodeRuntime, GatewayError> {
        self.tree(tree_id)?
            .nodes
            .get(node_id)
            .ok_or_else(|| GatewayError::UnknownNode(node_id.clone()))
    }

    fn node_mut(
        &mut self,
        tree_id: &SessionTreeId,
        node_id: &SessionNodeId,
    ) -> Result<&mut NodeRuntime, GatewayError> {
        self.tree_mut(tree_id)?
            .nodes
            .get_mut(node_id)
            .ok_or_else(|| GatewayError::UnknownNode(node_id.clone()))
    }

    fn allocate_tree_id(&mut self) -> Result<SessionTreeId, GatewayError> {
        let sequence = self.next_tree;
        self.next_tree = self
            .next_tree
            .checked_add(1)
            .ok_or(GatewayError::IdentifierExhausted)?;
        SessionTreeId::parse(format!("tree-{sequence}"))
            .map_err(|error| GatewayError::Invariant(error.to_string()))
    }

    fn allocate_node_id(&mut self) -> Result<SessionNodeId, GatewayError> {
        let sequence = self.next_node;
        self.next_node = self
            .next_node
            .checked_add(1)
            .ok_or(GatewayError::IdentifierExhausted)?;
        SessionNodeId::parse(format!("node-{sequence}"))
            .map_err(|error| GatewayError::Invariant(error.to_string()))
    }

    fn allocate_objective_id(&mut self) -> Result<ObjectiveId, GatewayError> {
        let sequence = self.next_objective;
        self.next_objective = self
            .next_objective
            .checked_add(1)
            .ok_or(GatewayError::IdentifierExhausted)?;
        ObjectiveId::parse(format!("objective-{sequence}"))
            .map_err(|error| GatewayError::Invariant(error.to_string()))
    }
}

enum AttachMode {
    New,
    Load(AcpSessionId),
    Resume(AcpSessionId),
    Fork(AcpSessionId),
}

struct PreparedNode {
    node: NodeRuntime,
    objective: ObjectiveSnapshot,
}

fn close_prepared(prepared: &mut [PreparedNode]) {
    for prepared in prepared.iter_mut().rev() {
        let _ = prepared.node.session.execute(SessionCommand::Close);
    }
}

struct TreeRuntime {
    definition: SessionTreeDefinition,
    root: SessionNodeId,
    nodes: BTreeMap<SessionNodeId, NodeRuntime>,
    objectives: BTreeMap<ObjectiveId, ObjectiveSnapshot>,
    active_workflow: Option<WorkflowId>,
}

impl TreeRuntime {
    fn snapshot(&self, tree_id: SessionTreeId) -> SessionTreeSnapshot {
        SessionTreeSnapshot {
            id: tree_id,
            definition_id: self.definition.definition_id().clone(),
            root: self.root.clone(),
            nodes: self.nodes.values().map(NodeRuntime::snapshot).collect(),
            objectives: self.objectives.values().cloned().collect(),
            active_workflow: self.active_workflow.clone(),
        }
    }
}

struct NodeRuntime {
    id: SessionNodeId,
    parent: Option<SessionNodeId>,
    role: RoleId,
    difficulty: Difficulty,
    state: SessionNodeState,
    model: ModelConfig,
    objective_id: ObjectiveId,
    events: Vec<super::SessionEvent>,
    session: Box<dyn AcpSession>,
}

impl NodeRuntime {
    fn snapshot(&self) -> SessionNodeSnapshot {
        SessionNodeSnapshot {
            id: self.id.clone(),
            parent: self.parent.clone(),
            role: self.role.clone(),
            difficulty: self.difficulty,
            state: self.state.clone(),
            model: self.model.clone(),
            objective_id: self.objective_id.clone(),
            downstream_session: Some(self.session.id().clone()),
        }
    }
}

fn edited_paths(events: &[super::SessionEvent]) -> Vec<String> {
    let mut paths = BTreeSet::new();
    for event in events {
        let super::SessionEvent::ToolStarted {
            name,
            raw_input_json,
            ..
        } = event
        else {
            continue;
        };
        let name = name.to_ascii_lowercase();
        if !["write", "edit", "patch", "apply"]
            .iter()
            .any(|verb| name.contains(verb))
        {
            continue;
        }
        let Ok(input) = serde_json::from_str::<serde_json::Value>(raw_input_json) else {
            continue;
        };
        collect_paths(&input, &mut paths);
    }
    paths.into_iter().collect()
}

fn collect_paths(value: &serde_json::Value, paths: &mut BTreeSet<String>) {
    match value {
        serde_json::Value::Object(fields) => {
            for (key, value) in fields {
                if matches!(key.as_str(), "path" | "file_path" | "filepath" | "filename") {
                    if let Some(path) = value.as_str().filter(|path| !path.is_empty()) {
                        paths.insert(path.to_owned());
                    }
                }
                collect_paths(value, paths);
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                collect_paths(value, paths);
            }
        }
        _ => {}
    }
}

fn backend_ids(definition: &SessionTreeDefinition) -> Vec<BackendId> {
    definition
        .backends()
        .map(|backend| backend.id().clone())
        .collect()
}

fn is_descendant(tree: &TreeRuntime, candidate: &SessionNodeId, ancestor: &SessionNodeId) -> bool {
    let mut current = Some(candidate);
    while let Some(id) = current {
        if id == ancestor {
            return true;
        }
        current = tree.nodes.get(id).and_then(|node| node.parent.as_ref());
    }
    false
}

fn depth(tree: &TreeRuntime, node_id: &SessionNodeId) -> usize {
    let mut depth = 0;
    let mut current = tree
        .nodes
        .get(node_id)
        .and_then(|node| node.parent.as_ref());
    while let Some(parent) = current {
        depth += 1;
        current = tree.nodes.get(parent).and_then(|node| node.parent.as_ref());
    }
    depth
}
