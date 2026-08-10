use phenix_acp::{
    BackendId, GatewayError, ModelConfig, RouterId, RoutingDecision, RoutingRequest, RoutingTable,
    SessionRouter, SessionTreeId, ThinkingLevel,
};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SessionRoutingSelection {
    Routing(RouterId),
    Model(ModelConfig),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionRoutingOption {
    pub value: String,
    pub display_name: String,
}

/// Routes every node in one immutable conductor revision according to the
/// session tree's explicit selection.
///
/// A tree starts on the configured default routing table. Selecting another
/// routing table keeps automatic route resolution enabled. Selecting a concrete
/// model pins that complete model configuration and bypasses every routing table
/// for all later workflow/delegation requests in the tree.
#[derive(Clone)]
pub(crate) struct SessionPolicyRouter {
    catalog: Arc<RoutingCatalog>,
    selections: Arc<Mutex<BTreeMap<SessionTreeId, SessionRoutingSelection>>>,
}

#[derive(Debug)]
struct RoutingCatalog {
    default_router: RouterId,
    routers: BTreeMap<RouterId, RoutingTable>,
    models: Vec<ModelConfig>,
}

impl SessionPolicyRouter {
    pub(crate) fn new(
        default_router: RouterId,
        routing_tables: impl IntoIterator<Item = RoutingTable>,
    ) -> Result<Self, GatewayError> {
        let routers = routing_tables
            .into_iter()
            .map(|router| (router.id().clone(), router))
            .collect::<BTreeMap<_, _>>();
        if !routers.contains_key(&default_router) {
            return Err(GatewayError::MissingRouter(default_router));
        }

        let mut seen = BTreeSet::new();
        let mut models = Vec::new();
        for router in routers.values() {
            for rule in router.rules() {
                for (_, model) in rule.models().iter() {
                    let key = model_value(model);
                    if seen.insert(key) {
                        models.push(model.clone());
                    }
                }
            }
        }

        Ok(Self {
            catalog: Arc::new(RoutingCatalog {
                default_router,
                routers,
                models,
            }),
            selections: Arc::new(Mutex::new(BTreeMap::new())),
        })
    }

    pub(crate) fn options(&self, concrete_backend: &BackendId) -> Vec<SessionRoutingOption> {
        let mut options = self
            .catalog
            .routers
            .values()
            .map(|router| SessionRoutingOption {
                value: format!("routing/{}", router.id()),
                display_name: format!("Routing · {}", router.title()),
            })
            .collect::<Vec<_>>();
        options.extend(
            self.catalog
                .models
                .iter()
                .filter(|model| &model.backend == concrete_backend)
                .map(|model| SessionRoutingOption {
                    value: model_value(model),
                    display_name: format!("{}/{}/{}", model.backend, model.provider, model.model),
                }),
        );
        options
    }

    pub(crate) fn current_value(&self, tree_id: &SessionTreeId) -> Result<String, GatewayError> {
        let selection = self
            .selections
            .lock()
            .map_err(|_| GatewayError::routing("session routing selection lock poisoned"))?
            .get(tree_id)
            .cloned()
            .unwrap_or_else(|| {
                SessionRoutingSelection::Routing(self.catalog.default_router.clone())
            });
        Ok(selection_value(&selection))
    }

    pub(crate) fn resolve_selection(
        &self,
        tree_id: &SessionTreeId,
        value: &str,
        concrete_backend: &BackendId,
        thinking: ThinkingLevel,
    ) -> Result<SessionRoutingSelection, GatewayError> {
        if let Some(profile) = value.strip_prefix("routing/") {
            let router_id = RouterId::parse(profile.to_owned())
                .map_err(|error| GatewayError::routing(error.to_string()))?;
            if !self.catalog.routers.contains_key(&router_id) {
                return Err(GatewayError::routing(format!(
                    "routing profile {router_id} is not configured for tree {tree_id}"
                )));
            }
            return Ok(SessionRoutingSelection::Routing(router_id));
        }

        let model = self
            .catalog
            .models
            .iter()
            .find(|model| model_value(model) == value)
            .cloned()
            .ok_or_else(|| {
                GatewayError::routing(format!(
                    "concrete model {value} is not configured for tree {tree_id}"
                ))
            })?;
        if &model.backend != concrete_backend {
            return Err(GatewayError::routing(format!(
                "cannot switch the already-open root session from backend {concrete_backend} to {}; choose a concrete model on the current backend or select a routing profile",
                model.backend
            )));
        }
        Ok(SessionRoutingSelection::Model(ModelConfig {
            thinking,
            ..model
        }))
    }

    pub(crate) fn set_selection(
        &self,
        tree_id: &SessionTreeId,
        selection: SessionRoutingSelection,
    ) -> Result<(), GatewayError> {
        self.selections
            .lock()
            .map_err(|_| GatewayError::routing("session routing selection lock poisoned"))?
            .insert(tree_id.clone(), selection);
        Ok(())
    }

    pub(crate) fn clear(&self, tree_id: &SessionTreeId) -> Result<(), GatewayError> {
        self.selections
            .lock()
            .map_err(|_| GatewayError::routing("session routing selection lock poisoned"))?
            .remove(tree_id);
        Ok(())
    }
}

impl SessionRouter for SessionPolicyRouter {
    fn route(&self, request: &RoutingRequest) -> Result<RoutingDecision, GatewayError> {
        let selection = self
            .selections
            .lock()
            .map_err(|_| GatewayError::routing("session routing selection lock poisoned"))?
            .get(&request.tree_id)
            .cloned()
            .unwrap_or_else(|| {
                SessionRoutingSelection::Routing(self.catalog.default_router.clone())
            });

        match selection {
            SessionRoutingSelection::Routing(router_id) => self
                .catalog
                .routers
                .get(&router_id)
                .ok_or_else(|| GatewayError::MissingRouter(router_id))?
                .route(request),
            SessionRoutingSelection::Model(model) => {
                if !request
                    .available_backends
                    .iter()
                    .any(|backend| backend == &model.backend)
                {
                    return Err(GatewayError::routing(format!(
                        "pinned model selected unavailable backend {} for tree {}",
                        model.backend, request.tree_id
                    )));
                }
                Ok(RoutingDecision {
                    difficulty: request.difficulty,
                    model,
                    explanation: "concrete session model selected; routing table bypassed"
                        .to_owned(),
                })
            }
        }
    }
}

fn selection_value(selection: &SessionRoutingSelection) -> String {
    match selection {
        SessionRoutingSelection::Routing(router) => format!("routing/{router}"),
        SessionRoutingSelection::Model(model) => model_value(model),
    }
}

fn model_value(model: &ModelConfig) -> String {
    format!("{}/{}/{}", model.backend, model.provider, model.model)
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_acp::{
        parse_routing_table, Difficulty, RoleId, SessionTreeId, WorkflowId,
    };

    const ROUTER_A: &str = r#"
# Router A

```phenix-router
id: router.a
```

## Routes

| Role | Workflow | D0 | D1 | D2 | D3 | D4 | Explanation |
|---|---|---|---|---|---|---|---|
| `*` | `*` | `test/provider/model-a/low` | `test/provider/model-a/low` | `test/provider/model-a/medium` | `test/provider/model-a/high` | `test/provider/model-a/max` | route a |
"#;

    const ROUTER_B: &str = r#"
# Router B

```phenix-router
id: router.b
```

## Routes

| Role | Workflow | D0 | D1 | D2 | D3 | D4 | Explanation |
|---|---|---|---|---|---|---|---|
| `*` | `*` | `test/provider/model-b/low` | `test/provider/model-b/low` | `test/provider/model-b/medium` | `test/provider/model-b/high` | `test/provider/model-b/max` | route b |
"#;

    fn policy() -> SessionPolicyRouter {
        SessionPolicyRouter::new(
            RouterId::parse("router.a").expect("router id"),
            [
                parse_routing_table(ROUTER_A).expect("router a"),
                parse_routing_table(ROUTER_B).expect("router b"),
            ],
        )
        .expect("policy router")
    }

    fn request(tree_id: &SessionTreeId) -> RoutingRequest {
        RoutingRequest {
            tree_id: tree_id.clone(),
            parent_node: None,
            role: RoleId::parse("implementer").expect("role id"),
            difficulty: Difficulty::D2,
            objective: "test routing".to_owned(),
            workflow: Some(WorkflowId::parse("workflow.test").expect("workflow id")),
            available_backends: vec![BackendId::parse("test").expect("backend id")],
        }
    }

    #[test]
    fn routing_selection_uses_selected_profile() {
        let policy = policy();
        let tree_id = SessionTreeId::parse("tree-routing").expect("tree id");
        let selection = policy
            .resolve_selection(
                &tree_id,
                "routing/router.b",
                &BackendId::parse("test").expect("backend id"),
                ThinkingLevel::Medium,
            )
            .expect("selection");
        policy
            .set_selection(&tree_id, selection)
            .expect("set selection");

        let decision = policy.route(&request(&tree_id)).expect("route");
        assert_eq!(decision.model.model.as_str(), "model-b");
        assert_eq!(policy.current_value(&tree_id).unwrap(), "routing/router.b");
    }

    #[test]
    fn concrete_model_selection_bypasses_routing_for_workflow_nodes() {
        let policy = policy();
        let tree_id = SessionTreeId::parse("tree-pinned").expect("tree id");
        let backend = BackendId::parse("test").expect("backend id");

        let routed = policy
            .resolve_selection(
                &tree_id,
                "routing/router.b",
                &backend,
                ThinkingLevel::High,
            )
            .expect("routing selection");
        policy
            .set_selection(&tree_id, routed)
            .expect("set routing selection");
        assert_eq!(
            policy.route(&request(&tree_id)).unwrap().model.model.as_str(),
            "model-b"
        );

        let pinned = policy
            .resolve_selection(
                &tree_id,
                "test/provider/model-a",
                &backend,
                ThinkingLevel::High,
            )
            .expect("model selection");
        policy
            .set_selection(&tree_id, pinned)
            .expect("set model selection");

        let decision = policy.route(&request(&tree_id)).expect("route");
        assert_eq!(decision.model.model.as_str(), "model-a");
        assert_eq!(decision.model.thinking, ThinkingLevel::High);
        assert_eq!(policy.current_value(&tree_id).unwrap(), "test/provider/model-a");
    }
}
