use phenix_acp::{
    AcpEndpoint, AcpSessionFactory, BackendDefinition, BackendId, DefinitionId, FixedRouter,
    ModelConfig, ModelId, PhenixAcpGateway, ProviderId, RouterId, SessionTreeDefinition,
    ThinkingLevel,
};
use std::collections::BTreeMap;
use std::error::Error;

pub(crate) fn smoke_gateway<F>(backend: F) -> Result<PhenixAcpGateway, Box<dyn Error>>
where
    F: AcpSessionFactory,
{
    let definition_id = DefinitionId::parse("phenix.smoke")?;
    let router_id = RouterId::parse("phenix.smoke")?;
    let backend_id = BackendId::parse("fixture")?;
    let endpoint = AcpEndpoint::stdio("fixture-acp", Vec::new(), BTreeMap::new())?;
    let definition = SessionTreeDefinition::builder(definition_id, router_id.clone())
        .backend(BackendDefinition::new(backend_id.clone(), endpoint))?
        .build()?;
    let model = ModelConfig {
        backend: backend_id.clone(),
        provider: ProviderId::parse("fixture")?,
        model: ModelId::parse("fixture-model")?,
        thinking: ThinkingLevel::Medium,
    };
    Ok(PhenixAcpGateway::builder()
        .definition(definition)?
        .router(router_id, FixedRouter::new(model))?
        .backend(backend_id, backend)?
        .build()?)
}
