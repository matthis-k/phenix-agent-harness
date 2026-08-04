#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct KeyModifiers {
    pub control: bool,
    pub alt: bool,
    pub shift: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KeyCode {
    Character(char),
    Enter,
    Escape,
    Backspace,
    Delete,
    Insert,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    PageUp,
    PageDown,
    Tab,
    BackTab,
    Function(u8),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct KeyInput {
    pub code: KeyCode,
    pub modifiers: KeyModifiers,
    pub repeat: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MouseAction {
    Press(MouseButton),
    Release(MouseButton),
    Drag(MouseButton),
    ScrollUp,
    ScrollDown,
    Move,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MouseInput {
    pub column: u16,
    pub row: u16,
    pub action: MouseAction,
    pub modifiers: KeyModifiers,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UiInput {
    Key(KeyInput),
    Paste(String),
    Resize { width: u16, height: u16 },
    Mouse(MouseInput),
    FocusGained,
    FocusLost,
}
