use phenix_core::{ExecutionId, WorkspaceId, WorkspaceLeaseMode, WorkspaceLeaseRequest};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::{Arc, Condvar, Mutex};

#[derive(Clone, Default)]
pub(super) struct WorkspaceLeaseManager {
    state: Arc<(Mutex<WorkspaceLeaseState>, Condvar)>,
}

#[derive(Default)]
struct WorkspaceLeaseState {
    workspaces: BTreeMap<WorkspaceId, WorkspaceLeaseHolders>,
}

#[derive(Default)]
struct WorkspaceLeaseHolders {
    readers: BTreeSet<ExecutionId>,
    writer: Option<ExecutionId>,
}

impl WorkspaceLeaseHolders {
    fn permits(&self, mode: WorkspaceLeaseMode) -> bool {
        match mode {
            WorkspaceLeaseMode::Read => self.writer.is_none(),
            WorkspaceLeaseMode::Write => self.writer.is_none() && self.readers.is_empty(),
        }
    }

    fn acquire(&mut self, request: &WorkspaceLeaseRequest) {
        match request.mode {
            WorkspaceLeaseMode::Read => {
                self.readers.insert(request.execution_id.clone());
            }
            WorkspaceLeaseMode::Write => {
                self.writer = Some(request.execution_id.clone());
            }
        }
    }

    fn release(&mut self, request: &WorkspaceLeaseRequest) {
        match request.mode {
            WorkspaceLeaseMode::Read => {
                self.readers.remove(&request.execution_id);
            }
            WorkspaceLeaseMode::Write => {
                if self.writer.as_ref() == Some(&request.execution_id) {
                    self.writer = None;
                }
            }
        }
    }

    fn is_empty(&self) -> bool {
        self.writer.is_none() && self.readers.is_empty()
    }
}

impl WorkspaceLeaseManager {
    pub(super) fn acquire(
        &self,
        request: WorkspaceLeaseRequest,
    ) -> Result<WorkspaceLease, WorkspaceLeaseError> {
        let (lock, ready) = &*self.state;
        let mut state = lock
            .lock()
            .map_err(|_| WorkspaceLeaseError::StatePoisoned)?;
        loop {
            let holders = state
                .workspaces
                .entry(request.workspace_id.clone())
                .or_default();
            if holders.permits(request.mode) {
                holders.acquire(&request);
                return Ok(WorkspaceLease {
                    manager: self.clone(),
                    request,
                });
            }
            state = ready
                .wait(state)
                .map_err(|_| WorkspaceLeaseError::StatePoisoned)?;
        }
    }

    fn release(&self, request: &WorkspaceLeaseRequest) {
        let (lock, ready) = &*self.state;
        let Ok(mut state) = lock.lock() else {
            return;
        };
        let empty = state
            .workspaces
            .get_mut(&request.workspace_id)
            .is_some_and(|holders| {
                holders.release(request);
                holders.is_empty()
            });
        if empty {
            state.workspaces.remove(&request.workspace_id);
        }
        ready.notify_all();
    }
}

pub(super) struct WorkspaceLease {
    manager: WorkspaceLeaseManager,
    request: WorkspaceLeaseRequest,
}

impl Drop for WorkspaceLease {
    fn drop(&mut self) {
        self.manager.release(&self.request);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum WorkspaceLeaseError {
    StatePoisoned,
}

impl Display for WorkspaceLeaseError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::StatePoisoned => f.write_str("workspace lease state lock poisoned"),
        }
    }
}

impl Error for WorkspaceLeaseError {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    fn request(execution: &str, mode: WorkspaceLeaseMode) -> WorkspaceLeaseRequest {
        WorkspaceLeaseRequest {
            workspace_id: WorkspaceId::parse("workspace:/repo").unwrap(),
            execution_id: ExecutionId::parse(execution).unwrap(),
            mode,
        }
    }

    #[test]
    fn readers_share_one_workspace() {
        let manager = WorkspaceLeaseManager::default();
        let first = manager
            .acquire(request("execution-1", WorkspaceLeaseMode::Read))
            .unwrap();
        let other = manager.clone();
        let (acquired, observed) = mpsc::channel();
        let reader = thread::spawn(move || {
            let lease = other
                .acquire(request("execution-2", WorkspaceLeaseMode::Read))
                .unwrap();
            acquired.send(()).unwrap();
            lease
        });

        observed.recv_timeout(Duration::from_secs(1)).unwrap();
        let second = reader.join().unwrap();
        drop(first);
        drop(second);
    }

    #[test]
    fn writer_excludes_readers_until_release() {
        let manager = WorkspaceLeaseManager::default();
        let writer = manager
            .acquire(request("execution-1", WorkspaceLeaseMode::Write))
            .unwrap();
        let other = manager.clone();
        let (acquired, observed) = mpsc::channel();
        let reader = thread::spawn(move || {
            let lease = other
                .acquire(request("execution-2", WorkspaceLeaseMode::Read))
                .unwrap();
            acquired.send(()).unwrap();
            lease
        });

        assert!(observed.recv_timeout(Duration::from_millis(100)).is_err());
        drop(writer);
        observed.recv_timeout(Duration::from_secs(1)).unwrap();
        drop(reader.join().unwrap());
    }

    #[test]
    fn reader_excludes_writer_until_release() {
        let manager = WorkspaceLeaseManager::default();
        let reader = manager
            .acquire(request("execution-1", WorkspaceLeaseMode::Read))
            .unwrap();
        let other = manager.clone();
        let (acquired, observed) = mpsc::channel();
        let writer = thread::spawn(move || {
            let lease = other
                .acquire(request("execution-2", WorkspaceLeaseMode::Write))
                .unwrap();
            acquired.send(()).unwrap();
            lease
        });

        assert!(observed.recv_timeout(Duration::from_millis(100)).is_err());
        drop(reader);
        observed.recv_timeout(Duration::from_secs(1)).unwrap();
        drop(writer.join().unwrap());
    }
}
