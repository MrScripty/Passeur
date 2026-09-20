import { museDefinition } from "../muse/config.js";
import { codexDefinition } from "./codex/config.js";
import type { AdapterDefinition } from "./types.js";
export const builtinAdapters: Readonly<Record<string, AdapterDefinition>> = Object.freeze({ muse: museDefinition, codex: codexDefinition });
