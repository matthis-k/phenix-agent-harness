use super::{ConductorRuntime, RuntimeError, StandardSession};
use crate::routing::SessionRoutingOption;
use phenix_acp::{
    BackendId, Difficulty, GatewayError, RoleId, SessionCommand, ThinkingLevel,
};
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
        Ok(config_options_value(
            current_value,
            self.routing.options(&context.backend),
        ))
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
        let root_model = self.routing.resolve_root_model(
            &context.session.tree_id,
            &selection,
            context.role,
            context.difficulty,
            context.objective,
            context.thinking,
        )?;
        if root_model.backend != context.backend {
            return Err(GatewayError::routing(format!(
                "routing selection {value} resolves the already-open root session from backend {} to {}; cross-backend root migration is not supported",
                context.backend, root_model.backend
            ))
            .into());
        }

        // Both direct-model and routing-profile selection immediately retarget
        // the root. Only after that succeeds do we commit the policy that will
        // govern every future workflow/delegated node in this tree.
        self.conductor.gateway_mut().execute(
            &context.session.tree_id,
            &context.session.root_node_id,
            SessionCommand::SetModel {
                model: root_model.selection(),
            },
        )?;
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
        let objective = snapshot
            .objectives
            .iter()
            .find(|objective| objective.id == root.objective_id)
            .ok_or_else(|| {
                GatewayError::Invariant(format!(
                    "standard session root objective {} is missing from tree {}",
                    root.objective_id, session.tree_id
                ))
            })?;
        Ok(StandardSessionRoutingContext {
            session,
            backend: root.model.backend.clone(),
            thinking: root.model.thinking,
            role: root.role.clone(),
            difficulty: root.difficulty,
            objective: objective.title.clone(),
        })
    }
}

fn config_options_value(current_value: String, options: Vec<SessionRoutingOption>) -> Value {
    let options = options
        .into_iter()
        .map(|option| {
            json!({
                "value": option.value,
                "name": option.display_name,
            })
        })
        .collect::<Vec<_>>();
    json!([{
        "id": MODEL_CONFIG_ID,
        "name": "Model / routing",
        "category": "model",
        "type": "select",
        "currentValue": current_value,
        "options": options,
    }])
}

struct StandardSessionRoutingContext {
    session: StandardSession,
    backend: BackendId,
    thinking: ThinkingLevel,
    role: RoleId,
    difficulty: Difficulty,
    objective: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_acp_model_option_preserves_canonical_selection_values() {
        let value = config_options_value(
            "routing/mixed".to_owned(),
            vec![
                SessionRoutingOption {
                    value: "routing/mixed".to_owned(),
                    display_name: "Routing · Mixed".to_owned(),
                },
                SessionRoutingOption {
                    value: "pi/openai/gpt-5.6".to_owned(),
                    display_name: "pi/openai/gpt-5.6".to_owned(),
                },
            ],
        );
        assert_eq!(value[0]["category"], "model");
        assert_eq!(value[0]["currentValue"], "routing/mixed");
        assert_eq!(value[0]["options"][1]["value"], "pi/openai/gpt-5.6");
    }
}
