use crate::theme::theme_style;
use phenix_frontend_config::ThemeConfig;
use phenix_runtime_api::{TranscriptBlock, TranscriptRole};
use phenix_ui_core::{transcript_turn_id, AppState};
use ratatui::style::Modifier;
use ratatui::text::{Line, Span};
use std::ops::Range;

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

pub(crate) fn transcript_document(state: &AppState, theme: &ThemeConfig) -> TranscriptDocument {
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
        let start = lines.len();
        render_turn(
            &mut lines,
            turn,
            selected == Some(index) && state.view.focus == phenix_ui_core::FocusTarget::Transcript,
            state.view.transcript_turn_is_expanded(&turn.id),
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
    theme: &ThemeConfig,
) {
    if let Some(user) = &turn.user {
        lines.push(Line::styled(
            "You",
            theme_style(theme, "Accent").add_modifier(Modifier::BOLD),
        ));
        if user.is_empty() {
            lines.push(Line::styled("  ", theme_style(theme, "Surface")));
        } else {
            lines.extend(user.lines().map(|line| {
                Line::from(vec![
                    Span::styled("▌", theme_style(theme, "Accent")),
                    Span::styled(format!(" {line} "), theme_style(theme, "Surface")),
                ])
            }));
        }
        lines.push(Line::default());
    }

    if !turn.response.trim().is_empty() {
        lines.extend(markdown_document_lines(&turn.response, theme));
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
                lines.extend(detail_lines(detail, theme));
            }
        }
    }

    if lines.last().is_some_and(|line| !line.spans.is_empty()) {
        lines.push(Line::default());
    }
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

fn detail_lines(detail: &TurnDetail, theme: &ThemeConfig) -> Vec<Line<'static>> {
    let group = detail.kind.theme_group();
    let mut lines = vec![Line::styled(
        format!("  {}", detail.kind.label()),
        theme_style(theme, group).add_modifier(Modifier::BOLD),
    )];
    lines.extend(detail.text.lines().map(|line| {
        Line::from(vec![
            Span::styled("  │ ", theme_style(theme, group)),
            Span::styled(line.to_owned(), theme_style(theme, "Muted")),
        ])
    }));
    lines
}

fn markdown_document_lines(text: &str, theme: &ThemeConfig) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let mut in_code_block = false;

    for raw in text.lines() {
        let trimmed = raw.trim_start();
        if let Some(fence) = trimmed.strip_prefix("```") {
            if in_code_block {
                in_code_block = false;
                lines.push(Line::default());
            } else {
                in_code_block = true;
                let language = fence.trim();
                if !language.is_empty() {
                    lines.push(Line::styled(
                        format!("  {language}"),
                        theme_style(theme, "Muted"),
                    ));
                }
            }
            continue;
        }

        if in_code_block {
            lines.push(Line::from(vec![
                Span::styled("  │ ", theme_style(theme, "Muted")),
                Span::styled(raw.to_owned(), theme_style(theme, "Surface")),
            ]));
            continue;
        }

        if trimmed.is_empty() {
            lines.push(Line::default());
            continue;
        }

        if is_markdown_rule(trimmed) {
            lines.push(Line::styled(
                "────────────────────────────────",
                theme_style(theme, "Border"),
            ));
            continue;
        }

        if let Some((level, heading)) = markdown_heading(trimmed) {
            let group = if level <= 2 { "Accent" } else { "Normal" };
            lines.push(Line::styled(
                heading.to_owned(),
                theme_style(theme, group).add_modifier(Modifier::BOLD),
            ));
            continue;
        }

        if let Some(item) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            let mut spans = vec![Span::styled("• ", theme_style(theme, "Accent"))];
            spans.extend(inline_markdown_spans(item, theme));
            lines.push(Line::from(spans));
            continue;
        }

        if let Some((marker, item)) = ordered_list_item(trimmed) {
            let mut spans = vec![Span::styled(
                format!("{marker} "),
                theme_style(theme, "Accent"),
            )];
            spans.extend(inline_markdown_spans(item, theme));
            lines.push(Line::from(spans));
            continue;
        }

        if let Some(quote) = trimmed.strip_prefix("> ") {
            lines.push(Line::from(vec![
                Span::styled("│ ", theme_style(theme, "Muted")),
                Span::styled(
                    quote.to_owned(),
                    theme_style(theme, "Muted").add_modifier(Modifier::ITALIC),
                ),
            ]));
            continue;
        }

        lines.push(Line::from(inline_markdown_spans(raw, theme)));
    }

    lines
}

fn markdown_heading(line: &str) -> Option<(usize, &str)> {
    let level = line.chars().take_while(|character| *character == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let heading = line.get(level..)?.strip_prefix(' ')?;
    Some((level, heading.trim()))
}

fn ordered_list_item(line: &str) -> Option<(&str, &str)> {
    let (marker, item) = line.split_once(' ')?;
    let digits = marker.strip_suffix('.')?;
    if digits.is_empty() || !digits.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    Some((marker, item))
}

fn is_markdown_rule(line: &str) -> bool {
    let compact = line
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    let Some(marker) = compact.chars().next() else {
        return false;
    };
    compact.len() >= 3
        && matches!(marker, '-' | '*' | '_')
        && compact.chars().all(|character| character == marker)
}

fn inline_markdown_spans(text: &str, theme: &ThemeConfig) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        let bold = remaining.find("**");
        let code = remaining.find('`');
        let next = match (bold, code) {
            (Some(bold), Some(code)) => bold.min(code),
            (Some(bold), None) => bold,
            (None, Some(code)) => code,
            (None, None) => {
                spans.push(Span::styled(
                    remaining.to_owned(),
                    theme_style(theme, "Normal"),
                ));
                break;
            }
        };

        if next > 0 {
            spans.push(Span::styled(
                remaining[..next].to_owned(),
                theme_style(theme, "Normal"),
            ));
            remaining = &remaining[next..];
            continue;
        }

        if let Some(after_open) = remaining.strip_prefix("**") {
            if let Some(end) = after_open.find("**") {
                spans.push(Span::styled(
                    after_open[..end].to_owned(),
                    theme_style(theme, "Normal").add_modifier(Modifier::BOLD),
                ));
                remaining = &after_open[end + 2..];
            } else {
                spans.push(Span::styled("**", theme_style(theme, "Normal")));
                remaining = after_open;
            }
            continue;
        }

        if let Some(after_open) = remaining.strip_prefix('`') {
            if let Some(end) = after_open.find('`') {
                spans.push(Span::styled(
                    after_open[..end].to_owned(),
                    theme_style(theme, "Surface"),
                ));
                remaining = &after_open[end + 1..];
            } else {
                spans.push(Span::styled("`", theme_style(theme, "Normal")));
                remaining = after_open;
            }
        }
    }

    spans
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
        render_turn(&mut lines, &turn, false, false, &ThemeConfig::default());
        let text = lines.iter().map(line_text).collect::<Vec<_>>();
        assert!(text.iter().any(|line| line.contains("hi")));
        assert!(text.iter().any(|line| line == "Hello there."));
        assert!(text.iter().any(|line| line.contains("[Thinking]")));
        assert!(!text.iter().any(|line| line.contains("hidden")));
    }
}
