use agent_client_protocol::schema::v1::{
    ClientCapabilities, ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest,
    SessionId,
};
use agent_client_protocol::schema::ProtocolVersion;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::error::Error;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const RESPONSE_TIMEOUT: Duration = Duration::from_secs(20);

#[test]
fn inbound_prompt_routes_models_and_completes_a_delegation_tool_loop() -> Result<(), Box<dyn Error>>
{
    let mock_agent = PathBuf::from(env!("CARGO_BIN_EXE_mock-acp-agent"));
    let conductor = PathBuf::from(env!("CARGO_BIN_EXE_phenix-conductor"));
    let cwd = std::env::current_dir()?;
    let coordinator_log = unique_temp_path("phenix-mock-coordinator", "jsonl");
    let specialist_log = unique_temp_path("phenix-mock-specialist", "jsonl");

    let mut process = RpcProcess::spawn(&conductor, &cwd)?;
    process.send_request(
        1,
        "initialize",
        &InitializeRequest::new(ProtocolVersion::V1).client_capabilities(ClientCapabilities::new()),
    )?;
    process.receive_response(1)?;

    process.send_request(
        100,
        "_phenix/config/apply",
        &configuration_json(&mock_agent, &coordinator_log, &specialist_log),
    )?;
    let configured = process.receive_response(100)?;
    assert_eq!(configured["result"]["revision"], 1);
    assert_eq!(
        configured["result"]["definition_id"],
        "definition.black-box"
    );

    process.send_request(2, "session/new", &NewSessionRequest::new(&cwd))?;
    let created = process.receive_response(2)?;
    let tree_id = required_string(&created["result"], "sessionId")?;

    process.send_request(
        3,
        "_phenix/session_tree/get",
        &json!({ "tree_id": tree_id }),
    )?;
    let tree = process.receive_response(3)?;
    let root_node = required_string(&tree["result"], "root")?;
    assert_eq!(tree["result"]["nodes"][0]["backend"], "coordinator");
    assert_eq!(tree["result"]["nodes"][0]["model"]["provider"], "mock");
    assert_eq!(tree["result"]["nodes"][0]["model"]["model"], "coordinator");

    let coordinator_models = backend_models(&mut process, 4, &tree_id, "coordinator")?;
    assert_model_catalog(
        &coordinator_models,
        &["mock/coordinator", "mock/coordinator-unused"],
    );
    let specialist_models = backend_models(&mut process, 5, &tree_id, "specialist")?;
    assert_model_catalog(
        &specialist_models,
        &["mock/specialist", "mock/specialist-alternate"],
    );

    process.send_request(
        6,
        "session/prompt",
        &PromptRequest::new(
            SessionId::new(tree_id.clone()),
            vec![ContentBlock::from("solve the black-box task")],
        ),
    )?;
    let (initial_response, tool_input) = receive_prompt_with_tool(&process, 6, "phenix.delegate")?;
    assert!(initial_response
        .to_string()
        .contains("delegating to specialist"));
    assert_eq!(tool_input["role"], "specialist");
    assert_eq!(tool_input["objective"], "compute the deterministic answer");
    assert_eq!(tool_input["prompt"], "calculate 6 * 7");

    process.send_request(
        7,
        "_phenix/node/delegate",
        &json!({
            "tree_id": tree_id,
            "parent_node": root_node,
            "role": tool_input["role"],
            "objective": tool_input["objective"],
        }),
    )?;
    let delegated = process.receive_response(7)?;
    let specialist_node = required_string(&delegated["result"], "node_id")?;

    process.send_request(
        8,
        "_phenix/node/execute",
        &json!({
            "tree_id": tree_id,
            "node_id": specialist_node,
            "command": {
                "kind": "prompt",
                "text": tool_input["prompt"],
                "images": [],
            }
        }),
    )?;
    let mut specialist_results = vec![process.receive_response(8)?];
    for poll_id in 8_000..8_250 {
        if specialist_results
            .iter()
            .any(|result| result.to_string().contains("42"))
        {
            break;
        }
        thread::sleep(Duration::from_millis(20));
        process.send_request(
            poll_id,
            "_phenix/node/execute",
            &json!({
                "tree_id": tree_id,
                "node_id": specialist_node,
                "command": { "kind": "poll" }
            }),
        )?;
        specialist_results.push(process.receive_response(poll_id)?);
    }
    assert!(
        specialist_results
            .iter()
            .any(|result| result.to_string().contains("42")),
        "specialist response did not traverse the conductor: {specialist_results:?}"
    );

    process.send_request(
        9,
        "session/prompt",
        &PromptRequest::new(
            SessionId::new(tree_id.clone()),
            vec![ContentBlock::from("tool-result: 42")],
        ),
    )?;
    let final_messages = receive_prompt(&process, 9)?;
    assert!(
        final_messages
            .iter()
            .any(|message| message.to_string().contains("final answer: 42")),
        "coordinator final answer was not projected upstream: {final_messages:?}"
    );
    assert!(
        final_messages.iter().any(|message| {
            message.to_string().contains("toolCallId")
                && message.to_string().contains("completed")
                && message.to_string().contains("42")
        }),
        "completed tool lifecycle was not projected upstream: {final_messages:?}"
    );

    process.send_request(
        10,
        "_phenix/session_tree/get",
        &json!({ "tree_id": tree_id }),
    )?;
    let completed_tree = process.receive_response(10)?;
    let nodes = completed_tree["result"]["nodes"]
        .as_array()
        .ok_or("tree snapshot did not contain nodes")?;
    assert_eq!(nodes.len(), 2);
    let child = nodes
        .iter()
        .find(|node| node["id"] == specialist_node)
        .ok_or("delegated specialist node is missing")?;
    assert_eq!(child["parent"], root_node);
    assert_eq!(child["backend"], "specialist");
    assert_eq!(child["model"]["provider"], "mock");
    assert_eq!(child["model"]["model"], "specialist");

    let coordinator_events = read_json_lines(&coordinator_log)?;
    assert_log_event(
        &coordinator_events,
        "model_selected",
        "mock/coordinator",
        None,
    );
    assert_log_event(
        &coordinator_events,
        "prompt_received",
        "mock/coordinator",
        Some("solve the black-box task"),
    );
    assert!(coordinator_events.iter().any(|event| {
        event["kind"] == "tool_emitted"
            && event["tool"] == "phenix.delegate"
            && event["input"]["role"] == "specialist"
    }));
    assert!(coordinator_events.iter().any(|event| {
        event["kind"] == "tool_completed"
            && event["tool"] == "phenix.delegate"
            && event["result"] == "42"
    }));

    let specialist_events = read_json_lines(&specialist_log)?;
    assert_log_event(
        &specialist_events,
        "model_selected",
        "mock/specialist",
        None,
    );
    assert_log_event(
        &specialist_events,
        "prompt_received",
        "mock/specialist",
        Some("calculate 6 * 7"),
    );

    process.shutdown();
    for path in [coordinator_log, specialist_log] {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

fn backend_models(
    process: &mut RpcProcess,
    id: u64,
    tree_id: &str,
    backend: &str,
) -> Result<Value, Box<dyn Error>> {
    process.send_request(
        id,
        "_phenix/backend/model/list",
        &json!({ "tree_id": tree_id, "backend": backend }),
    )?;
    Ok(process.receive_response(id)?["result"]["models"].clone())
}

fn assert_model_catalog(models: &Value, expected: &[&str]) {
    let actual = models
        .as_array()
        .expect("model list must be an array")
        .iter()
        .map(|model| format!("{}/{}", model["provider"], model["model"]).replace('"', ""))
        .collect::<Vec<_>>();
    assert_eq!(actual, expected);
}

fn receive_prompt_with_tool(
    process: &RpcProcess,
    response_id: u64,
    tool_name: &str,
) -> Result<(Value, Value), Box<dyn Error>> {
    let mut messages = Vec::new();
    let mut tool_input = None;
    loop {
        let message = process.receive()?;
        if let Some(tool) = find_tool(&message, tool_name) {
            tool_input = tool.get("rawInput").cloned();
        }
        if message.get("id") == Some(&Value::from(response_id)) {
            break;
        }
        messages.push(message);
    }
    let input = tool_input.ok_or("expected tool call was not projected upstream")?;
    Ok((Value::Array(messages), input))
}

fn receive_prompt(process: &RpcProcess, response_id: u64) -> Result<Vec<Value>, Box<dyn Error>> {
    let mut messages = Vec::new();
    loop {
        let message = process.receive()?;
        if message.get("id") == Some(&Value::from(response_id)) {
            break;
        }
        messages.push(message);
    }
    Ok(messages)
}

fn find_tool<'a>(value: &'a Value, title: &str) -> Option<&'a Map<String, Value>> {
    match value {
        Value::Object(object) => {
            if object.get("title").and_then(Value::as_str) == Some(title)
                && object.contains_key("rawInput")
            {
                return Some(object);
            }
            object.values().find_map(|value| find_tool(value, title))
        }
        Value::Array(values) => values.iter().find_map(|value| find_tool(value, title)),
        _ => None,
    }
}

fn assert_log_event(events: &[Value], kind: &str, model: &str, text: Option<&str>) {
    assert!(events.iter().any(|event| {
        event["kind"] == kind
            && event["model"] == model
            && text.is_none_or(|text| event["text"] == text)
    }));
}

fn read_json_lines(path: &Path) -> Result<Vec<Value>, Box<dyn Error>> {
    let file = fs::File::open(path)?;
    BufReader::new(file)
        .lines()
        .map(|line| Ok(serde_json::from_str(&line?)?))
        .collect()
}

fn configuration_json(mock_agent: &Path, coordinator_log: &Path, specialist_log: &Path) -> Value {
    let routing = r#"
# Black-box routing

```phenix-router
id: router.black-box
```

## Routes

| Role | Workflow | Target | Explanation |
|---|---|---|---|
| `coordinator` | `*` | `coordinator/mock/coordinator` | deterministic coordinator |
| `specialist` | `*` | `specialist/mock/specialist` | deterministic specialist |
| `*` | `*` | `coordinator/mock/coordinator` | fallback coordinator |
"#;
    let coordinator = json!({
        "backend_id": "coordinator",
        "default_model": "mock/coordinator-unused",
        "log_path": coordinator_log,
        "models": [
            {
                "id": "mock/coordinator",
                "display_name": "Mock Coordinator",
                "response": "delegating to specialist",
                "final_response": "final answer: 42",
                "tool_call": {
                    "name": "phenix.delegate",
                    "input": {
                        "role": "specialist",
                        "objective": "compute the deterministic answer",
                        "prompt": "calculate 6 * 7"
                    }
                }
            },
            {
                "id": "mock/coordinator-unused",
                "display_name": "Unused Coordinator",
                "response": "wrong coordinator model"
            }
        ]
    });
    let specialist = json!({
        "backend_id": "specialist",
        "default_model": "mock/specialist-alternate",
        "log_path": specialist_log,
        "models": [
            {
                "id": "mock/specialist",
                "display_name": "Mock Specialist",
                "response": "42"
            },
            {
                "id": "mock/specialist-alternate",
                "display_name": "Alternate Specialist",
                "response": "wrong specialist model"
            }
        ]
    });
    json!({
        "source_root": ".",
        "input": {
            "definition_id": "definition.black-box",
            "router": "router.black-box",
            "root": {
                "tree_id": "black-box-root",
                "role": "coordinator",
                "objective": "exercise the complete adapter path"
            },
            "backends": [
                {
                    "id": "coordinator",
                    "command": format!("{:?}", mock_agent),
                    "environment": {
                        "PHENIX_MOCK_ACP_CONFIG": coordinator.to_string()
                    }
                },
                {
                    "id": "specialist",
                    "command": format!("{:?}", mock_agent),
                    "environment": {
                        "PHENIX_MOCK_ACP_CONFIG": specialist.to_string()
                    }
                }
            ],
            "definitions": [{
                "kind": "routing_table",
                "source": {
                    "kind": "inline",
                    "source": routing,
                    "format": "markdown"
                }
            }]
        }
    })
}

fn required_string(value: &Value, key: &str) -> Result<String, Box<dyn Error>> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("missing string field {key:?}").into())
}

fn unique_temp_path(stem: &str, extension: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("{stem}-{}-{nonce}.{extension}", std::process::id()))
}

struct RpcProcess {
    child: Child,
    stdin: ChildStdin,
    messages: Receiver<Value>,
}

impl RpcProcess {
    fn spawn(conductor: &Path, cwd: &Path) -> Result<Self, Box<dyn Error>> {
        let mut child = Command::new(conductor)
            .arg("--cwd")
            .arg(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let stdin = child.stdin.take().ok_or("missing conductor stdin")?;
        let stdout = child.stdout.take().ok_or("missing conductor stdout")?;
        let (sender, messages) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                let Ok(message) = serde_json::from_str(&line) else {
                    continue;
                };
                if sender.send(message).is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            stdin,
            messages,
        })
    }

    fn send_request<T: Serialize>(
        &mut self,
        id: u64,
        method: &str,
        params: &T,
    ) -> Result<(), Box<dyn Error>> {
        serde_json::to_writer(
            &mut self.stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params,
            }),
        )?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()?;
        Ok(())
    }

    fn receive_response(&self, id: u64) -> Result<Value, Box<dyn Error>> {
        loop {
            let message = self.receive()?;
            if message.get("id") == Some(&Value::from(id)) {
                return Ok(message);
            }
        }
    }

    fn receive(&self) -> Result<Value, Box<dyn Error>> {
        self.messages
            .recv_timeout(RESPONSE_TIMEOUT)
            .map_err(Into::into)
    }

    fn shutdown(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for RpcProcess {
    fn drop(&mut self) {
        self.shutdown();
    }
}
