from pathlib import Path


def replace_once(path: str, old: str, new: str, already_present: str | None = None) -> None:
    target = Path(path)
    source = target.read_text()
    if old in source:
        target.write_text(source.replace(old, new, 1))
        return
    if already_present is not None and already_present in source:
        return
    raise SystemExit(f"expected repair target not found in {path}")


key_old = "    pub fn len(&self) -> usize {\n        self.strokes.len()\n    }\n"
key_new = key_old + "\n    pub fn is_empty(&self) -> bool {\n        self.strokes.is_empty()\n    }\n"
replace_once(
    "rust/crates/phenix-ui-lua/src/key.rs",
    key_old,
    key_new,
    "pub fn is_empty(&self) -> bool",
)

runtime_old = """            UiMessage::Ui(mut envelope) => {
            if matches!(&envelope.target, RouteTarget::Focused) {
                if let UiEvent::Input(UiInput::Mouse(mouse)) = &envelope.event {
                    if let Some(element) = self.renderer.hit_test(mouse.column, mouse.row) {
                        envelope.target = RouteTarget::Bubble(element);
                    }
                }
            }
            self.router.route_ui(&self.state, &envelope)
        }
"""
runtime_new = """            UiMessage::Ui(mut envelope) => {
                if matches!(&envelope.target, RouteTarget::Focused) {
                    if let UiEvent::Input(UiInput::Mouse(mouse)) = &envelope.event {
                        if let Some(element) = self.renderer.hit_test(mouse.column, mouse.row) {
                            envelope.target = RouteTarget::Bubble(element);
                        }
                    }
                }
                self.router.route_ui(&self.state, &envelope)
            }
"""
replace_once(
    "rust/crates/phenix-ui-runtime/src/runtime.rs",
    runtime_old,
    runtime_new,
    runtime_new,
)

consumers_old = """        let mut state = AppState::default();
        state.exit_requested = true;
        let output = Box::new(BackendOutput::Stopped { result: Ok(()) });
"""
consumers_new = """        let state = AppState {
            exit_requested: true,
            ..AppState::default()
        };
        let output = Box::new(BackendOutput::Stopped { result: Ok(()) });
"""
replace_once(
    "rust/crates/phenix-ui-runtime/src/consumers.rs",
    consumers_old,
    consumers_new,
    consumers_new,
)
