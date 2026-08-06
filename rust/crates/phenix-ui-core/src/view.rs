use crate::routing::ElementId;
use phenix_runtime_api::{AuthFlowId, AuthPrompt, DialogId, ExtensionUiRequest, RunId};
use std::collections::BTreeMap;

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
    pub transcript_scroll: ScrollState,
    pub sidebar_scroll: ScrollState,
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

    pub fn set_input_editor(&mut self, editor: InputEditor) {
        self.input_editor = editor;
        self.vim_mode = match editor {
            InputEditor::Owned => VimMode::Insert,
            InputEditor::Embedded | InputEditor::External => VimMode::Normal,
        };
        let input_height = match editor {
            InputEditor::Embedded => self.terminal.height.saturating_div(3).clamp(8, 16),
            InputEditor::Owned | InputEditor::External => 3,
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
                height: Some(1),
                ..PaneViewState::default()
            },
        );
        panes.insert(
            ElementId::sidebar(),
            PaneViewState {
                width: Some(28),
                ..PaneViewState::default()
            },
        );
        panes.insert(
            ElementId::input(),
            PaneViewState {
                height: Some(3),
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
            transcript_scroll: ScrollState::default(),
            sidebar_scroll: ScrollState::default(),
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
    fn editor_selection_controls_only_frontend_view_state() {
        let mut view = ViewState::default();
        view.terminal.height = 42;

        view.set_input_editor(InputEditor::Embedded);
        assert_eq!(view.input_editor, InputEditor::Embedded);
        assert_eq!(view.vim_mode, VimMode::Normal);
        assert_eq!(view.pane(&ElementId::input()).height, Some(14));

        view.set_input_editor(InputEditor::External);
        assert_eq!(view.input_editor, InputEditor::External);
        assert_eq!(view.pane(&ElementId::input()).height, Some(3));
    }
}
