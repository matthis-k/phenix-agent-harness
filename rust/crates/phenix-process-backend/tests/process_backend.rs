#![cfg(unix)]

use phenix_process_backend::{ProcessAgentBackend, ProcessBackendConfig};
use phenix_runtime_api::{
    BackendCommand, BackendOutput, BackendReply, BackendRuntime, ClientInformation,
};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[test]
fn process_backend_correlates_initialization_and_orderly_shutdown() {
    let script = write_mock_runtime();
    let backend = ProcessAgentBackend::new(ProcessBackendConfig::new(&script)).expect("backend");
    let runtime = BackendRuntime::spawn(Box::new(backend), 16).expect("runtime");

    let initialize = runtime
        .client
        .submit(BackendCommand::Initialize {
            client: ClientInformation {
                name: "integration-test".to_owned(),
                build: "test".to_owned(),
            },
        })
        .expect("initialize request");
    let reply = receive_reply(&runtime, initialize.as_str());
    assert!(matches!(reply, BackendReply::Initialized { .. }));

    let shutdown = runtime
        .client
        .submit(BackendCommand::Shutdown)
        .expect("shutdown request");
    assert_eq!(
        receive_reply(&runtime, shutdown.as_str()),
        BackendReply::Completed
    );
    runtime.join().expect("backend joins");

    fs::remove_file(script).ok();
}

fn receive_reply(runtime: &BackendRuntime, request_id: &str) -> BackendReply {
    loop {
        match runtime
            .outputs
            .recv_timeout(Duration::from_secs(5))
            .expect("backend output")
        {
            BackendOutput::Reply {
                request_id: current,
                result,
            } if current.as_str() == request_id => return result.expect("successful reply"),
            BackendOutput::Stopped { result } => {
                result.expect("backend stop result");
                panic!("backend stopped before replying to {request_id}");
            }
            BackendOutput::Reply { .. } | BackendOutput::Event(_) => {}
        }
    }
}

fn write_mock_runtime() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "phenix-process-backend-{}-{nonce}.sh",
        std::process::id()
    ));
    fs::write(
        &path,
        r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
  case "$line" in
    *'"type":"initialize"'*)
      printf '%s\n' "{\"kind\":\"response\",\"id\":\"$id\",\"result\":{\"ok\":true,\"reply\":{\"capabilities\":{},\"snapshot\":{\"health\":\"ready\",\"capabilities\":{},\"sessions\":[],\"runs\":[],\"objectives\":[]}}}}"
      ;;
    *'"type":"shutdown"'*)
      printf '%s\n' "{\"kind\":\"response\",\"id\":\"$id\",\"result\":{\"ok\":true,\"reply\":{\"completed\":true}}}"
      exit 0
      ;;
    *)
      printf '%s\n' "{\"kind\":\"response\",\"id\":\"$id\",\"result\":{\"ok\":true,\"reply\":{\"accepted\":true}}}"
      ;;
  esac
done
"#,
    )
    .expect("write mock runtime");
    let mut permissions = fs::metadata(&path).expect("mock metadata").permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&path, permissions).expect("mock permissions");
    path
}
