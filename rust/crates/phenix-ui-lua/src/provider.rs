use crate::api::install_api;
use crate::key::KeyChord;
use mlua::{Function, Lua, RegistryKey, Table};
use phenix_frontend_config::{
    FrontendCommand, FrontendConfig, FrontendConfigProvider, FrontendContext,
    FrontendProviderError, KeymapDescription, PaneType,
};
use phenix_ui_core::KeyInput;
use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

const DEFAULT_CONFIG: &str = include_str!("../default.lua");

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LuaFrontendOptions {
    pub source_path: Option<PathBuf>,
    pub load_defaults: bool,
}

impl Default for LuaFrontendOptions {
    fn default() -> Self {
        Self {
            source_path: None,
            load_defaults: true,
        }
    }
}

pub struct LuaFrontendProvider {
    lua: Lua,
    state: Rc<RefCell<LuaState>>,
    commands: Rc<RefCell<Vec<FrontendCommand>>>,
    config: FrontendConfig,
    options: LuaFrontendOptions,
}

impl LuaFrontendProvider {
    pub fn new(options: LuaFrontendOptions) -> Result<Self, FrontendProviderError> {
        let built = build_provider(&options)?;
        Ok(Self {
            lua: built.lua,
            state: built.state,
            commands: built.commands,
            config: built.config,
            options,
        })
    }

    pub fn default_source() -> &'static str {
        DEFAULT_CONFIG
    }

    fn sync_config(&mut self) {
        let mut state = self.state.borrow_mut();
        state.refresh_keymap_descriptions();
        self.config = state.config.clone();
    }

    fn callback_for(
        &self,
        context: &FrontendContext,
        input: KeyInput,
    ) -> Result<Option<Function>, FrontendProviderError> {
        let state = self.state.borrow();
        let binding = state
            .bindings
            .iter()
            .rev()
            .find(|binding| binding.pane == context.pane_type && binding.chord.matches(input))
            .or_else(|| {
                state.bindings.iter().rev().find(|binding| {
                    binding.pane == PaneType::Global && binding.chord.matches(input)
                })
            });
        binding
            .map(|binding| {
                self.lua
                    .registry_value::<Function>(&binding.callback)
                    .map_err(lua_runtime_error)
            })
            .transpose()
    }

    fn context_table(&self, context: &FrontendContext) -> Result<Table, FrontendProviderError> {
        let table = self.lua.create_table().map_err(lua_runtime_error)?;
        table
            .set("focused_element", context.focused_element.as_str())
            .map_err(lua_runtime_error)?;
        table
            .set("pane_type", context.pane_type.name())
            .map_err(lua_runtime_error)?;
        table
            .set("overlay_open", context.overlay_open)
            .map_err(lua_runtime_error)?;
        table
            .set("dialog_open", context.dialog_open)
            .map_err(lua_runtime_error)?;
        table
            .set("input_empty", context.input_empty)
            .map_err(lua_runtime_error)?;
        table
            .set("details_visible", context.details_visible)
            .map_err(lua_runtime_error)?;
        Ok(table)
    }
}

impl FrontendConfigProvider for LuaFrontendProvider {
    fn config(&self) -> &FrontendConfig {
        &self.config
    }

    fn handle_key(
        &mut self,
        context: &FrontendContext,
        input: KeyInput,
    ) -> Result<Vec<FrontendCommand>, FrontendProviderError> {
        let Some(callback) = self.callback_for(context, input)? else {
            return Ok(Vec::new());
        };
        self.commands.borrow_mut().clear();
        callback
            .call::<()>(self.context_table(context)?)
            .map_err(lua_runtime_error)?;
        self.sync_config();
        let mut commands = self.commands.borrow_mut();
        if commands.is_empty() {
            Ok(vec![FrontendCommand::Handled])
        } else {
            Ok(commands.drain(..).collect())
        }
    }

    fn reload(&mut self) -> Result<(), FrontendProviderError> {
        let built = build_provider(&self.options)?;
        self.lua = built.lua;
        self.state = built.state;
        self.commands = built.commands;
        self.config = built.config;
        Ok(())
    }

    fn source_path(&self) -> Option<&Path> {
        self.options.source_path.as_deref()
    }
}

#[derive(Default)]
pub(crate) struct LuaState {
    pub config: FrontendConfig,
    pub bindings: Vec<LuaBinding>,
}

impl LuaState {
    pub fn refresh_keymap_descriptions(&mut self) {
        self.config.keymaps = self
            .bindings
            .iter()
            .map(|binding| KeymapDescription {
                pane: binding.pane,
                chord: binding.source.clone(),
                description: binding.description.clone(),
            })
            .collect();
    }
}

pub(crate) struct LuaBinding {
    pub pane: PaneType,
    pub chord: KeyChord,
    pub source: String,
    pub description: Option<String>,
    pub callback: RegistryKey,
}

struct BuiltProvider {
    lua: Lua,
    state: Rc<RefCell<LuaState>>,
    commands: Rc<RefCell<Vec<FrontendCommand>>>,
    config: FrontendConfig,
}

fn build_provider(options: &LuaFrontendOptions) -> Result<BuiltProvider, FrontendProviderError> {
    let lua = Lua::new();
    let state = Rc::new(RefCell::new(LuaState::default()));
    let commands = Rc::new(RefCell::new(Vec::new()));
    install_api(&lua, Rc::clone(&state), Rc::clone(&commands))?;

    if options.load_defaults {
        execute(&lua, DEFAULT_CONFIG, "@phenix/default.lua")?;
    }
    if let Some(path) = &options.source_path {
        let source = fs::read_to_string(path)
            .map_err(|error| FrontendProviderError::io(path, error.to_string()))?;
        execute(&lua, &source, &format!("@{}", path.display()))?;
    }

    let config = {
        let mut state = state.borrow_mut();
        state.refresh_keymap_descriptions();
        state.config.clone()
    };
    Ok(BuiltProvider {
        lua,
        state,
        commands,
        config,
    })
}

fn execute(lua: &Lua, source: &str, name: &str) -> Result<(), FrontendProviderError> {
    lua.load(source)
        .set_name(name)
        .exec()
        .map_err(lua_configuration_error)
}

fn lua_configuration_error(error: mlua::Error) -> FrontendProviderError {
    FrontendProviderError::configuration(error.to_string())
}

fn lua_runtime_error(error: mlua::Error) -> FrontendProviderError {
    FrontendProviderError::runtime(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_frontend_config::{ApplicationCommand, FrontendCommand, UiCommand};
    use phenix_ui_core::{ElementId, KeyCode, KeyModifiers};

    #[test]
    fn user_configuration_can_remove_and_replace_defaults() {
        let path = temporary_config(
            r#"
phenix.keymap.del("global", "<C-d>")
phenix.keymap.set("sidebar", "x", function()
  phenix.ui.focus.set("ui.input")
end)
"#,
        );
        let mut provider = LuaFrontendProvider::new(LuaFrontendOptions {
            source_path: Some(path.clone()),
            load_defaults: true,
        })
        .expect("Lua provider");

        let global = context(PaneType::Input);
        assert!(provider
            .handle_key(&global, key(KeyCode::Character('d'), true, false, false))
            .expect("removed mapping")
            .is_empty());

        let commands = provider
            .handle_key(
                &context(PaneType::Sidebar),
                key(KeyCode::Character('x'), false, false, false),
            )
            .expect("replacement mapping");
        assert_eq!(
            commands,
            vec![FrontendCommand::Ui(UiCommand::FocusSet(ElementId::input()))]
        );
        fs::remove_file(path).ok();
    }

    #[test]
    fn defaults_are_regular_lua_callbacks() {
        let mut provider =
            LuaFrontendProvider::new(LuaFrontendOptions::default()).expect("Lua provider");
        let commands = provider
            .handle_key(
                &context(PaneType::Global),
                key(KeyCode::Character('d'), true, false, false),
            )
            .expect("default quit mapping");
        assert_eq!(
            commands,
            vec![FrontendCommand::Application(ApplicationCommand::Quit)]
        );
    }

    fn context(pane_type: PaneType) -> FrontendContext {
        FrontendContext {
            focused_element: pane_type.element_id(),
            pane_type,
            overlay_open: pane_type == PaneType::Overlay,
            dialog_open: false,
            input_empty: true,
            details_visible: false,
        }
    }

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

    fn temporary_config(source: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "phenix-lua-config-{}-{}.lua",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        fs::write(&path, source).expect("write config");
        path
    }
}
