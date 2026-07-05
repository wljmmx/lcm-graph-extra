/**
 * S-9': 关键词提取（轻量版）
 *
 * 简单的词频统计 + 停用词过滤，零延迟。
 * 用于话题漂移检测和跨轮去重。
 */

const TOPIC_STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could','should',
  'may','might','can','this','that','these','those','it','its','for',
  'with','from','into','through','during','before','after','by','about',
  'and','or','but','not','no','yes','so','if','then','else','when',
  'what','which','who','whom','how','why','where','there','here',
  '的','了','在','是','我','有','和','就','不','人','都','一','一个','上',
  '也','很','到','说','要','去','你','会','着','没有','看','好','自己','这',
  '他','她','它','们','那','些','什么','怎么','吗','呢','吧','啊','哦',
  'please','just','need','want','like','get','make','use','using','used',
  'help','know','think','还是','可以','已经','现在','因为','所以','但是',
]);

/**
 * S-9': 从消息列表中提取 top-N 关键词，用于话题漂移检测。
 * 简单的词频统计 + 停用词过滤，零延迟。
 */
export function extractTopKeywords(messages: any[], topN: number = 15): string[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const freq = new Map<string, number>();
  for (const msg of messages) {
    const content = msg?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content.map((c: any) => typeof c === 'string' ? c : c?.text ?? '').join(' ');
    }
    if (!text) continue;
    const tokens = text
      .replace(/[\s,;.，；。.、:：!?！？\\/\\[\\](){}|~`@#$%^&*=+<>-]+/g, ' ')
      .split(/\s+/)
      .filter((t) => {
        const w = t.toLowerCase();
        return !TOPIC_STOP_WORDS.has(w) && w.length >= 2;
      });
    for (const tok of tokens) {
      const w = tok.toLowerCase();
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word]) => word);
}

/** Simple string hash for cross-turn dedup */
export function quickHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return h.toString(36);
}
