use phenix_core::{
    CallableId, ModelTarget, RoutingProfile, RoutingProfileDescriptor, RoutingProfileId,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
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

#[derive(Clone, Debug, Default)]
pub struct RoutingRegistry {
    profiles: BTreeMap<RoutingProfileId, RoutingProfile>,
}

impl RoutingRegistry {
    pub(crate) fn semantic_manifest(&self) -> Value {
        serde_json::to_value(&self.profiles)
            .expect("routing profiles contain only JSON-serializable values")
    }

    pub fn register(&mut self, profile: RoutingProfile) -> Result<(), RoutingRegistryError> {
        if self.profiles.contains_key(&profile.id) {
            return Err(RoutingRegistryError::Duplicate(profile.id));
        }
        self.profiles.insert(profile.id.clone(), profile);
        Ok(())
    }

    /// Returns the configured routing profiles with the distinct providers that
    /// must be authenticated before the profile can be used.
    #[must_use]
    pub fn descriptors(&self) -> Vec<RoutingProfileDescriptor> {
        self.profiles
            .values()
            .map(|profile| {
                let mut providers = BTreeSet::from([profile.default_target.provider.clone()]);
                providers.extend(
                    profile
                        .callable_targets
                        .values()
                        .map(|target| target.provider.clone()),
                );
                RoutingProfileDescriptor {
                    id: profile.id.clone(),
                    providers: providers.into_iter().collect(),
                }
            })
            .collect()
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

    fn model(provider: &str, name: &str) -> ModelTarget {
        ModelTarget {
            backend: BackendId::parse("mock").unwrap(),
            provider: ProviderId::parse(provider).unwrap(),
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
                default_target: model("mock", "root"),
                callable_targets: BTreeMap::from([(agent.clone(), model("mock", "scout"))]),
            })
            .unwrap();
        assert_eq!(
            routing
                .resolve(&RoutingProfileId::parse("default").unwrap(), Some(&agent))
                .unwrap(),
            model("mock", "scout")
        );
    }

    #[test]
    fn catalog_is_sorted_and_lists_every_distinct_provider() {
        let agent = CallableId::parse("agent.scout").unwrap();
        let mut routing = RoutingRegistry::default();
        routing
            .register(RoutingProfile {
                id: RoutingProfileId::parse("router.zeta").unwrap(),
                default_target: model("openai-codex", "root"),
                callable_targets: BTreeMap::from([(agent.clone(), model("opencode-go", "scout"))]),
            })
            .unwrap();
        routing
            .register(RoutingProfile {
                id: RoutingProfileId::parse("router.alpha").unwrap(),
                default_target: model("openai-api", "root"),
                callable_targets: BTreeMap::from([(agent, model("openai-api", "scout"))]),
            })
            .unwrap();

        assert_eq!(
            routing.descriptors(),
            vec![
                RoutingProfileDescriptor {
                    id: RoutingProfileId::parse("router.alpha").unwrap(),
                    providers: vec![ProviderId::parse("openai-api").unwrap()],
                },
                RoutingProfileDescriptor {
                    id: RoutingProfileId::parse("router.zeta").unwrap(),
                    providers: vec![
                        ProviderId::parse("openai-codex").unwrap(),
                        ProviderId::parse("opencode-go").unwrap(),
                    ],
                },
            ]
        );
    }
}
