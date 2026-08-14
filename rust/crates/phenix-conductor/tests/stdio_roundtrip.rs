use agent_client_protocol::schema::v1::{
    ClientCapabilities, ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest,
    SessionId,
};
use agent_client_protocol::schema::ProtocolVersion;
use serde::Serialize;
use serde_json::{json, Value};
use std::error::Error;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::Duration;

const RESPONSE_TIMEOUT: Duration = Duration::from_secs(15);

#[test]
fn standard_and_phenix_acp_share_one_conductor_aggregate() -> Result<(), Box<dyn Error>> {
    let fixture_agent = PathBuf::from(env!("CARGO_BIN_EXE_fixture-agent"));
    let conductor = PathBuf::from(env!("CARGO_BIN_EXE_phenix-conductor"));
    let cwd = std::env::current_dir()?;

    let mut process = RpcProcess::spawn(&conductor, &cwd)?;
    process.send_request(
        1,
        "initialize",
        &InitializeRequest::new(ProtocolVersion::V1).client_capabilities(ClientCapabilities::new()),
    )?;
    process.receive_response(1)?;

    process.send_request(
        100,
        "_phenix/config/load",
        &configuration_json(&fixture_agent),
    )?;
    let configured = process.receive_response(100)?;
    assert_eq!(configured["result"]["definition_id"], "definition.fixture");

    process.send_request(101, "_phenix/config/get", &json!({}))?;
    let configuration = process.receive_response(101)?;
    assert_eq!(
        configuration["result"]["active"]["workflows"],
        json!([{ "id": "workflow.fixture", "title": "Fixture workflow" }])
    );

    process.send_request(2, "session/new", &NewSessionRequest::new(&cwd))?;
    let created = process.receive_response(2)?;
    let session_id = created["result"]["sessionId"]
        .as_str()
        .ok_or("session/new did not return a session ID")?
        .to_owned();

    process.send_request(3, "_phenix/session_tree/list", &json!({}))?;
    let listed = process.receive_response(3)?;
    assert_eq!(listed["result"]["trees"][0]["tree_id"], session_id);

    process.send_request(
        4,
        "_phenix/session_tree/get",
        &json!({ "tree_id": session_id }),
    )?;
    let tree = process.receive_response(4)?;
    assert_eq!(tree["result"]["id"], session_id);
    assert_eq!(tree["result"]["nodes"].as_array().map(Vec::len), Some(1));
    assert_eq!(tree["result"]["nodes"][0]["difficulty"], "d2");
    assert_eq!(tree["result"]["nodes"][0]["model"]["backend"], "fixture");
    assert_eq!(tree["result"]["nodes"][0]["model"]["thinking"], "medium");
    let root_node_id = tree["result"]["root"]
        .as_str()
        .ok_or("tree snapshot did not contain a root node")?
        .to_owned();

    let backend_target = json!({
        "tree_id": session_id,
        "backend": "fixture",
    });
    process.send_request(5, "_phenix/backend/capabilities/get", &backend_target)?;
    let capabilities = process.receive_response(5)?;
    assert_eq!(capabilities["result"]["backend"], "fixture");
    assert!(capabilities["result"]["capabilities"].is_object());

    process.send_request(6, "_phenix/backend/model/list", &backend_target)?;
    let models = process.receive_response(6)?;
    assert_eq!(models["result"]["backend"], "fixture");
    assert!(models["result"]["models"].is_array());

    process.send_request(7, "_phenix/backend/auth_provider/list", &backend_target)?;
    let providers = process.receive_response(7)?;
    assert_eq!(providers["result"]["backend"], "fixture");
    assert!(providers["result"]["providers"].is_array());

    process.send_request(8, "_phenix/backend/command/list", &backend_target)?;
    let commands = process.receive_response(8)?;
    assert_eq!(commands["result"]["backend"], "fixture");
    assert!(commands["result"]["commands"].is_array());

    process.send_request(
        9,
        "_phenix/node/subscribe",
        &json!({
            "tree_id": session_id,
            "node_id": root_node_id,
        }),
    )?;
    process.receive_response(9)?;

    process.send_request(
        10,
        "_phenix/node/execute",
        &json!({
            "tree_id": session_id,
            "node_id": root_node_id,
            "command": {
                "kind": "prompt",
                "text": "extended",
                "images": [],
            }
        }),
    )?;
    let mut saw_extended_event = false;
    let mut extended_completed = None;
    while !saw_extended_event || extended_completed.is_none() {
        let message = process.receive()?;
        if message.get("method").and_then(Value::as_str) == Some("_phenix/node/event")
            && message.to_string().contains("echo: extended")
        {
            saw_extended_event = true;
        }
        if message.get("id") == Some(&Value::from(10)) {
            extended_completed = Some(message);
        }
    }
    let extended_completed = extended_completed.expect("node execute response");
    assert!(
        saw_extended_event,
        "subscribed node did not emit the downstream Phenix ACP event"
    );
    assert!(
        extended_completed["result"]["events"].is_array(),
        "node execution did not return its immediate event batch"
    );

    process.send_request(
        11,
        "session/prompt",
        &PromptRequest::new(
            SessionId::new(session_id.clone()),
            vec![ContentBlock::from("hello")],
        ),
    )?;
    let mut saw_echo = false;
    let completed = loop {
        let message = process.receive()?;
        if message.get("method").and_then(Value::as_str) == Some("session/update")
            && message.to_string().contains("echo: hello")
        {
            saw_echo = true;
        }
        if message.get("id") == Some(&Value::from(11)) {
            break message;
        }
    };
    assert!(
        saw_echo,
        "conductor did not forward the downstream ACP update"
    );
    assert_eq!(completed["result"]["stopReason"], "end_turn");

    process.send_request(
        12,
        "_phenix/session_tree/get",
        &json!({ "tree_id": session_id }),
    )?;
    let tree_after_prompt = process.receive_response(12)?;
    assert_eq!(tree_after_prompt["result"]["id"], session_id);
    assert_eq!(
        tree_after_prompt["result"]["nodes"][0]["downstream_session"],
        "fixture-session"
    );

    process.shutdown();
    Ok(())
}

fn configuration_json(fixture_agent: &Path) -> Value {
    let workflow = r#"
# Fixture workflow

```phenix-workflow
id: workflow.fixture
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `inspect` | `-` | `scout` | inspect {objective} |
"#;
    let routing = r#"
# Fixture routing

```phenix-router
id: router.fixture
```

## Routes

| Role | Workflow | D0 | D1 | D2 | D3 | D4 | Explanation |
|---|---|---|---|---|---|---|---|
| `*` | `*` | `fixture/provider/model/minimal` | `fixture/provider/model/low` | `fixture/provider/model/medium` | `fixture/provider/model/high` | `fixture/provider/model/max` | fixture route |
"#;
    json!({
        "source_root": ".",
        "input": {
            "definition_id": "definition.fixture",
            "router": "router.fixture",
            "standard_session": {
                "role": "coordinator",
                "difficulty": "d2",
                "objective": "coordinate the fixture session"
            },
            "backends": [{
                "id": "fixture",
                "command": format!("{:?}", fixture_agent)
            }],
            "definitions": [
                {
                    "kind": "workflow",
                    "source": {
                        "kind": "inline",
                        "source": workflow,
                        "format": "markdown"
                    }
                },
                {
                    "kind": "routing_table",
                    "source": {
                        "kind": "inline",
                        "source": routing,
                        "format": "markdown"
                    }
                }
            ]
        }
    })
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
