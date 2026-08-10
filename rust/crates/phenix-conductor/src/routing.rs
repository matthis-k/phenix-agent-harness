use phenix_acp::{
    BackendId, GatewayError, ModelConfig, RouterId, RoutingDecision, RoutingRequest, RoutingTable,
    SessionRouter, SessionTreeId, ThinkingLevel,
};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionRoutingSelection {
    Routing(RouterId),
    Model(ModelConfig),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionRoutingOption {
    pub value: String,
    pub display_name: String,
}

#[derive(Clone)]
pub(crate) struct SessionPolicyRouter {
    catalog: Arc<RoutingCatalog>,
}

#[derive(Debug)]
struct RoutingCatalog {
    default_router: RouterId,
    routers: BTreeMap<RouterId, RoutingTable>,
    models: Vec<ModelConfig>,
}

static TREE_CATALOGS: OnceLock<Mutex<BTreeMap<SessionTreeId, Arc<RoutingCatalog>>>> =
    OnceLock::new();
static TREE_SELECTIONS: OnceLock<Mutex<BTreeMap<SessionTreeId, SessionRoutingSelection>>> =
    OnceLock::new();

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
        })
    }
}

impl SessionRouter for SessionPolicyRouter {
    fn route(&self, request: &RoutingRequest) -> Result<RoutingDecision, GatewayError> {
        catalogs()
            .lock()
            .map_err(|_| GatewayError::routing("session routing catalog lock poisoned"))?
            .insert(request.tree_id.clone(), Arc::clone(&self.catalog));

        let selection = selections()
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

pub fn session_routing_options(
    tree_id: &SessionTreeId,
    concrete_backend: &BackendId,
) -> Result<Vec<SessionRoutingOption>, GatewayError> {
    let catalog = catalog(tree_id)?;
    let mut options = catalog
        .routers
        .values()
        .map(|router| SessionRoutingOption {
            value: format!("routing/{}", router.id()),
            display_name: format!("Routing · {}", router.title()),
        })
        .collect::<Vec<_>>();
    options.extend(
        catalog
            .models
            .iter()
            .filter(|model| &model.backend == concrete_backend)
            .map(|model| SessionRoutingOption {
                value: model_value(model),
                display_name: format!("{}/{}/{}", model.backend, model.provider, model.model),
            }),
    );
    Ok(options)
}

pub fn current_session_routing_value(tree_id: &SessionTreeId) -> Result<String, GatewayError> {
    let catalog = catalog(tree_id)?;
    let selection = selections()
        .lock()
        .map_err(|_| GatewayError::routing("session routing selection lock poisoned"))?
        .get(tree_id)
        .cloned()
        .unwrap_or_else(|| SessionRoutingSelection::Routing(catalog.default_router.clone()));
    Ok(selection_value(&selection))
}

pub fn select_session_routing(
    tree_id: &SessionTreeId,
    value: &str,
    concrete_backend: &BackendId,
    thinking: ThinkingLevel,
) -> Result<SessionRoutingSelection, GatewayError> {
    let catalog = catalog(tree_id)?;
    let selection = if let Some(profile) = value.strip_prefix("routing/") {
        let router_id = RouterId::parse(profile.to_owned())
            .map_err(|error| GatewayError::routing(error.to_string()))?;
        if !catalog.routers.contains_key(&router_id) {
            return Err(GatewayError::routing(format!(
                "routing profile {router_id} is not configured for tree {tree_id}"
            )));
        }
        SessionRoutingSelection::Routing(router_id)
    } else {
        let model = catalog
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
                "cannot switch the already-open root session from backend {concrete_backend} to {}; select a routing profile to route delegated work across backends",
                model.backend
            )));
        }
        SessionRoutingSelection::Model(ModelConfig { thinking, ..model })
    };

    selections()
        .lock()
        .map_err(|_| GatewayError::routing("session routing selection lock poisoned"))?
        .insert(tree_id.clone(), selection.clone());
    Ok(selection)
}

pub fn clear_session_routing(tree_id: &SessionTreeId) {
    if let Ok(mut catalogs) = catalogs().lock() {
        catalogs.remove(tree_id);
    }
    if let Ok(mut selections) = selections().lock() {
        selections.remove(tree_id);
    }
}

fn catalog(tree_id: &SessionTreeId) -> Result<Arc<RoutingCatalog>, GatewayError> {
    catalogs()
        .lock()
        .map_err(|_| GatewayError::routing("session routing catalog lock poisoned"))?
        .get(tree_id)
        .cloned()
        .ok_or_else(|| GatewayError::UnknownTree(tree_id.clone()))
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

fn catalogs() -> &'static Mutex<BTreeMap<SessionTreeId, Arc<RoutingCatalog>>> {
    TREE_CATALOGS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn selections() -> &'static Mutex<BTreeMap<SessionTreeId, SessionRoutingSelection>> {
    TREE_SELECTIONS.get_or_init(|| Mutex::new(BTreeMap::new()))
}
