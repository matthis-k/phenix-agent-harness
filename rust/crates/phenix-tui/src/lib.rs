#![forbid(unsafe_code)]

use phenix_runtime_api::{
    AuthMethod, AuthPrompt, AuthPromptResponse, ExtensionUiRequest, ExtensionUiResponse,
    ThinkingLevel, TranscriptRole,
};
use phenix_ui_core::{
    AppEvent, AppState, FocusTarget, KeyCode, KeyInput, OverlayState, UiInput, UserIntent,
};
use phenix_ui_runtime::{UiInputController, UiRenderer};
use ratatui::layout::{Constraint, Direction, Layout, Margin, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
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
        let terminal = self
            .terminal
            .as_mut()
            .ok_or_else(|| "terminal is already restored".to_owned())?;
        terminal
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
            UiInput::Paste(text) => {
                let mut input = state.input.text.clone();
                input.push_str(&text);
                vec![user(UserIntent::InputChanged(input))]
            }
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
                KeyCode::Character('d') | KeyCode::Character('q') => {
                    vec![user(UserIntent::Quit)]
                }
                KeyCode::Character('c') => vec![user(UserIntent::Abort)],
                KeyCode::Character('l') => vec![user(UserIntent::OpenAuthentication)],
                KeyCode::Character('m') => vec![user(UserIntent::OpenModelPicker)],
                KeyCode::Character('r') => vec![user(UserIntent::OpenSessionPicker)],
                KeyCode::Character('o') => vec![user(UserIntent::ToggleDetails)],
                KeyCode::Enter => vec![user(UserIntent::SteerPrompt)],
                _ => Vec::new(),
            };
        }
        if key.modifiers.alt && key.code == KeyCode::Enter {
            return vec![user(UserIntent::FollowUpPrompt)];
        }

        match key.code {
            KeyCode::Escape => self.escape(state),
            KeyCode::Enter => self.enter(state, key.modifiers.shift),
            KeyCode::Tab => vec![user(UserIntent::SetFocus(next_focus(state.view.focus)))],
            KeyCode::BackTab => vec![user(UserIntent::SetFocus(previous_focus(
                state.view.focus,
            )))],
            KeyCode::Backspace => {
                let mut text = state.input.text.clone();
                text.pop();
                vec![user(UserIntent::InputChanged(text))]
            }
            KeyCode::Delete => Vec::new(),
            KeyCode::Character(character) if !key.modifiers.alt => {
                let mut text = state.input.text.clone();
                text.push(character);
                self.history_offset = None;
                vec![user(UserIntent::InputChanged(text))]
            }
            KeyCode::Up => self.up(state),
            KeyCode::Down => self.down(state),
            KeyCode::Left if state.view.focus == FocusTarget::Input => Vec::new(),
            KeyCode::Right if state.view.focus == FocusTarget::Input => Vec::new(),
            KeyCode::PageUp => {
                select_relative_run(state, -5).map_or_else(Vec::new, |intent| vec![user(intent)])
            }
            KeyCode::PageDown => {
                select_relative_run(state, 5).map_or_else(Vec::new, |intent| vec![user(intent)])
            }
            _ => Vec::new(),
        }
    }

    fn escape(&mut self, state: &AppState) -> Vec<AppEvent> {
        if let Some(OverlayState::AuthenticationPrompt { flow_id, .. }) = &state.view.overlay {
            return vec![user(UserIntent::CancelAuthentication(flow_id.clone()))];
        }
        if state.view.overlay.is_some() {
            return vec![user(UserIntent::CloseOverlay)];
        }
        if !state.dialogs.is_empty() {
            return vec![user(UserIntent::RespondToDialog(
                ExtensionUiResponse::Cancelled,
            ))];
        }
        vec![user(UserIntent::Abort)]
    }

    fn enter(&mut self, state: &AppState, shift: bool) -> Vec<AppEvent> {
        if shift {
            let mut text = state.input.text.clone();
            text.push('\n');
            return vec![user(UserIntent::InputChanged(text))];
        }
        if !state.dialogs.is_empty() {
            return respond_to_dialog(state);
        }
        match &state.view.overlay {
            Some(OverlayState::ModelPicker { .. }) => state.models.first().map_or_else(Vec::new, |model| {
                vec![user(UserIntent::SelectModel(model.model.clone()))]
            }),
            Some(OverlayState::AuthenticationProviders { .. }) => state
                .auth_providers
                .first()
                .and_then(|provider| {
                    provider.methods.first().map(|method| UserIntent::StartAuthentication {
                        provider_id: provider.id.clone(),
                        method: method.clone(),
                    })
                })
                .map_or_else(Vec::new, |intent| vec![user(intent)]),
            Some(OverlayState::AuthenticationPrompt {
                flow_id,
                prompt,
                selected,
                ..
            }) => {
                let response = auth_response(prompt, &state.input.text, *selected);
                vec![
                    user(UserIntent::InputChanged(String::new())),
                    user(UserIntent::RespondToAuthentication {
                        flow_id: flow_id.clone(),
                        response,
                    }),
                ]
            }
            Some(OverlayState::SessionPicker { .. }) => state
                .snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.sessions.first())
                .map_or_else(Vec::new, |session| {
                    vec![user(UserIntent::SwitchSession(session.id.clone()))]
                }),
            Some(OverlayState::CommandPalette { .. })
            | Some(OverlayState::ExtensionDialog { .. })
            | Some(OverlayState::Help) => Vec::new(),
            None => vec![user(UserIntent::SubmitPrompt)],
        }
    }

    fn up(&mut self, state: &AppState) -> Vec<AppEvent> {
        if state.view.focus == FocusTarget::Sidebar {
            return select_relative_run(state, -1).map_or_else(Vec::new, |intent| vec![user(intent)]);
        }
        if state.view.overlay.is_some() || !state.dialogs.is_empty() {
            return Vec::new();
        }
        let history = &state.input.history;
        if history.is_empty() {
            return Vec::new();
        }
        let next = self
            .history_offset
            .map_or(0, |offset| (offset + 1).min(history.len() - 1));
        self.history_offset = Some(next);
        let index = history.len() - 1 - next;
        vec![user(UserIntent::InputChanged(history[index].clone()))]
    }

    fn down(&mut self, state: &AppState) -> Vec<AppEvent> {
        if state.view.focus == FocusTarget::Sidebar {
            return select_relative_run(state, 1).map_or_else(Vec::new, |intent| vec![user(intent)]);
        }
        let Some(offset) = self.history_offset else {
            return Vec::new();
        };
        if offset == 0 {
            self.history_offset = None;
            return vec![user(UserIntent::InputChanged(String::new()))];
        }
        let next = offset - 1;
        self.history_offset = Some(next);
        let index = state.input.history.len() - 1 - next;
        vec![user(UserIntent::InputChanged(
            state.input.history[index].clone(),
        ))]
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
    let target = state
        .input_target()
        .map_or_else(|| "no run".to_owned(), ToString::to_string);
    let session = state
        .active_session
        .as_ref()
        .map_or_else(|| "new session".to_owned(), ToString::to_string);
    let line = Line::from(vec![
        Span::styled(" Phenix ", Style::default().fg(SURFACE).bg(ACCENT).bold()),
        Span::styled(format!("  {session}"), Style::default().fg(TEXT)),
        Span::styled(format!("  → {target}"), Style::default().fg(SUBTEXT)),
    ]);
    frame.render_widget(Paragraph::new(line).style(Style::default().bg(SURFACE_ALT)), area);
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
    let focused = state.view.focus == FocusTarget::Transcript;
    let block = panel("Transcript", focused);
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
                    .flat_map(|entry| transcript_lines(entry.role.clone(), &entry.text))
                    .collect()
            },
        );
    frame.render_widget(
        Paragraph::new(Text::from(lines))
            .wrap(Wrap { trim: false })
            .scroll((state.view.transcript_scroll.offset.min(u16::MAX as usize) as u16, 0)),
        inner,
    );
}

fn render_sidebar(frame: &mut Frame<'_>, area: Rect, state: &AppState) {
    let focused = state.view.focus == FocusTarget::Sidebar;
    let block = panel("Runs · Objectives · Sessions", focused);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let items = state.snapshot.as_ref().map_or_else(Vec::new, |snapshot| {
        snapshot
            .runs
            .iter()
            .map(|run| {
                let selected = state.input_target() == Some(&run.id);
                let marker = if selected { "▸" } else { " " };
                let style = if selected {
                    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(TEXT)
                };
                let details = if state.view.show_details {
                    format!("  {:?}  {}", run.state, run.definition_id)
                } else {
                    format!("  {:?}", run.state)
                };
                ListItem::new(Line::from(vec![
                    Span::styled(format!("{marker} {}", run.display_name), style),
                    Span::styled(details, Style::default().fg(SUBTEXT)),
                ]))
            })
            .collect()
    });
    let list = if items.is_empty() {
        List::new(vec![ListItem::new(Line::styled(
            "Waiting for runtime snapshot…",
            Style::default().fg(SUBTEXT),
        ))])
    } else {
        List::new(items)
    };
    frame.render_widget(list, inner);
}

fn render_input(frame: &mut Frame<'_>, area: Rect, state: &AppState) {
    let focused = state.view.focus == FocusTarget::Input && state.view.overlay.is_none();
    let title = state
        .input_target()
        .map_or_else(|| "Input".to_owned(), |run| format!("Input → {run}"));
    let block = panel(&title, focused);
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
    let health = format!("{:?}", state.connection);
    let status = state
        .statuses
        .iter()
        .map(|(key, value)| format!("{key}: {value}"))
        .collect::<Vec<_>>()
        .join(" · ");
    let notification = state.notifications.back().cloned().unwrap_or_default();
    let text = [health, status, notification]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("  ·  ");
    frame.render_widget(
        Paragraph::new(Line::styled(text, Style::default().fg(SUBTEXT)))
            .style(Style::default().bg(SURFACE_ALT)),
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
        OverlayState::ModelPicker { .. } => {
            let items = state.models.iter().map(|model| {
                ListItem::new(format!(
                    "{}/{}  {}",
                    model.model.provider, model.model.model, model.display_name
                ))
            });
            render_picker(frame, overlay_area, "Models", items.collect());
        }
        OverlayState::AuthenticationProviders { .. } => {
            let items = state.auth_providers.iter().map(|provider| {
                let configured = if provider.configured { "configured" } else { "login" };
                ListItem::new(format!("{}  ({configured})", provider.display_name))
            });
            render_picker(frame, overlay_area, "Authentication", items.collect());
        }
        OverlayState::SessionPicker { .. } => {
            let items = state
                .snapshot
                .as_ref()
                .into_iter()
                .flat_map(|snapshot| snapshot.sessions.iter())
                .map(|session| {
                    ListItem::new(
                        session
                            .name
                            .clone()
                            .unwrap_or_else(|| session.id.to_string()),
                    )
                });
            render_picker(frame, overlay_area, "Resume session", items.collect());
        }
        OverlayState::AuthenticationPrompt {
            flow_id, prompt, ..
        } => render_auth_prompt(frame, overlay_area, flow_id.as_str(), prompt, state),
        OverlayState::ExtensionDialog { request, .. } => {
            render_extension_dialog(frame, overlay_area, request, state)
        }
        OverlayState::CommandPalette { .. } => {
            let items = state
                .commands
                .iter()
                .map(|command| ListItem::new(format!("/{}", command.name)))
                .collect();
            render_picker(frame, overlay_area, "Commands", items);
        }
        OverlayState::Help => render_help(frame, overlay_area),
    }
}

fn render_picker(frame: &mut Frame<'_>, area: Rect, title: &str, items: Vec<ListItem<'_>>) {
    let block = panel(title, true);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if items.is_empty() {
        frame.render_widget(
            Paragraph::new("No entries available.").style(Style::default().fg(SUBTEXT)),
            inner,
        );
        return;
    }
    let mut lines = Vec::with_capacity(items.len());
    for (index, item) in items.into_iter().enumerate() {
        let style = if index == 0 {
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(TEXT)
        };
        lines.push(item.style(style));
    }
    frame.render_widget(List::new(lines).highlight_symbol("▸ "), inner);
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
    let mut lines = Vec::new();
    if let Some(flow) = state
        .auth_flows
        .iter()
        .find_map(|(id, flow)| (id.as_str() == flow_id).then_some(flow))
    {
        for notice in &flow.notices {
            lines.push(Line::styled(format!("{notice:?}"), Style::default().fg(YELLOW)));
        }
    }
    lines.push(Line::styled(auth_prompt_message(prompt), Style::default().fg(TEXT)));
    match prompt {
        AuthPrompt::Select { options, .. } => {
            for (index, option) in options.iter().enumerate() {
                let marker = if index == 0 { "▸" } else { " " };
                lines.push(Line::styled(
                    format!("{marker} {}", option.label),
                    if index == 0 {
                        Style::default().fg(ACCENT)
                    } else {
                        Style::default().fg(TEXT)
                    },
                ));
            }
        }
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
            vec![
                Line::styled(message.clone(), Style::default().fg(TEXT)),
                Line::styled("Enter: confirm · Esc: cancel", Style::default().fg(SUBTEXT)),
            ],
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
    lines.push(Line::styled("", Style::default()));
    lines.push(Line::styled("Enter: submit · Esc: cancel", Style::default().fg(SUBTEXT)));
    let block = panel(title, true);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn render_help(frame: &mut Frame<'_>, area: Rect) {
    let block = panel("Help", true);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    frame.render_widget(
        Paragraph::new(vec![
            Line::from("Ctrl+L login · Ctrl+M models · Ctrl+R sessions"),
            Line::from("Ctrl+Enter steer · Alt+Enter follow-up · Esc abort"),
            Line::from("Tab focus · Ctrl+O details · Ctrl+D exit"),
        ])
        .style(Style::default().fg(TEXT)),
        inner,
    );
}

fn panel<'a>(title: &'a str, focused: bool) -> Block<'a> {
    let border = if focused { ACCENT } else { SURFACE_ALT };
    Block::default()
        .borders(Borders::ALL)
        .title(Span::styled(
            format!(" {title} "),
            Style::default().fg(if focused { ACCENT } else { SUBTEXT }),
        ))
        .border_style(Style::default().fg(border))
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
        .inner(Margin::new(1, 1))
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
            continue;
        }
        column += 1;
        if column >= width {
            row += 1;
            column = 0;
        }
    }
    (column.min(u16::MAX as usize) as u16, row.min(u16::MAX as usize) as u16)
}

fn transcript_lines(role: TranscriptRole, text: &str) -> Vec<Line<'static>> {
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
    lines.extend(text.lines().map(|line| {
        Line::from(Span::styled(line.to_owned(), Style::default().fg(TEXT)))
    }));
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
        user(UserIntent::InputChanged(String::new())),
        user(UserIntent::RespondToDialog(response)),
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

fn select_relative_run(state: &AppState, delta: isize) -> Option<UserIntent> {
    let runs = &state.snapshot.as_ref()?.runs;
    if runs.is_empty() {
        return None;
    }
    let current = state
        .input_target()
        .and_then(|selected| runs.iter().position(|run| &run.id == selected))
        .unwrap_or(0);
    let next = current.saturating_add_signed(delta).min(runs.len() - 1);
    Some(UserIntent::SelectRun(runs[next].id.clone()))
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

fn user(intent: UserIntent) -> AppEvent {
    AppEvent::User(intent)
}

pub fn default_thinking_level() -> ThinkingLevel {
    ThinkingLevel::Medium
}

pub fn preferred_auth_method(methods: &[AuthMethod]) -> Option<AuthMethod> {
    methods
        .iter()
        .find(|method| **method == AuthMethod::OAuth)
        .cloned()
        .or_else(|| methods.first().cloned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_runtime_api::{RunId, RunKind, RunState, RunSummary, RuntimeSnapshot};

    #[test]
    fn sidebar_navigation_selects_runs_without owning_state_outside_the_loop() {
        let first = RunId::parse("run-1").expect("run ID");
        let second = RunId::parse("run-2").expect("run ID");
        let mut state = AppState::default();
        state.selected_run = Some(first.clone());
        state.snapshot = Some(RuntimeSnapshot {
            capabilities: Default::default(),
            health: phenix_runtime_api::BackendHealth::Ready,
            active_session: None,
            root_run: Some(first.clone()),
            selected_run: Some(first.clone()),
            sessions: Vec::new(),
            runs: vec![run(first), run(second.clone())],
            objectives: Vec::new(),
        });
        assert_eq!(select_relative_run(&state, 1), Some(UserIntent::SelectRun(second)));
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
