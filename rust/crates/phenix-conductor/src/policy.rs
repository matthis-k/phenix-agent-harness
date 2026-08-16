use crate::PreparedInvocation;
use phenix_core::{CallableDescriptor, CallableId, ConfigRevisionId, ExecutionId, SessionId};
use std::fmt::{self, Debug, Display, Formatter};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CallableOperation {
    StartAgent,
    StartWorkflow,
    StartWorkflowStep,
    InvokeTool,
}

#[derive(Debug)]
pub enum InvocationSubject<'a> {
    Callable {
        descriptor: &'a CallableDescriptor,
        operation: CallableOperation,
    },
    Model {
        invocation: &'a PreparedInvocation,
    },
}

#[derive(Debug)]
pub struct InvocationPolicyContext<'a> {
    pub session_id: &'a SessionId,
    pub execution_id: &'a ExecutionId,
    pub config_revision: &'a ConfigRevisionId,
    pub subject: InvocationSubject<'a>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyDenial {
    pub code: String,
    pub message: String,
    pub callable: Option<CallableId>,
}

impl PolicyDenial {
    #[must_use]
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            callable: None,
        }
    }

    #[must_use]
    pub fn for_callable(mut self, callable: CallableId) -> Self {
        self.callable = Some(callable);
        self
    }

    #[must_use]
    pub fn permission_required(callable: &CallableId) -> Self {
        Self::new(
            "permission_required",
            format!("permission is required for callable {callable}"),
        )
        .for_callable(callable.clone())
    }
}

impl Display for PolicyDenial {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PolicyDenial {}

pub trait InvocationGuard: Send + Sync {
    fn check(&self, context: &InvocationPolicyContext<'_>) -> Result<(), PolicyDenial>;
}

#[derive(Debug, Default)]
pub struct CallablePermissionGuard;

impl InvocationGuard for CallablePermissionGuard {
    fn check(&self, context: &InvocationPolicyContext<'_>) -> Result<(), PolicyDenial> {
        let InvocationSubject::Callable { descriptor, .. } = &context.subject else {
            return Ok(());
        };
        if descriptor.policy.requires_permission {
            return Err(PolicyDenial::permission_required(&descriptor.id));
        }
        Ok(())
    }
}

pub struct InvocationPolicy {
    guards: Vec<Arc<dyn InvocationGuard>>,
}

impl InvocationPolicy {
    #[must_use]
    pub fn new() -> Self {
        Self {
            guards: vec![Arc::new(CallablePermissionGuard)],
        }
    }

    pub fn register<G>(&mut self, guard: G)
    where
        G: InvocationGuard + 'static,
    {
        self.guards.push(Arc::new(guard));
    }

    pub fn check(&self, context: &InvocationPolicyContext<'_>) -> Result<(), PolicyDenial> {
        for guard in &self.guards {
            guard.check(context)?;
        }
        Ok(())
    }

    #[must_use]
    pub fn guard_count(&self) -> usize {
        self.guards.len()
    }
}

impl Default for InvocationPolicy {
    fn default() -> Self {
        Self::new()
    }
}

impl Debug for InvocationPolicy {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.debug_struct("InvocationPolicy")
            .field("guard_count", &self.guards.len())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_core::{CallableKind, CallablePolicy, CapabilitySet};
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn descriptor(requires_permission: bool) -> CallableDescriptor {
        CallableDescriptor {
            id: CallableId::parse("guarded").unwrap(),
            kind: CallableKind::Agent,
            description: "test callable".to_owned(),
            input_schema: json!({"type": "object"}),
            output_schema: json!({"type": "object"}),
            capabilities: CapabilitySet::default(),
            policy: CallablePolicy {
                requires_permission,
            },
        }
    }

    fn ids() -> (SessionId, ExecutionId, ConfigRevisionId) {
        (
            SessionId::parse("session").unwrap(),
            ExecutionId::parse("execution").unwrap(),
            ConfigRevisionId::parse("config").unwrap(),
        )
    }

    #[test]
    fn builtin_permission_guard_preserves_permission_required_policy() {
        let descriptor = descriptor(true);
        let (session_id, execution_id, config_revision) = ids();
        let context = InvocationPolicyContext {
            session_id: &session_id,
            execution_id: &execution_id,
            config_revision: &config_revision,
            subject: InvocationSubject::Callable {
                descriptor: &descriptor,
                operation: CallableOperation::StartAgent,
            },
        };

        let denial = InvocationPolicy::new().check(&context).unwrap_err();
        assert_eq!(denial.code, "permission_required");
        assert_eq!(denial.callable.as_ref(), Some(&descriptor.id));
    }

    struct RecordingGuard {
        name: &'static str,
        calls: Arc<Mutex<Vec<&'static str>>>,
        deny: bool,
    }

    impl InvocationGuard for RecordingGuard {
        fn check(&self, _context: &InvocationPolicyContext<'_>) -> Result<(), PolicyDenial> {
            self.calls.lock().unwrap().push(self.name);
            if self.deny {
                Err(PolicyDenial::new("test_denial", self.name))
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn guards_run_in_registration_order_and_stop_after_denial() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut policy = InvocationPolicy::new();
        policy.register(RecordingGuard {
            name: "first",
            calls: calls.clone(),
            deny: false,
        });
        policy.register(RecordingGuard {
            name: "second",
            calls: calls.clone(),
            deny: true,
        });
        policy.register(RecordingGuard {
            name: "third",
            calls: calls.clone(),
            deny: false,
        });

        let descriptor = descriptor(false);
        let (session_id, execution_id, config_revision) = ids();
        let context = InvocationPolicyContext {
            session_id: &session_id,
            execution_id: &execution_id,
            config_revision: &config_revision,
            subject: InvocationSubject::Callable {
                descriptor: &descriptor,
                operation: CallableOperation::InvokeTool,
            },
        };

        assert_eq!(policy.check(&context).unwrap_err().code, "test_denial");
        assert_eq!(*calls.lock().unwrap(), vec!["first", "second"]);
    }
}
