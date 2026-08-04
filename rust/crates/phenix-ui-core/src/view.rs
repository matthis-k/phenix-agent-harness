use phenix_runtime_api::{AuthFlowId, AuthPrompt, RunId};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum FocusTarget {
    Sidebar,
    Transcript,
    #[default]
    Input,
    Overlay,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum SidebarSection {
    #[default]
    Runs,
    Objectives,
    Sessions,
    Status,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OverlayState {
    CommandPalette {
        query: String,
        selected: usize,
    },
    ModelPicker {
        query: String,
        selected: usize,
    },
    AuthenticationProviders {
        query: String,
        selected: usize,
    },
    AuthenticationPrompt {
        flow_id: AuthFlowId,
        prompt: AuthPrompt,
        input: String,
        selected: usize,
    },
    SessionPicker {
        query: String,
        selected: usize,
    },
    Help,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TerminalSize {
    pub width: u16,
    pub height: u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ScrollState {
    pub offset: usize,
    pub follow_end: bool,
}

impl Default for ScrollState {
    fn default() -> Self {
        Self {
            offset: 0,
            follow_end: true,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ViewState {
    pub focus: FocusTarget,
    pub sidebar_section: SidebarSection,
    pub overlay: Option<OverlayState>,
    pub terminal: TerminalSize,
    pub selected_run: Option<RunId>,
    pub sidebar_index: usize,
    pub transcript_scroll: ScrollState,
    pub sidebar_scroll: ScrollState,
    pub show_details: bool,
}

impl Default for ViewState {
    fn default() -> Self {
        Self {
            focus: FocusTarget::Input,
            sidebar_section: SidebarSection::Runs,
            overlay: None,
            terminal: TerminalSize::default(),
            selected_run: None,
            sidebar_index: 0,
            transcript_scroll: ScrollState::default(),
            sidebar_scroll: ScrollState::default(),
            show_details: false,
        }
    }
}
