use crate::{AttemptGroup, ExecutionEvent, ExecutionSummary, SessionSummary, WorkspaceDescriptor};
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

pub const SESSION_DEBUG_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionDebugBundle {
    pub schema_version: u32,
    pub session: SessionSummary,
    pub workspace: WorkspaceDescriptor,
    #[serde(default)]
    pub executions: Vec<ExecutionSummary>,
    #[serde(default)]
    pub events: Vec<ExecutionEvent>,
    #[serde(default)]
    pub attempt_groups: Vec<AttemptGroup>,
}

impl SessionDebugBundle {
    #[must_use]
    pub fn new(session: SessionSummary, workspace: WorkspaceDescriptor) -> Self {
        Self {
            schema_version: SESSION_DEBUG_SCHEMA_VERSION,
            session,
            workspace,
            executions: Vec::new(),
            events: Vec::new(),
            attempt_groups: Vec::new(),
        }
    }
}

pub trait SessionDebugSerializer: Send + Sync {
    fn format_id(&self) -> &'static str;
    fn media_type(&self) -> &'static str;
    fn serialize(&self, bundle: &SessionDebugBundle) -> Result<Vec<u8>, DebugSerializeError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct JsonSessionDebugSerializer;

impl SessionDebugSerializer for JsonSessionDebugSerializer {
    fn format_id(&self) -> &'static str {
        "json"
    }

    fn media_type(&self) -> &'static str {
        "application/json"
    }

    fn serialize(&self, bundle: &SessionDebugBundle) -> Result<Vec<u8>, DebugSerializeError> {
        serde_json::to_vec_pretty(bundle).map_err(|error| DebugSerializeError(error.to_string()))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DebugSerializeError(String);

impl Display for DebugSerializeError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Error for DebugSerializeError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        BackendId, ConfigRevisionId, ExecutionTarget, InferenceOptions, ModelId, ModelTarget,
        ProviderId, SessionId, SessionState, WorkspaceId,
    };
    use std::path::PathBuf;

    fn fixture() -> SessionDebugBundle {
        let target = ExecutionTarget::Fixed(ModelTarget {
            backend: BackendId::parse("mock").unwrap(),
            provider: ProviderId::parse("mock").unwrap(),
            model: ModelId::parse("model").unwrap(),
            inference: InferenceOptions::default(),
        });
        SessionDebugBundle::new(
            SessionSummary {
                id: SessionId::parse("session-1").unwrap(),
                parent_session: None,
                name: Some("debug fixture".to_owned()),
                config_revision: ConfigRevisionId::parse("config-1").unwrap(),
                default_target: target,
                state: SessionState::Active,
            },
            WorkspaceDescriptor {
                id: WorkspaceId::parse("workspace-1").unwrap(),
                root: PathBuf::from("/repo"),
                scratch_paths: Default::default(),
            },
        )
    }

    #[test]
    fn json_is_one_serializer_for_the_canonical_bundle() {
        let serializer = JsonSessionDebugSerializer;
        let bytes = serializer.serialize(&fixture()).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

        assert_eq!(serializer.format_id(), "json");
        assert_eq!(serializer.media_type(), "application/json");
        assert_eq!(value["schema_version"], SESSION_DEBUG_SCHEMA_VERSION);
        assert_eq!(value["session"]["id"], "session-1");
        assert_eq!(value["workspace"]["id"], "workspace-1");
    }

    struct MarkerSerializer;

    impl SessionDebugSerializer for MarkerSerializer {
        fn format_id(&self) -> &'static str {
            "marker"
        }

        fn media_type(&self) -> &'static str {
            "application/x-phenix-marker"
        }

        fn serialize(&self, bundle: &SessionDebugBundle) -> Result<Vec<u8>, DebugSerializeError> {
            Ok(format!("session={}", bundle.session.id).into_bytes())
        }
    }

    #[test]
    fn serializers_are_replaceable_without_rebuilding_session_state() {
        let bundle = fixture();
        let serializer: &dyn SessionDebugSerializer = &MarkerSerializer;
        assert_eq!(serializer.serialize(&bundle).unwrap(), b"session=session-1");
    }
}
