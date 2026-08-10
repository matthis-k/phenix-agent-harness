use crate::rich_document::{render_document, RichBlockPresentation, RichMedia};
use crate::theme::{surface_style, theme_style};
use phenix_frontend_config::ThemeConfig;
use phenix_runtime_api::ToolExecutionOutcome;
use phenix_ui_core::{
    group_transcript_turns, parse_markdown, AppState, TranscriptTurn, TranscriptTurnItem,
    TranscriptTurnItemKind,
};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use serde_json::Value;
use std::ops::Range;

const DETAIL_PREFIX: &str = "  │ ";
const TURN_GAP_LINES: usize = 2;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TranscriptMediaAnchor {
    pub line: usize,
    pub media: RichMedia,
}

#[derive(Debug)]
pub(crate) struct TranscriptDocument {
    pub lines: Vec<Line<'static>>,
    pub turn_ranges: Vec<Range<usize>>,
    pub fold_lines: Vec<usize>,
    pub media: Vec<TranscriptMediaAnchor>,
}

pub(crate) fn transcript_document(
    state: &AppState,
    theme: &ThemeConfig,
    width: u16,
) -> TranscriptDocument {
    let mut turns = state
        .input_target()
        .and_then(|run_id| state.transcript(run_id))
        .map_or_else(Vec::new, |transcript| {
            group_transcript_turns(&transcript.blocks)
        });

    if !state.notifications.is_empty() {
        if turns.is_empty() {
            turns.push(TranscriptTurn {
                id: "frontend-notifications".to_owned(),
                user: None,
                response: String::new(),
                items: Vec::new(),
            });
        }
        if let Some(turn) = turns.last_mut() {
            turn.items.extend(
                state
                    .notifications
                    .iter()
                    .enumerate()
                    .map(|(index, message)| TranscriptTurnItem {
                        id: format!("frontend-notification:{index}"),
                        kind: TranscriptTurnItemKind::System,
                        text: message.clone(),
                    }),
            );
        }
    }

    let selected_turn = if turns.is_empty() {
        None
    } else {
        Some(
            state
                .view
                .transcript_selected_turn
                .unwrap_or(turns.len() - 1)
                .min(turns.len() - 1),
        )
    };

    let mut lines = Vec::new();
    let mut media = Vec::new();
    let mut turn_ranges = Vec::with_capacity(turns.len());
    let mut fold_lines = Vec::new();
    let mut fold_index = 0usize;
    for (index, turn) in turns.iter().enumerate() {
        if index > 0 {
            lines.extend((0..TURN_GAP_LINES).map(|_| Line::default()));
        }
        let start = lines.len();
        render_turn(
            &mut lines,
            &mut media,
            &mut fold_lines,
            &mut fold_index,
            turn,
            TurnRenderContext {
                selected: selected_turn == Some(index)
                    && state.view.focus == phenix_ui_core::FocusTarget::Transcript,
                width,
                state,
                theme,
            },
        );
        turn_ranges.push(start..lines.len());
    }

    TranscriptDocument {
        lines,
        turn_ranges,
        fold_lines,
        media,
    }
}

struct TurnRenderContext<'a> {
    selected: bool,
    width: u16,
    state: &'a AppState,
    theme: &'a ThemeConfig,
}

fn render_turn(
    lines: &mut Vec<Line<'static>>,
    media: &mut Vec<TranscriptMediaAnchor>,
    fold_lines: &mut Vec<usize>,
    fold_index: &mut usize,
    turn: &TranscriptTurn,
    context: TurnRenderContext<'_>,
) {
    let TurnRenderContext {
        selected,
        width,
        state,
        theme,
    } = context;
    if let Some(user) = &turn.user {
        lines.extend(user_message_lines(user, width, theme));
        lines.push(Line::default());
    }

    let mut rendered_any = false;
    let mut rich_block_index = 0usize;
    for item in &turn.items {
        if item.text.trim().is_empty() {
            continue;
        }
        if rendered_any {
            lines.push(Line::default());
        }
        match item.kind {
            TranscriptTurnItemKind::Assistant => render_assistant_item(
                lines,
                media,
                item,
                turn,
                selected,
                width,
                state,
                theme,
                &mut rich_block_index,
            ),
            TranscriptTurnItemKind::Thinking
            | TranscriptTurnItemKind::Tool
            | TranscriptTurnItemKind::System => {
                let current_fold = *fold_index;
                *fold_index = fold_index.saturating_add(1);
                fold_lines.push(lines.len());
                let expanded = state.view.transcript_item_is_expanded(&item.id);
                let fold_selected = state.view.focus == phenix_ui_core::FocusTarget::Transcript
                    && state.view.transcript_selected_fold == Some(current_fold);
                if item.kind == TranscriptTurnItemKind::Tool {
                    render_tool_item(lines, item, fold_selected, expanded, width, state, theme);
                    rendered_any = true;
                    continue;
                }
                lines.push(detail_summary_line(item, fold_selected, expanded, theme));
                if expanded {
                    lines.extend(detail_lines(item, width, theme));
                }
            }
        }
        rendered_any = true;
    }

    if !rendered_any && turn.user.is_some() {
        lines.push(Line::styled("…", theme_style(theme, "Muted")));
    }
}

#[allow(clippy::too_many_arguments)]
fn render_assistant_item(
    lines: &mut Vec<Line<'static>>,
    media: &mut Vec<TranscriptMediaAnchor>,
    item: &TranscriptTurnItem,
    turn: &TranscriptTurn,
    selected: bool,
    width: u16,
    state: &AppState,
    theme: &ThemeConfig,
    rich_block_index: &mut usize,
) {
    let document = parse_markdown(&item.text);
    let first_block = *rich_block_index;
    let rendered = render_document(&document, width, theme, |block_index, _| {
        let block_index = first_block.saturating_add(block_index);
        let key = rich_block_key(&turn.id, block_index);
        RichBlockPresentation {
            view: state.view.rich_block_view(&key),
            viewport: state.view.rich_block_viewport(&key),
            selected: selected && state.view.transcript_selected_block == Some(block_index),
        }
    });
    let block_count = rendered.len();
    for (local_block_index, block) in rendered.into_iter().enumerate() {
        if local_block_index > 0 {
            lines.push(Line::default());
        }
        let start = lines.len();
        if let Some(block_media) = block.media {
            media.push(TranscriptMediaAnchor {
                // Interactive rich blocks reserve their first row for the view toolbar.
                line: start.saturating_add(1),
                media: block_media,
            });
        }
        lines.extend(block.lines);
    }
    *rich_block_index = first_block.saturating_add(block_count);
}

fn rich_block_key(turn_id: &str, index: usize) -> String {
    format!("{turn_id}:block:{index}")
}

fn user_message_lines(text: &str, width: u16, theme: &ThemeConfig) -> Vec<Line<'static>> {
    let width = usize::from(width.max(1));
    let surface = surface_style(theme, "UserMessage");
    let content_width = width.saturating_sub(4).max(1);
    let mut lines = vec![padded_surface_line(
        vec![
            Span::styled("  ", surface),
            Span::styled(
                "You",
                theme_style(theme, "Accent").add_modifier(Modifier::BOLD),
            ),
        ],
        width,
        surface,
    )];

    if text.is_empty() {
        lines.push(padded_surface_line(Vec::new(), width, surface));
        return lines;
    }

    for logical_line in text.split('\n') {
        for fragment in wrap_preserving_text(logical_line, content_width) {
            lines.push(padded_surface_line(
                vec![
                    Span::styled("  ", surface),
                    Span::styled(fragment, theme_style(theme, "Normal")),
                ],
                width,
                surface,
            ));
        }
    }
    lines
}

fn padded_surface_line(
    mut spans: Vec<Span<'static>>,
    width: usize,
    surface: Style,
) -> Line<'static> {
    let used = spans
        .iter()
        .map(|span| span.content.chars().count())
        .sum::<usize>();
    if used < width {
        spans.push(Span::styled(" ".repeat(width - used), surface));
    }
    Line::from(spans).style(surface)
}

fn detail_summary_line(
    item: &TranscriptTurnItem,
    selected: bool,
    expanded: bool,
    theme: &ThemeConfig,
) -> Line<'static> {
    let (label, group, show_summary) = match item.kind {
        TranscriptTurnItemKind::Thinking => ("Thinking", "Thinking", false),
        TranscriptTurnItemKind::Tool => ("Tool", "Tool", true),
        TranscriptTurnItemKind::System => ("Notice", "Muted", true),
        TranscriptTurnItemKind::Assistant => unreachable!("assistant items use rich rendering"),
    };
    let marker_style = if selected {
        theme_style(theme, "Accent")
    } else {
        theme_style(theme, group)
    };
    let mut spans = vec![
        Span::styled(if expanded { "▾ " } else { "▸ " }, marker_style),
        Span::styled(
            label,
            theme_style(theme, group).add_modifier(Modifier::BOLD),
        ),
    ];
    if show_summary {
        if let Some(summary) = item
            .text
            .lines()
            .next()
            .filter(|line| !line.trim().is_empty())
        {
            spans.push(Span::styled("  ", theme_style(theme, "Muted")));
            spans.push(Span::styled(
                summary.to_owned(),
                theme_style(theme, "Muted"),
            ));
        }
    }
    Line::from(spans)
}

fn render_tool_item(
    lines: &mut Vec<Line<'static>>,
    item: &TranscriptTurnItem,
    selected: bool,
    expanded: bool,
    width: u16,
    state: &AppState,
    theme: &ThemeConfig,
) {
    let tool = state.tool_calls.get(&item.id);
    let name = tool
        .map(|tool| tool.name.as_str())
        .or_else(|| item.text.lines().next())
        .unwrap_or("Tool");
    let (status, status_group) = tool.map_or(("running", "Warning"), |tool| match &tool.outcome {
        Some(ToolExecutionOutcome::Succeeded) => ("done", "Success"),
        Some(ToolExecutionOutcome::Failed) => ("failed", "Error"),
        Some(ToolExecutionOutcome::Aborted) => ("aborted", "Warning"),
        None => ("running", "Warning"),
    });
    let marker_style = if selected {
        theme_style(theme, "Accent")
    } else {
        theme_style(theme, "Tool")
    };
    lines.push(Line::from(vec![
        Span::styled(if expanded { "▾ " } else { "▸ " }, marker_style),
        Span::styled(
            "Tool",
            theme_style(theme, "Tool").add_modifier(Modifier::BOLD),
        ),
        Span::styled(format!("  {name}"), theme_style(theme, "Normal")),
        Span::styled(format!("  · {status}"), theme_style(theme, status_group)),
    ]));
    if !expanded {
        return;
    }
    if let Some(tool) = tool {
        let mut rows = tool_argument_rows(&tool.raw_input_json);
        if let Some(output) = &tool.output {
            rows.push(("output".to_owned(), text_value_lines(output)));
        }
        lines.extend(render_key_value_rows(&rows, width, theme));
    }
}

fn tool_argument_rows(raw_input_json: &str) -> Vec<(String, Vec<String>)> {
    match serde_json::from_str::<Value>(raw_input_json) {
        Ok(Value::Object(values)) => values
            .into_iter()
            .map(|(key, value)| (key, json_value_lines(&value)))
            .collect(),
        Ok(value) => vec![("input".to_owned(), json_value_lines(&value))],
        Err(_) => vec![("input".to_owned(), text_value_lines(raw_input_json))],
    }
}

fn json_value_lines(value: &Value) -> Vec<String> {
    match value {
        Value::String(value) => text_value_lines(value),
        _ => serde_json::to_string_pretty(value)
            .unwrap_or_else(|_| value.to_string())
            .lines()
            .map(str::to_owned)
            .collect(),
    }
}

fn text_value_lines(value: &str) -> Vec<String> {
    if value.is_empty() {
        return vec![String::new()];
    }
    value.split('\n').map(str::to_owned).collect()
}

fn render_key_value_rows(
    rows: &[(String, Vec<String>)],
    width: u16,
    theme: &ThemeConfig,
) -> Vec<Line<'static>> {
    if rows.is_empty() {
        return vec![Line::styled(
            "  (no arguments)",
            theme_style(theme, "Muted"),
        )];
    }
    let width = usize::from(width.max(1));
    let indent = 2usize;
    let separator_width = 3usize;
    if width <= indent + separator_width + 4 {
        return rows
            .iter()
            .flat_map(|(key, values)| {
                values.iter().flat_map(move |value| {
                    wrap_preserving_text(
                        &format!("{key}: {value}"),
                        width.saturating_sub(indent).max(1),
                    )
                })
            })
            .map(|line| Line::styled(format!("  {line}"), theme_style(theme, "Muted")))
            .collect();
    }

    let available = width.saturating_sub(indent);
    let max_key = rows
        .iter()
        .map(|(key, _)| key.chars().count())
        .max()
        .unwrap_or(3);
    let key_width = max_key.min(24).min((available / 3).max(3));
    let value_width = available.saturating_sub(key_width + separator_width).max(1);
    let mut output = vec![Line::from(vec![
        Span::styled("  ", theme_style(theme, "Muted")),
        Span::styled(
            format!("{:<key_width$}", "key"),
            theme_style(theme, "Muted"),
        ),
        Span::styled(" │ ", theme_style(theme, "Border")),
        Span::styled("value", theme_style(theme, "Muted")),
    ])];

    for (key, values) in rows {
        let mut first = true;
        let logical_values = if values.is_empty() {
            vec![String::new()]
        } else {
            values.clone()
        };
        for logical in logical_values {
            let wrapped = wrap_preserving_text(&logical, value_width);
            for fragment in wrapped {
                let label = if first { key.as_str() } else { "" };
                output.push(Line::from(vec![
                    Span::styled("  ", theme_style(theme, "Muted")),
                    Span::styled(
                        format!("{label:<key_width$}"),
                        theme_style(theme, if first { "Tool" } else { "Muted" }),
                    ),
                    Span::styled(" │ ", theme_style(theme, "Border")),
                    Span::styled(fragment, theme_style(theme, "Muted")),
                ]));
                first = false;
            }
        }
    }
    output
}

fn detail_lines(item: &TranscriptTurnItem, width: u16, theme: &ThemeConfig) -> Vec<Line<'static>> {
    let group = match item.kind {
        TranscriptTurnItemKind::Thinking => "Thinking",
        TranscriptTurnItemKind::Tool => "Tool",
        TranscriptTurnItemKind::System => "Muted",
        TranscriptTurnItemKind::Assistant => unreachable!("assistant items use rich rendering"),
    };
    let content_width = usize::from(width)
        .saturating_sub(DETAIL_PREFIX.chars().count())
        .max(1);
    let skip_summary_line = matches!(
        item.kind,
        TranscriptTurnItemKind::Tool | TranscriptTurnItemKind::System
    );
    item.text
        .lines()
        .skip(usize::from(skip_summary_line))
        .flat_map(|logical_line| wrap_preserving_text(logical_line, content_width))
        .map(|fragment| {
            Line::from(vec![
                Span::styled(DETAIL_PREFIX, theme_style(theme, group)),
                Span::styled(fragment, theme_style(theme, "Muted")),
            ])
        })
        .collect()
}

fn wrap_preserving_text(line: &str, width: usize) -> Vec<String> {
    if line.is_empty() {
        return vec![String::new()];
    }
    let mut output = Vec::new();
    let mut current = String::new();
    for character in line.chars() {
        if current.chars().count() == width {
            output.push(std::mem::take(&mut current));
        }
        current.push(character);
    }
    if !current.is_empty() {
        output.push(current);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_runtime_api::{RunId, TranscriptBlock, TranscriptRole};
    use phenix_ui_core::{RichBlockView, RichBlockViewport};

    fn block(id: &str, role: TranscriptRole, text: &str) -> TranscriptBlock {
        TranscriptBlock {
            id: id.to_owned(),
            run_id: RunId::parse("run-1").expect("run id"),
            role,
            text: text.to_owned(),
            complete: true,
        }
    }

    fn line_text(line: &Line<'_>) -> String {
        line.spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>()
    }

    #[test]
    fn user_message_is_one_full_width_surface_including_wraps() {
        let theme = ThemeConfig::default();
        let lines = user_message_lines("abcdefghijklmnopqrstuvwxyz", 16, &theme);
        assert!(lines.len() > 2);
        assert!(lines
            .iter()
            .all(|line| line_text(line).chars().count() >= 16));
        let background = surface_style(&theme, "UserMessage").bg;
        assert!(background.is_some());
        assert!(lines.iter().all(|line| line.style.bg == background));
    }

    #[test]
    fn distinct_turns_have_explicit_vertical_rhythm() {
        let run_id = RunId::parse("run-1").expect("run id");
        let mut state = AppState {
            root_run: Some(run_id.clone()),
            selected_run: Some(run_id.clone()),
            ..AppState::default()
        };
        let transcript = state.transcript_mut(run_id);
        transcript.append(block("u1", TranscriptRole::User, "one"));
        transcript.append(block("a1", TranscriptRole::Assistant, "answer one"));
        transcript.append(block("u2", TranscriptRole::User, "two"));
        transcript.append(block("a2", TranscriptRole::Assistant, "answer two"));
        let document = transcript_document(&state, &ThemeConfig::default(), 50);
        assert_eq!(document.turn_ranges.len(), 2);
        assert!(document.turn_ranges[1].start >= document.turn_ranges[0].end + TURN_GAP_LINES);
    }

    #[test]
    fn mixed_thinking_tools_and_assistant_text_render_in_event_order() {
        let run_id = RunId::parse("run-1").expect("run id");
        let mut state = AppState {
            root_run: Some(run_id.clone()),
            selected_run: Some(run_id.clone()),
            ..AppState::default()
        };
        let transcript = state.transcript_mut(run_id);
        transcript.append(block("u1", TranscriptRole::User, "inspect"));
        transcript.append(block("t1", TranscriptRole::Thinking, "before tool"));
        transcript.append(block("tool", TranscriptRole::Tool, "read\nfile.rs"));
        transcript.append(block("t2", TranscriptRole::Thinking, "after tool"));
        transcript.append(block("a1", TranscriptRole::Assistant, "final answer"));
        for id in ["run-1:t1", "run-1:tool", "run-1:t2"] {
            state.view.expanded_transcript_items.insert(id.to_owned());
        }

        let document = transcript_document(&state, &ThemeConfig::default(), 50);
        let text = document.lines.iter().map(line_text).collect::<Vec<_>>();
        let before = text
            .iter()
            .position(|line| line.contains("before tool"))
            .expect("first thinking");
        let tool = text
            .iter()
            .position(|line| line.contains("read"))
            .expect("tool");
        let after = text
            .iter()
            .position(|line| line.contains("after tool"))
            .expect("second thinking");
        let answer = text
            .iter()
            .position(|line| line.contains("final answer"))
            .expect("assistant answer");
        assert!(before < tool && tool < after && after < answer);
    }

    #[test]
    fn tool_argument_rows_decode_json_newlines_without_unescaping_literal_backslashes() {
        let rows = tool_argument_rows(
            r#"{"script":"line one\nline two","literal":"line one\\nline two"}"#,
        );
        let script = rows
            .iter()
            .find(|(key, _)| key == "script")
            .expect("script row");
        assert_eq!(script.1, vec!["line one", "line two"]);
        let literal = rows
            .iter()
            .find(|(key, _)| key == "literal")
            .expect("literal row");
        assert_eq!(literal.1, vec!["line one\\nline two"]);
    }

    #[test]
    fn per_block_view_and_viewport_state_reaches_the_component_renderer() {
        let run_id = RunId::parse("run-1").expect("run id");
        let mut state = AppState {
            root_run: Some(run_id.clone()),
            selected_run: Some(run_id.clone()),
            ..AppState::default()
        };
        state
            .transcript_mut(run_id.clone())
            .append(block("u1", TranscriptRole::User, "code"));
        state.transcript_mut(run_id).append(block(
            "a1",
            TranscriptRole::Assistant,
            "```rust\nzero\none\ntwo\nthree\n```",
        ));
        let key = "run-1:u1:block:0".to_owned();
        state
            .view
            .set_rich_block_view(key.clone(), RichBlockView::Source);
        *state.view.rich_block_viewport_mut(key) = RichBlockViewport {
            horizontal: 0,
            vertical: 2,
        };
        let document = transcript_document(&state, &ThemeConfig::default(), 50);
        let text = document.lines.iter().map(line_text).collect::<Vec<_>>();
        assert!(text.iter().any(|line| line.contains("two")));
        assert!(!text.iter().any(|line| line.trim() == "zero"));
    }

    #[test]
    fn rich_block_indices_remain_stable_across_interleaved_items() {
        let run_id = RunId::parse("run-1").expect("run id");
        let mut state = AppState {
            root_run: Some(run_id.clone()),
            selected_run: Some(run_id.clone()),
            ..AppState::default()
        };
        let transcript = state.transcript_mut(run_id.clone());
        transcript.append(block("u1", TranscriptRole::User, "code"));
        transcript.append(block(
            "a1",
            TranscriptRole::Assistant,
            "```rust\nfirst\n```",
        ));
        transcript.append(block("tool", TranscriptRole::Tool, "read\nfile.rs"));
        transcript.append(block(
            "a2",
            TranscriptRole::Assistant,
            "```rust\nsecond\n```",
        ));
        state
            .view
            .set_rich_block_view("run-1:u1:block:1".to_owned(), RichBlockView::Source);
        state
            .view
            .rich_block_viewport_mut("run-1:u1:block:1".to_owned())
            .vertical = 0;
        let document = transcript_document(&state, &ThemeConfig::default(), 50);
        let text = document.lines.iter().map(line_text).collect::<Vec<_>>();
        assert!(text.iter().any(|line| line.contains("first")));
        assert!(text.iter().any(|line| line.contains("second")));
    }

    #[test]
    fn image_blocks_keep_a_media_anchor() {
        let run_id = RunId::parse("run-1").expect("run id");
        let mut state = AppState {
            root_run: Some(run_id.clone()),
            selected_run: Some(run_id.clone()),
            ..AppState::default()
        };
        state
            .transcript_mut(run_id.clone())
            .append(block("u1", TranscriptRole::User, "image"));
        state.transcript_mut(run_id).append(block(
            "a1",
            TranscriptRole::Assistant,
            "![preview](data:image/png;base64,Zm9v)",
        ));
        let document = transcript_document(&state, &ThemeConfig::default(), 50);
        assert_eq!(document.media.len(), 1);
        assert!(matches!(document.media[0].media, RichMedia::Image { .. }));
    }

    #[test]
    fn expanded_details_keep_a_stable_hanging_indent_when_wrapped() {
        let detail = TranscriptTurnItem {
            id: "detail-test".to_owned(),
            kind: TranscriptTurnItemKind::Thinking,
            text: "abcdefghijklmnopqrstuvwxyz".to_owned(),
        };
        let lines = detail_lines(&detail, 12, &ThemeConfig::default());
        let rendered = lines.iter().map(line_text).collect::<Vec<_>>();
        assert!(rendered.len() > 1);
        assert!(rendered.iter().all(|line| line.starts_with(DETAIL_PREFIX)));
        assert!(rendered.iter().all(|line| line.chars().count() <= 12));
    }
}
