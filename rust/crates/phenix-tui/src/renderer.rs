use crate::layout::collect_layout;
use crate::rich_document::RichMedia;
use crate::terminal_media::{TerminalImagePlacement, TerminalMediaRenderer};
use crate::theme::{panel, surface_style, theme_style};
use crate::transcript::{transcript_document, TranscriptDocument};
use phenix_frontend_config::{FrontendConfig, FrontendProviderRef, ThemeConfig};
use phenix_runtime_api::{AuthPrompt, ExtensionUiRequest, ObjectiveState, RunState, RunSummary};
use phenix_ui_core::{
    command_completions, AppState, ElementId, FocusTarget, InputEditor, OverlayState,
};
use phenix_ui_runtime::UiRenderer;
use ratatui::crossterm::{
    event::{DisableMouseCapture, EnableMouseCapture},
    execute,
};
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Margin, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Wrap};
use ratatui::{DefaultTerminal, Frame};
use std::collections::BTreeMap;
use std::io;

pub struct RatatuiRenderer {
    terminal: Option<DefaultTerminal>,
    provider: FrontendProviderRef,
    media: TerminalMediaRenderer,
    hit_regions: BTreeMap<ElementId, Rect>,
    modal_open: bool,
}

impl RatatuiRenderer {
    pub fn initialize(provider: FrontendProviderRef) -> io::Result<Self> {
        Ok(Self {
            terminal: Some(initialize_terminal()?),
            provider,
            media: TerminalMediaRenderer::default(),
            hit_regions: BTreeMap::new(),
            modal_open: false,
        })
    }
}

impl UiRenderer for RatatuiRenderer {
    fn render(&mut self, state: &AppState) -> Result<(), String> {
        let config = self.provider.borrow().config().clone();
        let mut screen = Rect::default();
        self.terminal
            .as_mut()
            .ok_or_else(|| "terminal is already restored".to_owned())?
            .draw(|frame| {
                screen = frame.area();
                render_application(frame, state, &config);
            })
            .map_err(|error| error.to_string())?;

        self.hit_regions = application_hit_regions(screen, state, &config);
        self.modal_open = pointer_modal_open(state);
        let images = terminal_image_placements(screen, state, &config);
        self.media
            .render(&images)
            .map_err(|error| error.to_string())
    }

    fn hit_test(&self, column: u16, row: u16) -> Option<ElementId> {
        if self.modal_open {
            return Some(ElementId::overlay());
        }
        hit_test_regions(&self.hit_regions, column, row)
    }

    fn suspend(&mut self) -> Result<(), String> {
        self.media.clear().map_err(|error| error.to_string())?;
        self.hit_regions.clear();
        self.modal_open = false;
        self.terminal.take();
        restore_terminal();
        Ok(())
    }

    fn resume(&mut self) -> Result<(), String> {
        self.terminal = Some(initialize_terminal().map_err(|error| error.to_string())?);
        Ok(())
    }
}

impl Drop for RatatuiRenderer {
    fn drop(&mut self) {
        let _ = self.media.clear();
        self.terminal.take();
        restore_terminal();
    }
}

fn initialize_terminal() -> io::Result<DefaultTerminal> {
    let terminal = ratatui::try_init()?;
    let mut stdout = io::stdout();
    if let Err(error) = execute!(stdout, EnableMouseCapture) {
        ratatui::restore();
        return Err(error);
    }
    Ok(terminal)
}

fn restore_terminal() {
    let mut stdout = io::stdout();
    let _ = execute!(stdout, DisableMouseCapture);
    ratatui::restore();
}

fn application_hit_regions(
    screen: Rect,
    state: &AppState,
    config: &FrontendConfig,
) -> BTreeMap<ElementId, Rect> {
    let mut panes = BTreeMap::new();
    collect_layout(&config.layout.root, screen, state, &mut panes);
    panes
}

fn pointer_modal_open(state: &AppState) -> bool {
    !state.dialogs.is_empty()
        || state
            .view
            .overlay
            .as_ref()
            .is_some_and(|overlay| !matches!(overlay, OverlayState::CommandPalette { .. }))
}

fn hit_test_regions(
    regions: &BTreeMap<ElementId, Rect>,
    column: u16,
    row: u16,
) -> Option<ElementId> {
    regions.iter().find_map(|(element, area)| {
        let inside = column >= area.x
            && column < area.x.saturating_add(area.width)
            && row >= area.y
            && row < area.y.saturating_add(area.height);
        inside.then(|| element.clone())
    })
}

fn render_application(frame: &mut Frame<'_>, state: &AppState, config: &FrontendConfig) {
    let area = frame.area();
    frame.render_widget(
        Block::new().style(surface_style(&config.theme, "Normal")),
        area,
    );

    let mut panes = BTreeMap::new();
    collect_layout(&config.layout.root, area, state, &mut panes);
    let input_area = panes.get(&ElementId::input()).copied();
    for (element, pane_area) in panes {
        render_pane(frame, pane_area, state, &config.theme, &element);
    }

    let completion_open = matches!(
        state.view.overlay,
        Some(OverlayState::CommandPalette { .. })
    );
    if (state.view.overlay.is_none() || completion_open) && state.dialogs.is_empty() {
        if let Some(input_area) = input_area {
            render_command_completion(frame, area, input_area, state, &config.theme);
        }
    }
    render_overlay(frame, area, state, &config.theme);
}

fn render_pane(
    frame: &mut Frame<'_>,
    area: Rect,
    state: &AppState,
    theme: &ThemeConfig,
    element: &ElementId,
) {
    match element.as_str() {
        "ui.header" => render_header(frame, area, state, theme),
        "ui.inspector" => render_inspector(frame, area, state, theme),
        "ui.transcript" => render_transcript(frame, area, state, theme),
        "ui.sidebar" => render_sidebar(frame, area, state, theme),
        "ui.specialized" => render_specialized(frame, area, state, theme),
        "ui.input" => render_input(frame, area, state, theme),
        "ui.status" => render_status(frame, area, state, theme),
        _ => render_unknown_pane(frame, area, theme, element),
    }
}

fn workspace_pane(focused: bool, theme: &ThemeConfig) -> Block<'static> {
    Block::new()
        .borders(Borders::TOP)
        .border_style(theme_style(
            theme,
            if focused { "BorderFocused" } else { "Border" },
        ))
        .style(surface_style(theme, "Surface"))
        .padding(ratatui::widgets::Padding::horizontal(1))
}

fn flat_surface(theme: &ThemeConfig) -> Block<'static> {
    Block::new()
        .style(surface_style(theme, "Surface"))
        .padding(ratatui::widgets::Padding::horizontal(1))
}

fn common_field_area(area: Rect) -> Rect {
    area.inner(Margin {
        horizontal: 1,
        vertical: 0,
    })
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
            Span::styled("Phenix", theme_style(theme, "Accent")),
            Span::styled(format!("  {session}"), theme_style(theme, "Normal")),
            Span::styled(format!("  → {target}"), theme_style(theme, "Muted")),
        ]))
        .style(surface_style(theme, "Normal")),
        common_field_area(area),
    );
}

fn render_transcript(frame: &mut Frame<'_>, area: Rect, state: &AppState, theme: &ThemeConfig) {
    let block = workspace_pane(state.view.focus == FocusTarget::Transcript, theme);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let document = transcript_document(state, theme, inner.width);
    let viewport_height = usize::from(inner.height.max(1));
    let scroll = transcript_scroll(&document, state, viewport_height);
    let mut lines = document.lines;
    if lines.is_empty() {
        lines.push(Line::styled(
            "No transcript yet.",
            theme_style(theme, "Muted"),
        ));
    }

    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((scroll.min(usize::from(u16::MAX)) as u16, 0)),
        inner,
    );
}

fn transcript_scroll(
    document: &TranscriptDocument,
    state: &AppState,
    viewport_height: usize,
) -> usize {
    let max_scroll = document.lines.len().saturating_sub(viewport_height);
    if !state.view.transcript_reveal_selection {
        return max_scroll.saturating_sub(state.view.transcript_scroll.offset);
    }
    if let Some(selected) = state.view.transcript_selected_fold {
        if let Some(line) = document.fold_lines.get(selected) {
            return line
                .saturating_sub(viewport_height.saturating_div(2))
                .min(max_scroll);
        }
    }
    state
        .view
        .transcript_selected_turn
        .and_then(|selected| {
            if document.turn_ranges.is_empty() {
                return None;
            }
            let selected = selected.min(document.turn_ranges.len() - 1);
            let range = &document.turn_ranges[selected];
            Some(range.end.saturating_sub(viewport_height).min(max_scroll))
        })
        .unwrap_or_else(|| max_scroll.saturating_sub(state.view.transcript_scroll.offset))
}

fn terminal_image_placements(
    screen: Rect,
    state: &AppState,
    config: &FrontendConfig,
) -> Vec<TerminalImagePlacement> {
    if state.view.overlay.is_some() || !state.dialogs.is_empty() {
        return Vec::new();
    }
    let mut panes = BTreeMap::new();
    collect_layout(&config.layout.root, screen, state, &mut panes);
    let Some(area) = panes.get(&ElementId::transcript()).copied() else {
        return Vec::new();
    };
    let inner =
        workspace_pane(state.view.focus == FocusTarget::Transcript, &config.theme).inner(area);
    if inner.width == 0 || inner.height == 0 {
        return Vec::new();
    }
    let document = transcript_document(state, &config.theme, inner.width);
    let viewport_height = usize::from(inner.height);
    let scroll = transcript_scroll(&document, state, viewport_height);
    let viewport_end = scroll.saturating_add(viewport_height);

    document
        .media
        .into_iter()
        .filter_map(|anchor| match anchor.media {
            RichMedia::Image {
                source,
                rows,
                alt: _,
            } => {
                let start = anchor.line;
                let end = start.saturating_add(usize::from(rows));
                if start < scroll || end > viewport_end {
                    return None;
                }
                let y = inner
                    .y
                    .saturating_add(u16::try_from(start - scroll).unwrap_or(u16::MAX));
                Some(TerminalImagePlacement {
                    x: inner.x,
                    y,
                    columns: inner.width,
                    rows,
                    source,
                })
            }
        })
        .collect()
}

fn render_sidebar(frame: &mut Frame<'_>, area: Rect, state: &AppState, theme: &ThemeConfig) {
    let sections = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(1),
            Constraint::Fill(2),
            Constraint::Length(1),
            Constraint::Fill(1),
        ])
        .split(area);

    render_session_section(frame, sections[0], state, theme);
    render_runs_section(frame, sections[2], state, theme);
    render_objectives_section(frame, sections[4], state, theme);
}

fn render_session_section(
    frame: &mut Frame<'_>,
    area: Rect,
    state: &AppState,
    theme: &ThemeConfig,
) {
    frame.render_widget(flat_surface(theme), area);
    frame.render_widget(
        Paragraph::new(vec![
            section_heading("Session tree", theme),
            Line::styled(
                state
                    .active_session
                    .as_ref()
                    .map_or_else(|| "—".to_owned(), ToString::to_string),
                theme_style(theme, "Normal"),
            ),
        ]),
        common_field_area(area),
    );
}

fn render_runs_section(frame: &mut Frame<'_>, area: Rect, state: &AppState, theme: &ThemeConfig) {
    frame.render_widget(flat_surface(theme), area);
    let mut lines = vec![section_heading("Runs", theme)];
    let visible = state.visible_runs();
    if visible.is_empty() {
        lines.push(Line::styled("none", theme_style(theme, "Muted")));
    } else {
        for (index, entry) in visible.iter().enumerate() {
            let Some(run) = state.run(&entry.id) else {
                continue;
            };
            let cursor =
                state.view.focus == FocusTarget::Sidebar && index == state.view.sidebar_index;
            let active = state.input_target() == Some(&run.id);
            let indent = "  ".repeat(entry.depth.min(8));
            let fold = if entry.has_children {
                if state.view.run_is_collapsed(&run.id) {
                    "▸ "
                } else {
                    "▾ "
                }
            } else {
                "  "
            };
            lines.push(Line::from(vec![
                Span::styled(
                    if cursor { "▸ " } else { "  " },
                    if cursor {
                        theme_style(theme, "Accent")
                    } else {
                        theme_style(theme, "Muted")
                    },
                ),
                Span::styled(indent, theme_style(theme, "Muted")),
                Span::styled(fold, theme_style(theme, "Muted")),
                Span::styled(
                    run.display_name.clone(),
                    if active || cursor {
                        theme_style(theme, "Accent")
                    } else {
                        theme_style(theme, "Normal")
                    },
                ),
                Span::styled(
                    if active { "  ●" } else { "" },
                    theme_style(theme, "Success"),
                ),
                Span::styled(format!(" · {:?}", run.state), theme_style(theme, "Muted")),
            ]));
        }
    }

    let scroll = state.view.sidebar_scroll.offset.min(usize::from(u16::MAX)) as u16;
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((scroll, 0)),
        common_field_area(area),
    );
}

fn render_objectives_section(
    frame: &mut Frame<'_>,
    area: Rect,
    state: &AppState,
    theme: &ThemeConfig,
) {
    frame.render_widget(flat_surface(theme), area);
    let mut lines = vec![section_heading("Objectives", theme)];
    match &state.snapshot {
        Some(snapshot) if !snapshot.objectives.is_empty() => {
            lines.extend(snapshot.objectives.iter().map(|objective| {
                Line::from(vec![
                    Span::styled(
                        format!("  {} ", objective_marker(&objective.state)),
                        objective_style(&objective.state, theme),
                    ),
                    Span::styled(objective.title.clone(), theme_style(theme, "Normal")),
                ])
            }));
        }
        _ => lines.push(Line::styled("none", theme_style(theme, "Muted"))),
    }
    frame.render_widget(
        Paragraph::new(lines).wrap(Wrap { trim: false }),
        common_field_area(area),
    );
}

fn render_inspector(frame: &mut Frame<'_>, area: Rect, state: &AppState, theme: &ThemeConfig) {
    let block = workspace_pane(false, theme);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut lines = vec![section_heading("Runtime", theme)];
    if let Some(session) = &state.active_session {
        lines.push(key_value_line("session", session.to_string(), theme));
    }
    for (key, value) in &state.statuses {
        lines.push(key_value_line(key, value.clone(), theme));
    }

    lines.push(Line::default());
    lines.push(section_heading("Selected run", theme));
    if let Some(run) = selected_run(state) {
        lines.extend(run_detail_lines(run, theme));
    } else {
        lines.push(Line::styled(
            "  no run selected",
            theme_style(theme, "Muted"),
        ));
    }

    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn render_specialized(frame: &mut Frame<'_>, area: Rect, state: &AppState, theme: &ThemeConfig) {
    let block = workspace_pane(false, theme);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut lines = Vec::new();
    if let Some(run) = selected_run(state) {
        lines.push(Line::styled(
            run.display_name.clone(),
            theme_style(theme, "Accent"),
        ));
        lines.push(Line::styled(
            format!("{} · {:?} · {:?}", run.id, run.kind, run.state),
            theme_style(theme, "Muted"),
        ));
        lines.push(Line::default());
        lines.extend(run_detail_lines(run, theme));

        if let Some(snapshot) = &state.snapshot {
            let objectives = snapshot
                .objectives
                .iter()
                .filter(|objective| objective.root_run_id == run.id)
                .collect::<Vec<_>>();
            if !objectives.is_empty() {
                lines.push(Line::default());
                lines.push(section_heading("Objectives", theme));
                for objective in objectives {
                    lines.push(Line::from(vec![
                        Span::styled(
                            format!("  {} ", objective_marker(&objective.state)),
                            objective_style(&objective.state, theme),
                        ),
                        Span::styled(objective.title.clone(), theme_style(theme, "Normal")),
                    ]));
                    if let Some(description) = &objective.description {
                        lines.push(Line::styled(
                            format!("    {description}"),
                            theme_style(theme, "Muted"),
                        ));
                    }
                }
            }
        }
    } else {
        lines.push(Line::styled(
            "No selected run to inspect.",
            theme_style(theme, "Muted"),
        ));
        lines.push(Line::default());
        lines.push(Line::styled(
            "This surface is reserved for exact run/workflow inspection. Graph rendering can be added when graph data is projected into the typed frontend model.",
            theme_style(theme, "Muted"),
        ));
    }

    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn run_detail_lines(run: &RunSummary, theme: &ThemeConfig) -> Vec<Line<'static>> {
    let mut lines = vec![
        key_value_line("id", run.id.to_string(), theme),
        key_value_line("definition", run.definition_id.clone(), theme),
        key_value_line("kind", format!("{:?}", run.kind), theme),
        key_value_line("state", format!("{:?}", run.state), theme),
    ];
    if let Some(parent) = &run.parent {
        lines.push(key_value_line("parent", parent.to_string(), theme));
    }
    if let Some(model) = &run.model {
        lines.push(key_value_line("model", model_selection_label(model), theme));
    }
    if let Some(thinking) = &run.thinking_level {
        lines.push(key_value_line("thinking", format!("{thinking:?}"), theme));
    }
    if let Some(difficulty) = &run.difficulty {
        lines.push(key_value_line("difficulty", difficulty.clone(), theme));
    }
    if let Some(budget) = &run.budget {
        lines.push(key_value_line("budget", budget.clone(), theme));
    }
    if let Some(session) = &run.persisted_session {
        lines.push(key_value_line("session", session.to_string(), theme));
    }
    if let Some(session_file) = &run.session_file {
        lines.push(key_value_line("session file", session_file.clone(), theme));
    }
    lines.push(key_value_line(
        "pending",
        run.pending_messages.to_string(),
        theme,
    ));
    if let Some(outcome) = &run.outcome {
        lines.push(key_value_line("outcome", format!("{outcome:?}"), theme));
    }
    lines
}

fn section_heading(label: &str, theme: &ThemeConfig) -> Line<'static> {
    Line::styled(label.to_owned(), theme_style(theme, "Accent"))
}

fn key_value_line(key: &str, value: String, theme: &ThemeConfig) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("  {key}: "), theme_style(theme, "Muted")),
        Span::styled(value, theme_style(theme, "Normal")),
    ])
}

fn objective_marker(state: &ObjectiveState) -> &'static str {
    match state {
        ObjectiveState::NotStarted => "○",
        ObjectiveState::WorkInProgress => "◐",
        ObjectiveState::Done => "●",
        ObjectiveState::Blocked => "!",
    }
}

fn objective_style(state: &ObjectiveState, theme: &ThemeConfig) -> ratatui::style::Style {
    match state {
        ObjectiveState::Done => theme_style(theme, "Success"),
        ObjectiveState::Blocked => theme_style(theme, "Error"),
        ObjectiveState::WorkInProgress => theme_style(theme, "Accent"),
        ObjectiveState::NotStarted => theme_style(theme, "Muted"),
    }
}

fn selected_run(state: &AppState) -> Option<&RunSummary> {
    state.snapshot.as_ref().and_then(|snapshot| {
        state
            .input_target()
            .and_then(|target| snapshot.runs.iter().find(|run| &run.id == target))
    })
}

fn render_input(frame: &mut Frame<'_>, area: Rect, state: &AppState, theme: &ThemeConfig) {
    let completion_open = matches!(
        state.view.overlay,
        Some(OverlayState::CommandPalette { .. })
    );
    let focused =
        state.view.focus == FocusTarget::Input && (state.view.overlay.is_none() || completion_open);
    let block = flat_surface(theme);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut lines = input_text_lines(&state.input.text, theme);
    let auxiliary = match state.view.input_editor {
        InputEditor::External => Some(
            "Ctrl-G or Enter opens $EDITOR · Ctrl-Enter submits · Esc returns to owned".to_owned(),
        ),
        InputEditor::Owned | InputEditor::Embedded => None,
    };
    if usize::from(inner.height) > lines.len() {
        if let Some(auxiliary) = auxiliary {
            lines.push(Line::styled(auxiliary, theme_style(theme, "Muted")));
        }
    }

    let cursor = state.input.cursor_byte.min(state.input.text.len());
    let prefix = &state.input.text[..cursor];
    let (column, row) = cursor_position(prefix, inner.width.max(1));
    let scroll = if focused && state.view.input_editor != InputEditor::External && inner.height > 0
    {
        row.saturating_sub(inner.height.saturating_sub(1))
    } else {
        0
    };

    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((scroll, 0)),
        inner,
    );

    if focused && state.view.input_editor != InputEditor::External && inner.height > 0 {
        frame.set_cursor_position((
            inner
                .x
                .saturating_add(column.min(inner.width.saturating_sub(1))),
            inner.y.saturating_add(
                row.saturating_sub(scroll)
                    .min(inner.height.saturating_sub(1)),
            ),
        ));
    }
}

fn input_text_lines(text: &str, theme: &ThemeConfig) -> Vec<Line<'static>> {
    text.split('\n')
        .map(|line| Line::styled(line.to_owned(), theme_style(theme, "Normal")))
        .collect()
}

fn render_command_completion(
    frame: &mut Frame<'_>,
    screen: Rect,
    input_area: Rect,
    state: &AppState,
    theme: &ThemeConfig,
) {
    if state.view.focus != FocusTarget::Input {
        return;
    }
    let completions = command_completions(state);
    if completions.is_empty() || input_area.y <= screen.y {
        return;
    }
    let selected = match &state.view.overlay {
        Some(OverlayState::CommandPalette { selected, .. }) => {
            (*selected).min(completions.len().saturating_sub(1))
        }
        _ => 0,
    };

    let content_width = completions
        .iter()
        .map(|completion| {
            completion.command.chars().count()
                + completion
                    .description
                    .as_ref()
                    .map_or(0, |description| description.chars().count() + 3)
        })
        .max()
        .unwrap_or(1)
        .saturating_add(4)
        .min(usize::from(input_area.width));
    let width = u16::try_from(content_width)
        .unwrap_or(input_area.width)
        .max(20.min(input_area.width));
    let requested_height = u16::try_from(completions.len())
        .unwrap_or(u16::MAX)
        .saturating_add(2);
    let available_height = input_area.y.saturating_sub(screen.y);
    let height = requested_height.min(available_height);
    if height < 3 || width < 2 {
        return;
    }
    let popup = Rect {
        x: input_area.x,
        y: input_area.y.saturating_sub(height),
        width,
        height,
    };
    frame.render_widget(Clear, popup);
    let block = panel("Commands", true, theme);
    let inner = block.inner(popup);
    frame.render_widget(block, popup);
    let items = completions
        .into_iter()
        .take(usize::from(inner.height))
        .enumerate()
        .map(|(index, completion)| {
            let mut spans = vec![Span::styled(
                format!(
                    "{} {}",
                    if index == selected { "▸" } else { " " },
                    completion.command
                ),
                if index == selected {
                    theme_style(theme, "Accent")
                } else {
                    theme_style(theme, "Normal")
                },
            )];
            if let Some(description) = completion.description {
                spans.push(Span::styled(
                    format!("  —  {description}"),
                    theme_style(theme, "Muted"),
                ));
            }
            ListItem::new(Line::from(spans))
        })
        .collect::<Vec<_>>();
    frame.render_widget(List::new(items), inner);
}

fn render_status(frame: &mut Frame<'_>, area: Rect, state: &AppState, theme: &ThemeConfig) {
    let selected_run = selected_run(state);
    let model = selected_run.and_then(|run| run.model.as_ref()).map_or_else(
        || "selection: unavailable".to_owned(),
        model_selection_label,
    );
    let thinking = selected_run
        .and_then(|run| run.thinking_level.as_ref())
        .map(|level| format!("thinking: {level:?}"));
    let statuses = state
        .statuses
        .values()
        .cloned()
        .collect::<Vec<_>>()
        .join(" · ");
    let mut spans = vec![
        Span::styled("model: ", theme_style(theme, "Muted")),
        Span::styled(model, theme_style(theme, "Accent")),
    ];
    if let Some(thinking) = thinking {
        spans.extend([
            Span::styled("  ·  thinking: ", theme_style(theme, "Muted")),
            Span::styled(thinking, theme_style(theme, "Warning")),
        ]);
    }
    if let Some(run) = selected_run {
        spans.extend([
            Span::styled("  ·  run: ", theme_style(theme, "Muted")),
            Span::styled(
                format!("{:?}", run.state),
                run_state_style(&run.state, theme),
            ),
        ]);
    }
    if !statuses.is_empty() {
        spans.extend([
            Span::styled("  ·  ", theme_style(theme, "Muted")),
            Span::styled(statuses, theme_style(theme, "Normal")),
        ]);
    }
    frame.render_widget(
        Paragraph::new(Line::from(spans))
            .alignment(Alignment::Right)
            .style(surface_style(theme, "Surface"))
            .wrap(Wrap { trim: true }),
        common_field_area(area),
    );
}

fn run_state_style(state: &RunState, theme: &ThemeConfig) -> ratatui::style::Style {
    match state {
        RunState::Completed => theme_style(theme, "Success"),
        RunState::Failed | RunState::Cancelled | RunState::Orphaned => theme_style(theme, "Error"),
        RunState::Created | RunState::Starting | RunState::Waiting | RunState::Completing => {
            theme_style(theme, "Warning")
        }
        RunState::Running => theme_style(theme, "Accent"),
    }
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
    if matches!(overlay, OverlayState::CommandPalette { .. }) {
        return;
    }
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
                        if provider.configured {
                            "configured"
                        } else {
                            "login"
                        }
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
        } => render_extension_dialog(frame, overlay_area, request, *selected, state, theme),
        OverlayState::Help => render_picker(
            frame,
            overlay_area,
            "Help",
            0,
            vec![
                "Ctrl-W h/j/k/l moves between windows; Ctrl-W +/-/</> resizes".to_owned(),
                "[b / ]b switches previous/next run without changing focus".to_owned(),
                "gt / gT switches next/previous persisted session".to_owned(),
                "Space f m/s/a opens model/session/auth selection".to_owned(),
                "Run tree: j/k cursor · h/l collapse-parent/expand-child · Enter activate"
                    .to_owned(),
                "Transcript j/k or {/} selects conversation turns; za toggles details".to_owned(),
                "Transcript Ctrl-D/U/F/B scrolls without changing semantic selection".to_owned(),
                "Transcript [/] selects rich blocks; v/V changes the selected block view"
                    .to_owned(),
                "Transcript H/L and J/K scroll the selected rendered block viewport".to_owned(),
                "Ctrl-C explicitly aborts the selected run; Esc never aborts work".to_owned(),
                "Ctrl-G opens the configured external editor".to_owned(),
                "Owned input: Shift-Enter newline; Ctrl-W/U/K shell-style editing".to_owned(),
                "Command completion: arrows/Ctrl-N/P navigate; Ctrl-Y/Enter accept".to_owned(),
                "Theme and keymaps are configured in config.lua".to_owned(),
            ],
            theme,
        ),
        OverlayState::CommandPalette { .. } => unreachable!("handled before centered overlays"),
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
    if values.is_empty() {
        frame.render_widget(
            List::new(vec![ListItem::new(Line::styled(
                "No entries available.",
                theme_style(theme, "Muted"),
            ))]),
            inner,
        );
        return;
    }

    let visible_rows = usize::from(inner.height.max(1));
    let selected = selected.min(values.len().saturating_sub(1));
    let start = selected
        .saturating_add(1)
        .saturating_sub(visible_rows)
        .min(values.len().saturating_sub(visible_rows.min(values.len())));
    let items = values
        .into_iter()
        .enumerate()
        .skip(start)
        .take(visible_rows)
        .map(|(index, value)| {
            ListItem::new(format!(
                "{} {value}",
                if index == selected { "▸" } else { " " }
            ))
            .style(if index == selected {
                theme_style(theme, "Accent")
            } else {
                theme_style(theme, "Normal")
            })
        })
        .collect::<Vec<_>>();
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
    let block = panel(&format!("Authentication · {flow_id}"), true, theme);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let mut lines = vec![Line::styled(
        auth_prompt_message(prompt),
        theme_style(theme, "Normal"),
    )];
    match prompt {
        AuthPrompt::Select { options, .. } => {
            lines.extend(options.iter().enumerate().map(|(index, option)| {
                Line::styled(
                    format!(
                        "{} {}",
                        if index == selected { "▸" } else { " " },
                        option.label
                    ),
                    if index == selected {
                        theme_style(theme, "Accent")
                    } else {
                        theme_style(theme, "Normal")
                    },
                )
            }));
        }
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
    let width = usize::from(width.max(1));
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
        column.min(usize::from(u16::MAX)) as u16,
        row.min(usize::from(u16::MAX)) as u16,
    )
}

fn model_selection_label(model: &phenix_runtime_api::ModelRef) -> String {
    format!("{}/{}", model.provider, model.model)
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
    use phenix_runtime_api::{
        BackendHealth, RunId, RunKind, RunState, RunSummary, RuntimeSnapshot, TranscriptBlock,
        TranscriptRole,
    };

    #[test]
    fn pointer_hit_testing_uses_the_pane_under_the_cursor() {
        let regions = BTreeMap::from([
            (ElementId::transcript(), Rect::new(0, 0, 80, 30)),
            (ElementId::sidebar(), Rect::new(80, 0, 20, 30)),
        ]);
        assert_eq!(
            hit_test_regions(&regions, 10, 5),
            Some(ElementId::transcript())
        );
        assert_eq!(
            hit_test_regions(&regions, 90, 5),
            Some(ElementId::sidebar())
        );
        assert_eq!(hit_test_regions(&regions, 100, 5), None);
    }

    #[test]
    fn command_completion_is_not_treated_as_a_modal_pointer_blocker() {
        let mut state = AppState::default();
        state.view.overlay = Some(OverlayState::CommandPalette {
            query: String::new(),
            selected: 0,
        });
        assert!(!pointer_modal_open(&state));
    }

    #[test]
    fn picker_window_keeps_deep_selection_visible() {
        let selected = 12usize;
        let visible_rows = 5usize;
        let start = selected
            .saturating_add(1)
            .saturating_sub(visible_rows)
            .min(20usize.saturating_sub(visible_rows));
        assert_eq!(start, 8);
        assert!((start..start + visible_rows).contains(&selected));
    }

    #[test]
    fn input_buffer_is_split_into_explicit_lines() {
        let lines = input_text_lines("one\n\nthree", &ThemeConfig::default());
        assert_eq!(lines.len(), 3);
    }

    #[test]
    fn routing_and_concrete_models_use_canonical_status_values() {
        let routed = phenix_runtime_api::ModelRef {
            provider: "routing".to_owned(),
            model: "mixed".to_owned(),
        };
        let direct = phenix_runtime_api::ModelRef {
            provider: "pi".to_owned(),
            model: "openai/gpt-5.6".to_owned(),
        };
        assert_eq!(model_selection_label(&routed), "routing/mixed");
        assert_eq!(model_selection_label(&direct), "pi/openai/gpt-5.6");
    }

    #[test]
    fn status_can_resolve_selected_run_model() {
        let run_id = RunId::parse("run-root").expect("run ID");
        let mut state = AppState {
            root_run: Some(run_id.clone()),
            selected_run: Some(run_id.clone()),
            ..AppState::default()
        };
        state.snapshot = Some(RuntimeSnapshot {
            capabilities: Default::default(),
            health: BackendHealth::Ready,
            active_session: None,
            root_run: Some(run_id.clone()),
            selected_run: Some(run_id.clone()),
            sessions: Vec::new(),
            runs: vec![RunSummary {
                id: run_id,
                parent: None,
                kind: RunKind::Root,
                definition_id: "root".to_owned(),
                display_name: "Root".to_owned(),
                state: RunState::Running,
                persisted_session: None,
                session_file: None,
                model: Some(phenix_runtime_api::ModelRef {
                    provider: "routing".to_owned(),
                    model: "mixed".to_owned(),
                }),
                thinking_level: None,
                difficulty: None,
                budget: None,
                pending_messages: 0,
                outcome: None,
            }],
            objectives: Vec::new(),
        });
        let model = state
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.runs.first())
            .and_then(|run| run.model.as_ref())
            .expect("selected model");
        assert_eq!(model_selection_label(model), "routing/mixed");
    }

    #[test]
    fn visible_png_media_is_projected_to_terminal_coordinates() {
        let run_id = RunId::parse("run-image").expect("run id");
        let mut state = AppState {
            root_run: Some(run_id.clone()),
            selected_run: Some(run_id.clone()),
            ..AppState::default()
        };
        state
            .transcript_mut(run_id.clone())
            .append(TranscriptBlock {
                id: "u1".to_owned(),
                run_id: run_id.clone(),
                role: TranscriptRole::User,
                text: "image".to_owned(),
                complete: true,
            });
        state
            .transcript_mut(run_id.clone())
            .append(TranscriptBlock {
                id: "a1".to_owned(),
                run_id,
                role: TranscriptRole::Assistant,
                text: "![preview](data:image/png;base64,Zm9v)".to_owned(),
                complete: true,
            });
        let placements =
            terminal_image_placements(Rect::new(0, 0, 120, 40), &state, &FrontendConfig::default());
        assert_eq!(placements.len(), 1);
        assert_eq!(placements[0].source, "data:image/png;base64,Zm9v");
        assert!(placements[0].rows > 0);
    }
}
