/**
 * 轻量 Prometheus 文本格式解析器（OpenMetrics 子集）。
 *
 * 用于解析 graph-memory-pro /api/metrics 返回的 text/plain 指标，
 * 将：
 *   graph_memory_recall_latency_ms{phase="recall_total",quantile="0.5"} 10.5
 * 解析为：
 *   { name: 'graph_memory_recall_latency_ms', labels: { phase: 'recall_total', quantile: '0.5' }, value: 10.5 }
 */

export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface PromMetricFamily {
  name: string;
  type: string;
  help: string;
  samples: PromSample[];
}

/** 解析单个 metric 行，失败返回 null */
function parseLine(line: string): PromSample | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  // 形如 name{label="v",label2="v2"} value 或 name value
  const braceIdx = trimmed.indexOf('{');
  const spaceIdx = trimmed.indexOf(' ');
  let name: string;
  let labelsStr = '';
  let valueStr = '';

  if (braceIdx !== -1 && (spaceIdx === -1 || braceIdx < spaceIdx)) {
    name = trimmed.slice(0, braceIdx).trim();
    const closeBrace = trimmed.indexOf('}', braceIdx);
    if (closeBrace === -1) return null;
    labelsStr = trimmed.slice(braceIdx + 1, closeBrace);
    valueStr = trimmed.slice(closeBrace + 1).trim();
  } else {
    if (spaceIdx === -1) return null;
    name = trimmed.slice(0, spaceIdx).trim();
    valueStr = trimmed.slice(spaceIdx + 1).trim();
  }

  if (!name) return null;

  // 值可能带时间戳尾巴："10.5 123456789"，只取第一个 token
  const valueToken = valueStr.split(/\s+/)[0] ?? '';
  const value = Number(valueToken);
  if (Number.isNaN(value)) return null;

  const labels: Record<string, string> = {};
  if (labelsStr) {
    const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(labelsStr)) !== null) {
      labels[m[1]] = m[2];
    }
  }

  return { name, labels, value };
}

/** 解析完整 Prometheus 文本，按指标名聚合为 family 列表（保持出现顺序） */
export function parsePrometheusText(text: string): PromMetricFamily[] {
  const families = new Map<string, PromMetricFamily>();
  const order: string[] = [];
  const meta = new Map<string, { type: string; help: string }>();

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('# HELP ')) {
      const rest = line.slice('# HELP '.length).trim();
      const sp = rest.indexOf(' ');
      if (sp !== -1) {
        const name = rest.slice(0, sp);
        const help = rest.slice(sp + 1).trim();
        meta.set(name, { ...(meta.get(name) ?? { type: '', help: '' }), help });
      }
      continue;
    }
    if (line.startsWith('# TYPE ')) {
      const rest = line.slice('# TYPE '.length).trim();
      const sp = rest.indexOf(' ');
      if (sp !== -1) {
        const name = rest.slice(0, sp);
        const type = rest.slice(sp + 1).trim();
        meta.set(name, { ...(meta.get(name) ?? { type: '', help: '' }), type });
      }
      continue;
    }
    if (line.startsWith('#')) continue; // 其他注释

    const sample = parseLine(line);
    if (!sample) continue;

    let family = families.get(sample.name);
    if (!family) {
      family = { name: sample.name, type: '', help: '', samples: [] };
      families.set(sample.name, family);
      order.push(sample.name);
    }
    family.samples.push(sample);
  }

  // 回填 TYPE / HELP
  for (const name of order) {
    const f = families.get(name)!;
    const m = meta.get(name);
    if (m) {
      f.type = m.type;
      f.help = m.help;
    }
  }

  return order.map((name) => families.get(name)!);
}

/** 便捷：按指标名前缀筛选 family */
export function filterFamilies(families: PromMetricFamily[], prefix: string): PromMetricFamily[] {
  return families.filter((f) => f.name.startsWith(prefix));
}