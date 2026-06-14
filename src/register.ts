export interface OpenClawContext {
  config: Record<string, unknown>;
  logger?: any;
  hooks?: Record<string, (...args: any[]) => void>;
  sessionKey?: string;
  sessionFile?: string;
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
