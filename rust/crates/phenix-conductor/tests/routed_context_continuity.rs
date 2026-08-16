#[path = "support/protocol_harness.rs"]
mod protocol_harness;

use phenix_conductor::{ConductorRuntime, ConductorServer};
use phenix_core::{ExecutionTarget, RoutingProfile, RoutingProfileId, SessionId};
use phenix_protocol::{ClientMessage, Command};
use protocol_harness::{backend_id, model_target, MockBackend, MockBackendState, MockModelScript};
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

fn route(id: &str, model: &str) -> RoutingProfile {
    RoutingProfile {
        id: RoutingProfileId::parse(id).unwrap(),
        default_target: model_target(model),
        callable_targets: BTreeMap::new(),
    }
}

fn assert_replayed_alpha(prompt: &str, current: &str) {
    assert!(prompt.contains(
        r#"[{"role":"user","content":"remember alpha"},{"role":"assistant","content":"alpha acknowledged"}]"#
    ));
    assert!(prompt.contains(&format!("Current user message:\n{current}")));
}

#[test]
fn routed_turn_replays_prior_conversation_after_model_route_changes() {
    let route_a = RoutingProfileId::parse("route-a").unwrap();
    let route_b = RoutingProfileId::parse("route-b").unwrap();
    let mut runtime = ConductorRuntime::new();
    runtime
        .register_routing_profile(route("route-a", "model-a"))
        .unwrap();
    runtime
        .register_routing_profile(route("route-b", "model-b"))
        .unwrap();

    let state = Arc::new(MockBackendState::default());
    let backend = MockBackend::new(state.clone(), MockModelScript::reply("alpha acknowledged"));
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
    assert_replayed_alpha(&prompts[1], "what did I say?");
}

#[test]
fn routed_context_is_reconstructed_from_the_journal_after_runtime_restore() {
    let route_a = RoutingProfileId::parse("route-a").unwrap();
    let route_b = RoutingProfileId::parse("route-b").unwrap();
    let mut runtime = ConductorRuntime::new();
    runtime
        .register_routing_profile(route("route-a", "model-a"))
        .unwrap();
    runtime
        .register_routing_profile(route("route-b", "model-b"))
        .unwrap();

    let first_state = Arc::new(MockBackendState::default());
    let first_backend = MockBackend::new(
        first_state.clone(),
        MockModelScript::reply("alpha acknowledged"),
    );
    let mut first_server = ConductorServer::new(runtime);
    first_server
        .register_backend(backend_id(), Box::new(first_backend))
        .unwrap();

    let mut first_output = Vec::new();
    first_server
        .serve_ndjson(
            Cursor::new(encode([
                ClientMessage {
                    id: 1,
                    command: Command::CreateSession {
                        parent_session: None,
                        name: Some("routed restart".to_owned()),
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
    assert_eq!(first_state.prompts(), ["remember alpha"]);

    let mut retarget_output = Vec::new();
    first_server
        .serve_ndjson(
            Cursor::new(encode([ClientMessage {
                id: 3,
                command: Command::SetSessionTarget {
                    session_id: SessionId::parse("session-1").unwrap(),
                    target: ExecutionTarget::Routed(route_b),
                },
            }])),
            &mut retarget_output,
        )
        .unwrap();

    let journal = first_server.runtime().journal().clone();
    let journal_json = serde_json::to_string(&journal).unwrap();
    assert!(journal_json.contains("remember alpha"));
    assert!(!journal_json.contains("Continue the same Phenix conversation"));
    drop(first_server);

    let mut restored = ConductorRuntime::restore(journal).unwrap();
    restored
        .register_routing_profile(route("route-b", "model-b"))
        .unwrap();

    let restored_state = Arc::new(MockBackendState::default());
    let restored_backend = MockBackend::new(
        restored_state.clone(),
        MockModelScript::reply("restored answer"),
    );
    let mut restored_server = ConductorServer::new(restored);
    restored_server
        .register_backend(backend_id(), Box::new(restored_backend))
        .unwrap();

    let mut restored_output = Vec::new();
    restored_server
        .serve_ndjson(
            Cursor::new(encode([ClientMessage {
                id: 4,
                command: Command::Submit {
                    session_id: SessionId::parse("session-1").unwrap(),
                    text: "after restart".to_owned(),
                },
            }])),
            &mut restored_output,
        )
        .unwrap();

    let opens = restored_state.opens();
    assert_eq!(opens.len(), 1);
    assert_eq!(opens[0].model.model.as_str(), "model-b");
    let prompts = restored_state.prompts();
    assert_eq!(prompts.len(), 1);
    assert_replayed_alpha(&prompts[0], "after restart");
}
