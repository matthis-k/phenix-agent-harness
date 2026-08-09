use agent_client_protocol::schema::v1::{
    AgentCapabilities, ClientRequest, ContentBlock, ContentChunk, InitializeResponse,
    PromptResponse, SessionNotification, SessionUpdate, StopReason, TextContent,
};
use agent_client_protocol::{Agent, Stdio};
use serde_json::{json, Value};
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
                    ClientRequest::NewSessionRequest(_) => json!({
                        "sessionId": "fixture-session",
                        "configOptions": fixture_config_options(),
                    }),
                    ClientRequest::SetSessionConfigOptionRequest(request) => {
                        let value = serde_json::to_value(&request.value)
                            .map_err(agent_client_protocol::Error::into_internal_error)?;
                        json!({
                            "configOptions": fixture_config_options_with(
                                &request.config_id.to_string(),
                                &value,
                            ),
                        })
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

fn fixture_config_options() -> Value {
    fixture_config_options_with("", &Value::Null)
}

fn fixture_config_options_with(config_id: &str, value: &Value) -> Value {
    let selected_model = if config_id == "model" {
        value.as_str().unwrap_or("provider/model")
    } else {
        "provider/model"
    };
    let selected_thinking = if config_id == "thinking" {
        value.as_str().unwrap_or("medium")
    } else {
        "medium"
    };
    json!([
        {
            "id": "model",
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": selected_model,
            "options": [{
                "value": "provider/model",
                "name": "Fixture Model",
            }],
        },
        {
            "id": "thinking",
            "name": "Thinking",
            "category": "thought_level",
            "type": "select",
            "currentValue": selected_thinking,
            "options": [
                { "value": "minimal", "name": "Minimal" },
                { "value": "low", "name": "Low" },
                { "value": "medium", "name": "Medium" },
                { "value": "high", "name": "High" },
                { "value": "max", "name": "Max" }
            ],
        }
    ])
}
