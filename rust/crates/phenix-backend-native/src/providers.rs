use crate::credentials::CredentialStore;
use genai::adapter::AdapterKind;
use genai::resolver::{AuthData, Endpoint};
use genai::{ModelIden, ServiceTarget};
use phenix_backend::BackendError;
use phenix_core::{ModelId, ProviderId};

pub(crate) const OPENAI_API_PROVIDER: &str = "openai-api";
pub(crate) const ANTHROPIC_PROVIDER: &str = "anthropic";
pub(crate) const GEMINI_PROVIDER: &str = "gemini";
pub(crate) const GITHUB_COPILOT_PROVIDER: &str = "github-copilot";
pub(crate) const OPENCODE_ZEN_PROVIDER: &str = "opencode-zen";
pub(crate) const OPENCODE_GO_PROVIDER: &str = "opencode-go";
pub(crate) const OPEN_ROUTER_PROVIDER: &str = "open-router";
pub(crate) const OLLAMA_PROVIDER: &str = "ollama";
pub(crate) const OLLAMA_CLOUD_PROVIDER: &str = "ollama-cloud";
pub(crate) const DEEPSEEK_PROVIDER: &str = "deepseek";
pub(crate) const GROQ_PROVIDER: &str = "groq";
pub(crate) const XAI_PROVIDER: &str = "xai";

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
const ANTHROPIC_API_KEY_ENV: &str = "ANTHROPIC_API_KEY";
const GEMINI_API_KEY_ENV: &str = "GEMINI_API_KEY";
const GOOGLE_API_KEY_ENV: &str = "GOOGLE_API_KEY";
const GITHUB_COPILOT_TOKEN_ENV: &str = "COPILOT_GITHUB_TOKEN";
const GH_TOKEN_ENV: &str = "GH_TOKEN";
const GITHUB_TOKEN_ENV: &str = "GITHUB_TOKEN";
const OPENCODE_API_KEY_ENV: &str = "OPENCODE_API_KEY";
const OPENCODE_GO_API_KEY_ENV: &str = "OPENCODE_GO_API_KEY";
const OPEN_ROUTER_API_KEY_ENV: &str = "OPEN_ROUTER_API_KEY";
const OPENROUTER_API_KEY_ENV: &str = "OPENROUTER_API_KEY";
const OLLAMA_API_KEY_ENV: &str = "OLLAMA_API_KEY";
const DEEPSEEK_API_KEY_ENV: &str = "DEEPSEEK_API_KEY";
const GROQ_API_KEY_ENV: &str = "GROQ_API_KEY";
const XAI_API_KEY_ENV: &str = "XAI_API_KEY";

pub(crate) fn is_gateway_provider(provider: &ProviderId) -> bool {
    matches!(
        provider.as_str(),
        OPENCODE_ZEN_PROVIDER | OPENCODE_GO_PROVIDER
    )
}

pub(crate) fn validate_gateway_model(
    provider: &ProviderId,
    model: &ModelId,
) -> Result<(), BackendError> {
    gateway_adapter(provider, model).map(|_| ())
}

pub(crate) fn gateway_target(
    credentials: &CredentialStore,
    provider: &ProviderId,
    model: &ModelId,
) -> Result<Option<ServiceTarget>, BackendError> {
    let (credential_provider, endpoint, auth_names) = match provider.as_str() {
        OPENCODE_ZEN_PROVIDER => (
            OPENCODE_ZEN_PROVIDER,
            OPENCODE_ZEN_ENDPOINT,
            &[OPENCODE_API_KEY_ENV][..],
        ),
        OPENCODE_GO_PROVIDER => (
            OPENCODE_GO_PROVIDER,
            OPENCODE_GO_ENDPOINT,
            &[OPENCODE_API_KEY_ENV, OPENCODE_GO_API_KEY_ENV][..],
        ),
        _ => return Ok(None),
    };
    let adapter_kind = gateway_adapter(provider, model)?;
    let auth = match credentials
        .api_key(credential_provider)
        .map_err(BackendError::Protocol)?
    {
        Some(secret) => AuthData::from_single(secret),
        None => auth_from_environment(auth_names),
    };
    Ok(Some(ServiceTarget {
        endpoint: Endpoint::from_static(endpoint),
        auth,
        model: ModelIden::new(adapter_kind, model.as_str()),
    }))
}

pub(crate) fn canonical_auth_provider(provider: &ProviderId) -> Option<&'static str> {
    match provider.as_str() {
        OPENAI_API_PROVIDER => Some(OPENAI_API_PROVIDER),
        "openai-codex" => Some("openai-codex"),
        ANTHROPIC_PROVIDER => Some(ANTHROPIC_PROVIDER),
        GEMINI_PROVIDER => Some(GEMINI_PROVIDER),
        GITHUB_COPILOT_PROVIDER => Some(GITHUB_COPILOT_PROVIDER),
        OPENCODE_ZEN_PROVIDER => Some(OPENCODE_ZEN_PROVIDER),
        OPENCODE_GO_PROVIDER => Some(OPENCODE_GO_PROVIDER),
        OPEN_ROUTER_PROVIDER => Some(OPEN_ROUTER_PROVIDER),
        OLLAMA_CLOUD_PROVIDER => Some(OLLAMA_CLOUD_PROVIDER),
        DEEPSEEK_PROVIDER => Some(DEEPSEEK_PROVIDER),
        GROQ_PROVIDER => Some(GROQ_PROVIDER),
        XAI_PROVIDER => Some(XAI_PROVIDER),
        _ => None,
    }
}

pub(crate) fn genai_model(provider: &ProviderId, model: &ModelId) -> Result<String, BackendError> {
    let namespace = match provider.as_str() {
        OPENAI_API_PROVIDER | "openai-codex" => "openai_resp",
        ANTHROPIC_PROVIDER => "anthropic",
        GEMINI_PROVIDER => "gemini",
        GITHUB_COPILOT_PROVIDER => "github_copilot",
        OPEN_ROUTER_PROVIDER => "open_router",
        OLLAMA_PROVIDER => "ollama",
        OLLAMA_CLOUD_PROVIDER => "ollama_cloud",
        DEEPSEEK_PROVIDER => "deepseek",
        GROQ_PROVIDER => "groq",
        XAI_PROVIDER => "xai",
        other => {
            return Err(BackendError::Unsupported(format!(
                "unsupported Phenix provider {other:?}"
            )))
        }
    };
    Ok(format!("{namespace}::{}", model.as_str()))
}

pub(crate) fn is_api_key_auth_provider(provider: &str) -> bool {
    matches!(
        provider,
        OPENAI_API_PROVIDER
            | ANTHROPIC_PROVIDER
            | GEMINI_PROVIDER
            | GITHUB_COPILOT_PROVIDER
            | OPENCODE_ZEN_PROVIDER
            | OPENCODE_GO_PROVIDER
            | OPEN_ROUTER_PROVIDER
            | OLLAMA_CLOUD_PROVIDER
            | DEEPSEEK_PROVIDER
            | GROQ_PROVIDER
            | XAI_PROVIDER
    )
}

pub(crate) fn auth_provider_for_adapter(adapter: &str) -> Option<&'static str> {
    match adapter {
        "openai" | "openai_resp" => Some(OPENAI_API_PROVIDER),
        "anthropic" => Some(ANTHROPIC_PROVIDER),
        "gemini" => Some(GEMINI_PROVIDER),
        "github_copilot" => Some(GITHUB_COPILOT_PROVIDER),
        "open_router" => Some(OPEN_ROUTER_PROVIDER),
        "ollama_cloud" => Some(OLLAMA_CLOUD_PROVIDER),
        "deepseek" => Some(DEEPSEEK_PROVIDER),
        "groq" => Some(GROQ_PROVIDER),
        "xai" => Some(XAI_PROVIDER),
        _ => None,
    }
}

pub(crate) fn environment_api_key(provider: &str) -> Option<String> {
    let names: &[&str] = match provider {
        OPENAI_API_PROVIDER => &[OPENAI_API_KEY_ENV],
        ANTHROPIC_PROVIDER => &[ANTHROPIC_API_KEY_ENV],
        GEMINI_PROVIDER => &[GEMINI_API_KEY_ENV, GOOGLE_API_KEY_ENV],
        GITHUB_COPILOT_PROVIDER => &[GITHUB_COPILOT_TOKEN_ENV, GH_TOKEN_ENV, GITHUB_TOKEN_ENV],
        OPENCODE_ZEN_PROVIDER => &[OPENCODE_API_KEY_ENV],
        OPENCODE_GO_PROVIDER => &[OPENCODE_API_KEY_ENV, OPENCODE_GO_API_KEY_ENV],
        OPEN_ROUTER_PROVIDER => &[OPEN_ROUTER_API_KEY_ENV, OPENROUTER_API_KEY_ENV],
        OLLAMA_CLOUD_PROVIDER => &[OLLAMA_API_KEY_ENV],
        DEEPSEEK_PROVIDER => &[DEEPSEEK_API_KEY_ENV],
        GROQ_PROVIDER => &[GROQ_API_KEY_ENV],
        XAI_PROVIDER => &[XAI_API_KEY_ENV],
        _ => return None,
    };
    names.iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .filter(|value| !value.trim().is_empty())
    })
}

pub(crate) fn environment_authenticated(provider: &str) -> bool {
    environment_api_key(provider).is_some()
}

pub(crate) fn environment_description(provider: &str) -> Option<&'static str> {
    match provider {
        OPENAI_API_PROVIDER => Some("Enter an OpenAI API key; OPENAI_API_KEY is also supported"),
        ANTHROPIC_PROVIDER => Some("Enter an Anthropic API key; ANTHROPIC_API_KEY is also supported"),
        GEMINI_PROVIDER => Some(
            "Enter a Google Gemini API key; GEMINI_API_KEY or GOOGLE_API_KEY is also supported",
        ),
        GITHUB_COPILOT_PROVIDER => Some(
            "Enter a GitHub token; COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN is also supported",
        ),
        OPENCODE_ZEN_PROVIDER => Some("Enter an OpenCode Zen API key; OPENCODE_API_KEY is also supported"),
        OPENCODE_GO_PROVIDER => Some(
            "Enter an OpenCode Go API key; OPENCODE_API_KEY or OPENCODE_GO_API_KEY is also supported",
        ),
        OPEN_ROUTER_PROVIDER => Some(
            "Enter an OpenRouter API key; OPEN_ROUTER_API_KEY or OPENROUTER_API_KEY is also supported",
        ),
        OLLAMA_CLOUD_PROVIDER => Some("Enter an Ollama Cloud API key; OLLAMA_API_KEY is also supported"),
        DEEPSEEK_PROVIDER => Some("Enter a DeepSeek API key; DEEPSEEK_API_KEY is also supported"),
        GROQ_PROVIDER => Some("Enter a Groq API key; GROQ_API_KEY is also supported"),
        XAI_PROVIDER => Some("Enter an xAI API key; XAI_API_KEY is also supported"),
        _ => None,
    }
}

pub(crate) fn environment_name(provider: &str) -> Option<&'static str> {
    match provider {
        OPENAI_API_PROVIDER => Some("OpenAI API key"),
        ANTHROPIC_PROVIDER => Some("Anthropic API key"),
        GEMINI_PROVIDER => Some("Google Gemini API key"),
        GITHUB_COPILOT_PROVIDER => Some("GitHub token"),
        OPENCODE_ZEN_PROVIDER => Some("OpenCode Zen API key"),
        OPENCODE_GO_PROVIDER => Some("OpenCode Go API key"),
        OPEN_ROUTER_PROVIDER => Some("OpenRouter API key"),
        OLLAMA_CLOUD_PROVIDER => Some("Ollama Cloud API key"),
        DEEPSEEK_PROVIDER => Some("DeepSeek API key"),
        GROQ_PROVIDER => Some("Groq API key"),
        XAI_PROVIDER => Some("xAI API key"),
        _ => None,
    }
}

fn gateway_adapter(provider: &ProviderId, model: &ModelId) -> Result<AdapterKind, BackendError> {
    match provider.as_str() {
        OPENCODE_ZEN_PROVIDER => zen_adapter(model),
        OPENCODE_GO_PROVIDER => Ok(go_adapter(model)),
        other => Err(BackendError::Unsupported(format!(
            "provider {other:?} is not an OpenCode gateway"
        ))),
    }
}

fn zen_adapter(model: &ModelId) -> Result<AdapterKind, BackendError> {
    let model = model.as_str();
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

fn go_adapter(model: &ModelId) -> AdapterKind {
    let model = model.as_str();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(value: &str) -> ProviderId {
        ProviderId::parse(value).unwrap()
    }

    fn model(value: &str) -> ModelId {
        ModelId::parse(value).unwrap()
    }

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
    fn only_canonical_phenix_provider_ids_have_auth_mappings() {
        for (provider_id, auth_provider) in [
            (OPENAI_API_PROVIDER, OPENAI_API_PROVIDER),
            ("anthropic", ANTHROPIC_PROVIDER),
            ("gemini", GEMINI_PROVIDER),
            ("github-copilot", GITHUB_COPILOT_PROVIDER),
            ("opencode-zen", OPENCODE_ZEN_PROVIDER),
            ("opencode-go", OPENCODE_GO_PROVIDER),
            ("open-router", OPEN_ROUTER_PROVIDER),
            ("ollama-cloud", OLLAMA_CLOUD_PROVIDER),
            ("deepseek", DEEPSEEK_PROVIDER),
            ("groq", GROQ_PROVIDER),
            ("xai", XAI_PROVIDER),
        ] {
            assert_eq!(
                canonical_auth_provider(&provider(provider_id)),
                Some(auth_provider)
            );
            assert!(is_api_key_auth_provider(auth_provider));
            assert!(environment_name(auth_provider).is_some());
            assert!(environment_description(auth_provider).is_some());
        }
        assert_eq!(
            canonical_auth_provider(&provider("openai-codex")),
            Some("openai-codex")
        );
        for alias in [
            "openai",
            "openai-responses",
            "google",
            "opencode",
            "openrouter",
        ] {
            assert_eq!(
                canonical_auth_provider(&provider(alias)),
                None,
                "alias {alias}"
            );
        }
        assert_eq!(canonical_auth_provider(&provider(OLLAMA_PROVIDER)), None);
    }

    #[test]
    fn canonical_provider_mapping_owns_provider_adapter_identity() {
        assert_eq!(
            genai_model(&provider(OPENAI_API_PROVIDER), &model("gpt-5.6-terra")).unwrap(),
            "openai_resp::gpt-5.6-terra"
        );
        assert!(genai_model(&provider("openai-responses"), &model("gpt-5.6-terra")).is_err());
    }

    #[test]
    fn opencode_go_uses_each_current_wire_protocol() {
        assert_eq!(go_adapter(&model("gpt-5.6-luna")), AdapterKind::OpenAIResp);
        assert_eq!(go_adapter(&model("qwen3.7-plus")), AdapterKind::Anthropic);
        assert_eq!(go_adapter(&model("minimax-m3")), AdapterKind::Anthropic);
        assert_eq!(go_adapter(&model("deepseek-v4-flash")), AdapterKind::OpenAI);
    }

    #[test]
    fn opencode_zen_uses_each_current_wire_protocol() {
        assert_eq!(
            zen_adapter(&model("gpt-5.6-terra")).unwrap(),
            AdapterKind::OpenAIResp
        );
        assert_eq!(
            zen_adapter(&model("claude-sonnet-5")).unwrap(),
            AdapterKind::Anthropic
        );
        assert_eq!(
            zen_adapter(&model("qwen3.7-plus")).unwrap(),
            AdapterKind::Anthropic
        );
        assert_eq!(
            zen_adapter(&model("deepseek-v4-flash")).unwrap(),
            AdapterKind::OpenAI
        );
        assert!(matches!(
            zen_adapter(&model("gemini-3.6-flash")),
            Err(BackendError::Unsupported(_))
        ));
    }
}
