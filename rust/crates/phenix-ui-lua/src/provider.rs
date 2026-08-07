use crate::acp::{install_acp_api, AcpApplicationConfig, AcpConfigurationState};
use crate::api::install_api;
use crate::key::KeyChord;
use mlua::{Function, Lua, RegistryKey, Table};
use phenix_frontend_config::{
    FrontendCommand, FrontendConfig, FrontendConfigProvider, FrontendContext,
    FrontendProviderError, KeymapDescription, PaneType,
};
use phenix_ui_core::{KeyCode, KeyInput};
use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

const DEFAULT_CONFIG: &str = include_str!("../default.lua");
const KEY_SEQUENCE_TIMEOUT: Duration = Duration::from_millis(500);

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
    acp_config: Option<AcpApplicationConfig>,
    pending_keys: Vec<KeyInput>,
    pending_since: Option<Instant>,
}

enum KeyResolution {
    None,
    Prefix,
    Callback(Function),
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
            acp_config: built.acp_config,
            pending_keys: Vec::new(),
            pending_since: None,
        })
    }

    pub fn default_source() -> &'static str {
        DEFAULT_CONFIG
    }

    pub fn acp_config(&self) -> Option<&AcpApplicationConfig> {
        self.acp_config.as_ref()
    }

    fn sync_config(&mut self) {
        let mut state = self.state.borrow_mut();
        state.refresh_keymap_descriptions();
        self.config = state.config.clone();
    }

    fn clear_pending_keys(&mut self) {
        self.pending_keys.clear();
        self.pending_since = None;
    }

    fn expire_pending_keys(&mut self, now: Instant) {
        if self
            .pending_since
            .is_some_and(|started| now.duration_since(started) >= KEY_SEQUENCE_TIMEOUT)
        {
            self.clear_pending_keys();
        }
    }

    fn resolve_scope(
        &self,
        pane: PaneType,
        inputs: &[KeyInput],
    ) -> Result<KeyResolution, FrontendProviderError> {
        let state = self.state.borrow();
        if let Some(binding) = state
            .bindings
            .iter()
            .rev()
            .find(|binding| binding.pane == pane && binding.chord.matches_inputs(inputs))
        {
            return self
                .lua
                .registry_value::<Function>(&binding.callback)
                .map(KeyResolution::Callback)
                .map_err(lua_runtime_error);
        }
        if state
            .bindings
            .iter()
            .any(|binding| binding.pane == pane && binding.chord.starts_with_inputs(inputs))
        {
            return Ok(KeyResolution::Prefix);
        }
        Ok(KeyResolution::None)
    }

    fn resolve_pending(
        &self,
        context: &FrontendContext,
    ) -> Result<KeyResolution, FrontendProviderError> {
        match self.resolve_scope(context.pane_type, &self.pending_keys)? {
            KeyResolution::None if context.pane_type != PaneType::Global => {
                self.resolve_scope(PaneType::Global, &self.pending_keys)
            }
            resolution => Ok(resolution),
        }
    }

    fn callback_for(
        &mut self,
        context: &FrontendContext,
        input: KeyInput,
    ) -> Result<KeyResolution, FrontendProviderError> {
        let now = Instant::now();
        self.expire_pending_keys(now);

        if input.code == KeyCode::Escape && !self.pending_keys.is_empty() {
            self.clear_pending_keys();
            return Ok(KeyResolution::Prefix);
        }

        let had_pending = !self.pending_keys.is_empty();
        self.pending_keys.push(input);
        match self.resolve_pending(context)? {
            KeyResolution::Callback(callback) => {
                self.clear_pending_keys();
                Ok(KeyResolution::Callback(callback))
            }
            KeyResolution::Prefix => {
                self.pending_since.get_or_insert(now);
                Ok(KeyResolution::Prefix)
            }
            KeyResolution::None if had_pending => {
                self.clear_pending_keys();
                self.pending_keys.push(input);
                match self.resolve_pending(context)? {
                    KeyResolution::Callback(callback) => {
                        self.clear_pending_keys();
                        Ok(KeyResolution::Callback(callback))
                    }
                    KeyResolution::Prefix => {
                        self.pending_since = Some(now);
                        Ok(KeyResolution::Prefix)
                    }
                    KeyResolution::None => {
                        self.clear_pending_keys();
                        Ok(KeyResolution::None)
                    }
                }
            }
            KeyResolution::None => {
                self.clear_pending_keys();
                Ok(KeyResolution::None)
            }
        }
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
        let callback = match self.callback_for(context, input)? {
            KeyResolution::Callback(callback) => callback,
            KeyResolution::Prefix => return Ok(vec![FrontendCommand::Handled]),
            KeyResolution::None => return Ok(Vec::new()),
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
        self.acp_config = built.acp_config;
        self.clear_pending_keys();
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
    pub acp: AcpConfigurationState,
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
    acp_config: Option<AcpApplicationConfig>,
}

fn build_provider(options: &LuaFrontendOptions) -> Result<BuiltProvider, FrontendProviderError> {
    let lua = Lua::new();
    let state = Rc::new(RefCell::new(LuaState::default()));
    let commands = Rc::new(RefCell::new(Vec::new()));
    install_api(&lua, Rc::clone(&state), Rc::clone(&commands))?;
    install_acp_api(&lua, Rc::clone(&state))?;

    if options.load_defaults {
        execute(&lua, DEFAULT_CONFIG, "@phenix/default.lua")?;
    }
    if let Some(path) = &options.source_path {
        let source = fs::read_to_string(path)
            .map_err(|error| FrontendProviderError::io(path, error.to_string()))?;
        execute(&lua, &source, &format!("@{}", path.display()))?;
    }

    let (config, acp_config) = {
        let mut state = state.borrow_mut();
        state.refresh_keymap_descriptions();
        (state.config.clone(), state.acp.configuration())
    };
    Ok(BuiltProvider {
        lua,
        state,
        commands,
        config,
        acp_config,
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
phenix.keymap.del("global", "<C-q>")
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
            .handle_key(&global, key(KeyCode::Character('q'), true, false, false))
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
                key(KeyCode::Character('q'), true, false, false),
            )
            .expect("default quit mapping");
        assert_eq!(
            commands,
            vec![FrontendCommand::Application(ApplicationCommand::Quit)]
        );
    }

    #[test]
    fn resolves_neovim_sequences_with_pane_precedence() {
        let path = temporary_config(
            r#"
phenix.keymap.set("global", "gg", function()
  phenix.ui.focus.set("ui.transcript")
end)
phenix.keymap.set("sidebar", "gg", function()
  phenix.ui.focus.set("ui.input")
end)
phenix.keymap.set("global", "<leader>fm", phenix.action.models)
"#,
        );
        let mut provider = LuaFrontendProvider::new(LuaFrontendOptions {
            source_path: Some(path.clone()),
            load_defaults: false,
        })
        .expect("Lua provider");

        let sidebar = context(PaneType::Sidebar);
        assert_eq!(
            provider
                .handle_key(&sidebar, key(KeyCode::Character('g'), false, false, false))
                .expect("prefix"),
            vec![FrontendCommand::Handled]
        );
        assert_eq!(
            provider
                .handle_key(&sidebar, key(KeyCode::Character('g'), false, false, false))
                .expect("complete"),
            vec![FrontendCommand::Ui(UiCommand::FocusSet(ElementId::input()))]
        );

        let global = context(PaneType::Transcript);
        for character in [' ', 'f'] {
            assert_eq!(
                provider
                    .handle_key(&global, key(KeyCode::Character(character), false, false, false))
                    .expect("leader prefix"),
                vec![FrontendCommand::Handled]
            );
        }
        assert_eq!(
            provider
                .handle_key(&global, key(KeyCode::Character('m'), false, false, false))
                .expect("leader completion"),
            vec![FrontendCommand::Application(
                ApplicationCommand::OpenModelPicker
            )]
        );
        fs::remove_file(path).ok();
    }

    #[test]
    fn failed_prefix_retries_the_current_key() {
        let path = temporary_config(
            r#"
phenix.keymap.set("global", "gg", phenix.action.quit)
phenix.keymap.set("global", "x", phenix.action.models)
"#,
        );
        let mut provider = LuaFrontendProvider::new(LuaFrontendOptions {
            source_path: Some(path.clone()),
            load_defaults: false,
        })
        .expect("Lua provider");
        let global = context(PaneType::Transcript);
        assert_eq!(
            provider
                .handle_key(&global, key(KeyCode::Character('g'), false, false, false))
                .expect("prefix"),
            vec![FrontendCommand::Handled]
        );
        assert_eq!(
            provider
                .handle_key(&global, key(KeyCode::Character('x'), false, false, false))
                .expect("retry x"),
            vec![FrontendCommand::Application(
                ApplicationCommand::OpenModelPicker
            )]
        );
        fs::remove_file(path).ok();
    }

    #[test]
    fn escape_cancels_a_pending_sequence_without_running_an_action() {
        let path = temporary_config(
            r#"
phenix.keymap.set("global", "gg", phenix.action.quit)
"#,
        );
        let mut provider = LuaFrontendProvider::new(LuaFrontendOptions {
            source_path: Some(path.clone()),
            load_defaults: false,
        })
        .expect("Lua provider");
        let global = context(PaneType::Transcript);
        assert_eq!(
            provider
                .handle_key(&global, key(KeyCode::Character('g'), false, false, false))
                .expect("prefix"),
            vec![FrontendCommand::Handled]
        );
        assert_eq!(
            provider
                .handle_key(&global, key(KeyCode::Escape, false, false, false))
                .expect("cancel prefix"),
            vec![FrontendCommand::Handled]
        );
        fs::remove_file(path).ok();
    }

    #[test]
    fn lua_configuration_declares_acp_runtime_and_definition_sources() {
        let path = temporary_config(
            r#"
phenix.acp.configure({
  definition_id = "phenix.harness",
  router = "router.mixed",
  backend = { id = "pi", command = "pi-acp" },
  root = {
    tree_id = "tree-frontend",
    role = "coordinator",
    objective = "Interactive tree",
  },
})
phenix.acp.workflow("workflows/implement.md")
phenix.acp.routing_table({ source = [[
# Router
```phenix-router
id: router.mixed
```
## Routes
| Role | Workflow | Target | Explanation |
|---|---|---|---|
| `*` | `*` | `pi/provider/model` | fallback |
]], format = "markdown" })
"#,
        );
        let provider = LuaFrontendProvider::new(LuaFrontendOptions {
            source_path: Some(path.clone()),
            load_defaults: false,
        })
        .expect("Lua provider");
        let config = provider.acp_config().expect("ACP config");
        assert_eq!(config.definition_id().as_str(), "phenix.harness");
        assert_eq!(config.router().as_str(), "router.mixed");
        assert_eq!(config.backend().id().as_str(), "pi");
        assert_eq!(config.definitions().len(), 2);
        fs::remove_file(path).ok();
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
