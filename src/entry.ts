/**
 * Plugin entry point for lcm-graph-extra (register.ts architecture).
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  info,
  bootstrap,
  assemble,
  afterTurn,
  maintain,
  compact,
} from "./register.js";

export default definePluginEntry(
  "lcm-graph-extra",
  () => ({
    info,
    bootstrap,
    assemble,
    afterTurn: afterTurn as any,
    maintain,
    compact: compact as any,
    dispose: () => {},
  }),
);
