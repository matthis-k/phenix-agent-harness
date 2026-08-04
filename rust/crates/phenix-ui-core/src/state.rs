use phenix_runtime_api::{
    BackendCapabilities, BackendHealth, DialogId, ExtensionUiRequest, RuntimeSnapshot, SessionId,
    TranscriptBlock,
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
pub struct AppState {
    pub connection: RuntimeConnectionState,
    pub capabilities: BackendCapabilities,
    pub snapshot: Option<RuntimeSnapshot>,
    pub active_session: Option<SessionId>,
    pub input: InputState,
    pub transcript: TranscriptState,
    pub dialogs: VecDeque<DialogState>,
    pub statuses: BTreeMap<String, String>,
    pub notifications: VecDeque<String>,
    pub should_quit: bool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            connection: RuntimeConnectionState::Starting,
            capabilities: BackendCapabilities::default(),
            snapshot: None,
            active_session: None,
            input: InputState::default(),
            transcript: TranscriptState {
                follow_end: true,
                ..TranscriptState::default()
            },
            dialogs: VecDeque::new(),
            statuses: BTreeMap::new(),
            notifications: VecDeque::new(),
            should_quit: false,
        }
    }
}
