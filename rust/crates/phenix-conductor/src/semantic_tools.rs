use crate::{
    ConductorError, ConductorRuntime, OrchestrationFailureDecisionRequest, ResolvedInvocation,
};
use phenix_backend::{BackendError, ToolInvocation, ToolResult};
use phenix_core::{
    CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
    ExecutionEventKind, ExecutionKind, ExecutionSummary, SkillId,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;

pub(super) const ORCHESTRATION_LIST_ID: &str = "phenix_orchestration_list";
pub(super) const ORCHESTRATION_START_ID: &str = "phenix_orchestration_start";
pub(super) const ORCHESTRATION_DECIDE_FAILURE_ID: &str = "phenix_orchestration_decide_failure";
pub(super) const SKILL_LOAD_ID: &str = "phenix_skill_load";
pub(super) const SKILL_RESOURCE_READ_ID: &str = "phenix_skill_resource_read";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OrchestrationStartInput {
    orchestration: String,
    objective: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case", deny_unknown_fields)]
enum OrchestrationDecisionInput {
    Retry,
    ChooseAnotherChild { callable: String, objective: String },
    Continue,
    Fail,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillLoadInput {
    skill: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillResourceReadInput {
    skill: String,
    path: String,
}

pub(super) fn extend_semantic_tools(
    runtime: &ConductorRuntime,
    resolved: &mut ResolvedInvocation,
) -> Result<(), ConductorError> {
    let is_root = runtime.snapshot().executions.iter().any(|execution| {
        execution.id == resolved.execution_id && execution.kind == ExecutionKind::Root
    });
    let has_orchestrations = runtime
        .callable_descriptors_for_execution(&resolved.execution_id)?
        .iter()
        .any(|descriptor| descriptor.kind == CallableKind::Orchestration);
    if is_root && has_orchestrations {
        resolved.tools.callables.extend(orchestration_descriptors());
    }
    if runtime
        .failed_child_for_interface(&resolved.execution_id)
        .is_some()
    {
        resolved
            .tools
            .callables
            .push(orchestration_decide_failure_descriptor());
    }
    if runtime.has_model_invocable_skills_for_execution(&resolved.execution_id)? {
        resolved.tools.callables.push(skill_load_descriptor());
    }
    if runtime.has_skills_for_execution(&resolved.execution_id)? {
        resolved
            .tools
            .callables
            .push(skill_resource_read_descriptor());
    }
    Ok(())
}

pub(super) fn is_semantic_tool(id: &CallableId) -> bool {
    matches!(
        id.as_str(),
        ORCHESTRATION_LIST_ID
            | ORCHESTRATION_START_ID
            | ORCHESTRATION_DECIDE_FAILURE_ID
            | SKILL_LOAD_ID
            | SKILL_RESOURCE_READ_ID
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
        ORCHESTRATION_LIST_ID => parse_list(&invocation.arguments_json).and_then(|()| {
            runtime
                .callable_descriptors_for_execution(execution_id)
                .map(|descriptors| {
                    list_output(
                        descriptors
                            .into_iter()
                            .filter(|descriptor| descriptor.kind == CallableKind::Orchestration)
                            .collect(),
                    )
                })
                .map_err(|error| error.to_string())
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
                    .start_orchestration(
                        execution_id,
                        &orchestration,
                        json!({"objective": objective}),
                    )
                    .map(|execution| start_output(&execution))
                    .map_err(|error| error.to_string())
            })
        }
        ORCHESTRATION_DECIDE_FAILURE_ID => parse_failure_decision(&invocation.arguments_json)
            .and_then(|decision| {
                let failed_child = runtime
                    .failed_child_for_interface(execution_id)
                    .ok_or_else(|| {
                        "execution is not an orchestration failure interface".to_owned()
                    })?;
                runtime
                    .decide_orchestration_failure(execution_id, decision)
                    .map_err(|error| error.to_string())?;
                let record = runtime
                    .orchestration_failure_decision(&failed_child)
                    .expect("successful decision is durably recorded");
                serde_json::to_string(&record).map_err(|error| error.to_string())
            }),
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

fn parse_failure_decision(
    arguments_json: &str,
) -> Result<OrchestrationFailureDecisionRequest, String> {
    let input: OrchestrationDecisionInput = serde_json::from_str(arguments_json)
        .map_err(|error| format!("invalid orchestration failure decision: {error}"))?;
    match input {
        OrchestrationDecisionInput::Retry => Ok(OrchestrationFailureDecisionRequest::Retry),
        OrchestrationDecisionInput::ChooseAnotherChild {
            callable,
            objective,
        } => {
            if objective.trim().is_empty() {
                return Err("replacement objective must not be empty".to_owned());
            }
            let callable = CallableId::parse(callable)
                .map_err(|error| format!("invalid replacement callable id: {error}"))?;
            Ok(OrchestrationFailureDecisionRequest::ChooseAnotherChild {
                callable,
                objective,
            })
        }
        OrchestrationDecisionInput::Continue => Ok(OrchestrationFailureDecisionRequest::Continue),
        OrchestrationDecisionInput::Fail => Ok(OrchestrationFailureDecisionRequest::Fail),
    }
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

fn orchestration_decide_failure_descriptor() -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse(ORCHESTRATION_DECIDE_FAILURE_ID)
            .expect("static orchestration decision id"),
        kind: CallableKind::Tool,
        description: "Record exactly one parent decision for the failed child assigned to this orchestration interface execution.".to_owned(),
        input_schema: json!({
            "oneOf": [
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["decision"],
                    "properties": { "decision": { "const": "retry" } }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["decision", "callable", "objective"],
                    "properties": {
                        "decision": { "const": "choose_another_child" },
                        "callable": { "type": "string", "minLength": 1 },
                        "objective": { "type": "string", "minLength": 1 }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["decision"],
                    "properties": { "decision": { "const": "continue" } }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["decision"],
                    "properties": { "decision": { "const": "fail" } }
                }
            ]
        }),
        output_schema: json!({ "type": "object" }),
        capabilities: CapabilitySet::default(),
        policy: CallablePolicy {
            requires_permission: false,
        },
    }
}

fn skill_load_descriptor() -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse(SKILL_LOAD_ID).expect("static skill load id"),
        kind: CallableKind::Tool,
        description: "Load the full instructions and resource inventory for one discoverable Phenix skill by id. Use the available-skills catalog from context instead of guessing names.".to_owned(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["skill"],
            "properties": {
                "skill": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Skill id from the available-skills catalog"
                }
            }
        }),
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
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["skill", "path"],
            "properties": {
                "skill": { "type": "string", "minLength": 1 },
                "path": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Relative resource path exactly as listed by the active skill"
                }
            }
        }),
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
