use crate::state::{AdapterState, SessionState};
use crate::terminal::TerminalEvent;
use phenix_acp::acp::schema::v1::{
    ContentBlock, ContentChunk, SessionNotification, SessionUpdate, ToolCall, ToolCallStatus,
    ToolCallUpdate,
};
use phenix_runtime_api::{
    BackendError, BackendEvent, BackendOutputSender, RunOutcome, RunState, ToolCallId,
    ToolExecutionOutcome, TranscriptBlock, TranscriptRole,
};

const MAX_TOOL_SUMMARY_CHARS: usize = 8_192;

pub(crate) fn apply_session_notification(
    state: &mut AdapterState,
    notification: SessionNotification,
    outputs: &BackendOutputSender,
) -> Result<(), BackendError> {
    let session = state.session_by_acp_mut(&notification.session_id)?;
    match notification.update {
        SessionUpdate::UserMessageChunk(chunk) => {
            append_chunk(session, TranscriptRole::User, chunk, outputs)?;
        }
        SessionUpdate::AgentMessageChunk(chunk) => {
            append_chunk(session, TranscriptRole::Assistant, chunk, outputs)?;
        }
        SessionUpdate::AgentThoughtChunk(chunk) => {
            append_chunk(session, TranscriptRole::Thinking, chunk, outputs)?;
        }
        SessionUpdate::ToolCall(tool) => apply_tool_call(session, tool, outputs)?,
        SessionUpdate::ToolCallUpdate(update) => apply_tool_update(session, update, outputs)?,
        SessionUpdate::Plan(plan) => {
            let text = serde_json::to_string_pretty(&plan)
                .map_err(|error| BackendError::Protocol(error.to_string()))?;
            append_complete_block(session, TranscriptRole::System, "plan", text, outputs)?;
        }
        SessionUpdate::AvailableCommandsUpdate(update) => {
            session.commands = update.available_commands;
            outputs.event(BackendEvent::StatusChanged {
                key: "commands".to_owned(),
                text: Some(format!("{} available", session.commands.len())),
            })?;
        }
        SessionUpdate::CurrentModeUpdate(update) => {
            if let Some(modes) = &mut session.modes {
                modes.current_mode_id = update.current_mode_id.clone();
            }
            outputs.event(BackendEvent::StatusChanged {
                key: "mode".to_owned(),
                text: Some(update.current_mode_id.to_string()),
            })?;
        }
        SessionUpdate::ConfigOptionUpdate(update) => {
            session.config_options = update.config_options;
            session.run.model = session.current_model();
            session.run.thinking_level = session.current_thinking_level();
            outputs.event(BackendEvent::RunChanged(session.run.clone()))?;
        }
        SessionUpdate::SessionInfoUpdate(update) => {
            apply_session_info(session, &update)?;
            outputs.event(BackendEvent::PersistedSessionChanged(
                session.summary.clone(),
            ))?;
            outputs.event(BackendEvent::RunChanged(session.run.clone()))?;
        }
        SessionUpdate::UsageUpdate(update) => {
            let cost = update.cost.as_ref().map_or_else(String::new, |cost| {
                format!(" · {:.4} {}", cost.amount, cost.currency)
            });
            outputs.event(BackendEvent::StatusChanged {
                key: "context".to_owned(),
                text: Some(format!("{} / {} tokens{cost}", update.used, update.size)),
            })?;
        }
        _ => {}
    }
    state.refresh_capabilities();
    Ok(())
}

pub(crate) fn apply_terminal_event(
    state: &AdapterState,
    event: TerminalEvent,
    outputs: &BackendOutputSender,
) -> Result<(), BackendError> {
    match event {
        TerminalEvent::Started {
            session_id,
            terminal_id,
            command,
        } => {
            let text = state
                .sessions
                .values()
                .find(|session| session.acp_id.to_string() == session_id)
                .map_or_else(
                    || format!("{terminal_id}: {command}"),
                    |session| format!("{} · {terminal_id}: {command}", session.run.display_name),
                );
            outputs.event(BackendEvent::StatusChanged {
                key: format!("terminal.{terminal_id}"),
                text: Some(text),
            })?;
        }
        TerminalEvent::Finished {
            session_id,
            terminal_id,
            exit_code,
        } => {
            let session = state
                .sessions
                .values()
                .find(|session| session.acp_id.to_string() == session_id)
                .map(|session| session.run.display_name.as_str())
                .unwrap_or("unknown session");
            outputs.event(BackendEvent::StatusChanged {
                key: format!("terminal.{terminal_id}"),
                text: Some(format!(
                    "{session} · {terminal_id}: exited with {exit_code:?}"
                )),
            })?;
        }
    }
    Ok(())
}

pub(crate) fn finish_prompt(
    session: &mut SessionState,
    stop_reason: phenix_acp::acp::schema::v1::StopReason,
    outputs: &BackendOutputSender,
) -> Result<(), BackendError> {
    session.prompt_active = false;
    close_active_transcript_segment(session, outputs)?;
    match stop_reason {
        phenix_acp::acp::schema::v1::StopReason::Cancelled => {
            session.run.state = RunState::Cancelled;
            session.run.outcome = Some(RunOutcome::Cancelled {
                reason: "ACP prompt cancelled".to_owned(),
            });
        }
        phenix_acp::acp::schema::v1::StopReason::Refusal => {
            session.run.state = RunState::Failed;
            session.run.outcome = Some(RunOutcome::Failure {
                code: "acp.refusal".to_owned(),
                message: "ACP agent refused the prompt".to_owned(),
                retryable: false,
            });
        }
        _ => {
            session.run.state = RunState::Completed;
            session.run.outcome = Some(RunOutcome::Success);
        }
    }
    outputs.event(BackendEvent::RunChanged(session.run.clone()))?;
    Ok(())
}

fn append_chunk(
    session: &mut SessionState,
    role: TranscriptRole,
    chunk: ContentChunk,
    outputs: &BackendOutputSender,
) -> Result<(), BackendError> {
    let text = content_markdown(&chunk.content)?;
    if text.is_empty() {
        return Ok(());
    }
    let key = transcript_stream_key(role, chunk.message_id.as_ref().map(ToString::to_string));
    if !session.transcript_blocks.contains_key(&key) && !session.transcript_blocks.is_empty() {
        close_active_transcript_segment(session, outputs)?;
    }
    let is_new = !session.transcript_blocks.contains_key(&key);
    let block = if is_new {
        let id = session.next_transcript_key("acp-message")?;
        TranscriptBlock {
            id,
            run_id: session.run.id.clone(),
            role,
            text,
            complete: false,
        }
    } else {
        let mut block = session
            .transcript_blocks
            .get(&key)
            .cloned()
            .ok_or_else(|| BackendError::Protocol("transcript block disappeared".to_owned()))?;
        block.text.push_str(&text);
        block
    };
    session.transcript_blocks.insert(key, block.clone());
    if is_new {
        outputs.event(BackendEvent::TranscriptAppended(block))?;
    } else {
        outputs.event(BackendEvent::TranscriptUpdated(block))?;
    }
    Ok(())
}

fn transcript_stream_key(role: TranscriptRole, message_id: Option<String>) -> String {
    message_id.map_or_else(
        || format!("active-{role:?}"),
        |message_id| format!("message-{role:?}-{message_id}"),
    )
}

fn close_active_transcript_segment(
    session: &mut SessionState,
    outputs: &BackendOutputSender,
) -> Result<(), BackendError> {
    for block in session.transcript_blocks.values_mut() {
        if !block.complete {
            block.complete = true;
            outputs.event(BackendEvent::TranscriptUpdated(block.clone()))?;
        }
    }
    // ACP message IDs identify streamed messages, not presentation segments. Once a
    // different transcript event intervenes, later chunks must start a new block so
    // the frontend can preserve the exact reasoning/tool/text chronology.
    session.transcript_blocks.clear();
    Ok(())
}

fn append_complete_block(
    session: &mut SessionState,
    role: TranscriptRole,
    prefix: &str,
    text: String,
    outputs: &BackendOutputSender,
) -> Result<(), BackendError> {
    close_active_transcript_segment(session, outputs)?;
    outputs.event(BackendEvent::TranscriptAppended(TranscriptBlock {
        id: session.next_transcript_key(prefix)?,
        run_id: session.run.id.clone(),
        role,
        text,
        complete: true,
    }))
}

/// Normalize standard ACP content into the rich transcript's Markdown ingestion
/// format without destroying media payloads. Images use data URIs so the
/// renderer-neutral rich-text parser can produce an `Image` primitive while the
/// terminal renderer remains free to choose Kitty/Sixel/text fallback rendering.
fn content_markdown(content: &ContentBlock) -> Result<String, BackendError> {
    match content {
        ContentBlock::Text(text) => Ok(text.text.clone()),
        ContentBlock::Image(image) => Ok(format!(
            "![ACP image](data:{};base64,{})",
            image.mime_type, image.data
        )),
        ContentBlock::Audio(audio) => Ok(format!("[audio: {}]", audio.mime_type)),
        ContentBlock::ResourceLink(resource) => Ok(format!("[resource]({})", resource.uri)),
        ContentBlock::Resource(resource) => serde_json::to_string(resource)
            .map(|value| format!("[embedded resource: {value}]"))
            .map_err(|error| BackendError::Protocol(error.to_string())),
        _ => Ok(String::new()),
    }
}

fn apply_tool_call(
    session: &mut SessionState,
    tool: ToolCall,
    outputs: &BackendOutputSender,
) -> Result<(), BackendError> {
    close_active_transcript_segment(session, outputs)?;
    let id = ToolCallId::parse(tool.tool_call_id.to_string())
        .map_err(|error| BackendError::Protocol(error.to_string()))?;
    let raw_input_json = tool
        .raw_input
        .as_ref()
        .map_or_else(|| "{}".to_owned(), serde_json::Value::to_string);
    session
        .tools
        .insert(tool.tool_call_id.to_string(), tool.clone());
    outputs.event(BackendEvent::ToolStarted {
        run_id: session.run.id.clone(),
        tool_call_id: id.clone(),
        tool_name: tool.title.clone(),
        raw_input_json: raw_input_json.clone(),
        input_summary: bounded_summary(raw_input_json),
    })?;
    emit_tool_state(session, id, &tool, outputs)
}

fn apply_tool_update(
    session: &mut SessionState,
    update: ToolCallUpdate,
    outputs: &BackendOutputSender,
) -> Result<(), BackendError> {
    let key = update.tool_call_id.to_string();
    let call = if let Some(call) = session.tools.get_mut(&key) {
        call.update(update.fields);
        call.clone()
    } else {
        ToolCall::try_from(update).map_err(|error| BackendError::Protocol(error.to_string()))?
    };
    session.tools.insert(key, call.clone());
    let id = ToolCallId::parse(call.tool_call_id.to_string())
        .map_err(|error| BackendError::Protocol(error.to_string()))?;
    emit_tool_state(session, id, &call, outputs)
}

fn emit_tool_state(
    session: &SessionState,
    id: ToolCallId,
    tool: &ToolCall,
    outputs: &BackendOutputSender,
) -> Result<(), BackendError> {
    match tool.status {
        ToolCallStatus::Completed => outputs.event(BackendEvent::ToolFinished {
            run_id: session.run.id.clone(),
            tool_call_id: id,
            outcome: ToolExecutionOutcome::Succeeded,
            output_summary: tool_output(tool),
        }),
        ToolCallStatus::Failed => outputs.event(BackendEvent::ToolFinished {
            run_id: session.run.id.clone(),
            tool_call_id: id,
            outcome: ToolExecutionOutcome::Failed,
            output_summary: tool_output(tool),
        }),
        ToolCallStatus::Pending | ToolCallStatus::InProgress => {
            outputs.event(BackendEvent::ToolUpdated {
                run_id: session.run.id.clone(),
                tool_call_id: id,
                output: format!("{} · {:?}", tool.title, tool.status),
            })
        }
        _ => Ok(()),
    }
}

fn tool_output(tool: &ToolCall) -> String {
    bounded_summary(tool.raw_output.as_ref().map_or_else(
        || serde_json::to_string_pretty(&tool.content).unwrap_or_else(|_| "[]".to_owned()),
        |output| output.to_string(),
    ))
}

fn bounded_summary(value: String) -> String {
    let mut characters = value.chars();
    let summary = characters
        .by_ref()
        .take(MAX_TOOL_SUMMARY_CHARS)
        .collect::<String>();
    if characters.next().is_some() {
        format!("{summary}\n… [truncated]")
    } else {
        summary
    }
}

fn apply_session_info(
    session: &mut SessionState,
    update: &phenix_acp::acp::schema::v1::SessionInfoUpdate,
) -> Result<(), BackendError> {
    let value =
        serde_json::to_value(update).map_err(|error| BackendError::Protocol(error.to_string()))?;
    if let Some(title) = value.get("title") {
        if let Some(title) = title.as_str() {
            session.summary.name = Some(title.to_owned());
            session.run.display_name = title.to_owned();
        } else if title.is_null() {
            session.summary.name = None;
        }
    }
    if let Some(updated_at) = value.get("updatedAt") {
        session.summary.updated_at = updated_at.as_str().map(str::to_owned);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_acp::acp::schema::v1::ImageContent;

    #[test]
    fn tool_summaries_are_bounded_on_character_boundaries() {
        let value = "中".repeat(MAX_TOOL_SUMMARY_CHARS + 1);
        let summary = bounded_summary(value);
        assert!(summary.ends_with("… [truncated]"));
        assert_eq!(summary.matches('中').count(), MAX_TOOL_SUMMARY_CHARS);
    }

    #[test]
    fn stream_keys_include_role_even_with_message_ids() {
        assert_ne!(
            transcript_stream_key(TranscriptRole::Thinking, Some("message-1".to_owned())),
            transcript_stream_key(TranscriptRole::Assistant, Some("message-1".to_owned()))
        );
    }

    #[test]
    fn image_content_survives_projection_as_a_rich_image() {
        let image =
            ContentBlock::Image(ImageContent::new("Zm9v".to_owned(), "image/png".to_owned()));
        assert_eq!(
            content_markdown(&image).expect("image projection"),
            "![ACP image](data:image/png;base64,Zm9v)"
        );
    }
}
