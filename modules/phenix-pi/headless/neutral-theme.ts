import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type { HeadlessThemeAccess } from "./extension-ui.ts";

type ExtensionTheme = ExtensionUIContext["theme"];

export function createNeutralThemeAccess(): HeadlessThemeAccess {
  let current = createNeutralTheme();
  return {
    get current() {
      return current;
    },
    list: () => [{ name: "headless", path: undefined }],
    get: (name) => (name === "headless" ? current : undefined),
    set: (theme) => {
      if (typeof theme === "string") {
        return theme === "headless"
          ? { success: true }
          : { success: false, error: `Theme is rendered by the Rust frontend: ${theme}` };
      }
      current = theme;
      return { success: true };
    },
  };
}

function createNeutralTheme(): ExtensionTheme {
  const identity = (...args: readonly unknown[]): string => {
    for (let index = args.length - 1; index >= 0; index -= 1) {
      const value = args[index];
      if (typeof value === "string") return value;
    }
    return "";
  };

  let proxy: unknown;
  proxy = new Proxy(identity, {
    apply: (_target, _thisArgument, argumentsList) => identity(...argumentsList),
    get: (_target, property) => {
      if (property === "name") return "headless";
      if (property === "toJSON") return () => ({ name: "headless" });
      if (property === Symbol.toStringTag) return "HeadlessTheme";
      return proxy;
    },
  });
  return proxy as ExtensionTheme;
}
