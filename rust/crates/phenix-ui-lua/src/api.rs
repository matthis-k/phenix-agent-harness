use crate::key::KeyChord;
use crate::provider::{LuaBinding, LuaState};
use mlua::{Function, Lua, Table, Value};
use phenix_frontend_config::{
    ApplicationCommand, ColorSpec, FrontendCommand, FrontendProviderError, HighlightStyle,
    InputCommand, NamedColor, OverlayCommand, PaneType, ThemeConfig, UiCommand,
};
use phenix_ui_core::{ElementId, FocusDirection, LayoutAxis, ResizeRequest};
use std::cell::RefCell;
use std::rc::Rc;

pub(crate) fn install_api(
    lua: &Lua,
    state: Rc<RefCell<LuaState>>,
    commands: Rc<RefCell<Vec<FrontendCommand>>>,
) -> Result<(), FrontendProviderError> {
    let phenix = lua.create_table().map_err(runtime_error)?;
    phenix
        .set("keymap", keymap_api(lua, Rc::clone(&state))?)
        .map_err(runtime_error)?;
    phenix
        .set("action", action_api(lua, Rc::clone(&commands))?)
        .map_err(runtime_error)?;
    phenix
        .set("ui", ui_api(lua, Rc::clone(&commands))?)
        .map_err(runtime_error)?;
    phenix
        .set("input", input_api(lua, Rc::clone(&commands))?)
        .map_err(runtime_error)?;
    phenix
        .set("overlay", overlay_api(lua, Rc::clone(&commands))?)
        .map_err(runtime_error)?;
    phenix
        .set("theme", theme_api(lua, Rc::clone(&state))?)
        .map_err(runtime_error)?;
    lua.globals().set("phenix", phenix).map_err(runtime_error)
}

fn keymap_api(lua: &Lua, state: Rc<RefCell<LuaState>>) -> Result<Table, FrontendProviderError> {
    let api = lua.create_table().map_err(runtime_error)?;

    let set_state = Rc::clone(&state);
    api.set(
        "set",
        lua
            .create_function(
                move |lua,
                      (pane, source, callback, options): (
                    String,
                    String,
                    Function,
                    Option<Table>,
                )| {
                    let pane = PaneType::parse(&pane).map_err(mlua::Error::external)?;
                    let chord = KeyChord::parse(&source).map_err(mlua::Error::external)?;
                    let description = options
                        .as_ref()
                        .map(|table| table.get::<Option<String>>("desc"))
                        .transpose()?
                        .flatten();
                    let callback = lua.create_registry_value(callback)?;
                    let mut state = set_state.borrow_mut();
                    state
                        .bindings
                        .retain(|binding| !(binding.pane == pane && binding.chord == chord));
                    state.bindings.push(LuaBinding {
                        pane,
                        chord,
                        source,
                        description,
                        callback,
                    });
                    state.refresh_keymap_descriptions();
                    Ok(())
                },
            )
            .map_err(runtime_error)?,
    )
    .map_err(runtime_error)?;

    let delete_state = Rc::clone(&state);
    api.set(
        "del",
        lua.create_function(move |_, (pane, source): (String, String)| {
            let pane = PaneType::parse(&pane).map_err(mlua::Error::external)?;
            let chord = KeyChord::parse(&source).map_err(mlua::Error::external)?;
            let mut state = delete_state.borrow_mut();
            state
                .bindings
                .retain(|binding| !(binding.pane == pane && binding.chord == chord));
            state.refresh_keymap_descriptions();
            Ok(())
        })
        .map_err(runtime_error)?,
    )
    .map_err(runtime_error)?;

    api.set(
        "clear",
        lua.create_function(move |_, pane: Option<String>| {
            let mut state = state.borrow_mut();
            if let Some(pane) = pane {
                let pane = PaneType::parse(&pane).map_err(mlua::Error::external)?;
                state.bindings.retain(|binding| binding.pane != pane);
            } else {
                state.bindings.clear();
            }
            state.refresh_keymap_descriptions();
            Ok(())
        })
        .map_err(runtime_error)?,
    )
    .map_err(runtime_error)?;

    Ok(api)
}

fn action_api(
    lua: &Lua,
    commands: Rc<RefCell<Vec<FrontendCommand>>>,
) -> Result<Table, FrontendProviderError> {
    let api = lua.create_table().map_err(runtime_error)?;
    for (name, command) in [
        ("submit", ApplicationCommand::Submit),
        ("steer", ApplicationCommand::Steer),
        ("follow_up", ApplicationCommand::FollowUp),
        ("abort", ApplicationCommand::Abort),
        ("quit", ApplicationCommand::Quit),
        ("login", ApplicationCommand::OpenAuthentication),
        ("models", ApplicationCommand::OpenModelPicker),
        ("sessions", ApplicationCommand::OpenSessionPicker),
        ("new_session", ApplicationCommand::CreateSession),
        ("activate_sidebar_run", ApplicationCommand::ActivateSidebarRun),
        ("toggle_details", ApplicationCommand::ToggleDetails),
        ("close_overlay", ApplicationCommand::CloseOverlay),
    ] {
        api.set(
            name,
            command_function(
                lua,
                Rc::clone(&commands),
                FrontendCommand::Application(command),
            )?,
        )
        .map_err(runtime_error)?;
    }

    let run_commands = Rc::clone(&commands);
    api.set(
        "move_run",
        lua.create_function(move |_, delta: i32| {
            run_commands
                .borrow_mut()
                .push(FrontendCommand::Application(ApplicationCommand::MoveRun(delta)));
            Ok(())
        })
        .map_err(runtime_error)?,
    )
    .map_err(runtime_error)?;

    let session_commands = Rc::clone(&commands);
    api.set(
        "move_session",
        lua.create_function(move |_, delta: i32| {
            session_commands.borrow_mut().push(FrontendCommand::Application(
                ApplicationCommand::MoveSession(delta),
            ));
            Ok(())
        })
        .map_err(runtime_error)?,
    )
    .map_err(runtime_error)?;

    Ok(api)
}

fn ui_api(
    lua: &Lua,
    commands: Rc<RefCell<Vec<FrontendCommand>>>,
) -> Result<Table, FrontendProviderError> {
    let api = lua.create_table().map_err(runtime_error)?;
    let focus = lua.create_table().map_err(runtime_error)?;

    let focus_commands = Rc::clone(&commands);
    focus
        .set(
            "set",
            lua.create_function(move |_, element: String| {
                focus_commands
                    .borrow_mut()
                    .push(FrontendCommand::Ui(UiCommand::FocusSet(
                        ElementId::parse(element).map_err(mlua::Error::external)?,
                    )));
                Ok(())
            })
            .map_err(runtime_error)?,
        )
        .map_err(runtime_error)?;

    let move_commands = Rc::clone(&commands);
    focus
        .set(
            "move",
            lua.create_function(move |_, direction: String| {
                move_commands
                    .borrow_mut()
                    .push(FrontendCommand::Ui(UiCommand::FocusMove(
                        parse_focus_direction(&direction)?,
                    )));
                Ok(())
            })
            .map_err(runtime_error)?,
        )
        .map_err(runtime_error)?;
    api.set("focus", focus).map_err(runtime_error)?;

    let pane = lua.create_table().map_err(runtime_error)?;
    let resize_commands = Rc::clone(&commands);
    pane.set(
        "resize",
        lua.create_function(move |_, (element, axis, amount): (String, String, i32)| {
            let amount_abs = amount.unsigned_abs().min(u16::MAX as u32) as u16;
            let request = if amount >= 0 {
                ResizeRequest::Grow(amount_abs)
            } else {
                ResizeRequest::Shrink(amount_abs)
            };
            resize_commands
                .borrow_mut()
                .push(FrontendCommand::Ui(UiCommand::PaneResize {
                    element: ElementId::parse(element).map_err(mlua::Error::external)?,
                    axis: parse_axis(&axis)?,
                    request,
                }));
            Ok(())
        })
        .map_err(runtime_error)?,
    )
    .map_err(runtime_error)?;

    let size_commands = Rc::clone(&commands);
    pane.set(
        "set_size",
        lua.create_function(move |_, (element, axis, size): (String, String, u16)| {
            size_commands
                .borrow_mut()
                .push(FrontendCommand::Ui(UiCommand::PaneResize {
                    element: ElementId::parse(element).map_err(mlua::Error::external)?,
                    axis: parse_axis(&axis)?,
                    request: ResizeRequest::Set(size),
                }));
            Ok(())
        })
        .map_err(runtime_error)?,
    )
    .map_err(runtime_error)?;

    for (name, visible) in [("show", true), ("hide", false)] {
        let visibility_commands = Rc::clone(&commands);
        pane.set(
            name,
            lua.create_function(move |_, element: String| {
                visibility_commands.borrow_mut().push(FrontendCommand::Ui(
                    UiCommand::PaneVisibility {
                        element: ElementId::parse(element).map_err(mlua::Error::external)?,
                        visible,
                    },
                ));
                Ok(())
            })
            .map_err(runtime_error)?,
        )
        .map_err(runtime_error)?;
    }

    let toggle_commands = Rc::clone(&commands);
    pane.set(
        "toggle",
        lua.create_function(move |_, element: String| {
            toggle_commands
                .borrow_mut()
                .push(FrontendCommand::Ui(UiCommand::PaneToggle(
                    ElementId::parse(element).map_err(mlua::Error::external)?,
                )));
            Ok(())
        })
        .map_err(runtime_error)?,
    )
    .map_err(runtime_error)?;

    let scroll_commands = Rc::clone(&commands);
    pane.set(
        "scroll",
        lua.create_function(move |_, (element, lines): (String, i32)| {
            scroll_commands
                .borrow_mut()
                .push(FrontendCommand::Ui(UiCommand::PaneScroll {
                    element: ElementId::parse(element).map_err(mlua::Error::external)?,
                    lines,
                }));
            Ok(())
        })
        .map_err(runtime_error)?,
    )
    .map_err(runtime_error)?;
    api.set("pane", pane).map_err(runtime_error)?;

    let sidebar = lua.create_table().map_err(runtime_error)?;
    let sidebar_move_commands = Rc::clone(&commands);
    sidebar
        .set(
            "move_run",
            lua.create_function(move |_, delta: i32| {
                sidebar_move_commands
                    .borrow_mut()
                    .push(FrontendCommand::Ui(UiCommand::SidebarRunMove(delta)));
                Ok(())
            })
            .map_err(runtime_error)?,
        )
        .map_err(runtime_error)?;
    for (name, command) in [
        ("parent", UiCommand::SidebarRunParent),
        ("child", UiCommand::SidebarRunChild),
        ("toggle", UiCommand::SidebarRunToggle),
    ] {
        sidebar
            .set(
                name,
                command_function(lua, Rc::clone(&commands), FrontendCommand::Ui(command))?,
            )
            .map_err(runtime_error)?;
    }
    api.set("sidebar", sidebar).map_err(runtime_error)?;

    let transcript = lua.create_table().map_err(runtime_error)?;
    let transcript_move_commands = Rc::clone(&commands);
    transcript
        .set(
            "move",
            lua.create_function(move |_, delta: i32| {
                transcript_move_commands
                    .borrow_mut()
                    .push(FrontendCommand::Ui(UiCommand::TranscriptTurnMove(delta)));
                Ok(())
            })
            .map_err(runtime_error)?,
        )
        .map_err(runtime_error)?;
    transcript
        .set(
            "toggle_details",
            command_function(
                lua,
                Rc::clone(&commands),
                FrontendCommand::Ui(UiCommand::TranscriptTurnToggleDetails),
            )?,
        )
        .map_err(runtime_error)?;
    api.set("transcript", transcript).map_err(runtime_error)?;

    api.set(
        "invalidate",
        command_function(lua, commands, FrontendCommand::Ui(UiCommand::Invalidate))?,
    )
    .map_err(runtime_error)?;
    Ok(api)
}

fn input_api(
    lua: &Lua,
    commands: Rc<RefCell<Vec<FrontendCommand>>>,
) -> Result<Table, FrontendProviderError> {
    let api = lua.create_table().map_err(runtime_error)?;
    let insert_commands = Rc::clone(&commands);
    api.set(
        "insert",
        lua.create_function(move |_, text: String| {
            insert_commands
                .borrow_mut()
                .push(FrontendCommand::Input(InputCommand::Insert(text)));
            Ok(())
        })
        .map_err(runtime_error)?,
    )
    .map_err(runtime_error)?;
    for (name, command) in [
        ("backspace", InputCommand::Backspace),
        ("delete", InputCommand::Delete),
        ("move_left", InputCommand::MoveLeft),
        ("move_right", InputCommand::MoveRight),
        ("history_previous", InputCommand::HistoryPrevious),
        ("history_next", InputCommand::HistoryNext),
    ] {
        api.set(
            name,
            command_function(lua, Rc::clone(&commands), FrontendCommand::Input(command))?,
        )
        .map_err(runtime_error)?;
    }
    Ok(api)
}

fn overlay_api(
    lua: &Lua,
    commands: Rc<RefCell<Vec<FrontendCommand>>>,
) -> Result<Table, FrontendProviderError> {
    let api = lua.create_table().map_err(runtime_error)?;
    for (name, command) in [
        ("next", OverlayCommand::MoveSelection(1)),
        ("previous", OverlayCommand::MoveSelection(-1)),
        ("accept", OverlayCommand::Accept),
        ("cancel", OverlayCommand::Cancel),
    ] {
        api.set(
            name,
            command_function(lua, Rc::clone(&commands), FrontendCommand::Overlay(command))?,
        )
        .map_err(runtime_error)?;
    }
    Ok(api)
}

fn theme_api(lua: &Lua, state: Rc<RefCell<LuaState>>) -> Result<Table, FrontendProviderError> {
    let api = lua.create_table().map_err(runtime_error)?;
    let set_state = Rc::clone(&state);
    api.set(
        "set",
        lua.create_function(move |_, (group, style): (String, Table)| {
            set_state
                .borrow_mut()
                .config
                .theme
                .set(group, parse_style(&style)?);
            Ok(())
        })
        .map_err(runtime_error)?,
    )
    .map_err(runtime_error)?;

    let delete_state = Rc::clone(&state);
    api.set(
        "del",
        lua.create_function(move |_, group: String| {
            delete_state
                .borrow_mut()
                .config
                .theme
                .highlights
                .remove(&group);
            Ok(())
        })
        .map_err(runtime_error)?,
    )
    .map_err(runtime_error)?;

    api.set(
        "reset",
        lua.create_function(move |_, ()| {
            state.borrow_mut().config.theme = ThemeConfig::default();
            Ok(())
        })
        .map_err(runtime_error)?,
    )
    .map_err(runtime_error)?;
    Ok(api)
}

fn command_function(
    lua: &Lua,
    commands: Rc<RefCell<Vec<FrontendCommand>>>,
    command: FrontendCommand,
) -> Result<Function, FrontendProviderError> {
    lua.create_function(move |_, ()| {
        commands.borrow_mut().push(command.clone());
        Ok(())
    })
    .map_err(runtime_error)
}

fn parse_style(table: &Table) -> mlua::Result<HighlightStyle> {
    Ok(HighlightStyle {
        foreground: parse_optional_color(table.get::<Value>("fg")?)?,
        background: parse_optional_color(table.get::<Value>("bg")?)?,
        bold: table.get::<Option<bool>>("bold")?.unwrap_or(false),
        italic: table.get::<Option<bool>>("italic")?.unwrap_or(false),
        underline: table.get::<Option<bool>>("underline")?.unwrap_or(false),
        reversed: table.get::<Option<bool>>("reverse")?.unwrap_or(false),
    })
}

fn parse_optional_color(value: Value) -> mlua::Result<Option<ColorSpec>> {
    match value {
        Value::Nil => Ok(None),
        Value::Integer(index) if (0..=255).contains(&index) => {
            Ok(Some(ColorSpec::Indexed(index as u8)))
        }
        Value::String(value) => parse_color_name(value.to_str()?.as_ref()).map(Some),
        Value::Table(table) => Ok(Some(ColorSpec::Rgb {
            red: table.get("r")?,
            green: table.get("g")?,
            blue: table.get("b")?,
        })),
        _ => Err(mlua::Error::runtime(
            "color must be a name, #RRGGBB, index, or {r,g,b}",
        )),
    }
}

fn parse_color_name(value: &str) -> mlua::Result<ColorSpec> {
    if let Some(hex) = value.strip_prefix('#') {
        if hex.len() == 6 {
            let red = u8::from_str_radix(&hex[0..2], 16).map_err(mlua::Error::external)?;
            let green = u8::from_str_radix(&hex[2..4], 16).map_err(mlua::Error::external)?;
            let blue = u8::from_str_radix(&hex[4..6], 16).map_err(mlua::Error::external)?;
            return Ok(ColorSpec::Rgb { red, green, blue });
        }
    }
    let named = match value.trim().to_ascii_lowercase().as_str() {
        "default" => return Ok(ColorSpec::Default),
        "black" => NamedColor::Black,
        "red" => NamedColor::Red,
        "green" => NamedColor::Green,
        "yellow" => NamedColor::Yellow,
        "blue" => NamedColor::Blue,
        "magenta" => NamedColor::Magenta,
        "cyan" => NamedColor::Cyan,
        "white" => NamedColor::White,
        "gray" | "grey" => NamedColor::Gray,
        "dark-gray" | "dark-grey" => NamedColor::DarkGray,
        _ => return Err(mlua::Error::runtime(format!("unknown color: {value}"))),
    };
    Ok(ColorSpec::Named(named))
}

fn parse_focus_direction(value: &str) -> mlua::Result<FocusDirection> {
    match value.trim().to_ascii_lowercase().as_str() {
        "next" => Ok(FocusDirection::Next),
        "previous" | "prev" => Ok(FocusDirection::Previous),
        "left" => Ok(FocusDirection::Left),
        "right" => Ok(FocusDirection::Right),
        "up" => Ok(FocusDirection::Up),
        "down" => Ok(FocusDirection::Down),
        _ => Err(mlua::Error::runtime(
            "focus direction must be next, previous, left, right, up, or down",
        )),
    }
}

fn parse_axis(value: &str) -> mlua::Result<LayoutAxis> {
    match value.trim().to_ascii_lowercase().as_str() {
        "horizontal" | "width" | "x" => Ok(LayoutAxis::Horizontal),
        "vertical" | "height" | "y" => Ok(LayoutAxis::Vertical),
        _ => Err(mlua::Error::runtime(
            "axis must be horizontal/width/x or vertical/height/y",
        )),
    }
}

fn runtime_error(error: mlua::Error) -> FrontendProviderError {
    FrontendProviderError::runtime(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hex_and_named_colors() {
        assert_eq!(
            parse_color_name("#112233").expect("hex color"),
            ColorSpec::Rgb {
                red: 0x11,
                green: 0x22,
                blue: 0x33,
            }
        );
        assert_eq!(
            parse_color_name("blue").expect("named color"),
            ColorSpec::Named(NamedColor::Blue)
        );
    }
}
