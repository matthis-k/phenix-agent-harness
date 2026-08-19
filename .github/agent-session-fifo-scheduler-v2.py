from pathlib import Path

ROOT = Path.cwd()


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    file = ROOT / path
    content = file.read_text()
    actual = content.count(old)
    if actual != count:
        raise RuntimeError(f"{path}: expected {count} occurrences, found {actual}: {old!r}")
    file.write_text(content.replace(old, new, count))


server = "rust/crates/phenix-conductor/src/server.rs"
replace(server, "use std::collections::{BTreeMap, BTreeSet};", "use std::collections::{BTreeMap, BTreeSet, VecDeque};")
replace(
    server,
    "    mpsc::{self, Receiver, SyncSender},\n    Arc, Mutex, MutexGuard,\n",
    "    mpsc::{self, SyncSender},\n    Arc, Condvar, Mutex, MutexGuard,\n",
)
replace(server, "const EXECUTION_BUFFER: usize = 64;\n", "")
replace(
    server,
    "struct ExecutionJob {\n    execution_id: ExecutionId,\n}\n",
    '''struct ExecutionJob {
    execution_id: ExecutionId,
    session_id: SessionId,
}

#[derive(Default)]
struct ExecutionQueueState {
    pending: VecDeque<ExecutionJob>,
    active_sessions: BTreeSet<SessionId>,
    closed: bool,
}

#[derive(Clone, Default)]
struct ExecutionQueue {
    state: Arc<(Mutex<ExecutionQueueState>, Condvar)>,
}

impl ExecutionQueue {
    fn enqueue(&self, job: ExecutionJob) -> Result<(), ServerError> {
        let (lock, ready) = &*self.state;
        let mut state = lock
            .lock()
            .map_err(|_| ServerError::StatePoisoned("execution queue"))?;
        if state.closed {
            return Err(ServerError::StatePoisoned("closed execution queue"));
        }
        state.pending.push_back(job);
        ready.notify_one();
        Ok(())
    }

    fn next(&self) -> Result<Option<ExecutionJob>, ServerError> {
        let (lock, ready) = &*self.state;
        let mut state = lock
            .lock()
            .map_err(|_| ServerError::StatePoisoned("execution queue"))?;
        loop {
            if let Some(index) = state
                .pending
                .iter()
                .position(|job| !state.active_sessions.contains(&job.session_id))
            {
                let job = state
                    .pending
                    .remove(index)
                    .expect("pending execution index was selected");
                state.active_sessions.insert(job.session_id.clone());
                return Ok(Some(job));
            }
            if state.closed && state.pending.is_empty() {
                return Ok(None);
            }
            state = ready
                .wait(state)
                .map_err(|_| ServerError::StatePoisoned("execution queue"))?;
        }
    }

    fn complete(&self, session_id: &SessionId) -> Result<(), ServerError> {
        let (lock, ready) = &*self.state;
        let mut state = lock
            .lock()
            .map_err(|_| ServerError::StatePoisoned("execution queue"))?;
        state.active_sessions.remove(session_id);
        ready.notify_all();
        Ok(())
    }

    fn close(&self) -> Result<(), ServerError> {
        let (lock, ready) = &*self.state;
        let mut state = lock
            .lock()
            .map_err(|_| ServerError::StatePoisoned("execution queue"))?;
        state.closed = true;
        ready.notify_all();
        Ok(())
    }
}
''',
)
replace(
    server,
    "        let (execution_sender, execution_receiver) = mpsc::sync_channel(EXECUTION_BUFFER);",
    "        let executions = ExecutionQueue::default();",
)
replace(
    server,
    "            let execution_receiver = Arc::new(Mutex::new(execution_receiver));\n            let executors = (0..EXECUTION_WORKERS)\n                .map(|_| {\n                    let execution_receiver = Arc::clone(&execution_receiver);\n                    let runtime = runtime.clone();\n                    let backends = backends.clone();\n                    let active_scopes = active_scopes.clone();\n                    let store = store.clone();\n                    let persist_lock = persist_lock.clone();\n                    scope.spawn(move || {\n                        execution_loop(\n                            execution_receiver,\n                            runtime,\n                            backends,\n                            active_scopes,\n                            store,\n                            persist_lock,\n                        )\n                    })\n                })\n                .collect::<Vec<_>>();\n\n            let result = self.read_requests(input, &output_sender, &execution_sender);\n            drop(execution_sender);",
    "            let executors = (0..EXECUTION_WORKERS)\n                .map(|_| {\n                    let executions = executions.clone();\n                    let runtime = runtime.clone();\n                    let backends = backends.clone();\n                    let active_scopes = active_scopes.clone();\n                    let store = store.clone();\n                    let persist_lock = persist_lock.clone();\n                    scope.spawn(move || {\n                        execution_loop(\n                            executions,\n                            runtime,\n                            backends,\n                            active_scopes,\n                            store,\n                            persist_lock,\n                        )\n                    })\n                })\n                .collect::<Vec<_>>();\n\n            let result = self.read_requests(input, &output_sender, &executions);\n            executions.close()?;",
)

file = ROOT / server
content = file.read_text()
old_parameter = "        executions: &SyncSender<ExecutionJob>,"
if content.count(old_parameter) != 5:
    raise RuntimeError(f"{server}: expected 5 execution sender parameters, found {content.count(old_parameter)}")
file.write_text(content.replace(old_parameter, "        executions: &ExecutionQueue,", 4))

replace(
    server,
    "        let execution_id = execution.id.clone();\n        self.persist()?;\n        self.respond(output, request_id, Ok(Reply::Execution { execution }))?;\n        self.enqueue_execution(execution_id, executions)",
    "        let execution_id = execution.id.clone();\n        let execution_session = execution.session_id.clone();\n        self.persist()?;\n        self.respond(output, request_id, Ok(Reply::Execution { execution }))?;\n        self.enqueue_execution(execution_id, execution_session, executions)",
)
replace(
    server,
    "                    .map(|candidate| candidate.id)\n                    .collect::<Vec<_>>()\n            };\n            for child in pending {\n                self.enqueue_execution(child, executions)?;\n            }",
    "                    .map(|candidate| (candidate.id, candidate.session_id))\n                    .collect::<Vec<_>>()\n            };\n            for (child, session_id) in pending {\n                self.enqueue_execution(child, session_id, executions)?;\n            }",
)
replace(
    server,
    "            self.enqueue_execution(execution_id, executions)",
    "            self.enqueue_execution(execution_id, execution.session_id, executions)",
)
replace(
    server,
    "    fn enqueue_execution(\n        &self,\n        execution_id: ExecutionId,\n        executions: &SyncSender<ExecutionJob>,\n    ) -> Result<(), ServerError> {\n        if executions\n            .send(ExecutionJob {\n                execution_id: execution_id.clone(),\n            })\n            .is_err()\n        {\n            self.fail_execution(\n                &execution_id,\n                protocol_error(\n                    ErrorCode::BackendTransport,\n                    \"conductor execution worker is unavailable\",\n                ),\n            )?;\n            self.persist()?;\n        }\n        Ok(())\n    }",
    '''    fn enqueue_execution(
        &self,
        execution_id: ExecutionId,
        session_id: SessionId,
        executions: &ExecutionQueue,
    ) -> Result<(), ServerError> {
        executions.enqueue(ExecutionJob {
            execution_id,
            session_id,
        })
    }''',
)
replace(
    server,
    "fn execution_loop(\n    executions: Arc<Mutex<Receiver<ExecutionJob>>>,",
    "fn execution_loop(\n    executions: ExecutionQueue,",
)
replace(
    server,
    '''    loop {
        let job = {
            let receiver = executions
                .lock()
                .map_err(|_| ServerError::StatePoisoned("execution receiver"))?;
            receiver.recv()
        };
        let Ok(job) = job else {
            break;
        };
        execute_job_chain(
            job.execution_id,
            &runtime,
            &backends,
            &active_scopes,
            store.as_ref(),
            &persist_lock,
        )?;
    }
    Ok(())
}''',
    '''    while let Some(job) = executions.next()? {
        let result = execute_job_chain(
            job.execution_id,
            &runtime,
            &backends,
            &active_scopes,
            store.as_ref(),
            &persist_lock,
        );
        executions.complete(&job.session_id)?;
        result?;
    }
    Ok(())
}''',
)

anchor = "    #[test]\n    fn independent_sessions_use_bounded_parallel_execution_lanes() {"
queue_test = '''    #[test]
    fn execution_queue_serializes_each_session_without_blocking_independent_sessions() {
        let queue = ExecutionQueue::default();
        let first_session = SessionId::parse("session-1").unwrap();
        let second_session = SessionId::parse("session-2").unwrap();
        queue
            .enqueue(ExecutionJob {
                execution_id: ExecutionId::parse("execution-1").unwrap(),
                session_id: first_session.clone(),
            })
            .unwrap();
        queue
            .enqueue(ExecutionJob {
                execution_id: ExecutionId::parse("execution-2").unwrap(),
                session_id: first_session.clone(),
            })
            .unwrap();
        queue
            .enqueue(ExecutionJob {
                execution_id: ExecutionId::parse("execution-3").unwrap(),
                session_id: second_session.clone(),
            })
            .unwrap();

        let first = queue.next().unwrap().unwrap();
        assert_eq!(first.execution_id, ExecutionId::parse("execution-1").unwrap());
        let independent = queue.next().unwrap().unwrap();
        assert_eq!(independent.execution_id, ExecutionId::parse("execution-3").unwrap());

        queue.complete(&first_session).unwrap();
        let second = queue.next().unwrap().unwrap();
        assert_eq!(second.execution_id, ExecutionId::parse("execution-2").unwrap());
        queue.complete(&first_session).unwrap();
        queue.complete(&second_session).unwrap();
        queue.close().unwrap();
        assert!(queue.next().unwrap().is_none());
    }

'''
replace(server, anchor, queue_test + anchor)

continuity = "rust/crates/phenix-conductor/tests/fixed_target_continuity.rs"
replace(
    continuity,
    '''        .filter_map(|message| match message {
            ServerMessage::Event { event } => match event.kind {
                ExecutionEventKind::AssistantContentDelta { text } => Some(text),
                _ => None,
            },
            _ => None,
        })
        .collect::<Vec<_>>();

    assert_eq!(content, ["turn:1", "turn:2", "turn:1"]);''',
    '''        .filter_map(|message| match message {
            ServerMessage::Event { event } => match event.kind {
                ExecutionEventKind::AssistantContentDelta { text } => {
                    Some((event.execution_id, text))
                }
                _ => None,
            },
            _ => None,
        })
        .collect::<BTreeMap<_, _>>();

    assert_eq!(
        content.get(&ExecutionId::parse("execution-1").unwrap()),
        Some(&"turn:1".to_owned())
    );
    assert_eq!(
        content.get(&ExecutionId::parse("execution-2").unwrap()),
        Some(&"turn:2".to_owned())
    );
    assert_eq!(
        content.get(&ExecutionId::parse("execution-3").unwrap()),
        Some(&"turn:1".to_owned())
    );''',
)
replace(
    continuity,
    '''    assert_eq!(
        *state.persistent_opens.lock().unwrap(),
        [
            SessionId::parse("session-1").unwrap(),
            SessionId::parse("session-1").unwrap(),
            SessionId::parse("session-2").unwrap(),
        ]
    );''',
    '''    let persistent_opens = state.persistent_opens.lock().unwrap();
    assert_eq!(
        persistent_opens
            .iter()
            .filter(|session_id| session_id.as_str() == "session-1")
            .count(),
        2
    );
    assert_eq!(
        persistent_opens
            .iter()
            .filter(|session_id| session_id.as_str() == "session-2")
            .count(),
        1
    );''',
)
