use crate::rich_document::render_markdown;
use crate::theme::{surface_style, theme_style};
use phenix_frontend_config::ThemeConfig;
use phenix_runtime_api::{TranscriptBlock, TranscriptRole};
use phenix_ui_core::{transcript_turn_id, AppState};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use std::ops::Range;

const DETAIL_PREFIX: &str = "  │ ";
const TURN_GAP_LINES: usize = 2;

#[derive(Debug)]
pub(crate) struct TranscriptDocument {
    pub lines: Vec<Line<'static>>,
    pub turn_ranges: Vec<Range<usize>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ConversationTurn {
    id: String,
    user: Option<String>,
    response: String,
    details: Vec<TurnDetail>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TurnDetail {
    kind: DetailKind,
    text: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DetailKind {
    Thinking,
    Tool,
    System,
}

impl DetailKind {
    const fn label(self) -> &'static str {
        match self {
            Self::Thinking => "Thinking",
            Self::Tool => "Tool",
            Self::System => "Notice",
        }
    }

    const fn theme_group(self) -> &'static str {
        match self {
            Self::Thinking => "Thinking",
            Self::Tool => "Tool",
            Self::System => "Muted",
        }
    }
}

pub(crate) fn transcript_document(
    state: &AppState,
    theme: &ThemeConfig,
    width: u16,
) -> TranscriptDocument {
    let mut turns = state
        .input_target()
        .and_then(|run_id| state.transcript(run_id))
        .map_or_else(Vec::new, |transcript| group_turns(&transcript.blocks));

    if !state.notifications.is_empty() {
        if turns.is_empty() {
            turns.push(ConversationTurn {
                id: "frontend-notifications".to_owned(),
                user: None,
                response: String::new(),
                details: Vec::new(),
            });
        }
        if let Some(turn) = turns.last_mut() {
            turn.details
                .extend(state.notifications.iter().map(|message| TurnDetail {
                    kind: DetailKind::System,
                    text: message.clone(),
                }));
        }
    }

    let selected = if turns.is_empty() {
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
    let mut turn_ranges = Vec::with_capacity(turns.len());
    for (index, turn) in turns.iter().enumerate() {
        if index > 0 {
            lines.extend((0..TURN_GAP_LINES).map(|_| Line::default()));
        }
        let start = lines.len();
        render_turn(
            &mut lines,
            turn,
            selected == Some(index) && state.view.focus == phenix_ui_core::FocusTarget::Transcript,
            state.view.transcript_turn_is_expanded(&turn.id),
            width,
            theme,
        );
        turn_ranges.push(start..lines.len());
    }

    TranscriptDocument { lines, turn_ranges }
}

fn group_turns(blocks: &[TranscriptBlock]) -> Vec<ConversationTurn> {
    let mut turns = Vec::new();
    for block in blocks {
        if matches!(block.role, TranscriptRole::User) {
            turns.push(ConversationTurn {
                id: transcript_turn_id(block),
                user: Some(block.text.clone()),
                response: String::new(),
                details: Vec::new(),
            });
            continue;
        }

        if turns.is_empty() {
            turns.push(ConversationTurn {
                id: transcript_turn_id(block),
                user: None,
                response: String::new(),
                details: Vec::new(),
            });
        }
        let turn = turns.last_mut().expect("turn inserted above");
        match block.role {
            TranscriptRole::Assistant => append_document_text(&mut turn.response, &block.text),
            TranscriptRole::Thinking => {
                push_detail(turn, DetailKind::Thinking, block.text.clone());
            }
            TranscriptRole::Tool => {
                push_detail(turn, DetailKind::Tool, block.text.clone());
            }
            TranscriptRole::System => {
                push_detail(turn, DetailKind::System, block.text.clone());
            }
            TranscriptRole::User => unreachable!("handled before current turn lookup"),
        }
    }
    turns
}

fn push_detail(turn: &mut ConversationTurn, kind: DetailKind, text: String) {
    if text.trim().is_empty() {
        return;
    }
    if let Some(last) = turn.details.last_mut() {
        if last.kind == kind {
            append_document_text(&mut last.text, &text);
            return;
        }
    }
    turn.details.push(TurnDetail { kind, text });
}

fn append_document_text(target: &mut String, source: &str) {
    if source.trim().is_empty() {
        return;
    }
    if !target.is_empty() && !target.ends_with('\n') && !source.starts_with('\n') {
        target.push_str("\n\n");
    }
    target.push_str(source);
}

fn render_turn(
    lines: &mut Vec<Line<'static>>,
    turn: &ConversationTurn,
    selected: bool,
    expanded: bool,
    width: u16,
    theme: &ThemeConfig,
) {
    if let Some(user) = &turn.user {
        lines.extend(user_message_lines(user, width, theme));
        lines.push(Line::default());
    }

    if !turn.response.trim().is_empty() {
        lines.extend(render_markdown(&turn.response, width, theme));
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
    turn: &ConversationTurn,
    selected: bool,
    expanded: bool,
    theme: &ThemeConfig,
) -> Line<'static> {
    let thinking = turn
        .details
        .iter()
        .filter(|detail| detail.kind == DetailKind::Thinking)
        .count();
    let tools = turn
        .details
        .iter()
        .filter(|detail| detail.kind == DetailKind::Tool)
        .count();
    let notices = turn
        .details
        .iter()
        .filter(|detail| detail.kind == DetailKind::System)
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

fn detail_lines(detail: &TurnDetail, width: u16, theme: &ThemeConfig) -> Vec<Line<'static>> {
    let group = detail.kind.theme_group();
    let mut lines = vec![Line::styled(
        format!("  {}", detail.kind.label()),
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
    use phenix_runtime_api::RunId;

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
    fn groups_acp_details_under_the_user_turn() {
        let turns = group_turns(&[
            block("u1", TranscriptRole::User, "hi"),
            block("t1", TranscriptRole::Thinking, "think"),
            block("a1", TranscriptRole::Assistant, "hello"),
            block("tool1", TranscriptRole::Tool, "read file"),
        ]);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].id, "run-1:u1");
        assert_eq!(turns[0].user.as_deref(), Some("hi"));
        assert_eq!(turns[0].response, "hello");
        assert_eq!(turns[0].details.len(), 2);
    }

    #[test]
    fn assistant_markdown_is_not_reinterpreted_as_backend_metadata() {
        let turns = group_turns(&[block(
            "a1",
            TranscriptRole::Assistant,
            "## Context\nThis is ordinary answer content.",
        )]);
        assert_eq!(turns.len(), 1);
        assert_eq!(
            turns[0].response,
            "## Context\nThis is ordinary answer content."
        );
        assert!(turns[0].details.is_empty());
    }

    #[test]
    fn user_message_is_one_full_width_surface_including_wraps() {
        let theme = ThemeConfig::default();
        let lines = user_message_lines("abcdefghijklmnopqrstuvwxyz", 16, &theme);
        assert!(lines.len() > 2);
        assert!(lines.iter().all(|line| line_text(line).chars().count() >= 16));
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
        let first_end = document.turn_ranges[0].end;
        let second_start = document.turn_ranges[1].start;
        assert!(second_start >= first_end + TURN_GAP_LINES);
    }

    #[test]
    fn collapsed_turn_reads_like_chat_content() {
        let turn = ConversationTurn {
            id: "run-1:u1".to_owned(),
            user: Some("hi".to_owned()),
            response: "Hello **there**.".to_owned(),
            details: vec![TurnDetail {
                kind: DetailKind::Thinking,
                text: "hidden".to_owned(),
            }],
        };
        let mut lines = Vec::new();
        render_turn(
            &mut lines,
            &turn,
            false,
            false,
            80,
            &ThemeConfig::default(),
        );
        let text = lines.iter().map(line_text).collect::<Vec<_>>();
        assert!(text.iter().any(|line| line.contains("hi")));
        assert!(text.iter().any(|line| line.contains("Hello there.")));
        assert!(text.iter().any(|line| line.contains("[Thinking]")));
        assert!(!text.iter().any(|line| line.contains("hidden")));
    }

    #[test]
    fn rich_markdown_table_is_rendered_inside_assistant_response() {
        let turn = ConversationTurn {
            id: "run-1:u1".to_owned(),
            user: Some("status?".to_owned()),
            response: "| Check | State |\n| --- | --- |\n| tests | green |".to_owned(),
            details: Vec::new(),
        };
        let mut lines = Vec::new();
        render_turn(
            &mut lines,
            &turn,
            false,
            false,
            60,
            &ThemeConfig::default(),
        );
        let text = lines.iter().map(line_text).collect::<Vec<_>>();
        assert!(text.iter().any(|line| line.contains("Check") && line.contains("State")));
        assert!(text.iter().any(|line| line.contains('┼')));
        assert!(text.iter().any(|line| line.contains("tests") && line.contains("green")));
    }

    #[test]
    fn expanded_details_keep_a_stable_hanging_indent_when_wrapped() {
        let detail = TurnDetail {
            kind: DetailKind::Thinking,
            text: "abcdefghijklmnopqrstuvwxyz".to_owned(),
        };
        let lines = detail_lines(&detail, 12, &ThemeConfig::default());
        let rendered = lines.iter().skip(1).map(line_text).collect::<Vec<_>>();
        assert!(rendered.len() > 1);
        assert!(rendered.iter().all(|line| line.starts_with(DETAIL_PREFIX)));
        assert!(rendered.iter().all(|line| line.chars().count() <= 12));
    }
}
