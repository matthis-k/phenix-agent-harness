use crate::view::ViewState;
use phenix_runtime_api::{
    AuthFlowId, AuthNotice, AuthPrompt, AuthProviderSummary, BackendCapabilities, BackendHealth,
    CommandSummary, DialogId, ExtensionUiRequest, ModelSummary, RunId, RuntimeSnapshot, SessionId,
    ThinkingLevel, TranscriptBlock,
};
use std::collections::{BTreeMap, VecDeque};

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
        self.cursor_byte = self.cursor_byte.min(self.text.len());
        while !self.text.is_char_boundary(self.cursor_byte) {
            self.cursor_byte = self.cursor_byte.saturating_sub(1);
        }
        self.text.insert_str(self.cursor_byte, text);
        self.cursor_byte += text.len();
        self.history_cursor = None;
    }

    pub fn move_left(&mut self) {
        if self.cursor_byte == 0 {
            return;
        }
        self.cursor_byte = self.text[..self.cursor_byte]
            .char_indices()
            .next_back()
            .map_or(0, |(index, _)| index);
    }

    pub fn move_right(&mut self) {
        if self.cursor_byte >= self.text.len() {
            return;
        }
        let width = self.text[self.cursor_byte..]
            .chars()
            .next()
            .map_or(0, char::len_utf8);
        self.cursor_byte += width;
    }

    pub fn backspace(&mut self) {
        if self.cursor_byte == 0 {
            return;
        }
        let previous = self.text[..self.cursor_byte]
            .char_indices()
            .next_back()
            .map_or(0, |(index, _)| index);
        self.text.drain(previous..self.cursor_byte);
        self.cursor_byte = previous;
        self.history_cursor = None;
    }

    pub fn delete(&mut self) {
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
    }

    pub fn auth_flow_mut(&mut self, flow_id: AuthFlowId) -> &mut AuthFlowState {
        self.auth_flows
            .entry(flow_id.clone())
            .or_insert_with(|| AuthFlowState::new(flow_id))
    }
}

impl Default for AppState {
    fn default() -> Self {
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
            statuses: BTreeMap::new(),
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
}
