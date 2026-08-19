from pathlib import Path

ROOT = Path.cwd()


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    file = ROOT / path
    content = file.read_text()
    actual = content.count(old)
    if actual != count:
        raise RuntimeError(f"{path}: expected {count} occurrences, found {actual}: {old!r}")
    file.write_text(content.replace(old, new, count))


# Complete the typed inference-effort migration in the ACP backend test surface.
replace(
    "rust/crates/phenix-backend-acp/src/lib.rs",
    "    AuthenticationState, BackendCatalog, BackendId, InferenceOptions, ModelDescriptor, ModelId,\n",
    "    AuthenticationState, BackendCatalog, BackendId, InferenceEffort, InferenceOptions,\n    ModelDescriptor, ModelId,\n",
)
replace(
    "rust/crates/phenix-backend-acp/src/lib.rs",
    '        target.inference.effort = Some("high".to_owned());',
    "        target.inference.effort = Some(InferenceEffort::High);",
)

# Clarify that OrchestrationDefinition itself is canonical; only an intermediate source DTO is absent.
replace(
    "rust/crates/phenix-core/src/lib.rs",
    "/// Source adapters such as Markdown, Lua values, JSON, or RON produce this type\n/// directly. There is no intermediate orchestration-definition domain model.\n",
    "/// Source adapters such as Markdown, Lua values, JSON, or RON produce this type\n/// directly. There is no intermediate source-definition DTO between those adapters\n/// and this canonical domain type.\n",
)

# Preserve version-1 durable-journal compatibility only on decode. Current serialization
# emits the canonical orchestration vocabulary.
replace(
    "rust/crates/phenix-conductor/src/journal.rs",
    "    Invocation { input: String },\n    Orchestration { objective: String, next_node: usize },\n",
    "    Invocation { input: String },\n    #[serde(alias = \"workflow\")]\n    Orchestration { objective: String, next_node: usize },\n",
)
replace(
    "rust/crates/phenix-conductor/src/journal.rs",
    "    OrchestrationAdvanced {\n        execution_id: ExecutionId,\n        next_node: usize,\n    },\n",
    "    #[serde(alias = \"workflow_advanced\")]\n    OrchestrationAdvanced {\n        execution_id: ExecutionId,\n        next_node: usize,\n    },\n",
)
replace(
    "rust/crates/phenix-conductor/src/journal.rs",
    "fn is_terminal(state: &ExecutionState) -> bool {\n    matches!(\n        state,\n        ExecutionState::Completed\n            | ExecutionState::Failed\n            | ExecutionState::Cancelled\n            | ExecutionState::Interrupted\n    )\n}\n",
    "fn is_terminal(state: &ExecutionState) -> bool {\n    matches!(\n        state,\n        ExecutionState::Completed\n            | ExecutionState::Failed\n            | ExecutionState::Cancelled\n            | ExecutionState::Interrupted\n    )\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    use serde_json::json;\n\n    #[test]\n    fn legacy_workflow_tags_decode_but_current_journals_emit_orchestration() {\n        let payload: JournalExecutionPayload = serde_json::from_value(json!({\n            \"kind\": \"workflow\",\n            \"objective\": \"legacy\",\n            \"next_node\": 2\n        }))\n        .unwrap();\n        assert!(matches!(\n            payload,\n            JournalExecutionPayload::Orchestration {\n                ref objective,\n                next_node: 2\n            } if objective == \"legacy\"\n        ));\n        assert_eq!(serde_json::to_value(&payload).unwrap()[\"kind\"], \"orchestration\");\n\n        let event: DomainEvent = serde_json::from_value(json!({\n            \"type\": \"workflow_advanced\",\n            \"execution_id\": \"execution-1\",\n            \"next_node\": 3\n        }))\n        .unwrap();\n        assert!(matches!(\n            event,\n            DomainEvent::OrchestrationAdvanced { next_node: 3, .. }\n        ));\n        assert_eq!(\n            serde_json::to_value(&event).unwrap()[\"type\"],\n            \"orchestration_advanced\"\n        );\n    }\n}\n",
)

# Make continuation after a failed tool invocation explicit: the same model/tool loop
# host can receive a successful call immediately afterwards.
replace(
    "rust/crates/phenix-backend-native/src/lib.rs",
    "        assert_eq!(host.calls, 1);\n\n        let unknown = dispatch_tool_call(&tools, &mut host, \"made_up_tool\", &json!({})).unwrap();\n",
    "        assert_eq!(host.calls, 1);\n\n        host.result = Ok(ToolResult {\n            output: \"recovered\".to_owned(),\n            success: true,\n        });\n        let recovered =\n            dispatch_tool_call(&tools, &mut host, \"read\", &json!({\"path\": \"valid\"})).unwrap();\n        assert_eq!(recovered, \"recovered\");\n        assert_eq!(host.calls, 2, \"a failed tool call must not poison later calls\");\n\n        let unknown = dispatch_tool_call(&tools, &mut host, \"made_up_tool\", &json!({})).unwrap();\n",
)
replace(
    "rust/crates/phenix-backend-native/src/lib.rs",
    '        assert_eq!(host.calls, 1, "unknown tools must not reach the host");',
    '        assert_eq!(host.calls, 2, "unknown tools must not reach the host");',
)
