use crate::source;
use crate::{
    DefinitionSourceError, DefinitionSourceKind, PhenixAcpGatewayBuilder, RouterId, RoutingTable,
    WorkflowDefinition, WorkflowId,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Definition {
    Workflow(WorkflowDefinition),
    RoutingTable(RoutingTable),
}

impl Definition {
    pub fn kind(&self) -> DefinitionSourceKind {
        match self {
            Self::Workflow(_) => DefinitionSourceKind::Workflow,
            Self::RoutingTable(_) => DefinitionSourceKind::Router,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Definitions {
    inner: source::DefinitionSources,
}

impl Definitions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, source: &str) -> Result<DefinitionSourceKind, DefinitionSourceError> {
        self.inner.add(source)
    }

    pub fn add_workflow(&mut self, source: &str) -> Result<WorkflowId, DefinitionSourceError> {
        self.inner.add_workflow(source)
    }

    pub fn add_routing_table(
        &mut self,
        source: &str,
    ) -> Result<RouterId, DefinitionSourceError> {
        self.inner.add_router(source)
    }

    pub fn workflows(&self) -> impl ExactSizeIterator<Item = &WorkflowDefinition> {
        self.inner.workflows()
    }

    pub fn routing_tables(&self) -> impl ExactSizeIterator<Item = &RoutingTable> {
        self.inner.routers()
    }

    pub fn register(
        self,
        builder: PhenixAcpGatewayBuilder,
    ) -> Result<PhenixAcpGatewayBuilder, DefinitionSourceError> {
        self.inner.register(builder)
    }
}

pub fn parse_definition(source_text: &str) -> Result<Definition, DefinitionSourceError> {
    match source::parse_definition(source_text)? {
        source::ParsedDefinition::Workflow(workflow) => Ok(Definition::Workflow(workflow)),
        source::ParsedDefinition::Router(router) => Ok(Definition::RoutingTable(router)),
    }
}

pub fn parse_workflow(source_text: &str) -> Result<WorkflowDefinition, DefinitionSourceError> {
    match parse_definition(source_text)? {
        Definition::Workflow(workflow) => Ok(workflow),
        Definition::RoutingTable(_) => Err(DefinitionSourceError::UnexpectedKind {
            expected: DefinitionSourceKind::Workflow,
            actual: DefinitionSourceKind::Router,
        }),
    }
}

pub fn parse_routing_table(source_text: &str) -> Result<RoutingTable, DefinitionSourceError> {
    match parse_definition(source_text)? {
        Definition::RoutingTable(router) => Ok(router),
        Definition::Workflow(_) => Err(DefinitionSourceError::UnexpectedKind {
            expected: DefinitionSourceKind::Router,
            actual: DefinitionSourceKind::Workflow,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKFLOW: &str = r#"# Implementation

```phenix-workflow
id: phenix.implement
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `implement` | | `implementer` | Implement {objective} |
"#;

    const ROUTER: &str = r#"# Default routing

```phenix-router
id: phenix.default
```

## Routes

| Role | Workflow | Target | Explanation |
|---|---|---|---|
| `*` | `*` | `pi/openai/gpt-5.6-sol` | Default route |
"#;

    #[test]
    fn parser_returns_semantic_definition_variants() {
        assert!(matches!(
            parse_definition(WORKFLOW).expect("workflow"),
            Definition::Workflow(_)
        ));
        assert!(matches!(
            parse_definition(ROUTER).expect("routing table"),
            Definition::RoutingTable(_)
        ));
    }

    #[test]
    fn typed_entry_points_reject_the_other_definition_kind() {
        assert!(parse_workflow(WORKFLOW).is_ok());
        assert!(parse_routing_table(ROUTER).is_ok());
        assert!(parse_workflow(ROUTER).is_err());
        assert!(parse_routing_table(WORKFLOW).is_err());
    }
}
