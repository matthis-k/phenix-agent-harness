use phenix_ui_core::{ElementId, KeyCode, KeyInput, KeyModifiers};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum PaneType {
    Global,
    Root,
    Layout,
    Sidebar,
    Transcript,
    Input,
    Status,
    Overlay,
}

impl PaneType {
    pub fn parse(value: &str) -> Result<Self, KeyParseError> {
        match normalize(value).as_str() {
            "global" => Ok(Self::Global),
            "root" => Ok(Self::Root),
            "layout" => Ok(Self::Layout),
            "sidebar" => Ok(Self::Sidebar),
            "transcript" => Ok(Self::Transcript),
            "input" => Ok(Self::Input),
            "status" => Ok(Self::Status),
            "overlay" => Ok(Self::Overlay),
            _ => Err(KeyParseError::UnknownPane(value.to_owned())),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Root => "root",
            Self::Layout => "layout",
            Self::Sidebar => "sidebar",
            Self::Transcript => "transcript",
            Self::Input => "input",
            Self::Status => "status",
            Self::Overlay => "overlay",
        }
    }

    pub fn element_id(self) -> ElementId {
        match self {
            Self::Global | Self::Root => ElementId::root(),
            Self::Layout => ElementId::layout(),
            Self::Sidebar => ElementId::sidebar(),
            Self::Transcript => ElementId::transcript(),
            Self::Input => ElementId::input(),
            Self::Status => ElementId::status(),
            Self::Overlay => ElementId::overlay(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct KeyChord {
    pub code: KeyCode,
    pub modifiers: KeyModifiers,
}

impl KeyChord {
    pub fn parse(value: &str) -> Result<Self, KeyParseError> {
        let value = value.trim();
        if value.is_empty() {
            return Err(KeyParseError::InvalidChord(value.to_owned()));
        }
        let tokens = if value.starts_with('<') && value.ends_with('>') {
            value[1..value.len() - 1]
                .split('-')
                .map(str::trim)
                .filter(|token| !token.is_empty())
                .collect::<Vec<_>>()
        } else {
            value
                .split('+')
                .map(str::trim)
                .filter(|token| !token.is_empty())
                .collect::<Vec<_>>()
        };
        if tokens.is_empty() {
            return Err(KeyParseError::InvalidChord(value.to_owned()));
        }

        let mut modifiers = KeyModifiers::default();
        let mut key = None;
        for token in tokens {
            match token.to_ascii_lowercase().as_str() {
                "c" | "ctrl" | "control" => modifiers.control = true,
                "a" | "m" | "alt" | "meta" => modifiers.alt = true,
                "s" | "shift" => modifiers.shift = true,
                _ if key.is_none() => key = Some(parse_code(token)?),
                _ => return Err(KeyParseError::InvalidChord(value.to_owned())),
            }
        }
        let code = key.ok_or_else(|| KeyParseError::InvalidChord(value.to_owned()))?;
        if code == KeyCode::BackTab {
            modifiers.shift = false;
        }
        Ok(Self { code, modifiers })
    }

    pub fn matches(self, input: KeyInput) -> bool {
        self.code == input.code && self.modifiers == input.modifiers
    }
}

impl Display for KeyChord {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        if self.modifiers.control {
            formatter.write_str("ctrl+")?;
        }
        if self.modifiers.alt {
            formatter.write_str("alt+")?;
        }
        if self.modifiers.shift {
            formatter.write_str("shift+")?;
        }
        write!(formatter, "{:?}", self.code)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum KeyParseError {
    UnknownPane(String),
    InvalidChord(String),
    InvalidKey(String),
}

impl Display for KeyParseError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownPane(value) => write!(formatter, "unknown pane type: {value}"),
            Self::InvalidChord(value) => write!(formatter, "invalid key chord: {value}"),
            Self::InvalidKey(value) => write!(formatter, "invalid key name: {value}"),
        }
    }
}

impl Error for KeyParseError {}

fn parse_code(token: &str) -> Result<KeyCode, KeyParseError> {
    let normalized = normalize(token);
    let code = match normalized.as_str() {
        "cr" | "enter" | "return" => KeyCode::Enter,
        "esc" | "escape" => KeyCode::Escape,
        "bs" | "backspace" => KeyCode::Backspace,
        "del" | "delete" => KeyCode::Delete,
        "ins" | "insert" => KeyCode::Insert,
        "left" => KeyCode::Left,
        "right" => KeyCode::Right,
        "up" => KeyCode::Up,
        "down" => KeyCode::Down,
        "home" => KeyCode::Home,
        "end" => KeyCode::End,
        "pageup" | "page-up" => KeyCode::PageUp,
        "pagedown" | "page-down" => KeyCode::PageDown,
        "tab" => KeyCode::Tab,
        "s-tab" | "backtab" | "back-tab" => KeyCode::BackTab,
        "space" => KeyCode::Character(' '),
        function if function.starts_with('f') => {
            let number = function[1..]
                .parse::<u8>()
                .map_err(|_| KeyParseError::InvalidKey(token.to_owned()))?;
            if !(1..=24).contains(&number) {
                return Err(KeyParseError::InvalidKey(token.to_owned()));
            }
            KeyCode::Function(number)
        }
        _ if token.chars().count() == 1 => {
            KeyCode::Character(token.chars().next().expect("one character"))
        }
        _ => return Err(KeyParseError::InvalidKey(token.to_owned())),
    };
    Ok(code)
}

fn normalize(value: &str) -> String {
    value.trim().to_ascii_lowercase().replace('_', "-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_neovim_and_explicit_modifier_notation() {
        assert_eq!(KeyChord::parse("<C-d>"), KeyChord::parse("ctrl+d"));
        assert_eq!(KeyChord::parse("<M-CR>"), KeyChord::parse("alt+enter"));
        assert_eq!(
            KeyChord::parse("<S-Tab>").expect("shift tab").code,
            KeyCode::BackTab
        );
    }

    #[test]
    fn pane_types_have_stable_routing_addresses() {
        assert_eq!(PaneType::Sidebar.element_id(), ElementId::sidebar());
        assert_eq!(PaneType::Global.element_id(), ElementId::root());
    }
}
