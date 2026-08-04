#![forbid(unsafe_code)]

use phenix_acp::{
    AcpEndpoint, BackendDefinition, BackendId, DefinitionError, DefinitionId, RouterId,
    SessionTreeDefinition, SessionTreeDefinitionBuilder, WorkflowId,
};
use std::collections::BTreeMap;

pub fn standard_builder() -> Result<SessionTreeDefinitionBuilder, DefinitionError> {
    let pi_endpoint = AcpEndpoint::stdio("pi-acp", Vec::new(), BTreeMap::new())?;
    let builder = SessionTreeDefinition::builder(
        DefinitionId::parse("phenix.standard").expect("static definition ID is valid"),
        RouterId::parse("phenix.capability-budget").expect("static router ID is valid"),
    )
    .backend(BackendDefinition::new(
        BackendId::parse("pi").expect("static backend ID is valid"),
        pi_endpoint,
    ))?;

    ["implement", "qa", "qa-fix", "dynamic"]
        .into_iter()
        .try_fold(builder, |builder, workflow| {
            builder.workflow(
                WorkflowId::parse(format!("phenix.{workflow}"))
                    .expect("static workflow ID is valid"),
            )
        })
}

pub fn standard() -> Result<SessionTreeDefinition, DefinitionError> {
    standard_builder()?.build()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_preset_is_only_a_reusable_immutable_tree_definition() {
        let first = standard().expect("standard preset");
        let second = standard().expect("standard preset");
        assert_eq!(first, second);
        assert_eq!(first.backends().len(), 1);
        assert_eq!(first.workflows().len(), 4);
    }
}
