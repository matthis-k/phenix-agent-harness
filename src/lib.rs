use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use thiserror::Error;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum WorkflowStateError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("task not found: {0}")]
    TaskNotFound(Uuid),
}

pub type Result<T> = std::result::Result<T, WorkflowStateError>;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct WorkflowSession {
    pub id: Uuid,
    pub name: String,
    pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct WorkflowTask {
    pub id: Uuid,
    pub session_id: Uuid,
    pub title: String,
    pub status: TaskStatus,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Blocked,
    Done,
}

impl TaskStatus {
    fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Pending => "pending",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Blocked => "blocked",
            TaskStatus::Done => "done",
        }
    }

    fn from_str(value: &str) -> Self {
        match value {
            "in_progress" => TaskStatus::InProgress,
            "blocked" => TaskStatus::Blocked,
            "done" => TaskStatus::Done,
            _ => TaskStatus::Pending,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct WorkflowEvent {
    pub id: Uuid,
    pub task_id: Uuid,
    pub kind: String,
    pub message: String,
    pub payload: serde_json::Value,
    pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct WorkflowSummary {
    pub session_id: Uuid,
    pub task_count: usize,
    pub event_count: usize,
    pub pending: usize,
    pub in_progress: usize,
    pub blocked: usize,
    pub done: usize,
}

pub struct WorkflowRepository {
    conn: Connection,
}

impl WorkflowRepository {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        let repo = Self { conn };
        repo.init()?;
        Ok(repo)
    }

    pub fn open_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        let repo = Self { conn };
        repo.init()?;
        Ok(repo)
    }

    pub fn init(&self) -> Result<()> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS workflow_sessions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS workflow_tasks (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES workflow_sessions(id),
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS workflow_events (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES workflow_tasks(id),
                kind TEXT NOT NULL,
                message TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL
            );",
        )?;
        Ok(())
    }

    pub fn create_session(&self, name: &str) -> Result<WorkflowSession> {
        let session = WorkflowSession {
            id: Uuid::now_v7(),
            name: name.to_owned(),
            created_at: OffsetDateTime::now_utc(),
        };
        self.conn.execute(
            "INSERT INTO workflow_sessions (id, name, created_at) VALUES (?1, ?2, ?3)",
            params![session.id, session.name, session.created_at],
        )?;
        Ok(session)
    }

    pub fn create_task(&self, session_id: Uuid, title: &str) -> Result<WorkflowTask> {
        let now = OffsetDateTime::now_utc();
        let task = WorkflowTask {
            id: Uuid::now_v7(),
            session_id,
            title: title.to_owned(),
            status: TaskStatus::Pending,
            created_at: now,
            updated_at: now,
        };
        self.conn.execute(
            "INSERT INTO workflow_tasks (id, session_id, title, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                task.id,
                task.session_id,
                task.title,
                task.status.as_str(),
                task.created_at,
                task.updated_at
            ],
        )?;
        Ok(task)
    }

    pub fn list_tasks(&self, session_id: Option<Uuid>) -> Result<Vec<WorkflowTask>> {
        let mut tasks = Vec::new();
        if let Some(session_id) = session_id {
            let mut stmt = self.conn.prepare(
                "SELECT id, session_id, title, status, created_at, updated_at
                 FROM workflow_tasks WHERE session_id = ?1 ORDER BY created_at",
            )?;
            let rows = stmt.query_map(params![session_id], Self::map_task)?;
            for row in rows {
                tasks.push(row?);
            }
        } else {
            let mut stmt = self.conn.prepare(
                "SELECT id, session_id, title, status, created_at, updated_at
                 FROM workflow_tasks ORDER BY created_at",
            )?;
            let rows = stmt.query_map([], Self::map_task)?;
            for row in rows {
                tasks.push(row?);
            }
        }
        Ok(tasks)
    }

    pub fn record_event(
        &self,
        task_id: Uuid,
        kind: &str,
        message: &str,
        payload: serde_json::Value,
    ) -> Result<WorkflowEvent> {
        let exists = self
            .conn
            .query_row(
                "SELECT 1 FROM workflow_tasks WHERE id = ?1",
                params![task_id],
                |_| Ok(()),
            )
            .optional()?;
        if exists.is_none() {
            return Err(WorkflowStateError::TaskNotFound(task_id));
        }

        let event = WorkflowEvent {
            id: Uuid::now_v7(),
            task_id,
            kind: kind.to_owned(),
            message: message.to_owned(),
            payload,
            created_at: OffsetDateTime::now_utc(),
        };
        self.conn.execute(
            "INSERT INTO workflow_events (id, task_id, kind, message, payload, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                event.id,
                event.task_id,
                event.kind,
                event.message,
                serde_json::to_string(&event.payload)?,
                event.created_at
            ],
        )?;
        Ok(event)
    }

    pub fn summarize(&self, session_id: Uuid) -> Result<WorkflowSummary> {
        let tasks = self.list_tasks(Some(session_id))?;
        let event_count = self.conn.query_row(
            "SELECT COUNT(*) FROM workflow_events e
             JOIN workflow_tasks t ON t.id = e.task_id
             WHERE t.session_id = ?1",
            params![session_id],
            |row| row.get::<_, i64>(0),
        )? as usize;
        Ok(WorkflowSummary {
            session_id,
            task_count: tasks.len(),
            event_count,
            pending: tasks.iter().filter(|task| task.status == TaskStatus::Pending).count(),
            in_progress: tasks
                .iter()
                .filter(|task| task.status == TaskStatus::InProgress)
                .count(),
            blocked: tasks.iter().filter(|task| task.status == TaskStatus::Blocked).count(),
            done: tasks.iter().filter(|task| task.status == TaskStatus::Done).count(),
        })
    }

    fn map_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkflowTask> {
        let status: String = row.get(3)?;
        Ok(WorkflowTask {
            id: row.get(0)?,
            session_id: row.get(1)?,
            title: row.get(2)?,
            status: TaskStatus::from_str(&status),
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_event_and_summarizes_session() {
        let repo = WorkflowRepository::open_memory().expect("repository opens");
        let session = repo.create_session("demo").expect("session created");
        let task = repo.create_task(session.id, "implement slice").expect("task created");

        repo.record_event(
            task.id,
            "note",
            "started",
            serde_json::json!({ "source": "test" }),
        )
        .expect("event recorded");

        let summary = repo.summarize(session.id).expect("summary produced");
        assert_eq!(summary.task_count, 1);
        assert_eq!(summary.event_count, 1);
        assert_eq!(summary.pending, 1);
    }

    #[test]
    fn opens_file_database_in_temp_dir() {
        let dir = tempfile::tempdir().expect("temp dir");
        let db_path = dir.path().join("workflow-state.sqlite3");
        let repo = WorkflowRepository::open(&db_path).expect("repository opens");
        let session = repo.create_session("file-db").expect("session created");
        let tasks = repo.list_tasks(Some(session.id)).expect("tasks listed");
        assert!(tasks.is_empty());
    }
}
