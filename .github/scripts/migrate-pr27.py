from pathlib import Path

adapter = Path("modules/phenix-pi/extensions/phenix-runtime/session-subagent-adapter.ts")
text = adapter.read_text()

status_anchor = '''function statusForError(error: SubagentExecutionError): SubagentStatus {
  if (error.code === "ABORTED") return "cancelled";
  if (error.code === "ORPHANED_SESSION") return "orphaned";
  return "failed";
}
'''
projection = '''function statusForError(error: SubagentExecutionError): SubagentStatus {
  if (error.code === "ABORTED") return "cancelled";
  if (error.code === "ORPHANED_SESSION") return "orphaned";
  return "failed";
}

function projectChildEvent(
  event: ChildSessionEvent,
  snapshot: SubagentSnapshot,
): SubagentEvent {
  switch (event.type) {
    case "session.started":
    case "session.disposed":
      return { type: event.type, snapshot };
    case "agent.event":
      return { type: event.type, snapshot, event: event.event };
    case "tool.started":
      return { type: event.type, snapshot, toolName: event.toolName };
    case "tool.completed":
      return {
        type: event.type,
        snapshot,
        toolName: event.toolName,
        isError: event.isError,
      };
    case "cycle.settled":
      return { type: event.type, snapshot, cycle: event.cycle };
    case "session.failed":
      return {
        type: event.type,
        snapshot,
        error: {
          code: event.error.code,
          message: event.error.message,
        },
      };
    case "session.cancelled":
      return { type: event.type, snapshot, reason: event.reason };
  }
}
'''
if text.count(status_anchor) != 1:
    raise RuntimeError("statusForError anchor not found exactly once")
text = text.replace(status_anchor, projection)

old_subscribe = '''  subscribe(listener: (event: SubagentEvent) => void): () => void {
    return this.run.subscribe((event) => {
      this.observe(event);
      listener({
        type: event.type,
        snapshot: this.snapshot(),
        data: event,
      });
    });
  }
'''
new_subscribe = '''  subscribe(listener: (event: SubagentEvent) => void): () => void {
    return this.run.subscribe((event) => {
      this.observe(event);
      listener(projectChildEvent(event, this.snapshot()));
    });
  }
'''
if text.count(old_subscribe) != 1:
    raise RuntimeError("legacy subscribe projection not found exactly once")
text = text.replace(old_subscribe, new_subscribe)
adapter.write_text(text)

test_path = Path("modules/phenix-pi/tests/session-subagent-adapter.test.ts")
test = test_path.read_text()
test = test.replace(
    '''  type RuntimeBindings,
  returns,
  routing,
''',
    '''  type RuntimeBindings,
  returnsWithDecoder,
  routing,
  type SubagentEvent,
''',
)
test = test.replace(
    '''    returns: returns<SummaryResult>({
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: { summary: { type: "string" } },
    }),
''',
    '''    returns: returnsWithDecoder<SummaryResult>(
      {
        type: "object",
        additionalProperties: false,
        required: ["summary"],
        properties: { summary: { type: "string" } },
      },
      (value) => value as SummaryResult,
    ),
''',
)
test = test.replace(
    '''  private status: ChildSessionNode["status"] = "running";
''',
    '''  private status: ChildSessionNode["status"] = "running";
  private listener?: (event: ChildSessionEvent) => void;
''',
)
test = test.replace(
    '''  subscribe(_listener: (event: ChildSessionEvent) => void): () => void {
    return () => {};
  }
''',
    '''  subscribe(listener: (event: ChildSessionEvent) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  emit(event: ChildSessionEvent): void {
    this.listener?.(event);
  }
''',
)
insert_anchor = '''  it("cancels a result wait without cancelling child execution", async () => {
'''
event_test = '''  it("projects backend events into the stable public event protocol", async () => {
    const { manager, sessions, acceptance } = managerWith();
    const handle = await manager.spawn(request());
    const events: SubagentEvent[] = [];
    handle.subscribe((event) => events.push(event));

    sessions.run.emit({
      type: "tool.completed",
      runId: sessions.run.id,
      toolName: "read",
      isError: false,
    });

    assert.deepEqual(events, [
      {
        type: "tool.completed",
        snapshot: {
          id: "adapter-child",
          status: "running",
          model: { provider: "opencode-go", id: "deepseek-v4-flash" },
          thinking: "medium",
        },
        toolName: "read",
        isError: false,
      },
    ]);
    assert.equal("data" in events[0], false);

    acceptance.pending.resolve({ summary: "done" });
    await handle.result();
  });

'''
if test.count(insert_anchor) != 1:
    raise RuntimeError("adapter event test insertion anchor not found exactly once")
test = test.replace(insert_anchor, event_test + insert_anchor)
test_path.write_text(test)
