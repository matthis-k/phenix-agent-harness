use phenix_acp::{
    AcpEndpoint, AcpSession, AcpSessionFactory, AcpSessionId, BackendDefinition, BackendId,
    DefinitionId, Difficulty, FixedRouter, GatewayError, ModelConfig, ModelId, PhenixAcpGateway,
    ProviderId, RoleId, RouterId, SessionCommand, SessionEvent, SessionOpenRequest,
    SessionTreeDefinition, ThinkingLevel,
};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[derive(Clone, Default)]
struct TestFactory {
    next: Arc<AtomicU64>,
}

impl AcpSessionFactory for TestFactory {
    fn open(
        &self,
        _request: SessionOpenRequest,
        _tools: phenix_acp::ToolProvision,
    ) -> Result<Box<dyn AcpSession>, GatewayError> {
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
            SessionCommand::Prompt { text, .. } => vec![
                SessionEvent::Text {
                    text: format!("reply:{text}"),
                },
                SessionEvent::Completed,
            ],
            SessionCommand::Cancel => vec![SessionEvent::Cancelled {
                reason: "cancelled by test".to_owned(),
            }],
            _ => Vec::new(),
        })
    }
}

#[test]
fn completed_turn_does_not_close_the_conversation_session() {
    let backend = BackendId::parse("test").expect("backend");
    let router = RouterId::parse("test.router").expect("router");
    let definition_id = DefinitionId::parse("test.definition").expect("definition");
    let definition = SessionTreeDefinition::builder(definition_id.clone(), router.clone())
        .backend(BackendDefinition::new(
            backend.clone(),
            AcpEndpoint::stdio("test-agent", Vec::new(), BTreeMap::new()).expect("endpoint"),
        ))
        .expect("backend definition")
        .build()
        .expect("tree definition");
    let model = ModelConfig {
        backend: backend.clone(),
        provider: ProviderId::parse("test-provider").expect("provider"),
        model: ModelId::parse("test-model").expect("model"),
        thinking: ThinkingLevel::Medium,
    };
    let mut gateway = PhenixAcpGateway::builder()
        .definition(definition)
        .expect("definition")
        .router(router, FixedRouter::new(model))
        .expect("router")
        .backend(backend, TestFactory::default())
        .expect("backend")
        .build()
        .expect("gateway");

    let tree = gateway
        .create_tree(
            &definition_id,
            RoleId::parse("coordinator").expect("role"),
            Difficulty::D2,
            "interactive conversation",
        )
        .expect("tree");

    for (prompt, expected) in [("first", "reply:first"), ("second", "reply:second")] {
        let events = gateway
            .execute(
                &tree.tree_id,
                &tree.root_node_id,
                SessionCommand::Prompt {
                    text: prompt.to_owned(),
                    images: Vec::new(),
                },
            )
            .expect("prompt remains valid after the previous turn completed");
        assert!(events.iter().any(|event| matches!(
            &event.event,
            SessionEvent::Text { text } if text == expected
        )));
        assert!(events
            .iter()
            .any(|event| matches!(&event.event, SessionEvent::Completed)));
    }

    let snapshot = gateway.snapshot(&tree.tree_id).expect("tree remains alive");
    assert_eq!(snapshot.root, tree.root_node_id);
    assert_eq!(gateway.list_trees().trees.len(), 1);
}
