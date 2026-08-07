use crate::{
    install_core_consumers, install_frontend_provider, BusReaction, EventRouter, InputEdit,
    UiIngressError, UiMailbox, UiMessage, ViewMutation,
};
use phenix_frontend_config::FrontendProviderRef;
use phenix_runtime_api::{BackendClient, BackendCommand, BackendRuntime, BackendWorker};
use phenix_ui_core::{
    command_completions, group_transcript_turns, parse_markdown, reduce, AppEffect, AppEvent,
    AppState, FocusDirection, FocusTarget, LayoutAxis, OverlayState, ResizeRequest, VimMode,
};
#[cfg(test)]
use phenix_ui_core::{ElementId, InputEditor, RichBlockView};
use std::collections::VecDeque;
use std::env;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs;
use std::path::PathBuf;
use std::process::{self, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DEFAULT_DRAIN_LIMIT: usize = 256;

pub trait UiRenderer {
    fn render(&mut self, state: &AppState) -> Result<(), String>;

    fn suspend(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn resume(&mut self) -> Result<(), String> {
        Ok(())
    }
}

pub struct UiRuntime<R> {
    state: AppState,
    backend: BackendClient,
    renderer: R,
    router: EventRouter,
    receiver: Receiver<UiMessage>,
    mailbox: UiMailbox,
    backend_forwarder: Option<JoinHandle<()>>,
    backend_worker: Option<BackendWorker>,
    drain_limit: usize,
    external_io_pause: Option<Arc<AtomicBool>>,
}

impl<R> UiRuntime<R> {
    fn detach_workers(&mut self) {
        let _ = self.backend_forwarder.take();
        let _ = self.backend_worker.take();
    }
}

impl<R: UiRenderer> UiRuntime<R> {
    pub fn from_backend(
        state: AppState,
        backend: BackendRuntime,
        renderer: R,
        channel_capacity: usize,
    ) -> Result<Self, UiRuntimeError> {
        let mut router = EventRouter::standard();
        install_core_consumers(&mut router)
            .map_err(|error| UiRuntimeError::InvalidConfiguration(error.to_string()))?;
        Self::from_backend_with_router(state, backend, renderer, router, channel_capacity)
    }

    pub fn from_backend_with_frontend(
        state: AppState,
        backend: BackendRuntime,
        renderer: R,
        provider: FrontendProviderRef,
        channel_capacity: usize,
    ) -> Result<Self, UiRuntimeError> {
        let mut router = EventRouter::standard();
        install_core_consumers(&mut router)
            .map_err(|error| UiRuntimeError::InvalidConfiguration(error.to_string()))?;
        install_frontend_provider(&mut router, provider)
            .map_err(|error| UiRuntimeError::InvalidConfiguration(error.to_string()))?;
        Self::from_backend_with_router(state, backend, renderer, router, channel_capacity)
    }

    pub fn from_backend_with_router(
        state: AppState,
        backend: BackendRuntime,
        renderer: R,
        router: EventRouter,
        channel_capacity: usize,
    ) -> Result<Self, UiRuntimeError> {
        if channel_capacity == 0 {
            return Err(UiRuntimeError::InvalidConfiguration(
                "UI channel capacity must be positive".to_owned(),
            ));
        }
        let (sender, receiver) = mpsc::sync_channel(channel_capacity);
        let mailbox = UiMailbox { sender };
        let (backend, outputs, backend_worker) = backend.split();
        let backend_mailbox = mailbox.clone();
        let backend_forwarder = thread::Builder::new()
            .name("phenix-ui-backend-forwarder".to_owned())
            .spawn(move || {
                for output in outputs {
                    if backend_mailbox.send_backend(output).is_err() {
                        break;
                    }
                }
            })
            .map_err(|error| UiRuntimeError::Start(error.to_string()))?;

        Ok(Self {
            state,
            backend,
            renderer,
            router,
            receiver,
            mailbox,
            backend_forwarder: Some(backend_forwarder),
            backend_worker: Some(backend_worker),
            drain_limit: DEFAULT_DRAIN_LIMIT,
            external_io_pause: None,
        })
    }

    pub fn mailbox(&self) -> UiMailbox {
        self.mailbox.clone()
    }

    pub fn set_external_io_pause(&mut self, pause: Arc<AtomicBool>) {
        self.external_io_pause = Some(pause);
    }

    pub fn set_drain_limit(&mut self, drain_limit: usize) -> Result<(), UiRuntimeError> {
        if drain_limit == 0 {
            return Err(UiRuntimeError::InvalidConfiguration(
                "UI drain limit must be positive".to_owned(),
            ));
        }
        self.drain_limit = drain_limit;
        Ok(())
    }

    pub fn spawn_ticker(&self, period: Duration) -> Result<JoinHandle<()>, UiRuntimeError> {
        if period.is_zero() {
            return Err(UiRuntimeError::InvalidConfiguration(
                "UI tick period must be positive".to_owned(),
            ));
        }
        let mailbox = self.mailbox();
        thread::Builder::new()
            .name("phenix-ui-ticker".to_owned())
            .spawn(move || loop {
                thread::sleep(period);
                match mailbox.tick() {
                    Ok(()) | Err(UiIngressError::Coalesced) => {}
                    Err(UiIngressError::Disconnected) => break,
                }
            })
            .map_err(|error| UiRuntimeError::Start(error.to_string()))
    }

    pub fn run(mut self) -> Result<AppState, UiRuntimeError> {
        let mut dirty = true;
        while !self.state.should_quit {
            if dirty {
                self.renderer
                    .render(&self.state)
                    .map_err(UiRuntimeError::Render)?;
                dirty = false;
            }

            let message = self
                .receiver
                .recv()
                .map_err(|_| UiRuntimeError::Disconnected)?;
            dirty |= self.apply(message);

            for _ in 1..self.drain_limit {
                match self.receiver.try_recv() {
                    Ok(message) => dirty |= self.apply(message),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        if !self.state.should_quit {
                            return Err(UiRuntimeError::Disconnected);
                        }
                        break;
                    }
                }
                if self.state.should_quit {
                    break;
                }
            }
        }

        if dirty {
            self.renderer
                .render(&self.state)
                .map_err(UiRuntimeError::Render)?;
        }
        self.detach_workers();
        Ok(std::mem::take(&mut self.state))
    }

    fn apply(&mut self, message: UiMessage) -> bool {
        let reactions = match message {
            UiMessage::Content(envelope) => self.router.route_content(&self.state, &envelope),
            UiMessage::Ui(envelope) => self.router.route_ui(&self.state, &envelope),
            UiMessage::App(event) => vec![BusReaction::App(event)],
        };
        self.apply_reactions(reactions)
    }

    fn apply_reactions(&mut self, reactions: impl IntoIterator<Item = BusReaction>) -> bool {
        let mut queue = VecDeque::from_iter(reactions);
        let mut dirty = false;
        while let Some(reaction) = queue.pop_front() {
            match reaction {
                BusReaction::App(event) => dirty |= self.apply_event(event),
                BusReaction::Content(envelope) => {
                    queue.extend(self.router.route_content(&self.state, &envelope))
                }
                BusReaction::Ui(envelope) => {
                    queue.extend(self.router.route_ui(&self.state, &envelope))
                }
                BusReaction::View(mutation) => {
                    apply_view_mutation(&mut self.state, mutation);
                    dirty = true;
                }
                BusReaction::ExternalEditor => {
                    if let Err(error) = self.edit_with_external_editor() {
                        self.state
                            .notifications
                            .push_back(format!("external editor failed: {error}"));
                    }
                    dirty = true;
                }
                BusReaction::Render => dirty = true,
            }
        }
        dirty
    }

    fn apply_event(&mut self, event: AppEvent) -> bool {
        let mut effects = VecDeque::from(reduce(&mut self.state, event));
        let mut dirty = false;
        while let Some(effect) = effects.pop_front() {
            match effect {
                AppEffect::Send(command) => {
                    if let Err(error) = self.backend.submit(command) {
                        effects.extend(reduce(
                            &mut self.state,
                            AppEvent::BackendSubmitFailed(error.to_string()),
                        ));
                    }
                }
                AppEffect::RunExternal { flow_id, command } => {
                    if let Some(pause) = &self.external_io_pause {
                        pause.store(true, Ordering::Release);
                    }
                    let result = (|| {
                        self.renderer.suspend().map_err(UiRuntimeError::Render)?;
                        let status = Command::new(&command.program)
                            .args(&command.arguments)
                            .envs(&command.environment)
                            .status()
                            .map_err(|error| UiRuntimeError::Start(error.to_string()));
                        let resume = self.renderer.resume().map_err(UiRuntimeError::Render);
                        match (status, resume) {
                            (Ok(status), Ok(())) => Ok((
                                status.success(),
                                status.code().map(|code| format!("exit code {code}")),
                            )),
                            (Err(error), Ok(())) | (_, Err(error)) => Err(error),
                        }
                    })();
                    if let Some(pause) = &self.external_io_pause {
                        pause.store(false, Ordering::Release);
                    }
                    let command = match result {
                        Ok((success, message)) => BackendCommand::AuthTerminalFinished {
                            flow_id,
                            success,
                            message,
                        },
                        Err(error) => BackendCommand::AuthTerminalFinished {
                            flow_id,
                            success: false,
                            message: Some(error.to_string()),
                        },
                    };
                    if let Err(error) = self.backend.submit(command) {
                        effects.extend(reduce(
                            &mut self.state,
                            AppEvent::BackendSubmitFailed(error.to_string()),
                        ));
                    }
                    dirty = true;
                }
                AppEffect::Render => dirty = true,
                AppEffect::Quit => self.state.should_quit = true,
            }
        }
        dirty
    }

    fn edit_with_external_editor(&mut self) -> Result<(), UiRuntimeError> {
        let (program, arguments) = external_editor_command()?;
        let path = external_editor_path();
        fs::write(&path, &self.state.input.text)
            .map_err(|error| UiRuntimeError::ExternalEditor(error.to_string()))?;

        if let Some(pause) = &self.external_io_pause {
            pause.store(true, Ordering::Release);
        }
        let result = (|| {
            self.renderer.suspend().map_err(UiRuntimeError::Render)?;
            let status = Command::new(program)
                .args(arguments)
                .arg(&path)
                .status()
                .map_err(|error| UiRuntimeError::ExternalEditor(error.to_string()));
            let resume = self.renderer.resume().map_err(UiRuntimeError::Render);
            match (status, resume) {
                (Ok(status), Ok(())) if status.success() => Ok(()),
                (Ok(status), Ok(())) => {
                    Err(UiRuntimeError::ExternalEditor(status.code().map_or_else(
                        || "editor terminated by signal".to_owned(),
                        |code| format!("editor exited with code {code}"),
                    )))
                }
                (Err(error), Ok(())) | (_, Err(error)) => Err(error),
            }
        })();
        if let Some(pause) = &self.external_io_pause {
            pause.store(false, Ordering::Release);
        }

        let edited = result.and_then(|()| {
            fs::read_to_string(&path)
                .map_err(|error| UiRuntimeError::ExternalEditor(error.to_string()))
        });
        let _ = fs::remove_file(&path);
        self.state.input.replace(edited?);
        self.state.view.vim_mode = VimMode::Normal;
        sync_command_completion_overlay(&mut self.state);
        update_editor_status(&mut self.state);
        Ok(())
    }
}

impl<R> Drop for UiRuntime<R> {
    fn drop(&mut self) {
        self.detach_workers();
    }
}

fn external_editor_command() -> Result<(String, Vec<String>), UiRuntimeError> {
    let source = ["PHENIX_EXTERNAL_EDITOR", "VISUAL", "EDITOR"]
        .into_iter()
        .find_map(|name| env::var(name).ok().filter(|value| !value.trim().is_empty()))
        .unwrap_or_else(|| "vi".to_owned());
    let mut words = shell_words::split(&source)
        .map_err(|error| UiRuntimeError::ExternalEditor(error.to_string()))?;
    if words.is_empty() {
        return Err(UiRuntimeError::ExternalEditor(
            "editor command is empty".to_owned(),
        ));
    }
    let program = words.remove(0);
    Ok((program, words))
}

fn external_editor_path() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    env::temp_dir().join(format!("phenix-prompt-{}-{nonce}.md", process::id()))
}

fn apply_view_mutation(state: &mut AppState, mutation: ViewMutation) {
    match mutation {
        ViewMutation::SetFocus(focus) => state.view.focus = focus,
        ViewMutation::MoveFocus(direction) => {
            state.view.focus = move_focus(state.view.focus, direction);
        }
        ViewMutation::ResizePane {
            element,
            axis,
            request,
        } => {
            let pane = state.view.pane_mut(element);
            let dimension = match axis {
                LayoutAxis::Horizontal => &mut pane.width,
                LayoutAxis::Vertical => &mut pane.height,
            };
            let current = dimension.unwrap_or(1);
            *dimension = Some(match request {
                ResizeRequest::Grow(amount) => current.saturating_add(amount).max(1),
                ResizeRequest::Shrink(amount) => current.saturating_sub(amount).max(1),
                ResizeRequest::Set(value) => value.max(1),
            });
        }
        ViewMutation::SetPaneVisibility { element, visible } => {
            state.view.pane_mut(element.clone()).visible = visible;
            if !visible && FocusTarget::from_element(&element) == Some(state.view.focus) {
                state.view.focus = FocusTarget::Input;
            }
        }
        ViewMutation::ScrollPane { element, lines } => {
            let scroll = match element.as_str() {
                "ui.sidebar" => Some(&mut state.view.sidebar_scroll),
                "ui.transcript" => Some(&mut state.view.transcript_scroll),
                _ => None,
            };
            if let Some(scroll) = scroll {
                scroll.follow_end = false;
                scroll.offset = scroll.offset.saturating_add_signed(lines as isize);
            }
        }
        ViewMutation::MoveTranscriptTurn(delta) => move_transcript_turn(state, delta),
        ViewMutation::ToggleTranscriptTurnDetails => toggle_transcript_turn_details(state),
        ViewMutation::MoveTranscriptBlock(delta) => move_transcript_block(state, delta),
        ViewMutation::CycleTranscriptBlockView(delta) => cycle_transcript_block_view(state, delta),
        ViewMutation::ScrollTranscriptBlock {
            horizontal,
            vertical,
        } => scroll_transcript_block(state, horizontal, vertical),
        ViewMutation::EditInput(edit) => apply_input_edit(state, edit),
        ViewMutation::MoveOverlaySelection(delta) => move_overlay_selection(state, delta),
        ViewMutation::Notify(message) => state.notifications.push_back(message),
    }
}

fn move_transcript_turn(state: &mut AppState, delta: i32) {
    let turn_ids = state.active_transcript_turn_ids();
    if turn_ids.is_empty() {
        state.view.transcript_selected_turn = None;
        state.view.transcript_selected_block = None;
        return;
    }
    let last = turn_ids.len() - 1;
    let current = state
        .view
        .transcript_selected_turn
        .unwrap_or(last)
        .min(last);
    state.view.transcript_selected_turn =
        Some(current.saturating_add_signed(delta as isize).min(last));
    state.view.transcript_selected_block = None;
    state.view.transcript_scroll.follow_end = false;
}

fn toggle_transcript_turn_details(state: &mut AppState) {
    let turn_ids = state.active_transcript_turn_ids();
    if turn_ids.is_empty() {
        return;
    }
    let last = turn_ids.len() - 1;
    let selected = state
        .view
        .transcript_selected_turn
        .unwrap_or(last)
        .min(last);
    state.view.transcript_selected_turn = Some(selected);
    state
        .view
        .toggle_transcript_turn(turn_ids[selected].clone());
}

fn selected_rich_document(state: &AppState) -> Option<(String, phenix_ui_core::RichDocument)> {
    let run_id = state.input_target()?;
    let transcript = state.transcript(run_id)?;
    let turns = group_transcript_turns(&transcript.blocks);
    let last = turns.len().checked_sub(1)?;
    let selected = state
        .view
        .transcript_selected_turn
        .unwrap_or(last)
        .min(last);
    let turn = &turns[selected];
    Some((turn.id.clone(), parse_markdown(&turn.response)))
}

fn interactive_rich_blocks(document: &phenix_ui_core::RichDocument) -> Vec<usize> {
    document
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| block.is_interactive().then_some(index))
        .collect()
}

fn rich_block_key(turn_id: &str, index: usize) -> String {
    format!("{turn_id}:block:{index}")
}

fn move_transcript_block(state: &mut AppState, delta: i32) {
    let Some((_, document)) = selected_rich_document(state) else {
        state.view.transcript_selected_block = None;
        return;
    };
    let interactive = interactive_rich_blocks(&document);
    if interactive.is_empty() {
        state.view.transcript_selected_block = None;
        return;
    }
    let next = state
        .view
        .transcript_selected_block
        .and_then(|selected| interactive.iter().position(|index| *index == selected))
        .map_or_else(
            || {
                if delta.is_negative() {
                    interactive.len() - 1
                } else {
                    0
                }
            },
            |current| {
                current
                    .saturating_add_signed(delta as isize)
                    .min(interactive.len() - 1)
            },
        );
    state.view.transcript_selected_block = Some(interactive[next]);
    state.view.transcript_scroll.follow_end = false;
}

fn cycle_transcript_block_view(state: &mut AppState, delta: i32) {
    let Some((turn_id, document)) = selected_rich_document(state) else {
        return;
    };
    let interactive = interactive_rich_blocks(&document);
    let Some(block_index) = state
        .view
        .transcript_selected_block
        .filter(|selected| interactive.contains(selected))
        .or_else(|| interactive.first().copied())
    else {
        return;
    };
    state.view.transcript_selected_block = Some(block_index);
    let block = &document.blocks[block_index];
    let views = block.candidate_views();
    let key = rich_block_key(&turn_id, block_index);
    let current = state
        .view
        .rich_block_view(&key)
        .filter(|view| views.contains(view))
        .unwrap_or_else(|| block.default_view());
    let current_index = views.iter().position(|view| *view == current).unwrap_or(0);
    let len = i64::try_from(views.len()).unwrap_or(1).max(1);
    let next = (i64::try_from(current_index).unwrap_or(0) + i64::from(delta)).rem_euclid(len);
    let next = usize::try_from(next).unwrap_or(0);
    state.view.set_rich_block_view(key, views[next]);
}

fn scroll_transcript_block(state: &mut AppState, horizontal: i32, vertical: i32) {
    let Some((turn_id, document)) = selected_rich_document(state) else {
        return;
    };
    let interactive = interactive_rich_blocks(&document);
    let Some(block_index) = state
        .view
        .transcript_selected_block
        .filter(|selected| interactive.contains(selected))
        .or_else(|| interactive.first().copied())
    else {
        return;
    };
    state.view.transcript_selected_block = Some(block_index);
    let viewport = state
        .view
        .rich_block_viewport_mut(rich_block_key(&turn_id, block_index));
    viewport.horizontal = viewport
        .horizontal
        .saturating_add_signed(horizontal as isize);
    viewport.vertical = viewport.vertical.saturating_add_signed(vertical as isize);
}

fn apply_input_edit(state: &mut AppState, edit: InputEdit) {
    match edit {
        InputEdit::Insert(text) => state.input.insert(&text),
        InputEdit::Backspace => state.input.backspace(),
        InputEdit::Delete => state.input.delete(),
        InputEdit::DeleteLine => state.input.delete_line(),
        InputEdit::MoveLeft => state.input.move_left(),
        InputEdit::MoveRight => state.input.move_right(),
        InputEdit::MoveUp => state.input.move_up(),
        InputEdit::MoveDown => state.input.move_down(),
        InputEdit::MoveHome => state.input.move_home(),
        InputEdit::MoveEnd => state.input.move_end(),
        InputEdit::MoveWordForward => state.input.move_word_forward(),
        InputEdit::MoveWordBackward => state.input.move_word_backward(),
        InputEdit::HistoryPrevious => {
            if state.input.history.is_empty() {
                return;
            }
            let offset = state
                .input
                .history_cursor
                .map_or(0, |offset| (offset + 1).min(state.input.history.len() - 1));
            state.input.history_cursor = Some(offset);
            let index = state.input.history.len() - 1 - offset;
            state.input.text = state.input.history[index].clone();
            state.input.cursor_byte = state.input.text.len();
        }
        InputEdit::HistoryNext => {
            let Some(offset) = state.input.history_cursor else {
                return;
            };
            if offset == 0 {
                state.input.history_cursor = None;
                state.input.text.clear();
                state.input.cursor_byte = 0;
            } else {
                let next = offset - 1;
                state.input.history_cursor = Some(next);
                let index = state.input.history.len() - 1 - next;
                state.input.text = state.input.history[index].clone();
                state.input.cursor_byte = state.input.text.len();
            }
        }
        InputEdit::SetEditor(editor) => {
            state.view.set_input_editor(editor);
            update_editor_status(state);
        }
        InputEdit::SetVimMode(mode) => {
            state.view.vim_mode = mode;
            update_editor_status(state);
        }
    }
    sync_command_completion_overlay(state);
}

fn sync_command_completion_overlay(state: &mut AppState) {
    if !matches!(
        state.view.overlay,
        None | Some(OverlayState::CommandPalette { .. })
    ) {
        return;
    }
    let completions = command_completions(state);
    if completions.is_empty() {
        if matches!(
            state.view.overlay,
            Some(OverlayState::CommandPalette { .. })
        ) {
            state.view.overlay = None;
        }
        return;
    }
    let selected = match &state.view.overlay {
        Some(OverlayState::CommandPalette { selected, .. }) => {
            (*selected).min(completions.len().saturating_sub(1))
        }
        _ => 0,
    };
    state.view.overlay = Some(OverlayState::CommandPalette {
        query: state.input.text.clone(),
        selected,
    });
}

fn update_editor_status(state: &mut AppState) {
    state.statuses.insert(
        "frontend.editor".to_owned(),
        format!(
            "editor: {} · {}",
            state.view.input_editor.label(),
            state.view.vim_mode.label()
        ),
    );
}

fn move_overlay_selection(state: &mut AppState, delta: i32) {
    let length = match &state.view.overlay {
        Some(OverlayState::CommandPalette { .. }) => command_completions(state).len(),
        Some(OverlayState::ModelPicker { .. }) => state.models.len(),
        Some(OverlayState::AuthenticationProviders { .. }) => state.auth_providers.len(),
        Some(OverlayState::AuthenticationPrompt { prompt, .. }) => match prompt {
            phenix_runtime_api::AuthPrompt::Select { options, .. } => options.len(),
            _ => 0,
        },
        Some(OverlayState::SessionPicker { .. }) => state
            .snapshot
            .as_ref()
            .map_or(0, |snapshot| snapshot.sessions.len()),
        Some(OverlayState::ExtensionDialog { request, .. }) => match request {
            phenix_runtime_api::ExtensionUiRequest::Select { options, .. } => options.len(),
            _ => 0,
        },
        Some(OverlayState::Help) | None => 0,
    };
    if length == 0 {
        return;
    }
    let selected = match state.view.overlay.as_mut() {
        Some(OverlayState::CommandPalette { selected, .. })
        | Some(OverlayState::ModelPicker { selected, .. })
        | Some(OverlayState::AuthenticationProviders { selected, .. })
        | Some(OverlayState::AuthenticationPrompt { selected, .. })
        | Some(OverlayState::SessionPicker { selected, .. })
        | Some(OverlayState::ExtensionDialog { selected, .. }) => selected,
        Some(OverlayState::Help) | None => return,
    };
    *selected = selected
        .saturating_add_signed(delta as isize)
        .min(length.saturating_sub(1));
}

fn move_focus(current: FocusTarget, direction: FocusDirection) -> FocusTarget {
    match direction {
        FocusDirection::Next => match current {
            FocusTarget::Sidebar => FocusTarget::Transcript,
            FocusTarget::Transcript => FocusTarget::Input,
            FocusTarget::Input | FocusTarget::Overlay => FocusTarget::Sidebar,
        },
        FocusDirection::Previous => match current {
            FocusTarget::Sidebar => FocusTarget::Input,
            FocusTarget::Transcript => FocusTarget::Sidebar,
            FocusTarget::Input | FocusTarget::Overlay => FocusTarget::Transcript,
        },
        FocusDirection::Left => FocusTarget::Transcript,
        FocusDirection::Right => FocusTarget::Sidebar,
        FocusDirection::Up => FocusTarget::Transcript,
        FocusDirection::Down => FocusTarget::Input,
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum UiRuntimeError {
    InvalidConfiguration(String),
    Start(String),
    Render(String),
    ExternalEditor(String),
    Disconnected,
}

impl Display for UiRuntimeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfiguration(message) => {
                write!(formatter, "invalid UI runtime configuration: {message}")
            }
            Self::Start(message) => write!(formatter, "failed to start UI producer: {message}"),
            Self::Render(message) => write!(formatter, "failed to render UI: {message}"),
            Self::ExternalEditor(message) => write!(formatter, "external editor error: {message}"),
            Self::Disconnected => formatter.write_str("all UI message producers disconnected"),
        }
    }
}

impl Error for UiRuntimeError {}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_runtime_api::{TranscriptBlock, TranscriptRole};

    #[test]
    fn view_mutations_preserve_editor_cursor_and_pane_size() {
        let mut state = AppState::default();
        apply_view_mutation(
            &mut state,
            ViewMutation::EditInput(InputEdit::Insert("abc".to_owned())),
        );
        apply_view_mutation(&mut state, ViewMutation::EditInput(InputEdit::MoveLeft));
        apply_view_mutation(
            &mut state,
            ViewMutation::EditInput(InputEdit::Insert("x".to_owned())),
        );
        assert_eq!(state.input.text, "abxc");

        apply_view_mutation(
            &mut state,
            ViewMutation::ResizePane {
                element: ElementId::sidebar(),
                axis: LayoutAxis::Horizontal,
                request: ResizeRequest::Grow(4),
            },
        );
        assert_eq!(state.view.pane(&ElementId::sidebar()).width, Some(32));
    }

    #[test]
    fn transcript_turns_are_selected_and_expanded_independently() {
        let run_id = phenix_runtime_api::RunId::parse("run-1").expect("run id");
        let mut state = AppState {
            root_run: Some(run_id.clone()),
            ..AppState::default()
        };
        for (id, role) in [
            ("u1", TranscriptRole::User),
            ("a1", TranscriptRole::Assistant),
            ("u2", TranscriptRole::User),
            ("a2", TranscriptRole::Assistant),
        ] {
            state
                .transcript_mut(run_id.clone())
                .append(TranscriptBlock {
                    id: id.to_owned(),
                    run_id: run_id.clone(),
                    role,
                    text: id.to_owned(),
                    complete: true,
                });
        }
        apply_view_mutation(&mut state, ViewMutation::MoveTranscriptTurn(-1));
        assert_eq!(state.view.transcript_selected_turn, Some(0));
        apply_view_mutation(&mut state, ViewMutation::ToggleTranscriptTurnDetails);
        assert!(state.view.transcript_turn_is_expanded("run-1:u1"));
        assert!(!state.view.transcript_turn_is_expanded("run-1:u2"));
    }

    #[test]
    fn rich_blocks_have_independent_views_and_viewports() {
        let run_id = phenix_runtime_api::RunId::parse("run-rich").expect("run id");
        let mut state = AppState {
            root_run: Some(run_id.clone()),
            ..AppState::default()
        };
        state.selected_run = Some(run_id.clone());
        state
            .transcript_mut(run_id.clone())
            .append(TranscriptBlock {
                id: "u1".to_owned(),
                run_id: run_id.clone(),
                role: TranscriptRole::User,
                text: "show it".to_owned(),
                complete: true,
            });
        state
            .transcript_mut(run_id.clone())
            .append(TranscriptBlock {
                id: "a1".to_owned(),
                run_id,
                role: TranscriptRole::Assistant,
                text:
                    "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```mermaid\nflowchart LR\nA --> B\n```"
                        .to_owned(),
                complete: true,
            });

        move_transcript_block(&mut state, 1);
        assert_eq!(state.view.transcript_selected_block, Some(0));
        cycle_transcript_block_view(&mut state, 1);
        assert_eq!(
            state.view.rich_block_view("run-rich:u1:block:0"),
            Some(RichBlockView::Grid)
        );

        move_transcript_block(&mut state, 1);
        assert_eq!(state.view.transcript_selected_block, Some(1));
        scroll_transcript_block(&mut state, 4, 2);
        assert_eq!(
            state
                .view
                .rich_block_viewport("run-rich:u1:block:1")
                .horizontal,
            4
        );
        assert_eq!(
            state
                .view
                .rich_block_viewport("run-rich:u1:block:1")
                .vertical,
            2
        );
    }

    #[test]
    fn editor_mode_updates_are_local_and_visible_in_status() {
        let mut state = AppState::default();
        state.view.terminal.height = 36;
        apply_input_edit(&mut state, InputEdit::SetEditor(InputEditor::Embedded));
        assert_eq!(state.view.pane(&ElementId::input()).height, Some(12));
        assert_eq!(
            state.statuses.get("frontend.editor").map(String::as_str),
            Some("editor: embedded · normal")
        );

        apply_input_edit(&mut state, InputEdit::SetVimMode(VimMode::Insert));
        assert_eq!(
            state.statuses.get("frontend.editor").map(String::as_str),
            Some("editor: embedded · insert")
        );
    }

    #[test]
    fn external_editor_paths_are_unique_and_markdown_typed() {
        let first = external_editor_path();
        let second = external_editor_path();
        assert_eq!(
            first.extension().and_then(|value| value.to_str()),
            Some("md")
        );
        assert!(first.starts_with(env::temp_dir()));
        assert!(second.starts_with(env::temp_dir()));
    }

    #[test]
    fn slash_input_opens_and_updates_a_command_completion_overlay() {
        let mut state = AppState::default();
        apply_input_edit(&mut state, InputEdit::Insert("/mo".to_owned()));
        assert!(matches!(
            state.view.overlay,
            Some(OverlayState::CommandPalette { selected: 0, .. })
        ));
        move_overlay_selection(&mut state, 1);
        assert!(matches!(
            state.view.overlay,
            Some(OverlayState::CommandPalette { selected: 1, .. })
        ));
        apply_input_edit(&mut state, InputEdit::Insert("del".to_owned()));
        assert!(state.view.overlay.is_none());
    }
}
