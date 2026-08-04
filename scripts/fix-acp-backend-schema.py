from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old in text:
        file.write_text(text.replace(old, new, 1))
    elif new not in text:
        raise RuntimeError(f"missing schema-fix anchor in {file}: {old}")


state = "rust/crates/phenix-acp-backend/src/state.rs"
replace_once(
    state,
    "    AgentCapabilities, AuthMethod as AcpAuthMethod, AvailableCommand, InitializeResponse,",
    "    AuthMethod as AcpAuthMethod, AvailableCommand, InitializeResponse,",
)
replace_once(
    state,
    "                    methods: vec![FrontendAuthMethod::ApiKey],",
    "                    methods: vec![FrontendAuthMethod::Terminal],",
)
replace_once(
    state,
    "            api_keys: initialize\n                .auth_methods\n                .iter()\n                .any(|method| matches!(method, AcpAuthMethod::Terminal(_))),\n            device_code: false,",
    "            api_keys: false,\n            terminal: initialize\n                .auth_methods\n                .iter()\n                .any(|method| matches!(method, AcpAuthMethod::Terminal(_))),\n            device_code: false,",
)
replace_once(
    state,
    "fn model_ref(value: String) -> ModelRef {\n    let (provider, model) = value.split_once('/').map_or_else(\n        || (\"acp\".to_owned(), value),\n        |(provider, model)| (provider.to_owned(), model.to_owned()),\n    );\n    ModelRef { provider, model }\n}",
    "fn model_ref(value: String) -> ModelRef {\n    let (provider, model) = match value.split_once('/') {\n        Some((provider, model)) => (provider.to_owned(), model.to_owned()),\n        None => (\"acp\".to_owned(), value),\n    };\n    ModelRef { provider, model }\n}",
)

lib = "rust/crates/phenix-acp-backend/src/lib.rs"
replace_once(
    lib,
    "    ClientSessionCapabilities, CloseSessionRequest, CreateTerminalRequest, ForkSessionRequest,\n    ImageContent, InitializeRequest, KillTerminalRequest, ListSessionsRequest, LoadSessionRequest,",
    "    ClientSessionCapabilities, ContentBlock, CreateTerminalRequest, ForkSessionRequest,\n    ImageContent, InitializeRequest, KillTerminalRequest, ListSessionsRequest, LoadSessionRequest,",
)
replace_once(
    lib,
    "    SetSessionConfigOptionRequest, SetSessionModeRequest, TerminalOutputRequest,\n    WaitForTerminalExitRequest,",
    "    SetSessionConfigOptionRequest, SetSessionModeRequest, TerminalOutputRequest, TextContent,\n    WaitForTerminalExitRequest,",
)
replace_once(
    lib,
    "    BackendReply, BackendRequest, CommandSummary, ExternalCommand, NotificationLevel,",
    "    BackendReply, BackendRequest, CommandSource, CommandSummary, ExternalCommand, NotificationLevel,",
)
replace_once(
    lib,
    "                    source: Some(\"ACP\".to_owned()),",
    "                    source: CommandSource::BuiltIn,",
)
replace_once(
    lib,
    "                session.run.pending_messages = session.follow_ups.len();\n                outputs.event(BackendEvent::MessageQueueChanged {\n                    run_id: session.run.id.clone(),\n                    pending: session.follow_ups.len(),\n                })?;\n                session\n                    .follow_ups\n                    .pop_front()\n                    .map(|prompt| (session.run.id.clone(), prompt))",
    "                let next = session.follow_ups.pop_front();\n                session.run.pending_messages = session.follow_ups.len();\n                emit_queue_state(session, 0, outputs)?;\n                next.map(|prompt| (session.run.id.clone(), prompt))",
)
replace_once(
    lib,
    "    let mut content = vec![prompt.text.clone().into()];\n    for image in prompt.images {\n        content.push(\n            ImageContent::new(\n                base64::engine::general_purpose::STANDARD.encode(image.bytes),\n                image.media_type,\n            )\n            .into(),\n        );\n    }",
    "    let mut content: Vec<ContentBlock> = vec![\n        ContentBlock::Text(TextContent::new(prompt.text.clone())),\n    ];\n    for image in prompt.images {\n        content.push(ContentBlock::Image(ImageContent::new(\n            base64::engine::general_purpose::STANDARD.encode(image.bytes),\n            image.media_type,\n        )));\n    }",
)
replace_once(
    lib,
    "        outputs.event(BackendEvent::MessageQueueChanged {\n            run_id,\n            pending: session.follow_ups.len(),\n        })",
    "        emit_queue_state(session, 0, outputs)",
)
replace_once(
    lib,
    "    outputs.event(BackendEvent::MessageQueueChanged {\n        run_id,\n        pending: session.follow_ups.len(),\n    })\n}\n\nfn invoke_command(",
    "    emit_queue_state(session, 1, outputs)\n}\n\nfn emit_queue_state(\n    session: &state::SessionState,\n    steering_count: usize,\n    outputs: &BackendOutputSender,\n) -> Result<(), BackendError> {\n    let steering = session\n        .follow_ups\n        .iter()\n        .take(steering_count)\n        .map(|prompt| prompt.text.clone())\n        .collect();\n    let follow_ups = session\n        .follow_ups\n        .iter()\n        .skip(steering_count)\n        .map(|prompt| prompt.text.clone())\n        .collect();\n    outputs.event(BackendEvent::QueueChanged {\n        run_id: session.run.id.clone(),\n        steering,\n        follow_ups,\n    })\n}\n\nfn invoke_command(",
)
