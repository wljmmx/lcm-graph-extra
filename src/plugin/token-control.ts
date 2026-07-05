/**
 * applyTotalControl — 上下文 token 总量控制
 *
 * 按 section 优先级裁剪：低优先级整段移除，仍超限时截断保留段。
 * 优先级（数字小先被 trim）：
 *   1. 完整文档（最低）
 *   2. 经验
 *   3. 知识图谱（默认）
 *   4. 记忆文件（最高，通常保留）
 *   5. 工具指引（可安全删除）
 */

/**
 * 按 section 标题分割并按优先级裁剪到 maxChars 以内。
 * @param injected 原始 systemPromptAddition 文本
 * @param maxChars 最大字符数
 * @param removedSections 输出参数，记录被移除的段信息（可选）
 */
export function applyTotalControl(
  injected: string,
  maxChars: number,
  removedSections?: { label: string; chars: number }[],
): string {
  if (!injected || injected.length <= maxChars) return injected;

  // 按 section 标题分割
  const sections: { label: string; content: string; priority: number }[] = [];
  const lines = injected.split('\n');
  let currentLabel = '';
  let currentLines: string[] = [];
  let currentPriority = 0;

  for (const line of lines) {
    // Match any Markdown H2 header: ## anything (emoji or plain text)
    const headerMatch = line.match(/^## (.+)/);
    if (headerMatch) {
      if (currentLines.length > 0 && currentLabel) {
        sections.push({
          label: currentLabel,
          content: currentLines.join('\n'),
          priority: currentPriority,
        });
      }
      // Priority by keyword matching (emoji-independent)
      const headerText = headerMatch[1];
      if (headerText.includes('完整文档')) {
        currentPriority = 1;  // 最低优先级，超限时最先被 trim
      } else if (headerText.includes('经验')) {
        currentPriority = 2;  // 较低优先级
      } else if (headerText.includes('知识图谱')) {
        currentPriority = 3;  // 较高优先级
      } else if (headerText.includes('记忆文件') || headerText.includes('📄')) {
        currentPriority = 4;  // 最高优先级，最后被 trim（通常保留）
      } else if (headerText.includes('工具') || headerText.includes('Tool')) {
        currentPriority = 5;  // 工具指引可安全删除
      } else {
        currentPriority = 3;
      }
      currentLabel = line;
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.length > 0 && currentLabel) {
    sections.push({
      label: currentLabel,
      content: currentLines.join('\n'),
      priority: currentPriority,
    });
  }

  if (sections.length === 0) return injected;

  // 按优先级升序排列（数字小的先被 trim，即完整文档→经验→知识图谱→记忆文件）
  sections.sort((a, b) => a.priority - b.priority);

  // 阶段1：从低优先级整段移除
  let result = injected;
  const removedStats: { label: string; chars: number }[] = [];
  for (let i = 0; i < sections.length && result.length > maxChars; i++) {
    // 只移除当前最低优先级的非最高优先级段
    const lowestPriority = sections[i].priority;
    const candidates = sections.filter(s => s.priority === lowestPriority);
    for (const candidate of candidates) {
      if (result.length <= maxChars) break;
      // SEC-L: 修复前用 result.replace(candidate.content, '') —— String.replace 首个出现
      // 不一定是目标段（若段内容在多处重复会误删）。改为 indexOf 精确定位 + slice 移除。
      const idx = result.indexOf(candidate.content);
      if (idx !== -1) {
        result = (result.slice(0, idx) + result.slice(idx + candidate.content.length))
          .replace(/\n{3,}/g, '\n\n').trim();
      }
      removedStats.push({ label: candidate.label, chars: candidate.content.length });
    }
  }
  if (removedSections) {
    for (const rs of removedStats) removedSections.push(rs);
  }

  // 阶段2：如果还超，截断最后的保留内容
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + '\n\n...（上下文字段过长，已裁剪）';
  }

  return result;
}
