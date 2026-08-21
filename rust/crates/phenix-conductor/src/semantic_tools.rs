use crate::{ConductorRuntime, ResolvedInvocation};
use phenix_backend::{BackendError, ToolInvocation, ToolResult};
use phenix_core::{
    CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
    ExecutionEventKind, ExecutionKind, ExecutionSummary, SkillId,
};
use schemars::{schema_for, JsonSchema};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;

pub(super) const ORCHESTRATION_LIST_ID: &str = "phenix_orchestration_list";
pub(super) const ORCHESTRATION_START_ID: &str = "phenix_orchestration_start";
pub(super) const SKILL_LOAD_ID: &str = "phenix_skill_load";
pub(super) const SKILL_RESOURCE_READ_ID: &str = "phenix_skill_resource_read";

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct EmptyInput {}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct OrchestrationStartInput {
    /// Orchestration id returned by phenix_orchestration_list.
    #[schemars(length(min = 1))]
    orchestration: String,
    /// Objective for the orchestration.
    #[schemars(length(min = 1))]
    objective: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SkillLoadInput {
    /// Skill id from the available-skills catalog.
    #[schemars(length(min = 1))]
    skill: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SkillResourceReadInput {
    /// Active skill id.
    #[schemars(length(min = 1))]
    skill: String,
    /// Relative resource path exactly as listed by the active skill.
    #[schemars(length(min = 1))]
    path: String,
}

pub(super) fn extend_semantic_tools(runtime: &ConductorRuntime, resolved: &mut ResolvedInvocation) {
    let is_root = runtime.snapshot().executions.iter().any(|execution| {
        execution.id == resolved.execution_id && execution.kind == ExecutionKind::Root
    });
    let has_orchestrations = runtime
        .callable_descriptors()
        .iter()
        .any(|descriptor| descriptor.kind == CallableKind::Orchestration);
    if is_root && has_orchestrations {
        resolved.tools.callables.extend(orchestration_descriptors());
    }
    if runtime.has_model_invocable_skills() {
        resolved.tools.callables.push(skill_load_descriptor());
    }
    if runtime.has_skills() {
        resolved
            .tools
            .callables
            .push(skill_resource_read_descriptor());
    }
}

pub(super) fn is_semantic_tool(id: &CallableId) -> bool {
    matches!(
        id.as_str(),
        ORCHESTRATION_LIST_ID | ORCHESTRATION_START_ID | SKILL_LOAD_ID | SKILL_RESOURCE_READ_ID
    )
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

    let outcome = match invocation.callable.as_str() {
        ORCHESTRATION_LIST_ID => parse_list(&invocation.arguments_json).map(|()| {
            list_output(
                runtime
                    .callable_descriptors()
                    .into_iter()
                    .filter(|descriptor| descriptor.kind == CallableKind::Orchestration)
                    .collect(),
            )
        }),
        SKILL_LOAD_ID => parse_skill_load(&invocation.arguments_json).and_then(|skill| {
            runtime
                .load_skill(execution_id, &skill)
                .map_err(|error| error.to_string())
        }),
        SKILL_RESOURCE_READ_ID => {
            parse_skill_resource_read(&invocation.arguments_json).and_then(|(skill, path)| {
                runtime
                    .read_skill_resource(execution_id, &skill, &path)
                    .map_err(|error| error.to_string())
            })
        }
        ORCHESTRATION_START_ID => {
            parse_start(&invocation.arguments_json).and_then(|(orchestration, objective)| {
                runtime
                    .start_orchestration(execution_id, &orchestration, objective)
                    .map(|execution| start_output(&execution))
                    .map_err(|error| error.to_string())
            })
        }
        _ => unreachable!("semantic tool was checked before dispatch"),
    };
    let result = tool_result(outcome);

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

fn tool_result(outcome: Result<String, String>) -> ToolResult {
    match outcome {
        Ok(output) => ToolResult {
            output,
            success: true,
        },
        Err(output) => ToolResult {
            output,
            success: false,
        },
    }
}

fn orchestration_descriptors() -> Vec<CallableDescriptor> {
    vec![
        orchestration_list_descriptor(),
        orchestration_start_descriptor(),
    ]
}

fn parse_list(arguments_json: &str) -> Result<(), String> {
    serde_json::from_str::<EmptyInput>(arguments_json)
        .map(|_| ())
        .map_err(|error| format!("invalid orchestration list arguments: {error}"))
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

fn parse_skill_load(arguments_json: &str) -> Result<SkillId, String> {
    let input: SkillLoadInput = serde_json::from_str(arguments_json)
        .map_err(|error| format!("invalid skill load arguments: {error}"))?;
    SkillId::parse(input.skill).map_err(|error| format!("invalid skill id: {error}"))
}

fn parse_skill_resource_read(arguments_json: &str) -> Result<(SkillId, String), String> {
    let input: SkillResourceReadInput = serde_json::from_str(arguments_json)
        .map_err(|error| format!("invalid skill resource read arguments: {error}"))?;
    if input.path.trim().is_empty() {
        return Err("skill resource path must not be empty".to_owned());
    }
    let skill =
        SkillId::parse(input.skill).map_err(|error| format!("invalid skill id: {error}"))?;
    Ok((skill, input.path))
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

fn input_schema<T: JsonSchema>() -> Value {
    serde_json::to_value(schema_for!(T)).expect("derived input schema must serialize")
}

fn skill_load_descriptor() -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse(SKILL_LOAD_ID).expect("static skill load id"),
        kind: CallableKind::Tool,
        description: "Load the full instructions and resource inventory for one discoverable Phenix skill by id. Use the available-skills catalog from context instead of guessing names.".to_owned(),
        input_schema: input_schema::<SkillLoadInput>(),
        output_schema: json!({
            "type": "string"
        }),
        capabilities: CapabilitySet::default(),
        policy: CallablePolicy {
            requires_permission: false,
        },
    }
}

fn skill_resource_read_descriptor() -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse(SKILL_RESOURCE_READ_ID).expect("static skill resource read id"),
        kind: CallableKind::Tool,
        description: "Read one frozen text resource listed by a skill that is active for this execution. A skill becomes active through explicit manual invocation or a successful phenix_skill_load.".to_owned(),
        input_schema: input_schema::<SkillResourceReadInput>(),
        output_schema: json!({ "type": "string" }),
        capabilities: CapabilitySet::default(),
        policy: CallablePolicy {
            requires_permission: false,
        },
    }
}

fn orchestration_list_descriptor() -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse(ORCHESTRATION_LIST_ID).expect("static orchestration list id"),
        kind: CallableKind::Tool,
        description: "List the orchestrations this Phenix root agent can call. Use this instead of guessing orchestration names.".to_owned(),
        input_schema: input_schema::<EmptyInput>(),
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
        input_schema: input_schema::<OrchestrationStartInput>(),
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

#[cfg(test)]
mod schema_tests {
    use super::*;

    #[test]
    fn derived_semantic_input_schemas_preserve_parser_constraints() {
        let empty = input_schema::<EmptyInput>();
        assert_eq!(empty["additionalProperties"], false);

        let start = input_schema::<OrchestrationStartInput>();
        assert_eq!(start["properties"]["orchestration"]["minLength"], 1);
        assert_eq!(start["properties"]["objective"]["minLength"], 1);

        let resource = input_schema::<SkillResourceReadInput>();
        assert_eq!(resource["properties"]["path"]["minLength"], 1);
    }
}
