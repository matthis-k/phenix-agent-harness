use crate::state::transcript_turn_id;
use phenix_runtime_api::{TranscriptBlock, TranscriptRole};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TranscriptDetailKind {
    Thinking,
    Tool,
    System,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TranscriptTurnDetail {
    pub kind: TranscriptDetailKind,
    pub text: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TranscriptTurn {
    pub id: String,
    pub user: Option<String>,
    pub response: String,
    pub details: Vec<TranscriptTurnDetail>,
}

pub fn group_transcript_turns(blocks: &[TranscriptBlock]) -> Vec<TranscriptTurn> {
    let mut turns = Vec::new();
    for block in blocks {
        if matches!(block.role, TranscriptRole::User) {
            turns.push(TranscriptTurn {
                id: transcript_turn_id(block),
                user: Some(block.text.clone()),
                response: String::new(),
                details: Vec::new(),
            });
            continue;
        }

        if turns.is_empty() {
            turns.push(TranscriptTurn {
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
                push_detail(turn, TranscriptDetailKind::Thinking, block.text.clone())
            }
            TranscriptRole::Tool => {
                push_detail(turn, TranscriptDetailKind::Tool, block.text.clone())
            }
            TranscriptRole::System => {
                push_detail(turn, TranscriptDetailKind::System, block.text.clone())
            }
            TranscriptRole::User => unreachable!("handled before current turn lookup"),
        }
    }
    turns
}

fn push_detail(turn: &mut TranscriptTurn, kind: TranscriptDetailKind, text: String) {
    if text.trim().is_empty() {
        return;
    }
    if let Some(last) = turn.details.last_mut() {
        if last.kind == kind {
            append_document_text(&mut last.text, &text);
            return;
        }
    }
    turn.details.push(TranscriptTurnDetail { kind, text });
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
    fn user_blocks_start_turns_and_details_remain_attached() {
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
        assert_eq!(turns[0].details.len(), 2);
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
    }
}
