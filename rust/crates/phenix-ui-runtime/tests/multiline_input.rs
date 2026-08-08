use phenix_frontend_config::{
    FrontendCommand, FrontendConfig, FrontendConfigProvider, FrontendContext,
    FrontendProviderError, FrontendProviderRef,
};
use phenix_ui_core::{AppState, EventEnvelope, KeyCode, KeyInput, KeyModifiers, UiInput};
use phenix_ui_runtime::{
    BusReaction, EventConsumer, FrontendProviderConsumer, InputEdit, UiEvent, ViewMutation,
};
use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;

#[derive(Default)]
struct EmptyProvider {
    config: FrontendConfig,
}

impl FrontendConfigProvider for EmptyProvider {
    fn config(&self) -> &FrontendConfig {
        &self.config
    }

    fn handle_key(
        &mut self,
        _context: &FrontendContext,
        _input: KeyInput,
    ) -> Result<Vec<FrontendCommand>, FrontendProviderError> {
        Ok(Vec::new())
    }

    fn reload(&mut self) -> Result<(), FrontendProviderError> {
        Ok(())
    }

    fn source_path(&self) -> Option<&Path> {
        None
    }
}

fn enter(shift: bool) -> EventEnvelope<UiEvent> {
    EventEnvelope::focused(UiEvent::Input(UiInput::Key(KeyInput {
        code: KeyCode::Enter,
        modifiers: KeyModifiers {
            shift,
            ..KeyModifiers::default()
        },
        repeat: false,
    })))
}

fn consumer() -> FrontendProviderConsumer {
    let provider: FrontendProviderRef = Rc::new(RefCell::new(EmptyProvider::default()));
    FrontendProviderConsumer::new(provider)
}

#[test]
fn shift_enter_inserts_a_newline_instead_of_submitting() {
    let mut consumer = consumer();
    let reactions = consumer.on_ui(&AppState::default(), &enter(true));

    assert_eq!(
        reactions.reactions,
        vec![BusReaction::View(ViewMutation::EditInput(
            InputEdit::Insert("\n".to_owned())
        ))]
    );
}

#[test]
fn plain_enter_remains_the_submit_action() {
    let mut consumer = consumer();
    let reactions = consumer.on_ui(&AppState::default(), &enter(false));

    assert!(matches!(
        reactions.reactions.as_slice(),
        [BusReaction::App(phenix_ui_core::AppEvent::User(
            phenix_ui_core::UserIntent::SubmitPrompt
        ))]
    ));
}
