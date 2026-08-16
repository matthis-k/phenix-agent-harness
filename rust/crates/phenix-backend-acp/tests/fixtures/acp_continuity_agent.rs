#![forbid(unsafe_code)]

use agent_client_protocol::schema::v1::{
    ContentBlock, ContentChunk, InitializeRequest, InitializeResponse, NewSessionRequest,
    NewSessionResponse, PromptRequest, PromptResponse, SessionConfigOption,
    SessionConfigOptionCategory, SessionConfigSelectOption, SessionNotification, SessionUpdate,
    StopReason, TextContent,
};
use agent_client_protocol::{Agent, Stdio};
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};
use std::thread;

fn model_options() -> Vec<SessionConfigOption> {
    vec![SessionConfigOption::select(
        "model",
        "Model",
        "fixture-model",
        vec![SessionConfigSelectOption::new(
            "fixture-model",
            "Fixture Model",
        )],
    )
    .category(SessionConfigOptionCategory::Model)]
}

async fn run() -> Result<(), agent_client_protocol::Error> {
    let next_session = Arc::new(Mutex::new(0_u64));
    let turns = Arc::new(Mutex::new(BTreeMap::<String, usize>::new()));

    Agent
        .builder()
        .on_receive_request(
            async |request: InitializeRequest, responder, _connection| {
                responder.respond(InitializeResponse::new(request.protocol_version))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let next_session = next_session.clone();
                let turns = turns.clone();
                async move |_request: NewSessionRequest, responder, _connection| {
                    let session_id = {
                        let mut next_session = next_session.lock().map_err(|_| {
                            agent_client_protocol::Error::internal_error()
                                .data("fixture session counter lock poisoned")
                        })?;
                        *next_session += 1;
                        format!("native-session-{}", *next_session)
                    };
                    turns
                        .lock()
                        .map_err(|_| {
                            agent_client_protocol::Error::internal_error()
                                .data("fixture turn map lock poisoned")
                        })?
                        .insert(session_id.clone(), 0);
                    responder.respond(
                        NewSessionResponse::new(session_id).config_options(model_options()),
                    )
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let turns = turns.clone();
                async move |request: PromptRequest, responder, connection| {
                    let session_id = request.session_id.clone();
                    let turn = {
                        let mut turns = turns.lock().map_err(|_| {
                            agent_client_protocol::Error::internal_error()
                                .data("fixture turn map lock poisoned")
                        })?;
                        let turn = turns.get_mut(&session_id.to_string()).ok_or_else(|| {
                            agent_client_protocol::Error::invalid_params()
                                .data(format!("unknown fixture session {session_id}"))
                        })?;
                        *turn += 1;
                        *turn
                    };
                    connection.send_notification(SessionNotification::new(
                        session_id,
                        SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                            TextContent::new(format!("turn:{turn}")),
                        ))),
                    ))?;
                    responder.respond(PromptResponse::new(StopReason::EndTurn))
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_to(Stdio::new())
        .await
}

struct ThreadWake(thread::Thread);

impl Wake for ThreadWake {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.0.unpark();
    }
}

fn block_on<F: Future>(future: F) -> F::Output {
    let waker = Waker::from(Arc::new(ThreadWake(thread::current())));
    let mut context = Context::from_waker(&waker);
    let mut future: Pin<Box<F>> = Box::pin(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(output) => return output,
            Poll::Pending => thread::park(),
        }
    }
}

fn main() {
    if let Err(error) = block_on(run()) {
        eprintln!("ACP continuity fixture failed: {error}");
        std::process::exit(1);
    }
}
