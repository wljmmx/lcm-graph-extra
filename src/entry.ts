/**
 * lcm-graph-extra — OpenClaw ContextEngine Plugin Entry Point
 *
 * 现代 SDK 入口：使用 definePluginEntry + registerContextEngine。
 * 传递 api 引用给引擎，使其能调用运行时 LLM 能力。
 */

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { LCMMemoryEngine } from './engine';

export default definePluginEntry({
  id: 'lcm-graph-extra',
  name: 'LCM Graph Extra',
  description: 'Context engine: graph memory + semantic search + experience learning',
  kind: 'context-engine',
  register(api) {
    api.registerContextEngine('lcm-graph-extra', async (ctx) => {
      const engine = new LCMMemoryEngine(ctx);
      await engine.init(api);
      return engine;
    });
  },
});
