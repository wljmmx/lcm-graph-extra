<script setup lang="ts">
/**
 * MemoryResultList —— 跨引擎搜索结果列表。
 *
 * - 三个 NCard 分组（lcm / qmd / neo4j），每组 NList 展示结果
 * - 每条结果展示 content（高亮匹配词）、source、score
 * - loading=true 时显示 NSkeleton 骨架占位
 * - sourceColor 按引擎区分：lcm→info / qmd→success / neo4j→warning
 * - 单引擎失败时显示 NAlert（来自 response.errors）
 */
import { computed } from 'vue';
import {
  NCard,
  NList,
  NListItem,
  NTag,
  NAlert,
  NEmpty,
  NSpace,
  NText,
  NSkeleton,
} from 'naive-ui';
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

/**
 * source → NTag 颜色：按引擎区分。
 *
 * - lcm（本地数据库）→ info（蓝）
 * - qmd（代码/文档）→ success（绿）
 * - neo4j（图谱）→ warning（橙）
 * - 其他 → default
 */
function sourceColor(s: string): 'info' | 'success' | 'warning' | 'default' {
  const key = s.toLowerCase();
  if (key === 'lcm') return 'info';
  if (key === 'qmd') return 'success';
  if (key === 'neo4j') return 'warning';
  return 'default';
}

/** 引擎分组配置 */
const groups = computed(() => [
  { key: 'lcm' as const, label: 'LCM（lcm.db）', items: lcmResults.value },
  { key: 'qmd' as const, label: 'QMD（代码/文档）', items: qmdResults.value },
  { key: 'neo4j' as const, label: 'Neo4j（图谱）', items: neo4jResults.value },
]);

// 是否显示骨架屏：仅当 loading 且尚无结果时
const showSkeleton = computed(
  () => props.loading && !props.results && groups.value.every((g) => g.items.length === 0),
);
</script>

<template>
  <NSpace vertical :size="12">
    <!-- 骨架屏占位（首次加载、无结果时） -->
    <template v-if="showSkeleton">
      <NCard v-for="i in 3" :key="i" size="small">
        <NSkeleton text :repeat="4" />
      </NCard>
    </template>

    <template v-else>
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
                <NText
                  v-if="r.score !== undefined"
                  depth="3"
                  style="font-size: var(--fs-caption)"
                >
                  score: {{ r.score.toFixed?.(3) ?? r.score }}
                </NText>
                <NText
                  v-if="r.pagerank !== undefined"
                  depth="3"
                  style="font-size: var(--fs-caption)"
                >
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
                <NText
                  v-if="r.file"
                  depth="3"
                  class="mono"
                  style="font-size: var(--fs-caption)"
                >{{ r.file }}</NText>
                <NText
                  v-if="r.sessionId"
                  depth="3"
                  class="mono"
                  style="font-size: var(--fs-caption)"
                >
                  session: {{ r.sessionId }}
                </NText>
              </NSpace>
            </NSpace>
          </NListItem>
        </NList>
      </NCard>
    </template>
  </NSpace>
</template>

<style scoped>
.cell-wrap {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
}
/* 命中高亮：用 token 色板，支持暗色模式自动适配 */
.hit {
  background-color: var(--color-bg-highlight);
  color: var(--color-text-primary);
  padding: 0 2px;
  border-radius: var(--radius-sm);
}
/* .mono 已在 tokens.css 全局定义，此处不再重复声明 */
</style>
