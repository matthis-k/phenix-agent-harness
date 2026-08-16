#![forbid(unsafe_code)]

/// Minimal conductor spine. Runtime state/execution semantics are added in R3;
/// this crate deliberately owns no ACP types.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeHealth {
    Starting,
    Ready,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConductorRuntime {
    health: RuntimeHealth,
}

impl ConductorRuntime {
    #[must_use]
    pub fn new() -> Self {
        Self {
            health: RuntimeHealth::Starting,
        }
    }
    #[must_use]
    pub fn health(&self) -> &RuntimeHealth {
        &self.health
    }
    pub fn mark_ready(&mut self) {
        self.health = RuntimeHealth::Ready;
    }
}
impl Default for ConductorRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn conductor_spine_is_protocol_and_backend_neutral() {
        let mut runtime = ConductorRuntime::new();
        runtime.mark_ready();
        assert_eq!(runtime.health(), &RuntimeHealth::Ready);
    }
}
