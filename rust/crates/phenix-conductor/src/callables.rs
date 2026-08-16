use phenix_backend::ToolResult;
use phenix_core::{CallableDescriptor, CallableId, CallableKind, WorkflowDefinition};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Debug, Display, Formatter};
use std::sync::Arc;

type ToolHandler = dyn Fn(&str) -> Result<String, String> + Send + Sync;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CallableRegistryError {
    Duplicate(CallableId),
    Unknown(CallableId),
    WrongKind {
        callable: CallableId,
        expected: CallableKind,
        actual: CallableKind,
    },
    EmptyWorkflow(CallableId),
    InvalidWorkflowStep {
        workflow: CallableId,
        callable: CallableId,
    },
}

impl Display for CallableRegistryError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Duplicate(id) => write!(f, "callable already registered: {id}"),
            Self::Unknown(id) => write!(f, "unknown callable: {id}"),
            Self::WrongKind {
                callable,
                expected,
                actual,
            } => write!(
                f,
                "callable {callable} has kind {actual:?}, expected {expected:?}"
            ),
            Self::EmptyWorkflow(id) => write!(f, "workflow has no steps: {id}"),
            Self::InvalidWorkflowStep { workflow, callable } => write!(
                f,
                "workflow {workflow} references non-agent or unknown callable {callable}"
            ),
        }
    }
}

impl Error for CallableRegistryError {}

enum CallableImplementation {
    Tool(Arc<ToolHandler>),
    Agent,
    Workflow(Box<WorkflowDefinition>),
}

struct CallableEntry {
    descriptor: CallableDescriptor,
    implementation: CallableImplementation,
}

impl Debug for CallableEntry {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.debug_struct("CallableEntry")
            .field("descriptor", &self.descriptor)
            .finish_non_exhaustive()
    }
}

#[derive(Default)]
pub struct CallableRegistry {
    entries: BTreeMap<CallableId, CallableEntry>,
}

impl Debug for CallableRegistry {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.debug_struct("CallableRegistry")
            .field("descriptors", &self.descriptors())
            .finish()
    }
}

impl CallableRegistry {
    pub fn register_tool<F>(
        &mut self,
        descriptor: CallableDescriptor,
        handler: F,
    ) -> Result<(), CallableRegistryError>
    where
        F: Fn(&str) -> Result<String, String> + Send + Sync + 'static,
    {
        self.register(
            descriptor,
            CallableKind::Tool,
            CallableImplementation::Tool(Arc::new(handler)),
        )
    }

    pub fn register_agent(
        &mut self,
        descriptor: CallableDescriptor,
    ) -> Result<(), CallableRegistryError> {
        self.register(
            descriptor,
            CallableKind::Agent,
            CallableImplementation::Agent,
        )
    }

    pub fn register_workflow(
        &mut self,
        definition: WorkflowDefinition,
    ) -> Result<(), CallableRegistryError> {
        if definition.descriptor.kind != CallableKind::Workflow {
            return Err(CallableRegistryError::WrongKind {
                callable: definition.descriptor.id,
                expected: CallableKind::Workflow,
                actual: definition.descriptor.kind,
            });
        }
        if definition.steps.is_empty() {
            return Err(CallableRegistryError::EmptyWorkflow(
                definition.descriptor.id,
            ));
        }
        for step in &definition.steps {
            let Some(entry) = self.entries.get(&step.callable) else {
                return Err(CallableRegistryError::InvalidWorkflowStep {
                    workflow: definition.descriptor.id.clone(),
                    callable: step.callable.clone(),
                });
            };
            if entry.descriptor.kind != CallableKind::Agent {
                return Err(CallableRegistryError::InvalidWorkflowStep {
                    workflow: definition.descriptor.id.clone(),
                    callable: step.callable.clone(),
                });
            }
        }
        let descriptor = definition.descriptor.clone();
        self.register(
            descriptor,
            CallableKind::Workflow,
            CallableImplementation::Workflow(Box::new(definition)),
        )
    }

    fn register(
        &mut self,
        descriptor: CallableDescriptor,
        expected: CallableKind,
        implementation: CallableImplementation,
    ) -> Result<(), CallableRegistryError> {
        if descriptor.kind != expected {
            return Err(CallableRegistryError::WrongKind {
                callable: descriptor.id,
                expected,
                actual: descriptor.kind,
            });
        }
        if self.entries.contains_key(&descriptor.id) {
            return Err(CallableRegistryError::Duplicate(descriptor.id));
        }
        self.entries.insert(
            descriptor.id.clone(),
            CallableEntry {
                descriptor,
                implementation,
            },
        );
        Ok(())
    }

    #[must_use]
    pub fn descriptors(&self) -> Vec<CallableDescriptor> {
        self.entries
            .values()
            .map(|entry| entry.descriptor.clone())
            .collect()
    }

    #[must_use]
    pub fn tool_descriptors(&self) -> Vec<CallableDescriptor> {
        self.entries
            .values()
            .filter(|entry| entry.descriptor.kind == CallableKind::Tool)
            .map(|entry| entry.descriptor.clone())
            .collect()
    }

    pub fn descriptor(
        &self,
        id: &CallableId,
    ) -> Result<&CallableDescriptor, CallableRegistryError> {
        self.entries
            .get(id)
            .map(|entry| &entry.descriptor)
            .ok_or_else(|| CallableRegistryError::Unknown(id.clone()))
    }

    pub fn workflow(&self, id: &CallableId) -> Result<&WorkflowDefinition, CallableRegistryError> {
        let entry = self
            .entries
            .get(id)
            .ok_or_else(|| CallableRegistryError::Unknown(id.clone()))?;
        match &entry.implementation {
            CallableImplementation::Workflow(definition) => Ok(definition.as_ref()),
            _ => Err(CallableRegistryError::WrongKind {
                callable: id.clone(),
                expected: CallableKind::Workflow,
                actual: entry.descriptor.kind.clone(),
            }),
        }
    }

    #[must_use]
    pub fn contains(&self, id: &CallableId) -> bool {
        self.entries.contains_key(id)
    }

    pub fn invoke_tool(
        &self,
        id: &CallableId,
        arguments_json: &str,
    ) -> Result<ToolResult, CallableRegistryError> {
        let entry = self
            .entries
            .get(id)
            .ok_or_else(|| CallableRegistryError::Unknown(id.clone()))?;
        let CallableImplementation::Tool(handler) = &entry.implementation else {
            return Err(CallableRegistryError::WrongKind {
                callable: id.clone(),
                expected: CallableKind::Tool,
                actual: entry.descriptor.kind.clone(),
            });
        };
        if entry.descriptor.policy.requires_permission {
            return Ok(ToolResult {
                output: format!("permission required for tool {id}"),
                success: false,
            });
        }
        Ok(match handler(arguments_json) {
            Ok(output) => ToolResult {
                output,
                success: true,
            },
            Err(output) => ToolResult {
                output,
                success: false,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_core::{CallablePolicy, CapabilitySet};
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn descriptor(id: &str, kind: CallableKind) -> CallableDescriptor {
        CallableDescriptor {
            id: CallableId::parse(id).unwrap(),
            kind,
            description: "test callable".to_owned(),
            input_schema: json!({"type": "object"}),
            output_schema: json!({"type": "object"}),
            capabilities: CapabilitySet::default(),
            policy: CallablePolicy::default(),
        }
    }

    #[test]
    fn ids_are_unique_across_callable_kinds() {
        let mut registry = CallableRegistry::default();
        registry
            .register_agent(descriptor("same", CallableKind::Agent))
            .unwrap();
        assert!(matches!(
            registry.register_tool(
                descriptor("same", CallableKind::Tool),
                |_| Ok(String::new())
            ),
            Err(CallableRegistryError::Duplicate(_))
        ));
    }

    #[test]
    fn permission_policy_denies_without_executing_tool_handler() {
        let called = Arc::new(AtomicBool::new(false));
        let marker = called.clone();
        let mut guarded = descriptor("guarded", CallableKind::Tool);
        guarded.policy.requires_permission = true;
        let mut registry = CallableRegistry::default();
        registry
            .register_tool(guarded, move |_| {
                marker.store(true, Ordering::SeqCst);
                Ok("should not execute".to_owned())
            })
            .unwrap();
        let result = registry
            .invoke_tool(&CallableId::parse("guarded").unwrap(), "{}")
            .unwrap();
        assert!(!result.success);
        assert!(!called.load(Ordering::SeqCst));
    }
}
