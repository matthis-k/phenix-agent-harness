use phenix_runtime_api::{
    BackendCapabilities, BackendHealth, DialogId, ExtensionUiRequest, RunId, RuntimeSnapshot,
    SessionId, TranscriptBlock,
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
    pub root_run: Option<RunId>,
    pub selected_run: Option<RunId>,
    pub input: InputState,
    pub transcripts: BTreeMap<RunId, TranscriptState>,
    pub dialogs: VecDeque<DialogState>,
    pub statuses: BTreeMap<String, String>,
    pub notifications: VecDeque<String>,
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
        self.capabilities = snapshot.capabilities.clone();
        self.snapshot = Some(snapshot);
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
            dialogs: VecDeque::new(),
            statuses: BTreeMap::new(),
            notifications: VecDeque::new(),
            should_quit: false,
        }
    }
}
