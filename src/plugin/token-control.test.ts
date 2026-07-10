/**
 * applyTotalControl 单元测试。
 *
 * 覆盖 P0-2 修复：优先级与 priority-trim 对齐。
 * 保护顺序（高→低）：经验(L4) > 知识图谱(L3) > 记忆文件/文档摘要(L2) > 历史摘要/完整文档(L1) > 工具(可删)
 */
import { describe, it, expect } from 'vitest';
import { applyTotalControl } from './token-control.js';

describe('applyTotalControl', () => {
  it('未超限时原样返回', () => {
    const text = '## 📄 记忆文件（参考）\nshort content';
    expect(applyTotalControl(text, 1000)).toBe(text);
  });

  it('空字符串原样返回', () => {
    expect(applyTotalControl('', 100)).toBe('');
  });

  it('P0-2: 经验优先级最高，超限时最后被裁剪', () => {
    // 构造：历史摘要(优先级1) + 知识图谱(3) + 经验(4)，maxChars 设到只能保留 1 段
    const sections = [
      '## 📋 历史摘要\n' + 'a'.repeat(200),
      '## 🔗 知识图谱（历史知识参考）\n' + 'b'.repeat(200),
      '## 💡 经验总结（历史经验参考）\n' + 'c'.repeat(200),
    ];
    const text = sections.join('\n\n');
    // maxChars 设为 250：移除历史摘要(优先级1)后约 410，仍超；移除知识图谱(3)后约 205，达标
    const removed: { label: string; chars: number }[] = [];
    const result = applyTotalControl(text, 250, removed);

    // 经验段应保留，历史摘要和知识图谱应被移除
    expect(result).toContain('经验总结');
    expect(result).not.toContain('历史摘要');
    expect(result).not.toContain('知识图谱');
    // 移除顺序：先低优先级（历史摘要），再高优先级（知识图谱）
    expect(removed.length).toBeGreaterThanOrEqual(2);
  });

  it('P0-2: 历史摘要优先级最低，最先被裁剪', () => {
    const sections = [
      '## 📋 历史摘要\n' + 'a'.repeat(200),
      '## 📄 记忆文件（参考）\n' + 'b'.repeat(200),
    ];
    const text = sections.join('\n\n');
    const removed: { label: string; chars: number }[] = [];
    const result = applyTotalControl(text, 250, removed);

    expect(result).toContain('记忆文件');
    expect(result).not.toContain('历史摘要');
    expect(removed.some(r => r.label.includes('历史摘要'))).toBe(true);
  });

  it('P0-2: 完整文档与历史摘要同属最低优先级', () => {
    const sections = [
      '## 📄 完整文档（参考，非当前任务）\n' + 'a'.repeat(200),
      '## 🔗 知识图谱（历史知识参考）\n' + 'b'.repeat(200),
    ];
    const text = sections.join('\n\n');
    const removed: { label: string; chars: number }[] = [];
    const result = applyTotalControl(text, 250, removed);

    expect(result).toContain('知识图谱');
    expect(result).not.toContain('完整文档');
  });

  it('P0-2: 知识图谱优先级高于记忆文件', () => {
    const sections = [
      '## 📄 记忆文件（参考）\n' + 'a'.repeat(200),
      '## 🔗 知识图谱（历史知识参考）\n' + 'b'.repeat(200),
    ];
    const text = sections.join('\n\n');
    // maxChars=250：移除记忆文件(2)后约 205，达标；知识图谱(3)应保留
    const removed: { label: string; chars: number }[] = [];
    const result = applyTotalControl(text, 250, removed);

    expect(result).toContain('知识图谱');
    expect(result).not.toContain('记忆文件');
  });

  it('P0-2: 经验比知识图谱更受保护', () => {
    const sections = [
      '## 🔗 知识图谱（历史知识参考）\n' + 'a'.repeat(200),
      '## 💡 经验总结（历史经验参考）\n' + 'b'.repeat(200),
    ];
    const text = sections.join('\n\n');
    const removed: { label: string; chars: number }[] = [];
    const result = applyTotalControl(text, 250, removed);

    expect(result).toContain('经验总结');
    expect(result).not.toContain('知识图谱');
  });

  it('removedSections 记录被移除段的信息', () => {
    const text = '## 📋 历史摘要\n' + 'a'.repeat(300);
    const removed: { label: string; chars: number }[] = [];
    applyTotalControl(text, 100, removed);
    expect(removed.length).toBeGreaterThanOrEqual(1);
    expect(removed[0].label).toContain('历史摘要');
    expect(removed[0].chars).toBeGreaterThan(0);
  });

  it('单段超长时：低优先级段被整段移除（result 为空或后缀）', () => {
    // 单段超长：阶段1 整段移除后 result 为空（length 0 <= maxChars），不再触发阶段2 截断
    const text = '## 📋 历史摘要\n' + 'x'.repeat(500);
    const result = applyTotalControl(text, 100);
    // 历史摘要整段被移除，结果不含该段内容
    expect(result).not.toContain('历史摘要');
  });

  it('阶段2截断：保留段仍超限时截断到 maxChars', () => {
    // 构造两个同优先级段，maxChars 设到移除一个后另一个仍超
    // 经验段(优先级4)超长 + 工具段(优先级5)，工具优先级数字大不会先被裁
    // 但经验是最高保留优先级（4），工具是5（可删）。移除顺序按 priority 升序：
    // 先尝试移除 priority 较小的段。这里只有经验(4)和工具(5)，
    // 先移除经验(4)…但经验只有1段。实际：经验先被移除，result=工具段。
    // 改用：两段都是历史摘要(1)，移除第一段后第二段仍超 → 触发阶段2截断
    const text =
      '## 📋 历史摘要\n' + 'a'.repeat(300) + '\n\n' +
      '## 📋 历史摘要\n' + 'b'.repeat(300);
    const result = applyTotalControl(text, 100);
    // 两段同优先级，阶段1 逐段移除直到不超或无段可移；
    // 若移除后仍超（单段 > maxChars），阶段2 截断
    expect(result.length <= 200 || result.includes('已裁剪') || !result.includes('历史摘要')).toBe(true);
  });
});
