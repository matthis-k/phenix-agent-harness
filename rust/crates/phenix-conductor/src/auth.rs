use super::{ConductorRuntime, RuntimeError, RuntimeExtensionError, StandardSession};
use agent_client_protocol::schema::v1::{ExtRequest, ExtResponse};
use phenix_acp::{
    AcpMethod, BackendAuthCancel, BackendAuthCancelParams, BackendAuthLink, BackendAuthLogout,
    BackendAuthLogoutParams, BackendAuthNotice, BackendAuthPrompt, BackendAuthPromptOption,
    BackendAuthRespond, BackendAuthRespondParams, BackendAuthResponse, BackendAuthStart,
    BackendAuthStartParams, BackendAuthTerminalFinished, BackendAuthTerminalFinishedParams,
    BackendControlEvent, BackendEventBatch, BackendEventPoll, BackendExternalCommand,
    BackendHealth, BackendTargetParams, SessionTreeId,
};
use phenix_runtime_api::{
    AuthFlowId, AuthLink, AuthNotice, AuthPrompt, AuthPromptResponse, BackendCommand, BackendEvent,
    BackendHealth as RuntimeBackendHealth, BackendReply, ExternalCommand, SecretValue,
};
use serde::de::DeserializeOwned;
use serde_json::value::to_raw_value;
use std::sync::Arc;

impl ConductorRuntime {
    pub fn create_standard_session_with_id(
        &mut self,
        tree_id: SessionTreeId,
    ) -> Result<StandardSession, RuntimeError> {
        let template = self
            .standard_session
            .clone()
            .ok_or(RuntimeError::MissingStandardSessionTemplate)?;
        let started = self.conductor.gateway_mut().create_tree_with_id(
            tree_id,
            &self.definition_id,
            template.role,
            template.difficulty,
            template.objective,
        )?;
        Ok(StandardSession {
            session_id: started.tree_id.to_string(),
            tree_id: started.tree_id,
            root_node_id: started.root_node_id,
        })
    }

    pub fn handle_auth_extension(
        &mut self,
        request: &ExtRequest,
    ) -> Result<Option<ExtResponse>, RuntimeExtensionError> {
        let response = match request.method.as_ref() {
            BackendAuthStart::METHOD => {
                let params = decode::<BackendAuthStartParams>(BackendAuthStart::METHOD, request)?;
                let target = BackendTargetParams {
                    tree_id: params.tree_id,
                    backend: params.backend,
                };
                let method = match params.method {
                    phenix_acp::BackendAuthMethod::OAuth => phenix_runtime_api::AuthMethod::OAuth,
                    phenix_acp::BackendAuthMethod::ApiKey => phenix_runtime_api::AuthMethod::ApiKey,
                    phenix_acp::BackendAuthMethod::Terminal => {
                        phenix_runtime_api::AuthMethod::Terminal
                    }
                };
                let batch = self.submit_auth(
                    &target,
                    BackendCommand::AuthLoginStart {
                        provider_id: params.provider_id,
                        method,
                    },
                    BackendAuthStart::METHOD,
                )?;
                encode::<BackendAuthStart>(&batch)?
            }
            BackendAuthRespond::METHOD => {
                let params =
                    decode::<BackendAuthRespondParams>(BackendAuthRespond::METHOD, request)?;
                let target = BackendTargetParams {
                    tree_id: params.tree_id,
                    backend: params.backend,
                };
                let response = map_response(params.response);
                let batch = self.submit_auth(
                    &target,
                    BackendCommand::AuthLoginRespond {
                        flow_id: parse_flow_id(&params.flow_id)?,
                        response,
                    },
                    BackendAuthRespond::METHOD,
                )?;
                encode::<BackendAuthRespond>(&batch)?
            }
            BackendAuthCancel::METHOD => {
                let params = decode::<BackendAuthCancelParams>(BackendAuthCancel::METHOD, request)?;
                let target = BackendTargetParams {
                    tree_id: params.tree_id,
                    backend: params.backend,
                };
                let batch = self.submit_auth(
                    &target,
                    BackendCommand::AuthLoginCancel {
                        flow_id: parse_flow_id(&params.flow_id)?,
                    },
                    BackendAuthCancel::METHOD,
                )?;
                encode::<BackendAuthCancel>(&batch)?
            }
            BackendAuthTerminalFinished::METHOD => {
                let params = decode::<BackendAuthTerminalFinishedParams>(
                    BackendAuthTerminalFinished::METHOD,
                    request,
                )?;
                let target = BackendTargetParams {
                    tree_id: params.tree_id,
                    backend: params.backend,
                };
                let batch = self.submit_auth(
                    &target,
                    BackendCommand::AuthTerminalFinished {
                        flow_id: parse_flow_id(&params.flow_id)?,
                        success: params.success,
                        message: params.message,
                    },
                    BackendAuthTerminalFinished::METHOD,
                )?;
                encode::<BackendAuthTerminalFinished>(&batch)?
            }
            BackendAuthLogout::METHOD => {
                let params = decode::<BackendAuthLogoutParams>(BackendAuthLogout::METHOD, request)?;
                let target = BackendTargetParams {
                    tree_id: params.tree_id,
                    backend: params.backend,
                };
                let batch = self.submit_auth(
                    &target,
                    BackendCommand::AuthLogout {
                        provider_id: params.provider_id,
                    },
                    BackendAuthLogout::METHOD,
                )?;
                encode::<BackendAuthLogout>(&batch)?
            }
            BackendEventPoll::METHOD => {
                let target = decode::<BackendTargetParams>(BackendEventPoll::METHOD, request)?;
                let batch = self.poll_backend_events(&target, BackendEventPoll::METHOD)?;
                encode::<BackendEventPoll>(&batch)?
            }
            _ => return Ok(None),
        };
        Ok(Some(response))
    }

    fn submit_auth(
        &self,
        target: &BackendTargetParams,
        command: BackendCommand,
        method: &'static str,
    ) -> Result<BackendEventBatch, RuntimeExtensionError> {
        let mut control = self.backend_control(target)?;
        match control.submit(command)? {
            BackendReply::Accepted | BackendReply::Completed => {}
            reply => {
                return Err(RuntimeExtensionError::UnexpectedReply {
                    method,
                    reply: format!("{reply:?}"),
                });
            }
        }
        map_event_batch(target.backend.clone(), control.drain_events()?, method)
    }

    fn poll_backend_events(
        &self,
        target: &BackendTargetParams,
        method: &'static str,
    ) -> Result<BackendEventBatch, RuntimeExtensionError> {
        let mut control = self.backend_control(target)?;
        map_event_batch(target.backend.clone(), control.drain_events()?, method)
    }
}

fn decode<T: DeserializeOwned>(
    method: &'static str,
    request: &ExtRequest,
) -> Result<T, RuntimeExtensionError> {
    serde_json::from_str(request.params.get())
        .map_err(|source| RuntimeExtensionError::Decode { method, source })
}

fn encode<M: AcpMethod>(result: &M::Result) -> Result<ExtResponse, RuntimeExtensionError> {
    let raw = to_raw_value(result).map_err(|source| RuntimeExtensionError::Encode {
        method: M::METHOD,
        source,
    })?;
    Ok(ExtResponse::new(Arc::from(raw)))
}

fn parse_flow_id(value: &str) -> Result<AuthFlowId, RuntimeExtensionError> {
    AuthFlowId::parse(value).map_err(|error| RuntimeExtensionError::InvalidBackendValue {
        field: "auth flow ID",
        message: error.to_string(),
    })
}

fn map_response(value: BackendAuthResponse) -> AuthPromptResponse {
    match value {
        BackendAuthResponse::Text { text } => AuthPromptResponse::Text(text),
        BackendAuthResponse::Secret { secret } => {
            AuthPromptResponse::Secret(SecretValue::from_utf8(secret))
        }
        BackendAuthResponse::Selected { option_id } => AuthPromptResponse::Selected(option_id),
        BackendAuthResponse::ManualCode { code } => AuthPromptResponse::ManualCode(code),
        BackendAuthResponse::Cancelled => AuthPromptResponse::Cancelled,
    }
}

fn map_event_batch(
    backend: phenix_acp::BackendId,
    events: Vec<BackendEvent>,
    method: &'static str,
) -> Result<BackendEventBatch, RuntimeExtensionError> {
    let events = events
        .into_iter()
        .map(|event| map_event(event, method))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(BackendEventBatch { backend, events })
}

fn map_event(
    event: BackendEvent,
    method: &'static str,
) -> Result<BackendControlEvent, RuntimeExtensionError> {
    match event {
        BackendEvent::ExternalCommandRequested { flow_id, command } => {
            Ok(BackendControlEvent::ExternalCommandRequested {
                flow_id: flow_id.to_string(),
                command: map_external_command(command),
            })
        }
        BackendEvent::AuthPromptRequested { flow_id, prompt } => {
            Ok(BackendControlEvent::AuthPromptRequested {
                flow_id: flow_id.to_string(),
                prompt: map_prompt(prompt),
            })
        }
        BackendEvent::AuthNotice { flow_id, notice } => Ok(BackendControlEvent::AuthNotice {
            flow_id: flow_id.to_string(),
            notice: map_notice(notice),
        }),
        BackendEvent::AuthFinished {
            flow_id,
            provider_id,
            result,
        } => Ok(BackendControlEvent::AuthFinished {
            flow_id: flow_id.to_string(),
            provider_id,
            error: result.err(),
        }),
        BackendEvent::HealthChanged(health) => Ok(BackendControlEvent::HealthChanged {
            health: map_health(health),
        }),
        event => Err(RuntimeExtensionError::UnexpectedReply {
            method,
            reply: format!("unexpected control event {event:?}"),
        }),
    }
}

fn map_external_command(value: ExternalCommand) -> BackendExternalCommand {
    BackendExternalCommand {
        program: value.program,
        arguments: value.arguments,
        environment: value.environment,
    }
}

fn map_prompt(value: AuthPrompt) -> BackendAuthPrompt {
    match value {
        AuthPrompt::Text {
            message,
            placeholder,
        } => BackendAuthPrompt::Text {
            message,
            placeholder,
        },
        AuthPrompt::Secret {
            message,
            placeholder,
        } => BackendAuthPrompt::Secret {
            message,
            placeholder,
        },
        AuthPrompt::Select { message, options } => BackendAuthPrompt::Select {
            message,
            options: options
                .into_iter()
                .map(|option| BackendAuthPromptOption {
                    id: option.id,
                    label: option.label,
                    description: option.description,
                })
                .collect(),
        },
        AuthPrompt::ManualCode {
            message,
            placeholder,
        } => BackendAuthPrompt::ManualCode {
            message,
            placeholder,
        },
    }
}

fn map_notice(value: AuthNotice) -> BackendAuthNotice {
    match value {
        AuthNotice::Information { message, links } => BackendAuthNotice::Information {
            message,
            links: links.into_iter().map(map_link).collect(),
        },
        BackendAuthNotice::Url { .. } => unreachable!(),
        AuthNotice::Url { url, instructions } => BackendAuthNotice::Url { url, instructions },
        AuthNotice::DeviceCode {
            user_code,
            verification_uri,
            expires_in_seconds,
        } => BackendAuthNotice::DeviceCode {
            user_code,
            verification_uri,
            expires_in_seconds,
        },
        AuthNotice::Progress { message } => BackendAuthNotice::Progress { message },
    }
}

fn map_link(value: AuthLink) -> BackendAuthLink {
    BackendAuthLink {
        url: value.url,
        label: value.label,
    }
}

fn map_health(value: RuntimeBackendHealth) -> BackendHealth {
    match value {
        RuntimeBackendHealth::Starting => BackendHealth::Starting,
        RuntimeBackendHealth::Ready => BackendHealth::Ready,
        RuntimeBackendHealth::Degraded { message } => BackendHealth::Degraded { message },
        RuntimeBackendHealth::Failed { message } => BackendHealth::Failed { message },
        RuntimeBackendHealth::Stopped => BackendHealth::Stopped,
    }
}
