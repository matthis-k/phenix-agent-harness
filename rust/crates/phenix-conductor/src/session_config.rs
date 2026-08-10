use super::{ConductorRuntime, RuntimeError, StandardSession};
use crate::routing::SessionRoutingSelection;
use phenix_acp::{BackendId, GatewayError, SessionCommand, ThinkingLevel};
use serde_json::{json, Value};

const MODEL_CONFIG_ID: &str = "model";

impl ConductorRuntime {
    /// Project the tree's routing policy through standard ACP's model selector.
    ///
    /// Values are deliberately canonical and self-describing:
    /// `routing/<profile>` keeps automatic routing enabled, while
    /// `<backend>/<provider>/<model>` is a concrete model pin.
    pub fn standard_session_config_options(&self, session_id: &str) -> Result<Value, RuntimeError> {
        let context = self.standard_session_routing_context(session_id)?;
        let current_value = self.routing.current_value(&context.session.tree_id)?;
        let options = self
            .routing
            .options(&context.backend)
            .into_iter()
            .map(|option| {
                json!({
                    "value": option.value,
                    "name": option.display_name,
                })
            })
            .collect::<Vec<_>>();

        Ok(json!([{
            "id": MODEL_CONFIG_ID,
            "name": "Model / routing",
            "category": "model",
            "type": "select",
            "currentValue": current_value,
            "options": options,
        }]))
    }

    pub fn set_standard_session_config_option(
        &mut self,
        session_id: &str,
        config_id: &str,
        value: &Value,
    ) -> Result<Value, RuntimeError> {
        if config_id != MODEL_CONFIG_ID {
            return Err(GatewayError::routing(format!(
                "unknown standard ACP session config option {config_id:?}"
            ))
            .into());
        }
        let value = value.as_str().ok_or_else(|| {
            GatewayError::routing(format!(
                "standard ACP session config option {MODEL_CONFIG_ID:?} requires a string value"
            ))
        })?;
        let context = self.standard_session_routing_context(session_id)?;
        let selection = self.routing.resolve_selection(
            &context.session.tree_id,
            value,
            &context.backend,
            context.thinking,
        )?;

        // A concrete selection is both the root session's actual model and the
        // policy used for every future child. Commit the policy only after the
        // downstream model switch succeeds so the two cannot diverge.
        if let SessionRoutingSelection::Model(model) = &selection {
            self.conductor.gateway_mut().execute(
                &context.session.tree_id,
                &context.session.root_node_id,
                SessionCommand::SetModel {
                    model: model.selection(),
                },
            )?;
        }
        self.routing
            .set_selection(&context.session.tree_id, selection)?;
        self.standard_session_config_options(session_id)
    }

    fn standard_session_routing_context(
        &self,
        session_id: &str,
    ) -> Result<StandardSessionRoutingContext, RuntimeError> {
        let session = self.standard_session(session_id)?;
        let snapshot = self.conductor.gateway().snapshot(&session.tree_id)?;
        let root = snapshot
            .nodes
            .iter()
            .find(|node| node.id == session.root_node_id)
            .ok_or_else(|| {
                GatewayError::Invariant(format!(
                    "standard session tree {} has no root node {}",
                    session.tree_id, session.root_node_id
                ))
            })?;
        Ok(StandardSessionRoutingContext {
            session,
            backend: root.model.backend.clone(),
            thinking: root.model.thinking,
        })
    }
}

struct StandardSessionRoutingContext {
    session: StandardSession,
    backend: BackendId,
    thinking: ThinkingLevel,
}
