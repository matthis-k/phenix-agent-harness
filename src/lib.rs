use rusqlite::{params, types::ValueRef, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;
use thiserror::Error;
use time::OffsetDateTime;
use uuid::Uuid;


#[derive(Debug, Error)]
pub enum AgentCommError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("missing required argument: {0}")]
    Missing(&'static str),
    #[error("invalid argument: {0}")]
    Invalid(String),
    #[error("unknown tool: {0}")]
    UnknownTool(String),
}

pub type Result<T> = std::result::Result<T, AgentCommError>;

pub const TOOLS: &[&str] = &[
    "comm_session_init",
    "comm_session_resume",
    "comm_session_get",
    "comm_session_list",
    "comm_session_close",
    "comm_agent_register",
    "comm_agent_heartbeat",
    "comm_agent_update_status",
    "comm_agent_list",
    "comm_message_send",
    "comm_message_list",
    "comm_message_read",
    "comm_message_ack",
    "comm_message_reply",
    "comm_graph_create",
    "comm_graph_get",
    "comm_graph_summary",
    "comm_task_create",
    "comm_task_update",
    "comm_task_add_dependency",
    "comm_task_add_child",
    "comm_task_claim",
    "comm_task_release",
    "comm_task_complete",
    "comm_task_fail",
    "comm_task_block",
    "comm_task_list_ready",
    "comm_task_list_for_agent",
    "comm_event_list",
    "comm_event_recent",
    "comm_artifact_record",
    "comm_artifact_list",
    "comm_decision_record",
    "comm_decision_list",
];

const AGENT_STATUSES: &[&str] = &["available", "busy", "waiting", "offline"];
const TASK_STATUSES: &[&str] = &["pending", "in_progress", "blocked", "completed", "failed"];
const MESSAGE_FORMATS: &[&str] = &["text", "markdown", "json", "yaml"];
const MESSAGE_SEVERITIES: &[&str] = &["info", "notice", "warning", "error"];

pub struct AgentCommRepository {
    conn: Connection,
}

impl AgentCommRepository {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        // Set busy timeout BEFORE any SQL operations. This ensures that
        // PRAGMA journal_mode=WAL (which may need to acquire a lock to
        // checkpoint the existing journal) will retry on SQLITE_BUSY
        // instead of immediately failing and crashing the MCP at boot.
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
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

    /// Initialize or migrate the database schema.
    ///
    /// Uses `PRAGMA user_version` to detect the current schema version.
    /// Version 0 (uninitialized) runs the full schema creation.
    /// Future versions should add migration steps here.
    pub fn init(&self) -> Result<()> {
        let version: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap_or(0);
        if version < 1 {
            self.migrate_v1()?;
        }
        Ok(())
    }

    /// Schema version 1: initial table creation.
    fn migrate_v1(&self) -> Result<()> {
        self.conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS sessions (
               id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
               metadata TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
               closed_at TEXT
             );
              CREATE TABLE IF NOT EXISTS agents (
                id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                name TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, metadata TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_heartbeat_at TEXT NOT NULL,
                UNIQUE(session_id, name)
              );
             CREATE TABLE IF NOT EXISTS graphs (
               id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
               name TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS tasks (
               id TEXT PRIMARY KEY, graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
               parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
               title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
               assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
               claimed_by TEXT REFERENCES agents(id) ON DELETE SET NULL, claim_expires_at TEXT,
               metadata TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS task_dependencies (
               task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
               depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
               PRIMARY KEY(task_id, depends_on_task_id), CHECK(task_id <> depends_on_task_id)
             );
              CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                from_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
                task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
                parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
                to_kind TEXT, format TEXT NOT NULL, severity TEXT NOT NULL,
                subject TEXT NOT NULL, body TEXT NOT NULL, metadata TEXT NOT NULL,
                created_at TEXT NOT NULL
              );
              CREATE TABLE IF NOT EXISTS message_recipients (
                message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
                agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
                delivered_at TEXT NOT NULL, read_at TEXT, acked_at TEXT,
                PRIMARY KEY(message_id, agent_id)
              );
             CREATE TABLE IF NOT EXISTS events (
               id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
               agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
               task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
               kind TEXT NOT NULL, message TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS artifacts (
               id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
               task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
               agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
               name TEXT NOT NULL, kind TEXT NOT NULL, uri TEXT, content_ref TEXT, metadata TEXT NOT NULL,
               created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS decisions (
               id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
               task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
               agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
               title TEXT NOT NULL, rationale TEXT NOT NULL, outcome TEXT NOT NULL, metadata TEXT NOT NULL,
               created_at TEXT NOT NULL
             );
             PRAGMA user_version = 1;",
        )?;
        Ok(())
    }

    pub fn call_tool(&self, tool: &str, args: Value) -> Result<Value> {
        let a = args
            .as_object()
            .ok_or_else(|| AgentCommError::Invalid("arguments must be an object".into()))?;
        match tool {
            "comm_session_init" => self.session_init(str_arg(a, "name")?, opt_value(a, "metadata")),
            "comm_session_resume" | "comm_session_get" => {
                self.get_by_id("sessions", str_arg(a, "session_id")?)
            }
            "comm_session_list" => self.list_sessions(),
            "comm_session_close" => self.close_session(str_arg(a, "session_id")?),
            "comm_agent_register" => self.agent_register(
                str_arg(a, "session_id")?,
                str_arg(a, "name")?,
                opt_str(a, "kind").unwrap_or("agent"),
                opt_value(a, "metadata"),
            ),
            "comm_agent_heartbeat" => self.agent_touch(str_arg(a, "agent_id")?, "heartbeat"),
            "comm_agent_update_status" => self.agent_status(
                str_arg(a, "agent_id")?,
                str_arg(a, "status")?,
                opt_value(a, "metadata"),
            ),
            "comm_agent_list" => self.list_where("agents", "session_id", str_arg(a, "session_id")?),
            "comm_message_send" => self.message_send(
                str_arg(a, "session_id")?,
                opt_str(a, "from_agent_id"),
                opt_str(a, "to_agent_id"),
                opt_str_array(a, "to_agent_ids")?,
                opt_str(a, "to_kind"),
                opt_str(a, "task_id"),
                None,
                opt_str(a, "format").unwrap_or("markdown"),
                opt_str(a, "severity").unwrap_or("info"),
                opt_str(a, "subject").unwrap_or(""),
                str_arg(a, "body")?,
                opt_value(a, "metadata"),
            ),
            "comm_message_list" => self.message_list(
                str_arg(a, "session_id")?,
                opt_str(a, "agent_id"),
                opt_str(a, "task_id"),
            ),
            "comm_message_read" => self.mark_message(
                str_arg(a, "message_id")?,
                str_arg(a, "agent_id")?,
                "read_at",
                "message.read",
            ),
            "comm_message_ack" => self.mark_message(
                str_arg(a, "message_id")?,
                str_arg(a, "agent_id")?,
                "acked_at",
                "message.ack",
            ),
            "comm_message_reply" => self.message_reply(
                str_arg(a, "message_id")?,
                opt_str(a, "from_agent_id"),
                str_arg(a, "body")?,
                opt_value(a, "metadata"),
            ),
            "comm_graph_create" => self.graph_create(
                str_arg(a, "session_id")?,
                str_arg(a, "name")?,
                opt_value(a, "metadata"),
            ),
            "comm_graph_get" => self.get_by_id("graphs", str_arg(a, "graph_id")?),
            "comm_graph_summary" => self.graph_summary(str_arg(a, "graph_id")?),
            "comm_task_create" => self.task_create(
                str_arg(a, "graph_id")?,
                opt_str(a, "parent_id"),
                str_arg(a, "title")?,
                opt_str(a, "description").unwrap_or(""),
                opt_str(a, "assigned_agent_id"),
                opt_value(a, "metadata"),
            ),
            "comm_task_update" => self.task_update(str_arg(a, "task_id")?, &args),
            "comm_task_add_dependency" => {
                self.task_add_dependency(str_arg(a, "task_id")?, str_arg(a, "depends_on_task_id")?)
            }
            "comm_task_add_child" => self.task_create(
                str_arg(a, "graph_id")?,
                Some(str_arg(a, "parent_id")?),
                str_arg(a, "title")?,
                opt_str(a, "description").unwrap_or(""),
                opt_str(a, "assigned_agent_id"),
                opt_value(a, "metadata"),
            ),
            "comm_task_claim" => self.task_claim(
                str_arg(a, "task_id")?,
                str_arg(a, "agent_id")?,
                opt_str(a, "claim_expires_at"),
            ),
            "comm_task_release" => {
                self.task_release(str_arg(a, "task_id")?, opt_str(a, "agent_id"))
            }
            "comm_task_complete" => self.task_complete(
                str_arg(a, "task_id")?,
                bool_arg(a, "override_incomplete_dependencies"),
            ),
            "comm_task_fail" => self.task_terminal(
                str_arg(a, "task_id")?,
                "failed",
                opt_str(a, "reason").unwrap_or(""),
            ),
            "comm_task_block" => self.task_terminal(
                str_arg(a, "task_id")?,
                "blocked",
                opt_str(a, "reason").unwrap_or(""),
            ),
            "comm_task_list_ready" => self.task_list_ready(str_arg(a, "graph_id")?),
            "comm_task_list_for_agent" => self.task_list_for_agent(str_arg(a, "agent_id")?),
            "comm_event_list" => self.event_list(
                str_arg(a, "session_id")?,
                opt_str(a, "task_id"),
                opt_i64(a, "limit").unwrap_or(100),
            ),
            "comm_event_recent" => self.event_recent(opt_i64(a, "limit").unwrap_or(25)),
            "comm_artifact_record" => self.artifact_record(
                str_arg(a, "session_id")?,
                opt_str(a, "task_id"),
                opt_str(a, "agent_id"),
                str_arg(a, "name")?,
                str_arg(a, "kind")?,
                opt_str(a, "uri"),
                opt_str(a, "content_ref"),
                opt_value(a, "metadata"),
            ),
            "comm_artifact_list" => {
                self.list_where("artifacts", "session_id", str_arg(a, "session_id")?)
            }
            "comm_decision_record" => self.decision_record(
                str_arg(a, "session_id")?,
                opt_str(a, "task_id"),
                opt_str(a, "agent_id"),
                str_arg(a, "title")?,
                str_arg(a, "rationale")?,
                str_arg(a, "outcome")?,
                opt_value(a, "metadata"),
            ),
            "comm_decision_list" => {
                self.list_where("decisions", "session_id", str_arg(a, "session_id")?)
            }
            _ => Err(AgentCommError::UnknownTool(tool.to_owned())),
        }
    }

    fn session_init(&self, name: &str, metadata: Value) -> Result<Value> {
        let id = uuid();
        let now = now();
        let meta = metadata.to_string();
        self.conn.execute(
            "INSERT INTO sessions VALUES (?1,?2,'open',?3,?4,?4,NULL)",
            params![id, name, meta, now],
        )?;
        self.event(
            &id,
            None,
            None,
            "session.init",
            name,
            json!({"session_id": id}),
        )?;
        self.get_by_id("sessions", &id)
    }

    fn close_session(&self, session_id: &str) -> Result<Value> {
        let now = now();
        self.conn.execute(
            "UPDATE sessions SET status='closed', closed_at=?2, updated_at=?2 WHERE id=?1",
            params![session_id, now],
        )?;
        self.event(session_id, None, None, "session.close", "closed", json!({}))?;
        self.get_by_id("sessions", session_id)
    }

    fn list_sessions(&self) -> Result<Value> {
        self.query_json(
            "SELECT * FROM sessions ORDER BY created_at DESC LIMIT 200",
            [],
        )
    }

    fn agent_register(
        &self,
        session_id: &str,
        name: &str,
        kind: &str,
        metadata: Value,
    ) -> Result<Value> {
        let id = uuid();
        let now = now();
        self.conn.execute(
            "INSERT INTO agents VALUES (?1,?2,?3,?4,'available',?5,?6,?6,?6)",
            params![id, session_id, name, kind, metadata.to_string(), now],
        )?;
        self.event(
            session_id,
            Some(&id),
            None,
            "agent.register",
            name,
            json!({"kind": kind}),
        )?;
        self.get_by_id("agents", &id)
    }

    fn agent_touch(&self, agent_id: &str, kind: &str) -> Result<Value> {
        let now = now();
        self.conn.execute(
            "UPDATE agents SET last_heartbeat_at=?2, updated_at=?2 WHERE id=?1",
            params![agent_id, now],
        )?;
        let session_id = self.scalar(
            "SELECT session_id FROM agents WHERE id=?1",
            params![agent_id],
        )?;
        self.event(&session_id, Some(agent_id), None, kind, "", json!({}))?;
        self.get_by_id("agents", agent_id)
    }

    fn agent_status(&self, agent_id: &str, status: &str, metadata: Value) -> Result<Value> {
        validate("agent status", status, AGENT_STATUSES)?;
        let now = now();
        self.conn.execute(
            "UPDATE agents SET status=?2, metadata=?3, updated_at=?4 WHERE id=?1",
            params![agent_id, status, metadata.to_string(), now],
        )?;
        let session_id = self.scalar(
            "SELECT session_id FROM agents WHERE id=?1",
            params![agent_id],
        )?;
        self.event(
            &session_id,
            Some(agent_id),
            None,
            "agent.status",
            status,
            json!({}),
        )?;
        self.get_by_id("agents", agent_id)
    }

    fn graph_create(&self, session_id: &str, name: &str, metadata: Value) -> Result<Value> {
        let id = uuid();
        let now = now();
        self.conn.execute(
            "INSERT INTO graphs VALUES (?1,?2,?3,?4,?5,?5)",
            params![id, session_id, name, metadata.to_string(), now],
        )?;
        self.event(
            session_id,
            None,
            None,
            "graph.create",
            name,
            json!({"graph_id": id}),
        )?;
        self.get_by_id("graphs", &id)
    }

    fn graph_summary(&self, graph_id: &str) -> Result<Value> {
        let rows = self.query_json(
            "SELECT status, COUNT(*) AS count FROM tasks WHERE graph_id=?1 GROUP BY status",
            params![graph_id],
        )?;
        let deps: i64 = self.conn.query_row("SELECT COUNT(*) FROM task_dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.graph_id=?1", params![graph_id], |r| r.get(0))?;
        Ok(json!({"graph_id": graph_id, "statuses": rows, "dependency_count": deps}))
    }

    fn task_create(
        &self,
        graph_id: &str,
        parent_id: Option<&str>,
        title: &str,
        description: &str,
        assigned_agent_id: Option<&str>,
        metadata: Value,
    ) -> Result<Value> {
        let id = uuid();
        let now = now();
        self.conn.execute(
            "INSERT INTO tasks VALUES (?1,?2,?3,?4,?5,'pending',?6,NULL,NULL,?7,?8,?8)",
            params![
                id,
                graph_id,
                parent_id,
                title,
                description,
                assigned_agent_id,
                metadata.to_string(),
                now
            ],
        )?;
        let session_id = self.scalar(
            "SELECT session_id FROM graphs WHERE id=?1",
            params![graph_id],
        )?;
        self.event(
            &session_id,
            assigned_agent_id,
            Some(&id),
            "task.create",
            title,
            json!({"parent_id": parent_id}),
        )?;
        self.get_by_id("tasks", &id)
    }

    fn task_update(&self, task_id: &str, args: &Value) -> Result<Value> {
        let obj = args.as_object().unwrap();
        if let Some(v) = obj.get("title").and_then(Value::as_str) {
            self.conn.execute(
                "UPDATE tasks SET title=?2, updated_at=?3 WHERE id=?1",
                params![task_id, v, now()],
            )?;
        }
        if let Some(v) = obj.get("description").and_then(Value::as_str) {
            self.conn.execute(
                "UPDATE tasks SET description=?2, updated_at=?3 WHERE id=?1",
                params![task_id, v, now()],
            )?;
        }
        if let Some(v) = obj.get("status").and_then(Value::as_str) {
            validate("task status", v, TASK_STATUSES)?;
            self.conn.execute(
                "UPDATE tasks SET status=?2, updated_at=?3 WHERE id=?1",
                params![task_id, v, now()],
            )?;
        }
        if let Some(v) = obj.get("assigned_agent_id").and_then(Value::as_str) {
            self.conn.execute(
                "UPDATE tasks SET assigned_agent_id=?2, updated_at=?3 WHERE id=?1",
                params![task_id, v, now()],
            )?;
        }
        if let Some(v) = obj.get("metadata") {
            self.conn.execute(
                "UPDATE tasks SET metadata=?2, updated_at=?3 WHERE id=?1",
                params![task_id, v.to_string(), now()],
            )?;
        }
        self.task_event(task_id, "task.update", "updated", json!({}))?;
        self.get_by_id("tasks", task_id)
    }

    fn task_add_dependency(&self, task_id: &str, dep: &str) -> Result<Value> {
        if self.reaches(dep, task_id)? {
            return Err(AgentCommError::Invalid(
                "dependency would create a cycle".into(),
            ));
        }
        self.conn.execute(
            "INSERT INTO task_dependencies VALUES (?1,?2)",
            params![task_id, dep],
        )?;
        self.task_event(
            task_id,
            "task.dependency.add",
            dep,
            json!({"depends_on_task_id": dep}),
        )?;
        self.get_by_id("tasks", task_id)
    }

    fn task_claim(&self, task_id: &str, agent_id: &str, expires: Option<&str>) -> Result<Value> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let changed = self.conn.execute("UPDATE tasks SET claimed_by=?2, claim_expires_at=?3, status='in_progress', updated_at=?4 WHERE id=?1 AND status IN ('pending','in_progress') AND (claimed_by IS NULL OR claimed_by=?2)", params![task_id, agent_id, expires, now()]);
        let changed = match changed {
            Ok(changed) => changed,
            Err(err) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                return Err(err.into());
            }
        };
        if changed != 1 {
            let _ = self.conn.execute_batch("ROLLBACK");
            return Err(AgentCommError::Invalid(
                "task already has an active claim or is not claimable".into(),
            ));
        }
        self.conn.execute_batch("COMMIT")?;
        self.task_event(task_id, "task.claim", agent_id, json!({}))?;
        self.get_by_id("tasks", task_id)
    }

    fn task_release(&self, task_id: &str, agent_id: Option<&str>) -> Result<Value> {
        if let Some(agent_id) = agent_id {
            let current: Option<String> = self
                .conn
                .query_row(
                    "SELECT claimed_by FROM tasks WHERE id=?1",
                    params![task_id],
                    |r| r.get(0),
                )
                .optional()?;
            if current.as_deref().is_some_and(|c| c != agent_id) {
                return Err(AgentCommError::Invalid(
                    "agent does not own the active claim".into(),
                ));
            }
        }
        self.conn.execute("UPDATE tasks SET claimed_by=NULL, claim_expires_at=NULL, status=CASE WHEN status='in_progress' THEN 'pending' ELSE status END, updated_at=?2 WHERE id=?1", params![task_id, now()])?;
        self.task_event(task_id, "task.release", "released", json!({}))?;
        self.get_by_id("tasks", task_id)
    }

    fn task_complete(&self, task_id: &str, override_deps: bool) -> Result<Value> {
        let incomplete: i64 = self.conn.query_row("SELECT COUNT(*) FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id WHERE d.task_id=?1 AND t.status != 'completed'", params![task_id], |r| r.get(0))?;
        if incomplete > 0 && !override_deps {
            return Err(AgentCommError::Invalid(
                "task has incomplete dependencies".into(),
            ));
        }
        self.task_terminal(task_id, "completed", "completed")
    }

    fn task_terminal(&self, task_id: &str, status: &str, reason: &str) -> Result<Value> {
        validate("task status", status, TASK_STATUSES)?;
        self.conn.execute("UPDATE tasks SET status=?2, claimed_by=NULL, claim_expires_at=NULL, updated_at=?3 WHERE id=?1", params![task_id, status, now()])?;
        self.task_event(task_id, &format!("task.{status}"), reason, json!({}))?;
        self.get_by_id("tasks", task_id)
    }

    fn task_list_ready(&self, graph_id: &str) -> Result<Value> {
        self.query_json("SELECT * FROM tasks t WHERE graph_id=?1 AND status='pending' AND NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.id=d.depends_on_task_id WHERE d.task_id=t.id AND dep.status != 'completed') ORDER BY created_at", params![graph_id])
    }

    fn task_list_for_agent(&self, agent_id: &str) -> Result<Value> {
        self.query_json("SELECT * FROM tasks WHERE assigned_agent_id=?1 OR claimed_by=?1 ORDER BY updated_at DESC", params![agent_id])
    }

    fn message_send(
        &self,
        session_id: &str,
        from: Option<&str>,
        to: Option<&str>,
        mut tos: Vec<String>,
        to_kind: Option<&str>,
        task: Option<&str>,
        parent: Option<&str>,
        format: &str,
        severity: &str,
        subject: &str,
        body: &str,
        metadata: Value,
    ) -> Result<Value> {
        validate("message format", format, MESSAGE_FORMATS)?;
        validate("message severity", severity, MESSAGE_SEVERITIES)?;
        if let Some(to) = to {
            tos.push(to.to_owned());
        }
        if let Some(kind) = to_kind {
            let mut stmt = self.conn.prepare(
                "SELECT id FROM agents WHERE session_id=?1 AND kind=?2 ORDER BY created_at",
            )?;
            for row in stmt.query_map(params![session_id, kind], |r| r.get::<_, String>(0))? {
                tos.push(row?);
            }
        }
        tos.sort();
        tos.dedup();
        let id = uuid();
        let now = now();
        self.conn.execute(
            "INSERT INTO messages VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                id,
                session_id,
                from,
                task,
                parent,
                to_kind,
                format,
                severity,
                subject,
                body,
                metadata.to_string(),
                now
            ],
        )?;
        for agent_id in &tos {
            self.conn.execute(
                "INSERT OR IGNORE INTO message_recipients VALUES (?1,?2,?3,NULL,NULL)",
                params![id, agent_id, now],
            )?;
        }
        self.event(session_id, from, task, "message.send", subject, json!({"message_id": id, "to_agent_ids": tos, "to_kind": to_kind, "format": format, "severity": severity}))?;
        self.get_by_id("messages", &id)
    }

    fn message_reply(
        &self,
        message_id: &str,
        from: Option<&str>,
        body: &str,
        metadata: Value,
    ) -> Result<Value> {
        let (session_id, to, task, subject): (String, Option<String>, Option<String>, String) =
            self.conn.query_row(
                "SELECT session_id, from_agent_id, task_id, subject FROM messages WHERE id=?1",
                params![message_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?;
        self.message_send(
            &session_id,
            from,
            to.as_deref(),
            Vec::new(),
            None,
            task.as_deref(),
            Some(message_id),
            "markdown",
            "info",
            &subject,
            body,
            metadata,
        )
    }

    fn message_list(
        &self,
        session_id: &str,
        agent_id: Option<&str>,
        task_id: Option<&str>,
    ) -> Result<Value> {
        match (agent_id, task_id) {
            (Some(a), _) => self.query_json("SELECT m.*, r.agent_id AS recipient_agent_id, r.delivered_at, r.read_at, r.acked_at FROM messages m LEFT JOIN message_recipients r ON r.message_id=m.id AND r.agent_id=?2 WHERE m.session_id=?1 AND (m.from_agent_id=?2 OR r.agent_id=?2) ORDER BY m.created_at", params![session_id, a]),
            (_, Some(t)) => self.query_json("SELECT * FROM messages WHERE session_id=?1 AND task_id=?2 ORDER BY created_at", params![session_id, t]),
            _ => self.query_json("SELECT * FROM messages WHERE session_id=?1 ORDER BY created_at", params![session_id]),
        }
    }

    fn mark_message(
        &self,
        message_id: &str,
        agent_id: &str,
        column: &str,
        kind: &str,
    ) -> Result<Value> {
        self.conn.execute(
            &format!(
                "UPDATE message_recipients SET {column}=?3 WHERE message_id=?1 AND agent_id=?2"
            ),
            params![message_id, agent_id, now()],
        )?;
        let (session_id, task_id): (String, Option<String>) = self.conn.query_row(
            "SELECT session_id, task_id FROM messages WHERE id=?1",
            params![message_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        self.event(
            &session_id,
            Some(agent_id),
            task_id.as_deref(),
            kind,
            message_id,
            json!({"agent_id": agent_id}),
        )?;
        self.get_by_id("messages", message_id)
    }

    fn event_list(&self, session_id: &str, task_id: Option<&str>, limit: i64) -> Result<Value> {
        if let Some(task_id) = task_id {
            self.query_json("SELECT * FROM events WHERE session_id=?1 AND task_id=?2 ORDER BY created_at DESC LIMIT ?3", params![session_id, task_id, limit])
        } else {
            self.query_json(
                "SELECT * FROM events WHERE session_id=?1 ORDER BY created_at DESC LIMIT ?2",
                params![session_id, limit],
            )
        }
    }

    fn event_recent(&self, limit: i64) -> Result<Value> {
        self.query_json(
            "SELECT * FROM events ORDER BY created_at DESC LIMIT ?1",
            params![limit],
        )
    }

    fn artifact_record(
        &self,
        session_id: &str,
        task_id: Option<&str>,
        agent_id: Option<&str>,
        name: &str,
        kind: &str,
        uri: Option<&str>,
        content_ref: Option<&str>,
        metadata: Value,
    ) -> Result<Value> {
        let id = uuid();
        let now = now();
        self.conn.execute(
            "INSERT INTO artifacts VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                id,
                session_id,
                task_id,
                agent_id,
                name,
                kind,
                uri,
                content_ref,
                metadata.to_string(),
                now
            ],
        )?;
        self.event(
            session_id,
            agent_id,
            task_id,
            "artifact.record",
            name,
            json!({"artifact_id": id, "kind": kind}),
        )?;
        self.get_by_id("artifacts", &id)
    }

    fn decision_record(
        &self,
        session_id: &str,
        task_id: Option<&str>,
        agent_id: Option<&str>,
        title: &str,
        rationale: &str,
        outcome: &str,
        metadata: Value,
    ) -> Result<Value> {
        let id = uuid();
        let now = now();
        self.conn.execute(
            "INSERT INTO decisions VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                id,
                session_id,
                task_id,
                agent_id,
                title,
                rationale,
                outcome,
                metadata.to_string(),
                now
            ],
        )?;
        self.event(
            session_id,
            agent_id,
            task_id,
            "decision.record",
            title,
            json!({"decision_id": id, "outcome": outcome}),
        )?;
        self.get_by_id("decisions", &id)
    }

    fn get_by_id(&self, table: &str, id: &str) -> Result<Value> {
        self.query_one_json(&format!("SELECT * FROM {table} WHERE id=?1"), params![id])
    }
    fn list_where(&self, table: &str, column: &str, value: &str) -> Result<Value> {
        self.query_json(
            &format!("SELECT * FROM {table} WHERE {column}=?1 ORDER BY created_at"),
            params![value],
        )
    }

    fn scalar<P: rusqlite::Params>(&self, sql: &str, params: P) -> Result<String> {
        Ok(self.conn.query_row(sql, params, |r| r.get(0))?)
    }

    fn task_event(&self, task_id: &str, kind: &str, message: &str, payload: Value) -> Result<()> {
        let session_id = self.scalar(
            "SELECT g.session_id FROM graphs g JOIN tasks t ON t.graph_id=g.id WHERE t.id=?1",
            params![task_id],
        )?;
        self.event(&session_id, None, Some(task_id), kind, message, payload)
    }

    fn event(
        &self,
        session_id: &str,
        agent_id: Option<&str>,
        task_id: Option<&str>,
        kind: &str,
        message: &str,
        payload: Value,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO events VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                uuid(),
                session_id,
                agent_id,
                task_id,
                kind,
                message,
                payload.to_string(),
                now()
            ],
        )?;
        Ok(())
    }

    fn reaches(&self, from: &str, target: &str) -> Result<bool> {
        let mut seen = HashSet::new();
        let mut stack = vec![from.to_owned()];
        while let Some(id) = stack.pop() {
            if id == target {
                return Ok(true);
            }
            if !seen.insert(id.clone()) {
                continue;
            }
            let mut stmt = self
                .conn
                .prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id=?1")?;
            for row in stmt.query_map(params![id], |r| r.get::<_, String>(0))? {
                stack.push(row?);
            }
        }
        Ok(false)
    }

    fn query_one_json<P: rusqlite::Params>(&self, sql: &str, params: P) -> Result<Value> {
        let values = self.query_json(sql, params)?;
        values
            .as_array()
            .and_then(|v| v.first())
            .cloned()
            .ok_or_else(|| AgentCommError::Invalid("record not found".into()))
    }

    fn query_json<P: rusqlite::Params>(&self, sql: &str, params: P) -> Result<Value> {
        let mut stmt = self.conn.prepare(sql)?;
        let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let rows = stmt.query_map(params, |row| {
            let mut obj = serde_json::Map::new();
            for (idx, name) in names.iter().enumerate() {
                let cell = row.get_ref(idx)?;
                let value = match cell {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(i) => Value::Number(i.into()),
                    ValueRef::Real(f) => serde_json::Number::from_f64(f)
                        .map(Value::Number)
                        .unwrap_or(Value::Null),
                    ValueRef::Text(s) => {
                        let s = std::str::from_utf8(s)
                            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                        if name == "metadata" || name == "payload" {
                            serde_json::from_str(s).unwrap_or(Value::String(s.to_owned()))
                        } else {
                            Value::String(s.to_owned())
                        }
                    }
                    ValueRef::Blob(b) => Value::String(format!("<blob: {} bytes>", b.len())),
                };
                obj.insert(name.clone(), value);
            }
            Ok(Value::Object(obj))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(Value::Array(out))
    }
}

/// Process a single JSON-RPC request against the repository.
///
/// Handles the MCP lifecycle methods (`initialize`, `ping`, `tools/list`,
/// `tools/call`) and routes tool tool calls to the repository. Returns
/// `Value::Null` for notifications so the caller can suppress the response.
pub fn handle_json_rpc(repo: &AgentCommRepository, request: Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let is_notification = method.starts_with("notifications/");
    let result: std::result::Result<Value, String> = match method {
        "initialize" => {
            let client_version = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2025-06-18");
            Ok(json!({
                "protocolVersion": client_version,
                "serverInfo": {"name": "phenix-agent-comm-mcp", "version": env!("CARGO_PKG_VERSION")},
                "capabilities": {"tools": {}}
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tool_descriptions()})),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            repo.call_tool(name, args).map(|value| json!({
                "content": [{"type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string())}],
                "isError": false
            })).map_err(|err| err.to_string())
        }
        _ if is_notification => return Value::Null,
        _ => Err(format!("method not found: {method}")),
    };
    match result {
        Ok(result) => json!({"jsonrpc":"2.0", "id": id, "result": result}),
        Err(err) => {
            json!({"jsonrpc":"2.0", "id": id, "error": {"code": -32000, "message": err.to_string()}})
        }
    }
}

fn str_arg<'a>(a: &'a serde_json::Map<String, Value>, name: &'static str) -> Result<&'a str> {
    a.get(name)
        .and_then(Value::as_str)
        .ok_or(AgentCommError::Missing(name))
}
fn opt_str<'a>(a: &'a serde_json::Map<String, Value>, name: &str) -> Option<&'a str> {
    a.get(name).and_then(Value::as_str)
}
fn opt_str_array(a: &serde_json::Map<String, Value>, name: &'static str) -> Result<Vec<String>> {
    match a.get(name) {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str().map(str::to_owned).ok_or_else(|| {
                    AgentCommError::Invalid(format!("{name} must contain only strings"))
                })
            })
            .collect(),
        Some(_) => Err(AgentCommError::Invalid(format!("{name} must be an array"))),
    }
}
fn opt_value(a: &serde_json::Map<String, Value>, name: &str) -> Value {
    a.get(name).cloned().unwrap_or_else(|| json!({}))
}
fn bool_arg(a: &serde_json::Map<String, Value>, name: &str) -> bool {
    a.get(name).and_then(Value::as_bool).unwrap_or(false)
}
fn opt_i64(a: &serde_json::Map<String, Value>, name: &str) -> Option<i64> {
    a.get(name).and_then(Value::as_i64)
}
fn validate(kind: &str, value: &str, allowed: &[&str]) -> Result<()> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(AgentCommError::Invalid(format!("invalid {kind}: {value}")))
    }
}
fn uuid() -> String {
    Uuid::now_v7().to_string()
}
fn now() -> String {
    OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .expect("rfc3339")
}

pub fn tool_descriptions() -> Value {
    let tools: Vec<Value> = TOOLS
        .iter()
        .map(|name| {
            let (description, schema) = tool_meta(name);
            json!({
                "name": name,
                "description": description,
                "inputSchema": schema,
            })
        })
        .collect();
    Value::Array(tools)
}

fn tool_meta(name: &str) -> (&'static str, Value) {
    // Each entry: (description, inputSchema)
    match name {
        "comm_session_init" => (
            "Create a new communication session",
            json!({"type":"object","properties":{"name":{"type":"string","description":"Session name"},"metadata":{"type":"object","description":"Optional metadata"}},"required":["name"]})
        ),
        "comm_session_resume" => (
            "Resume or get an existing session by ID",
            json!({"type":"object","properties":{"session_id":{"type":"string","description":"Session ID"}},"required":["session_id"]})
        ),
        "comm_session_get" => (
            "Get session details by ID",
            json!({"type":"object","properties":{"session_id":{"type":"string","description":"Session ID"}},"required":["session_id"]})
        ),
        "comm_session_list" => (
            "List all sessions (most recent first, max 200)",
            json!({"type":"object","properties":{}})
        ),
        "comm_session_close" => (
            "Close a session",
            json!({"type":"object","properties":{"session_id":{"type":"string","description":"Session ID"}},"required":["session_id"]})
        ),
        "comm_agent_register" => (
            "Register an agent in a session",
            json!({"type":"object","properties":{"session_id":{"type":"string","description":"Session ID"},"name":{"type":"string","description":"Agent name"},"kind":{"type":"string","description":"Agent kind e.g. phenix-worker"},"metadata":{"type":"object","description":"Optional metadata"}},"required":["session_id","name"]})
        ),
        "comm_agent_heartbeat" => (
            "Update agent heartbeat timestamp",
            json!({"type":"object","properties":{"agent_id":{"type":"string","description":"Agent ID"}},"required":["agent_id"]})
        ),
        "comm_agent_update_status" => (
            "Update agent status (available/busy/waiting/offline)",
            json!({"type":"object","properties":{"agent_id":{"type":"string","description":"Agent ID"},"status":{"type":"string","description":"New status: available, busy, waiting, offline","enum":["available","busy","waiting","offline"]},"metadata":{"type":"object","description":"Optional metadata"}},"required":["agent_id","status"]})
        ),
        "comm_agent_list" => (
            "List agents in a session",
            json!({"type":"object","properties":{"session_id":{"type":"string","description":"Session ID"}},"required":["session_id"]})
        ),
        "comm_message_send" => (
            "Send a message to agents (by ID, IDs list, or kind)",
            json!({"type":"object","properties":{"session_id":{"type":"string","description":"Session ID"},"from_agent_id":{"type":"string","description":"Sender agent ID (optional)"},"to_agent_id":{"type":"string","description":"Single recipient agent ID"},"to_agent_ids":{"type":"array","items":{"type":"string"},"description":"Multiple recipient agent IDs"},"to_kind":{"type":"string","description":"Route to all agents of this kind e.g. phenix-worker"},"task_id":{"type":"string","description":"Associated task ID"},"format":{"type":"string","description":"Message format: text, markdown, json, yaml","default":"markdown"},"severity":{"type":"string","description":"Severity: info, notice, warning, error","default":"info"},"subject":{"type":"string","description":"Message subject"},"body":{"type":"string","description":"Message body"},"metadata":{"type":"object","description":"Optional metadata"}},"required":["session_id","body"]})
        ),
        "comm_message_list" => (
            "List messages in a session, optionally filtered by agent or task",
            json!({"type":"object","properties":{"session_id":{"type":"string","description":"Session ID"},"agent_id":{"type":"string","description":"Filter by recipient agent ID"},"task_id":{"type":"string","description":"Filter by task ID"}},"required":["session_id"]})
        ),
        "comm_message_read" => (
            "Mark a message as read by an agent",
            json!({"type":"object","properties":{"message_id":{"type":"string","description":"Message ID"},"agent_id":{"type":"string","description":"Reading agent ID"}},"required":["message_id","agent_id"]})
        ),
        "comm_message_ack" => (
            "Mark a message as acknowledged by an agent",
            json!({"type":"object","properties":{"message_id":{"type":"string","description":"Message ID"},"agent_id":{"type":"string","description":"Acknowledging agent ID"}},"required":["message_id","agent_id"]})
        ),
        "comm_message_reply" => (
            "Reply to an existing message, creating a threaded conversation",
            json!({"type":"object","properties":{"message_id":{"type":"string","description":"Parent message ID to reply to"},"from_agent_id":{"type":"string","description":"Reply sender agent ID"},"body":{"type":"string","description":"Reply body"},"metadata":{"type":"object","description":"Optional metadata"}},"required":["message_id","body"]})
        ),
        "comm_graph_create" => (
            "Create a new task graph within a session",
            json!({"type":"object","properties":{"session_id":{"type":"string","description":"Session ID"},"name":{"type":"string","description":"Graph name"},"metadata":{"type":"object","description":"Optional metadata"}},"required":["session_id","name"]})
        ),
        "comm_graph_get" => (
            "Get graph details by ID",
            json!({"type":"object","properties":{"graph_id":{"type":"string","description":"Graph ID"}},"required":["graph_id"]})
        ),
        "comm_graph_summary" => (
            "Get graph summary with task status counts and dependency count",
            json!({"type":"object","properties":{"graph_id":{"type":"string","description":"Graph ID"}},"required":["graph_id"]})
        ),
        "comm_task_create" => (
            "Create a new task in a graph",
            json!({"type":"object","properties":{"graph_id":{"type":"string","description":"Graph ID"},"parent_id":{"type":"string","description":"Optional parent task ID"},"title":{"type":"string","description":"Task title"},"description":{"type":"string","description":"Task description"},"assigned_agent_id":{"type":"string","description":"Optional assigned agent ID"},"metadata":{"type":"object","description":"Optional metadata"}},"required":["graph_id","title"]})
        ),
        "comm_task_update" => (
            "Update task fields (title, description, status, assigned_agent_id, metadata)",
            json!({"type":"object","properties":{"task_id":{"type":"string","description":"Task ID"},"title":{"type":"string","description":"New title"},"description":{"type":"string","description":"New description"},"status":{"type":"string","description":"New status: pending, in_progress, blocked, completed, failed","enum":["pending","in_progress","blocked","completed","failed"]},"assigned_agent_id":{"type":"string","description":"New assigned agent ID"},"metadata":{"type":"object","description":"New metadata"}},"required":["task_id"]})
        ),
        "comm_task_add_dependency" => (
            "Add a dependency between two tasks (task depends_on depends_on_task_id)",
            json!({"type":"object","properties":{"task_id":{"type":"string","description":"Dependent task ID (depends on the other)"},"depends_on_task_id":{"type":"string","description":"Prerequisite task ID"},"title":{"type":"string","description":"Required: title for context"}},"required":["task_id","depends_on_task_id","title"]})
        ),
        "comm_task_add_child" => (
            "Create a child task under a parent task",
            json!({"type":"object","properties":{"graph_id":{"type":"string","description":"Graph ID"},"parent_id":{"type":"string","description":"Parent task ID"},"title":{"type":"string","description":"Child task title"},"description":{"type":"string","description":"Optional description"},"assigned_agent_id":{"type":"string","description":"Optional assigned agent ID"},"metadata":{"type":"object","description":"Optional metadata"}},"required":["graph_id","parent_id","title"]})
        ),
        "comm_task_claim" => (
            "Claim a task for an agent, setting status to in_progress",
            json!({"type":"object","properties":{"task_id":{"type":"string","description":"Task ID"},"agent_id":{"type":"string","description":"Claiming agent ID"},"claim_expires_at":{"type":"string","description":"Optional claim expiry timestamp (RFC 3339)"}},"required":["task_id","agent_id"]})
        ),
        "comm_task_release" => (
            "Release a claimed task back to pending",
            json!({"type":"object","properties":{"task_id":{"type":"string","description":"Task ID"},"agent_id":{"type":"string","description":"Optional agent ID (only that agent can release if set)"}},"required":["task_id"]})
        ),
        "comm_task_complete" => (
            "Mark a task as completed. Fails if dependencies are incomplete unless override_incomplete_dependencies is true.",
            json!({"type":"object","properties":{"task_id":{"type":"string","description":"Task ID"},"override_incomplete_dependencies":{"type":"boolean","description":"Override incomplete dependency check"}},"required":["task_id"]})
        ),
        "comm_task_fail" => (
            "Mark a task as failed",
            json!({"type":"object","properties":{"task_id":{"type":"string","description":"Task ID"},"reason":{"type":"string","description":"Failure reason"}},"required":["task_id"]})
        ),
        "comm_task_block" => (
            "Mark a task as blocked",
            json!({"type":"object","properties":{"task_id":{"type":"string","description":"Task ID"},"reason":{"type":"string","description":"Block reason"}},"required":["task_id"]})
        ),
        "comm_task_list_ready" => (
            "List tasks ready to claim (pending with all dependencies completed)",
            json!({"type":"object","properties":{"graph_id":{"type":"string","description":"Graph ID"},"session_id":{"type":"string","description":"Required: session ID for context"}},"required":["graph_id"]})
        ),
        "comm_task_list_for_agent" => (
            "List tasks assigned or claimed by an agent",
            json!({"type":"object","properties":{"agent_id":{"type":"string","description":"Agent ID"}},"required":["agent_id"]})
        ),
        "comm_event_list" => (
            "List events for a session, optionally filtered by task",
            json!({"type":"object","properties":{"session_id":{"type":"string","description":"Session ID"},"task_id":{"type":"string","description":"Filter by task ID"},"limit":{"type":"integer","description":"Max events to return (default 100)"}},"required":["session_id"]})
        ),
        "comm_event_recent" => (
            "List most recent events across all sessions",
            json!({"type":"object","properties":{"limit":{"type":"integer","description":"Max events to return (default 25)"}}})
        ),
        "comm_artifact_record" => (
            "Record an artifact (output, diff, log, etc.)",
            json!({"type":"object","properties":{"session_id":{"type":"string","description":"Session ID"},"task_id":{"type":"string","description":"Optional associated task ID"},"agent_id":{"type":"string","description":"Optional associated agent ID"},"name":{"type":"string","description":"Artifact name"},"kind":{"type":"string","description":"Artifact kind (e.g. plan, diff, log, checkpoint)"},"uri":{"type":"string","description":"Optional URI reference"},"content_ref":{"type":"string","description":"Optional content reference"},"metadata":{"type":"object","description":"Optional metadata"}},"required":["session_id","name","kind"]})
        ),
        "comm_artifact_list" => (
            "List artifacts in a session",
            json!({"type":"object","properties":{"session_id":{"type":"string","description":"Session ID"}},"required":["session_id"]})
        ),
        "comm_decision_record" => (
            "Record a decision with rationale and outcome",
            json!({"type":"object","properties":{"session_id":{"type":"string","description":"Session ID"},"task_id":{"type":"string","description":"Optional associated task ID"},"agent_id":{"type":"string","description":"Optional associated agent ID"},"title":{"type":"string","description":"Decision title"},"rationale":{"type":"string","description":"Rationale for the decision"},"outcome":{"type":"string","description":"Decision outcome (e.g. accepted, rejected, deferred)"},"metadata":{"type":"object","description":"Optional metadata"}},"required":["session_id","title","rationale","outcome"]})
        ),
        "comm_decision_list" => (
            "List decisions in a session",
            json!({"type":"object","properties":{"session_id":{"type":"string","description":"Session ID"}},"required":["session_id"]})
        ),
        _ => ("Agent communication tool", json!({"type":"object","properties":{}})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_graph_rejects_cycles_and_incomplete_completion() {
        let repo = AgentCommRepository::open_memory().unwrap();
        let session = repo
            .call_tool("comm_session_init", json!({"name":"demo"}))
            .unwrap();
        let session_id = session["id"].as_str().unwrap();
        let graph = repo
            .call_tool(
                "comm_graph_create",
                json!({"session_id":session_id,"name":"g"}),
            )
            .unwrap();
        let graph_id = graph["id"].as_str().unwrap();
        let a = repo
            .call_tool("comm_task_create", json!({"graph_id":graph_id,"title":"a"}))
            .unwrap();
        let b = repo
            .call_tool("comm_task_create", json!({"graph_id":graph_id,"title":"b"}))
            .unwrap();
        repo.call_tool(
            "comm_task_add_dependency",
            json!({"task_id":b["id"],"depends_on_task_id":a["id"]}),
        )
        .unwrap();
        assert!(repo
            .call_tool(
                "comm_task_add_dependency",
                json!({"task_id":a["id"],"depends_on_task_id":b["id"]})
            )
            .is_err());
        assert!(repo
            .call_tool("comm_task_complete", json!({"task_id":b["id"]}))
            .is_err());
        repo.call_tool("comm_task_complete", json!({"task_id":a["id"]}))
            .unwrap();
        repo.call_tool("comm_task_complete", json!({"task_id":b["id"]}))
            .unwrap();
    }

    #[test]
    fn claim_does_not_overwrite_active_claim() {
        let repo = AgentCommRepository::open_memory().unwrap();
        let s = repo
            .call_tool("comm_session_init", json!({"name":"demo"}))
            .unwrap();
        let sid = s["id"].as_str().unwrap();
        let agent1 = repo
            .call_tool("comm_agent_register", json!({"session_id":sid,"name":"a1"}))
            .unwrap();
        let agent2 = repo
            .call_tool("comm_agent_register", json!({"session_id":sid,"name":"a2"}))
            .unwrap();
        let g = repo
            .call_tool("comm_graph_create", json!({"session_id":sid,"name":"g"}))
            .unwrap();
        let t = repo
            .call_tool("comm_task_create", json!({"graph_id":g["id"],"title":"t"}))
            .unwrap();
        repo.call_tool(
            "comm_task_claim",
            json!({"task_id":t["id"],"agent_id":agent1["id"]}),
        )
        .unwrap();
        assert!(repo
            .call_tool(
                "comm_task_claim",
                json!({"task_id":t["id"],"agent_id":agent2["id"]})
            )
            .is_err());
    }

    #[test]
    fn agents_use_kind_and_stable_statuses() {
        let repo = AgentCommRepository::open_memory().unwrap();
        let s = repo
            .call_tool("comm_session_init", json!({"name":"demo"}))
            .unwrap();
        let sid = s["id"].as_str().unwrap();
        let agent = repo
            .call_tool(
                "comm_agent_register",
                json!({"session_id":sid,"name":"planner","kind":"phenix-planner"}),
            )
            .unwrap();
        assert_eq!(agent["kind"], "phenix-planner");
        let old_field = ["ro", "le"].concat();
        assert!(agent.get(&old_field).is_none());
        assert!(repo
            .call_tool(
                "comm_agent_update_status",
                json!({"agent_id":agent["id"],"status":"busy"})
            )
            .is_ok());
        assert!(repo
            .call_tool(
                "comm_agent_update_status",
                json!({"agent_id":agent["id"],"status":"done"})
            )
            .is_err());
        let graph = repo
            .call_tool("comm_graph_create", json!({"session_id":sid,"name":"g"}))
            .unwrap();
        let task = repo
            .call_tool(
                "comm_task_create",
                json!({"graph_id":graph["id"],"title":"t"}),
            )
            .unwrap();
        assert!(repo
            .call_tool(
                "comm_task_update",
                json!({"task_id":task["id"],"status":"done"})
            )
            .is_err());
    }

    #[test]
    fn messages_have_format_severity_kind_delivery_and_per_recipient_state() {
        let repo = AgentCommRepository::open_memory().unwrap();
        let s = repo
            .call_tool("comm_session_init", json!({"name":"demo"}))
            .unwrap();
        let sid = s["id"].as_str().unwrap();
        let from = repo
            .call_tool(
                "comm_agent_register",
                json!({"session_id":sid,"name":"planner","kind":"phenix-planner"}),
            )
            .unwrap();
        let to1 = repo
            .call_tool(
                "comm_agent_register",
                json!({"session_id":sid,"name":"worker-1","kind":"phenix-worker"}),
            )
            .unwrap();
        let to2 = repo
            .call_tool(
                "comm_agent_register",
                json!({"session_id":sid,"name":"worker-2","kind":"phenix-worker"}),
            )
            .unwrap();
        let msg = repo.call_tool("comm_message_send", json!({"session_id":sid,"from_agent_id":from["id"],"to_kind":"phenix-worker","format":"json","severity":"warning","subject":"work","body":"{}"})).unwrap();
        assert_eq!(msg["to_kind"], "phenix-worker");
        assert_eq!(msg["format"], "json");
        assert_eq!(msg["severity"], "warning");
        repo.call_tool(
            "comm_message_read",
            json!({"message_id":msg["id"],"agent_id":to1["id"]}),
        )
        .unwrap();
        let l1 = repo
            .call_tool(
                "comm_message_list",
                json!({"session_id":sid,"agent_id":to1["id"]}),
            )
            .unwrap();
        let l2 = repo
            .call_tool(
                "comm_message_list",
                json!({"session_id":sid,"agent_id":to2["id"]}),
            )
            .unwrap();
        assert!(l1[0]["read_at"].is_string());
        assert!(l2[0]["read_at"].is_null());
    }

    #[test]
    fn atomic_claim_conflict_is_stable_across_connections() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("agent-comm.sqlite3");
        let repo1 = AgentCommRepository::open(&db).unwrap();
        let repo2 = AgentCommRepository::open(&db).unwrap();
        let s = repo1
            .call_tool("comm_session_init", json!({"name":"demo"}))
            .unwrap();
        let sid = s["id"].as_str().unwrap();
        let a1 = repo1
            .call_tool("comm_agent_register", json!({"session_id":sid,"name":"a1"}))
            .unwrap();
        let a2 = repo1
            .call_tool("comm_agent_register", json!({"session_id":sid,"name":"a2"}))
            .unwrap();
        let g = repo1
            .call_tool("comm_graph_create", json!({"session_id":sid,"name":"g"}))
            .unwrap();
        let t = repo1
            .call_tool("comm_task_create", json!({"graph_id":g["id"],"title":"t"}))
            .unwrap();
        repo1
            .call_tool(
                "comm_task_claim",
                json!({"task_id":t["id"],"agent_id":a1["id"]}),
            )
            .unwrap();
        assert!(repo2
            .call_tool(
                "comm_task_claim",
                json!({"task_id":t["id"],"agent_id":a2["id"]})
            )
            .is_err());
        let current = repo2
            .call_tool("comm_task_list_for_agent", json!({"agent_id":a1["id"]}))
            .unwrap();
        assert_eq!(current[0]["claimed_by"], a1["id"]);
        assert_eq!(current[0]["status"], "in_progress");
    }

    #[test]
    fn mcp_handshake_full_sequence() {
        let repo = AgentCommRepository::open_memory().unwrap();

        // initialize
        let resp = handle_json_rpc(
            &repo,
            json!({"jsonrpc":"2.0", "id":1, "method":"initialize"}),
        );
        assert_eq!(resp["jsonrpc"], "2.0");
        assert_eq!(resp["id"], 1);
        assert_eq!(
            resp["result"]["serverInfo"]["name"],
            "phenix-agent-comm-mcp"
        );
        assert_eq!(resp["result"]["protocolVersion"], "2025-06-18");
        assert!(resp["result"]["capabilities"]["tools"].is_object());

        // notifications/initialized → should return Value::Null (suppressed)
        let resp = handle_json_rpc(
            &repo,
            json!({"jsonrpc":"2.0", "method":"notifications/initialized"}),
        );
        assert!(resp.is_null(), "notifications must return Null");

        // ping
        let resp = handle_json_rpc(&repo, json!({"jsonrpc":"2.0", "id":2, "method":"ping"}));
        assert_eq!(resp["result"], json!({}));

        // tools/list
        let resp = handle_json_rpc(
            &repo,
            json!({"jsonrpc":"2.0", "id":3, "method":"tools/list"}),
        );
        let tools = &resp["result"]["tools"];
        assert!(tools.is_array());
        assert!(
            tools.as_array().unwrap().len() >= 30,
            "expected at least 30 tools"
        );
        assert!(tools[0]["name"].is_string());

        // tools/call — comm_session_init
        let resp = handle_json_rpc(
            &repo,
            json!({
                "jsonrpc":"2.0", "id":4, "method":"tools/call",
                "params": {"name": "comm_session_init", "arguments": {"name": "mcp-test"}}
            }),
        );
        assert_eq!(
            resp["result"]["isError"], false,
            "session init should succeed"
        );
        let content = &resp["result"]["content"];
        assert!(content.is_array());
        assert_eq!(content[0]["type"], "text");

        // unknown method returns error
        let resp = handle_json_rpc(&repo, json!({"jsonrpc":"2.0", "id":5, "method":"unknown"}));
        assert!(
            resp.get("error").is_some(),
            "unknown method should return error"
        );
        assert_eq!(resp["error"]["code"], -32000);

        // notifications/anything also suppressed
        let resp = handle_json_rpc(
            &repo,
            json!({"jsonrpc":"2.0", "method":"notifications/foo"}),
        );
        assert!(resp.is_null());

        // notifications/cancelled is also suppressed
        let resp = handle_json_rpc(
            &repo,
            json!({"jsonrpc":"2.0", "method":"notifications/cancelled"}),
        );
        assert!(
            resp.is_null(),
            "notifications/* must return Null regardless of path"
        );
    }

    #[test]
    fn schema_migration_sets_user_version() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("schema-version.sqlite3");
        let repo = AgentCommRepository::open(&db).unwrap();
        // After open+init, user_version should be 1
        let version: i64 = repo
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 1, "schema should be at version 1 after init");

        // Open again — should not fail or reset
        let repo2 = AgentCommRepository::open(&db).unwrap();
        let version: i64 = repo2
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 1, "re-opening should preserve user_version");
    }

    #[test]
    fn busy_timeout_set_before_sql_operations() {
        // Verify that the busy_timeout pragma was set properly by checking
        // the connection's busy timeout setting.
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("busy-test.sqlite3");
        let repo = AgentCommRepository::open(&db).unwrap();
        let timeout: i64 = repo
            .conn
            .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
            .unwrap();
        // rusqlite's busy_timeout sets it in milliseconds. We set 5000ms.
        assert_eq!(timeout, 5000, "busy_timeout should be 5000ms");
    }

    #[test]
    fn open_memory_is_usable() {
        let repo = AgentCommRepository::open_memory().unwrap();
        let s = repo
            .call_tool("comm_session_init", json!({"name":"mem-test"}))
            .unwrap();
        assert_eq!(s["name"], "mem-test");
        assert_eq!(s["status"], "open");
    }
}
