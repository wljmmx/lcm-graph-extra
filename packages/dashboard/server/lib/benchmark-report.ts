/**
 * Benchmark 报告生成器。
 *
 * 支持：
 * - JSON 导出：完整 BenchmarkResult 结构，便于离线分析和版本对比
 * - Markdown 导出：含表格和 ASCII 柱状图，便于贴到 PR/Issue
 */
import type { BenchmarkResult, BenchmarkSummary, BenchmarkItemResult } from './benchmark.js';

// ---------------------------------------------------------------------------
// JSON 导出
// ---------------------------------------------------------------------------

/** 生成 JSON 报告（返回字符串） */
export function exportJsonReport(result: BenchmarkResult): string {
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Markdown 导出
// ---------------------------------------------------------------------------

/** 生成 Markdown 报告 */
export function exportMarkdownReport(result: BenchmarkResult): string {
  const lines: string[] = [];
  const s = result.summary;

  // 标题
  lines.push(`# Benchmark 报告`);
  lines.push('');
  lines.push(`**运行 ID:** \`${result.runId}\``);
  lines.push(`**开始时间:** ${result.startedAt}`);
  lines.push(`**结束时间:** ${result.endedAt}`);
  lines.push(`**总耗时:** ${s.totalDurationMs}ms (${(s.totalDurationMs / 1000).toFixed(2)}s)`);
  lines.push('');

  // 配置
  lines.push(`## 配置`);
  lines.push('');
  lines.push(`| 参数 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| QMD Base URL | \`${result.options.qmdBaseUrl}\` |`);
  lines.push(`| 查询模式 | ${result.options.mode} |`);
  lines.push(`| limit | ${result.options.limit} |`);
  lines.push(`| 超时 | ${result.options.timeoutMs}ms |`);
  lines.push(`| rerank | ${result.options.rerank} |`);
  lines.push(`| 并发数 | ${result.options.concurrency} |`);
  lines.push(`| 测试集来源 | ${result.options.fixturesSource} |`);
  lines.push(`| 测试集数量 | ${result.options.fixturesCount} |`);
  lines.push('');

  // 概览
  lines.push(`## 概览`);
  lines.push('');
  lines.push(`| 指标 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 总用例数 | ${s.totalFixtures} |`);
  lines.push(`| 成功数 | ${s.successCount} |`);
  lines.push(`| 成功率 | ${(s.successRate * 100).toFixed(1)}% |`);
  lines.push(`| 平均结果数 | ${s.avgResultCount.toFixed(2)} |`);
  lines.push('');

  // 延迟分布
  lines.push(`## 延迟分布`);
  lines.push('');
  lines.push(`| 百分位 | 延迟 (ms) |`);
  lines.push(`|---------|----------|`);
  lines.push(`| min | ${s.latency.min} |`);
  lines.push(`| P50 | ${s.latency.p50} |`);
  lines.push(`| P90 | ${s.latency.p90} |`);
  lines.push(`| P95 | ${s.latency.p95} |`);
  lines.push(`| P99 | ${s.latency.p99} |`);
  lines.push(`| max | ${s.latency.max} |`);
  lines.push(`| avg | ${s.latency.avg.toFixed(1)} |`);
  lines.push(`| std | ${s.latency.std.toFixed(1)} |`);
  lines.push('');

  // ASCII 柱状图（P50/P90/P95/P99 相对长度）
  const maxLatency = Math.max(s.latency.p99, s.latency.max, 1);
  const barLen = (ms: number) => Math.round((ms / maxLatency) * 40);
  lines.push('```');
  lines.push('延迟分布柱状图（相对长度，max=P99 或 max）：');
  lines.push(`P50  [${'█'.repeat(barLen(s.latency.p50))}${'░'.repeat(40 - barLen(s.latency.p50))}] ${s.latency.p50}ms`);
  lines.push(`P90  [${'█'.repeat(barLen(s.latency.p90))}${'░'.repeat(40 - barLen(s.latency.p90))}] ${s.latency.p90}ms`);
  lines.push(`P95  [${'█'.repeat(barLen(s.latency.p95))}${'░'.repeat(40 - barLen(s.latency.p95))}] ${s.latency.p95}ms`);
  lines.push(`P99  [${'█'.repeat(barLen(s.latency.p99))}${'░'.repeat(40 - barLen(s.latency.p99))}] ${s.latency.p99}ms`);
  lines.push('```');
  lines.push('');

  // Tokens 消耗
  lines.push(`## Tokens 消耗`);
  lines.push('');
  lines.push(`| 类型 | Tokens |`);
  lines.push(`|------|--------|`);
  lines.push(`| 输入 | ${s.estimatedTokens.input} |`);
  lines.push(`| 输出 | ${s.estimatedTokens.output} |`);
  lines.push(`| 总计 | ${s.estimatedTokens.total} |`);
  lines.push(`| 平均每条 | ${(s.estimatedTokens.total / Math.max(1, s.successCount)).toFixed(1)} |`);
  lines.push('');

  // 压缩率
  lines.push(`## 压缩率`);
  lines.push('');
  lines.push(`- 返回 snippets 总字符数: ${Math.round(s.compressionRatio * 4000 * s.successCount * result.options.limit)}`);
  lines.push(`- 假设全文档总字符数: ${s.successCount * result.options.limit * 4000}`);
  lines.push(`- **压缩率: ${(s.compressionRatio * 100).toFixed(1)}%**（越低表示裁剪越多，节省的 tokens 越多）`);
  lines.push('');

  // 召回率
  if (s.recall) {
    lines.push(`## 召回率评估`);
    lines.push('');
    lines.push(`> 仅有 \`expectedDocIds\` 标注的 ${s.recall.evaluated} 条用例参与评估。`);
    lines.push('');
    lines.push(`| 指标 | 值 |`);
    lines.push(`|------|-----|`);
    lines.push(`| 平均召回率 (Recall) | ${(s.recall.avgRecall * 100).toFixed(1)}% |`);
    lines.push(`| 平均精确率 (Precision) | ${(s.recall.avgPrecision * 100).toFixed(1)}% |`);
    lines.push(`| 平均 F1 | ${(s.recall.avgF1 * 100).toFixed(1)}% |`);
    lines.push('');
  } else {
    lines.push(`## 召回率评估`);
    lines.push('');
    lines.push('> 无 `expectedDocIds` 标注的用例，跳过召回率评估。');
    lines.push('');
  }

  // 按分类统计
  lines.push(`## 按分类统计`);
  lines.push('');
  lines.push(`| 分类 | 总数 | 成功 | 成功率 | 平均延迟 (ms) | 平均结果数 | 平均召回率 |`);
  lines.push(`|------|------|------|--------|-------------|----------|----------|`);
  for (const cat of s.byCategory) {
    lines.push(
      `| ${cat.category} | ${cat.total} | ${cat.success} | ${(cat.successRate * 100).toFixed(0)}% | ${cat.avgLatencyMs.toFixed(0)} | ${cat.avgResultCount.toFixed(1)} | ${cat.avgRecall !== null ? (cat.avgRecall * 100).toFixed(0) + '%' : 'N/A'} |`,
    );
  }
  lines.push('');

  // 逐条详情
  lines.push(`## 逐条详情`);
  lines.push('');
  lines.push(`| ID | 分类 | 查询 | 成功 | 延迟 (ms) | 结果数 | 召回率 |`);
  lines.push(`|----|------|------|------|----------|--------|--------|`);
  for (const item of result.items) {
    const queryShort = item.query.length > 40 ? item.query.slice(0, 40) + '...' : item.query;
    const recall = item.recall !== null ? (item.recall * 100).toFixed(0) + '%' : 'N/A';
    const success = item.success ? '✓' : '✗';
    lines.push(
      `| ${item.fixtureId} | ${item.category} | ${queryShort} | ${success} | ${item.latencyMs} | ${item.resultCount} | ${recall} |`,
    );
  }
  lines.push('');

  // 失败用例
  const failed = result.items.filter((i) => !i.success);
  if (failed.length > 0) {
    lines.push(`## 失败用例`);
    lines.push('');
    for (const f of failed) {
      lines.push(`### ${f.fixtureId} (${f.category})`);
      lines.push(`- **查询:** ${f.query}`);
      lines.push(`- **错误:** ${f.error ?? 'unknown'}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 持久化（内存存储，进程重启后清空；后续可扩展为 SQLite）
// ---------------------------------------------------------------------------

const MAX_HISTORY = 20;
const history: BenchmarkResult[] = [];

/** 保存 benchmark 结果到内存历史 */
export function saveBenchmarkResult(result: BenchmarkResult): void {
  history.unshift(result);
  if (history.length > MAX_HISTORY) {
    history.length = MAX_HISTORY;
  }
}

/** 获取历史列表（不含 items 详情，只含 summary） */
export function getBenchmarkHistory(): Array<{ runId: string; startedAt: string; endedAt: string; summary: BenchmarkSummary; options: BenchmarkResult['options'] }> {
  return history.map((r) => ({
    runId: r.runId,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    summary: r.summary,
    options: r.options,
  }));
}

/** 根据 runId 获取完整结果 */
export function getBenchmarkResult(runId: string): BenchmarkResult | null {
  return history.find((r) => r.runId === runId) ?? null;
}
