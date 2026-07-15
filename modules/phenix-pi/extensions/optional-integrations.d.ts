import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ExtensionRegistrar = (pi: ExtensionAPI) => void | Promise<void>;

declare module "@hypabolic/pi-hypa/extensions/index.ts" {
  const register: ExtensionRegistrar;
  export default register;
}

declare module "@hypabolic/pi-hypa/extensions/rewrite-client.ts" {
  export function getExecArgs(binary: string, args: string[]): [string, string[]];
  export function resolveHypaBinary(binary: string): string;
}

declare module "@hypabolic/pi-hypa/extensions/tools.ts" {
  export function buildReadCommand(path: string, offset?: number, limit?: number): string;
}

declare module "pi-lsp/extensions/pi-lsp/index.ts" {
  const register: ExtensionRegistrar;
  export default register;
}

declare module "pi-mcp-adapter/index.ts" {
  const register: ExtensionRegistrar;
  export default register;
}

declare module "pi-context-tools/extensions/index.ts" {
  const register: ExtensionRegistrar;
  export default register;
}

declare module "@juicesharp/rpiv-web-tools/index.ts" {
  interface WebToolOptions {
    readonly interceptors?: {
      readonly github?: boolean;
    };
  }

  const register: (pi: ExtensionAPI, options?: WebToolOptions) => void | Promise<void>;
  export default register;
}
