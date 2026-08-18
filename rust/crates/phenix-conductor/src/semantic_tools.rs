use crate::{ConductorRuntime, ResolvedInvocation};
use phenix_backend::{BackendError, ToolInvocation, ToolResult};
use phenix_core::{
    CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
    ExecutionEventKind, ExecutionKind, ExecutionSummary,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;

pub(super) const ORCHESTRATION_LIST_ID: &str = "phenix_orchestration_list";
pub(super) const ORCHESTRATION_START_ID: &str = "phenix_orchestration_start";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OrchestrationStartInput {
    orchestration: String,
    objective: String,
}

pub(super) fn extend_root_workflow_tools(
    runtime: &ConductorRuntime,
    resolved: &mut ResolvedInvocation,
) {
    let is_root = runtime.snapshot().executions.iter().any(|execution| {
        execution.id == resolved.execution_id && execution.kind == ExecutionKind::Root
    });
    let has_orchestrations = runtime
        .callable_descriptors()
        .iter()
        .any(|descriptor| descriptor.kind == CallableKind::Orchestration);
    if is_root && has_orchestrations {
        resolved.tools.callables.extend(descriptors());
    }
}

pub(super) fn is_semantic_tool(id: &CallableId) -> bool {
    matches!(id.as_str(), ORCHESTRATION_LIST_ID | ORCHESTRATION_START_ID)
}

pub(super) fn invoke(
    runtime: &mut ConductorRuntime,
    execution_id: &phenix_core::ExecutionId,
    allowed_tools: &BTreeSet<CallableId>,
    invocation: ToolInvocation,
) -> Result<ToolResult, BackendError> {
    if !allowed_tools.contains(&invocation.callable) || !is_semantic_tool(&invocation.callable) {
        return Err(BackendError::Protocol(format!(
            "backend invoked unprovisioned semantic tool {}",
            invocation.callable
        )));
    }

    let tool_call_id = runtime.new_tool_call_id();
    runtime
        .push_event(
            execution_id,
            ExecutionEventKind::ToolCallStarted {
                tool_call_id: tool_call_id.clone(),
                callable: invocation.callable.clone(),
            },
        )
        .map_err(conductor_protocol_error)?;
    runtime
        .push_event(
            execution_id,
            ExecutionEventKind::ToolCallArguments {
                tool_call_id: tool_call_id.clone(),
                arguments: invocation.arguments_json.clone(),
            },
        )
        .map_err(conductor_protocol_error)?;

    let result = match invocation.callable.as_str() {
        ORCHESTRATION_LIST_ID => match parse_list(&invocation.arguments_json) {
            Ok(()) => ToolResult {
                output: list_output(
                    runtime
                        .callable_descriptors()
                        .into_iter()
                        .filter(|descriptor| descriptor.kind == CallableKind::Orchestration)
                        .collect(),
                ),
                success: true,
            },
            Err(error) => ToolResult {
                output: error,
                success: false,
            },
        },
        ORCHESTRATION_START_ID => match parse_start(&invocation.arguments_json) {
            Ok((orchestration, objective)) => {
                match runtime.start_orchestration(execution_id, &orchestration, objective) {
                    Ok(execution) => ToolResult {
                        output: start_output(&execution),
                        success: true,
                    },
                    Err(error) => ToolResult {
                        output: error.to_string(),
                        success: false,
                    },
                }
            }
            Err(error) => ToolResult {
                output: error,
                success: false,
            },
        },
        _ => unreachable!("semantic tool was checked before dispatch"),
    };

    runtime
        .push_event(
            execution_id,
            ExecutionEventKind::ToolCallFinished {
                tool_call_id,
                output: result.output.clone(),
                success: result.success,
            },
        )
        .map_err(conductor_protocol_error)?;
    Ok(result)
}

fn descriptors() -> Vec<CallableDescriptor> {
    vec![
        orchestration_list_descriptor(),
        orchestration_start_descriptor(),
    ]
}

fn parse_list(arguments_json: &str) -> Result<(), String> {
    let value: Value = serde_json::from_str(arguments_json)
        .map_err(|error| format!("invalid orchestration list arguments: {error}"))?;
    let Some(object) = value.as_object() else {
        return Err("orchestration list arguments must be an object".to_owned());
    };
    if !object.is_empty() {
        return Err("orchestration list arguments must be empty".to_owned());
    }
    Ok(())
}

fn parse_start(arguments_json: &str) -> Result<(CallableId, String), String> {
    let input: OrchestrationStartInput = serde_json::from_str(arguments_json)
        .map_err(|error| format!("invalid orchestration start arguments: {error}"))?;
    if input.objective.trim().is_empty() {
        return Err("orchestration objective must not be empty".to_owned());
    }
    let orchestration = CallableId::parse(input.orchestration)
        .map_err(|error| format!("invalid orchestration id: {error}"))?;
    Ok((orchestration, input.objective))
}

fn list_output(orchestrations: Vec<CallableDescriptor>) -> String {
    let orchestrations = orchestrations
        .into_iter()
        .map(|descriptor| {
            json!({
                "id": descriptor.id,
                "kind": "orchestration",
                "description": descriptor.description,
                "input_schema": descriptor.input_schema,
                "output_schema": descriptor.output_schema,
                "capabilities": descriptor.capabilities,
                "policy": descriptor.policy,
            })
        })
        .collect::<Vec<_>>();
    json!({ "orchestrations": orchestrations }).to_string()
}

fn start_output(execution: &ExecutionSummary) -> String {
    json!({
        "execution_id": execution.id,
        "callable": execution.callable,
        "kind": "orchestration",
        "state": execution.state,
    })
    .to_string()
}

fn conductor_protocol_error(error: crate::ConductorError) -> BackendError {
    BackendError::Protocol(error.to_string())
}

fn orchestration_list_descriptor() -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse(ORCHESTRATION_LIST_ID).expect("static orchestration list id"),
        kind: CallableKind::Tool,
        description: "List the orchestrations this Phenix root agent can call. Use this instead of guessing orchestration names.".to_owned(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {}
        }),
        output_schema: json!({
            "type": "object",
            "required": ["orchestrations"],
            "properties": {
                "orchestrations": { "type": "array" }
            }
        }),
        capabilities: CapabilitySet::default(),
        policy: CallablePolicy {
            requires_permission: false,
        },
    }
}

fn orchestration_start_descriptor() -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse(ORCHESTRATION_START_ID).expect("static orchestration start id"),
        kind: CallableKind::Tool,
        description: "Start one conductor-owned orchestration returned by phenix_orchestration_list with a concrete objective.".to_owned(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["orchestration", "objective"],
            "properties": {
                "orchestration": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Orchestration id returned by phenix_orchestration_list"
                },
                "objective": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Objective for the orchestration"
                }
            }
        }),
        output_schema: json!({
            "type": "object",
            "required": ["execution_id", "callable", "kind", "state"]
        }),
        capabilities: CapabilitySet::default(),
        policy: CallablePolicy {
            requires_permission: false,
        },
    }
}
