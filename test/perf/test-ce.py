import json
import os
import subprocess
from datetime import datetime, timezone

SESSIONS_JSON = "/home/wljmmx/.openclaw/agents/main/sessions/sessions.json"
SESSIONS_DIR = "/home/wljmmx/.openclaw/agents/main/sessions"
OUT_DIR = "/home/wljmmx/.openclaw/workspace/main/workfiles/lcm-graph-extra/test-perf"

results = []

def add(cat, name, val, unit):
    results.append({"cat": cat, "name": name, "value": val, "unit": unit})

def main():
    print("=== OpenClaw CE Performance Test ===")
    print(f"Date: {datetime.now(timezone.utc).isoformat()}")
    
    with open(SESSIONS_JSON) as f:
        sessions = json.load(f)
    entries = list(sessions.values()) if isinstance(sessions, dict) else sessions
    
    # I. LATENCY
    print("\n--- I. Latency ---")
    latencies = []
    for s in entries:
        rt = s.get("runtimeMs")
        spr = s.get("systemPromptReport")
        if rt and spr:
            latencies.append(rt)
    
    if latencies:
        rt_sorted = sorted(latencies)
        n = len(rt_sorted)
        add("I", "avg-context-build", round(sum(rt_sorted)/n, 2), "ms")
        add("I", "p50-runtime", rt_sorted[int(n*0.5)], "ms")
        add("I", "p95-runtime", rt_sorted[min(int(n*0.95), n-1)], "ms")
        add("I", "p99-runtime", rt_sorted[min(int(n*0.99), n-1)], "ms")
        add("I", "min-runtime", min(rt_sorted), "ms")
        add("I", "max-runtime", max(rt_sorted), "ms")
        print(f"Sessions with runtime data: {n}")
    
    # II. THROUGHPUT & CAPACITY
    print("\n--- II. Throughput ---")
    done = [s for s in entries if s.get("status") == "done"]
    aborted = [s for s in entries if s.get("abortedLastRun") == True or s.get("status") == "aborted"]
    timeout_list = [s for s in entries if s.get("status") == "timeout"]
    
    add("II", "total-sessions", len(entries), "sessions")
    add("II", "done-sessions", len(done), "sessions")
    add("II", "aborted", len(aborted), "sessions")
    add("II", "timeout", len(timeout_list), "sessions")
    
    token_entries = [s for s in entries if s.get("totalTokens")]
    if token_entries:
        total_input = sum(s.get("inputTokens", 0) for s in token_entries)
        total_output = sum(s.get("outputTokens", 0) for s in token_entries)
        add("II", "avg-input-tokens", round(total_input/len(token_entries)), "tokens")
        add("II", "avg-output-tokens", round(total_output/len(token_entries)), "tokens")
        
        active = [s for s in token_entries if (s.get("runtimeMs") or 0) > 0]
        if active:
            rates = []
            for s in active:
                rt = s.get("runtimeMs", 1)
                toks = s.get("totalTokens", 0)
                rates.append((toks / rt) * 1000)
            add("II", "avg-token-rate", round(sum(rates)/len(rates)), "tok/s")
        
        ctx_util = []
        for s in entries:
            ct = s.get("contextTokens")
            tt = s.get("totalTokens")
            if ct and tt:
                ctx_util.append(tt / ct * 100)
        if ctx_util:
            add("II", "max-context-utilization", round(max(ctx_util), 1), "%")
        
        add("II", "max-single-session-tokens", max(s.get("totalTokens", 0) for s in token_entries), "tokens")
    
    # III. RESOURCE USAGE
    print("\n--- III. Resources ---")
    try:
        r = subprocess.run(["du", "-sb", SESSIONS_DIR], capture_output=True, text=True, timeout=10)
        parts = r.stdout.split()
        disk_bytes = int(parts[0]) if parts else 0
        add("III", "disk-usage", round(disk_bytes/1024/1024, 1), "MB")
    except:
        pass
    
    try:
        r = subprocess.run(["find", SESSIONS_DIR, "-maxdepth", "1", "-name", "*.jsonl", "-type", "f", "|", "wc", "-l"],
                          shell=True, capture_output=True, text=True, timeout=10)
        file_count = int(r.stdout.strip()) if r.stdout.strip().isdigit() else 0
        add("III", "session-files", file_count, "files")
    except:
        pass
    
    try:
        r = subprocess.run(["ps", "aux"], capture_output=True, text=True, timeout=5)
        total_rss = 0
        for line in r.stdout.split("\n"):
            if "openclaw" in line.lower() and "node" in line.lower():
                parts = line.split()
                if len(parts) > 5:
                    try:
                        total_rss += int(parts[5])
                    except: pass
        add("III", "total-rss", round(total_rss/1024), "MB")
    except: pass
    
    # IV. CACHE EFFICIENCY
    print("\n--- IV. Cache ---")
    cr = sum(s.get("cacheRead", 0) for s in entries)
    cw = sum(s.get("cacheWrite", 0) for s in entries)
    add("IV", "cache-read-tokens", cr, "tokens")
    add("IV", "cache-write-tokens", cw, "tokens")
    if cr + cw > 0:
        add("IV", "cache-hit-rate", round(cr/(cr+cw)*100, 1), "%")
    fresh = [s for s in entries if s.get("totalTokensFresh") == True]
    add("IV", "fresh-token-pct", round(len(fresh)/len(entries)*100, 1), "%")
    
    # V. COMPRESSION & TOKEN EFFICIENCY
    print("\n--- V. Compression ---")
    comp = sum(s.get("compactionCount", 0) for s in entries)
    add("V", "total-compactions", comp, "compactions")
    
    trunc_total = 0
    for s in entries:
        bt = s.get("systemPromptReport", {}).get("bootstrapTruncation", {})
        if isinstance(bt, dict) and bt.get("truncatedFiles"):
            trunc_total += bt["truncatedFiles"]
    add("V", "bootstrap-truncations", trunc_total, "events")
    
    # VI. STABILITY & RELIABILITY
    print("\n--- VI. Stability ---")
    add("VI", "success-rate", round(len(done)/len(entries)*100, 1), "%")
    add("VI", "abort-rate", round(len(aborted)/len(entries)*100, 1), "%")
    add("VI", "timeout-rate", round(len(timeout_list)/len(entries)*100, 1), "%")
    
    if latencies:
        mean_rt = sum(latencies)/len(latencies)
        stddev = (sum((r - mean_rt)**2 for r in latencies)/len(latencies))**0.5
        add("VI", "runtime-stddev", round(stddev), "ms")
        outliers = sum(1 for r in latencies if r > mean_rt + 2*stddev)
        add("VI", "runtime-outliers", outliers, "sessions")
    
    # VII. RETRIEVAL & RECALL
    print("\n--- VII. Retrieval ---")
    with_debug = [s for s in entries if s.get("pluginDebugEntries")]
    add("VII", "sessions-with-memory-debug", len(with_debug), "sessions")
    
    # VIII. LOSSLESS-CLAW
    print("\n--- VIII. Lossless-Claw ---")
    lc_dir = "/home/wljmmx/.openclaw/workspace/main/lcm-graph-extra/data"
    if os.path.isdir(lc_dir):
        gfiles = [f for f in os.listdir(lc_dir) if f.endswith(".json")]
        add("VIII", "graph-data-files", len(gfiles), "files")
    
    # IX. CONCURRENCY
    print("\n--- IX. Concurrency ---")
    running = [s for s in entries if s.get("status") == "running"]
    add("IX", "currently-running", len(running), "sessions")
    
    channels = {}
    for s in entries:
        ch = (s.get("deliveryContext") or {}).get("channel") or s.get("lastChannel") or "unknown"
        channels[ch] = channels.get(ch, 0) + 1
    print(f"Channels: {channels}")
    
    # Generate report
    os.makedirs(OUT_DIR, exist_ok=True)
    generate_report(entries)

def generate_report(entries):
    lines = []
    lines.append("# OpenClaw CE (Context Engine) 性能测试报告")
    lines.append("")
    lines.append(f"**测试日期:** {datetime.now(timezone.utc).isoformat()}")
    lines.append(f"**总会话数:** {len(entries)}")
    lines.append("")
    
    cats = {
        "I": "一、延迟性能 (Latency)",
        "II": "二、吞吐量与处理能力",
        "III": "三、资源占用",
        "IV": "四、缓存效率",
        "V": "五、上下文压缩与Token效率",
        "VI": "六、稳定性与可靠性",
        "VII": "七、检索与召回性能",
        "VIII": "八、lossless-claw 无损上下文",
        "IX": "九、并发与调度性能"
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
    
    # Assessment
    avg_rt = next((r for r in results if r["name"] == "avg-context-build"), None)
    p95_rt = next((r for r in results if r["name"] == "p95-runtime"), None)
    s_rate = next((r for r in results if r["name"] == "success-rate"), None)
    
    lines.append("## 评估总结")
    lines.append("")
    if avg_rt:
        lines.append(f"- **平均上下文构建延迟:** {round(avg_rt['value'])}ms")
    if p95_rt:
        lines.append(f"- **P95 运行时延迟:** {round(p95_rt['value'])}ms")
    if s_rate:
        lines.append(f"- **会话成功率:** {s_rate['value']}%")
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
