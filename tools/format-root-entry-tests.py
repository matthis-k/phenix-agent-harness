from pathlib import Path


path = Path("modules/phenix-pi/tests/root-workflow-entry-routing.test.ts")
text = path.read_text()
old_collect = '''    const events = await collect(
      stream(makeModel("phenix", "free"), context, { sessionId }),
    );
'''
new_collect = '''    const events = await collect(stream(makeModel("phenix", "free"), context, { sessionId }));
'''
if text.count(old_collect) != 2:
    raise SystemExit("unexpected root entry collect formatting context")
text = text.replace(old_collect, new_collect)
old_message = '''      const publicMessage =
        event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
'''
new_message = '''      const publicMessage =
        event.type === "done"
          ? event.message
          : event.type === "error"
            ? event.error
            : event.partial;
'''
if old_message not in text:
    raise SystemExit("unexpected root entry message formatting context")
path.write_text(text.replace(old_message, new_message, 1))

path = Path("modules/phenix-pi/tests/routing-stream-failover.test.ts")
text = path.read_text()
old_import = '''  clearActiveRouteForSession,
  createRouterStream,
  setActiveRouteForSession,
  type RouterStreamDependencies,
  type RouterStreamFunction,
'''
new_import = '''  clearActiveRouteForSession,
  createRouterStream,
  type RouterStreamDependencies,
  type RouterStreamFunction,
  setActiveRouteForSession,
'''
if old_import not in text:
    raise SystemExit("unexpected failover import formatting context")
path.write_text(text.replace(old_import, new_import, 1))
