use crate::rich_text::RichBlockView;
use crate::routing::ElementId;
use phenix_runtime_api::{AuthFlowId, AuthPrompt, DialogId, ExtensionUiRequest, RunId};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum FocusTarget {
    Sidebar,
    Transcript,
    #[default]
    Input,
    Overlay,
}

impl FocusTarget {
    pub fn element_id(self) -> ElementId {
        match self {
            Self::Sidebar => ElementId::sidebar(),
            Self::Transcript => ElementId::transcript(),
            Self::Input => ElementId::input(),
            Self::Overlay => ElementId::overlay(),
        }
    }

    pub fn from_element(element: &ElementId) -> Option<Self> {
        match element.as_str() {
            "ui.sidebar" => Some(Self::Sidebar),
            "ui.transcript" => Some(Self::Transcript),
            "ui.input" => Some(Self::Input),
            "ui.overlay" => Some(Self::Overlay),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum InputEditor {
    #[default]
    Owned,
    Embedded,
    External,
}

impl InputEditor {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Owned => "owned",
            Self::Embedded => "embedded",
            Self::External => "external",
        }
    }

    pub const fn next(self) -> Self {
        match self {
            Self::Owned => Self::Embedded,
            Self::Embedded => Self::External,
            Self::External => Self::Owned,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum VimMode {
    Normal,
    #[default]
    Insert,
}

impl VimMode {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Insert => "insert",
        }
    }
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
    ExtensionDialog {
        dialog_id: DialogId,
        request: ExtensionUiRequest,
        input: String,
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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RichBlockViewport {
    pub horizontal: usize,
    pub vertical: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PaneViewState {
    pub visible: bool,
    pub width: Option<u16>,
    pub height: Option<u16>,
}

impl Default for PaneViewState {
    fn default() -> Self {
        Self {
            visible: true,
            width: None,
            height: None,
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
    pub collapsed_runs: BTreeSet<RunId>,
    pub transcript_scroll: ScrollState,
    pub sidebar_scroll: ScrollState,
    pub transcript_selected_turn: Option<usize>,
    pub transcript_selected_block: Option<usize>,
    pub expanded_transcript_turns: BTreeSet<String>,
    pub rich_block_views: BTreeMap<String, RichBlockView>,
    pub rich_block_viewports: BTreeMap<String, RichBlockViewport>,
    pub show_details: bool,
    pub input_editor: InputEditor,
    pub vim_mode: VimMode,
    pub panes: BTreeMap<ElementId, PaneViewState>,
}

impl ViewState {
    pub fn pane(&self, element: &ElementId) -> PaneViewState {
        self.panes.get(element).copied().unwrap_or_default()
    }

    pub fn pane_mut(&mut self, element: ElementId) -> &mut PaneViewState {
        self.panes.entry(element).or_default()
    }

    pub fn run_is_collapsed(&self, run_id: &RunId) -> bool {
        self.collapsed_runs.contains(run_id)
    }

    pub fn set_run_collapsed(&mut self, run_id: RunId, collapsed: bool) {
        if collapsed {
            self.collapsed_runs.insert(run_id);
        } else {
            self.collapsed_runs.remove(&run_id);
        }
    }

    pub fn toggle_run_collapsed(&mut self, run_id: RunId) {
        if !self.collapsed_runs.remove(&run_id) {
            self.collapsed_runs.insert(run_id);
        }
    }

    pub fn transcript_turn_is_expanded(&self, id: &str) -> bool {
        self.expanded_transcript_turns.contains(id)
    }

    pub fn toggle_transcript_turn(&mut self, id: String) {
        if !self.expanded_transcript_turns.remove(&id) {
            self.expanded_transcript_turns.insert(id);
        }
    }

    pub fn rich_block_view(&self, id: &str) -> Option<RichBlockView> {
        self.rich_block_views.get(id).copied()
    }

    pub fn set_rich_block_view(&mut self, id: String, view: RichBlockView) {
        self.rich_block_views.insert(id, view);
    }

    pub fn rich_block_viewport(&self, id: &str) -> RichBlockViewport {
        self.rich_block_viewports
            .get(id)
            .copied()
            .unwrap_or_default()
    }

    pub fn rich_block_viewport_mut(&mut self, id: String) -> &mut RichBlockViewport {
        self.rich_block_viewports.entry(id).or_default()
    }

    pub fn set_input_editor(&mut self, editor: InputEditor) {
        self.input_editor = editor;
        self.vim_mode = match editor {
            InputEditor::Owned => VimMode::Insert,
            InputEditor::Embedded | InputEditor::External => VimMode::Normal,
        };
        let input_height = match editor {
            InputEditor::Embedded => self.terminal.height.saturating_div(3).clamp(8, 16),
            InputEditor::Owned | InputEditor::External => 5,
        };
        self.pane_mut(ElementId::input()).height = Some(input_height);
    }
}

impl Default for ViewState {
    fn default() -> Self {
        let mut panes = BTreeMap::new();
        panes.insert(
            ElementId::header(),
            PaneViewState {
                visible: false,
                height: Some(1),
                ..PaneViewState::default()
            },
        );
        panes.insert(
            ElementId::inspector(),
            PaneViewState {
                visible: false,
                width: Some(22),
                ..PaneViewState::default()
            },
        );
        panes.insert(ElementId::transcript(), PaneViewState::default());
        panes.insert(
            ElementId::sidebar(),
            PaneViewState {
                width: Some(28),
                ..PaneViewState::default()
            },
        );
        panes.insert(
            ElementId::specialized(),
            PaneViewState {
                visible: false,
                ..PaneViewState::default()
            },
        );
        panes.insert(
            ElementId::input(),
            PaneViewState {
                height: Some(5),
                ..PaneViewState::default()
            },
        );
        panes.insert(
            ElementId::status(),
            PaneViewState {
                height: Some(1),
                ..PaneViewState::default()
            },
        );
        Self {
            focus: FocusTarget::Input,
            sidebar_section: SidebarSection::Runs,
            overlay: None,
            terminal: TerminalSize::default(),
            selected_run: None,
            sidebar_index: 0,
            collapsed_runs: BTreeSet::new(),
            transcript_scroll: ScrollState::default(),
            sidebar_scroll: ScrollState::default(),
            transcript_selected_turn: None,
            transcript_selected_block: None,
            expanded_transcript_turns: BTreeSet::new(),
            rich_block_views: BTreeMap::new(),
            rich_block_viewports: BTreeMap::new(),
            show_details: false,
            input_editor: InputEditor::Owned,
            vim_mode: VimMode::Insert,
            panes,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_tree_collapse_state_is_local_frontend_state() {
        let run_id = RunId::parse("run-child").expect("run id");
        let mut view = ViewState::default();
        assert!(!view.run_is_collapsed(&run_id));
        view.toggle_run_collapsed(run_id.clone());
        assert!(view.run_is_collapsed(&run_id));
        view.set_run_collapsed(run_id.clone(), false);
        assert!(!view.run_is_collapsed(&run_id));
    }

    #[test]
    fn transcript_turn_expansion_is_independent_per_turn() {
        let mut view = ViewState::default();
        view.toggle_transcript_turn("turn-a".to_owned());
        assert!(view.transcript_turn_is_expanded("turn-a"));
        assert!(!view.transcript_turn_is_expanded("turn-b"));
        view.toggle_transcript_turn("turn-a".to_owned());
        assert!(!view.transcript_turn_is_expanded("turn-a"));
    }

    #[test]
    fn rich_block_presentation_is_independent_per_instance() {
        let mut view = ViewState::default();
        view.set_rich_block_view("turn-a:block:0".to_owned(), RichBlockView::Grid);
        view.rich_block_viewport_mut("turn-a:block:0".to_owned())
            .horizontal = 4;
        assert_eq!(
            view.rich_block_view("turn-a:block:0"),
            Some(RichBlockView::Grid)
        );
        assert_eq!(view.rich_block_viewport("turn-a:block:0").horizontal, 4);
        assert_eq!(view.rich_block_view("turn-b:block:0"), None);
    }

    #[test]
    fn default_workspace_exposes_conversation_and_operations_only() {
        let view = ViewState::default();
        assert!(view.pane(&ElementId::transcript()).visible);
        assert!(view.pane(&ElementId::input()).visible);
        assert!(view.pane(&ElementId::status()).visible);
        assert!(view.pane(&ElementId::sidebar()).visible);
        assert!(!view.pane(&ElementId::inspector()).visible);
        assert!(!view.pane(&ElementId::specialized()).visible);
        assert!(!view.pane(&ElementId::header()).visible);
    }
}
