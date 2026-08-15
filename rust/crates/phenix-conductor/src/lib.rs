#![forbid(unsafe_code)]

use phenix_runtime_api::BackendHealth;

/// Minimal application-runtime spine retained across the purge.
///
/// Functionality is intentionally reintroduced here rather than through ACP.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConductorRuntime {
    health: BackendHealth,
}

impl ConductorRuntime {
    #[must_use]
    pub fn new() -> Self {
        Self {
            health: BackendHealth::Starting,
        }
    }

    #[must_use]
    pub fn health(&self) -> &BackendHealth {
        &self.health
    }

    pub fn mark_ready(&mut self) {
        self.health = BackendHealth::Ready;
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
    fn conductor_owns_runtime_lifecycle() {
        let mut runtime = ConductorRuntime::new();
        assert_eq!(runtime.health(), &BackendHealth::Starting);
        runtime.mark_ready();
        assert_eq!(runtime.health(), &BackendHealth::Ready);
    }
}
