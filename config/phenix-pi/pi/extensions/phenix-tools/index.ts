/**
 * Phenix tools — main extension entry point.
 *
 * Registers all 11 tools: read, search, find, edit, ast_grep, ast_edit,
 * lsp, todo, task, job, resolve.
 *
 * Inspired by the oh-my-pi tool design (MIT License).
 * This is a Phenix-tailored subset: smaller, safer, Nix-friendly.
 *
 * Portions derived from can1357/oh-my-pi, MIT License.
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 *
 * This tool design is inspired by can1357/oh-my-pi. oh-my-pi is MIT licensed.
 * No substantial source code is copied unless noted in file headers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setExtensionAPI } from "./_shared.js";
import { registerRead } from "./read.js";
import { registerSearch } from "./search.js";
import { registerFind } from "./find.js";
import { registerEdit } from "./edit.js";
import { registerAstGrep } from "./ast_grep.js";
import { registerAstEdit } from "./ast_edit.js";
import { registerLsp } from "./lsp.js";
import { registerTodo } from "./todo.js";
import { registerTask } from "./task.js";
import { registerJob } from "./job.js";
import { registerResolve } from "./resolve.js";

export default function phenixTools(pi: ExtensionAPI) {
  // Store pi API reference for session state persistence
  setExtensionAPI(pi);

  // Register all 11 tools
  registerRead(pi);
  registerSearch(pi);
  registerFind(pi);
  registerEdit(pi);
  registerAstGrep(pi);
  registerAstEdit(pi);
  registerLsp(pi);
  registerTodo(pi);
  registerTask(pi);
  registerJob(pi);
  registerResolve(pi);
}
