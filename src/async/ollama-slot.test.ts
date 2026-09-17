/**
 * OllamaSlotPool 并发调度单元测试。
 *
 * 覆盖方向 2（模型粒度互斥）：
 * - 不同模型严格串行（绝对避免显存互踢 → 中断/重载）
 * - 同一模型可并行但不超过并发上限
 * - 并发已满时同模型排队
 * - 远程（非 Ollama）端点不排队，直连
 */
import { describe, it, expect } from 'vitest';
import { OllamaSlotPool } from './ollama-slot.js';

const OLLAMA_URL = 'http://127.0.0.1:11434';
const REMOTE_URL = 'https://api.openai.com/v1';

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

/** 简化：直接用最外层 withSlot 语义（Ollama 端点）构造池 */
function makePool(maxConcurrency: number): OllamaSlotPool {
  process.env.OLLAMA_MAX_CONCURRENCY = String(maxConcurrency);
  return new OllamaSlotPool();
}

describe('OllamaSlotPool 模型粒度互斥（方向 2）', () => {
    it('不同模型严格串行：B 必须等 A 结束才开始', async () => {
      const pool = makePool(2);
      const events: string[] = [];
      let releaseA!: () => void;
      const gateA = new Promise<void>((r) => { releaseA = r; });

      const taskA = pool.withSlot(OLLAMA_URL, 'model-A', async () => {
        events.push('A-start');
        await gateA;
        events.push('A-end');
        return 'A';
      });
      await tick();
      expect(events).toContain('A-start');

      let bStarted = false;
      const taskB = pool.withSlot(OLLAMA_URL, 'model-B', async () => {
        bStarted = true;
        events.push('B-start');
        return 'B';
      });
      await tick();
      // A（另一模型）仍在跑 → B 不得并发
      expect(bStarted).toBe(false);

      releaseA!();
      const [, b] = await Promise.all([taskA, taskB]);
      expect(bStarted).toBe(true);
      expect(events.indexOf('A-end')).toBeLessThan(events.indexOf('B-start'));
    });

    it('同一模型可并行，但不超过并发上限', async () => {
      const pool = makePool(2);
      const running = new Set<string>();
      let maxRunning = 0;
      const gates: Array<() => void> = [];

      const mkTask = (id: string) => {
        let release!: () => void;
        const g = new Promise<void>((r) => { release = r; });
        gates.push(release);
        return pool.withSlot(OLLAMA_URL, 'same-model', async () => {
          running.add(id);
          maxRunning = Math.max(maxRunning, running.size);
          await g;
          running.delete(id);
          return id;
        });
      };

      const t1 = mkTask('t1');
      const t2 = mkTask('t2');
      const t3 = mkTask('t3'); // 并发已满(2) → 排队
      await tick();

      expect(running.size).toBe(2); // t1,t2 并行（同模型，容量 2）
      expect(running.has('t3')).toBe(false); // t3 排队

      // 逐个放行，最终全部完成
      gates.forEach((g) => g());
      await Promise.all([t1, t2, t3]);
      expect(running.size).toBe(0);
      expect(maxRunning).toBeLessThanOrEqual(2);
    });

    it('当前模型有容量时，同模型等待者被唤起', async () => {
      const pool = makePool(1); // 同模型容量 1 → 完全串行
      const order: string[] = [];
      let release1!: () => void;
      const gate1 = new Promise<void>((r) => { release1 = r; });

      const t1 = pool.withSlot(OLLAMA_URL, 'm', async () => {
        order.push('1');
        await gate1;
        return '1';
      });
      const t2 = pool.withSlot(OLLAMA_URL, 'm', async () => {
        order.push('2');
        return '2';
      });
      await tick();
      expect(order).toEqual(['1']);
      release1!();
      const r = await Promise.all([t1, t2]);
      expect(order).toEqual(['1', '2']);
    });

    it('远程（非 Ollama）端点不排队，直连执行', async () => {
      const pool = makePool(1);
      let remoteRan = false;
      // 先占满本地 Ollama slot，验证远程调用不被阻塞
      let releaseLocal!: () => void;
      const gateLocal = new Promise<void>((r) => { releaseLocal = r; });
      const localTask = pool.withSlot(OLLAMA_URL, 'local-model', async () => {
        await gateLocal;
        return 'local';
      });
      await tick();
      const remoteTask = pool.withSlot(REMOTE_URL, 'remote-model', async () => {
        remoteRan = true;
        return 'remote';
      });
      await tick();
      expect(remoteRan).toBe(true); // 远程不被本地队列阻塞
      releaseLocal!();
      await Promise.all([localTask, remoteTask]);
    });
  });