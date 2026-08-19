from pathlib import Path

ROOT = Path.cwd()


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    file = ROOT / path
    content = file.read_text()
    actual = content.count(old)
    if actual != count:
        raise RuntimeError(f"{path}: expected {count} occurrences, found {actual}: {old!r}")
    file.write_text(content.replace(old, new, count))


native = "rust/crates/phenix-backend-native/src/lib.rs"
replace(
    native,
    "        for provider in &auth_providers {\n            if provider_has_valid_auth(&self.credentials, provider)? {\n                any_authenticated = true;\n                break;\n            }\n        }",
    "        for provider in &auth_providers {\n            let provider_id = ProviderId::parse(*provider)\n                .map_err(|error| BackendError::Protocol(error.to_string()))?;\n            if provider_has_valid_auth(&self.credentials, &provider_id)? {\n                any_authenticated = true;\n                break;\n            }\n        }",
)
replace(
    native,
    "        assert_eq!(\n            provider_reasoning_effort(&InferenceEffort::High),\n            ReasoningEffort::High\n        );\n        assert_eq!(\n            provider_reasoning_effort(&InferenceEffort::ExtraHigh),\n            ReasoningEffort::XHigh\n        );",
    "        assert!(matches!(\n            provider_reasoning_effort(&InferenceEffort::High),\n            ReasoningEffort::High\n        ));\n        assert!(matches!(\n            provider_reasoning_effort(&InferenceEffort::ExtraHigh),\n            ReasoningEffort::XHigh\n        ));",
)

# Add a conductor-level black-box regression proving an ordinary tool failure is a
# recoverable ToolResult and a later tool call in the same backend execution succeeds.
test = "rust/crates/phenix-conductor/tests/black_box_model_tool_loop.rs"
replace(
    test,
    "struct UnsupportedBackend {\n    opened: Arc<AtomicBool>,\n}\n",
    '''struct RecoveringToolBackend;\nstruct RecoveringToolSession;\n\nimpl Backend for RecoveringToolBackend {\n    fn capabilities(&self) -> BackendCapabilities {\n        BackendCapabilities {\n            tool_presentations: BTreeSet::from([ToolPresentation::Native]),\n            images: false,\n            persistent_sessions: false,\n        }\n    }\n\n    fn open_session(\n        &mut self,\n        request: BackendSessionRequest,\n    ) -> Result<Arc<dyn BackendSession>, BackendError> {\n        assert_eq!(request.tools.presentation(), Some(ToolPresentation::Native));\n        Ok(Arc::new(RecoveringToolSession))\n    }\n}\n\nimpl BackendSession for RecoveringToolSession {\n    fn execute(\n        &self,\n        _request: BackendExecutionRequest,\n        host: &mut dyn BackendHost,\n    ) -> Result<(), BackendError> {\n        let failed = host.invoke_tool(ToolInvocation {\n            callable: CallableId::parse("flaky").unwrap(),\n            arguments_json: r#"{\"attempt\":1}"#.to_owned(),\n        })?;\n        assert!(!failed.success);\n        assert!(failed.output.contains("first attempt failed"));\n\n        let recovered = host.invoke_tool(ToolInvocation {\n            callable: CallableId::parse("flaky").unwrap(),\n            arguments_json: r#"{\"attempt\":2}"#.to_owned(),\n        })?;\n        assert!(recovered.success);\n        assert_eq!(recovered.output, r#"{\"attempt\":2}"#);\n        host.emit(BackendEvent::ContentDelta("recovered".to_owned()))?;\n        Ok(())\n    }\n\n    fn cancel(&self, _execution_id: &phenix_core::ExecutionId) -> Result<(), BackendError> {\n        Ok(())\n    }\n}\n\nstruct UnsupportedBackend {\n    opened: Arc<AtomicBool>,\n}\n''',
)
replace(
    test,
    "#[test]\nfn required_tools_are_rejected_before_opening_unsupported_backend() {",
    '''#[test]\nfn failed_tool_call_does_not_poison_later_calls_in_same_execution() {\n    use std::sync::atomic::AtomicUsize;\n\n    let attempts = Arc::new(AtomicUsize::new(0));\n    let marker = attempts.clone();\n    let mut runtime = ConductorRuntime::new();\n    runtime\n        .register_tool(descriptor("flaky", CallableKind::Tool), move |arguments| {\n            let attempt = marker.fetch_add(1, Ordering::SeqCst);\n            if attempt == 0 {\n                Err("first attempt failed".to_owned())\n            } else {\n                Ok(arguments.to_owned())\n            }\n        })\n        .unwrap();\n    let session = runtime.create_session(None, None, fixed()).unwrap();\n    let execution = runtime.submit(&session.id, "recover after tool failure").unwrap();\n    let mut backend = RecoveringToolBackend;\n\n    runtime\n        .drive_execution(&execution.id, &mut backend)\n        .unwrap();\n\n    assert_eq!(attempts.load(Ordering::SeqCst), 2);\n    assert_eq!(\n        runtime\n            .snapshot()\n            .executions\n            .into_iter()\n            .find(|item| item.id == execution.id)\n            .unwrap()\n            .state,\n        ExecutionState::Completed\n    );\n    assert!(runtime.events_since(0).iter().any(|event| {\n        matches!(\n            event.kind,\n            ExecutionEventKind::ToolCallFinished { success: false, .. }\n        )\n    }));\n}\n\n#[test]\nfn required_tools_are_rejected_before_opening_unsupported_backend() {''',
)
