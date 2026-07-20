import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createTaskRuntimeFacade } from "./index.ts";
import { createTaskClientTools, createTaskTools } from "./pi-tools.ts";
import { taskClientFromEnvironment } from "./transport.ts";

/**
 * Standalone process entry.
 *
 * A process-backed child receives a Unix-socket endpoint and opaque subtree
 * capability from its backend. An ordinary standalone session gets a local
 * root tree instead.
 */
export default async function phenixTasks(pi: ExtensionAPI): Promise<void> {
  const remoteClient = taskClientFromEnvironment();
  if (remoteClient) {
    for (const tool of createTaskClientTools({ resolveClient: () => remoteClient })) {
      pi.registerTool(tool as never);
    }
    return;
  }

  const service = createTaskRuntimeFacade();
  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId() ?? "default";
    service.ensureWorkflow({
      workflowId: `session:${sessionId}`,
      ownerSessionId: sessionId,
      rootActorId: `root:${sessionId}`,
      title: "Phenix session",
    });
  });

  for (const tool of createTaskTools({
    service,
    resolveAuthority: (ctx) =>
      service.rootAuthorityForSession(ctx.sessionManager.getSessionId() ?? "default"),
  })) {
    pi.registerTool(tool as never);
  }
}
