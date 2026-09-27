<script setup lang="ts">
/**
 * 检索质量与输出配置（v2.4.0 recall 段）。
 *
 * 数据契约：GET /api/config → GmProRuntimeConfigResult，config.recall 为 v2.4.0 新增段。
 * 展示 recall 段的 6 项能力开关与参数：
 *   点1 向量缓存（I-1，内置 LRU，始终开启，无配置项）
 *   点2 memorySliceChars（记忆切片长度，默认 800）
 *   点3 outputFormat（标准格式化输出：enabled/concise/faithful）
 *   点4 temporalWeight（时序权重，默认 0.3）
 *   点5 multiStage（多阶段检索）
 *   点6 chunking（长文本分段嵌入：enabled/chunkSize/chunkOverlap）
 *
 * 点6 参数口径校正（仅展示层告警，不改变 gm-pro 的切分算法）：
 *   chunkSize 是「字符数」而非 token；chunkOverlap 要看相对占比而非绝对值。
 *   默认 400/40 分别贴近 512 token 窗口上限、且重叠仅 10%（低于建议 15~20%）。
 *
 * 卡片内部自取数据（/api/config 与图谱健康等解耦），失败时停止轮询避免刷屏。
 */
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { NCard, NTag, NDescriptions, NDescriptionsItem } from 'naive-ui';
import CardState from './CardState.vue';
import { fetchGmProRuntimeConfig, type GmProRecallConfig } from '../../api/gm-pro';

const {
  data: cfgRes,
  isFetching: cfgFetching,
  isError: cfgIsError,
  refetch: refetchCfg,
} = useQuery({
  queryKey: ['gm-pro-runtime-config'],
  queryFn: fetchGmProRuntimeConfig,
  // 失败时停止无意义轮询，避免「一直读取中」刷屏
  refetchInterval: (query) => (query.state.data?.ok ? 120_000 : false),
  staleTime: 60_000,
  retry: 1,
});

const loading = computed(() => cfgFetching.value && !runtimeConfig.value && !cfgIsError.value);
const runtimeConfig = computed(() => (cfgRes.value?.ok ? (cfgRes.value.data ?? null) : null));
const recall = computed<GmProRecallConfig | null>(() => runtimeConfig.value?.config?.recall ?? null);

/** 未显式配置 recall 段时，graph-memory-pro 使用的内置默认值 */
const DEFAULTS = {
  memorySliceChars: 800,
  temporalWeight: 0.3,
  chunkSize: 400,
  chunkOverlap: 40,
};

/**
 * 点6 参数口径校正参数（仅用于展示层告警，不改动 gm-pro 的定长字符切分算法）。
 *
 * - Qwen3.5-Embedding-0.6B 有效窗口约 512 token；中文约 1 字符 ≈ 1~1.25 token，
 *   故 chunkSize=400 字符 ≈ 400~500 token，已贴近窗口上限（建议 ≤ 384 字符 ≈ 480 token，留 ~25% 余量）。
 * - chunkOverlap 需看相对占比：默认 40/400 = 10%，低于建议的 15~20%（同 400 字符下应约 60~80 字符）。
 */
const EMBED_WINDOW_TOKENS = 512;
/** 中文 token 上限估算：1 字符最多约 1.25 token */
const CHARS_PER_TOKEN_MAX = 1.25;
/** 窗口占用告警阈值（超过则提示贴近上限） */
const WINDOW_USAGE_WARN = 0.75;
/** 建议的重叠占比区间（相对 chunkSize） */
const RECOMMENDED_OVERLAP_RATIO: readonly [number, number] = [0.15, 0.2];

const version = computed(() => runtimeConfig.value?.version ?? '—');

/** 点2：记忆切片长度（未配置时回落到默认 800） */
const memorySliceChars = computed(() => recall.value?.memorySliceChars ?? DEFAULTS.memorySliceChars);
const memorySliceIsDefault = computed(() => recall.value?.memorySliceChars == null);

/** 点4：时序权重（未配置时回落到默认 0.3） */
const temporalWeight = computed(() => recall.value?.temporalWeight ?? DEFAULTS.temporalWeight);
const temporalIsDefault = computed(() => recall.value?.temporalWeight == null);

/** 点5：多阶段检索（默认 false） */
const multiStageEnabled = computed(() => recall.value?.multiStage === true);

/** 点3：标准格式化输出（默认 enabled=true） */
const outputFormat = computed(() => {
  const of = recall.value?.outputFormat;
  // 未配置 outputFormat 段时，v2.4.0 默认 enabled=true / concise=true / faithful=true
  const enabled = of?.enabled !== false;
  return {
    enabled,
    concise: of?.concise !== false,
    faithful: of?.faithful !== false,
    configured: of != null,
  };
});

/** 点6：长文本分段嵌入（默认 enabled=false） */
const chunking = computed(() => {
  const c = recall.value?.chunking;
  return {
    enabled: c?.enabled === true,
    chunkSize: c?.chunkSize ?? DEFAULTS.chunkSize,
    chunkOverlap: c?.chunkOverlap ?? DEFAULTS.chunkOverlap,
    configured: c != null,
  };
});

/**
 * 点6 口径提示（纯展示层）：把「字符数」换算成 token 窗口占用、把 overlap 换算成占比，
 * 对默认 400/40 这类贴近上限/占比偏低的取值给出告警。不改动 gm-pro 的切分行为。
 */
const chunkingAdvice = computed<{ text: string; warn: boolean } | null>(() => {
  const c = chunking.value;
  if (!c.enabled) return null;
  const size = c.chunkSize;
  const overlap = c.chunkOverlap;
  const parts: string[] = [];
  let warn = false;

  // 1) 窗口占用：chunkSize 是字符数，需换算为 token 才能与模型窗口比较
  if (size > 0) {
    const estTokens = Math.round(size * CHARS_PER_TOKEN_MAX);
    const usage = estTokens / EMBED_WINDOW_TOKENS;
    if (usage > WINDOW_USAGE_WARN) {
      parts.push(
        `${size} 字符 ≈ ${estTokens} token，已贴近 ${EMBED_WINDOW_TOKENS} token 窗口上限（~${Math.round(usage * 100)}%）`,
      );
      warn = true;
    }
  }

  // 2) 重叠占比：40/400 = 10%，低于建议的 15~20%
  if (size > 0) {
    const ratio = overlap / size;
    if (ratio < RECOMMENDED_OVERLAP_RATIO[0]) {
      const [lo, hi] = RECOMMENDED_OVERLAP_RATIO;
      parts.push(
        `重叠 ${overlap}/${size} ≈ ${Math.round(ratio * 100)}%，低于建议 ${Math.round(lo * 100)}~${Math.round(hi * 100)}%（≈${Math.round(size * lo)}~${Math.round(size * hi)} 字符）`,
      );
      warn = true;
    }
  }

  return parts.length ? { text: parts.join('；'), warn } : null;
});

/** recall 段是否完全未配置（全用内置默认值） */
const recallUnconfigured = computed(() => recall.value == null);

/** 整体能力摘要：开启的进阶能力数（multiStage / chunking / outputFormat 任意开启） */
const advancedCount = computed(() => {
  let n = 0;
  if (multiStageEnabled.value) n++;
  if (chunking.value.enabled) n++;
  return n;
});

function tagType(on: boolean): 'success' | 'default' {
  return on ? 'success' : 'default';
}
</script>

<template>
  <NCard size="small">
    <template #header>
      <span>检索质量配置</span>
      <NTag size="tiny" :bordered="false" type="info" style="margin-left:8px">recall · v{{ version }}</NTag>
    </template>
    <template #header-extra>
      <span class="muted" style="font-size:var(--fs-caption)">
        进阶能力 {{ advancedCount }} 项{{ recallUnconfigured ? ' · 全内置默认' : '' }}
      </span>
    </template>

    <CardState
      :loading="loading"
      :is-error="cfgIsError"
      :has-data="!!runtimeConfig"
      empty-text="暂无运行配置"
      error-text="运行配置请求失败"
      empty-hint="请确认 graph-memory-pro 服务（端口 7850）已启动。"
      @retry="refetchCfg"
    >
      <!-- recall 段不存在时给出迁移提示（v2.4.0 之前或未配置） -->
      <div v-if="recallUnconfigured" style="margin-bottom:8px">
        <NTag size="small" type="warning" :bordered="false">recall 段未配置</NTag>
        <span class="muted" style="font-size:var(--fs-caption);margin-left:6px">
          全部使用 v2.4.0 内置默认值。在 openclaw.json 的 graph-memory-pro 配置中新增 recall 段可显式调优。
        </span>
      </div>

      <NDescriptions :column="2" size="small" label-placement="left" bordered>
        <!-- 点1：向量缓存（I-1，内置 LRU，始终开启） -->
        <NDescriptionsItem label="点1 向量缓存">
          <NTag size="small" :type="tagType(true)" :bordered="false">内置开启</NTag>
          <span class="muted" style="font-size:var(--fs-caption);margin-left:4px">LRU + cosine</span>
        </NDescriptionsItem>

        <!-- 点2：记忆切片长度 -->
        <NDescriptionsItem label="点2 切片长度">
          <span class="mono">{{ memorySliceChars }}</span>
          <span class="muted" style="font-size:var(--fs-caption);margin-left:4px">
            字符{{ memorySliceIsDefault ? ' · 默认' : '' }}
          </span>
        </NDescriptionsItem>

        <!-- 点3：标准格式化输出 -->
        <NDescriptionsItem label="点3 格式化输出">
          <NTag size="small" :type="tagType(outputFormat.enabled)" :bordered="false">
            {{ outputFormat.enabled ? '开启' : '关闭' }}
          </NTag>
          <span v-if="outputFormat.enabled" class="muted" style="font-size:var(--fs-caption);margin-left:4px">
            {{ [outputFormat.concise ? '简洁' : '', outputFormat.faithful ? '贴近原文' : ''].filter(Boolean).join(' · ') }}
          </span>
        </NDescriptionsItem>

        <!-- 点4：时序权重 -->
        <NDescriptionsItem label="点4 时序权重">
          <span class="mono">{{ temporalWeight.toFixed(2) }}</span>
          <span class="muted" style="font-size:var(--fs-caption);margin-left:4px">
            {{ temporalIsDefault ? ' · 默认' : '' }}
          </span>
        </NDescriptionsItem>

        <!-- 点5：多阶段检索 -->
        <NDescriptionsItem label="点5 多阶段检索">
          <NTag size="small" :type="tagType(multiStageEnabled)" :bordered="false">
            {{ multiStageEnabled ? '开启' : '关闭' }}
          </NTag>
          <span class="muted" style="font-size:var(--fs-caption);margin-left:4px">FTS→图邻域→向量</span>
        </NDescriptionsItem>

        <!-- 点6：长文本分段嵌入 -->
        <NDescriptionsItem label="点6 分段嵌入">
          <NTag size="small" :type="tagType(chunking.enabled)" :bordered="false">
            {{ chunking.enabled ? '开启' : '关闭' }}
          </NTag>
          <span v-if="chunking.enabled" class="muted" style="font-size:var(--fs-caption);margin-left:4px">
            {{ chunking.chunkSize }}/{{ chunking.chunkOverlap }}
          </span>
          <!-- 口径提示：chunkSize 字符→token 窗口占用、chunkOverlap 相对占比（仅展示层） -->
          <div
            v-if="chunkingAdvice"
            class="advice"
            :class="chunkingAdvice.warn ? 'advice-warn' : 'muted'"
          >
            {{ chunkingAdvice.warn ? '⚠ ' : '' }}{{ chunkingAdvice.text }}
          </div>
        </NDescriptionsItem>
      </NDescriptions>

      <!-- 说明 -->
      <div class="muted" style="font-size:var(--fs-caption);margin-top:6px">
        recall 段控制检索质量与输出增强（v2.4.0 新增）。点1 为内置向量缓存无需配置；
        点2/4 未配置时使用默认值；点3 默认开启；点5/6 默认关闭，按需在 openclaw.json 开启。<br />
        点6 口径：chunkSize 为字符数（非 token），默认 400 字符 ≈ 400~500 token，贴近 512 token 窗口；
        chunkOverlap 看占比，默认 40/400 仅 10%，建议 15~20%（约 60~80 字符）。此处仅作提示，切分仍由 graph-memory-pro 执行。
      </div>
    </CardState>
  </NCard>
</template>

<style scoped>
.mono { font-family: var(--font-mono, ui-monospace, monospace); }
.advice { font-size: var(--fs-caption); margin-top: 2px; line-height: 1.4; }
.advice-warn { color: var(--n-warning-color, #f0a020); }
</style>
