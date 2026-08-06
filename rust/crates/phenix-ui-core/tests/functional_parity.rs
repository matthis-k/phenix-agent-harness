use phenix_runtime_api::{
    AuthFlowId, AuthMethod, AuthPromptResponse, BackendCommand, BackendHealth, ModelRef, RunId,
    RunKind, RunState, RunSummary, RuntimeSnapshot, SessionId, ThinkingLevel,
};
use phenix_ui_core::{reduce, AppEffect, AppEvent, AppState, UserIntent};

#[test]
fn model_and_thinking_selection_target_the_selected_run() {
    let run = RunId::parse("child-run").expect("run ID");
    let mut state = state_with_run(run.clone());
    let model = ModelRef {
        provider: "phenix".to_owned(),
        model: "free".to_owned(),
    };

    assert_send(
        reduce(
            &mut state,
            AppEvent::User(UserIntent::SelectModel(model.clone())),
        ),
        BackendCommand::ModelSelect {
            run_id: run.clone(),
            model,
        },
    );
    assert_send(
        reduce(
            &mut state,
            AppEvent::User(UserIntent::SelectThinking(ThinkingLevel::High)),
        ),
        BackendCommand::ThinkingSelect {
            run_id: run,
            level: ThinkingLevel::High,
        },
    );
}

#[test]
fn persisted_session_switching_does_not_reuse_run_identity() {
    let run = RunId::parse("root-run").expect("run ID");
    let session = SessionId::parse("persisted-session").expect("session ID");
    let mut state = state_with_run(run);

    assert_send(
        reduce(
            &mut state,
            AppEvent::User(UserIntent::SwitchSession(session.clone())),
        ),
        BackendCommand::SessionSwitch {
            session_id: session,
        },
    );
}

#[test]
fn authentication_flow_is_semantic_and_secret_responses_remain_redacted() {
    let mut state = AppState::default();
    assert_send(
        reduce(
            &mut state,
            AppEvent::User(UserIntent::StartAuthentication {
                provider_id: "example".to_owned(),
                method: AuthMethod::OAuth,
            }),
        ),
        BackendCommand::AuthLoginStart {
            provider_id: "example".to_owned(),
            method: AuthMethod::OAuth,
        },
    );

    let response =
        AuthPromptResponse::Secret(phenix_runtime_api::SecretValue::from_utf8("secret-value"));
    assert!(!format!("{response:?}").contains("secret-value"));
    let effects = reduce(
        &mut state,
        AppEvent::User(UserIntent::RespondToAuthentication {
            flow_id: AuthFlowId::parse("flow-1").expect("flow ID"),
            response,
        }),
    );
    assert!(matches!(
        effects.first(),
        Some(AppEffect::Send(BackendCommand::AuthLoginRespond { .. }))
    ));
}

#[test]
fn native_slash_commands_cover_runtime_controls() {
    let run = RunId::parse("root-run").expect("run ID");
    let cases = [
        (
            "/compact preserve decisions",
            BackendCommand::CompactionStart {
                run_id: run.clone(),
                instructions: Some("preserve decisions".to_owned()),
            },
        ),
        ("/reload", BackendCommand::ResourceReload),
        (
            "/abort",
            BackendCommand::ExecutionAbort {
                run_id: Some(run.clone()),
            },
        ),
        (
            "/thinking",
            BackendCommand::ThinkingLevels {
                run_id: run.clone(),
            },
        ),
    ];

    for (input, expected) in cases {
        let mut state = state_with_run(run.clone());
        state.input.replace(input.to_owned());
        assert_send(
            reduce(&mut state, AppEvent::User(UserIntent::SubmitPrompt)),
            expected,
        );
    }
}

#[test]
fn unknown_slash_commands_are_forwarded_unchanged_to_acp() {
    let run = RunId::parse("root-run").expect("run ID");
    let mut state = state_with_run(run.clone());
    state.input.replace("/phenix status".to_owned());

    assert_send(
        reduce(&mut state, AppEvent::User(UserIntent::SubmitPrompt)),
        BackendCommand::PromptSubmit {
            run_id: run,
            text: "/phenix status".to_owned(),
            images: Vec::new(),
            streaming_behavior: None,
        },
    );
}

fn assert_send(effects: Vec<AppEffect>, expected: BackendCommand) {
    assert!(effects
        .iter()
        .any(|effect| matches!(effect, AppEffect::Send(command) if command == &expected)));
}

fn state_with_run(run: RunId) -> AppState {
    let mut state = AppState::default();
    state.root_run = Some(run.clone());
    state.selected_run = Some(run.clone());
    state.snapshot = Some(RuntimeSnapshot {
        capabilities: Default::default(),
        health: BackendHealth::Ready,
        active_session: None,
        root_run: Some(run.clone()),
        selected_run: Some(run.clone()),
        sessions: Vec::new(),
        runs: vec![RunSummary {
            id: run,
            parent: None,
            kind: RunKind::Root,
            definition_id: "root.session".to_owned(),
            display_name: "Root".to_owned(),
            state: RunState::Running,
            persisted_session: None,
            session_file: None,
            model: None,
            thinking_level: None,
            difficulty: None,
            budget: None,
            pending_messages: 0,
            outcome: None,
        }],
        objectives: Vec::new(),
    });
    state
}
