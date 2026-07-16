/**
 * 轻量级 OpenTelemetry 追踪适配层
 *
 * 功能：
 * - trace ID 生成与传播（W3C TraceContext 兼容）
 * - 自动注入到 pino 日志
 * - 关键路径 span 计时（assemble/retrieval/compact/moa）
 * - 无外部依赖，运行时零开销（未启用时）
 *
 * 设计原则：
 * - 不引入 @opentelemetry/api 等重量级依赖
 * - 使用 node:crypto 生成 trace ID
 * - 与 pino 结构化日志无缝集成
 * - 符合 OpenClaw 插件沙箱约束
 */

import { randomUUID } from 'node:crypto';

// ============================================================================
// 类型定义
// ============================================================================

export interface TraceSpan {
  name: string;
  spanId: string;
  parentSpanId?: string;
  traceId: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: 'ok' | 'error';
  attributes: Record<string, string | number | boolean>;
  events: Array<{ name: string; timestamp: number; attributes?: Record<string, string | number | boolean> }>;
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

// ============================================================================
// 模块状态
// ============================================================================

let _enabled = false;
let _activeSpans = new Map<string, TraceSpan>();
let _completedSpans: TraceSpan[] = [];
const MAX_COMPLETED_SPANS = 1000;

// ============================================================================
// 配置
// ============================================================================

export function enableTracing(): void {
  _enabled = true;
}

export function disableTracing(): void {
  _enabled = false;
}

export function isTracingEnabled(): boolean {
  return _enabled;
}

// ============================================================================
// Trace ID 生成
// ============================================================================

/**
 * 生成 W3C TraceContext 兼容的 trace ID（32 字符 hex）。
 * 使用 crypto.randomUUID() + 补充随机位，确保唯一性。
 */
export function generateTraceId(): string {
  return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 16);
}

/**
 * 生成 span ID（16 字符 hex）。
 */
export function generateSpanId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

// ============================================================================
// Span 管理
// ============================================================================

/**
 * 从当前上下文中创建新的 trace context。
 * 如果未启用追踪，返回空对象（调用方跳过追踪逻辑）。
 */
export function createTraceContext(parentContext?: TraceContext): TraceContext | null {
  if (!_enabled) return null;
  return {
    traceId: parentContext?.traceId ?? generateTraceId(),
    spanId: generateSpanId(),
    parentSpanId: parentContext?.spanId,
  };
}

/**
 * 开始一个 span。返回 span 对象，调用方负责在完成时调用 endSpan。
 */
export function startSpan(
  name: string,
  parentContext?: TraceContext | null,
  attrs?: Record<string, string | number | boolean>,
): TraceSpan | null {
  if (!_enabled) return null;
  const ctx = parentContext ?? createTraceContext();
  if (!ctx) return null;
  const span: TraceSpan = {
    name,
    spanId: ctx.spanId,
    parentSpanId: ctx.parentSpanId,
    traceId: ctx.traceId,
    startTime: Date.now(),
    status: 'ok',
    attributes: attrs ?? {},
    events: [],
  };
  _activeSpans.set(span.spanId, span);
  return span;
}

/**
 * 结束一个 span。
 */
export function endSpan(span: TraceSpan | null, error?: Error): void {
  if (!span || !_enabled) return;
  span.endTime = Date.now();
  span.durationMs = span.endTime - span.startTime;
  if (error) {
    span.status = 'error';
    span.attributes['error.message'] = error.message;
    span.attributes['error.type'] = error.name;
  }
  _activeSpans.delete(span.spanId);
  _completedSpans.push(span);
  if (_completedSpans.length > MAX_COMPLETED_SPANS) {
    _completedSpans = _completedSpans.slice(-MAX_COMPLETED_SPANS / 2);
  }
}

/**
 * 向 span 添加事件。
 */
export function addSpanEvent(
  span: TraceSpan | null,
  name: string,
  attrs?: Record<string, string | number | boolean>,
): void {
  if (!span || !_enabled) return;
  span.events.push({ name, timestamp: Date.now(), attributes: attrs });
}

/**
 * 向 span 添加属性。
 */
export function setSpanAttribute(
  span: TraceSpan | null,
  key: string,
  value: string | number | boolean,
): void {
  if (!span || !_enabled) return;
  span.attributes[key] = value;
}

// ============================================================================
// 查询
// ============================================================================

/**
 * 获取所有活跃 span。
 */
export function getActiveSpans(): TraceSpan[] {
  return Array.from(_activeSpans.values());
}

/**
 * 获取最近的已完成 span。
 */
export function getRecentSpans(count: number = 20): TraceSpan[] {
  return _completedSpans.slice(-count);
}

/**
 * 获取用于注入 pino 日志的 trace context 绑定对象。
 * 返回 { traceId, spanId } 或 undefined。
 */
export function getLogBinding(span: TraceSpan | null): Record<string, string> | undefined {
  if (!span || !_enabled) return undefined;
  return { traceId: span.traceId, spanId: span.spanId };
}

/**
 * 重置所有追踪状态（测试用）。
 */
export function resetTracing(): void {
  _activeSpans = new Map();
  _completedSpans = [];
}

// ============================================================================
// 便捷包装器
// ============================================================================

/**
 * 包装异步函数，自动创建 span 并计时。
 *
 * 使用方式：
 *   const result = await withTracing('assemble', ctx, async (span) => {
 *     return await doAssemble();
 *   });
 */
export async function withTracing<T>(
  name: string,
  parentContext: TraceContext | null,
  fn: (span: TraceSpan | null) => Promise<T>,
  attrs?: Record<string, string | number | boolean>,
): Promise<T> {
  const span = startSpan(name, parentContext, attrs);
  try {
    const result = await fn(span);
    endSpan(span);
    return result;
  } catch (error) {
    endSpan(span, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}