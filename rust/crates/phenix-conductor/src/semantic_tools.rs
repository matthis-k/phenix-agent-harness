use phenix_core::{
    CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet, ExecutionSummary,
};
use serde::Deserialize;
use serde_json::json;

pub(crate) const WORKFLOW_LIST_ID: &str = "phenix_workflow_list";
pub(crate) const WORKFLOW_START_ID: &str = "phenix_workflow_start";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorkflowStartInput {
    pub workflow: String,
    pub objective: String,
}

pub(crate) fn descriptors() -> Vec<CallableDescriptor> {
    vec![workflow_list_descriptor(), workflow_start_descriptor()]
}

pub(crate) fn is_semantic_tool(id: &CallableId) -> bool {
    matches!(id.as_str(), WORKFLOW_LIST_ID | WORKFLOW_START_ID)
}

pub(crate) fn parse_start(arguments_json: &str) -> Result<(CallableId, String), String> {
    let input: WorkflowStartInput = serde_json::from_str(arguments_json)
        .map_err(|error| format!("invalid workflow start arguments: {error}"))?;
    if input.objective.trim().is_empty() {
        return Err("workflow objective must not be empty".to_owned());
    }
    let workflow = CallableId::parse(input.workflow)
        .map_err(|error| format!("invalid workflow id: {error}"))?;
    Ok((workflow, input.objective))
}

pub(crate) fn list_output(workflows: Vec<CallableDescriptor>) -> String {
    json!({ "workflows": workflows }).to_string()
}

pub(crate) fn start_output(execution: &ExecutionSummary) -> String {
    json!({
        "execution_id": execution.id,
        "callable": execution.callable,
        "kind": execution.kind,
        "state": execution.state,
    })
    .to_string()
}

fn workflow_list_descriptor() -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse(WORKFLOW_LIST_ID).expect("static workflow list id"),
        kind: CallableKind::Tool,
        description: "List the workflows this Phenix root agent can call. Use this instead of guessing workflow names.".to_owned(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {}
        }),
        output_schema: json!({
            "type": "object",
            "required": ["workflows"],
            "properties": {
                "workflows": { "type": "array" }
            }
        }),
        capabilities: CapabilitySet::default(),
        policy: CallablePolicy {
            requires_permission: false,
        },
    }
}

fn workflow_start_descriptor() -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse(WORKFLOW_START_ID).expect("static workflow start id"),
        kind: CallableKind::Tool,
        description: "Start one conductor-owned workflow returned by phenix_workflow_list with a concrete objective.".to_owned(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["workflow", "objective"],
            "properties": {
                "workflow": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Workflow id returned by phenix_workflow_list"
                },
                "objective": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Objective for the workflow"
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
