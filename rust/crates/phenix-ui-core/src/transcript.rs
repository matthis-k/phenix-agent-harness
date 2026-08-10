use crate::state::transcript_turn_id;
use phenix_runtime_api::{TranscriptBlock, TranscriptRole};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TranscriptTurnItemKind {
    Assistant,
    Thinking,
    Tool,
    System,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TranscriptTurnItem {
    pub kind: TranscriptTurnItemKind,
    pub text: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TranscriptTurn {
    pub id: String,
    pub user: Option<String>,
    /// Assistant-only projection retained for rich-block navigation. `items` is
    /// the canonical chronological representation used for transcript rendering.
    pub response: String,
    pub items: Vec<TranscriptTurnItem>,
}

pub fn group_transcript_turns(blocks: &[TranscriptBlock]) -> Vec<TranscriptTurn> {
    let mut turns = Vec::new();
    for block in blocks {
        if matches!(block.role, TranscriptRole::User) {
            turns.push(TranscriptTurn {
                id: transcript_turn_id(block),
                user: Some(block.text.clone()),
                response: String::new(),
                items: Vec::new(),
            });
            continue;
        }

        if turns.is_empty() {
            turns.push(TranscriptTurn {
                id: transcript_turn_id(block),
                user: None,
                response: String::new(),
                items: Vec::new(),
            });
        }
        let turn = turns.last_mut().expect("turn inserted above");
        let kind = match block.role {
            TranscriptRole::Assistant => {
                append_document_text(&mut turn.response, &block.text);
                TranscriptTurnItemKind::Assistant
            }
            TranscriptRole::Thinking => TranscriptTurnItemKind::Thinking,
            TranscriptRole::Tool => TranscriptTurnItemKind::Tool,
            TranscriptRole::System => TranscriptTurnItemKind::System,
            TranscriptRole::User => unreachable!("handled before current turn lookup"),
        };
        push_item(turn, kind, block.text.clone());
    }
    turns
}

fn push_item(turn: &mut TranscriptTurn, kind: TranscriptTurnItemKind, text: String) {
    if text.trim().is_empty() {
        return;
    }
    if let Some(last) = turn.items.last_mut() {
        if last.kind == kind {
            append_document_text(&mut last.text, &text);
            return;
        }
    }
    turn.items.push(TranscriptTurnItem { kind, text });
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

    #[test]
    fn user_blocks_start_turns_and_items_remain_attached_in_order() {
        let turns = group_transcript_turns(&[
            block("u1", TranscriptRole::User, "one"),
            block("t1", TranscriptRole::Thinking, "thinking"),
            block("a1", TranscriptRole::Assistant, "answer"),
            block("tool", TranscriptRole::Tool, "tool"),
            block("u2", TranscriptRole::User, "two"),
            block("a2", TranscriptRole::Assistant, "second"),
        ]);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].id, "run-1:u1");
        assert_eq!(turns[0].response, "answer");
        assert_eq!(
            turns[0]
                .items
                .iter()
                .map(|item| item.kind)
                .collect::<Vec<_>>(),
            vec![
                TranscriptTurnItemKind::Thinking,
                TranscriptTurnItemKind::Assistant,
                TranscriptTurnItemKind::Tool,
            ]
        );
        assert_eq!(turns[1].user.as_deref(), Some("two"));
    }

    #[test]
    fn adjacent_assistant_chunks_preserve_document_boundaries() {
        let turns = group_transcript_turns(&[
            block("u1", TranscriptRole::User, "one"),
            block("a1", TranscriptRole::Assistant, "first"),
            block("a2", TranscriptRole::Assistant, "second"),
        ]);
        assert_eq!(turns[0].response, "first\n\nsecond");
        assert_eq!(turns[0].items.len(), 1);
        assert_eq!(turns[0].items[0].kind, TranscriptTurnItemKind::Assistant);
        assert_eq!(turns[0].items[0].text, "first\n\nsecond");
    }

    #[test]
    fn non_adjacent_kinds_never_reorder_or_recombine() {
        let turns = group_transcript_turns(&[
            block("u1", TranscriptRole::User, "one"),
            block("t1", TranscriptRole::Thinking, "before tool"),
            block("tool", TranscriptRole::Tool, "read"),
            block("t2", TranscriptRole::Thinking, "after tool"),
            block("a1", TranscriptRole::Assistant, "answer"),
        ]);
        let items = &turns[0].items;
        assert_eq!(items.len(), 4);
        assert_eq!(items[0].text, "before tool");
        assert_eq!(items[0].kind, TranscriptTurnItemKind::Thinking);
        assert_eq!(items[1].kind, TranscriptTurnItemKind::Tool);
        assert_eq!(items[2].text, "after tool");
        assert_eq!(items[2].kind, TranscriptTurnItemKind::Thinking);
        assert_eq!(items[3].kind, TranscriptTurnItemKind::Assistant);
    }
}
