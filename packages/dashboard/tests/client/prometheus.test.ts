import { describe, it, expect } from 'vitest';
import { parsePrometheusText, filterFamilies } from '../../src/utils/prometheus';

describe('parsePrometheusText', () => {
  const sample = `# HELP graph_memory_recall_latency_ms Recall latency in ms
# TYPE graph_memory_recall_latency_ms summary
graph_memory_recall_latency_ms_sum{phase="recall_total"} 1234
graph_memory_recall_latency_ms_count{phase="recall_total"} 100
graph_memory_recall_latency_ms{phase="recall_total",quantile="0.5"} 8.2
graph_memory_recall_latency_ms{phase="recall_total",quantile="0.95"} 20.1
graph_memory_recall_latency_ms{phase="recall_total",quantile="0.99"} 45.7
# TYPE graph_memory_embed_cache_hit_rate gauge
graph_memory_embed_cache_hit_rate{target="ollama"} 0.89
graph_memory_embed_cache_hits_total{target="ollama"} 890
graph_memory_embed_cache_misses_total{target="ollama"} 110
# TYPE graph_memory_circuit_breaker_success_rate gauge
graph_memory_circuit_breaker_success_rate{target="llm"} 0.96
graph_memory_circuit_breaker_success_total{target="llm"} 480
graph_memory_circuit_breaker_failure_total{target="llm"} 20
`;

  it('解析所有指标族并保留顺序', () => {
    const families = parsePrometheusText(sample);
    expect(families.map((f) => f.name)).toEqual([
      'graph_memory_recall_latency_ms_sum',
      'graph_memory_recall_latency_ms_count',
      'graph_memory_recall_latency_ms',
      'graph_memory_embed_cache_hit_rate',
      'graph_memory_embed_cache_hits_total',
      'graph_memory_embed_cache_misses_total',
      'graph_memory_circuit_breaker_success_rate',
      'graph_memory_circuit_breaker_success_total',
      'graph_memory_circuit_breaker_failure_total',
    ]);
  });

  it('回填 TYPE / HELP 元信息', () => {
    const families = parsePrometheusText(sample);
    const latency = families.find((f) => f.name === 'graph_memory_recall_latency_ms')!;
    expect(latency.type).toBe('summary');
    expect(latency.help).toBe('Recall latency in ms');
  });

  it('解析带多标签的 quantile 样本', () => {
    const families = parsePrometheusText(sample);
    const latency = families.find((f) => f.name === 'graph_memory_recall_latency_ms')!;
    const p99 = latency.samples.find((s) => s.labels.quantile === '0.99')!;
    expect(p99.labels).toEqual({ phase: 'recall_total', quantile: '0.99' });
    expect(p99.value).toBeCloseTo(45.7);
  });

  it('summary 的 _sum/_count 是独立 metric 名', () => {
    const families = parsePrometheusText(sample);
    const latency = families.find((f) => f.name === 'graph_memory_recall_latency_ms')!;
    // 仅 3 个 quantile 样本属于主 metric；_sum/_count 是独立 family
    expect(latency.samples.length).toBe(3);
    expect(families.some((f) => f.name === 'graph_memory_recall_latency_ms_sum')).toBe(true);
    expect(families.some((f) => f.name === 'graph_memory_recall_latency_ms_count')).toBe(true);
  });

  it('filterFamilies 按前缀筛选', () => {
    const families = parsePrometheusText(sample);
    const embeds = filterFamilies(families, 'graph_memory_embed_cache_');
    expect(embeds.map((f) => f.name)).toEqual([
      'graph_memory_embed_cache_hit_rate',
      'graph_memory_embed_cache_hits_total',
      'graph_memory_embed_cache_misses_total',
    ]);
  });

  it('容忍尾部时间戳与空行', () => {
    const text = 'graph_memory_embed_cache_hit_rate{target="x"} 0.5 1620000000000\n\n';
    const families = parsePrometheusText(text);
    expect(families[0].samples[0].value).toBeCloseTo(0.5);
  });

  it('空输入返回空数组', () => {
    expect(parsePrometheusText('')).toEqual([]);
    expect(parsePrometheusText('# only a comment\n')).toEqual([]);
  });
});