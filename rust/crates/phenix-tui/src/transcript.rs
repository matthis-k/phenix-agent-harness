use crate::rich_document::{render_document, RichBlockPresentation, RichMedia};
use crate::theme::{surface_style, theme_style};
use phenix_frontend_config::ThemeConfig;
use phenix_ui_core::{
    group_transcript_turns, parse_markdown, AppState, TranscriptDetailKind, TranscriptTurn,
    TranscriptTurnDetail,
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
                details: Vec::new(),
            });
        }
        if let Some(turn) = turns.last_mut() {
            turn.details.extend(
                state
                    .notifications
                    .iter()
                    .map(|message| TranscriptTurnDetail {
                        kind: TranscriptDetailKind::System,
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
            selected_turn == Some(index)
                && state.view.focus == phenix_ui_core::FocusTarget::Transcript,
            state.view.transcript_turn_is_expanded(&turn.id),
            width,
            state,
            theme,
        );
        turn_ranges.push(start..lines.len());
    }

    TranscriptDocument {
        lines,
        turn_ranges,
        media,
    }
}

fn render_turn(
    lines: &mut Vec<Line<'static>>,
    media: &mut Vec<TranscriptMediaAnchor>,
    turn: &TranscriptTurn,
    selected: bool,
    expanded: bool,
    width: u16,
    state: &AppState,
    theme: &ThemeConfig,
) {
    if let Some(user) = &turn.user {
        lines.extend(user_message_lines(user, width, theme));
        lines.push(Line::default());
    }

    if !turn.response.trim().is_empty() {
        let document = parse_markdown(&turn.response);
        let rendered = render_document(&document, width, theme, |block_index, _| {
            let key = rich_block_key(&turn.id, block_index);
            RichBlockPresentation {
                view: state.view.rich_block_view(&key),
                viewport: state.view.rich_block_viewport(&key),
                selected: selected && state.view.transcript_selected_block == Some(block_index),
            }
        });
        for (block_index, block) in rendered.into_iter().enumerate() {
            if block_index > 0 {
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
    } else if turn.user.is_some() {
        lines.push(Line::styled("…", theme_style(theme, "Muted")));
    }

    if !turn.details.is_empty() {
        if !turn.response.trim().is_empty() {
            lines.push(Line::default());
        }
        lines.push(detail_summary_line(turn, selected, expanded, theme));
        if expanded {
            for detail in &turn.details {
                lines.extend(detail_lines(detail, width, theme));
            }
        }
    }
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
    turn: &TranscriptTurn,
    selected: bool,
    expanded: bool,
    theme: &ThemeConfig,
) -> Line<'static> {
    let thinking = turn
        .details
        .iter()
        .filter(|detail| detail.kind == TranscriptDetailKind::Thinking)
        .count();
    let tools = turn
        .details
        .iter()
        .filter(|detail| detail.kind == TranscriptDetailKind::Tool)
        .count();
    let notices = turn
        .details
        .iter()
        .filter(|detail| detail.kind == TranscriptDetailKind::System)
        .count();

    let marker_style = if selected {
        theme_style(theme, "Accent")
    } else {
        theme_style(theme, "Muted")
    };
    let mut spans = vec![Span::styled(
        if expanded { "▾ " } else { "▸ " },
        marker_style,
    )];
    let mut first = true;
    let mut push_chip = |label: String, group: &'static str| {
        if !first {
            spans.push(Span::styled("  ", theme_style(theme, "Muted")));
        }
        spans.push(Span::styled(
            format!("[{label}]"),
            theme_style(theme, group).add_modifier(Modifier::BOLD),
        ));
        first = false;
    };
    if thinking > 0 {
        push_chip("Thinking".to_owned(), "Thinking");
    }
    if tools > 0 {
        push_chip(
            if tools == 1 {
                "Tool".to_owned()
            } else {
                format!("Tools {tools}")
            },
            "Tool",
        );
    }
    if notices > 0 {
        push_chip(
            if notices == 1 {
                "Notice".to_owned()
            } else {
                format!("Notices {notices}")
            },
            "Muted",
        );
    }
    Line::from(spans)
}

fn detail_lines(
    detail: &TranscriptTurnDetail,
    width: u16,
    theme: &ThemeConfig,
) -> Vec<Line<'static>> {
    let (label, group) = match detail.kind {
        TranscriptDetailKind::Thinking => ("Thinking", "Thinking"),
        TranscriptDetailKind::Tool => ("Tool", "Tool"),
        TranscriptDetailKind::System => ("Notice", "Muted"),
    };
    let mut lines = vec![Line::styled(
        format!("  {label}"),
        theme_style(theme, group).add_modifier(Modifier::BOLD),
    )];
    let content_width = usize::from(width)
        .saturating_sub(DETAIL_PREFIX.chars().count())
        .max(1);
    for logical_line in detail.text.lines() {
        for fragment in wrap_preserving_text(logical_line, content_width) {
            lines.push(Line::from(vec![
                Span::styled(DETAIL_PREFIX, theme_style(theme, group)),
                Span::styled(fragment, theme_style(theme, "Muted")),
            ]));
        }
    }
    lines
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
        let mut state = AppState::default();
        state.root_run = Some(run_id.clone());
        state.selected_run = Some(run_id.clone());
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
    fn per_block_view_and_viewport_state_reaches_the_component_renderer() {
        let run_id = RunId::parse("run-1").expect("run id");
        let mut state = AppState::default();
        state.root_run = Some(run_id.clone());
        state.selected_run = Some(run_id.clone());
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
    fn image_blocks_keep_a_media_anchor() {
        let run_id = RunId::parse("run-1").expect("run id");
        let mut state = AppState::default();
        state.root_run = Some(run_id.clone());
        state.selected_run = Some(run_id.clone());
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
        let detail = TranscriptTurnDetail {
            kind: TranscriptDetailKind::Thinking,
            text: "abcdefghijklmnopqrstuvwxyz".to_owned(),
        };
        let lines = detail_lines(&detail, 12, &ThemeConfig::default());
        let rendered = lines.iter().skip(1).map(line_text).collect::<Vec<_>>();
        assert!(rendered.len() > 1);
        assert!(rendered.iter().all(|line| line.starts_with(DETAIL_PREFIX)));
        assert!(rendered.iter().all(|line| line.chars().count() <= 12));
    }
}
