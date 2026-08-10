use crate::rich_document::{render_document, RichBlockPresentation, RichMedia};
use crate::theme::{surface_style, theme_style};
use phenix_frontend_config::ThemeConfig;
use phenix_ui_core::{
    group_transcript_turns, parse_markdown, AppState, TranscriptTurn, TranscriptTurnItem,
    TranscriptTurnItemKind,
};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
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
                    .map(|message| TranscriptTurnItem {
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
    for (index, turn) in turns.iter().enumerate() {
        if index > 0 {
            lines.extend((0..TURN_GAP_LINES).map(|_| Line::default()));
        }
        let start = lines.len();
        render_turn(
            &mut lines,
            &mut media,
            turn,
            TurnRenderContext {
                selected: selected_turn == Some(index)
                    && state.view.focus == phenix_ui_core::FocusTarget::Transcript,
                expanded: state.view.transcript_turn_is_expanded(&turn.id),
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
        media,
    }
}

struct TurnRenderContext<'a> {
    selected: bool,
    expanded: bool,
    width: u16,
    state: &'a AppState,
    theme: &'a ThemeConfig,
}

fn render_turn(
    lines: &mut Vec<Line<'static>>,
    media: &mut Vec<TranscriptMediaAnchor>,
    turn: &TranscriptTurn,
    context: TurnRenderContext<'_>,
) {
    let TurnRenderContext {
        selected,
        expanded,
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
                lines.push(detail_summary_line(item, selected, expanded, theme));
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
        state
            .view
            .expanded_transcript_turns
            .insert("run-1:u1".to_owned());

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
