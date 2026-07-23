/**
 * 大工具负载外部分片 + 存根替换（stubLargeToolPayloads）
 *
 * 在 assemble 阶段检测消息中的大工具调用结果，将其写入外部文件，
 * 并用 [LCM Tool Output: file_xxx | …] 存根引用替换原始内容，
 * 避免单轮 token 爆炸。
 *
 * 存根格式兼容 lossless-claw 的 lcm_describe 工具。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

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

const DEFAULT_THRESHOLD_BYTES = 8000; // ~2K tokens
const DEFAULT_FRESH_TAIL = 8;

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

/**
 * 估算文本内容的字节数（UTF-8）
 */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

/**
 * 提取工具调用名称（从消息的 tool_call_id 或 tool_use 推断）
 */
function extractToolName(msg: any): string {
  // 尝试从 role 推断
  if (msg.role === 'tool' || msg.role === 'toolResult') {
    // 从 toolCallId 推断工具名
    const tcId = msg.toolCallId || msg.tool_call_id || msg.tool_use_id || '';
    if (tcId) {
      // 兼容多种 SDK 格式：toolu_xxx 或 tooluse_xxx
      const parts = tcId.split('_');
      if (parts.length >= 2) {
        return parts.slice(1).join('_') || 'Tool';
      }
    }
    // 从 content 中提取工具名（如果 content 是结构化对象）
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.toolResult?.toolName) return block.toolResult.toolName;
        if (block?.tool_use?.name) return block.tool_use.name;
      }
    }
  }
  return 'Tool';
}

/**
 * 生成文件 ID（兼容 lossless-claw 格式：file_ + 24 位 hex）
 */
function generateFileId(): string {
  return `file_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/**
 * 格式化美式数字（如 45230 → "45,230"）
 */
function formatBytes(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * 生成存根引用文本（兼容 lossless-claw 的 [LCM Tool Output: ...] 格式）
 */
function formatStubReference(
  fileId: string,
  toolName: string,
  byteSize: number,
  storedPath: string,
): string {
  return [
    `[LCM Tool Output: ${fileId} | tool=${toolName} | ${formatBytes(byteSize)} bytes]`,
    '',
    `Tool output externalized to disk (${formatBytes(byteSize)} bytes).`,
    `Use Read("${storedPath}") to retrieve the full content.`,
    '',
    `Or call lcm_describe(id="${fileId}", expandFile=true) if lossless-claw is available.`,
  ].join('\n');
}

/**
 * 确保目录存在，权限 0700
 */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * 将消息中的大工具负载外部化并替换为存根引用
 *
 * @param messages - 原始消息数组
 * @param config - 存根配置
 * @param logger - 日志记录器（可选）
 * @returns 处理结果
 */
export function stubLargeToolPayloads(
  messages: any[],
  config: StubConfig,
  logger?: any,
): StubResult {
  if (!config.enabled || messages.length === 0) {
    return { messages, stubbedCount: 0, tokensSaved: 0 };
  }

  let stubbedCount = 0;
  let tokensSaved = 0;

  // 确保存储目录存在
  ensureDir(config.filesDir);

  // 最近 N 条消息不存根（fresh tail 保护）
  const freshTailStart = Math.max(0, messages.length - config.freshTailCount);

  const processed = messages.map((msg, idx) => {
    // 仅处理工具结果消息
    const isToolResult =
      msg.role === 'tool' ||
      msg.role === 'toolResult' ||
      msg.role === 'tool_result';

    if (!isToolResult) return msg;

    // 获取消息内容
    const content = msg.content;
    let textContent: string | null = null;

    if (typeof content === 'string') {
      textContent = content;
    } else if (Array.isArray(content)) {
      // Anthropic content blocks: [{type: "tool_result", content: "..."}]
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

    // 外部化
    const fileId = generateFileId();
    const fileName = `${fileId}.txt`;
    const filePath = join(config.filesDir, fileName);
    const toolName = extractToolName(msg);

    try {
      writeFileSync(filePath, textContent, { encoding: 'utf-8', mode: 0o600 });
    } catch (err) {
      logger?.warn?.('[stubLargeToolPayloads] failed to write file', {
        filePath,
        err: String(err),
      });
      return msg;
    }

    const stub = formatStubReference(fileId, toolName, size, filePath);
    stubbedCount++;
    tokensSaved += Math.floor(size / 4); // 粗略估算：4 字节 ≈ 1 token

    // 替换消息内容
    if (Array.isArray(content)) {
      // Anthropic 格式：保留数组结构，替换为单个 text 块
      return {
        ...msg,
        content: [{ type: 'text', text: stub }],
        _stubbedFileId: fileId,
        _stubbedFilePath: filePath,
        _stubbedByteSize: size,
      };
    } else {
      return {
        ...msg,
        content: stub,
        _stubbedFileId: fileId,
        _stubbedFilePath: filePath,
        _stubbedByteSize: size,
      };
    }
  });

  if (stubbedCount > 0 && logger) {
    logger.info?.('[stubLargeToolPayloads] stubbed', {
      stubbedCount,
      tokensSaved: Math.floor(tokensSaved),
      filesDir: config.filesDir,
    });
  }

  return { messages: processed, stubbedCount, tokensSaved };
}