use phenix_ui_core::{KeyCode, KeyInput, KeyModifiers};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

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
        if normalize(value) == "<s-tab>" || normalize(value) == "shift+tab" {
            return Ok(Self {
                code: KeyCode::BackTab,
                modifiers: KeyModifiers::default(),
            });
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
        let Some((key_token, modifier_tokens)) = tokens.split_last() else {
            return Err(KeyParseError::InvalidChord(value.to_owned()));
        };

        let mut modifiers = KeyModifiers::default();
        for token in modifier_tokens {
            match token.to_ascii_lowercase().as_str() {
                "c" | "ctrl" | "control" if !modifiers.control => modifiers.control = true,
                "a" | "m" | "alt" | "meta" if !modifiers.alt => modifiers.alt = true,
                "s" | "shift" if !modifiers.shift => modifiers.shift = true,
                _ => return Err(KeyParseError::InvalidChord(value.to_owned())),
            }
        }

        let code = parse_code(key_token)?;
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
    InvalidChord(String),
    InvalidKey(String),
}

impl Display for KeyParseError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
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
    fn final_single_character_is_always_the_key_not_a_modifier_alias() {
        let control_c = KeyChord::parse("<C-c>").expect("control-c");
        assert_eq!(control_c.code, KeyCode::Character('c'));
        assert!(control_c.modifiers.control);

        let alt_m = KeyChord::parse("<M-m>").expect("alt-m");
        assert_eq!(alt_m.code, KeyCode::Character('m'));
        assert!(alt_m.modifiers.alt);
    }

    #[test]
    fn duplicate_or_unknown_modifier_tokens_are_rejected() {
        assert!(matches!(
            KeyChord::parse("<C-C-x>"),
            Err(KeyParseError::InvalidChord(_))
        ));
        assert!(matches!(
            KeyChord::parse("<Hyper-x>"),
            Err(KeyParseError::InvalidChord(_))
        ));
    }
}
