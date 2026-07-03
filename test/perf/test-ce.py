import json
import os
import subprocess
import glob
import statistics
import re
from datetime import datetime, timezone
from collections import defaultdict

OPENCLAW_DIR = os.environ.get('OPENCLAW_DIR', os.path.expanduser('~/.openclaw'))
SESSIONS_JSON = os.environ.get('SESSIONS_JSON', os.path.join(OPENCLAW_DIR, 'agents', 'main', 'sessions', 'sessions.json'))
SESSIONS_DIR = os.environ.get('SESSIONS_DIR', os.path.join(OPENCLAW_DIR, 'agents', 'main', 'sessions'))
OUT_DIR = os.environ.get('OUT_DIR', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'test-perf'))

results = []

def add(cat, name, val, unit):
    results.append({"cat": cat, "name": name, "value": val, "unit": unit})


def calc_percentiles(data):
    """计算分位数统计"""
    if not data:
        return {}
    sorted_data = sorted(data)
    n = len(sorted_data)
    return {
        "count": n,
        "min": round(sorted_data[0], 2),
        "p25": round(sorted_data[int(n*0.25)], 2) if n > 0 else 0,
        "p50": round(sorted_data[int(n*0.5)], 2) if n > 0 else 0,
        "p75": round(sorted_data[int(n*0.75)], 2) if n > 0 else 0,
        "p95": round(sorted_data[min(int(n*0.95), n-1)], 2) if n > 0 else 0,
        "p99": round(sorted_data[min(int(n*0.99), n-1)], 2) if n > 0 else 0,
        "max": round(sorted_data[-1], 2),
        "mean": round(statistics.mean(sorted_data), 2),
    }


# ============================================================================
# lcm-graph-extra 模块级延迟解析器
# ============================================================================

def parse_before_turn_timing(line):
    """从日志行解析 [TIMING] before_turn 的结构化计时数据"""
    match = re.search(r'\[TIMING\]\s+before_turn\s+(.*)', line)
    if not match:
        return None
    
    text = match.group(1)
    timing = {}
    
    # 解析 key=value 对
    pattern = r'(total|init|rgw|qmd|graph|exp|dedup|fmt|results)=(\S+)'
    for m in re.finditer(pattern, text):
        key = m.group(1)
        val_str = m.group(2).rstrip('ms')
        try:
            timing[key] = float(val_str)
        except ValueError:
            pass
    
    return timing if 'total' in timing else None


def extract_lcm_timings_from_sessions():
    """
    从 sessions.json 的 pluginDebugEntries 中提取 lcm-graph-extra 的 timing 数据
    
    解析 [TIMING] before_turn total=Xms init=Yms rgw=Zms qmd=Ams graph=Bms exp=Cms dedup=Dms fmt=Ems
    """
    timings_list = []
    
    try:
        with open(SESSIONS_JSON) as f:
            sessions = json.load(f)
    except:
        return timings_list
    
    entries = list(sessions.values()) if isinstance(sessions, dict) else sessions
    
    for s in entries:
        pde = s.get('pluginDebugEntries')
        if not pde:
            continue
        
        for entry in pde:
            plugin_id = entry.get('pluginId', '')
            if 'lossless-claw' not in plugin_id and 'lcm-graph' not in plugin_id:
                continue
            
            lines = entry.get('lines', [])
            for line in lines:
                timing = parse_before_turn_timing(line)
                if timing:
                    timings_list.append(timing)
    
    return timings_list


def analyze_lcm_module_latency():
    """分析 lcm-graph-extra 各模块延迟分布"""
    timings_list = extract_lcm_timings_from_sessions()
    
    if not timings_list:
        print("  [WARN] No before_turn timing data found in pluginDebugEntries")
        return None
    
    print(f"  Found {len(timings_list)} before_turn timing entries")
    
    # 各模块延迟统计
    module_fields = {
        'total': 'before_turn总耗时',
        'init': '网关初始化',
        'rgw': 'RetrievalGateway(并行搜索)',
        'qmd': 'QmdClient查询(记忆文件BM25+向量)',
        'graph': 'GraphAdapter查询(Neo4j图谱)',
        'exp': 'Experience召回',
        'dedup': '全源去重合并',
        'fmt': '结果格式化',
    }
    
    module_data = {k: [] for k in module_fields}
    
    for t in timings_list:
        for field in module_fields:
            val = t.get(field)
            if val is not None and val > 0:
                module_data[field].append(val)
    
    # 输出统计
    stats = {}
    for field, name in module_fields.items():
        data = module_data[field]
        if not data:
            print(f"  {name}: 无数据")
            continue
        
        s = calc_percentiles(data)
        stats[field] = s
        
        # 写入结果 (分类 I - 延迟性能)
        add("I", f"lcm_{field}_mean", s["mean"], "ms")
        add("I", f"lcm_{field}_p50", s["p50"], "ms")
        add("I", f"lcm_{field}_p95", s["p95"], "ms")
        add("I", f"lcm_{field}_max", s["max"], "ms")
        
        pct_of_total = round(100 * s["p50"] / stats.get('total', {}).get('p50', 1), 1) if 'total' in stats and stats['total'] else 0
        print(f"  {name}: mean={s['mean']}ms, p50={s['p50']}ms({pct_of_total}%), p95={s['p95']}ms, max={s['max']}ms")
    
    return stats


def analyze_trajectory_latency():
    """从 trajectory JSONL 文件中提取框架级模块延迟"""
    trajectory_files = glob.glob(os.path.join(SESSIONS_DIR, "*.trajectory.jsonl"))
    
    module_stats = {
        "total_runtime": [],
        "context_build": [],      # session.started → context.compiled
        "prompt_submit": [],      # context.compiled → prompt.submitted
        "model_inference": [],    # prompt.submitted → model.completed
        "post_processing": [],    # model.completed → session.ended
    }
    
    for target in trajectory_files:
        try:
            timeline = []
            with open(target) as f:
                for line in f:
                    obj = json.loads(line)
                    ts = obj.get('ts')
                    etype = obj.get('type')
                    if ts and etype:
                        dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
                        timeline.append((dt, etype))
            
            if len(timeline) < 3:
                continue
            
            timeline.sort(key=lambda x: x[0])
            
            events = {}
            for dt, etype in timeline:
                if etype not in events:
                    events[etype] = dt
            
            if 'session.started' not in events or 'session.ended' not in events:
                continue
            
            total_ms = (events['session.ended'] - events['session.started']).total_seconds() * 1000
            
            if total_ms < 0 or total_ms > 10_000_000:
                continue
            
            ctx_ms = 0
            prompt_ms = 0
            model_ms = 0
            post_ms = 0
            
            if 'context.compiled' in events:
                ctx_ms = (events['context.compiled'] - events['session.started']).total_seconds() * 1000
            
            if 'prompt.submitted' in events and 'context.compiled' in events:
                prompt_ms = (events['prompt.submitted'] - events['context.compiled']).total_seconds() * 1000
            
            if 'model.completed' in events and 'prompt.submitted' in events:
                model_ms = (events['model.completed'] - events['prompt.submitted']).total_seconds() * 1000
            
            if 'model.completed' in events:
                post_ms = (events['session.ended'] - events['model.completed']).total_seconds() * 1000
            
            if ctx_ms < 0 or prompt_ms < 0 or model_ms < 0 or post_ms < 0:
                continue
            
            module_stats["total_runtime"].append(total_ms)
            module_stats["context_build"].append(ctx_ms)
            module_stats["prompt_submit"].append(prompt_ms)
            module_stats["model_inference"].append(model_ms)
            module_stats["post_processing"].append(post_ms)
            
        except Exception:
            continue
    
    modules = {
        "total_runtime": ("avg-total-runtime", "总会话运行时"),
        "context_build": ("avg-context-build", "上下文构建(含lcm-graph-extra)"),
        "prompt_submit": ("avg-prompt-assembly", "Prompt组装"),
        "model_inference": ("avg-model-inference", "模型推理"),
        "post_processing": ("avg-post-processing", "后处理"),
    }
    
    for key, (name, desc) in modules.items():
        data = module_stats[key]
        if not data:
            continue
        s = calc_percentiles(data)
        add("I", f"{name}", s["mean"], "ms")
        add("I", f"{name}_p50", s["p50"], "ms")
        add("I", f"{name}_p95", s["p95"], "ms")
        add("I", f"{name}_max", s["max"], "ms")
    
    return module_stats


def main():
    print("=== OpenClaw CE Performance Test (lcm-graph-extra 模块级) ===")
    print(f"Date: {datetime.now(timezone.utc).isoformat()}")
    
    with open(SESSIONS_JSON) as f:
        sessions = json.load(f)
    entries = list(sessions.values()) if isinstance(sessions, dict) else sessions
    
    # I. LATENCY - 框架级 + lcm-graph-extra 模块级
    print("\n--- I. Latency ---")
    print("  [Phase 1] 框架级延迟拆解...")
    frame_stats = analyze_trajectory_latency()
    
    print("  [Phase 2] lcm-graph-extra 模块级延迟拆解...")
    lcm_stats = analyze_lcm_module_latency()
    
    # II. THROUGHPUT
    print("\n--- II. Throughput ---")
    done = [s for s in entries if s.get("status") == "done"]
    aborted = [s for s in entries if s.get("abortedLastRun") == True or s.get("status") == "aborted"]
    timeout_list = [s for s in entries if s.get("status") == "timeout"]
    
    add("II", "total-sessions", len(entries), "sessions")
    add("II", "done-sessions", len(done), "sessions")
    
    token_entries = [s for s in entries if s.get("totalTokens")]
    if token_entries:
        total_input = sum(s.get("inputTokens", 0) for s in token_entries)
        total_output = sum(s.get("outputTokens", 0) for s in token_entries)
        add("II", "avg-input-tokens", round(total_input/len(token_entries)), "tokens")
        add("II", "avg-output-tokens", round(total_output/len(token_entries)), "tokens")
    
    # VI. STABILITY
    print("\n--- VI. Stability ---")
    add("VI", "success-rate", round(len(done)/len(entries)*100, 1), "%")
    
    # Generate report
    os.makedirs(OUT_DIR, exist_ok=True)
    generate_report(entries, lcm_stats)


def generate_report(entries, lcm_stats):
    lines = []
    lines.append("# OpenClaw CE × lcm-graph-extra 性能测试报告")
    lines.append("")
    lines.append(f"**测试日期:** {datetime.now(timezone.utc).isoformat()}")
    lines.append(f"**总会话数:** {len(entries)}")
    lines.append("")
    
    cats = {
        "I": "一、延迟性能 — 框架级 + lcm-graph-extra 模块级拆解",
        "II": "二、吞吐量与处理能力",
        "VI": "六、稳定性与可靠性",
    }
    
    for cat_id, cat_name in cats.items():
        items = [r for r in results if r["cat"] == cat_id]
        if not items:
            continue
        lines.append(f"## {cat_name}")
        lines.append("")
        lines.append("| 指标 | 值 | 单位 |")
        lines.append("|------|-----|------|")
        for item in items:
            v = item["value"]
            if isinstance(v, float):
                v = f"{v:.2f}"
            elif isinstance(v, int):
                v = str(v)
            lines.append(f"| {item['name']} | {v} | {item['unit']} |")
        lines.append("")
    
    # lcm-graph-extra 延迟构成分析
    if lcm_stats:
        lines.append("## lcm-graph-extra 模块延迟构成分析")
        lines.append("")
        
        total_p50 = lcm_stats.get('total', {}).get('p50', 0)
        if total_p50 and total_p50 > 0:
            lines.append("### P50 各模块占比（排除模型推理）")
            lines.append("")
            
            field_labels = {
                'init': '网关初始化',
                'rgw': 'RetrievalGateway(并行搜索)',
                'qmd': 'QmdClient(BM25+向量)',
                'graph': 'GraphAdapter(Neo4j图谱)',
                'exp': 'Experience召回',
                'dedup': '去重合并',
                'fmt': '格式化',
            }
            
            for field, label in field_labels.items():
                s = lcm_stats.get(field)
                if s and s.get('p50'):
                    pct = round(100 * s['p50'] / total_p50, 1)
                    bar_len = max(1, int(pct / 2))
                    bar = '█' * bar_len
                    lines.append(f"- **{label}:** {s['p50']}ms ({pct}%) {bar}")
            
            lines.append("")
            lines.append("> **注意:** qmd + graph 是并行执行的，rgw 取两者中较长者。")
            lines.append("> rgw ≈ max(qmd, graph)")
    
    # Summary
    ctx_p50 = next((r for r in results if r["name"] == "avg-context-build_p50"), None)
    lcm_total_p50 = next((r for r in results if r["name"] == "lcm_total_p50"), None)
    
    lines.append("## 关键发现")
    lines.append("")
    if ctx_p50:
        lines.append(f"- 上下文构建 P50: **{ctx_p50['value']}ms** ({round(ctx_p50['value']/1000, 1)}s)")
    if lcm_total_p50:
        lines.append(f"- lcm-graph-extra before_turn P50: **{lcm_total_p50['value']}ms**")
    
    # Check if lcm timing is a significant portion of context build
    if ctx_p50 and lcm_total_p50:
        ctx_val = ctx_p50['value']
        lcm_val = lcm_total_p50['value']
        if ctx_val > 0:
            ratio = round(100 * lcm_val / ctx_val, 1)
            lines.append(f"- lcm-graph-extra 占上下文构建比例: **{ratio}%**")
    
    lines.append("")
    
    report_text = "\n".join(lines)
    
    out_path = os.path.join(OUT_DIR, "CE-report.md")
    with open(out_path, "w") as f:
        f.write(report_text)
    
    print(f"\nReport written: {out_path}")
    print()
    print(report_text)


if __name__ == "__main__":
    main()
