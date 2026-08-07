#![forbid(unsafe_code)]

use phenix_ui_core::{ElementId, FocusDirection, KeyInput, LayoutAxis, ResizeRequest};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::path::{Path, PathBuf};
use std::rc::Rc;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum PaneType {
    Global,
    Root,
    Layout,
    Inspector,
    Sidebar,
    Transcript,
    Specialized,
    Input,
    Status,
    Overlay,
}

impl PaneType {
    pub fn name(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Root => "root",
            Self::Layout => "layout",
            Self::Inspector => "inspector",
            Self::Sidebar => "sidebar",
            Self::Transcript => "transcript",
            Self::Specialized => "specialized",
            Self::Input => "input",
            Self::Status => "status",
            Self::Overlay => "overlay",
        }
    }

    pub fn parse(value: &str) -> Result<Self, FrontendProviderError> {
        match normalize(value).as_str() {
            "global" => Ok(Self::Global),
            "root" => Ok(Self::Root),
            "layout" => Ok(Self::Layout),
            "inspector" => Ok(Self::Inspector),
            "sidebar" => Ok(Self::Sidebar),
            "transcript" => Ok(Self::Transcript),
            "specialized" => Ok(Self::Specialized),
            "input" => Ok(Self::Input),
            "status" => Ok(Self::Status),
            "overlay" => Ok(Self::Overlay),
            _ => Err(FrontendProviderError::configuration(format!(
                "unknown pane type: {value}"
            ))),
        }
    }

    pub fn element_id(self) -> ElementId {
        match self {
            Self::Global | Self::Root => ElementId::root(),
            Self::Layout => ElementId::layout(),
            Self::Inspector => ElementId::inspector(),
            Self::Sidebar => ElementId::sidebar(),
            Self::Transcript => ElementId::transcript(),
            Self::Specialized => ElementId::specialized(),
            Self::Input => ElementId::input(),
            Self::Status => ElementId::status(),
            Self::Overlay => ElementId::overlay(),
        }
    }

    pub fn from_element(element: &ElementId) -> Self {
        match element.as_str() {
            "ui.layout" => Self::Layout,
            "ui.inspector" => Self::Inspector,
            "ui.sidebar" => Self::Sidebar,
            "ui.transcript" => Self::Transcript,
            "ui.specialized" => Self::Specialized,
            "ui.input" => Self::Input,
            "ui.status" => Self::Status,
            "ui.overlay" => Self::Overlay,
            _ => Self::Root,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FrontendContext {
    pub focused_element: ElementId,
    pub pane_type: PaneType,
    pub overlay_open: bool,
    pub dialog_open: bool,
    pub input_empty: bool,
    pub details_visible: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FrontendCommand {
    Application(ApplicationCommand),
    Ui(UiCommand),
    Input(InputCommand),
    Overlay(OverlayCommand),
    Handled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApplicationCommand {
    Submit,
    Steer,
    FollowUp,
    Abort,
    Quit,
    OpenAuthentication,
    OpenModelPicker,
    OpenSessionPicker,
    CreateSession,
    MoveSession(i32),
    MoveRun(i32),
    ActivateSidebarRun,
    ToggleDetails,
    CloseOverlay,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UiCommand {
    FocusSet(ElementId),
    FocusMove(FocusDirection),
    PaneResize {
        element: ElementId,
        axis: LayoutAxis,
        request: ResizeRequest,
    },
    PaneVisibility {
        element: ElementId,
        visible: bool,
    },
    PaneToggle(ElementId),
    PaneScroll {
        element: ElementId,
        lines: i32,
    },
    SidebarRunMove(i32),
    SidebarRunParent,
    SidebarRunChild,
    SidebarRunToggle,
    TranscriptTurnMove(i32),
    TranscriptTurnToggleDetails,
    Invalidate,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InputCommand {
    Insert(String),
    Backspace,
    Delete,
    MoveLeft,
    MoveRight,
    HistoryPrevious,
    HistoryNext,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OverlayCommand {
    MoveSelection(i32),
    Accept,
    Cancel,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ColorSpec {
    Default,
    Rgb { red: u8, green: u8, blue: u8 },
    Indexed(u8),
    Named(NamedColor),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NamedColor {
    Black,
    Red,
    Green,
    Yellow,
    Blue,
    Magenta,
    Cyan,
    White,
    Gray,
    DarkGray,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct HighlightStyle {
    pub foreground: Option<ColorSpec>,
    pub background: Option<ColorSpec>,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub reversed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThemeConfig {
    pub highlights: BTreeMap<String, HighlightStyle>,
}

impl ThemeConfig {
    pub fn style(&self, group: &str) -> HighlightStyle {
        self.highlights.get(group).cloned().unwrap_or_default()
    }

    pub fn set(&mut self, group: impl Into<String>, style: HighlightStyle) {
        self.highlights.insert(group.into(), style);
    }
}

impl Default for ThemeConfig {
    fn default() -> Self {
        let mut theme = Self {
            highlights: BTreeMap::new(),
        };

        // Catppuccin Mocha baseline: crust is application chrome/canvas and base
        // is the ordinary pane surface. Focus changes the border/title rather than
        // promoting an entire pane to a brighter surface level.
        theme.set(
            "Normal",
            HighlightStyle {
                foreground: Some(rgb(205, 214, 244)),
                background: Some(rgb(17, 17, 27)),
                ..HighlightStyle::default()
            },
        );
        for group in ["Surface", "SurfaceFocused"] {
            theme.set(
                group,
                HighlightStyle {
                    foreground: Some(rgb(205, 214, 244)),
                    background: Some(rgb(30, 30, 46)),
                    ..HighlightStyle::default()
                },
            );
        }

        for (group, foreground, bold) in [
            ("Muted", rgb(166, 173, 200), false),
            ("Accent", rgb(137, 180, 250), true),
            ("Success", rgb(166, 227, 161), false),
            ("Warning", rgb(249, 226, 175), false),
            ("Error", rgb(243, 139, 168), false),
            ("Thinking", rgb(249, 226, 175), false),
            ("Tool", rgb(203, 166, 247), false),
            ("Border", rgb(49, 50, 68), false),
            ("BorderFocused", rgb(137, 180, 250), false),
        ] {
            theme.set(
                group,
                HighlightStyle {
                    foreground: Some(foreground),
                    bold,
                    ..HighlightStyle::default()
                },
            );
        }
        theme
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SplitDirection {
    Horizontal,
    Vertical,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LayoutNode {
    Pane(PaneLayout),
    Split(SplitLayout),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaneLayout {
    pub element: ElementId,
    pub pane_type: PaneType,
    pub weight: u16,
    pub minimum: Option<u16>,
    pub maximum: Option<u16>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SplitLayout {
    pub direction: SplitDirection,
    pub children: Vec<LayoutNode>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LayoutConfig {
    pub root: LayoutNode,
}

impl Default for LayoutConfig {
    fn default() -> Self {
        let conversation = LayoutNode::Split(SplitLayout {
            direction: SplitDirection::Vertical,
            children: vec![
                pane(ElementId::transcript(), PaneType::Transcript, 1, None, None),
                pane(ElementId::input(), PaneType::Input, 3, Some(3), None),
                pane(ElementId::status(), PaneType::Status, 1, Some(1), Some(1)),
            ],
        });
        let workspace = LayoutNode::Split(SplitLayout {
            direction: SplitDirection::Horizontal,
            children: vec![
                pane(
                    ElementId::inspector(),
                    PaneType::Inspector,
                    22,
                    Some(18),
                    Some(32),
                ),
                conversation,
                pane(
                    ElementId::sidebar(),
                    PaneType::Sidebar,
                    28,
                    Some(24),
                    Some(40),
                ),
                pane(
                    ElementId::specialized(),
                    PaneType::Specialized,
                    1,
                    None,
                    None,
                ),
            ],
        });
        Self {
            root: LayoutNode::Split(SplitLayout {
                direction: SplitDirection::Vertical,
                children: vec![
                    pane(
                        ElementId::header(),
                        PaneType::Root,
                        1,
                        Some(1),
                        Some(1),
                    ),
                    workspace,
                ],
            }),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeymapDescription {
    pub pane: PaneType,
    pub chord: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct FrontendConfig {
    pub theme: ThemeConfig,
    pub layout: LayoutConfig,
    pub keymaps: Vec<KeymapDescription>,
}

pub trait FrontendConfigProvider {
    fn config(&self) -> &FrontendConfig;

    fn handle_key(
        &mut self,
        context: &FrontendContext,
        input: KeyInput,
    ) -> Result<Vec<FrontendCommand>, FrontendProviderError>;

    fn reload(&mut self) -> Result<(), FrontendProviderError>;

    fn source_path(&self) -> Option<&Path>;
}

pub type FrontendProviderRef = Rc<RefCell<dyn FrontendConfigProvider>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FrontendProviderErrorKind {
    Configuration,
    Runtime,
    Io,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FrontendProviderError {
    pub kind: FrontendProviderErrorKind,
    pub message: String,
    pub path: Option<PathBuf>,
}

impl FrontendProviderError {
    pub fn configuration(message: impl Into<String>) -> Self {
        Self {
            kind: FrontendProviderErrorKind::Configuration,
            message: message.into(),
            path: None,
        }
    }

    pub fn runtime(message: impl Into<String>) -> Self {
        Self {
            kind: FrontendProviderErrorKind::Runtime,
            message: message.into(),
            path: None,
        }
    }

    pub fn io(path: impl Into<PathBuf>, message: impl Into<String>) -> Self {
        Self {
            kind: FrontendProviderErrorKind::Io,
            message: message.into(),
            path: Some(path.into()),
        }
    }
}

impl Display for FrontendProviderError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        if let Some(path) = &self.path {
            write!(formatter, "{}: {}", path.display(), self.message)
        } else {
            formatter.write_str(&self.message)
        }
    }
}

impl Error for FrontendProviderError {}

fn normalize(value: &str) -> String {
    value.trim().to_ascii_lowercase().replace('_', "-")
}

fn rgb(red: u8, green: u8, blue: u8) -> ColorSpec {
    ColorSpec::Rgb { red, green, blue }
}

fn pane(
    element: ElementId,
    pane_type: PaneType,
    weight: u16,
    minimum: Option<u16>,
    maximum: Option<u16>,
) -> LayoutNode {
    LayoutNode::Pane(PaneLayout {
        element,
        pane_type,
        weight,
        minimum,
        maximum,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pane_types_are_renderer_neutral_but_have_stable_addresses() {
        assert_eq!(PaneType::Sidebar.element_id(), ElementId::sidebar());
        assert_eq!(PaneType::Inspector.element_id(), ElementId::inspector());
        assert_eq!(
            PaneType::Specialized.element_id(),
            ElementId::specialized()
        );
        assert_eq!(PaneType::from_element(&ElementId::input()), PaneType::Input);
    }

    #[test]
    fn default_theme_uses_semantic_highlight_groups() {
        let theme = ThemeConfig::default();
        assert!(theme.highlights.contains_key("Normal"));
        assert!(theme.highlights.contains_key("SurfaceFocused"));
        assert!(theme.highlights.contains_key("BorderFocused"));
        assert_eq!(theme.style("Normal").background, Some(rgb(17, 17, 27)));
        assert_eq!(theme.style("Surface").background, Some(rgb(30, 30, 46)));
        assert_eq!(theme.style("Accent").background, None);
    }

    #[test]
    fn default_layout_is_a_renderer_neutral_tree() {
        assert!(matches!(
            LayoutConfig::default().root,
            LayoutNode::Split(SplitLayout {
                direction: SplitDirection::Vertical,
                ..
            })
        ));
    }
}
