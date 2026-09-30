/**
 * graph-memory-pro `:GmMessage` 写入契约 —— LCM 侧镜像实现。
 *
 * 为什么必须镜像：lcm-graph-extra 是 graph-memory-pro 的**扩充增强**项目，写入的
 * `:GmMessage` 必须与上游生产端使用同一套身份与字段，否则双方数据无法互相访问：
 *   - 上游每轮 `agent_end` 会把整段会话**全量重放**（planMessagePersist）。若 id 算法
 *     不同，重放算出的 id 命不中导入写入的节点 → MERGE 退化为插入 → 历史被复制一份；
 *   - rebuild 读取面（listAllSessionKeys / getSessionMessages*）按 sessionKey 取全量，
 *     于是同一逻辑消息被读两次 → user/assistant 配对翻倍（llm 模式下是真金白银的 token）。
 *
 * 上游权威实现（v2.4.7）：graph-memory-pro `src/store/messages.ts`
 *   - `messageContentHash()`  —— 64-bit FNV-1a 全文指纹
 *   - `buildMessageId()`      —— `gm:<sessionKey>:<role>:<hash>:<seq>`
 *   - `planMessagePersist()`  —— 过滤 + turnIndex/occurrence 语义
 *   - `saveMessage()`         —— 字段集与 `createdAt` 仅 ON CREATE
 * 本节逐字对齐上述四点。哈希算法由公开测试向量守护（见 gm-message-contract.test.ts）。
 */

/** 上游只承认这两种 role（`planMessagePersist` 的过滤结果） */
export type GmMessageRole = 'user' | 'assistant';

/** 一条待写入的 `:GmMessage` 行（字段集与上游 saveMessage 一致） */
export interface GmMessageRow {
  /** `gm:<sessionKey>:<role>:<contentHash>:<seq>` */
  id: string;
  sessionKey: string;
  /**
   * 批内 0 基序号（上游注释：仅诊断用途，不再是身份的一部分）。
   * 上游每轮全量重放整段会话，故等价于「会话内 0 基消息序号」。
   */
  turnIndex: number;
  role: GmMessageRole;
  /** 全文（上游不截断；截断会同时改变指纹与 id） */
  content: string;
  /** 真实消息时间（上游 `createdAt`，仅 ON CREATE 写入） */
  createdAt: number;
  /** 同 (role, 指纹) 在本批中的 0 基出现序号（同内容重复消息靠它区分） */
  occurrence: number;
}

/** 导入侧的原始消息行（来自 lossless-claw 本地 sqlite 或官方 per-agent sqlite） */
export interface GmMessageSourceRow {
  /**
   * 消息角色：来源可能是任意 JSON 值（官方转录由 JSON.parse 得到），
   * 由 normalizeGmRole 按上游规则归一，非 user/assistant 一律丢弃。
   */
  role?: unknown;
  /**
   * 消息内容：字符串或 block 数组（官方转录两种都存）。
   * 扁平化规则见 flattenGmMessageContent —— 必须与上游取文本的规则一致，
   * 否则指纹不同 → id 不同 → MERGE 命不中上游节点。
   */
  content?: unknown;
  /** 消息真实时间（ms）。上游取宿主消息时间戳；缺失时写 0 由调用方兜底 */
  createdAt?: number;
}

/**
 * 消息内容扁平化 —— 与上游 `extractMessageText` 的处理**逐字对齐**：
 *   - 字符串：原样返回（不 trim，trim 会改变指纹）
 *   - 数组：保留「字符串元素」与「type === 'text' 的块」，取 `b.text ?? ''`，以 `"\n"` 连接
 *   - 其他：返回空串
 *
 * 为什么必须一致：上游持久化时先取文本、再对该文本算 FNV 指纹并构成 id。
 * 若这里多做一次 trim、换用别的分隔符、或忽略 input_text 块，
 * 同一条消息在两处会算出不同 id，MERGE 永不命中 → 历史被复制。
 */
export function flattenGmMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && (typeof b === 'string' || b?.type === 'text'))
      .map((b: any) => (typeof b === 'string' ? b : (b?.text ?? '')))
      .join('\n');
  }
  return '';
}

/**
 * 64-bit FNV-1a 全文指纹，小写 16 位十六进制。
 *
 * 与上游 `messageContentHash` 完全一致：逐 UTF-16 code unit 迭代（charCodeAt），
 * 64-bit 掩码，`padStart(16, '0')`。
 * 上游特意用**全文**而非前 N 字符：旧实现只取 `content.slice(0, 200)`，
 * 前 200 字相同的不同消息会算出同一 hash → 同一 id → MERGE 互相覆盖（真丢数据）。
 */
export function messageContentHash(content: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < content.length; i++) {
    h ^= BigInt(content.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * 稳定消息键 —— 与上游 `buildMessageId` 一致（不含数组下标，故宿主 compaction
 * 改写历史数组后键不变，不会重插）。
 */
export function buildMessageId(
  sessionKey: string,
  role: GmMessageRole,
  contentHash: string,
  seq: number,
): string {
  return `gm:${sessionKey}:${role}:${contentHash}:${seq}`;
}

/**
 * 解析写入 `:GmMessage.sessionKey` 的会话键 —— 与上游 `agent_end` 的回退链一致：
 *   `ctx.sessionKey ?? ctx.sessionId ?? _lastSessionKey`，三者皆空则**整轮跳过写入**。
 *
 * lcm 侧对应列：`conversations.session_key`（宿主 ctx.sessionKey）与
 * `conversations.session_id`（宿主 ctx.sessionId）。
 *
 * 注意：**不得**在此之外自造合成键（如 `conv:<conversation_id>`）——上游从无此约定，
 * 合成键会让同一段历史以两个 sessionKey 各被 rebuild 一遍（重复计算），
 * 而写入 session_id 恰是上游自己的回退值，可与之命中同一 key。
 *
 * @returns 可用的会话键；空串表示两列皆空 → 调用方应跳过该批（对齐上游「整轮跳过」）
 */
export function resolveGmSessionKey(sessionKey?: string | null, sessionId?: string | null): string {
  const sk = typeof sessionKey === 'string' ? sessionKey.trim() : '';
  if (sk) return sk;
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  return sid;
}

/** role 归一：与上游 `/user|human/i` → user、`/assistant/i` → assistant 完全一致 */
export function normalizeGmRole(raw: unknown): GmMessageRole | null {
  const r = typeof raw === 'string' ? raw : '';
  const isUser = /user|human/i.test(r);
  const isAssistant = /assistant/i.test(r);
  if (!isUser && !isAssistant) return null;
  return isAssistant ? 'assistant' : 'user';
}

export interface GmMessagePlan {
  rows: GmMessageRow[];
  /** 非 user/assistant（system/tool 等）被跳过数 —— 上游同样不持久化这些 */
  skippedNonConversational: number;
  /** 内容为空（含纯空白）被跳过数 —— 上游同样跳过 */
  skippedEmpty: number;
}

/**
 * 把「某会话按时间序排列的消息」规划为待写入的 `:GmMessage` 行。
 *
 * 与上游 `planMessagePersist` 对齐的三件事：
 *   1. 过滤：仅 user/assistant 且文本非空（system/tool 一律不写）；
 *   2. 身份：`sessionKey + role + 全文指纹 + 同内容出现序号`（不含位置分量）；
 *   3. 序号：`turnIndex` 为**过滤后**的 0 基递增计数（每产出一行 +1）。
 *
 * @param sources  已按会话内时序升序排列的原始消息（调用方负责排序）
 * @param sessionKey 已由 resolveGmSessionKey 解析；空串时调用方不应调用本函数
 */
export function planGmMessageRows(
  sources: readonly GmMessageSourceRow[],
  sessionKey: string,
): GmMessagePlan {
  const rows: GmMessageRow[] = [];
  const seen = new Map<string, number>();
  let turnIndex = 0;
  let skippedNonConversational = 0;
  let skippedEmpty = 0;

  for (const src of sources) {
    const role = normalizeGmRole(src?.role);
    if (!role) {
      skippedNonConversational += 1;
      continue;
    }
    const content = flattenGmMessageContent(src?.content);
    if (!content.trim()) {
      skippedEmpty += 1;
      continue;
    }
    const contentHash = messageContentHash(content);
    const group = `${role}\u0000${contentHash}`;
    const occurrence = seen.get(group) ?? 0;
    seen.set(group, occurrence + 1);

    rows.push({
      id: buildMessageId(sessionKey, role, contentHash, occurrence),
      sessionKey,
      turnIndex,
      role,
      content,
      createdAt: typeof src?.createdAt === 'number' ? src.createdAt : 0,
      occurrence,
    });
    turnIndex += 1;
  }

  return { rows, skippedNonConversational, skippedEmpty };
}