use super::*;
use crate::{
    AcpEndpoint, AcpSessionId, BackendDefinition, BackendId, DefinitionId, Difficulty, IdError,
    ModelConfig, ModelId, ProviderId, RoleId, RouterId, SessionTreeDefinition, ThinkingLevel,
    WorkflowId,
};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct RecordingFactory {
    next: Arc<AtomicU64>,
    opens: Arc<Mutex<Vec<SessionOpenRequest>>>,
    commands: Arc<Mutex<Vec<(AcpSessionId, SessionCommand)>>>,
}

impl RecordingFactory {
    fn new() -> Self {
        Self {
            next: Arc::new(AtomicU64::new(1)),
            opens: Arc::new(Mutex::new(Vec::new())),
            commands: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl AcpSessionFactory for RecordingFactory {
    fn open(&self, request: SessionOpenRequest) -> Result<Box<dyn AcpSession>, GatewayError> {
        self.opens.lock().expect("open log").push(request);
        let sequence = self.next.fetch_add(1, Ordering::Relaxed);
        let id = AcpSessionId::parse(format!("acp-session-{sequence}"))
            .map_err(|error| GatewayError::session(error.to_string()))?;
        Ok(Box::new(RecordingSession {
            id,
            commands: Arc::clone(&self.commands),
        }))
    }
}

struct RecordingSession {
    id: AcpSessionId,
    commands: Arc<Mutex<Vec<(AcpSessionId, SessionCommand)>>>,
}

impl AcpSession for RecordingSession {
    fn id(&self) -> &AcpSessionId {
        &self.id
    }

    fn execute(&mut self, command: SessionCommand) -> Result<Vec<SessionEvent>, GatewayError> {
        self.commands
            .lock()
            .expect("command log")
            .push((self.id.clone(), command.clone()));
        let events = match command {
            SessionCommand::Prompt { text, .. } => {
                vec![SessionEvent::Text { text }, SessionEvent::Completed]
            }
            SessionCommand::Steer { text, .. } => vec![SessionEvent::QueueChanged {
                steering: vec![text],
                follow_ups: Vec::new(),
            }],
            SessionCommand::FollowUp { text, .. } => vec![SessionEvent::QueueChanged {
                steering: Vec::new(),
                follow_ups: vec![text],
            }],
            SessionCommand::Compact { .. } => vec![SessionEvent::Compacted],
            SessionCommand::Poll => Vec::new(),
            SessionCommand::Cancel => vec![SessionEvent::Cancelled {
                reason: "cancelled by test".to_owned(),
            }],
            SessionCommand::Rename { .. }
            | SessionCommand::SetModel { .. }
            | SessionCommand::SetMode { .. }
            | SessionCommand::SetThinking { .. }
            | SessionCommand::Invoke { .. }
            | SessionCommand::RespondInteraction { .. }
            | SessionCommand::Close => Vec::new(),
        };
        Ok(events)
    }
}

fn id<T>(value: &str, parse: impl FnOnce(String) -> Result<T, IdError>) -> T {
    parse(value.to_owned()).expect("valid test ID")
}

fn backend_id() -> BackendId {
    id("pi", BackendId::parse)
}

fn router_id() -> RouterId {
    id("phenix.router", RouterId::parse)
}

fn workflow_id() -> WorkflowId {
    id("phenix.workflow", WorkflowId::parse)
}

fn definition_id() -> DefinitionId {
    id("phenix.standard", DefinitionId::parse)
}

fn model_config() -> ModelConfig {
    ModelConfig {
        backend: backend_id(),
        provider: ProviderId::parse("test-provider").expect("provider"),
        model: ModelId::parse("test-model").expect("model"),
        thinking: ThinkingLevel::Medium,
    }
}

fn definition() -> SessionTreeDefinition {
    SessionTreeDefinition::builder(definition_id(), router_id())
        .backend(BackendDefinition::new(
            backend_id(),
            AcpEndpoint::stdio("pi-acp", Vec::new(), BTreeMap::new()).expect("test endpoint"),
        ))
        .expect("backend")
        .workflow(workflow_id())
        .expect("workflow")
        .build()
        .expect("definition")
}

fn workflow() -> StaticWorkflow {
    let plan = WorkflowPlan::builder()
        .step(
            "implement",
            None::<String>,
            RoleId::parse("implementer").expect("role"),
            "Implement the requested change",
        )
        .expect("implement step")
        .step(
            "verify",
            Some("implement"),
            RoleId::parse("verifier").expect("role"),
            "Verify the implementation",
        )
        .expect("verify step")
        .build()
        .expect("workflow plan");
    StaticWorkflow::new(plan).expect("static workflow")
}

fn gateway(factory: RecordingFactory) -> PhenixAcpGateway {
    PhenixAcpGateway::builder()
        .definition(definition())
        .expect("definition")
        .router(router_id(), FixedRouter::new(model_config()))
        .expect("router")
        .workflow(workflow_id(), workflow())
        .expect("workflow")
        .backend(backend_id(), factory)
        .expect("backend")
        .build()
        .expect("gateway")
}

#[test]
fn build_rejects_unbound_executable_policy() {
    let error = PhenixAcpGateway::builder()
        .definition(definition())
        .expect("definition")
        .build()
        .err()
        .expect("missing router must fail");
    assert_eq!(error, GatewayError::MissingRouter(router_id()));
}

#[test]
fn separately_configured_trees_own_distinct_downstream_sessions() {
    let factory = RecordingFactory::new();
    let mut gateway = gateway(factory.clone());
    let first = gateway
        .create_tree(
            &definition_id(),
            RoleId::parse("root").expect("role"),
            Difficulty::D1,
            "first objective",
        )
        .expect("first tree");
    let second = gateway
        .create_tree(
            &definition_id(),
            RoleId::parse("root").expect("role"),
            Difficulty::D3,
            "second objective",
        )
        .expect("second tree");

    assert_ne!(first.root_node_id, second.root_node_id);
    assert_ne!(first.tree_id, second.tree_id);
    let trees = gateway.list_trees();
    assert_eq!(trees.trees.len(), 2);
    assert_ne!(trees.trees[0].root_session, trees.trees[1].root_session);
    assert_eq!(factory.opens.lock().expect("open log").len(), 2);
}

#[test]
fn workflow_plan_becomes_recursive_nodes_objectives_and_acp_sessions() {
    let factory = RecordingFactory::new();
    let mut gateway = gateway(factory.clone());
    let root = gateway
        .create_tree(
            &definition_id(),
            RoleId::parse("root").expect("role"),
            Difficulty::D2,
            "ship ACP",
        )
        .expect("tree");
    let started = gateway
        .start_workflow(&root.tree_id, &workflow_id(), None, "implement and verify")
        .expect("workflow");
    let snapshot = gateway.snapshot(&root.tree_id).expect("snapshot");

    assert_eq!(snapshot.nodes.len(), 3);
    assert_eq!(snapshot.objectives.len(), 4);
    let implement = snapshot
        .nodes
        .iter()
        .find(|node| node.id == started.root_node_id)
        .expect("implement node");
    assert_eq!(implement.parent, Some(root.root_node_id));
    assert_eq!(implement.difficulty, Difficulty::D2);
    let verify = snapshot
        .nodes
        .iter()
        .find(|node| node.role.as_str() == "verifier")
        .expect("verify node");
    assert_eq!(verify.parent, Some(implement.id.clone()));
    assert_eq!(verify.model, model_config());
    assert!(snapshot
        .nodes
        .iter()
        .all(|node| node.downstream_session.is_some()));

    let opens = factory.opens.lock().expect("open log");
    assert_eq!(opens.len(), 3);
    assert!(matches!(
        &opens[1].open,
        SessionOpenKind::New { parent: Some(_) }
    ));
    assert!(matches!(
        &opens[2].open,
        SessionOpenKind::New { parent: Some(_) }
    ));
}

#[test]
fn persistent_session_operations_are_explicit_open_modes() {
    let factory = RecordingFactory::new();
    let mut gateway = gateway(factory.clone());
    let root = gateway
        .create_tree(
            &definition_id(),
            RoleId::parse("root").expect("role"),
            Difficulty::D2,
            "persistent sessions",
        )
        .expect("tree");
    let persistent = AcpSessionId::parse("persisted-1").expect("session ID");
    gateway
        .load_session(
            &root.tree_id,
            &root.root_node_id,
            RoleId::parse("loader").expect("role"),
            None,
            "load",
            persistent.clone(),
        )
        .expect("load");
    gateway
        .resume_session(
            &root.tree_id,
            &root.root_node_id,
            RoleId::parse("resumer").expect("role"),
            Some(Difficulty::D4),
            "resume",
            persistent,
        )
        .expect("resume");
    gateway
        .fork_node(&root.tree_id, &root.root_node_id, "fork")
        .expect("fork");

    let opens = factory.opens.lock().expect("open log");
    assert!(matches!(&opens[1].open, SessionOpenKind::Load { .. }));
    assert_eq!(opens[1].difficulty, Difficulty::D2);
    assert!(matches!(&opens[2].open, SessionOpenKind::Resume { .. }));
    assert_eq!(opens[2].difficulty, Difficulty::D4);
    assert!(matches!(&opens[3].open, SessionOpenKind::Fork { .. }));
    assert_eq!(opens[3].difficulty, Difficulty::D2);
}

#[test]
fn live_session_controls_and_images_are_routed_to_the_selected_node() {
    let factory = RecordingFactory::new();
    let mut gateway = gateway(factory.clone());
    let root = gateway
        .create_tree(
            &definition_id(),
            RoleId::parse("root").expect("role"),
            Difficulty::D2,
            "exercise session controls",
        )
        .expect("tree");
    let events = gateway
        .execute(
            &root.tree_id,
            &root.root_node_id,
            SessionCommand::Prompt {
                text: "inspect image".to_owned(),
                images: vec![SessionImage {
                    media_type: "image/png".to_owned(),
                    data: vec![1, 2, 3],
                }],
            },
        )
        .expect("prompt");
    assert!(matches!(
        events.last().map(|event| &event.event),
        Some(SessionEvent::Completed)
    ));
    gateway
        .execute(
            &root.tree_id,
            &root.root_node_id,
            SessionCommand::Steer {
                text: "focus on types".to_owned(),
                images: Vec::new(),
            },
        )
        .expect("steer");
    gateway
        .execute(
            &root.tree_id,
            &root.root_node_id,
            SessionCommand::FollowUp {
                text: "run tests".to_owned(),
                images: Vec::new(),
            },
        )
        .expect("follow-up");
    gateway
        .execute(
            &root.tree_id,
            &root.root_node_id,
            SessionCommand::Compact { instructions: None },
        )
        .expect("compact");

    let commands = factory.commands.lock().expect("command log");
    assert!(commands.iter().any(
        |(_, command)| matches!(command, SessionCommand::Prompt { images, .. } if images.len() == 1)
    ));
    assert!(commands
        .iter()
        .any(|(_, command)| matches!(command, SessionCommand::Steer { .. })));
    assert!(commands
        .iter()
        .any(|(_, command)| matches!(command, SessionCommand::FollowUp { .. })));
    assert!(commands
        .iter()
        .any(|(_, command)| matches!(command, SessionCommand::Compact { .. })));
}
