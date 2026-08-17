use phenix_core::{
    AuthenticationInput, AuthenticationMethodId, AuthenticationMethodKind, AuthenticationState,
    ModelDescriptor, ProviderId,
};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthenticationMethodCapability {
    pub id: AuthenticationMethodId,
    pub kind: AuthenticationMethodKind,
    pub name: String,
    pub description: Option<String>,
}

/// One interchangeable authentication mechanism for a provider. Implementors
/// may use OAuth, API keys, environment credentials, or another provider-native
/// flow, but they never identify an execution backend.
pub trait AuthenticationStrategy: Send {
    fn provider(&self) -> &ProviderId;
    fn capability(&self) -> AuthenticationMethodCapability;
    fn state(&mut self) -> Result<AuthenticationState, AuthenticationError>;
    fn authenticate(
        &mut self,
        input: Option<&AuthenticationInput>,
    ) -> Result<(), AuthenticationError>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderAuthentication {
    pub provider: ProviderId,
    pub state: AuthenticationState,
    pub methods: Vec<AuthenticationMethodCapability>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthenticationError {
    DuplicateMethod {
        provider: ProviderId,
        method: AuthenticationMethodId,
    },
    UnknownProvider(ProviderId),
    UnknownMethod {
        provider: ProviderId,
        method: AuthenticationMethodId,
    },
    Failed(String),
}

impl Display for AuthenticationError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateMethod { provider, method } => write!(
                f,
                "authentication strategy already registered: {provider}/{method}"
            ),
            Self::UnknownProvider(provider) => write!(
                f,
                "no authentication strategies registered for provider {provider}"
            ),
            Self::UnknownMethod { provider, method } => write!(
                f,
                "unknown authentication method {method} for provider {provider}"
            ),
            Self::Failed(message) => f.write_str(message),
        }
    }
}

impl Error for AuthenticationError {}

#[derive(Default)]
pub struct AuthenticationManager {
    strategies: BTreeMap<(ProviderId, AuthenticationMethodId), Box<dyn AuthenticationStrategy>>,
}

impl AuthenticationManager {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register<S>(&mut self, strategy: S) -> Result<(), AuthenticationError>
    where
        S: AuthenticationStrategy + 'static,
    {
        let provider = strategy.provider().clone();
        let method = strategy.capability().id;
        let key = (provider.clone(), method.clone());
        if self.strategies.contains_key(&key) {
            return Err(AuthenticationError::DuplicateMethod { provider, method });
        }
        self.strategies.insert(key, Box::new(strategy));
        Ok(())
    }

    #[must_use]
    pub fn methods(&self, provider: &ProviderId) -> Vec<AuthenticationMethodCapability> {
        self.strategies
            .iter()
            .filter(|((candidate, _), _)| candidate == provider)
            .map(|(_, strategy)| strategy.capability())
            .collect()
    }

    pub fn state(
        &mut self,
        provider: &ProviderId,
    ) -> Result<AuthenticationState, AuthenticationError> {
        let keys = self.provider_keys(provider)?;
        for key in keys {
            if self
                .strategies
                .get_mut(&key)
                .expect("authentication strategy key remains registered")
                .state()?
                == AuthenticationState::Authenticated
            {
                return Ok(AuthenticationState::Authenticated);
            }
        }
        Ok(AuthenticationState::Required)
    }

    pub fn status(
        &mut self,
        provider: &ProviderId,
    ) -> Result<ProviderAuthentication, AuthenticationError> {
        Ok(ProviderAuthentication {
            provider: provider.clone(),
            state: self.state(provider)?,
            methods: self.methods(provider),
        })
    }

    pub fn authenticate(
        &mut self,
        provider: &ProviderId,
        method: &AuthenticationMethodId,
        input: Option<&AuthenticationInput>,
    ) -> Result<ProviderAuthentication, AuthenticationError> {
        let key = (provider.clone(), method.clone());
        let strategy =
            self.strategies
                .get_mut(&key)
                .ok_or_else(|| AuthenticationError::UnknownMethod {
                    provider: provider.clone(),
                    method: method.clone(),
                })?;
        strategy.authenticate(input)?;
        self.status(provider)
    }

    fn provider_keys(
        &self,
        provider: &ProviderId,
    ) -> Result<Vec<(ProviderId, AuthenticationMethodId)>, AuthenticationError> {
        let keys = self
            .strategies
            .keys()
            .filter(|(candidate, _)| candidate == provider)
            .cloned()
            .collect::<Vec<_>>();
        if keys.is_empty() {
            return Err(AuthenticationError::UnknownProvider(provider.clone()));
        }
        Ok(keys)
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ModelCatalogSource {
    Dynamic,
    BackendAdvertised,
    StaticFallback,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DiscoveredModelCatalog {
    pub provider: ProviderId,
    pub source: ModelCatalogSource,
    pub models: Vec<ModelDescriptor>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModelDiscoveryError {
    UnknownProvider(ProviderId),
    Unsupported(ProviderId),
    Failed(String),
}

impl Display for ModelDiscoveryError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownProvider(provider) => {
                write!(
                    f,
                    "no model discovery strategies registered for provider {provider}"
                )
            }
            Self::Unsupported(provider) => {
                write!(f, "model discovery is unavailable for provider {provider}")
            }
            Self::Failed(message) => f.write_str(message),
        }
    }
}

impl Error for ModelDiscoveryError {}

/// One model-discovery mechanism bound to one provider. External API, CLI, or
/// ACP translation belongs in the adapter implementing this strategy. The
/// provider service owns preference and fallback policy.
pub trait ModelDiscoveryStrategy: Send {
    fn provider(&self) -> &ProviderId;
    fn source(&self) -> ModelCatalogSource;
    fn discover(&mut self) -> Result<Vec<ModelDescriptor>, ModelDiscoveryError>;
}

#[derive(Default)]
pub struct ModelDiscoveryService {
    strategies: BTreeMap<ProviderId, Vec<Box<dyn ModelDiscoveryStrategy>>>,
}

impl ModelDiscoveryService {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register<S>(&mut self, strategy: S)
    where
        S: ModelDiscoveryStrategy + 'static,
    {
        let provider = strategy.provider().clone();
        let strategies = self.strategies.entry(provider).or_default();
        strategies.push(Box::new(strategy));
        strategies.sort_by_key(|strategy| strategy.source());
    }

    pub fn discover(
        &mut self,
        provider: &ProviderId,
    ) -> Result<DiscoveredModelCatalog, ModelDiscoveryError> {
        let strategies = self
            .strategies
            .get_mut(provider)
            .ok_or_else(|| ModelDiscoveryError::UnknownProvider(provider.clone()))?;
        for strategy in strategies {
            let source = strategy.source();
            match strategy.discover() {
                Ok(models) if !models.is_empty() => {
                    return Ok(DiscoveredModelCatalog {
                        provider: provider.clone(),
                        source,
                        models,
                    });
                }
                Ok(_) | Err(ModelDiscoveryError::Unsupported(_)) => continue,
                Err(error) => return Err(error),
            }
        }
        Err(ModelDiscoveryError::Unsupported(provider.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_core::{BackendId, InferenceOptions, ModelId, ModelTarget};

    struct TestAuthenticationStrategy {
        provider: ProviderId,
        capability: AuthenticationMethodCapability,
        authenticated: bool,
    }

    impl AuthenticationStrategy for TestAuthenticationStrategy {
        fn provider(&self) -> &ProviderId {
            &self.provider
        }

        fn capability(&self) -> AuthenticationMethodCapability {
            self.capability.clone()
        }

        fn state(&mut self) -> Result<AuthenticationState, AuthenticationError> {
            Ok(if self.authenticated {
                AuthenticationState::Authenticated
            } else {
                AuthenticationState::Required
            })
        }

        fn authenticate(
            &mut self,
            _input: Option<&AuthenticationInput>,
        ) -> Result<(), AuthenticationError> {
            self.authenticated = true;
            Ok(())
        }
    }

    enum DiscoveryResult {
        Unsupported,
        Models(Vec<ModelDescriptor>),
        Failed,
    }

    struct TestDiscoveryStrategy {
        provider: ProviderId,
        source: ModelCatalogSource,
        result: Option<DiscoveryResult>,
    }

    impl ModelDiscoveryStrategy for TestDiscoveryStrategy {
        fn provider(&self) -> &ProviderId {
            &self.provider
        }

        fn source(&self) -> ModelCatalogSource {
            self.source
        }

        fn discover(&mut self) -> Result<Vec<ModelDescriptor>, ModelDiscoveryError> {
            match self.result.take().expect("test strategy is called once") {
                DiscoveryResult::Unsupported => {
                    Err(ModelDiscoveryError::Unsupported(self.provider.clone()))
                }
                DiscoveryResult::Models(models) => Ok(models),
                DiscoveryResult::Failed => {
                    Err(ModelDiscoveryError::Failed("dynamic failure".to_owned()))
                }
            }
        }
    }

    fn provider(value: &str) -> ProviderId {
        ProviderId::parse(value).unwrap()
    }

    fn method(value: &str, kind: AuthenticationMethodKind) -> AuthenticationMethodCapability {
        AuthenticationMethodCapability {
            id: AuthenticationMethodId::parse(value).unwrap(),
            kind,
            name: value.to_owned(),
            description: None,
        }
    }

    fn descriptor(provider: &ProviderId) -> ModelDescriptor {
        ModelDescriptor {
            target: ModelTarget {
                backend: BackendId::parse("mock").unwrap(),
                provider: provider.clone(),
                model: ModelId::parse("mock-model").unwrap(),
                inference: InferenceOptions::default(),
            },
            name: "Mock model".to_owned(),
            selectable: true,
        }
    }

    #[test]
    fn authentication_manager_is_provider_scoped_not_backend_scoped() {
        let provider = provider("openai");
        let capability = method("oauth", AuthenticationMethodKind::Agent);
        let mut manager = AuthenticationManager::new();
        manager
            .register(TestAuthenticationStrategy {
                provider: provider.clone(),
                capability: capability.clone(),
                authenticated: false,
            })
            .unwrap();

        let status = manager.status(&provider).unwrap();
        assert_eq!(status.state, AuthenticationState::Required);
        assert_eq!(status.methods, vec![capability.clone()]);

        let status = manager
            .authenticate(&provider, &capability.id, None)
            .unwrap();
        assert_eq!(status.state, AuthenticationState::Authenticated);
    }

    #[test]
    fn same_auth_method_id_can_exist_for_different_providers() {
        let openai = provider("openai");
        let other = provider("other");
        let mut manager = AuthenticationManager::new();
        for provider in [openai.clone(), other.clone()] {
            manager
                .register(TestAuthenticationStrategy {
                    provider,
                    capability: method("api-key", AuthenticationMethodKind::ApiKey),
                    authenticated: false,
                })
                .unwrap();
        }

        assert_eq!(manager.methods(&openai).len(), 1);
        assert_eq!(manager.methods(&other).len(), 1);
    }

    #[test]
    fn runtime_discovery_is_preferred_even_when_registered_after_fallback() {
        let provider = provider("openrouter");
        let expected = descriptor(&provider);
        let mut discovery = ModelDiscoveryService::new();
        discovery.register(TestDiscoveryStrategy {
            provider: provider.clone(),
            source: ModelCatalogSource::StaticFallback,
            result: Some(DiscoveryResult::Models(vec![])),
        });
        discovery.register(TestDiscoveryStrategy {
            provider: provider.clone(),
            source: ModelCatalogSource::Dynamic,
            result: Some(DiscoveryResult::Models(vec![expected.clone()])),
        });

        let catalog = discovery.discover(&provider).unwrap();
        assert_eq!(catalog.source, ModelCatalogSource::Dynamic);
        assert_eq!(catalog.models, vec![expected]);
    }

    #[test]
    fn unavailable_runtime_discovery_falls_back_to_static_catalog() {
        let provider = provider("openrouter");
        let expected = descriptor(&provider);
        let mut discovery = ModelDiscoveryService::new();
        discovery.register(TestDiscoveryStrategy {
            provider: provider.clone(),
            source: ModelCatalogSource::Dynamic,
            result: Some(DiscoveryResult::Unsupported),
        });
        discovery.register(TestDiscoveryStrategy {
            provider: provider.clone(),
            source: ModelCatalogSource::StaticFallback,
            result: Some(DiscoveryResult::Models(vec![expected.clone()])),
        });

        let catalog = discovery.discover(&provider).unwrap();
        assert_eq!(catalog.source, ModelCatalogSource::StaticFallback);
        assert_eq!(catalog.models, vec![expected]);
    }

    #[test]
    fn runtime_discovery_failures_are_not_hidden_by_static_models() {
        let provider = provider("openrouter");
        let mut discovery = ModelDiscoveryService::new();
        discovery.register(TestDiscoveryStrategy {
            provider: provider.clone(),
            source: ModelCatalogSource::Dynamic,
            result: Some(DiscoveryResult::Failed),
        });
        discovery.register(TestDiscoveryStrategy {
            provider: provider.clone(),
            source: ModelCatalogSource::StaticFallback,
            result: Some(DiscoveryResult::Models(vec![descriptor(&provider)])),
        });

        assert_eq!(
            discovery.discover(&provider),
            Err(ModelDiscoveryError::Failed("dynamic failure".to_owned()))
        );
    }

    #[test]
    fn discovery_does_not_cross_provider_boundaries() {
        let openrouter = provider("openrouter");
        let openai = provider("openai");
        let mut discovery = ModelDiscoveryService::new();
        discovery.register(TestDiscoveryStrategy {
            provider: openrouter,
            source: ModelCatalogSource::Dynamic,
            result: Some(DiscoveryResult::Models(vec![])),
        });

        assert_eq!(
            discovery.discover(&openai),
            Err(ModelDiscoveryError::UnknownProvider(openai))
        );
    }
}
