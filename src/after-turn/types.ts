/**
 * AfterTurnContext — 依赖注入接口，传递 afterTurn 需要的所有闭包单例。
 */
export interface AfterTurnContext {
  api: any;
  logger: any;
  qmdClient: any;
  graphAdapter: any;
  expStore: any;
  losslessClawAdapter: any;
  cascadeManager: any;
  retrievalGateway: any;
  lcmgConfig: any;
  tracker: any;
  userProfile: any;
  resolveDistillationLlm: (api: any) => any;
  lastAssembleExpIdsBySession: Map<string, { ids: Array<{ id: string; summary: string; query: string }>; ts: number }>;
  /** R-5: 会话级输出质量评分，afterTurn 评估后写入，assemble 中读取调整检索门槛 */
  sessionQualityScores: Map<string, number>;
  /** P2-1: L4 检索缓存，经验写入时整体失效 */
  l4QueryCache?: Map<string, { results: any[]; ts: number }>;
}