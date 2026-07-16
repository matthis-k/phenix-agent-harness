import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ToolCallBlock = {
  readonly blocked: true;
  readonly reason: string;
};

declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionAPI {
    on(
      event: "before_tool_call",
      handler: (
        event: { readonly toolName?: string; readonly name?: string },
        ctx: ExtensionContext,
      ) => ToolCallBlock | undefined | Promise<ToolCallBlock | undefined>,
    ): void;
  }
}
