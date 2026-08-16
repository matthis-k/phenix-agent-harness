use phenix_backend::ToolResult;
use phenix_core::{CallableDescriptor, CallableId, CallableKind};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Debug, Display, Formatter};
use std::sync::Arc;

type ToolHandler = dyn Fn(&str) -> Result<String, String> + Send + Sync;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolRegistryError {
    NotATool(CallableId),
    Duplicate(CallableId),
    Unknown(CallableId),
}

impl Display for ToolRegistryError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotATool(id) => write!(f, "callable is not a tool: {id}"),
            Self::Duplicate(id) => write!(f, "tool already registered: {id}"),
            Self::Unknown(id) => write!(f, "unknown tool: {id}"),
        }
    }
}

impl Error for ToolRegistryError {}

struct RegisteredTool {
    descriptor: CallableDescriptor,
    handler: Arc<ToolHandler>,
}

impl Debug for RegisteredTool {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.debug_struct("RegisteredTool")
            .field("descriptor", &self.descriptor)
            .finish_non_exhaustive()
    }
}

#[derive(Default)]
pub struct ToolRegistry {
    entries: BTreeMap<CallableId, RegisteredTool>,
}

impl Debug for ToolRegistry {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.debug_struct("ToolRegistry")
            .field("descriptors", &self.descriptors())
            .finish()
    }
}

impl ToolRegistry {
    pub fn register<F>(
        &mut self,
        descriptor: CallableDescriptor,
        handler: F,
    ) -> Result<(), ToolRegistryError>
    where
        F: Fn(&str) -> Result<String, String> + Send + Sync + 'static,
    {
        if descriptor.kind != CallableKind::Tool {
            return Err(ToolRegistryError::NotATool(descriptor.id));
        }
        if self.entries.contains_key(&descriptor.id) {
            return Err(ToolRegistryError::Duplicate(descriptor.id));
        }
        self.entries.insert(
            descriptor.id.clone(),
            RegisteredTool {
                descriptor,
                handler: Arc::new(handler),
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
    pub fn contains(&self, id: &CallableId) -> bool {
        self.entries.contains_key(id)
    }

    pub fn invoke(
        &self,
        id: &CallableId,
        arguments_json: &str,
    ) -> Result<ToolResult, ToolRegistryError> {
        let entry = self
            .entries
            .get(id)
            .ok_or_else(|| ToolRegistryError::Unknown(id.clone()))?;
        if entry.descriptor.policy.requires_permission {
            return Ok(ToolResult {
                output: format!("permission required for tool {id}"),
                success: false,
            });
        }
        Ok(match (entry.handler)(arguments_json) {
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

    fn descriptor(id: &str, requires_permission: bool) -> CallableDescriptor {
        CallableDescriptor {
            id: CallableId::parse(id).unwrap(),
            kind: CallableKind::Tool,
            description: "test tool".to_owned(),
            input_schema: json!({"type": "object"}),
            output_schema: json!({"type": "string"}),
            capabilities: CapabilitySet::default(),
            policy: CallablePolicy {
                requires_permission,
            },
        }
    }

    #[test]
    fn rejects_duplicate_tools() {
        let mut registry = ToolRegistry::default();
        registry
            .register(descriptor("echo", false), |_| Ok("ok".to_owned()))
            .unwrap();
        assert_eq!(
            registry.register(descriptor("echo", false), |_| Ok("ok".to_owned())),
            Err(ToolRegistryError::Duplicate(
                CallableId::parse("echo").unwrap()
            ))
        );
    }

    #[test]
    fn permission_policy_denies_without_executing_handler() {
        let called = Arc::new(AtomicBool::new(false));
        let marker = called.clone();
        let mut registry = ToolRegistry::default();
        registry
            .register(descriptor("guarded", true), move |_| {
                marker.store(true, Ordering::SeqCst);
                Ok("should not execute".to_owned())
            })
            .unwrap();
        let result = registry
            .invoke(&CallableId::parse("guarded").unwrap(), "{}")
            .unwrap();
        assert!(!result.success);
        assert!(!called.load(Ordering::SeqCst));
    }
}
