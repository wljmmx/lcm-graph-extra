/**
 * 知识节点 id 契约单测 —— 锁定与上游 graph-memory-pro 的一致性。
 *
 * 上游权威实现（v2.4.7 `src/services/extract-service.ts`）：
 *   function hashString(s) { ... FNV-1a 32bit ... return (h >>> 0).toString(16); }
 *   function deterministicNodeId(type, name) { return `gn-${hashString(type + "|" + name)}`; }
 *   调用点：`deterministicNodeId(enode.type.toUpperCase(), enode.name)`
 *
 * 本插件此前用 `${type}-${sha256(type:name)}`，与上游不同 → MERGE 永不命中 →
 * 同名实体在图中留两份。本测试锁死对齐后的算法，防止回退。
 */
import { describe, it, expect } from 'vitest';
import { fnv1a32, makeNodeId } from './graph-adapter.js';

describe('fnv1a32（上游 hashString 对齐）', () => {
  // FNV 官方规范公开测试向量（http://www.isthe.com/chongo/tech/comp/fnv/）
  // 独立于上游源码，用于锁定算法本身。
  it('匹配 FNV 规范公开测试向量', () => {
    expect(fnv1a32('')).toBe('811c9dc5');
    expect(fnv1a32('a')).toBe('e40c292c');
    expect(fnv1a32('foobar')).toBe('bf9cf968');
  });

  it('输出无符号小写十六进制（无负号、无大写）', () => {
    for (const s of ['', 'a', 'TASK|修复登录 bug', '🧠', 'x'.repeat(500)]) {
      expect(fnv1a32(s)).toMatch(/^[0-9a-f]{1,8}$/);
    }
  });

  it('无符号语义：高位为 1 时不得输出负数', () => {
    // 旧实现若漏掉 `>>> 0`，此处会得到 "-xxxx"
    expect(fnv1a32('🧠')).not.toContain('-');
  });
});

describe('makeNodeId（上游 deterministicNodeId 对齐）', () => {
  // 冻结向量：由上游公式 gn-<hash(TYPE|name)> 生成
  it('形状与取值与上游一致（gn-<fnv1a32(TYPE|name)>）', () => {
    expect(makeNodeId('Fix login bug', 'Task')).toBe('gn-38c76828');
    expect(makeNodeId('useEffect cleanup', 'Skill')).toBe('gn-ea6bdbec');
    expect(makeNodeId('OOM on 4090', 'Event')).toBe('gn-6c68418c');
    expect(makeNodeId('修复登录 bug', 'Task')).toBe('gn-83a1dc4b');
  });

  it('类型大小写不敏感（内部统一 toUpperCase，与上游同源）', () => {
    expect(makeNodeId('X', 'Task')).toBe(makeNodeId('X', 'TASK'));
    expect(makeNodeId('X', 'task')).toBe(makeNodeId('X', 'Task'));
  });

  it('不再使用旧的 `${type}-${sha256}` 方案', () => {
    const id = makeNodeId('Fix login bug', 'Task');
    expect(id.startsWith('gn-')).toBe(true);
    // 旧方案形如 task-<12位hex>，且长度与字符集不同
    expect(id).not.toMatch(/^(task|skill|event)-[0-9a-f]{1}/);
  });

  it('名字区分大小写、类型区分（同簇内不碰撞）', () => {
    const ids = new Set([
      makeNodeId('Fix login bug', 'Task'),
      makeNodeId('fix login bug', 'Task'),
      makeNodeId('Fix login bug', 'Skill'),
      makeNodeId('Fix login bug', 'Event'),
    ]);
    expect(ids.size).toBe(4);
  });
});