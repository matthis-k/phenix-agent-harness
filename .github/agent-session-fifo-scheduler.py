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
replace(
    server,
    "use std::collections::{BTreeMap, BTreeSet};",
    "use std::collections::{BTreeMap, BTreeSet, VecDeque};",
)
replace(
    server,
    "    mpsc::{self, Receiver, SyncSender},\n    Arc, Mutex, MutexGuard,\n",
    "    mpsc::{self, SyncSender},\n    Arc, Condvar, Mutex, MutexGuard,\n",
)
replace(
    server,
    "struct ExecutionJob {\n    execution_id: ExecutionId,\n}\n",
    '''struct ExecutionJob {\n    execution_id: ExecutionId,\n    session_id: SessionId,\n}\n\n#[derive(Default)]\nstruct ExecutionQueueState {\n    pending: VecDeque<ExecutionJob>,\n    active_sessions: BTreeSet<SessionId>,\n    closed: bool,\n}\n\n#[derive(Clone, Default)]\nstruct ExecutionQueue {\n    state: Arc<(Mutex<ExecutionQueueState>, Condvar)>,\n}\n\nimpl ExecutionQueue {\n    fn enqueue(&self, job: ExecutionJob) -> Result<(), ServerError> {\n        let (lock, ready) = &*self.state;\n        let mut state = lock\n            .lock()\n            .map_err(|_| ServerError::StatePoisoned("execution queue"))?;\n        if state.closed {\n            return Err(ServerError::StatePoisoned("closed execution queue"));\n        }\n        state.pending.push_back(job);\n        ready.notify_one();\n        Ok(())\n    }\n\n    fn next(&self) -> Result<Option<ExecutionJob>, ServerError> {\n        let (lock, ready) = &*self.state;\n        let mut state = lock\n            .lock()\n            .map_err(|_| ServerError::StatePoisoned("execution queue"))?;\n        loop {\n            if let Some(index) = state\n                .pending\n                .iter()\n                .position(|job| !state.active_sessions.contains(&job.session_id))\n            {\n                let job = state\n                    .pending\n                    .remove(index)\n                    .expect("pending execution index was selected");\n                state.active_sessions.insert(job.session_id.clone());\n                return Ok(Some(job));\n            }\n            if state.closed && state.pending.is_empty() {\n                return Ok(None);\n            }\n            state = ready\n                .wait(state)\n                .map_err(|_| ServerError::StatePoisoned("execution queue"))?;\n        }\n    }\n\n    fn complete(&self, session_id: &SessionId) -> Result<(), ServerError> {\n        let (lock, ready) = &*self.state;\n        let mut state = lock\n            .lock()\n            .map_err(|_| ServerError::StatePoisoned("execution queue"))?;\n        state.active_sessions.remove(session_id);\n        ready.notify_all();\n        Ok(())\n    }\n\n    fn close(&self) -> Result<(), ServerError> {\n        let (lock, ready) = &*self.state;\n        let mut state = lock\n            .lock()\n            .map_err(|_| ServerError::StatePoisoned("execution queue"))?;\n        state.closed = true;\n        ready.notify_all();\n        Ok(())\n    }\n}\n''',
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
replace(
    server,
    "        executions: &SyncSender<ExecutionJob>,",
    "        executions: &ExecutionQueue,",
    count=4,
)
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
    '''    fn enqueue_execution(\n        &self,\n        execution_id: ExecutionId,\n        session_id: SessionId,\n        executions: &ExecutionQueue,\n    ) -> Result<(), ServerError> {\n        executions.enqueue(ExecutionJob {\n            execution_id,\n            session_id,\n        })\n    }''',
)
replace(
    server,
    "fn execution_loop(\n    executions: Arc<Mutex<Receiver<ExecutionJob>>>,",
    "fn execution_loop(\n    executions: ExecutionQueue,",
)
replace(
    server,
    '''    loop {\n        let job = {\n            let receiver = executions\n                .lock()\n                .map_err(|_| ServerError::StatePoisoned("execution receiver"))?;\n            receiver.recv()\n        };\n        let Ok(job) = job else {\n            break;\n        };\n        execute_job_chain(\n            job.execution_id,\n            &runtime,\n            &backends,\n            &active_scopes,\n            store.as_ref(),\n            &persist_lock,\n        )?;\n    }\n    Ok(())\n}''',
    '''    while let Some(job) = executions.next()? {\n        let result = execute_job_chain(\n            job.execution_id,\n            &runtime,\n            &backends,\n            &active_scopes,\n            store.as_ref(),\n            &persist_lock,\n        );\n        executions.complete(&job.session_id)?;\n        result?;\n    }\n    Ok(())\n}''',
)

# The queue itself owns the scheduling invariant: same-session jobs stay FIFO and\n# blocked jobs do not prevent a later independent session from using a free worker.\nanchor = "    #[test]\n    fn independent_sessions_use_bounded_parallel_execution_lanes() {"
queue_test = '''    #[test]\n    fn execution_queue_serializes_each_session_without_blocking_independent_sessions() {\n        let queue = ExecutionQueue::default();\n        let first_session = SessionId::parse("session-1").unwrap();\n        let second_session = SessionId::parse("session-2").unwrap();\n        queue\n            .enqueue(ExecutionJob {\n                execution_id: ExecutionId::parse("execution-1").unwrap(),\n                session_id: first_session.clone(),\n            })\n            .unwrap();\n        queue\n            .enqueue(ExecutionJob {\n                execution_id: ExecutionId::parse("execution-2").unwrap(),\n                session_id: first_session.clone(),\n            })\n            .unwrap();\n        queue\n            .enqueue(ExecutionJob {\n                execution_id: ExecutionId::parse("execution-3").unwrap(),\n                session_id: second_session.clone(),\n            })\n            .unwrap();\n\n        let first = queue.next().unwrap().unwrap();\n        assert_eq!(first.execution_id, ExecutionId::parse("execution-1").unwrap());\n        let independent = queue.next().unwrap().unwrap();\n        assert_eq!(\n            independent.execution_id,\n            ExecutionId::parse("execution-3").unwrap()\n        );\n\n        queue.complete(&first_session).unwrap();\n        let second = queue.next().unwrap().unwrap();\n        assert_eq!(second.execution_id, ExecutionId::parse("execution-2").unwrap());\n        queue.complete(&first_session).unwrap();\n        queue.complete(&second_session).unwrap();\n        queue.close().unwrap();\n        assert!(queue.next().unwrap().is_none());\n    }\n\n'''
replace(server, anchor, queue_test + anchor)

continuity = "rust/crates/phenix-conductor/tests/fixed_target_continuity.rs"
replace(
    continuity,
    "    let content = String::from_utf8(output)",
    "    let content = String::from_utf8(output)",
)
replace(
    continuity,
    '''        .filter_map(|message| match message {\n            ServerMessage::Event { event } => match event.kind {\n                ExecutionEventKind::AssistantContentDelta { text } => Some(text),\n                _ => None,\n            },\n            _ => None,\n        })\n        .collect::<Vec<_>>();\n\n    assert_eq!(content, ["turn:1", "turn:2", "turn:1"]);''',
    '''        .filter_map(|message| match message {\n            ServerMessage::Event { event } => match event.kind {\n                ExecutionEventKind::AssistantContentDelta { text } => {\n                    Some((event.execution_id, text))\n                }\n                _ => None,\n            },\n            _ => None,\n        })\n        .collect::<BTreeMap<_, _>>();\n\n    assert_eq!(\n        content.get(&ExecutionId::parse("execution-1").unwrap()),\n        Some(&"turn:1".to_owned())\n    );\n    assert_eq!(\n        content.get(&ExecutionId::parse("execution-2").unwrap()),\n        Some(&"turn:2".to_owned())\n    );\n    assert_eq!(\n        content.get(&ExecutionId::parse("execution-3").unwrap()),\n        Some(&"turn:1".to_owned())\n    );''',
)
replace(
    continuity,
    '''    assert_eq!(\n        *state.persistent_opens.lock().unwrap(),\n        [\n            SessionId::parse("session-1").unwrap(),\n            SessionId::parse("session-1").unwrap(),\n            SessionId::parse("session-2").unwrap(),\n        ]\n    );''',
    '''    let persistent_opens = state.persistent_opens.lock().unwrap();\n    assert_eq!(\n        persistent_opens\n            .iter()\n            .filter(|session_id| session_id.as_str() == "session-1")\n            .count(),\n        2\n    );\n    assert_eq!(\n        persistent_opens\n            .iter()\n            .filter(|session_id| session_id.as_str() == "session-2")\n            .count(),\n        1\n    );''',
)
