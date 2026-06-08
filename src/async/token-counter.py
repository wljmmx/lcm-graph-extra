#!/usr/bin/env python3
"""
Token 用量统计器 - Python 子进程包装
供 lcm-graph-extra 中 Node.js 通过 child_process 调用。
从 stdin 接收 JSON，从 stdout 输出 JSON。
"""
import sys
import json

TOKENIZER_PATH = "/home/wljmmx/.openclaw/workspace/main/lcm-graph-extra/src/async/tokenizer.json"

# 全局单例 tokenizer（进程内复用）
_tokenizer = None

def get_tokenizer():
    global _tokenizer
    if _tokenizer is None:
        from tokenizers import Tokenizer
        _tokenizer = Tokenizer.from_file(TOKENIZER_PATH)
    return _tokenizer

def count_tokens(text: str) -> dict:
    """使用 DeepSeek V3 BPE tokenizer 离线计算 token 数"""
    tok = get_tokenizer()
    result = tok.encode(text)
    return {
        "chars": len(text),
        "tokens": len(result.ids),
        "ids": result.ids[:5],  # 前5个 id 用于调试
    }

def estimate_non_deepseek(text: str) -> dict:
    """非 DeepSeek 模型回退估算：
    1 英文 ≈ 0.3 token, 1 中文 ≈ 0.6 token"""
    chinese = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    english = len(text) - chinese
    tokens = int(chinese * 0.6 + english * 0.3) + 1
    return {
        "chars": len(text),
        "tokens": tokens,
        "method": "estimate"
    }

def handle_request(req: dict):
    action = req.get("action", "count")
    
    if action == "ping":
        print(json.dumps({"ok": True, "version": 1}))
        return
    
    if action == "count":
        text = req.get("text", "")
        model = req.get("model", "").lower()
        
        # DeepSeek 模型使用精确 tokenizer
        if "deepseek" in model:
            result = count_tokens(text)
        else:
            result = estimate_non_deepseek(text)
        
        result["model"] = model
        print(json.dumps(result))
        return
    
    if action == "count_batch":
        items = req.get("items", [])
        results = []
        for item in items:
            text = item.get("text", "")
            model = item.get("model", "").lower()
            if "deepseek" in model:
                results.append(count_tokens(text))
            else:
                results.append(estimate_non_deepseek(text))
        print(json.dumps({"results": results, "count": len(results)}))
        return
    
    print(json.dumps({"error": f"Unknown action: {action}"}))


if __name__ == "__main__":
    # 预热 tokenizer（第一次调用会加载模型）
    try:
        get_tokenizer()
    except Exception as e:
        pass
    
    # 行协议：每行一个 JSON 请求，每行一个 JSON 响应
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            handle_request(req)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid JSON: {e}"}))
        except Exception as e:
            print(json.dumps({"error": f"Processing error: {e}"}))
        sys.stdout.flush()
