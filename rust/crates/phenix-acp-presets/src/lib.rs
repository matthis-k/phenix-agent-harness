#![forbid(unsafe_code)]

use phenix_acp::{
    AcpEndpoint, AcpSessionFactory, BackendDefinition, BackendId, DefinitionError, DefinitionId,
    FixedRouter, GatewayError, ModelConfig, ModelId, PhenixAcpGateway, PhenixAcpGatewayBuilder,
    ProviderId, RoleId, RouterId, SessionTreeDefinition, SessionTreeDefinitionBuilder,
    ThinkingLevel, Workflow, WorkflowId, WorkflowPlan, WorkflowRequest,
};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

// This crate is an explicit fixture/example package. None of these values are
// imported by phenix-conductor or installed as conductor defaults.
const STANDARD_DEFINITION: &str = "phenix.standard";
const STANDARD_ROUTER: &str = "phenix.fixture-router";
const PI_BACKEND: &str = "pi";

pub fn standard_builder() -> Result<SessionTreeDefinitionBuilder, DefinitionError> {
    let pi_endpoint = AcpEndpoint::stdio("pi-acp", Vec::new(), BTreeMap::new())?;
    let builder = SessionTreeDefinition::builder(definition_id(), router_id())
        .backend(BackendDefinition::new(backend_id(), pi_endpoint))?;

    workflow_templates()
        .into_iter()
        .try_fold(builder, |builder, (workflow_id, _)| {
            builder.workflow(workflow_id)
        })
}

pub fn standard() -> Result<SessionTreeDefinition, DefinitionError> {
    standard_builder()?.build()
}

pub fn standard_gateway_builder<F>(
    backend: F,
) -> Result<PhenixAcpGatewayBuilder, StandardGatewayError>
where
    F: AcpSessionFactory,
{
    let mut builder = PhenixAcpGateway::builder()
        .definition(standard()?)?
        .router(
            router_id(),
            FixedRouter::new(fixture_model()).explanation(
                "explicit fixture policy selected the configured ACP backend and model",
            ),
        )?
        .backend(backend_id(), backend)?;

    for (workflow_id, workflow) in workflow_templates() {
        builder = builder.workflow(workflow_id, workflow)?;
    }
    Ok(builder)
}

pub fn standard_gateway<F>(backend: F) -> Result<PhenixAcpGateway, StandardGatewayError>
where
    F: AcpSessionFactory,
{
    Ok(standard_gateway_builder(backend)?.build()?)
}

pub fn local_only(backend: BackendDefinition) -> Result<SessionTreeDefinition, DefinitionError> {
    SessionTreeDefinition::builder(
        DefinitionId::parse("phenix.local-only").expect("static definition ID is valid"),
        RouterId::parse("phenix.single-backend").expect("static router ID is valid"),
    )
    .backend(backend)?
    .workflow(WorkflowId::parse("phenix.direct").expect("static workflow ID is valid"))?
    .build()
}

#[derive(Debug)]
pub enum StandardGatewayError {
    Definition(DefinitionError),
    Gateway(GatewayError),
}

impl Display for StandardGatewayError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Definition(error) => {
                write!(formatter, "invalid fixture ACP definition: {error}")
            }
            Self::Gateway(error) => write!(formatter, "invalid fixture ACP gateway: {error}"),
        }
    }
}

impl Error for StandardGatewayError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Definition(error) => Some(error),
            Self::Gateway(error) => Some(error),
        }
    }
}

impl From<DefinitionError> for StandardGatewayError {
    fn from(error: DefinitionError) -> Self {
        Self::Definition(error)
    }
}

impl From<GatewayError> for StandardGatewayError {
    fn from(error: GatewayError) -> Self {
        Self::Gateway(error)
    }
}

#[derive(Clone, Debug)]
struct PresetWorkflow {
    steps: &'static [PresetStep],
}

impl PresetWorkflow {
    const fn new(steps: &'static [PresetStep]) -> Self {
        Self { steps }
    }
}

impl Workflow for PresetWorkflow {
    fn plan(&self, request: &WorkflowRequest) -> Result<WorkflowPlan, GatewayError> {
        let mut plan = WorkflowPlan::builder();
        for step in self.steps {
            plan = plan.step(
                step.key,
                step.parent,
                RoleId::parse(step.role).expect("static workflow role ID is valid"),
                format!("{}: {}", step.instruction, request.objective),
            )?;
        }
        plan.build()
    }
}

#[derive(Clone, Copy, Debug)]
struct PresetStep {
    key: &'static str,
    parent: Option<&'static str>,
    role: &'static str,
    instruction: &'static str,
}

const IMPLEMENT_STEPS: &[PresetStep] = &[
    PresetStep {
        key: "implementation",
        parent: None,
        role: "implementer",
        instruction: "Implement the objective",
    },
    PresetStep {
        key: "verification",
        parent: Some("implementation"),
        role: "verifier",
        instruction: "Verify the completed implementation",
    },
];

const QA_STEPS: &[PresetStep] = &[
    PresetStep {
        key: "inspection",
        parent: None,
        role: "scout",
        instruction: "Inspect the objective and collect concrete findings",
    },
    PresetStep {
        key: "verification",
        parent: Some("inspection"),
        role: "verifier",
        instruction: "Validate and prioritize the findings",
    },
];

const QA_FIX_STEPS: &[PresetStep] = &[
    PresetStep {
        key: "analysis",
        parent: None,
        role: "verifier",
        instruction: "Reproduce and classify the reported problems",
    },
    PresetStep {
        key: "implementation",
        parent: Some("analysis"),
        role: "implementer",
        instruction: "Fix the verified problems",
    },
    PresetStep {
        key: "verification",
        parent: Some("implementation"),
        role: "verifier",
        instruction: "Verify the fixes and check for regressions",
    },
];

const DYNAMIC_STEPS: &[PresetStep] = &[PresetStep {
    key: "execution",
    parent: None,
    role: "stock",
    instruction: "Execute the objective using the best available capabilities",
}];

fn workflow_templates() -> [(WorkflowId, PresetWorkflow); 4] {
    [
        (
            workflow_id("implement"),
            PresetWorkflow::new(IMPLEMENT_STEPS),
        ),
        (workflow_id("qa"), PresetWorkflow::new(QA_STEPS)),
        (workflow_id("qa-fix"), PresetWorkflow::new(QA_FIX_STEPS)),
        (workflow_id("dynamic"), PresetWorkflow::new(DYNAMIC_STEPS)),
    ]
}

fn definition_id() -> DefinitionId {
    DefinitionId::parse(STANDARD_DEFINITION).expect("static definition ID is valid")
}

fn router_id() -> RouterId {
    RouterId::parse(STANDARD_ROUTER).expect("static router ID is valid")
}

fn backend_id() -> BackendId {
    BackendId::parse(PI_BACKEND).expect("static backend ID is valid")
}

fn fixture_model() -> ModelConfig {
    ModelConfig {
        backend: backend_id(),
        provider: ProviderId::parse("fixture").expect("static provider ID is valid"),
        model: ModelId::parse("fixture-model").expect("static model ID is valid"),
        thinking: ThinkingLevel::Medium,
    }
}

fn workflow_id(name: &str) -> WorkflowId {
    WorkflowId::parse(format!("phenix.{name}")).expect("static workflow ID is valid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_acp::SessionTreeId;

    #[test]
    fn standard_preset_is_only_an_explicit_reusable_fixture_definition() {
        let first = standard().expect("standard preset");
        let second = standard().expect("standard preset");
        assert_eq!(first, second);
        assert_eq!(first.backends().len(), 1);
        assert_eq!(first.workflows().len(), 4);
    }

    #[test]
    fn fixture_workflows_expand_objectives_into_typed_session_steps() {
        let request = WorkflowRequest {
            tree_id: SessionTreeId::parse("tree-test").expect("tree ID"),
            objective: "ship the feature".to_owned(),
        };
        let (_, workflow) = workflow_templates()
            .into_iter()
            .find(|(id, _)| id.as_str() == "phenix.qa-fix")
            .expect("qa-fix workflow");
        let plan = workflow.plan(&request).expect("workflow plan");
        assert_eq!(plan.steps.len(), 3);
        assert_eq!(plan.steps[1].parent.as_deref(), Some("analysis"));
        assert!(plan.steps[2].objective.contains("ship the feature"));
    }
}
