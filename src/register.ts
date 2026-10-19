export interface OpenClawContext {
  config: Record<string, unknown>;
  logger?: any;
  hooks?: Record<string, (...args: any[]) => void>;
  sessionKey?: string;
  /** 旧契约：活动会话的 JSONL 转录路径。SDK 2026.10.4 起 compact 不再提供该定位符。 */
  sessionFile?: string;
  /**
   * SDK 2026.10.4：存储无关的会话身份（agentId/sessionId/sessionKey/storePath），
   * 取代 `sessionFile` 作为会话定位的权威来源。
   */
  sessionTarget?: any; // SDK: ContextEngineSessionTarget
  memoryDir?: string;
  sessionId?: string;
  taskId?: string;
  recentMessages?: Array<Record<string, unknown>>;
  priorMessages?: Array<Record<string, unknown>>;
}

export interface PluginInstance {
  config: any;
  logger: any;
  context: OpenClawContext;
  unregister(): void;
  _losslessClawAdapter?: any;
}
