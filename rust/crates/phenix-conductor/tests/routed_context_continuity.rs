#[path = "support/protocol_harness.rs"]
mod protocol_harness;

use phenix_conductor::{ConductorRuntime, ConductorServer};
use phenix_core::{ExecutionTarget, RoutingProfile, RoutingProfileId, SessionId};
use phenix_protocol::{ClientMessage, Command};
use protocol_harness::{
    backend_id, model_target, MockBackend, MockBackendState, MockModelScript,
};
use std::collections::BTreeMap;
use std::io::Cursor;
use std::sync::Arc;

fn encode(messages: impl IntoIterator<Item = ClientMessage>) -> Vec<u8> {
    messages
        .into_iter()
        .map(|message| format!("{}\n", serde_json::to_string(&message).unwrap()))
        .collect::<String>()
        .into_bytes()
}

#[test]
fn routed_turn_replays_prior_conversation_after_model_route_changes() {
    let route_a = RoutingProfileId::parse("route-a").unwrap();
    let route_b = RoutingProfileId::parse("route-b").unwrap();
    let mut runtime = ConductorRuntime::new();
    runtime
        .register_routing_profile(RoutingProfile {
            id: route_a.clone(),
            default_target: model_target("model-a"),
            callable_targets: BTreeMap::new(),
        })
        .unwrap();
    runtime
        .register_routing_profile(RoutingProfile {
            id: route_b.clone(),
            default_target: model_target("model-b"),
            callable_targets: BTreeMap::new(),
        })
        .unwrap();

    let state = Arc::new(MockBackendState::default());
    let backend = MockBackend::new(
        state.clone(),
        MockModelScript::reply("alpha acknowledged"),
    );
    let mut server = ConductorServer::new(runtime);
    server
        .register_backend(backend_id(), Box::new(backend))
        .unwrap();

    let mut first_output = Vec::new();
    server
        .serve_ndjson(
            Cursor::new(encode([
                ClientMessage {
                    id: 1,
                    command: Command::CreateSession {
                        parent_session: None,
                        name: Some("routed".to_owned()),
                        target: ExecutionTarget::Routed(route_a),
                    },
                },
                ClientMessage {
                    id: 2,
                    command: Command::Submit {
                        session_id: SessionId::parse("session-1").unwrap(),
                        text: "remember alpha".to_owned(),
                    },
                },
            ])),
            &mut first_output,
        )
        .unwrap();

    assert_eq!(state.prompts(), ["remember alpha"]);

    let mut second_output = Vec::new();
    server
        .serve_ndjson(
            Cursor::new(encode([
                ClientMessage {
                    id: 3,
                    command: Command::SetSessionTarget {
                        session_id: SessionId::parse("session-1").unwrap(),
                        target: ExecutionTarget::Routed(route_b),
                    },
                },
                ClientMessage {
                    id: 4,
                    command: Command::Submit {
                        session_id: SessionId::parse("session-1").unwrap(),
                        text: "what did I say?".to_owned(),
                    },
                },
            ])),
            &mut second_output,
        )
        .unwrap();

    let opens = state.opens();
    assert_eq!(opens.len(), 2);
    assert_eq!(opens[0].model.model.as_str(), "model-a");
    assert_eq!(opens[1].model.model.as_str(), "model-b");

    let prompts = state.prompts();
    assert_eq!(prompts.len(), 2);
    assert_eq!(prompts[0], "remember alpha");
    assert!(prompts[1].contains(
        r#"[{"role":"user","content":"remember alpha"},{"role":"assistant","content":"alpha acknowledged"}]"#
    ));
    assert!(prompts[1].contains("Current user message:\nwhat did I say?"));
}
