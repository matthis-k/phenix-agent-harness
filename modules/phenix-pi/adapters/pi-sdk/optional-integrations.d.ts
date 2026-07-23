import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ExtensionRegistrar = (pi: ExtensionAPI) => void | Promise<void>;

declare module "@hypabolic/pi-hypa/extensions/index.ts" {
  const register: ExtensionRegistrar;
  export default register;
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
  const register: ExtensionRegistrar;
  export default register;
}
