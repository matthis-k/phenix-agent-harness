use crate::{
    ReadyInvocation, RunFailure, RunId, WorkflowOutput, WorkflowRuntime, WorkflowRuntimeError,
};
use std::collections::BTreeMap;

/// A conductor-owned run registry. Executors receive a `StartedRun`, but only
/// this coordinator may transition graph state or release dependent work.
#[derive(Clone, Debug)]
pub struct WorkflowRunCoordinator {
    runtime: WorkflowRuntime,
    running: BTreeMap<RunId, String>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct StartedRun {
    pub run: RunId,
    pub node: String,
    pub invocation: ReadyInvocation,
}

impl WorkflowRunCoordinator {
    pub fn new(runtime: WorkflowRuntime) -> Self {
        Self {
            runtime,
            running: BTreeMap::new(),
        }
    }

    pub fn runtime(&self) -> &WorkflowRuntime {
        &self.runtime
    }

    /// Starts the complete deterministic ready batch. A backend adapter may
    /// execute this batch concurrently; it cannot create additional runs.
    pub fn start_ready(
        &mut self,
        mut allocate_run: impl FnMut() -> Result<RunId, WorkflowRuntimeError>,
    ) -> Result<Vec<StartedRun>, WorkflowRuntimeError> {
        let ready = self.runtime.ready()?;
        let mut started = Vec::with_capacity(ready.len());
        for invocation in ready {
            let run = allocate_run()?;
            self.runtime.start(&invocation.node, run.clone())?;
            self.running.insert(run.clone(), invocation.node.clone());
            started.push(StartedRun {
                run,
                node: invocation.node.clone(),
                invocation,
            });
        }
        Ok(started)
    }

    pub fn complete(
        &mut self,
        run: &RunId,
        outputs: Vec<WorkflowOutput>,
    ) -> Result<(), WorkflowRuntimeError> {
        let node = self.take_running(run)?;
        self.runtime.complete(&node, outputs)
    }

    pub fn fail(&mut self, run: &RunId, failure: RunFailure) -> Result<(), WorkflowRuntimeError> {
        let node = self.take_running(run)?;
        self.runtime.fail(&node, failure)
    }

    fn take_running(&mut self, run: &RunId) -> Result<String, WorkflowRuntimeError> {
        self.running
            .remove(run)
            .ok_or_else(|| WorkflowRuntimeError::UnknownRun(run.clone()))
    }
}
