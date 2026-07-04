<script setup lang="ts">
/**
 * MemoryResultList —— 跨引擎搜索结果列表。
 *
 * - 三个 NCard 分组（lcm / qmd / neo4j），每组 NList 展示结果
 * - 每条结果展示 content（高亮匹配词）、source、score
 * - 单引擎失败时显示 NAlert（来自 response.errors）
 */
import { computed } from 'vue';
import { NCard, NList, NListItem, NTag, NAlert, NEmpty, NSpace, NText } from 'naive-ui';
import type { MemorySearchResponse, MemorySearchResult } from '../api/memory';

const props = defineProps<{
  results: MemorySearchResponse | null | undefined;
  loading?: boolean;
  /** 高亮匹配词（搜索词） */
  query?: string;
}>();

const lcmResults = computed<MemorySearchResult[]>(() => props.results?.results.lcm ?? []);
const qmdResults = computed<MemorySearchResult[]>(() => props.results?.results.qmd ?? []);
const neo4jResults = computed<MemorySearchResult[]>(() => props.results?.results.neo4j ?? []);
const errors = computed(() => props.results?.errors ?? {});

/** 把 content 按 query 拆分为片段（命中段标 hit=true），用于高亮渲染 */
function highlight(content: string, query: string | undefined): Array<{ text: string; hit: boolean }> {
  if (!content) return [{ text: '', hit: false }];
  if (!query || !query.trim()) return [{ text: content, hit: false }];
  const q = query.trim();
  const lower = content.toLowerCase();
  const ql = q.toLowerCase();
  const segs: Array<{ text: string; hit: boolean }> = [];
  let i = 0;
  while (i < content.length) {
    const idx = lower.indexOf(ql, i);
    if (idx === -1) {
      segs.push({ text: content.slice(i), hit: false });
      break;
    }
    if (idx > i) segs.push({ text: content.slice(i, idx), hit: false });
    segs.push({ text: content.slice(idx, idx + q.length), hit: true });
    i = idx + q.length;
  }
  return segs;
}

/** source → 颜色 */
function sourceColor(_s: string): 'info' | 'success' | 'warning' {
  return 'info';
}

/** 引擎分组配置 */
const groups = computed(() => [
  { key: 'lcm' as const, label: 'LCM（lcm.db）', items: lcmResults.value },
  { key: 'qmd' as const, label: 'QMD（代码/文档）', items: qmdResults.value },
  { key: 'neo4j' as const, label: 'Neo4j（图谱）', items: neo4jResults.value },
]);
</script>

<template>
  <NSpace vertical :size="12">
    <!-- 引擎错误提示 -->
    <NAlert
      v-for="(err, key) in errors"
      :key="key"
      type="warning"
      :show-icon="true"
      :title="`${String(key).toUpperCase()} 引擎查询失败`"
    >
      {{ err }}
    </NAlert>

    <!-- 三引擎分组 -->
    <NCard
      v-for="g in groups"
      :key="g.key"
      :title="`${g.label}（${g.items.length} 条）`"
      size="small"
    >
      <NEmpty v-if="g.items.length === 0" size="small" description="无结果" />
      <NList v-else bordered>
        <NListItem v-for="(r, i) in g.items" :key="i">
          <NSpace vertical :size="2" style="width: 100%">
            <NSpace align="center" :size="6">
              <NTag size="small" :type="sourceColor(r.source)">{{ r.source }}</NTag>
              <NTag v-if="r.type" size="small">{{ r.type }}</NTag>
              <NText v-if="r.score !== undefined" depth="3" style="font-size: 12px">
                score: {{ r.score.toFixed?.(3) ?? r.score }}
              </NText>
              <NText v-if="r.pagerank !== undefined" depth="3" style="font-size: 12px">
                pagerank: {{ r.pagerank.toFixed?.(3) ?? r.pagerank }}
              </NText>
            </NSpace>
            <div class="cell-wrap">
              <span v-for="(seg, si) in highlight(r.content, props.query)" :key="si">
                <mark v-if="seg.hit" class="hit">{{ seg.text }}</mark>
                <template v-else>{{ seg.text }}</template>
              </span>
            </div>
            <NSpace v-if="r.file || r.sessionId" align="center" :size="6">
              <NText v-if="r.file" depth="3" class="mono" style="font-size: 12px">{{ r.file }}</NText>
              <NText v-if="r.sessionId" depth="3" class="mono" style="font-size: 12px">
                session: {{ r.sessionId }}
              </NText>
            </NSpace>
          </NSpace>
        </NListItem>
      </NList>
    </NCard>
  </NSpace>
</template>

<style scoped>
.cell-wrap {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.hit {
  background-color: #fff3a0;
  color: #333;
  padding: 0 2px;
  border-radius: 2px;
}
</style>
