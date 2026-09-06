/**
 * 工具结果异步压缩器
 *
 * 设计理念（受 SkillWeaver "Compressed Tool Observations" 启发）：
 *   - 当前轮：assemble 不碰工具结果，LLM 看到完整结果（即时推理不损失）
 *   - afterTurn：异步扫描本轮新增的 tool_result，生成确定性压缩版
 *   - 下一轮 assemble：检测到压缩版存在 → 用压缩版替换原文注入上下文
 *   - 原文始终保留在转录层（lossless-claw 存储），不丢数据
 *
 * 与 stubLargeToolPayloads 的区别：
 *   - stubLargeToolPayloads：同步、当前轮即替换、用于超大结果（>4KB）的外部化
 *   - 本模块：异步、下一轮生效、用于中等结果（512B~4KB）的渐进压缩
 *   - 两者互补：stub 处理超大，本模块处理中等，fresh tail 保护最近轮
 *
 * @module after-turn/tool-result-compressor
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 压缩后的工具结果条目 */
interface CompressedToolResult {
  /** 压缩后的文本内容 */
  compressed: string;
  /** 原始字节数 */
  originalBytes: number;
  /** 压缩后字节数 */
  compressedBytes: number;
  /** 压缩轮次（用于 LRU 淘汰） */
  compressedAtTurn: number;
  /** 工具名 */
  toolName: string;
}

/** 会话级压缩缓存：messageIndex → 压缩条目 */
type SessionCompressedMap = Map<number, CompressedToolResult>;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 触发压缩的最小字节数（低于此值不值得压缩）。v2.9.0: 512→256，
 * 扩大覆盖面 —— 常见检索结果/工具 JSON 输出集中在 256B~4KB 区间。 */
const COMPRESSION_THRESHOLD_BYTES = 256;

/** 压缩后保留的最大字符数（v2.9.0: 600→800，降低过度截断损失） */
const MAX_COMPRESSED_CHARS = 800;

/** 压缩后保留的最大行数 */
const MAX_COMPRESSED_LINES = 15;

/** 压缩有效的最低要求：压缩后 ≤ 原文的该比例（v2.9.0: 0.70→0.85，
 * 摘要格式开销约 200 字符，小结果在 70% 下常被判"不划算"而跳过，
 * 放宽后中等结果可真实进入压缩路径） */
const COMPRESS_RATIO_THRESHOLD = 0.85;

/** 压缩结果前缀标记（用于 assemble 检测） */
const COMPRESSION_MARKER = '[LCM Compressed Tool Result]';

/** 原文保留标记（LLM 可通过 lcm_describe 取回） */
const RETRIEVE_HINT = '[Use lcm_describe to retrieve full content if needed]';

// ---------------------------------------------------------------------------
// 会话级缓存（LRU，与 overhead-cache 对齐的容量/TTL）
// ---------------------------------------------------------------------------

const MAX_SESSIONS = 500;
const TTL_MS = 30 * 60 * 1000; // 30 min

const _sessionCompressedCache = new Map<string, {
  map: SessionCompressedMap;
  lastAccess: number;
}>();

function evictStale(): void {
  const now = Date.now();
  for (const [key, entry] of _sessionCompressedCache) {
    if ((now - entry.lastAccess) > TTL_MS) {
      _sessionCompressedCache.delete(key);
    } else {
      break;
    }
  }
  while (_sessionCompressedCache.size > MAX_SESSIONS) {
    const firstKey = _sessionCompressedCache.keys().next().value;
    if (firstKey === undefined) break;
    _sessionCompressedCache.delete(firstKey);
  }
}

function touchSession(sessionKey: string): void {
  const entry = _sessionCompressedCache.get(sessionKey);
  if (entry) {
    _sessionCompressedCache.delete(sessionKey);
    _sessionCompressedCache.set(sessionKey, entry);
  }
}

function getSessionMap(sessionKey: string): SessionCompressedMap {
  let entry = _sessionCompressedCache.get(sessionKey);
  if (!entry) {
    evictStale();
    entry = { map: new Map(), lastAccess: Date.now() };
    _sessionCompressedCache.set(sessionKey, entry);
  }
  entry.lastAccess = Date.now();
  touchSession(sessionKey);
  return entry.map;
}

// ---------------------------------------------------------------------------
// 工具名提取（对齐 tool-payload-stub 的 extractToolName）
// ---------------------------------------------------------------------------

function extractToolName(msg: any): string {
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (typeof block?.name === 'string' && block.name.trim()) {
        return block.name.trim();
      }
    }
  }
  const topLevel = msg.toolName ?? msg.tool_name ?? '';
  if (typeof topLevel === 'string' && topLevel.trim()) {
    return topLevel.trim();
  }
  return 'tool-result';
}

// ---------------------------------------------------------------------------
// 确定性压缩（非 LLM，复用 tool-payload-stub 的探索摘要思路）
// ---------------------------------------------------------------------------

/**
 * 生成确定性压缩版工具结果。
 *
 * 策略：
 *   - JSON：提取结构摘要（类型 + key 列表 + 数组长度）
 *   - 代码：提取 imports + 函数签名 + 行数
 *   - 文本：头部预览 + 总行数
 *   - 已有 stub 标记的（file_xxx）：跳过（已外部化）
 */
function compressToolResult(content: string, toolName: string): string {
  const trimmed = content.trim();

  // 已外部化的存根不压缩
  if (trimmed.includes('[LCM Tool Output:') || trimmed.includes(COMPRESSION_MARKER)) {
    return trimmed; // 已是压缩/存根形式
  }

  const lines: string[] = [`${COMPRESSION_MARKER} (${toolName})`];

  // JSON 检测
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    lines.push(compressJson(trimmed));
  } else if (isLikelyCode(trimmed)) {
    lines.push(compressCode(trimmed));
  } else {
    lines.push(compressText(trimmed));
  }

  lines.push(RETRIEVE_HINT);

  // 限制总长度
  const result = lines.join('\n');
  if (result.length > MAX_COMPRESSED_CHARS * 1.5) {
    return result.slice(0, MAX_COMPRESSED_CHARS) + '\n…\n' + RETRIEVE_HINT;
  }
  return result;
}

function compressJson(content: string): string {
  const lines: string[] = [];
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      lines.push(`Type: array (${parsed.length} items)`);
      if (parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null) {
        const keys = Object.keys(parsed[0]).slice(0, 8);
        lines.push(`Item keys: ${keys.join(', ')}${Object.keys(parsed[0]).length > 8 ? ', …' : ''}`);
      }
      // 首项预览
      const preview = JSON.stringify(parsed[0]).slice(0, 200);
      lines.push(`First item: ${preview}`);
    } else if (typeof parsed === 'object' && parsed !== null) {
      const keys = Object.keys(parsed).slice(0, 10);
      lines.push(`Type: object (${Object.keys(parsed).length} keys)`);
      lines.push(`Keys: ${keys.join(', ')}${Object.keys(parsed).length > 10 ? ', …' : ''}`);
    } else {
      lines.push(`Type: ${typeof parsed}, value: ${String(parsed).slice(0, 200)}`);
    }
  } catch {
    lines.push(`Raw (${content.length} chars), preview: ${content.slice(0, 200)}`);
  }
  return lines.join('\n');
}

function compressCode(content: string): string {
  const codeLines = content.split('\n');
  const sigs: string[] = [];
  let importCount = 0;

  for (const line of codeLines) {
    const t = line.trim();
    if (/^(import|from|require|use|package)\b/.test(t)) importCount++;
    if (sigs.length < 5 && /\b(function|def|class|interface|type|fn|const|let|var)\b/.test(t)) {
      sigs.push(t.slice(0, 100));
    }
  }

  const parts: string[] = [`Code (${codeLines.length} lines, ${importCount} imports)`];
  if (sigs.length > 0) {
    parts.push(`Key definitions:\n${sigs.join('\n')}`);
  }
  return parts.join('\n');
}

function compressText(content: string): string {
  const textLines = content.split('\n');
  const preview = textLines.slice(0, 5).map(l => l.slice(0, 120)).join('\n');
  return `Text (${textLines.length} lines):\n${preview}`;
}

function isLikelyCode(content: string): boolean {
  const lines = content.split('\n').slice(0, 15);
  let indicators = 0;
  for (const line of lines) {
    const t = line.trim();
    if (/^(import|export|function|class|def|const|let|var|if|for|while|return|pub|use|package|require)\b/.test(t)) {
      indicators++;
    }
    if (/[{}\[\]();]/.test(t) && t.length > 5) indicators++;
  }
  return indicators >= 3;
}

// ---------------------------------------------------------------------------
// 字节数估算
// ---------------------------------------------------------------------------

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

// ---------------------------------------------------------------------------
// 提取消息文本（对齐 tool-payload-stub）
// ---------------------------------------------------------------------------

function extractMessageText(msg: any): string | null {
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const toolBlock = content.find(
      (b: any) => b?.type === 'tool_result' || b?.type === 'toolResult',
    );
    if (toolBlock) {
      return typeof toolBlock.content === 'string'
        ? toolBlock.content
        : JSON.stringify(toolBlock.content);
    }
    const textParts = content
      .filter((b: any) => b?.type === 'text' || typeof b?.text === 'string')
      .map((b: any) => b.text);
    return textParts.length > 0 ? textParts.join('\n') : null;
  }
  if (content != null) return String(content);
  return null;
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * afterTurn 阶段：异步扫描本轮新增的 tool_result 消息，生成压缩版缓存。
 *
 * @param params.afterTurnParams - afterTurn 的原始 params（含 messages, prePromptMessageCount）
 * @param params.sessionKey - 会话标识
 * @param params.logger - 日志记录器
 * @param params.turnNumber - 当前轮次（用于 LRU 淘汰）
 */
export function compressToolResultsAsync(params: {
  messages: any[];
  prePromptMessageCount: number;
  sessionKey: string;
  logger?: any;
  turnNumber?: number;
}): void {
  const { messages, prePromptMessageCount, sessionKey, logger } = params;
  if (!sessionKey || messages.length === 0) return;

  const sessionMap = getSessionMap(sessionKey);

  // 本轮新增的消息（prePrompt 之后的部分）
  const newMsgs = prePromptMessageCount > 0
    ? messages.slice(prePromptMessageCount)
    : [];

  // v2.9.0: 判定统计 —— 用于核实"压缩是否真实调度"（用户可据日志判断
  // 是内容过小、压缩率不足，还是根本没进入路径）。
  let scannedCount = 0;
  let underThresholdCount = 0;
  let rateRejectedCount = 0;
  let compressedCount = 0;
  let bytesSaved = 0;

  for (const msg of newMsgs) {
    // 仅处理工具结果
    const isToolResult =
      msg?.role === 'tool' ||
      msg?.role === 'toolResult' ||
      msg?.role === 'tool_result';
    if (!isToolResult) continue;

    const textContent = extractMessageText(msg);
    if (!textContent) continue;

    scannedCount++;
    const size = byteLength(textContent);
    if (size < COMPRESSION_THRESHOLD_BYTES) {
      underThresholdCount++;
      continue;
    }

    // 已外部化的（stub）跳过
    if (textContent.includes('[LCM Tool Output:')) continue;

    // 使用消息在数组中的绝对索引作为 key
    const msgIndex = messages.indexOf(msg);
    if (msgIndex < 0) continue;

    // 已压缩过则跳过
    if (sessionMap.has(msgIndex)) continue;

    const toolName = extractToolName(msg);
    const compressed = compressToolResult(textContent, toolName);
    const compressedBytes = byteLength(compressed);

    // 仅当压缩确实有效（压缩率阈值内）才缓存
    if (compressedBytes >= size * COMPRESS_RATIO_THRESHOLD) {
      rateRejectedCount++;
      continue;
    }

    sessionMap.set(msgIndex, {
      compressed,
      originalBytes: size,
      compressedBytes,
      compressedAtTurn: params.turnNumber ?? 0,
      toolName,
    });

    compressedCount++;
    bytesSaved += (size - compressedBytes);
  }

  // LRU 淘汰：保留最近 200 条压缩记录（足够覆盖多轮历史）
  while (sessionMap.size > 200) {
    const firstKey = sessionMap.keys().next().value;
    if (firstKey === undefined) break;
    sessionMap.delete(firstKey);
  }

  if (logger) {
    logger.debug?.('[tool-result-compressor] scan summary', {
      sessionKey,
      scannedCount,
      underThresholdCount,
      rateRejectedCount,
      compressedCount,
      totalCompressed: sessionMap.size,
      thresholdBytes: COMPRESSION_THRESHOLD_BYTES,
      ratioThreshold: COMPRESS_RATIO_THRESHOLD,
    });
    if (compressedCount > 0) {
      logger.debug?.('[tool-result-compressor] compressed tool results', {
        sessionKey,
        compressedCount,
        bytesSaved,
        totalCompressed: sessionMap.size,
      });
    }
  }
}

/**
 * assemble 阶段：用压缩版替换消息中的工具结果原文。
 *
 * 仅替换已缓存的条目，未缓存的不动。
 * fresh tail 保护由调用方保证（assemble 的 stubLargeToolPayloads 已有 fresh tail 逻辑，
 * 本函数通过 freshTailCount 参数接收同一配置）。
 *
 * @param messages - assemble 的消息数组
 * @param sessionKey - 会话标识
 * @param freshTailCount - 最近 N 条消息不替换（默认 8，对齐 stub config）
 * @returns 处理后的消息数组和统计
 */
export function applyCompressedToolResults(
  messages: any[],
  sessionKey: string,
  freshTailCount: number = 8,
): { messages: any[]; replacedCount: number; tokensSaved: number } {
  if (!sessionKey || messages.length === 0) return { messages, replacedCount: 0, tokensSaved: 0 };

  const entry = _sessionCompressedCache.get(sessionKey);
  if (!entry) return { messages, replacedCount: 0, tokensSaved: 0 };

  const sessionMap = entry.map;
  if (sessionMap.size === 0) return { messages, replacedCount: 0, tokensSaved: 0 };

  entry.lastAccess = Date.now();
  touchSession(sessionKey);

  let replacedCount = 0;
  let tokensSaved = 0;
  const freshTailStart = Math.max(0, messages.length - freshTailCount);

  const processed = messages.map((msg, idx) => {
    // fresh tail 保护
    if (idx >= freshTailStart) return msg;

    const compressedEntry = sessionMap.get(idx);
    if (!compressedEntry) return msg;

    // 仅替换工具结果消息
    const isToolResult =
      msg?.role === 'tool' ||
      msg?.role === 'toolResult' ||
      msg?.role === 'tool_result';
    if (!isToolResult) return msg;

    // 不替换已外部化的（stub 已处理）
    const currentText = extractMessageText(msg);
    if (currentText && currentText.includes('[LCM Tool Output:')) return msg;

    replacedCount++;
    tokensSaved += Math.floor((compressedEntry.originalBytes - compressedEntry.compressedBytes) / 4);

    // 替换内容（保持消息结构）
    const content = msg.content;
    if (Array.isArray(content)) {
      return {
        ...msg,
        content: [{
          type: 'text',
          text: compressedEntry.compressed,
          toolResultCompressed: true,
          originalByteSize: compressedEntry.originalBytes,
        }],
      };
    }
    return {
      ...msg,
      content: compressedEntry.compressed,
      toolResultCompressed: true,
      originalByteSize: compressedEntry.originalBytes,
    };
  });

  return { messages: processed, replacedCount, tokensSaved };
}

/**
 * 会话重置时清理压缩缓存。
 * 对齐 session-reset.ts 的清理流程。
 */
export function clearCompressedToolResults(sessionKey: string): void {
  _sessionCompressedCache.delete(sessionKey);
}

/** 供 heartbeat 定时调用的异步淘汰入口（原仅 lazy evict on get/read） */
export function evictStaleCompressedResults(): void {
  evictStale();
}
