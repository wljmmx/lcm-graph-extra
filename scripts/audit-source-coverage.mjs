#!/usr/bin/env node
/**
 * 只读覆盖度审计：官方转录 vs lcm.db，谁有哪些会话。
 *
 * 背景（为什么要跑这个）：
 *   lcmg_import 的消息来源是**互斥选择** —— 官方 per-agent SQLite 只要读到消息就
 *   直接 return（tools.ts:`loadMessageSourceSessions`），lcm.db 分支根本不会执行。
 *   因此"官方有数据但迁移不完整"时，只存在于 lcm.db 的会话**永远不会进图**。
 *   本脚本量化这个差集，判断是否真的发生了漏迁。
 *
 * 安全边界（严格遵守）：
 *   - 仅 SELECT，无任何写操作、无 DDL；
 *   - 两个库都以 readOnly 打开（SQLite 只读句柄），不碰 Neo4j；
 *   - 不修改也不重建任何文件（若 WAL 需要恢复而只读打不开，会明确报错并退出，不降级为写模式）。
 *
 * 用法：
 *   node scripts/audit-source-coverage.mjs
 *   OPENCLAW_AGENTS_DIR=/path/to/agents node scripts/audit-source-coverage.mjs
 *   LCM_DB=/path/to/lcm.db node scripts/audit-source-coverage.mjs
 *
 * 库位置（与插件实现一致）：
 *   官方：$OPENCLAW_AGENTS_DIR 或 ~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite
 *   lcm：$LCM_DB 或 ~/.openclaw/lcm.db
 */

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const agentsDir = process.env.OPENCLAW_AGENTS_DIR?.trim()
  ? resolve(process.env.OPENCLAW_AGENTS_DIR)
  : resolve(homedir(), '.openclaw', 'agents');
const lcmDbPath = process.env.LCM_DB?.trim()
  ? resolve(process.env.LCM_DB)
  : resolve(homedir(), '.openclaw', 'lcm.db');

/** 只读打开；失败时返回 null + 原因（绝不解锁为可写） */
function openReadOnly(path) {
  if (!existsSync(path)) return { db: null, reason: 'file not found' };
  try {
    return { db: new DatabaseSync(path, { readOnly: true }), reason: null };
  } catch (e) {
    return { db: null, reason: `${e.message}（只读打开失败；不降级为可写模式，请手动检查 WAL/-shm）` };
  }
}

const hasTable = (db, name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);

/** 官方：有消息 entry 的会话（session_windows JOIN transcript_events） */
function officialSessions(db) {
  if (!hasTable(db, 'session_windows') || !hasTable(db, 'transcript_events')) {
    return { keys: new Set(), windowKeys: new Set(), note: 'session_windows / transcript_events 缺失' };
  }
  const rows = db.prepare(`
    SELECT w.session_key AS session_key, w.session_id AS session_id, COUNT(e.seq) AS n
    FROM session_windows w
    LEFT JOIN transcript_events e ON e.session_id = w.session_id
    GROUP BY w.session_id
  `).all();
  const keys = new Set();
  const windowKeys = new Set();
  let msgs = 0;
  for (const r of rows) {
    const k = String(r.session_key ?? '') || String(r.session_id ?? '');
    if (k) windowKeys.add(k);
    const n = Number(r.n ?? 0);
    msgs += n;
    if (n > 0 && k) keys.add(k);
  }
  return { keys, windowKeys, msgs, note: null };
}

/** lcm.db：有消息的会话（与插件 loader 完全同口径） */
function lcmSessions(db) {
  const rows = db.prepare(
    'SELECT conversation_id, session_id, session_key FROM conversations ' +
    'WHERE conversation_id IN (SELECT DISTINCT conversation_id FROM messages)',
  ).all();
  const keys = new Set();
  let msgs = 0;
  for (const r of rows) {
    const k = String(r.session_key ?? '') || String(r.session_id ?? '');
    if (k) keys.add(k);
    const c = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?').get(r.conversation_id);
    msgs += Number(c?.c ?? 0);
  }
  return { keys, msgs };
}

const sample = (set, n = 5) => [...set].slice(0, n).map((s) => `    - ${s}`).join('\n') || '    （空）';

function main() {
  console.log('=== 来源覆盖度审计（只读）===');
  console.log(`官方 agents 目录: ${agentsDir}`);
  console.log(`lcm.db          : ${lcmDbPath}`);
  console.log('');

  // ---- 官方侧 ----
  const agentDbs = [];
  if (existsSync(agentsDir)) {
    for (const agentId of readdirSync(agentsDir)) {
      const p = join(agentsDir, agentId, 'agent', 'openclaw-agent.sqlite');
      if (existsSync(p)) agentDbs.push({ agentId, path: p });
    }
  }
  let official = { keys: new Set(), windowKeys: new Set(), msgs: 0, note: '无 agent 库（官方存储不存在或未迁移）' };
  if (agentDbs.length > 0) {
    official = { keys: new Set(), windowKeys: new Set(), msgs: 0, note: null };
    for (const a of agentDbs) {
      const { db, reason } = openReadOnly(a.path);
      if (!db) { console.log(`  ⚠ ${a.agentId}: 跳过（${reason}）`); continue; }
      try {
        const r = officialSessions(db);
        for (const k of r.keys) official.keys.add(k);
        for (const k of r.windowKeys) official.windowKeys.add(k);
        official.msgs += r.msgs ?? 0;
        console.log(`  官方 ${a.agentId}: 会话 ${r.keys.size}（窗口 ${r.windowKeys.size}），消息行 ${r.msgs ?? 0}${r.note ? ` — ${r.note}` : ''}`);
      } finally { try { db.close(); } catch {} }
    }
  } else {
    console.log(`  官方：${official.note}`);
  }

  // ---- lcm.db 侧 ----
  let lcm = { keys: new Set(), msgs: 0, note: null };
  const lcmOpen = openReadOnly(lcmDbPath);
  if (!lcmOpen.db) {
    lcm.note = lcmOpen.reason;
    console.log(`  lcm.db: 无法读取 — ${lcm.note}`);
  } else {
    try {
      if (!hasTable(lcmOpen.db, 'conversations') || !hasTable(lcmOpen.db, 'messages')) {
        lcm.note = 'conversations / messages 表缺失';
        console.log(`  lcm.db: ${lcm.note}`);
      } else {
        lcm = { ...lcmSessions(lcmOpen.db), note: null };
        console.log(`  lcm.db: 有消息的会话 ${lcm.keys.size}，消息行 ${lcm.msgs}`);
      }
    } finally { try { lcmOpen.db.close(); } catch {} }
  }

  // ---- 差集 ----
  const onlyOfficial = [...official.keys].filter((k) => !lcm.keys.has(k));
  const onlyLcm = [...lcm.keys].filter((k) => !official.keys.has(k));
  const both = [...official.keys].filter((k) => lcm.keys.has(k));

  console.log('');
  console.log('=== 差集结果 ===');
  console.log(`两侧都有            : ${both.length}`);
  console.log(`仅官方有            : ${onlyOfficial.length}`);
  console.log(`仅 lcm.db 有        : ${onlyLcm.length}   ← 这些会话当前实现下不会进图`);
  console.log('');
  console.log('仅 lcm.db 有的会话（前 5 个）:');
  console.log(sample(new Set(onlyLcm)));
  console.log('');
  console.log('仅官方有的会话（前 5 个）:');
  console.log(sample(new Set(onlyOfficial)));

  console.log('');
  if (onlyLcm.length > 0 && official.keys.size > 0) {
    console.log('判定：官方非空 + lcm.db 存在其未覆盖的会话 → 命中"互斥早退"漏数据路径。');
    console.log('      这些会话的消息不会进 Neo4j（除非另有写入者，本脚本不检查 Neo4j）。');
  } else if (official.keys.size === 0) {
    console.log('判定：官方侧为空 → 当前实现会走 lcm.db 回退，无漏迁。');
  } else {
    console.log('判定：官方已覆盖 lcm.db 全部会话 → 无漏迁。');
  }
  console.log('提示：本审计是会话级（不含消息级去重口径），仅用于判断"是否有整段会话被跳过"。');
}

main();