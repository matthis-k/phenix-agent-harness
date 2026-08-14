use genai::chat::ReasoningEffort;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelSelection {
    pub provider: String,
    pub model: String,
}

impl ModelSelection {
    pub fn parse(value: &str) -> Result<Self, String> {
        let (provider, model) = value
            .split_once('/')
            .ok_or_else(|| format!("model selection {value:?} must be provider/model"))?;
        if provider.is_empty() || model.is_empty() {
            return Err(format!("model selection {value:?} must be provider/model"));
        }
        Ok(Self {
            provider: provider.to_owned(),
            model: model.to_owned(),
        })
    }

    pub fn genai_model(&self) -> Result<String, String> {
        let namespace = match self.provider.as_str() {
            "openai" => "openai",
            "openai-codex" => "openai_resp",
            "openai-responses" => "openai_resp",
            "anthropic" => "anthropic",
            "gemini" | "google" => "gemini",
            "opencode" | "opencode-go" => "opencode_go",
            "github-copilot" => "github_copilot",
            "open-router" => "open_router",
            "ollama" => "ollama",
            "ollama-cloud" => "ollama_cloud",
            "deepseek" => "deepseek",
            "groq" => "groq",
            "xai" => "xai",
            other => return Err(format!("unsupported Phenix provider {other:?}")),
        };
        Ok(format!("{namespace}::{}", self.model))
    }

    pub fn wire_value(&self) -> String {
        format!("{}/{}", self.provider, self.model)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ThoughtLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    ExtraHigh,
    Max,
}

impl ThoughtLevel {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "off" | "none" => Ok(Self::Off),
            "minimal" => Ok(Self::Minimal),
            "low" => Ok(Self::Low),
            "medium" => Ok(Self::Medium),
            "high" => Ok(Self::High),
            "extra_high" | "xhigh" => Ok(Self::ExtraHigh),
            "max" => Ok(Self::Max),
            other => Err(format!("unsupported thought level {other:?}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::ExtraHigh => "extra_high",
            Self::Max => "max",
        }
    }

    pub fn reasoning_effort(self) -> ReasoningEffort {
        match self {
            Self::Off => ReasoningEffort::None,
            Self::Minimal => ReasoningEffort::Minimal,
            Self::Low => ReasoningEffort::Low,
            Self::Medium => ReasoningEffort::Medium,
            Self::High => ReasoningEffort::High,
            Self::ExtraHigh => ReasoningEffort::XHigh,
            Self::Max => ReasoningEffort::Max,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_phenix_provider_names_without_leaking_library_names() {
        let model = ModelSelection::parse("opencode-go/kimi-k2.7-code").expect("selection");
        assert_eq!(
            model.genai_model().expect("model"),
            "opencode_go::kimi-k2.7-code"
        );
        assert_eq!(model.wire_value(), "opencode-go/kimi-k2.7-code");
    }

    #[test]
    fn maps_codex_subscription_to_the_responses_wire_adapter() {
        let model = ModelSelection::parse("openai-codex/gpt-5.6").expect("selection");
        assert_eq!(model.genai_model().expect("model"), "openai_resp::gpt-5.6");
    }
}
