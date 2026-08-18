use phenix_core::{CallableId, ModelTarget, RoutingProfile, RoutingProfileId};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoutingRegistryError {
    Duplicate(RoutingProfileId),
    Unknown(RoutingProfileId),
}

impl Display for RoutingRegistryError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Duplicate(id) => write!(f, "routing profile already registered: {id}"),
            Self::Unknown(id) => write!(f, "unknown routing profile: {id}"),
        }
    }
}

impl Error for RoutingRegistryError {}

#[derive(Debug, Default)]
pub struct RoutingRegistry {
    profiles: BTreeMap<RoutingProfileId, RoutingProfile>,
}

impl RoutingRegistry {
    pub fn register(&mut self, profile: RoutingProfile) -> Result<(), RoutingRegistryError> {
        if self.profiles.contains_key(&profile.id) {
            return Err(RoutingRegistryError::Duplicate(profile.id));
        }
        self.profiles.insert(profile.id.clone(), profile);
        Ok(())
    }

    /// Returns the configured profile identifiers in stable lexical order.
    #[must_use]
    pub fn profiles(&self) -> Vec<RoutingProfileId> {
        self.profiles.keys().cloned().collect()
    }

    pub fn resolve(
        &self,
        profile: &RoutingProfileId,
        callable: Option<&CallableId>,
    ) -> Result<ModelTarget, RoutingRegistryError> {
        let profile = self
            .profiles
            .get(profile)
            .ok_or_else(|| RoutingRegistryError::Unknown(profile.clone()))?;
        Ok(callable
            .and_then(|id| profile.callable_targets.get(id))
            .unwrap_or(&profile.default_target)
            .clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_core::{BackendId, InferenceOptions, ModelId, ProviderId};

    fn model(name: &str) -> ModelTarget {
        ModelTarget {
            backend: BackendId::parse("mock").unwrap(),
            provider: ProviderId::parse("mock").unwrap(),
            model: ModelId::parse(name).unwrap(),
            inference: InferenceOptions::default(),
        }
    }

    #[test]
    fn callable_override_wins_over_profile_default() {
        let agent = CallableId::parse("agent.scout").unwrap();
        let mut routing = RoutingRegistry::default();
        routing
            .register(RoutingProfile {
                id: RoutingProfileId::parse("default").unwrap(),
                default_target: model("root"),
                callable_targets: BTreeMap::from([(agent.clone(), model("scout"))]),
            })
            .unwrap();
        assert_eq!(
            routing
                .resolve(&RoutingProfileId::parse("default").unwrap(), Some(&agent))
                .unwrap(),
            model("scout")
        );
    }

    #[test]
    fn catalog_is_deterministically_sorted_by_profile_id() {
        let mut routing = RoutingRegistry::default();
        for id in ["router.zeta", "router.alpha"] {
            routing
                .register(RoutingProfile {
                    id: RoutingProfileId::parse(id).unwrap(),
                    default_target: model(id),
                    callable_targets: BTreeMap::new(),
                })
                .unwrap();
        }
        assert_eq!(
            routing.profiles(),
            vec![
                RoutingProfileId::parse("router.alpha").unwrap(),
                RoutingProfileId::parse("router.zeta").unwrap(),
            ]
        );
    }
}
