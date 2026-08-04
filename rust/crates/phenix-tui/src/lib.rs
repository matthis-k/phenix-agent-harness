#![forbid(unsafe_code)]

use phenix_runtime_api::{
    AuthPrompt, AuthPromptResponse, ExtensionUiRequest, ExtensionUiResponse, TranscriptRole,
};
use phenix_ui_core::{
    AppEvent, AppState, FocusTarget, KeyCode, KeyInput, OverlayState, UiInput, UserIntent,
};
use phenix_ui_runtime::{UiInputController, UiRenderer};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Wrap};
use ratatui::{DefaultTerminal, Frame};
use std::io;

const SURFACE: Color = Color::Rgb(30, 30, 46);
const SURFACE_ALT: Color = Color::Rgb(49, 50, 68);
const TEXT: Color = Color::Rgb(205, 214, 244);
const SUBTEXT: Color = Color::Rgb(166, 173, 200);
const ACCENT: Color = Color::Rgb(137, 180, 250);
const GREEN: Color = Color::Rgb(166, 227, 161);
const YELLOW: Color = Color::Rgb(249, 226, 175);
const RED: Color = Color::Rgb(243, 139, 168);

pub struct RatatuiRenderer {
    terminal: Option<DefaultTerminal>,
}

impl RatatuiRenderer {
    pub fn initialize() -> io::Result<Self> {
        Ok(Self {
            terminal: Some(ratatui::try_init()?),
        })
    }
}

impl UiRenderer for RatatuiRenderer {
    fn render(&mut self, state: &AppState) -> Result<(), String> {
        self.terminal
            .as_mut()
            .ok_or_else(|| "terminal is already restored".to_owned())?
            .draw(|frame| render_application(frame, state))
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

impl Drop for RatatuiRenderer {
    fn drop(&mut self) {
        self.terminal.take();
        ratatui::restore();
    }
}

#[derive(Default)]
pub struct PhenixInputController {
    history_offset: Option<usize>,
}

impl UiInputController for PhenixInputController {
    fn handle(&mut self, state: &AppState, input: UiInput) -> Vec<AppEvent> {
        match input {
            UiInput::Key(key) => self.handle_key(state, key),
            UiInput::Paste(text) => edit_input(state, |current| current.push_str(&text)),
            UiInput::Resize { .. }
            | UiInput::Mouse(_)
            | UiInput::FocusGained
            | UiInput::FocusLost => Vec::new(),
        }
    }
}

impl PhenixInputController {
    fn handle_key(&mut self, state: &AppState, key: KeyInput) -> Vec<AppEvent> {
        if key.modifiers.control {
            return match key.code {
                KeyCode::Character('d') | KeyCode::Character('q') => user(UserIntent::Quit),
                KeyCode::Character('c') => user(UserIntent::Abort),
                KeyCode::Character('l') => user(UserIntent::OpenAuthentication),
                KeyCode::Character('m') => user(UserIntent::OpenModelPicker),
                KeyCode::Character('r') => user(UserIntent::OpenSessionPicker),
                KeyCode::Character('o') => user(UserIntent::ToggleDetails),
                KeyCode::Enter => user(UserIntent::SteerPrompt),
                _ => Vec::new(),
            };
        }
        if key.modifiers.alt && key.code == KeyCode::Enter {
            return user(UserIntent::FollowUpPrompt);
        }

        match key.code {
            KeyCode::Escape => self.escape(state),
            KeyCode::Enter => self.enter(state, key.modifiers.shift),
            KeyCode::Tab => user(UserIntent::SetFocus(next_focus(state.view.focus))),
            KeyCode::BackTab => user(UserIntent::SetFocus(previous_focus(state.view.focus))),
            KeyCode::Backspace => edit_input(state, |current| {
                current.pop();
            }),
            KeyCode::Character(character) if !key.modifiers.alt => {
                self.history_offset = None;
                edit_input(state, |current| current.push(character))
            }
            KeyCode::Up => self.up(state),
            KeyCode::Down => self.down(state),
            KeyCode::PageUp => select_relative_run(state, -5),
            KeyCode::PageDown => select_relative_run(state, 5),
            _ => Vec::new(),
        }
    }

    fn escape(&mut self, state: &AppState) -> Vec<AppEvent> {
        if let Some(OverlayState::AuthenticationPrompt { flow_id, .. }) = &state.view.overlay {
            return user(UserIntent::CancelAuthentication(flow_id.clone()));
        }
        if state.view.overlay.is_some() {
            return user(UserIntent::CloseOverlay);
        }
        if !state.dialogs.is_empty() {
            return user(UserIntent::RespondToDialog(ExtensionUiResponse::Cancelled));
        }
        user(UserIntent::Abort)
    }

    fn enter(&mut self, state: &AppState, shift: bool) -> Vec<AppEvent> {
        if shift {
            return edit_input(state, |current| current.push('\n'));
        }
        if !state.dialogs.is_empty() {
            return respond_to_dialog(state);
        }
        match &state.view.overlay {
            Some(OverlayState::ModelPicker { .. }) => state
                .models
                .first()
                .map_or_else(Vec::new, |model| user(UserIntent::SelectModel(model.model.clone()))),
            Some(OverlayState::AuthenticationProviders { .. }) => state
                .auth_providers
                .first()
                .and_then(|provider| {
                    provider
                        .methods
                        .first()
                        .map(|method| UserIntent::StartAuthentication {
                            provider_id: provider.id.clone(),
                            method: method.clone(),
                        })
                })
                .map_or_else(Vec::new, user),
            Some(OverlayState::AuthenticationPrompt {
                flow_id,
                prompt,
                selected,
                ..
            }) => vec![
                AppEvent::User(UserIntent::InputChanged(String::new())),
                AppEvent::User(UserIntent::RespondToAuthentication {
                    flow_id: flow_id.clone(),
                    response: auth_response(prompt, &state.input.text, *selected),
                }),
            ],
            Some(OverlayState::SessionPicker { .. }) => state
                .snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.sessions.first())
                .map_or_else(Vec::new, |session| {
                    user(UserIntent::SwitchSession(session.id.clone()))
                }),
            Some(OverlayState::ExtensionDialog { .. }) => respond_to_dialog(state),
            Some(OverlayState::CommandPalette { .. }) | Some(OverlayState::Help) => Vec::new(),
            None => user(UserIntent::SubmitPrompt),
        }
    }

    fn up(&mut self, state: &AppState) -> Vec<AppEvent> {
        if state.view.focus == FocusTarget::Sidebar {
            return select_relative_run(state, -1);
        }
        if state.view.overlay.is_some() || state.input.history.is_empty() {
            return Vec::new();
        }
        let next = self
            .history_offset
            .map_or(0, |offset| (offset + 1).min(state.input.history.len() - 1));
        self.history_offset = Some(next);
        let index = state.input.history.len() - 1 - next;
        user(UserIntent::InputChanged(state.input.history[index].clone()))
    }

    fn down(&mut self, state: &AppState) -> Vec<AppEvent> {
        if state.view.focus == FocusTarget::Sidebar {
            return select_relative_run(state, 1);
        }
        let Some(offset) = self.history_offset else {
            return Vec::new();
        };
        if offset == 0 {
            self.history_offset = None;
            return user(UserIntent::InputChanged(String::new()));
        }
        let next = offset - 1;
        self.history_offset = Some(next);
        let index = state.input.history.len() - 1 - next;
        user(UserIntent::InputChanged(state.input.history[index].clone()))
    }
}

fn render_application(frame: &mut Frame<'_>, state: &AppState) {
    let area = frame.area();
    frame.render_widget(Block::new().style(Style::default().bg(SURFACE)), area);
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(5),
            Constraint::Length(input_height(state, area.width)),
            Constraint::Length(1),
        ])
        .split(area);
    render_header(frame, vertical[0], state);
    render_body(frame, vertical[1], state);
    render_input(frame, vertical[2], state);
    render_footer(frame, vertical[3], state);
    render_overlay(frame, area, state);
}

fn render_header(frame: &mut Frame<'_>, area: Rect, state: &AppState) {
    let session = state
        .active_session
        .as_ref()
        .map_or_else(|| "new session".to_owned(), ToString::to_string);
    let target = state
        .input_target()
        .map_or_else(|| "no run".to_owned(), ToString::to_string);
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                " Phenix ",
                Style::default()
                    .fg(SURFACE)
                    .bg(ACCENT)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(format!("  {session}"), Style::default().fg(TEXT)),
            Span::styled(format!("  → {target}"), Style::default().fg(SUBTEXT)),
        ]))
        .style(Style::default().bg(SURFACE_ALT)),
        area,
    );
}

fn render_body(frame: &mut Frame<'_>, area: Rect, state: &AppState) {
    let horizontal = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(72), Constraint::Percentage(28)])
        .split(area);
    render_transcript(frame, horizontal[0], state);
    render_sidebar(frame, horizontal[1], state);
}

fn render_transcript(frame: &mut Frame<'_>, area: Rect, state: &AppState) {
    let block = panel("Transcript", state.view.focus == FocusTarget::Transcript);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let lines = state
        .input_target()
        .and_then(|run_id| state.transcript(run_id))
        .map_or_else(
            || vec![Line::styled("No transcript yet.", Style::default().fg(SUBTEXT))],
            |transcript| {
                transcript
                    .blocks
                    .iter()
                    .flat_map(|entry| transcript_lines(&entry.role, &entry.text))
                    .collect()
            },
        );
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((state.view.transcript_scroll.offset.min(u16::MAX as usize) as u16, 0)),
        inner,
    );
}

fn render_sidebar(frame: &mut Frame<'_>, area: Rect, state: &AppState) {
    let block = panel("Runs", state.view.focus == FocusTarget::Sidebar);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let items = state.snapshot.as_ref().map_or_else(Vec::new, |snapshot| {
        snapshot
            .runs
            .iter()
            .map(|run| {
                let selected = state.input_target() == Some(&run.id);
                let marker = if selected { "▸" } else { " " };
                let details = if state.view.show_details {
                    format!(" · {} · {:?}", run.definition_id, run.state)
                } else {
                    format!(" · {:?}", run.state)
                };
                ListItem::new(Line::from(vec![
                    Span::styled(
                        format!("{marker} {}", run.display_name),
                        if selected {
                            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
                        } else {
                            Style::default().fg(TEXT)
                        },
                    ),
                    Span::styled(details, Style::default().fg(SUBTEXT)),
                ]))
            })
            .collect()
    });
    frame.render_widget(
        if items.is_empty() {
            List::new(vec![ListItem::new("Waiting for runtime snapshot…")])
        } else {
            List::new(items)
        },
        inner,
    );
}

fn render_input(frame: &mut Frame<'_>, area: Rect, state: &AppState) {
    let focused = state.view.focus == FocusTarget::Input && state.view.overlay.is_none();
    let block = panel("Input", focused);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    frame.render_widget(
        Paragraph::new(state.input.text.as_str())
            .style(Style::default().fg(TEXT))
            .wrap(Wrap { trim: false }),
        inner,
    );
    if focused && inner.height > 0 {
        let (column, row) = cursor_position(&state.input.text, inner.width.max(1));
        frame.set_cursor_position((
            inner.x.saturating_add(column.min(inner.width.saturating_sub(1))),
            inner.y.saturating_add(row.min(inner.height.saturating_sub(1))),
        ));
    }
}

fn render_footer(frame: &mut Frame<'_>, area: Rect, state: &AppState) {
    let status = state
        .statuses
        .iter()
        .map(|(key, value)| format!("{key}: {value}"))
        .collect::<Vec<_>>()
        .join(" · ");
    let notification = state.notifications.back().cloned().unwrap_or_default();
    let line = [format!("{:?}", state.connection), status, notification]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("  ·  ");
    frame.render_widget(
        Paragraph::new(line)
            .style(Style::default().fg(SUBTEXT).bg(SURFACE_ALT))
            .wrap(Wrap { trim: true }),
        area,
    );
}

fn render_overlay(frame: &mut Frame<'_>, area: Rect, state: &AppState) {
    if let Some(dialog) = state.dialogs.front() {
        render_extension_dialog(frame, centered(area, 70, 55), &dialog.request, state);
        return;
    }
    let Some(overlay) = &state.view.overlay else {
        return;
    };
    let overlay_area = centered(area, 70, 65);
    frame.render_widget(Clear, overlay_area);
    match overlay {
        OverlayState::ModelPicker { .. } => render_picker(
            frame,
            overlay_area,
            "Models",
            state
                .models
                .iter()
                .map(|model| {
                    format!(
                        "{}/{}  {}",
                        model.model.provider, model.model.model, model.display_name
                    )
                })
                .collect(),
        ),
        OverlayState::AuthenticationProviders { .. } => render_picker(
            frame,
            overlay_area,
            "Authentication",
            state
                .auth_providers
                .iter()
                .map(|provider| {
                    format!(
                        "{}  ({})",
                        provider.display_name,
                        if provider.configured { "configured" } else { "login" }
                    )
                })
                .collect(),
        ),
        OverlayState::SessionPicker { .. } => render_picker(
            frame,
            overlay_area,
            "Resume session",
            state
                .snapshot
                .as_ref()
                .into_iter()
                .flat_map(|snapshot| snapshot.sessions.iter())
                .map(|session| {
                    session
                        .name
                        .clone()
                        .unwrap_or_else(|| session.id.to_string())
                })
                .collect(),
        ),
        OverlayState::AuthenticationPrompt {
            flow_id, prompt, ..
        } => render_auth_prompt(frame, overlay_area, flow_id.as_str(), prompt, state),
        OverlayState::ExtensionDialog { request, .. } => {
            render_extension_dialog(frame, overlay_area, request, state)
        }
        OverlayState::CommandPalette { .. } => render_picker(
            frame,
            overlay_area,
            "Commands",
            state
                .commands
                .iter()
                .map(|command| format!("/{}", command.name))
                .collect(),
        ),
        OverlayState::Help => render_picker(
            frame,
            overlay_area,
            "Help",
            vec![
                "Ctrl+L login · Ctrl+M models · Ctrl+R sessions".to_owned(),
                "Ctrl+Enter steer · Alt+Enter follow-up · Esc abort".to_owned(),
                "Tab focus · Ctrl+O details · Ctrl+D exit".to_owned(),
            ],
        ),
    }
}

fn render_picker(frame: &mut Frame<'_>, area: Rect, title: &str, values: Vec<String>) {
    let block = panel(title, true);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let items = if values.is_empty() {
        vec![ListItem::new("No entries available.")]
    } else {
        values
            .into_iter()
            .enumerate()
            .map(|(index, value)| {
                ListItem::new(format!("{} {value}", if index == 0 { "▸" } else { " " }))
                    .style(if index == 0 {
                        Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(TEXT)
                    })
            })
            .collect()
    };
    frame.render_widget(List::new(items), inner);
}

fn render_auth_prompt(
    frame: &mut Frame<'_>,
    area: Rect,
    flow_id: &str,
    prompt: &AuthPrompt,
    state: &AppState,
) {
    let title = format!("Authentication · {flow_id}");
    let block = panel(&title, true);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let mut lines = vec![Line::styled(
        auth_prompt_message(prompt),
        Style::default().fg(TEXT),
    )];
    match prompt {
        AuthPrompt::Select { options, .. } => lines.extend(options.iter().enumerate().map(
            |(index, option)| {
                Line::styled(
                    format!("{} {}", if index == 0 { "▸" } else { " " }, option.label),
                    if index == 0 {
                        Style::default().fg(ACCENT)
                    } else {
                        Style::default().fg(TEXT)
                    },
                )
            },
        )),
        AuthPrompt::Secret { .. } => lines.push(Line::styled(
            "•".repeat(state.input.text.chars().count()),
            Style::default().fg(ACCENT),
        )),
        AuthPrompt::Text { .. } | AuthPrompt::ManualCode { .. } => lines.push(Line::styled(
            state.input.text.clone(),
            Style::default().fg(ACCENT),
        )),
    }
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn render_extension_dialog(
    frame: &mut Frame<'_>,
    area: Rect,
    request: &ExtensionUiRequest,
    state: &AppState,
) {
    frame.render_widget(Clear, area);
    let (title, mut lines) = match request {
        ExtensionUiRequest::Select { title, options } => (
            title.as_str(),
            options
                .iter()
                .enumerate()
                .map(|(index, option)| {
                    Line::styled(
                        format!("{} {option}", if index == 0 { "▸" } else { " " }),
                        if index == 0 {
                            Style::default().fg(ACCENT)
                        } else {
                            Style::default().fg(TEXT)
                        },
                    )
                })
                .collect::<Vec<_>>(),
        ),
        ExtensionUiRequest::Confirm { title, message } => (
            title.as_str(),
            vec![Line::styled(message.clone(), Style::default().fg(TEXT))],
        ),
        ExtensionUiRequest::Input { title, secret, .. } => (
            title.as_str(),
            vec![Line::styled(
                if *secret {
                    "•".repeat(state.input.text.chars().count())
                } else {
                    state.input.text.clone()
                },
                Style::default().fg(ACCENT),
            )],
        ),
        ExtensionUiRequest::Editor { title, prefill } => (
            title.as_str(),
            vec![Line::styled(
                if state.input.text.is_empty() {
                    prefill.clone().unwrap_or_default()
                } else {
                    state.input.text.clone()
                },
                Style::default().fg(TEXT),
            )],
        ),
    };
    lines.push(Line::styled(
        "Enter: submit · Esc: cancel",
        Style::default().fg(SUBTEXT),
    ));
    let block = panel(title, true);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn panel<'a>(title: &'a str, focused: bool) -> Block<'a> {
    Block::default()
        .borders(Borders::ALL)
        .title(Span::styled(
            format!(" {title} "),
            Style::default().fg(if focused { ACCENT } else { SUBTEXT }),
        ))
        .border_style(Style::default().fg(if focused { ACCENT } else { SURFACE_ALT }))
        .style(Style::default().bg(SURFACE).fg(TEXT))
}

fn centered(area: Rect, width_percent: u16, height_percent: u16) -> Rect {
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - height_percent) / 2),
            Constraint::Percentage(height_percent),
            Constraint::Percentage((100 - height_percent) / 2),
        ])
        .split(area);
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - width_percent) / 2),
            Constraint::Percentage(width_percent),
            Constraint::Percentage((100 - width_percent) / 2),
        ])
        .split(vertical[1])[1]
}

fn input_height(state: &AppState, width: u16) -> u16 {
    let width = width.saturating_sub(4).max(1) as usize;
    let visual_lines = state
        .input
        .text
        .split('\n')
        .map(|line| line.chars().count().div_ceil(width).max(1))
        .sum::<usize>();
    (visual_lines + 2).clamp(3, 10) as u16
}

fn cursor_position(text: &str, width: u16) -> (u16, u16) {
    let width = width.max(1) as usize;
    let mut row = 0usize;
    let mut column = 0usize;
    for character in text.chars() {
        if character == '\n' {
            row += 1;
            column = 0;
        } else {
            column += 1;
            if column >= width {
                row += 1;
                column = 0;
            }
        }
    }
    (column.min(u16::MAX as usize) as u16, row.min(u16::MAX as usize) as u16)
}

fn transcript_lines(role: &TranscriptRole, text: &str) -> Vec<Line<'static>> {
    let (label, color) = match role {
        TranscriptRole::User => ("you", ACCENT),
        TranscriptRole::Assistant => ("assistant", GREEN),
        TranscriptRole::Thinking => ("thinking", YELLOW),
        TranscriptRole::Tool => ("tool", Color::Rgb(203, 166, 247)),
        TranscriptRole::System => ("system", RED),
    };
    let mut lines = vec![Line::styled(
        format!("{label} ─"),
        Style::default().fg(color).add_modifier(Modifier::BOLD),
    )];
    lines.extend(text.lines().map(|line| Line::from(line.to_owned())));
    lines.push(Line::default());
    lines
}

fn respond_to_dialog(state: &AppState) -> Vec<AppEvent> {
    let Some(dialog) = state.dialogs.front() else {
        return Vec::new();
    };
    let response = match &dialog.request {
        ExtensionUiRequest::Select { options, .. } => options
            .first()
            .cloned()
            .map_or(ExtensionUiResponse::Cancelled, ExtensionUiResponse::Selected),
        ExtensionUiRequest::Confirm { .. } => ExtensionUiResponse::Confirmed(true),
        ExtensionUiRequest::Input { .. } | ExtensionUiRequest::Editor { .. } => {
            ExtensionUiResponse::Text(state.input.text.clone())
        }
    };
    vec![
        AppEvent::User(UserIntent::InputChanged(String::new())),
        AppEvent::User(UserIntent::RespondToDialog(response)),
    ]
}

fn auth_response(prompt: &AuthPrompt, text: &str, selected: usize) -> AuthPromptResponse {
    match prompt {
        AuthPrompt::Text { .. } => AuthPromptResponse::Text(text.to_owned()),
        AuthPrompt::Secret { .. } => {
            AuthPromptResponse::Secret(phenix_runtime_api::SecretValue::from_utf8(text))
        }
        AuthPrompt::ManualCode { .. } => AuthPromptResponse::ManualCode(text.to_owned()),
        AuthPrompt::Select { options, .. } => options
            .get(selected)
            .or_else(|| options.first())
            .map_or(AuthPromptResponse::Cancelled, |option| {
                AuthPromptResponse::Selected(option.id.clone())
            }),
    }
}

fn auth_prompt_message(prompt: &AuthPrompt) -> String {
    match prompt {
        AuthPrompt::Text { message, .. }
        | AuthPrompt::Secret { message, .. }
        | AuthPrompt::Select { message, .. }
        | AuthPrompt::ManualCode { message, .. } => message.clone(),
    }
}

fn edit_input(state: &AppState, edit: impl FnOnce(&mut String)) -> Vec<AppEvent> {
    let mut text = state.input.text.clone();
    edit(&mut text);
    user(UserIntent::InputChanged(text))
}

fn select_relative_run(state: &AppState, delta: isize) -> Vec<AppEvent> {
    let Some(snapshot) = &state.snapshot else {
        return Vec::new();
    };
    if snapshot.runs.is_empty() {
        return Vec::new();
    }
    let current = state
        .input_target()
        .and_then(|selected| snapshot.runs.iter().position(|run| &run.id == selected))
        .unwrap_or(0);
    let next = current
        .saturating_add_signed(delta)
        .min(snapshot.runs.len() - 1);
    user(UserIntent::SelectRun(snapshot.runs[next].id.clone()))
}

fn next_focus(focus: FocusTarget) -> FocusTarget {
    match focus {
        FocusTarget::Sidebar => FocusTarget::Transcript,
        FocusTarget::Transcript => FocusTarget::Input,
        FocusTarget::Input | FocusTarget::Overlay => FocusTarget::Sidebar,
    }
}

fn previous_focus(focus: FocusTarget) -> FocusTarget {
    match focus {
        FocusTarget::Sidebar => FocusTarget::Input,
        FocusTarget::Transcript => FocusTarget::Sidebar,
        FocusTarget::Input | FocusTarget::Overlay => FocusTarget::Transcript,
    }
}

fn user(intent: UserIntent) -> Vec<AppEvent> {
    vec![AppEvent::User(intent)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_runtime_api::{BackendHealth, RunId, RunKind, RunState, RunSummary, RuntimeSnapshot};

    #[test]
    fn sidebar_navigation_selects_runs_without_owning_state_outside_the_loop() {
        let first = RunId::parse("run-1").expect("run ID");
        let second = RunId::parse("run-2").expect("run ID");
        let mut state = AppState::default();
        state.selected_run = Some(first.clone());
        state.snapshot = Some(RuntimeSnapshot {
            capabilities: Default::default(),
            health: BackendHealth::Ready,
            active_session: None,
            root_run: Some(first.clone()),
            selected_run: Some(first.clone()),
            sessions: Vec::new(),
            runs: vec![run(first), run(second.clone())],
            objectives: Vec::new(),
        });
        assert_eq!(
            select_relative_run(&state, 1),
            user(UserIntent::SelectRun(second))
        );
    }

    #[test]
    fn secret_prompt_never_places_plain_text_in_debug_output() {
        let response = auth_response(
            &AuthPrompt::Secret {
                message: "key".to_owned(),
                placeholder: None,
            },
            "secret-value",
            0,
        );
        assert!(!format!("{response:?}").contains("secret-value"));
    }

    fn run(id: RunId) -> RunSummary {
        RunSummary {
            id,
            parent: None,
            kind: RunKind::Root,
            definition_id: "root.session".to_owned(),
            display_name: "Root".to_owned(),
            state: RunState::Running,
            persisted_session: None,
            session_file: None,
            model: None,
            thinking_level: None,
            difficulty: None,
            budget: None,
            pending_messages: 0,
            outcome: None,
        }
    }
}
