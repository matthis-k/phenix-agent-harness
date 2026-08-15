use phenix_conductor::resolve_child_target;
use phenix_runtime_api::{ExecutionTarget, ModelTarget};

#[test]
fn direct_model_target_cannot_fall_back_into_routing() {
    let fixed = ExecutionTarget::Fixed {
        model: ModelTarget {
            backend: "backend".to_owned(),
            provider: "provider".to_owned(),
            model: "model".to_owned(),
        },
    };
    let child = resolve_child_target(
        &fixed,
        Some(ExecutionTarget::Routed {
            profile: "mixed".to_owned(),
        }),
    );
    assert_eq!(child, fixed);
}
