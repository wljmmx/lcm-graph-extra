/**
 * lcm-graph-extra — Plugin Entry Point (v0.2.0)
 *
 * OpenClaw ContextEngine: coordinates lossless-claw + qmd + graph-memory-pro.
 *
 * Active CE implementation: src/entry.ts → engine.ts → LosslessClawAdapter
 * (via CE registry's getContextEngineFactory)
 */

export { default } from './src/entry.js';
