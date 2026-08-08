use crate::view::ViewState;
use phenix_runtime_api::{
    AuthFlowId, AuthNotice, AuthPrompt, AuthProviderSummary, BackendCapabilities, BackendHealth,
    CommandSummary, DialogId, ExtensionUiRequest, ModelSummary, RunId, RunSummary, RuntimeSnapshot,
    SessionId, ThinkingLevel, TranscriptBlock, TranscriptRole,
};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeConnectionState {
    Starting,
    Ready,
    Degraded(String),
    Failed(String),
    Stopped,
}

impl From<&BackendHealth> for RuntimeConnectionState {
    fn from(value: &BackendHealth) -> Self {
        match value {
            BackendHealth::Starting => Self::Starting,
            BackendHealth::Ready => Self::Ready,
            BackendHealth::Degraded { message } => Self::Degraded(message.clone()),
            BackendHealth::Failed { message } => Self::Failed(message.clone()),
            BackendHealth::Stopped => Self::Stopped,
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct InputState {
    pub text: String,
    pub cursor_byte: usize,
    pub history: VecDeque<String>,
    pub history_cursor: Option<usize>,
}

impl InputState {
    pub fn replace(&mut self, text: String) {
        self.cursor_byte = text.len();
        self.text = text;
        self.history_cursor = None;
    }

    pub fn insert(&mut self, text: &str) {
        self.normalize_cursor();
        self.text.insert_str(self.cursor_byte, text);
        self.cursor_byte += text.len();
        self.history_cursor = None;
    }

    pub fn move_left(&mut self) {
        self.normalize_cursor();
        self.cursor_byte = previous_char_start(&self.text, self.cursor_byte).unwrap_or(0);
    }

    pub fn move_right(&mut self) {
        self.normalize_cursor();
        if self.cursor_byte >= self.text.len() {
            return;
        }
        self.cursor_byte += self.text[self.cursor_byte..]
            .chars()
            .next()
            .map_or(0, char::len_utf8);
    }

    pub fn move_home(&mut self) {
        self.normalize_cursor();
        self.cursor_byte = self.line_start();
    }

    pub fn move_end(&mut self) {
        self.normalize_cursor();
        self.cursor_byte = self.line_end();
    }

    pub fn move_up(&mut self) {
        self.normalize_cursor();
        let current_start = self.line_start();
        if current_start == 0 {
            return;
        }
        let previous_end = current_start - 1;
        let previous_start = self.text[..previous_end]
            .rfind('\n')
            .map_or(0, |index| index + 1);
        let column = self.cursor_byte - current_start;
        self.cursor_byte = clamp_to_char_boundary(
            &self.text,
            previous_start + column.min(previous_end - previous_start),
        );
    }

    pub fn move_down(&mut self) {
        self.normalize_cursor();
        let current_end = self.line_end();
        if current_end >= self.text.len() {
            return;
        }
        let next_start = current_end + 1;
        let next_end = self.text[next_start..]
            .find('\n')
            .map_or(self.text.len(), |index| next_start + index);
        let column = self.cursor_byte - self.line_start();
        self.cursor_byte =
            clamp_to_char_boundary(&self.text, next_start + column.min(next_end - next_start));
    }

    pub fn move_word_forward(&mut self) {
        self.normalize_cursor();
        if self.cursor_byte >= self.text.len() {
            return;
        }
        let mut index = self.cursor_byte;
        let first = self.text[index..]
            .chars()
            .next()
            .expect("cursor before end");
        if first.is_whitespace() {
            index = skip_forward_while(&self.text, index, char::is_whitespace);
        } else {
            let class = character_class(first);
            index = skip_forward_while(&self.text, index, |character| {
                !character.is_whitespace() && character_class(character) == class
            });
            index = skip_forward_while(&self.text, index, char::is_whitespace);
        }
        self.cursor_byte = index;
    }

    pub fn move_word_backward(&mut self) {
        self.normalize_cursor();
        if self.cursor_byte == 0 {
            return;
        }
        let mut index = self.cursor_byte;
        while let Some(previous) = previous_char_start(&self.text, index) {
            let character = self.text[previous..index]
                .chars()
                .next()
                .expect("one character slice");
            if !character.is_whitespace() {
                break;
            }
            index = previous;
        }
        let Some(previous) = previous_char_start(&self.text, index) else {
            self.cursor_byte = 0;
            return;
        };
        let class = character_class(
            self.text[previous..index]
                .chars()
                .next()
                .expect("one character slice"),
        );
        index = previous;
        while let Some(candidate) = previous_char_start(&self.text, index) {
            let character = self.text[candidate..index]
                .chars()
                .next()
                .expect("one character slice");
            if character.is_whitespace() || character_class(character) != class {
                break;
            }
            index = candidate;
        }
        self.cursor_byte = index;
    }

    pub fn backspace(&mut self) {
        self.normalize_cursor();
        let Some(previous) = previous_char_start(&self.text, self.cursor_byte) else {
            return;
        };
        self.text.drain(previous..self.cursor_byte);
        self.cursor_byte = previous;
        self.history_cursor = None;
    }

    pub fn delete(&mut self) {
        self.normalize_cursor();
        if self.cursor_byte >= self.text.len() {
            return;
        }
        let width = self.text[self.cursor_byte..]
            .chars()
            .next()
            .map_or(0, char::len_utf8);
        self.text.drain(self.cursor_byte..self.cursor_byte + width);
        self.history_cursor = None;
    }

    pub fn delete_line(&mut self) {
        self.normalize_cursor();
        let start = self.line_start();
        let end = self.line_end();
        if end < self.text.len() {
            self.text.drain(start..=end);
            self.cursor_byte = start.min(self.text.len());
        } else if start > 0 {
            self.text.drain(start - 1..end);
            self.cursor_byte = start - 1;
        } else {
            self.text.clear();
            self.cursor_byte = 0;
        }
        self.history_cursor = None;
    }

    fn line_start(&self) -> usize {
        self.text[..self.cursor_byte]
            .rfind('\n')
            .map_or(0, |index| index + 1)
    }

    fn line_end(&self) -> usize {
        self.text[self.cursor_byte..]
            .find('\n')
            .map_or(self.text.len(), |index| self.cursor_byte + index)
    }

    fn normalize_cursor(&mut self) {
        self.cursor_byte =
            clamp_to_char_boundary(&self.text, self.cursor_byte.min(self.text.len()));
    }
}

fn previous_char_start(text: &str, index: usize) -> Option<usize> {
    if index == 0 {
        return None;
    }
    text[..index]
        .char_indices()
        .next_back()
        .map(|(index, _)| index)
}

fn clamp_to_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while !text.is_char_boundary(index) {
        index = index.saturating_sub(1);
    }
    index
}

fn skip_forward_while(text: &str, mut index: usize, predicate: impl Fn(char) -> bool) -> usize {
    while index < text.len() {
        let character = text[index..].chars().next().expect("cursor before end");
        if !predicate(character) {
            break;
        }
        index += character.len_utf8();
    }
    index
}

fn character_class(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

/// Stable view identity for a transcript turn. Backend-local block IDs may repeat
/// across independently configured runs, so the run ID is part of the key.
pub fn transcript_turn_id(block: &TranscriptBlock) -> String {
    format!("{}:{}", block.run_id, block.id)
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TranscriptState {
    pub blocks: Vec<TranscriptBlock>,
    pub block_index: BTreeMap<String, usize>,
    pub follow_end: bool,
}

impl TranscriptState {
    pub fn append(&mut self, block: TranscriptBlock) {
        if let Some(index) = self.block_index.get(&block.id).copied() {
            self.blocks[index] = block;
            return;
        }
        let index = self.blocks.len();
        self.block_index.insert(block.id.clone(), index);
        self.blocks.push(block);
    }

    pub fn update(&mut self, block: TranscriptBlock) {
        self.append(block);
    }

    /// Stable IDs for conversation turns. A user block always starts a new turn;
    /// pre-user backend output forms an initial synthetic turn instead of being
    /// merged into the first user message.
    pub fn turn_ids(&self) -> Vec<String> {
        let mut ids = Vec::new();
        for block in &self.blocks {
            if matches!(block.role, TranscriptRole::User) || ids.is_empty() {
                ids.push(transcript_turn_id(block));
            }
        }
        ids
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VisibleRun {
    pub id: RunId,
    pub depth: usize,
    pub has_children: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DialogState {
    pub id: DialogId,
    pub request: ExtensionUiRequest,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthFlowState {
    pub id: AuthFlowId,
    pub provider_id: Option<String>,
    pub prompt: Option<AuthPrompt>,
    pub notices: VecDeque<AuthNotice>,
}

impl AuthFlowState {
    pub fn new(id: AuthFlowId) -> Self {
        Self {
            id,
            provider_id: None,
            prompt: None,
            notices: VecDeque::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppState {
    pub connection: RuntimeConnectionState,
    pub capabilities: BackendCapabilities,
    pub snapshot: Option<RuntimeSnapshot>,
    pub active_session: Option<SessionId>,
    pub root_run: Option<RunId>,
    pub selected_run: Option<RunId>,
    pub input: InputState,
    pub transcripts: BTreeMap<RunId, TranscriptState>,
    pub models: Vec<ModelSummary>,
    pub thinking_levels: Vec<ThinkingLevel>,
    pub auth_providers: Vec<AuthProviderSummary>,
    pub auth_flows: BTreeMap<AuthFlowId, AuthFlowState>,
    pub commands: Vec<CommandSummary>,
    pub dialogs: VecDeque<DialogState>,
    pub statuses: BTreeMap<String, String>,
    pub notifications: VecDeque<String>,
    pub view: ViewState,
    pub exit_requested: bool,
    pub should_quit: bool,
}

impl AppState {
    pub fn input_target(&self) -> Option<&RunId> {
        self.selected_run.as_ref().or(self.root_run.as_ref())
    }

    pub fn transcript(&self, run_id: &RunId) -> Option<&TranscriptState> {
        self.transcripts.get(run_id)
    }

    pub fn transcript_mut(&mut self, run_id: RunId) -> &mut TranscriptState {
        self.transcripts
            .entry(run_id)
            .or_insert_with(|| TranscriptState {
                follow_end: true,
                ..TranscriptState::default()
            })
    }

    pub fn active_transcript_turn_ids(&self) -> Vec<String> {
        self.input_target()
            .and_then(|run_id| self.transcript(run_id))
            .map_or_else(Vec::new, TranscriptState::turn_ids)
    }

    pub fn visible_runs(&self) -> Vec<VisibleRun> {
        let Some(snapshot) = &self.snapshot else {
            return Vec::new();
        };
        project_visible_runs(&snapshot.runs, &self.view.collapsed_runs)
    }

    pub fn sidebar_cursor_run_id(&self) -> Option<RunId> {
        let visible = self.visible_runs();
        visible
            .get(self.view.sidebar_index.min(visible.len().saturating_sub(1)))
            .map(|entry| entry.id.clone())
    }

    pub fn run(&self, run_id: &RunId) -> Option<&RunSummary> {
        self.snapshot
            .as_ref()?
            .runs
            .iter()
            .find(|run| &run.id == run_id)
    }

    pub fn first_run_child(&self, run_id: &RunId) -> Option<RunId> {
        self.snapshot
            .as_ref()?
            .runs
            .iter()
            .find_map(|run| (run.parent.as_ref() == Some(run_id)).then(|| run.id.clone()))
    }

    pub fn run_parent(&self, run_id: &RunId) -> Option<RunId> {
        self.run(run_id)?.parent.clone()
    }

    pub fn visible_run_neighbor(&self, run_id: &RunId, delta: i32) -> Option<RunId> {
        let visible = self.visible_runs();
        let current = visible.iter().position(|entry| &entry.id == run_id)?;
        let next = current
            .saturating_add_signed(delta as isize)
            .min(visible.len().saturating_sub(1));
        visible.get(next).map(|entry| entry.id.clone())
    }

    pub fn apply_snapshot(&mut self, snapshot: RuntimeSnapshot) {
        self.connection = RuntimeConnectionState::from(&snapshot.health);
        self.active_session = snapshot.active_session.clone();
        self.root_run = snapshot.root_run.clone();
        self.selected_run = snapshot
            .selected_run
            .clone()
            .or_else(|| snapshot.root_run.clone());
        self.view.selected_run = self.selected_run.clone();
        self.capabilities = snapshot.capabilities.clone();
        self.snapshot = Some(snapshot);

        let visible = self.visible_runs();
        if let Some(selected) = self.selected_run.as_ref() {
            if let Some(index) = visible.iter().position(|entry| &entry.id == selected) {
                self.view.sidebar_index = index;
            } else {
                self.view.sidebar_index =
                    self.view.sidebar_index.min(visible.len().saturating_sub(1));
            }
        } else {
            self.view.sidebar_index = self.view.sidebar_index.min(visible.len().saturating_sub(1));
        }
    }

    pub fn auth_flow_mut(&mut self, flow_id: AuthFlowId) -> &mut AuthFlowState {
        self.auth_flows
            .entry(flow_id.clone())
            .or_insert_with(|| AuthFlowState::new(flow_id))
    }
}

fn project_visible_runs(runs: &[RunSummary], collapsed: &BTreeSet<RunId>) -> Vec<VisibleRun> {
    let known = runs
        .iter()
        .map(|run| run.id.clone())
        .collect::<BTreeSet<_>>();
    let mut children = BTreeMap::<Option<RunId>, Vec<&RunSummary>>::new();
    for run in runs {
        let parent = run.parent.clone().filter(|parent| known.contains(parent));
        children.entry(parent).or_default().push(run);
    }

    let mut visible = Vec::new();
    let mut visited = BTreeSet::new();
    if let Some(roots) = children.get(&None) {
        for root in roots {
            append_visible_run(root, 0, &children, collapsed, &mut visited, &mut visible);
        }
    }

    // Invalid/cyclic backend projections must not make runs disappear from the
    // frontend. Any unvisited node is surfaced as an additional root; the visited
    // set prevents a malformed cycle from recursing indefinitely.
    for run in runs {
        if !visited.contains(&run.id) {
            append_visible_run(run, 0, &children, collapsed, &mut visited, &mut visible);
        }
    }
    visible
}

fn append_visible_run(
    run: &RunSummary,
    depth: usize,
    children: &BTreeMap<Option<RunId>, Vec<&RunSummary>>,
    collapsed: &BTreeSet<RunId>,
    visited: &mut BTreeSet<RunId>,
    visible: &mut Vec<VisibleRun>,
) {
    if !visited.insert(run.id.clone()) {
        return;
    }
    let descendants = children.get(&Some(run.id.clone()));
    let has_children = descendants.is_some_and(|children| !children.is_empty());
    visible.push(VisibleRun {
        id: run.id.clone(),
        depth,
        has_children,
    });
    if collapsed.contains(&run.id) {
        return;
    }
    if let Some(descendants) = descendants {
        for child in descendants {
            append_visible_run(
                child,
                depth.saturating_add(1),
                children,
                collapsed,
                visited,
                visible,
            );
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        let mut statuses = BTreeMap::new();
        statuses.insert(
            "frontend.editor".to_owned(),
            "editor: owned · insert".to_owned(),
        );
        Self {
            connection: RuntimeConnectionState::Starting,
            capabilities: BackendCapabilities::default(),
            snapshot: None,
            active_session: None,
            root_run: None,
            selected_run: None,
            input: InputState::default(),
            transcripts: BTreeMap::new(),
            models: Vec::new(),
            thinking_levels: Vec::new(),
            auth_providers: Vec::new(),
            auth_flows: BTreeMap::new(),
            commands: Vec::new(),
            dialogs: VecDeque::new(),
            statuses,
            notifications: VecDeque::new(),
            view: ViewState::default(),
            exit_requested: false,
            should_quit: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_runtime_api::{RunKind, RunState};

    fn run(id: &str, parent: Option<&str>) -> RunSummary {
        RunSummary {
            id: RunId::parse(id).expect("run id"),
            parent: parent.map(|parent| RunId::parse(parent).expect("parent id")),
            kind: RunKind::Agent,
            definition_id: id.to_owned(),
            display_name: id.to_owned(),
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

    #[test]
    fn editor_operations_preserve_utf8_boundaries() {
        let mut input = InputState::default();
        input.insert("größer");
        input.move_left();
        input.backspace();
        assert_eq!(input.text, "größr");
        assert!(input.text.is_char_boundary(input.cursor_byte));
        input.delete();
        assert_eq!(input.text, "größ");
    }

    #[test]
    fn multiline_navigation_preserves_the_nearest_valid_column() {
        let mut input = InputState::default();
        input.replace("alpha\nβ\ngamma".to_owned());
        input.move_home();
        input.move_up();
        assert_eq!(&input.text[input.cursor_byte..], "β\ngamma");
        input.move_up();
        assert_eq!(input.cursor_byte, 0);
        input.move_down();
        assert_eq!(&input.text[input.cursor_byte..], "β\ngamma");
    }

    #[test]
    fn word_and_line_commands_are_deterministic() {
        let mut input = InputState::default();
        input.replace("one two\nthree".to_owned());
        input.move_word_backward();
        assert_eq!(input.cursor_byte, 8);
        input.delete_line();
        assert_eq!(input.text, "one two");
        assert_eq!(input.cursor_byte, 7);
    }

    #[test]
    fn user_blocks_define_stable_transcript_turns() {
        let run_id = RunId::parse("run-1").expect("run id");
        let mut transcript = TranscriptState::default();
        for (id, role, text) in [
            ("u1", TranscriptRole::User, "one"),
            ("a1", TranscriptRole::Assistant, "answer one"),
            ("t1", TranscriptRole::Thinking, "thought"),
            ("u2", TranscriptRole::User, "two"),
            ("a2", TranscriptRole::Assistant, "answer two"),
        ] {
            transcript.append(TranscriptBlock {
                id: id.to_owned(),
                run_id: run_id.clone(),
                role,
                text: text.to_owned(),
                complete: true,
            });
        }
        assert_eq!(transcript.turn_ids(), vec!["run-1:u1", "run-1:u2"]);
    }

    #[test]
    fn run_projection_is_hierarchical_and_respects_collapsed_nodes() {
        let mut state = AppState {
            snapshot: Some(RuntimeSnapshot {
                capabilities: BackendCapabilities::default(),
                health: BackendHealth::Ready,
                active_session: None,
                root_run: Some(RunId::parse("root").expect("root")),
                selected_run: Some(RunId::parse("root").expect("root")),
                sessions: Vec::new(),
                runs: vec![
                    run("root", None),
                    run("child-a", Some("root")),
                    run("grandchild", Some("child-a")),
                    run("child-b", Some("root")),
                ],
                objectives: Vec::new(),
            }),
            ..AppState::default()
        };
        assert_eq!(
            state
                .visible_runs()
                .into_iter()
                .map(|entry| (entry.id.to_string(), entry.depth))
                .collect::<Vec<_>>(),
            vec![
                ("root".to_owned(), 0),
                ("child-a".to_owned(), 1),
                ("grandchild".to_owned(), 2),
                ("child-b".to_owned(), 1),
            ]
        );
        state
            .view
            .set_run_collapsed(RunId::parse("child-a").expect("child"), true);
        assert_eq!(
            state
                .visible_runs()
                .into_iter()
                .map(|entry| entry.id.to_string())
                .collect::<Vec<_>>(),
            vec!["root", "child-a", "child-b"]
        );
    }

    #[test]
    fn turn_identity_is_namespaced_by_run() {
        let first = TranscriptBlock {
            id: "u1".to_owned(),
            run_id: RunId::parse("run-a").expect("run id"),
            role: TranscriptRole::User,
            text: String::new(),
            complete: true,
        };
        let second = TranscriptBlock {
            run_id: RunId::parse("run-b").expect("run id"),
            ..first.clone()
        };
        assert_ne!(transcript_turn_id(&first), transcript_turn_id(&second));
    }
}
