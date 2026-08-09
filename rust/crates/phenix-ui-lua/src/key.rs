use phenix_ui_core::{KeyCode, KeyInput, KeyModifiers};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct KeyStroke {
    pub code: KeyCode,
    pub modifiers: KeyModifiers,
}

impl KeyStroke {
    fn parse(value: &str) -> Result<Self, KeyParseError> {
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
        if normalize(value) == "<leader>" {
            return Ok(Self {
                code: KeyCode::Character(' '),
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

    fn matches(self, input: KeyInput) -> bool {
        self.code == input.code && self.modifiers == input.modifiers
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeyChord {
    strokes: Vec<KeyStroke>,
}

impl KeyChord {
    pub fn parse(value: &str) -> Result<Self, KeyParseError> {
        let value = value.trim();
        if value.is_empty() {
            return Err(KeyParseError::InvalidChord(value.to_owned()));
        }

        let strokes = parse_sequence(value)?;
        if strokes.is_empty() {
            return Err(KeyParseError::InvalidChord(value.to_owned()));
        }
        Ok(Self { strokes })
    }

    pub fn len(&self) -> usize {
        self.strokes.len()
    }

    pub fn matches_inputs(&self, inputs: &[KeyInput]) -> bool {
        self.strokes.len() == inputs.len()
            && self
                .strokes
                .iter()
                .zip(inputs)
                .all(|(stroke, input)| stroke.matches(*input))
    }

    pub fn starts_with_inputs(&self, inputs: &[KeyInput]) -> bool {
        inputs.len() <= self.strokes.len()
            && self
                .strokes
                .iter()
                .zip(inputs)
                .all(|(stroke, input)| stroke.matches(*input))
    }
}

impl Display for KeyChord {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        for stroke in &self.strokes {
            if stroke.modifiers.control {
                formatter.write_str("<C-")?;
            } else if stroke.modifiers.alt {
                formatter.write_str("<M-")?;
            } else if stroke.modifiers.shift {
                formatter.write_str("<S-")?;
            }
            match stroke.code {
                KeyCode::Character(' ') if !stroke.modifiers.control && !stroke.modifiers.alt => {
                    formatter.write_str("<leader>")?;
                }
                KeyCode::Character(character) => write!(formatter, "{character}")?,
                ref code => write!(formatter, "{code:?}")?,
            }
            if stroke.modifiers.control || stroke.modifiers.alt || stroke.modifiers.shift {
                formatter.write_str(">")?;
            }
        }
        Ok(())
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

fn parse_sequence(value: &str) -> Result<Vec<KeyStroke>, KeyParseError> {
    if !value.starts_with('<') {
        if let Ok(stroke) = KeyStroke::parse(value) {
            return Ok(vec![stroke]);
        }
    }

    let mut strokes = Vec::new();
    let mut remaining = value;
    while !remaining.is_empty() {
        if let Some(rest) = remaining.strip_prefix('<') {
            let end = rest
                .find('>')
                .ok_or_else(|| KeyParseError::InvalidChord(value.to_owned()))?;
            let token = &remaining[..end + 2];
            strokes.push(KeyStroke::parse(token)?);
            remaining = &remaining[end + 2..];
            continue;
        }

        let character = remaining
            .chars()
            .next()
            .ok_or_else(|| KeyParseError::InvalidChord(value.to_owned()))?;
        strokes.push(KeyStroke {
            code: KeyCode::Character(character),
            modifiers: KeyModifiers::default(),
        });
        remaining = &remaining[character.len_utf8()..];
    }
    Ok(strokes)
}

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
        "space" | "leader" => KeyCode::Character(' '),
        "lt" => KeyCode::Character('<'),
        "gt" => KeyCode::Character('>'),
        function if function.len() > 1 && function.starts_with('f') => {
            let number = function[1..]
                .parse::<u8>()
                .map_err(|_| KeyParseError::InvalidKey(token.to_owned()))?;
            if !(1..=24).contains(&number) {
                return Err(KeyParseError::InvalidKey(token.to_owned()));
            }
            KeyCode::Function(number)
        }
        _ if token.chars().count() == 1 => KeyCode::Character(
            token
                .chars()
                .next()
                .ok_or_else(|| KeyParseError::InvalidKey(token.to_owned()))?,
        ),
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

    fn key(code: KeyCode, control: bool, alt: bool, shift: bool) -> KeyInput {
        KeyInput {
            code,
            modifiers: KeyModifiers {
                control,
                alt,
                shift,
            },
            repeat: false,
        }
    }

    #[test]
    fn accepts_neovim_and_explicit_modifier_notation() {
        assert_eq!(KeyChord::parse("<C-d>"), KeyChord::parse("ctrl+d"));
        assert_eq!(KeyChord::parse("<M-CR>"), KeyChord::parse("alt+enter"));
        assert!(KeyChord::parse("<S-Tab>")
            .expect("shift tab")
            .matches_inputs(&[key(KeyCode::BackTab, false, false, false)]));
    }

    #[test]
    fn parses_neovim_style_multi_key_sequences() {
        let sequence = KeyChord::parse("<C-w>h").expect("window chord");
        assert_eq!(sequence.len(), 2);
        assert!(sequence.starts_with_inputs(&[key(KeyCode::Character('w'), true, false, false)]));
        assert!(sequence.matches_inputs(&[
            key(KeyCode::Character('w'), true, false, false),
            key(KeyCode::Character('h'), false, false, false),
        ]));

        let gg = KeyChord::parse("gg").expect("gg");
        assert_eq!(gg.len(), 2);
        let leader = KeyChord::parse("<leader>fm").expect("leader sequence");
        assert_eq!(leader.len(), 3);
        assert!(leader.starts_with_inputs(&[key(KeyCode::Character(' '), false, false, false)]));
        let narrow = KeyChord::parse("<C-w><lt>").expect("literal angle sequence");
        assert!(narrow.matches_inputs(&[
            key(KeyCode::Character('w'), true, false, false),
            key(KeyCode::Character('<'), false, false, false),
        ]));
    }

    #[test]
    fn final_single_character_is_always_the_key_not_a_modifier_alias() {
        let control_c = KeyChord::parse("<C-c>").expect("control-c");
        assert!(control_c.matches_inputs(&[key(
            KeyCode::Character('c'),
            true,
            false,
            false
        )]));

        let control_f = KeyChord::parse("<C-f>").expect("control-f");
        assert!(control_f.matches_inputs(&[key(
            KeyCode::Character('f'),
            true,
            false,
            false
        )]));

        let alt_m = KeyChord::parse("<M-m>").expect("alt-m");
        assert!(alt_m.matches_inputs(&[key(
            KeyCode::Character('m'),
            false,
            true,
            false
        )]));
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
