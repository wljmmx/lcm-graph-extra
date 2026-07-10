/**
 * H-5: 模型输出质量自动评估结果。
 */
export interface OutputQualityMetrics {
  outputLength: number;
  outputLengthOk: boolean;
  isRepetitive: boolean;
  referencesUsed: number;
  referencesAvailable: number;
  userFeedbackSignal: 'positive' | 'negative' | 'neutral';
  overallScore: number; // [0, 1]
}

/**
 * H-5: 模型输出质量自动评估（afterTurn 中执行）。
 * 纯规则检查，零 LLM 调用，不影响延迟。
 *
 * 从 index.ts 模块级提取到独立模块。
 */
export function evaluateOutputQuality(
  output: string,
  previousOutput: string | null,
  systemPromptAddition: string,
): OutputQualityMetrics {
  const metrics: OutputQualityMetrics = {
    outputLength: output.length,
    outputLengthOk: output.length >= 10 && output.length <= 8000,
    isRepetitive: false,
    referencesUsed: 0,
    referencesAvailable: 0,
    userFeedbackSignal: 'neutral',
    overallScore: 0,
  };

  // 1. 引用使用率：检查模型输出中是否引用了知识库中的实体
  if (systemPromptAddition) {
    const kbEntities = systemPromptAddition.match(/`(\w{3,})`/g) ?? [];
    metrics.referencesAvailable = kbEntities.length;
    if (kbEntities.length > 0) {
      let used = 0;
      for (const entity of kbEntities) {
        if (output.includes(entity.replace(/`/g, ''))) used++;
      }
      metrics.referencesUsed = used;
    }
  }

  // 2. 重复输出检测
  if (previousOutput && output.length > 50) {
    const overlap = output.slice(0, 200).toLowerCase();
    const prev = previousOutput.slice(0, 200).toLowerCase();
    if (overlap === prev) {
      metrics.isRepetitive = true;
    }
  }

  // 综合评分
  let score = 0;
  if (metrics.outputLengthOk) score += 0.3;
  if (metrics.referencesAvailable > 0) {
    score += (metrics.referencesUsed / metrics.referencesAvailable) * 0.3;
  } else {
    score += 0.3; // 无引用内容时不扣分
  }
  if (!metrics.isRepetitive) score += 0.4;
  metrics.overallScore = Math.round(score * 100) / 100;
  return metrics;
}