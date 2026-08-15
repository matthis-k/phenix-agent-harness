use phenix_runtime_api::{ClientCommand, FrontendRequest, FrontendResponse, ServerReply};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

#[test]
fn stdio_roundtrip_uses_phenix_frontend_protocol() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_phenix-conductor"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn conductor");

    let request = FrontendRequest {
        id: 7,
        command: ClientCommand::Initialize,
    };
    let mut stdin = child.stdin.take().expect("stdin");
    serde_json::to_writer(&mut stdin, &request).expect("serialize request");
    stdin.write_all(b"\n").expect("newline");
    drop(stdin);

    let stdout = child.stdout.take().expect("stdout");
    let line = BufReader::new(stdout)
        .lines()
        .next()
        .expect("one response")
        .expect("read response");
    let response: FrontendResponse = serde_json::from_str(&line).expect("decode response");
    assert_eq!(response.id, 7);
    assert!(matches!(
        response.result,
        Some(ServerReply::Initialized { .. })
    ));
    assert_eq!(child.wait().expect("wait").code(), Some(0));
}
