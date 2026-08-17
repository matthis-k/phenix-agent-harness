use genai::adapter::AdapterKind;
use genai::resolver::{AuthData, Endpoint};
use genai::{ModelIden, ServiceTarget};
use phenix_backend::BackendError;

pub(crate) const OPENAI_API_PROVIDER: &str = "openai-api";
pub(crate) const OPENCODE_ZEN_PROVIDER: &str = "opencode-zen";
pub(crate) const OPENCODE_GO_PROVIDER: &str = "opencode-go";
pub(crate) const OPEN_ROUTER_PROVIDER: &str = "open-router";

pub(crate) const DEFAULT_MODELS: &[&str] = &[
    "openai-codex/gpt-5.6-terra",
    "openai-codex/gpt-5.6-sol",
    "openai-codex/gpt-5.6-luna",
    "openai-api/gpt-5.6-terra",
    "openai-api/gpt-5.6-sol",
    "openai-api/gpt-5.6-luna",
    "opencode-go/gpt-5.6-luna",
    "opencode-go/deepseek-v4-flash",
    "opencode-go/mimo-v2.5",
    "opencode-go/minimax-m3",
    "opencode-go/qwen3.7-plus",
    "opencode-zen/gpt-5.6-terra",
    "opencode-zen/gpt-5.6-sol",
    "opencode-zen/gpt-5.6-luna",
    "opencode-zen/claude-sonnet-5",
    "opencode-zen/qwen3.7-plus",
    "opencode-zen/deepseek-v4-flash",
    "opencode-zen/mimo-v2.5-free",
    "open-router/openrouter/auto",
];

const OPENCODE_ZEN_ENDPOINT: &str = "https://opencode.ai/zen/v1/";
const OPENCODE_GO_ENDPOINT: &str = "https://opencode.ai/zen/go/v1/";
const OPENAI_API_KEY_ENV: &str = "OPENAI_API_KEY";
const OPENCODE_API_KEY_ENV: &str = "OPENCODE_API_KEY";
const OPENCODE_GO_API_KEY_ENV: &str = "OPENCODE_GO_API_KEY";
const OPEN_ROUTER_API_KEY_ENV: &str = "OPEN_ROUTER_API_KEY";

pub(crate) fn is_gateway_provider(provider: &str) -> bool {
    matches!(
        provider,
        "opencode" | OPENCODE_ZEN_PROVIDER | OPENCODE_GO_PROVIDER
    )
}

pub(crate) fn validate_gateway_model(provider: &str, model: &str) -> Result<(), BackendError> {
    gateway_adapter(provider, model).map(|_| ())
}

pub(crate) fn gateway_target(
    provider: &str,
    model: &str,
) -> Result<Option<ServiceTarget>, BackendError> {
    let (endpoint, auth_names) = match provider {
        "opencode" | OPENCODE_ZEN_PROVIDER => (OPENCODE_ZEN_ENDPOINT, &[OPENCODE_API_KEY_ENV][..]),
        OPENCODE_GO_PROVIDER => (
            OPENCODE_GO_ENDPOINT,
            &[OPENCODE_API_KEY_ENV, OPENCODE_GO_API_KEY_ENV][..],
        ),
        _ => return Ok(None),
    };
    let adapter_kind = gateway_adapter(provider, model)?;
    Ok(Some(ServiceTarget {
        endpoint: Endpoint::from_static(endpoint),
        auth: auth_from_environment(auth_names),
        model: ModelIden::new(adapter_kind, model),
    }))
}

pub(crate) fn canonical_auth_provider(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" | "openai-responses" | OPENAI_API_PROVIDER => Some(OPENAI_API_PROVIDER),
        "openai-codex" => Some("openai-codex"),
        "opencode" | OPENCODE_ZEN_PROVIDER => Some(OPENCODE_ZEN_PROVIDER),
        OPENCODE_GO_PROVIDER => Some(OPENCODE_GO_PROVIDER),
        "openrouter" | OPEN_ROUTER_PROVIDER => Some(OPEN_ROUTER_PROVIDER),
        _ => None,
    }
}

pub(crate) fn environment_authenticated(provider: &str) -> bool {
    match provider {
        OPENAI_API_PROVIDER => has_environment_secret(&[OPENAI_API_KEY_ENV]),
        OPENCODE_ZEN_PROVIDER => has_environment_secret(&[OPENCODE_API_KEY_ENV]),
        OPENCODE_GO_PROVIDER => {
            has_environment_secret(&[OPENCODE_API_KEY_ENV, OPENCODE_GO_API_KEY_ENV])
        }
        OPEN_ROUTER_PROVIDER => has_environment_secret(&[OPEN_ROUTER_API_KEY_ENV]),
        _ => false,
    }
}

pub(crate) fn environment_description(provider: &str) -> Option<&'static str> {
    match provider {
        OPENAI_API_PROVIDER => Some("OpenAI API key from OPENAI_API_KEY"),
        OPENCODE_ZEN_PROVIDER => Some("OpenCode Zen API key from OPENCODE_API_KEY"),
        OPENCODE_GO_PROVIDER => {
            Some("OpenCode Go API key from OPENCODE_API_KEY or OPENCODE_GO_API_KEY")
        }
        OPEN_ROUTER_PROVIDER => Some("OpenRouter API key from OPEN_ROUTER_API_KEY"),
        _ => None,
    }
}

pub(crate) fn environment_name(provider: &str) -> Option<&'static str> {
    match provider {
        OPENAI_API_PROVIDER => Some("OpenAI API key"),
        OPENCODE_ZEN_PROVIDER => Some("OpenCode Zen API key"),
        OPENCODE_GO_PROVIDER => Some("OpenCode Go API key"),
        OPEN_ROUTER_PROVIDER => Some("OpenRouter API key"),
        _ => None,
    }
}

fn gateway_adapter(provider: &str, model: &str) -> Result<AdapterKind, BackendError> {
    match provider {
        "opencode" | OPENCODE_ZEN_PROVIDER => zen_adapter(model),
        OPENCODE_GO_PROVIDER => Ok(go_adapter(model)),
        other => Err(BackendError::Unsupported(format!(
            "provider {other:?} is not an OpenCode gateway"
        ))),
    }
}

fn zen_adapter(model: &str) -> Result<AdapterKind, BackendError> {
    if model.starts_with("gemini-") {
        return Err(BackendError::Unsupported(format!(
            "OpenCode Zen model {model:?} requires the Google-native Zen endpoint, which the built-in Phenix backend does not expose yet"
        )));
    }
    if model.starts_with("gpt-") || model.starts_with("grok-") {
        return Ok(AdapterKind::OpenAIResp);
    }
    if model.starts_with("claude-") || model.starts_with("qwen") {
        return Ok(AdapterKind::Anthropic);
    }
    Ok(AdapterKind::OpenAI)
}

fn go_adapter(model: &str) -> AdapterKind {
    if model.starts_with("gpt-") {
        return AdapterKind::OpenAIResp;
    }
    if model.starts_with("minimax-") || model.starts_with("qwen") {
        return AdapterKind::Anthropic;
    }
    AdapterKind::OpenAI
}

fn auth_from_environment(names: &[&'static str]) -> AuthData {
    for name in names {
        if let Ok(secret) = std::env::var(name) {
            if !secret.trim().is_empty() {
                return AuthData::from_single(secret);
            }
        }
    }
    AuthData::from_env(names[0])
}

fn has_environment_secret(names: &[&str]) -> bool {
    names.iter().any(|name| {
        std::env::var(name)
            .ok()
            .is_some_and(|value| !value.trim().is_empty())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_catalog_covers_requested_provider_classes() {
        for provider in [
            "openai-codex",
            OPENAI_API_PROVIDER,
            OPENCODE_GO_PROVIDER,
            OPENCODE_ZEN_PROVIDER,
            OPEN_ROUTER_PROVIDER,
        ] {
            assert!(
                DEFAULT_MODELS
                    .iter()
                    .any(|model| model.starts_with(&format!("{provider}/"))),
                "missing default model for {provider}"
            );
        }
        assert!(!DEFAULT_MODELS.contains(&"openai-codex/gpt-5.6"));
    }

    #[test]
    fn opencode_go_uses_each_current_wire_protocol() {
        assert_eq!(go_adapter("gpt-5.6-luna"), AdapterKind::OpenAIResp);
        assert_eq!(go_adapter("qwen3.7-plus"), AdapterKind::Anthropic);
        assert_eq!(go_adapter("minimax-m3"), AdapterKind::Anthropic);
        assert_eq!(go_adapter("deepseek-v4-flash"), AdapterKind::OpenAI);
    }

    #[test]
    fn opencode_zen_uses_each_current_wire_protocol() {
        assert_eq!(
            zen_adapter("gpt-5.6-terra").unwrap(),
            AdapterKind::OpenAIResp
        );
        assert_eq!(
            zen_adapter("claude-sonnet-5").unwrap(),
            AdapterKind::Anthropic
        );
        assert_eq!(zen_adapter("qwen3.7-plus").unwrap(), AdapterKind::Anthropic);
        assert_eq!(
            zen_adapter("deepseek-v4-flash").unwrap(),
            AdapterKind::OpenAI
        );
        assert!(matches!(
            zen_adapter("gemini-3.6-flash"),
            Err(BackendError::Unsupported(_))
        ));
    }
}
