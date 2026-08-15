use futures::channel::oneshot;
use phenix_acp::acp::schema::v1::{
    PermissionOption, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome, SessionId as AcpSessionId,
};
use phenix_runtime_api::{
    BackendError, BackendEvent, BackendOutputSender, DialogId, ExtensionUiRequest,
    ExtensionUiResponse,
};
use std::collections::BTreeMap;

pub(crate) struct PermissionRequestEvent {
    pub request: RequestPermissionRequest,
    pub response: oneshot::Sender<RequestPermissionResponse>,
}

struct PendingPermission {
    session_id: AcpSessionId,
    response: oneshot::Sender<RequestPermissionResponse>,
    options: BTreeMap<String, PermissionOption>,
}

pub(crate) struct PermissionBroker {
    auto_approve: bool,
    next_id: u64,
    pending: BTreeMap<DialogId, PendingPermission>,
}

impl Default for PermissionBroker {
    fn default() -> Self {
        Self {
            auto_approve: true,
            next_id: 0,
            pending: BTreeMap::new(),
        }
    }
}

impl PermissionBroker {
    pub fn request(
        &mut self,
        event: PermissionRequestEvent,
        outputs: &BackendOutputSender,
    ) -> Result<(), BackendError> {
        if self.auto_approve {
            let outcome = choose_by_confirmation(event.request.options.iter(), true)
                .unwrap_or(RequestPermissionOutcome::Cancelled);
            return event
                .response
                .send(RequestPermissionResponse::new(outcome))
                .map_err(|_| {
                    BackendError::Transport("ACP permission responder closed".to_owned())
                });
        }
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or_else(|| BackendError::Protocol("permission dialog IDs exhausted".to_owned()))?;
        let dialog_id = DialogId::parse(format!("acp-permission-{id}"))
            .map_err(|error| BackendError::Protocol(error.to_string()))?;
        let options = unique_labels(event.request.options);
        let labels = options.keys().cloned().collect::<Vec<_>>();
        let title = event
            .request
            .tool_call
            .fields
            .title
            .clone()
            .unwrap_or_else(|| format!("Permission for {}", event.request.tool_call.tool_call_id));
        self.pending.insert(
            dialog_id.clone(),
            PendingPermission {
                session_id: event.request.session_id,
                response: event.response,
                options,
            },
        );
        outputs.event(BackendEvent::ExtensionUiRequested {
            dialog_id,
            request: ExtensionUiRequest::Select {
                title,
                options: labels,
            },
        })
    }

    pub fn respond(
        &mut self,
        dialog_id: &DialogId,
        response: ExtensionUiResponse,
    ) -> Result<(), BackendError> {
        let pending = self.pending.remove(dialog_id).ok_or_else(|| {
            BackendError::InvalidConfiguration(format!(
                "permission dialog {dialog_id} is no longer pending"
            ))
        })?;
        let outcome = match response {
            ExtensionUiResponse::Selected(label) => pending
                .options
                .get(&label)
                .map(|option| {
                    RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                        option.option_id.clone(),
                    ))
                })
                .unwrap_or(RequestPermissionOutcome::Cancelled),
            ExtensionUiResponse::Confirmed(confirmed) => {
                choose_by_confirmation(pending.options.values(), confirmed)
                    .unwrap_or(RequestPermissionOutcome::Cancelled)
            }
            ExtensionUiResponse::Text(_) | ExtensionUiResponse::Cancelled => {
                RequestPermissionOutcome::Cancelled
            }
        };
        pending
            .response
            .send(RequestPermissionResponse::new(outcome))
            .map_err(|_| BackendError::Transport("ACP permission responder closed".to_owned()))
    }

    pub fn cancel_session(&mut self, session_id: &AcpSessionId) {
        let pending = std::mem::take(&mut self.pending);
        self.pending = pending
            .into_iter()
            .filter_map(|(dialog_id, pending)| {
                if &pending.session_id == session_id {
                    let _ = pending.response.send(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Cancelled,
                    ));
                    None
                } else {
                    Some((dialog_id, pending))
                }
            })
            .collect();
    }

    pub fn cancel_all(&mut self) {
        for (_, pending) in std::mem::take(&mut self.pending) {
            let _ = pending.response.send(RequestPermissionResponse::new(
                RequestPermissionOutcome::Cancelled,
            ));
        }
    }
}

fn unique_labels(options: Vec<PermissionOption>) -> BTreeMap<String, PermissionOption> {
    let mut labels = BTreeMap::new();
    for option in options {
        let mut label = option.name.clone();
        if labels.contains_key(&label) {
            label = format!("{} [{}]", option.name, option.option_id);
        }
        labels.insert(label, option);
    }
    labels
}

fn choose_by_confirmation<'a>(
    mut options: impl Iterator<Item = &'a PermissionOption>,
    confirmed: bool,
) -> Option<RequestPermissionOutcome> {
    let preferred = options.find(|option| {
        if confirmed {
            matches!(
                option.kind,
                phenix_acp::acp::schema::v1::PermissionOptionKind::AllowOnce
                    | phenix_acp::acp::schema::v1::PermissionOptionKind::AllowAlways
            )
        } else {
            matches!(
                option.kind,
                phenix_acp::acp::schema::v1::PermissionOptionKind::RejectOnce
                    | phenix_acp::acp::schema::v1::PermissionOptionKind::RejectAlways
            )
        }
    })?;
    Some(RequestPermissionOutcome::Selected(
        SelectedPermissionOutcome::new(preferred.option_id.clone()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_acp::acp::schema::v1::PermissionOptionKind;

    #[test]
    fn duplicate_permission_names_remain_addressable() {
        let options = unique_labels(vec![
            PermissionOption::new("once", "Allow", PermissionOptionKind::AllowOnce),
            PermissionOption::new("always", "Allow", PermissionOptionKind::AllowAlways),
        ]);
        assert_eq!(options.len(), 2);
        assert!(options.keys().any(|label| label == "Allow"));
        assert!(options.keys().any(|label| label.contains("always")));
    }

    #[test]
    fn default_policy_prefers_an_allow_option_without_user_input() {
        let options = [
            PermissionOption::new("reject", "Reject", PermissionOptionKind::RejectOnce),
            PermissionOption::new("allow", "Allow", PermissionOptionKind::AllowOnce),
        ];
        let outcome = choose_by_confirmation(options.iter(), true).expect("allow outcome");
        assert!(matches!(
            outcome,
            RequestPermissionOutcome::Selected(selected)
                if selected.option_id.to_string() == "allow"
        ));
        assert!(PermissionBroker::default().auto_approve);
    }
}
