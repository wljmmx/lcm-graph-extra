/**
 * 大工具负载外部分片 + 存根替换（stubLargeToolPayloads）
 *
 * 在 assemble 阶段检测消息中的大工具调用结果，将其写入外部文件，
 * 并用 [LCM Tool Output: file_xxx | …] 存根引用替换原始内容，
 * 避免单轮 token 爆炸。
 *
 * 完全兼容 lossless-claw 的 large_files 机制：
 *   - 文件写入 lossless-claw 的 large_files 表
 *   - 存根格式与 lossless-claw 的 formatToolOutputReference 完全一致
 *   - Agent 可通过 lcm_describe(id="file_xxx", expandFile=true) 按需取回完整内容
 *   - lcm_expand 遍历 DAG 时可关联 fileIds
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { insertLargeFile } from '../lcm-bridge.js';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface StubConfig {
  enabled: boolean;
  /** 工具负载阈值（字节），超过此大小触发外部分片（默认 ~2K tokens = 8000 字节） */
  thresholdBytes: number;
  /** 外部文件存储目录 */
  filesDir: string;
  /** 最近 N 条消息不存根（fresh tail 保护） */
  freshTailCount: number;
}

export interface StubResult {
  /** 处理后的消息数组 */
  messages: any[];
  /** 存根化数量 */
  stubbedCount: number;
  /** 节省的 token 估算（4 字节 ≈ 1 token） */
  tokensSaved: number;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD_BYTES = 8000; // ~2K tokens
const DEFAULT_FRESH_TAIL = 8;

/** lossless-claw 的 fileId 正则：file_ + 16 位小写 hex */
const FILE_ID_RE = /\bfile_[a-f0-9]{16}\b/gi;

/** 探索摘要默认截取字符数 */
const EXPLORATION_SLICE_CHARS = 2_400;

/** 文本头部行数限制 */
const TEXT_HEADER_LIMIT = 18;

// ---------------------------------------------------------------------------
// 配置解析
// ---------------------------------------------------------------------------

/**
 * 从 lcm-graph-extra 插件配置中读取 stub 相关参数
 */
export function resolveStubConfig(pluginConfig: any): StubConfig {
  const stubCfg = pluginConfig?.stubLargeToolPayloads;
  const enabled = typeof stubCfg === 'object' ? (stubCfg.enabled === true) : false;
  const thresholdBytes = (typeof stubCfg === 'object' ? stubCfg.thresholdBytes : undefined)
    ?? pluginConfig?.largeFileThreshold
    ?? DEFAULT_THRESHOLD_BYTES;
  const filesDir = (typeof stubCfg === 'object' ? stubCfg.filesDir : undefined)
    ?? pluginConfig?.largeFilesDir
    ?? (process.env.LCM_LARGE_FILES_DIR || join(process.env.OPENCLAW_STATE_DIR || join(process.env.HOME || '/tmp', '.openclaw'), 'lcm-files'));
  const freshTailCount = (typeof stubCfg === 'object' ? stubCfg.freshTailCount : undefined)
    ?? DEFAULT_FRESH_TAIL;

  return { enabled, thresholdBytes, filesDir, freshTailCount };
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** 估算文本内容的字节数（UTF-8） */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

/** 格式化美式数字（如 45230 → "45,230"） */
function formatBytes(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * 生成文件 ID（完全兼容 lossless-claw 格式：file_ + 16 位 hex）
 *
 * lossless-claw 使用: `file_${randomUUID().replace(/-/g, "").slice(0, 16)}`
 * 对应的提取正则: FILE_ID_RE = /\bfile_[a-f0-9]{16}\b/gi
 */
function generateFileId(): string {
  return `file_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// 工具名提取
// ---------------------------------------------------------------------------

/**
 * 提取工具调用名称（从消息的 content block 中推断）
 *
 * 匹配 lossless-claw 的 resolveLiveToolResultExternalization 逻辑：
 *   优先从 content block 的 name 字段获取，其次从顶层 toolName 获取
 */
function extractToolName(msg: any): string {
  // 从 content array 的 block 中提取 name
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (typeof block?.name === 'string' && block.name.trim()) {
        return block.name.trim();
      }
    }
  }
  // 从顶层字段获取
  const topLevel = msg.toolName ?? msg.tool_name ?? '';
  if (typeof topLevel === 'string' && topLevel.trim()) {
    return topLevel.trim();
  }
  return 'tool-result';
}

// ---------------------------------------------------------------------------
// 确定性探索摘要生成（对齐 lossless-claw 的 exploreStructuredData / exploreCode / exploreText）
// ---------------------------------------------------------------------------

/**
 * 生成确定性探索摘要。
 *
 * lossless-claw 使用 LLM 辅助摘要（结构化数据/代码用确定性方法，文本用 LLM），
 * 此处为轻量级实现：检测内容类型 → 生成结构化摘要或文本头部。
 */
function generateExplorationSummary(content: string, fileName: string, mimeType: string): string {
  const trimmed = content.trim();

  // JSON 检测
  if (mimeType === 'application/json' || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return exploreStructuredData(trimmed, fileName);
  }

  // 代码检测（通过常见模式）
  if (isLikelyCode(trimmed, fileName)) {
    return exploreCode(trimmed, fileName);
  }

  // 默认：文本头部
  return exploreText(trimmed);
}

/** 结构化数据摘要（JSON/CSV/XML） */
function exploreStructuredData(content: string, fileName: string): string {
  const lines: string[] = [];
  lines.push(`Structured summary (${fileName || 'data'})`);

  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      lines.push(`Top-level type: array (${parsed.length} items)`);
      if (parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null) {
        const keys = Object.keys(parsed[0]).slice(0, 15);
        lines.push(`Item keys: ${keys.join(', ')}${keys.length >= 15 ? ', ...' : ''}`);
      }
    } else if (typeof parsed === 'object' && parsed !== null) {
      const keys = Object.keys(parsed).slice(0, 15);
      lines.push(`Top-level type: object (${Object.keys(parsed).length} keys)`);
      lines.push(`Keys: ${keys.join(', ')}${keys.length >= 15 ? ', ...' : ''}`);
    } else {
      lines.push(`Top-level type: ${typeof parsed}`);
    }
  } catch {
    lines.push(`Raw content (${content.length} chars)`);
  }

  return lines.join('\n');
}

/** 代码摘要（检测函数/类/导入） */
function exploreCode(content: string, fileName: string): string {
  const lines: string[] = [];
  lines.push(`Code exploration summary (${fileName || 'code'})`);

  const codeLines = content.split('\n');
  const imports: string[] = [];
  const definitions: string[] = [];
  const comments: string[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (/^(import|from|require|package|use|#include)\b/.test(trimmed)) {
      imports.push(trimmed.slice(0, 120));
    }
    if (/\b(function|def|class|interface|type|enum|struct|fn|pub fn|export|const|let|var)\b/.test(trimmed)) {
      definitions.push(trimmed.slice(0, 120));
    }
    if (/^(\/\/|#|--|;)\s/.test(trimmed) && comments.length < 5) {
      comments.push(trimmed.slice(0, 120));
    }
  }

  if (imports.length > 0) {
    lines.push(`Imports/dependencies: ${imports.length} entries`);
    lines.push(imports.slice(0, 8).join('\n'));
  }
  if (definitions.length > 0) {
    lines.push(`\nTop-level definitions: ${definitions.length} entries`);
    lines.push(definitions.slice(0, 10).join('\n'));
  }
  if (comments.length > 0) {
    lines.push(`\nNotable comments: ${comments.length}`);
    lines.push(comments.slice(0, 3).join('\n'));
  }

  lines.push(`\nTotal lines: ${codeLines.length}`);
  return lines.join('\n');
}

/** 文本摘要（头部截取） */
function exploreText(content: string): string {
  const lines: string[] = [];
  lines.push('Text exploration summary');

  const textLines = content.split('\n');
  const headers: string[] = [];

  for (const line of textLines.slice(0, TEXT_HEADER_LIMIT)) {
    const trimmed = line.trim();
    if (/^#{1,6}\s/.test(trimmed)) {
      headers.push(trimmed.slice(0, 100));
    }
  }

  if (headers.length > 0) {
    lines.push(`Detected section headers: ${headers.length}`);
    lines.push(headers.join('\n'));
  }

  // 文本头部预览
  const preview = textLines.slice(0, 5).map(l => l.slice(0, 200)).join('\n');
  lines.push(`\nContent preview:\n${preview}`);

  lines.push(`\nTotal lines: ${textLines.length}, Total chars: ${content.length}`);
  return lines.join('\n');
}

/** 检测内容是否可能是代码 */
function isLikelyCode(content: string, fileName: string): boolean {
  const ext = (fileName || '').split('.').pop()?.toLowerCase() ?? '';
  const codeExtensions = new Set([
    'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h',
    'cs', 'rb', 'php', 'swift', 'kt', 'scala', 'sh', 'sql', 'vue', 'svelte',
  ]);
  if (codeExtensions.has(ext)) return true;

  // 模式检测
  const lines = content.split('\n').slice(0, 20);
  let codeIndicators = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(import|export|function|class|def|const|let|var|if|for|while|return|pub|use|package|require)\b/.test(trimmed)) {
      codeIndicators++;
    }
    if (/[{}\[\]();]/.test(trimmed) && trimmed.length > 5) {
      codeIndicators++;
    }
  }
  return codeIndicators >= 3;
}

// ---------------------------------------------------------------------------
// 存根引用生成
// ---------------------------------------------------------------------------

/**
 * 生成存根引用文本。
 *
 * 完全兼容 lossless-claw 的 formatToolOutputReference 格式：
 *
 *   [LCM Tool Output: file_xxx | tool=ToolName | N bytes]
 *
 *   Exploration Summary:
 *   <summary>
 *
 *   Call lcm_describe(id="<file_id above>", expandFile=true) to fetch the full output content from disk.
 */
function formatToolOutputReference(
  fileId: string,
  toolName: string,
  byteSize: number,
  explorationSummary: string,
): string {
  return [
    `[LCM Tool Output: ${fileId} | tool=${toolName} | ${formatBytes(byteSize)} bytes]`,
    '',
    'Exploration Summary:',
    explorationSummary.trim() || '(no summary available)',
    '',
    'Call lcm_describe(id="<file_id above>", expandFile=true) to fetch the full output content from disk.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 文件存储
// ---------------------------------------------------------------------------

/** 确保目录存在，权限 0700 */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

/**
 * 将消息中的大工具负载外部化并替换为存根引用。
 *
 * 流程对齐 lossless-claw 的 interceptLargeToolResults：
 *   遍历消息 → 检测大负载 → 外部化到磁盘 → 写入 large_files 表 → 替换为存根
 *
 * @param messages - 原始消息数组
 * @param config - 存根配置
 * @param logger - 日志记录器（可选）
 * @param conversationId - lossless-claw 的 conversation_id（用于 large_files 表外键）
 * @returns 处理结果
 */
export function stubLargeToolPayloads(
  messages: any[],
  config: StubConfig,
  logger?: any,
  conversationId?: number | null,
): StubResult {
  if (!config.enabled || messages.length === 0) {
    return { messages, stubbedCount: 0, tokensSaved: 0 };
  }

  let stubbedCount = 0;
  let tokensSaved = 0;

  // 确保存储目录存在
  ensureDir(config.filesDir);

  // 最近 N 条消息不存根（fresh tail 保护，对齐 lossless-claw）
  const freshTailStart = Math.max(0, messages.length - config.freshTailCount);

  const processed = messages.map((msg, idx) => {
    // 仅处理工具结果消息（对齐 lossless-claw 的 interceptLargeToolResults）
    const isToolResult =
      msg.role === 'tool' ||
      msg.role === 'toolResult' ||
      msg.role === 'tool_result';

    if (!isToolResult) return msg;

    // 获取消息内容文本
    const content = msg.content;
    let textContent: string | null = null;

    if (typeof content === 'string') {
      textContent = content;
    } else if (Array.isArray(content)) {
      // Anthropic content blocks 或 OpenClaw tool_result blocks
      const toolBlock = content.find(
        (b: any) => b?.type === 'tool_result' || b?.type === 'toolResult',
      );
      if (toolBlock) {
        textContent = typeof toolBlock.content === 'string'
          ? toolBlock.content
          : JSON.stringify(toolBlock.content);
      } else {
        // 回退：拼接所有文本块
        textContent = content
          .filter((b: any) => b?.type === 'text' || typeof b?.text === 'string')
          .map((b: any) => b.text)
          .join('\n');
        if (!textContent) {
          textContent = JSON.stringify(content);
        }
      }
    } else if (content != null) {
      textContent = String(content);
    }

    if (!textContent) return msg;

    const size = byteLength(textContent);

    // 不满足阈值，跳过
    if (size < config.thresholdBytes) return msg;

    // Fresh tail 保护：最近的消息不存根
    if (idx >= freshTailStart) return msg;

    // ── 外部化（对齐 lossless-claw 的 externalizeLargeTextPayload） ──

    const fileId = generateFileId();
    const toolName = extractToolName(msg);
    const mimeType = 'text/plain';
    const extension = 'txt';
    const fileName = `${toolName}.${extension}`;
    const lineCount = textContent.split(/\r?\n/).length;

    // 存储路径：<filesDir>/<conversationId>/<fileId>.<ext>（对齐 lossless-claw）
    const convDir = conversationId != null
      ? join(config.filesDir, String(conversationId))
      : config.filesDir;
    const filePath = join(convDir, `${fileId}.${extension}`);

    try {
      ensureDir(convDir);
      writeFileSync(filePath, textContent, { encoding: 'utf-8', mode: 0o600 });
    } catch (err) {
      logger?.warn?.('[stubLargeToolPayloads] failed to write file', {
        filePath,
        err: String(err),
      });
      return msg;
    }

    // 生成探索摘要
    const explorationSummary = generateExplorationSummary(textContent, fileName, mimeType);

    // 写入 large_files 表（使 lcm_describe / lcm_expand 可检索）
    if (conversationId != null) {
      const inserted = insertLargeFile({
        fileId,
        conversationId,
        fileName,
        mimeType,
        byteSize: size,
        lineCount,
        storageUri: filePath,
        explorationSummary,
      });
      if (!inserted && logger) {
        logger.warn?.('[stubLargeToolPayloads] insertLargeFile failed, lcm_describe will not find this file', {
          fileId,
          conversationId,
        });
      }
    } else if (logger) {
      logger.debug?.('[stubLargeToolPayloads] no conversationId, skipping large_files table insert', {
        fileId,
      });
    }

    // 生成存根引用（对齐 lossless-claw 的 formatToolOutputReference）
    const stub = formatToolOutputReference(fileId, toolName, size, explorationSummary);

    stubbedCount++;
    tokensSaved += Math.floor(size / 4); // 粗略估算：4 字节 ≈ 1 token

    // 替换消息内容（对齐 lossless-claw 的 buildExternalizedToolResultBlock）
    if (Array.isArray(content)) {
      return {
        ...msg,
        content: [{
          type: 'text',
          text: stub,
          externalizedFileId: fileId,
          originalByteSize: size,
          toolOutputExternalized: true,
          externalizationReason: 'large_tool_result',
        }],
      };
    } else {
      return {
        ...msg,
        content: stub,
        externalizedFileId: fileId,
        originalByteSize: size,
        toolOutputExternalized: true,
        externalizationReason: 'large_tool_result',
      };
    }
  });

  if (stubbedCount > 0 && logger) {
    logger.info?.('[stubLargeToolPayloads] stubbed', {
      stubbedCount,
      tokensSaved: Math.floor(tokensSaved),
      filesDir: config.filesDir,
      conversationId: conversationId ?? 'none',
    });
  }

  return { messages: processed, stubbedCount, tokensSaved };
}