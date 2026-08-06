use agent_client_protocol::schema::v1::{
    AgentCapabilities, ClientRequest, ContentBlock, ContentChunk, InitializeResponse,
    NewSessionResponse, PromptResponse, SessionNotification, SessionUpdate, StopReason, TextContent,
};
use agent_client_protocol::{Agent, Stdio};
use std::error::Error;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn Error>> {
    Agent
        .builder()
        .name("phenix-conductor-fixture-agent")
        .on_receive_request(
            async move |request: ClientRequest, responder, connection| {
                let response = match request {
                    ClientRequest::InitializeRequest(initialize) => serde_json::to_value(
                        InitializeResponse::new(initialize.protocol_version)
                            .agent_capabilities(AgentCapabilities::new()),
                    )
                    .map_err(agent_client_protocol::Error::into_internal_error)?,
                    ClientRequest::NewSessionRequest(_) => {
                        serde_json::to_value(NewSessionResponse::new("fixture-session"))
                            .map_err(agent_client_protocol::Error::into_internal_error)?
                    }
                    ClientRequest::PromptRequest(prompt) => {
                        let text = prompt
                            .prompt
                            .into_iter()
                            .filter_map(|block| match block {
                                ContentBlock::Text(text) => Some(text.text),
                                _ => None,
                            })
                            .collect::<Vec<_>>()
                            .join("\n");
                        connection.send_notification(SessionNotification::new(
                            prompt.session_id,
                            SessionUpdate::AgentMessageChunk(ContentChunk::new(
                                ContentBlock::Text(TextContent::new(format!("echo: {text}"))),
                            )),
                        ))?;
                        serde_json::to_value(PromptResponse::new(StopReason::EndTurn))
                            .map_err(agent_client_protocol::Error::into_internal_error)?
                    }
                    _ => return Err(agent_client_protocol::Error::method_not_found()),
                };
                responder.respond(response)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_to(Stdio::new())
        .await?;
    Ok(())
}
