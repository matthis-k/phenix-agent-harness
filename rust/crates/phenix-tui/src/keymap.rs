use phenix_tui::PhenixInputController;
use phenix_ui_core::{
    AppEvent, AppState, FocusTarget, KeyCode, KeyInput, KeyModifiers, UiInput,
};
use phenix_ui_runtime::UiInputController;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum PaneType {
    Root,
    Layout,
    Sidebar,
    Transcript,
    Input,
    Status,
    Overlay,
}

impl PaneType {
    fn parse(value: &str) -> Result<Self, KeymapError> {
        match normalize_name(value).as_str() {
            "root" => Ok(Self::Root),
            "layout" => Ok(Self::Layout),
            "sidebar" => Ok(Self::Sidebar),
            "transcript" => Ok(Self::Transcript),
            "input" => Ok(Self::Input),
            "status" => Ok(Self::Status),
            "overlay" => Ok(Self::Overlay),
            _ => Err(KeymapError::UnknownPaneType(value.to_owned())),
        }
    }

    fn for_state(state: &AppState) -> Self {
        if state.view.overlay.is_some() || !state.dialogs.is_empty() {
            return Self::Overlay;
        }
        match state.view.focus {
            FocusTarget::Sidebar => Self::Sidebar,
            FocusTarget::Transcript => Self::Transcript,
            FocusTarget::Input => Self::Input,
            FocusTarget::Overlay => Self::Overlay,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KeyAction {
    Quit,
    Abort,
    OpenAuthentication,
    OpenModelPicker,
    OpenSessionPicker,
    ToggleDetails,
    FocusNext,
    FocusPrevious,
    Submit,
    InsertNewline,
    Steer,
    FollowUp,
    Accept,
    Cancel,
    DeleteBackward,
    Previous,
    Next,
    PagePrevious,
    PageNext,
}

impl KeyAction {
    fn parse(value: &str) -> Result<Self, KeymapError> {
        match normalize_name(value).as_str() {
            "quit" => Ok(Self::Quit),
            "abort" => Ok(Self::Abort),
            "open-authentication" | "login" => Ok(Self::OpenAuthentication),
            "open-model-picker" | "models" => Ok(Self::OpenModelPicker),
            "open-session-picker" | "sessions" => Ok(Self::OpenSessionPicker),
            "toggle-details" => Ok(Self::ToggleDetails),
            "focus-next" => Ok(Self::FocusNext),
            "focus-previous" => Ok(Self::FocusPrevious),
            "submit" => Ok(Self::Submit),
            "insert-newline" => Ok(Self::InsertNewline),
            "steer" => Ok(Self::Steer),
            "follow-up" => Ok(Self::FollowUp),
            "accept" => Ok(Self::Accept),
            "cancel" => Ok(Self::Cancel),
            "delete-backward" => Ok(Self::DeleteBackward),
            "previous" => Ok(Self::Previous),
            "next" => Ok(Self::Next),
            "page-previous" => Ok(Self::PagePrevious),
            "page-next" => Ok(Self::PageNext),
            _ => Err(KeymapError::UnknownAction(value.to_owned())),
        }
    }

    fn canonical_input(self) -> KeyInput {
        let (code, modifiers) = match self {
            Self::Quit => (KeyCode::Character('d'), modifiers(true, false, false)),
            Self::Abort => (KeyCode::Character('c'), modifiers(true, false, false)),
            Self::OpenAuthentication => {
                (KeyCode::Character('l'), modifiers(true, false, false))
            }
            Self::OpenModelPicker => {
                (KeyCode::Character('m'), modifiers(true, false, false))
            }
            Self::OpenSessionPicker => {
                (KeyCode::Character('r'), modifiers(true, false, false))
            }
            Self::ToggleDetails => {
                (KeyCode::Character('o'), modifiers(true, false, false))
            }
            Self::FocusNext => (KeyCode::Tab, KeyModifiers::default()),
            Self::FocusPrevious => (KeyCode::BackTab, KeyModifiers::default()),
            Self::Submit | Self::Accept => (KeyCode::Enter, KeyModifiers::default()),
            Self::InsertNewline => (KeyCode::Enter, modifiers(false, false, true)),
            Self::Steer => (KeyCode::Enter, modifiers(true, false, false)),
            Self::FollowUp => (KeyCode::Enter, modifiers(false, true, false)),
            Self::Cancel => (KeyCode::Escape, KeyModifiers::default()),
            Self::DeleteBackward => (KeyCode::Backspace, KeyModifiers::default()),
            Self::Previous => (KeyCode::Up, KeyModifiers::default()),
            Self::Next => (KeyCode::Down, KeyModifiers::default()),
            Self::PagePrevious => (KeyCode::PageUp, KeyModifiers::default()),
            Self::PageNext => (KeyCode::PageDown, KeyModifiers::default()),
        };
        KeyInput {
            code,
            modifiers,
            repeat: false,
        }
    }
}

const ALL_ACTIONS: [KeyAction; 20] = [
    KeyAction::Quit,
    KeyAction::Abort,
    KeyAction::OpenAuthentication,
    KeyAction::OpenModelPicker,
    KeyAction::OpenSessionPicker,
    KeyAction::ToggleDetails,
    KeyAction::FocusNext,
    KeyAction::FocusPrevious,
    KeyAction::Submit,
    KeyAction::InsertNewline,
    KeyAction::Steer,
    KeyAction::FollowUp,
    KeyAction::Accept,
    KeyAction::Cancel,
    KeyAction::DeleteBackward,
    KeyAction::Previous,
    KeyAction::Next,
    KeyAction::PagePrevious,
    KeyAction::PageNext,
    KeyAction::Abort,
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct KeyChord {
    code: KeyCode,
    modifiers: KeyModifiers,
}

impl KeyChord {
    fn parse(value: &str) -> Result<Self, KeymapError> {
        let mut modifiers = KeyModifiers::default();
        let mut key = None;
        for part in value.split('+').map(str::trim).filter(|part| !part.is_empty()) {
            match part.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => modifiers.control = true,
                "alt" | "meta" => modifiers.alt = true,
                "shift" => modifiers.shift = true,
                token if key.is_none() => key = Some(parse_key_code(token)?),
                _ => return Err(KeymapError::InvalidChord(value.to_owned())),
            }
        }
        let code = key.ok_or_else(|| KeymapError::InvalidChord(value.to_owned()))?;
        if code == KeyCode::BackTab {
            modifiers.shift = false;
        }
        Ok(Self { code, modifiers })
    }

    fn matches(self, key: KeyInput) -> bool {
        self.code == key.code && self.modifiers == key.modifiers
    }

    fn from_input(input: KeyInput) -> Self {
        Self {
            code: input.code,
            modifiers: input.modifiers,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Binding {
    chord: KeyChord,
    action: KeyAction,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct BindingLayer {
    bindings: Vec<Binding>,
}

impl BindingLayer {
    fn resolve(&self, key: KeyInput) -> Option<KeyAction> {
        self.bindings
            .iter()
            .find(|binding| binding.chord.matches(key))
            .map(|binding| binding.action)
    }

    fn replace_action(
        &mut self,
        action: KeyAction,
        chords: impl IntoIterator<Item = KeyChord>,
    ) -> Result<(), KeymapError> {
        self.bindings.retain(|binding| binding.action != action);
        for chord in chords {
            if let Some(existing) = self.bindings.iter().find(|binding| binding.chord == chord) {
                return Err(KeymapError::Conflict {
                    chord,
                    first: existing.action,
                    second: action,
                });
            }
            self.bindings.push(Binding { chord, action });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Keymap {
    global: BindingLayer,
    panes: BTreeMap<PaneType, BindingLayer>,
}

impl Keymap {
    pub fn load(path: Option<&Path>) -> Result<Self, KeymapError> {
        let Some(path) = path else {
            return Ok(Self::default());
        };
        let source = match fs::read_to_string(path) {
            Ok(source) => source,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(KeymapError::MissingConfig(path.to_path_buf()))
            }
            Err(error) => return Err(KeymapError::Read(path.to_path_buf(), error.to_string())),
        };
        Self::from_toml(&source)
            .map_err(|error| KeymapError::Config(path.to_path_buf(), Box::new(error)))
    }

    pub fn load_optional(path: &Path) -> Result<Self, KeymapError> {
        if !path.exists() {
            return Ok(Self::default());
        }
        Self::load(Some(path))
    }

    pub fn from_toml(source: &str) -> Result<Self, KeymapError> {
        let file: ConfigFile = toml::from_str(source)
            .map_err(|error| KeymapError::Toml(error.to_string()))?;
        let mut keymap = if file.keymaps.replace_defaults {
            Self::empty()
        } else {
            Self::default()
        };
        apply_table(&mut keymap.global, &file.keymaps.global)?;
        for (pane_name, table) in file.keymaps.panes {
            let pane = PaneType::parse(&pane_name)?;
            apply_table(keymap.panes.entry(pane).or_default(), &table)?;
        }
        Ok(keymap)
    }

    pub fn resolve(&self, state: &AppState, key: KeyInput) -> Option<KeyAction> {
        self.panes
            .get(&PaneType::for_state(state))
            .and_then(|layer| layer.resolve(key))
            .or_else(|| self.global.resolve(key))
    }

    fn empty() -> Self {
        Self {
            global: BindingLayer::default(),
            panes: BTreeMap::new(),
        }
    }

    fn reserves_default_chord(key: KeyInput) -> bool {
        ALL_ACTIONS
            .iter()
            .any(|action| KeyChord::from_input(action.canonical_input()).matches(key))
    }

    pub fn default_toml() -> &'static str {
        DEFAULT_CONFIG
    }
}

impl Default for Keymap {
    fn default() -> Self {
        Self::from_toml(DEFAULT_CONFIG).expect("built-in keymap must be valid")
    }
}

pub struct KeymapInputController {
    keymap: Keymap,
    inner: PhenixInputController,
}

impl KeymapInputController {
    pub fn new(keymap: Keymap) -> Self {
        Self {
            keymap,
            inner: PhenixInputController::default(),
        }
    }
}

impl UiInputController for KeymapInputController {
    fn handle(&mut self, state: &AppState, input: UiInput) -> Vec<AppEvent> {
        let UiInput::Key(key) = input else {
            return self.inner.handle(state, input);
        };
        if let Some(action) = self.keymap.resolve(state, key) {
            return self
                .inner
                .handle(state, UiInput::Key(action.canonical_input()));
        }
        if Keymap::reserves_default_chord(key) {
            return Vec::new();
        }
        self.inner.handle(state, UiInput::Key(key))
    }
}

#[derive(Debug, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct ConfigFile {
    keymaps: KeymapsFile,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default, deny_unknown_fields, rename_all = "kebab-case")]
struct KeymapsFile {
    replace_defaults: bool,
    global: BindingTable,
    panes: BTreeMap<String, BindingTable>,
}

type BindingTable = BTreeMap<String, ChordList>;

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ChordList {
    One(String),
    Many(Vec<String>),
}

impl ChordList {
    fn values(self) -> Vec<String> {
        match self {
            Self::One(value) => vec![value],
            Self::Many(values) => values,
        }
    }
}

fn apply_table(layer: &mut BindingLayer, table: &BindingTable) -> Result<(), KeymapError> {
    for (action_name, chord_list) in table {
        let action = KeyAction::parse(action_name)?;
        let chords = match chord_list {
            ChordList::One(value) => vec![KeyChord::parse(value)?],
            ChordList::Many(values) => values
                .iter()
                .map(|value| KeyChord::parse(value))
                .collect::<Result<Vec<_>, _>>()?,
        };
        layer.replace_action(action, chords)?;
    }
    Ok(())
}

fn parse_key_code(token: &str) -> Result<KeyCode, KeymapError> {
    let code = match token {
        "enter" | "return" => KeyCode::Enter,
        "esc" | "escape" => KeyCode::Escape,
        "backspace" => KeyCode::Backspace,
        "delete" | "del" => KeyCode::Delete,
        "insert" | "ins" => KeyCode::Insert,
        "left" => KeyCode::Left,
        "right" => KeyCode::Right,
        "up" => KeyCode::Up,
        "down" => KeyCode::Down,
        "home" => KeyCode::Home,
        "end" => KeyCode::End,
        "pageup" | "page-up" => KeyCode::PageUp,
        "pagedown" | "page-down" => KeyCode::PageDown,
        "tab" => KeyCode::Tab,
        "backtab" | "back-tab" => KeyCode::BackTab,
        "space" => KeyCode::Character(' '),
        function if function.starts_with('f') => {
            let number = function[1..]
                .parse::<u8>()
                .map_err(|_| KeymapError::InvalidKey(token.to_owned()))?;
            if !(1..=24).contains(&number) {
                return Err(KeymapError::InvalidKey(token.to_owned()));
            }
            KeyCode::Function(number)
        }
        character if character.chars().count() == 1 => {
            KeyCode::Character(character.chars().next().expect("one character"))
        }
        _ => return Err(KeymapError::InvalidKey(token.to_owned())),
    };
    Ok(code)
}

fn normalize_name(value: &str) -> String {
    value.trim().to_ascii_lowercase().replace('_', "-")
}

fn modifiers(control: bool, alt: bool, shift: bool) -> KeyModifiers {
    KeyModifiers {
        control,
        alt,
        shift,
    }
}

#[derive(Debug)]
pub enum KeymapError {
    MissingConfig(PathBuf),
    Read(PathBuf, String),
    Config(PathBuf, Box<KeymapError>),
    Toml(String),
    UnknownPaneType(String),
    UnknownAction(String),
    InvalidChord(String),
    InvalidKey(String),
    Conflict {
        chord: KeyChord,
        first: KeyAction,
        second: KeyAction,
    },
}

impl Display for KeymapError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingConfig(path) => write!(formatter, "keymap config does not exist: {}", path.display()),
            Self::Read(path, message) => {
                write!(formatter, "failed to read keymap config {}: {message}", path.display())
            }
            Self::Config(path, error) => {
                write!(formatter, "invalid keymap config {}: {error}", path.display())
            }
            Self::Toml(message) => write!(formatter, "invalid TOML: {message}"),
            Self::UnknownPaneType(pane) => write!(formatter, "unknown pane type: {pane}"),
            Self::UnknownAction(action) => write!(formatter, "unknown key action: {action}"),
            Self::InvalidChord(chord) => write!(formatter, "invalid key chord: {chord}"),
            Self::InvalidKey(key) => write!(formatter, "invalid key name: {key}"),
            Self::Conflict { chord, first, second } => write!(
                formatter,
                "key chord {chord:?} is assigned to both {first:?} and {second:?} in one keymap layer"
            ),
        }
    }
}

impl Error for KeymapError {}

pub const DEFAULT_CONFIG: &str = r#"[keymaps]
replace-defaults = false

[keymaps.global]
quit = ["ctrl+d", "ctrl+q"]
abort = ["ctrl+c", "esc"]
open-authentication = "ctrl+l"
open-model-picker = "ctrl+m"
open-session-picker = "ctrl+r"
toggle-details = "ctrl+o"
focus-next = "tab"
focus-previous = "backtab"

[keymaps.panes.input]
submit = "enter"
insert-newline = "shift+enter"
steer = "ctrl+enter"
follow-up = "alt+enter"
delete-backward = "backspace"
previous = "up"
next = "down"

[keymaps.panes.sidebar]
previous = ["up", "k"]
next = ["down", "j"]
page-previous = "pageup"
page-next = "pagedown"

[keymaps.panes.transcript]
previous = ["up", "k"]
next = ["down", "j"]
page-previous = "pageup"
page-next = "pagedown"

[keymaps.panes.overlay]
accept = "enter"
cancel = "esc"
previous = ["up", "k"]
next = ["down", "j"]
delete-backward = "backspace"
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pane_bindings_override_global_bindings() {
        let keymap = Keymap::from_toml(
            r#"[keymaps]
replace-defaults = true
[keymaps.global]
abort = "esc"
[keymaps.panes.overlay]
cancel = "esc"
"#,
        )
        .expect("keymap");
        let mut state = AppState::default();
        state.view.focus = FocusTarget::Overlay;
        assert_eq!(
            keymap.resolve(
                &state,
                KeyInput {
                    code: KeyCode::Escape,
                    modifiers: KeyModifiers::default(),
                    repeat: false,
                }
            ),
            Some(KeyAction::Cancel)
        );
    }

    #[test]
    fn the_same_chord_is_valid_in_different_pane_types() {
        let keymap = Keymap::from_toml(
            r#"[keymaps]
replace-defaults = true
[keymaps.panes.input]
submit = "enter"
[keymaps.panes.overlay]
accept = "enter"
"#,
        )
        .expect("keymap");
        assert!(keymap.panes.contains_key(&PaneType::Input));
        assert!(keymap.panes.contains_key(&PaneType::Overlay));
    }

    #[test]
    fn conflicting_chords_in_one_pane_are_rejected() {
        let error = Keymap::from_toml(
            r#"[keymaps]
replace-defaults = true
[keymaps.panes.sidebar]
previous = "k"
next = "k"
"#,
        )
        .expect_err("conflict");
        assert!(matches!(error, KeymapError::Conflict { .. }));
    }

    #[test]
    fn empty_binding_list_disables_a_default_action() {
        let keymap = Keymap::from_toml(
            r#"[keymaps.panes.input]
submit = []
"#,
        )
        .expect("keymap");
        let state = AppState::default();
        assert_eq!(
            keymap.resolve(
                &state,
                KeyInput {
                    code: KeyCode::Enter,
                    modifiers: KeyModifiers::default(),
                    repeat: false,
                }
            ),
            None
        );
    }
}
