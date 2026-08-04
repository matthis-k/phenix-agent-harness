#![forbid(unsafe_code)]

use phenix_frontend_config::{
    ColorSpec, FrontendConfig, FrontendProviderRef, HighlightStyle, LayoutNode, NamedColor,
    SplitDirection, ThemeConfig,
};
use phenix_runtime_api::{AuthPrompt, ExtensionUiRequest, TranscriptRole};
use phenix_ui_core::{AppState, ElementId, FocusTarget, OverlayState};
use phenix_ui_runtime::UiRenderer;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Wrap};
use ratatui::{DefaultTerminal, Frame};
use std::collections::BTreeMap;
use std::io;

pub struct RatatuiRenderer {
    terminal: Option<DefaultTerminal>,
    provider: FrontendProviderRef,
}

impl RatatuiRenderer {
    pub fn initialize(provider: FrontendProviderRef) -> io::Result<Self> {
        Ok(Self {
            terminal: Some(ratatui::try_init()?),
            provider,
        })
    }
}

impl UiRenderer for RatatuiRenderer {
    fn render(&mut self, state: &AppState) -> Result<(), String> {
        let config = self.provider.borrow().config().clone();
        self.terminal
            .as_mut()
            .ok_or_else(|| "terminal is already restored".to_owned())?
            .draw(|frame| render_application(frame, state, &config))
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

fn render_application(frame: &mut Frame<'_>, state: &AppState, config: &FrontendConfig) {
    let area = frame.area();
    frame.render_widget(Block::new().style(theme_style(&config.theme, "Normal")), area);

    let header_height = if state.view.pane(&ElementId::header()).visible {
        state
            .view
            .pane(&ElementId::header())
            .height
            .unwrap_or(1)
            .min(area.height)
    } else {
        0
    };
    let regions = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(header_height), Constraint::Min(0)])
        .split(area);
    if header_height > 0 {
        render_header(frame, regions[0], state, &config.theme);
    }

    let mut panes = BTreeMap::new();
    collect_layout(
        &config.layout.root,
        regions[1],
        state,
        &mut panes,
    );
    for (element, pane_area) in panes {
        render_pane(frame, pane_area, state, &config.theme, &element);
    }
    render_overlay(frame, area, state, &config.theme);
}

fn collect_layout(
    node: &LayoutNode,
    area: Rect,
    state: &AppState,
    output: &mut BTreeMap<ElementId, Rect>,
) {
    match node {
        LayoutNode::Pane(pane) => {
            if state.view.pane(&pane.element).visible && area.width > 0 && area.height > 0 {
                output.insert(pane.element.clone(), area);
            }
        }
        LayoutNode::Split(split) => {
            if split.children.is_empty() {
                return;
            }
            let direction = match split.direction {
                SplitDirection::Horizontal => Direction::Horizontal,
                SplitDirection::Vertical => Direction::Vertical,
            };
            let constraints = split
                .children
                .iter()
                .map(|child| child_constraint(child, split.direction, state))
                .collect::<Vec<_>>();
            let child_areas = Layout::default()
                .direction(direction)
                .constraints(constraints)
                .split(area);
            for (child, child_area) in split.children.iter().zip(child_areas.iter().copied()) {
                collect_layout(child, child_area, state, output);
            }
        }
    }
}

fn child_constraint(
    node: &LayoutNode,
    direction: SplitDirection,
    state: &AppState,
) -> Constraint {
    match node {
        LayoutNode::Pane(pane) => {
            let view = state.view.pane(&pane.element);
            if !view.visible {
                return Constraint::Length(0);
            }
            let explicit = match direction {
                SplitDirection::Horizontal => view.width,
                SplitDirection::Vertical => view.height,
            };
            explicit.map_or_else(
                || Constraint::Fill(pane.weight.max(1)),
                Constraint::Length,
            )
        }
        LayoutNode::Split(split) => Constraint::Fill(layout_weight(&split.children).max(1)),
    }
}

fn layout_weight(nodes: &[LayoutNode]) -> u16 {
    nodes.iter().fold(0u16, |total, node| {
        total.saturating_add(match node {
            LayoutNode::Pane(pane) => pane.weight.max(1),
            LayoutNode::Split(split) => layout_weight(&split.children).max(1),
        })
    })
}

fn render_pane(
    frame: &mut Frame<'_>,
    area: Rect,
    state: &AppState,
    theme: &ThemeConfig,
    element: &ElementId,
) {
    match element.as_str() {
        "ui.transcript" => render_transcript(frame, area, state, theme),
        "ui.sidebar" => render_sidebar(frame, area, state, theme),
        "ui.input" => render_input(frame, area, state, theme),
        "ui.status" => render_status(frame, area, state, theme),
        "ui.header" => render_header(frame, area, state, theme),
        _ => render_unknown_pane(frame, area, theme, element),
    }
}

fn render_header(frame: &mut Frame<'_>, area: Rect, state: &AppState, theme: &ThemeConfig) {
    let session = state
        .active_session
        .as_ref()
        .map_or_else(|| "new session".to_owned(), ToString::to_string);
    let target = state
        .input_target()
        .map_or_else(|| "no run".to_owned(), ToString::to_string);
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(" Phenix ", theme_style(theme, "Accent")),
            Span::styled(format!("  {session}"), theme_style(theme, "Normal")),
            Span::styled(format!("  → {target}"), theme_style(theme, "Muted")),
        ]))
        .style(theme_style(theme, "Surface")),
        area,
    );
}

fn render_transcript(frame: &mut Frame<'_>, area: Rect, state: &AppState, theme: &ThemeConfig) {
    let block = panel(
        "Transcript",
        state.view.focus == FocusTarget::Transcript,
        theme,
    );
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let lines = state
        .input_target()
        .and_then(|run_id| state.transcript(run_id))
        .map_or_else(
            || vec![Line::styled("No transcript yet.", theme_style(theme, "Muted"))],
            |transcript| {
                transcript
                    .blocks
                    .iter()
                    .flat_map(|entry| transcript_lines(&entry.role, &entry.text, theme))
                    .collect()
            },
        );
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((
                state.view.transcript_scroll.offset.min(u16::MAX as usize) as u16,
                0,
            )),
        inner,
    );
}

fn render_sidebar(frame: &mut Frame<'_>, area: Rect, state: &AppState, theme: &ThemeConfig) {
    let block = panel("Runs", state.view.focus == FocusTarget::Sidebar, theme);
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
                            theme_style(theme, "Accent")
                        } else {
                            theme_style(theme, "Normal")
                        },
                    ),
                    Span::styled(details, theme_style(theme, "Muted")),
                ]))
            })
            .collect()
    });
    frame.render_widget(
        if items.is_empty() {
            List::new(vec![ListItem::new(Line::styled(
                "Waiting for runtime snapshot…",
                theme_style(theme, "Muted"),
            ))])
        } else {
            List::new(items)
        },
        inner,
    );
}

fn render_input(frame: &mut Frame<'_>, area: Rect, state: &AppState, theme: &ThemeConfig) {
    let focused = state.view.focus == FocusTarget::Input && state.view.overlay.is_none();
    let block = panel("Input", focused, theme);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    frame.render_widget(
        Paragraph::new(state.input.text.as_str())
            .style(theme_style(theme, "Normal"))
            .wrap(Wrap { trim: false }),
        inner,
    );
    if focused && inner.height > 0 {
        let prefix = &state.input.text[..state.input.cursor_byte.min(state.input.text.len())];
        let (column, row) = cursor_position(prefix, inner.width.max(1));
        frame.set_cursor_position((
            inner.x.saturating_add(column.min(inner.width.saturating_sub(1))),
            inner.y.saturating_add(row.min(inner.height.saturating_sub(1))),
        ));
    }
}

fn render_status(frame: &mut Frame<'_>, area: Rect, state: &AppState, theme: &ThemeConfig) {
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
            .style(theme_style(theme, "Surface"))
            .wrap(Wrap { trim: true }),
        area,
    );
}

fn render_unknown_pane(
    frame: &mut Frame<'_>,
    area: Rect,
    theme: &ThemeConfig,
    element: &ElementId,
) {
    frame.render_widget(
        Paragraph::new(Line::styled(
            format!("No native renderer registered for {element}"),
            theme_style(theme, "Muted"),
        ))
        .block(panel(element.as_str(), false, theme))
        .wrap(Wrap { trim: true }),
        area,
    );
}

fn render_overlay(frame: &mut Frame<'_>, area: Rect, state: &AppState, theme: &ThemeConfig) {
    if let Some(dialog) = state.dialogs.front() {
        render_extension_dialog(
            frame,
            centered(area, 70, 55),
            &dialog.request,
            overlay_selected(state),
            state,
            theme,
        );
        return;
    }
    let Some(overlay) = &state.view.overlay else {
        return;
    };
    let overlay_area = centered(area, 70, 65);
    frame.render_widget(Clear, overlay_area);
    match overlay {
        OverlayState::ModelPicker { selected, .. } => render_picker(
            frame,
            overlay_area,
            "Models",
            *selected,
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
            theme,
        ),
        OverlayState::AuthenticationProviders { selected, .. } => render_picker(
            frame,
            overlay_area,
            "Authentication",
            *selected,
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
            theme,
        ),
        OverlayState::SessionPicker { selected, .. } => render_picker(
            frame,
            overlay_area,
            "Resume session",
            *selected,
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
            theme,
        ),
        OverlayState::AuthenticationPrompt {
            flow_id,
            prompt,
            selected,
            ..
        } => render_auth_prompt(
            frame,
            overlay_area,
            flow_id.as_str(),
            prompt,
            *selected,
            state,
            theme,
        ),
        OverlayState::ExtensionDialog {
            request, selected, ..
        } => render_extension_dialog(
            frame,
            overlay_area,
            request,
            *selected,
            state,
            theme,
        ),
        OverlayState::CommandPalette { selected, .. } => render_picker(
            frame,
            overlay_area,
            "Commands",
            *selected,
            state
                .commands
                .iter()
                .map(|command| format!("/{}", command.name))
                .collect(),
            theme,
        ),
        OverlayState::Help => render_picker(
            frame,
            overlay_area,
            "Help",
            0,
            vec![
                "Frontend keymaps are configured in init.lua".to_owned(),
                "Use `phenix --print-default-config` to inspect defaults".to_owned(),
            ],
            theme,
        ),
    }
}

fn render_picker(
    frame: &mut Frame<'_>,
    area: Rect,
    title: &str,
    selected: usize,
    values: Vec<String>,
    theme: &ThemeConfig,
) {
    let block = panel(title, true, theme);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let items = if values.is_empty() {
        vec![ListItem::new(Line::styled(
            "No entries available.",
            theme_style(theme, "Muted"),
        ))]
    } else {
        values
            .into_iter()
            .enumerate()
            .map(|(index, value)| {
                ListItem::new(format!("{} {value}", if index == selected { "▸" } else { " " }))
                    .style(if index == selected {
                        theme_style(theme, "Accent")
                    } else {
                        theme_style(theme, "Normal")
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
    selected: usize,
    state: &AppState,
    theme: &ThemeConfig,
) {
    let title = format!("Authentication · {flow_id}");
    let block = panel(&title, true, theme);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let mut lines = vec![Line::styled(
        auth_prompt_message(prompt),
        theme_style(theme, "Normal"),
    )];
    match prompt {
        AuthPrompt::Select { options, .. } => lines.extend(options.iter().enumerate().map(
            |(index, option)| {
                Line::styled(
                    format!("{} {}", if index == selected { "▸" } else { " " }, option.label),
                    if index == selected {
                        theme_style(theme, "Accent")
                    } else {
                        theme_style(theme, "Normal")
                    },
                )
            },
        )),
        AuthPrompt::Secret { .. } => lines.push(Line::styled(
            "•".repeat(state.input.text.chars().count()),
            theme_style(theme, "Accent"),
        )),
        AuthPrompt::Text { .. } | AuthPrompt::ManualCode { .. } => lines.push(Line::styled(
            state.input.text.clone(),
            theme_style(theme, "Accent"),
        )),
    }
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn render_extension_dialog(
    frame: &mut Frame<'_>,
    area: Rect,
    request: &ExtensionUiRequest,
    selected: usize,
    state: &AppState,
    theme: &ThemeConfig,
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
                        format!("{} {option}", if index == selected { "▸" } else { " " }),
                        if index == selected {
                            theme_style(theme, "Accent")
                        } else {
                            theme_style(theme, "Normal")
                        },
                    )
                })
                .collect::<Vec<_>>(),
        ),
        ExtensionUiRequest::Confirm { title, message } => (
            title.as_str(),
            vec![Line::styled(message.clone(), theme_style(theme, "Normal"))],
        ),
        ExtensionUiRequest::Input { title, secret, .. } => (
            title.as_str(),
            vec![Line::styled(
                if *secret {
                    "•".repeat(state.input.text.chars().count())
                } else {
                    state.input.text.clone()
                },
                theme_style(theme, "Accent"),
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
                theme_style(theme, "Normal"),
            )],
        ),
    };
    lines.push(Line::styled(
        "Use configured overlay keymaps to submit or cancel",
        theme_style(theme, "Muted"),
    ));
    let block = panel(title, true, theme);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn panel<'a>(title: &'a str, focused: bool, theme: &ThemeConfig) -> Block<'a> {
    Block::default()
        .borders(Borders::ALL)
        .title(Span::styled(
            format!(" {title} "),
            theme_style(theme, if focused { "Accent" } else { "Muted" }),
        ))
        .border_style(theme_style(
            theme,
            if focused { "BorderFocused" } else { "Border" },
        ))
        .style(theme_style(theme, "Normal"))
}

fn theme_style(theme: &ThemeConfig, group: &str) -> Style {
    let HighlightStyle {
        foreground,
        background,
        bold,
        italic,
        underline,
        reversed,
    } = theme.style(group);
    let mut style = Style::default();
    if let Some(foreground) = foreground {
        style = style.fg(ratatui_color(foreground));
    }
    if let Some(background) = background {
        style = style.bg(ratatui_color(background));
    }
    let mut modifiers = Modifier::empty();
    if bold {
        modifiers |= Modifier::BOLD;
    }
    if italic {
        modifiers |= Modifier::ITALIC;
    }
    if underline {
        modifiers |= Modifier::UNDERLINED;
    }
    if reversed {
        modifiers |= Modifier::REVERSED;
    }
    style.add_modifier(modifiers)
}

fn ratatui_color(color: ColorSpec) -> Color {
    match color {
        ColorSpec::Default => Color::Reset,
        ColorSpec::Rgb { red, green, blue } => Color::Rgb(red, green, blue),
        ColorSpec::Indexed(index) => Color::Indexed(index),
        ColorSpec::Named(named) => match named {
            NamedColor::Black => Color::Black,
            NamedColor::Red => Color::Red,
            NamedColor::Green => Color::Green,
            NamedColor::Yellow => Color::Yellow,
            NamedColor::Blue => Color::Blue,
            NamedColor::Magenta => Color::Magenta,
            NamedColor::Cyan => Color::Cyan,
            NamedColor::White => Color::White,
            NamedColor::Gray => Color::Gray,
            NamedColor::DarkGray => Color::DarkGray,
        },
    }
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
    (
        column.min(u16::MAX as usize) as u16,
        row.min(u16::MAX as usize) as u16,
    )
}

fn transcript_lines(role: &TranscriptRole, text: &str, theme: &ThemeConfig) -> Vec<Line<'static>> {
    let (label, group) = match role {
        TranscriptRole::User => ("you", "Accent"),
        TranscriptRole::Assistant => ("assistant", "Success"),
        TranscriptRole::Thinking => ("thinking", "Thinking"),
        TranscriptRole::Tool => ("tool", "Tool"),
        TranscriptRole::System => ("system", "Error"),
    };
    let mut lines = vec![Line::styled(
        format!("{label} ─"),
        theme_style(theme, group).add_modifier(Modifier::BOLD),
    )];
    lines.extend(text.lines().map(|line| Line::from(line.to_owned())));
    lines.push(Line::default());
    lines
}

fn auth_prompt_message(prompt: &AuthPrompt) -> String {
    match prompt {
        AuthPrompt::Text { message, .. }
        | AuthPrompt::Secret { message, .. }
        | AuthPrompt::Select { message, .. }
        | AuthPrompt::ManualCode { message, .. } => message.clone(),
    }
}

fn overlay_selected(state: &AppState) -> usize {
    match &state.view.overlay {
        Some(OverlayState::CommandPalette { selected, .. })
        | Some(OverlayState::ModelPicker { selected, .. })
        | Some(OverlayState::AuthenticationProviders { selected, .. })
        | Some(OverlayState::AuthenticationPrompt { selected, .. })
        | Some(OverlayState::SessionPicker { selected, .. })
        | Some(OverlayState::ExtensionDialog { selected, .. }) => *selected,
        Some(OverlayState::Help) | None => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_frontend_config::{LayoutConfig, PaneLayout, PaneType, SplitLayout};

    #[test]
    fn provider_layout_is_mapped_without_widget_state() {
        let state = AppState::default();
        let mut output = BTreeMap::new();
        collect_layout(
            &LayoutConfig {
                root: LayoutNode::Split(SplitLayout {
                    direction: SplitDirection::Horizontal,
                    children: vec![
                        LayoutNode::Pane(PaneLayout {
                            element: ElementId::transcript(),
                            pane_type: PaneType::Transcript,
                            weight: 3,
                            minimum: None,
                            maximum: None,
                        }),
                        LayoutNode::Pane(PaneLayout {
                            element: ElementId::sidebar(),
                            pane_type: PaneType::Sidebar,
                            weight: 1,
                            minimum: None,
                            maximum: None,
                        }),
                    ],
                }),
            }
            .root,
            Rect::new(0, 0, 100, 20),
            &state,
            &mut output,
        );
        assert!(output.contains_key(&ElementId::transcript()));
        assert_eq!(output[&ElementId::sidebar()].width, 28);
    }

    #[test]
    fn semantic_theme_groups_map_to_ratatui_styles() {
        let style = theme_style(&ThemeConfig::default(), "Accent");
        assert!(style.add_modifier.contains(Modifier::BOLD));
    }
}
