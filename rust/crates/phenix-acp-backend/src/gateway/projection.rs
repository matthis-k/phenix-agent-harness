use phenix_acp::{
    AcpSessionId, GatewayError, InteractionResponse, ModelSelection, SessionEvent, SessionImage,
};
use phenix_runtime_api::{
    BackendError, BackendHealth, ExtensionUiRequest, ExtensionUiResponse, ImageInput, ModelRef,
    RunOutcome, RunState, RuntimeSnapshot, SessionId, ThinkingLevel,
};

pub(super) fn runtime_images(images: Vec<SessionImage>) -> Vec<ImageInput> {
    images
        .into_iter()
        .map(|image| ImageInput {
            media_type: image.media_type,
            bytes: image.data,
        })
        .collect()
}

pub(super) fn runtime_model(model: &ModelSelection) -> ModelRef {
    ModelRef {
        provider: model.provider.as_str().to_owned(),
        model: model.model.as_str().to_owned(),
    }
}

pub(super) fn runtime_session_id(
    session_id: &AcpSessionId,
) -> Result<SessionId, GatewayError> {
    SessionId::parse(session_id.as_str()).map_err(|error| GatewayError::session(error.to_string()))
}

pub(super) fn parse_thinking_level(level: &str) -> Result<ThinkingLevel, GatewayError> {
    match level.trim().to_ascii_lowercase().replace('-', "_").as_str() {
        "off" => Ok(ThinkingLevel::Off),
        "minimal" => Ok(ThinkingLevel::Minimal),
        "low" => Ok(ThinkingLevel::Low),
        "medium" => Ok(ThinkingLevel::Medium),
        "high" => Ok(ThinkingLevel::High),
        "extra_high" | "xhigh" => Ok(ThinkingLevel::ExtraHigh),
        "max" => Ok(ThinkingLevel::Max),
        other => Err(GatewayError::session(format!(
            "unknown thinking level {other}"
        ))),
    }
}

pub(super) fn terminal_run_event(
    state: &RunState,
    outcome: Option<&RunOutcome>,
) -> Option<SessionEvent> {
    match state {
        RunState::Completed => Some(SessionEvent::Completed),
        RunState::Failed => Some(SessionEvent::Failed {
            message: match outcome {
                Some(RunOutcome::Failure { message, .. }) => message.clone(),
                _ => "ACP run failed".to_owned(),
            },
        }),
        RunState::Cancelled => Some(SessionEvent::Cancelled {
            reason: match outcome {
                Some(RunOutcome::Cancelled { reason }) => reason.clone(),
                _ => "ACP run cancelled".to_owned(),
            },
        }),
        RunState::Created
        | RunState::Starting
        | RunState::Running
        | RunState::Waiting
        | RunState::Completing
        | RunState::Orphaned => None,
    }
}

pub(super) fn interaction_event(
    request_id: String,
    request: ExtensionUiRequest,
) -> SessionEvent {
    match request {
        ExtensionUiRequest::Select { title, options } => SessionEvent::PermissionRequested {
            request_id,
            title,
            options,
        },
        ExtensionUiRequest::Confirm { title, message } => SessionEvent::PermissionRequested {
            request_id,
            title: format!("{title}: {message}"),
            options: vec!["Confirm".to_owned(), "Cancel".to_owned()],
        },
        ExtensionUiRequest::Input {
            title,
            placeholder,
            secret,
        } => SessionEvent::Text {
            text: format!(
                "{title}: input required{}{}",
                if secret { " (secret)" } else { "" },
                placeholder.map_or_else(String::new, |value| format!(" [{value}]"))
            ),
        },
        ExtensionUiRequest::Editor { title, .. } => SessionEvent::Text {
            text: format!("{title}: editor input required"),
        },
    }
}

pub(super) fn runtime_interaction_response(
    response: InteractionResponse,
) -> ExtensionUiResponse {
    match response {
        InteractionResponse::Selected(value) => ExtensionUiResponse::Selected(value),
        InteractionResponse::Confirmed(value) => ExtensionUiResponse::Confirmed(value),
        InteractionResponse::Text(value) => ExtensionUiResponse::Text(value),
        InteractionResponse::Cancelled => ExtensionUiResponse::Cancelled,
    }
}

pub(super) fn empty_snapshot() -> RuntimeSnapshot {
    RuntimeSnapshot {
        capabilities: Default::default(),
        health: BackendHealth::Starting,
        active_session: None,
        root_run: None,
        selected_run: None,
        sessions: Vec::new(),
        runs: Vec::new(),
        objectives: Vec::new(),
    }
}

pub(super) fn backend_error(error: BackendError) -> GatewayError {
    GatewayError::session(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thinking_levels_are_parsed_without_backend_specific_strings_leaking_out() {
        assert_eq!(
            parse_thinking_level("extra-high").expect("level"),
            ThinkingLevel::ExtraHigh
        );
        assert!(parse_thinking_level("unbounded").is_err());
    }

    #[test]
    fn terminal_run_outcomes_preserve_failure_and_cancellation_details() {
        assert_eq!(
            terminal_run_event(
                &RunState::Failed,
                Some(&RunOutcome::Failure {
                    code: "test".to_owned(),
                    message: "failed deliberately".to_owned(),
                    retryable: false,
                })
            ),
            Some(SessionEvent::Failed {
                message: "failed deliberately".to_owned()
            })
        );
        assert_eq!(
            terminal_run_event(
                &RunState::Cancelled,
                Some(&RunOutcome::Cancelled {
                    reason: "stopped".to_owned(),
                })
            ),
            Some(SessionEvent::Cancelled {
                reason: "stopped".to_owned()
            })
        );
    }

    #[test]
    fn typed_interaction_responses_map_without_protocol_strings() {
        assert_eq!(
            runtime_interaction_response(InteractionResponse::Confirmed(true)),
            ExtensionUiResponse::Confirmed(true)
        );
        assert_eq!(
            runtime_interaction_response(InteractionResponse::Cancelled),
            ExtensionUiResponse::Cancelled
        );
    }
}
