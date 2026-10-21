<script setup lang="ts">
/**
 * Harnessing 演进视图（Harness² 吸收：Propose–Probe–Compose 回路可视化）。
 *
 * 数据源：GET /api/harnessing/summary
 *   - live：插件内存态（信号池 + 最近自动观察步）——"现在正在观察什么"
 *   - history：Neo4j 带证据链的经验（adopt 沉淀）——"已经演进过什么"
 *   - stats：按作用域 / 组件聚合
 *
 * 说明：自动观察步为 observe-only，本页只读；写入需在 agent 侧显式调用
 * lcmg_harness_step mode=apply。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  NCard,
  NSpace,
  NButton,
  NTag,
  NTable,
  NAlert,
  NStatistic,
  NGrid,
  NGi,
  NEmpty,
  NSpin,
} from 'naive-ui';
import { fetchHarnessingSummary, type HarnessingSummary } from '../api/harnessing';

const loading = ref(false);
const data = ref<HarnessingSummary | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

async function refresh() {
  loading.value = !data.value;
  try {
    data.value = await fetchHarnessingSummary();
  } catch {
    /* 保持上次数据，错误由 liveError/historyError 展示 */
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  refresh();
  timer = setInterval(refresh, 30_000);
});
onBeforeUnmount(() => { if (timer) clearInterval(timer); });

// ===== live 派生 =====
const live = computed(() => data.value?.live ?? null);
const lastStep = computed(() => live.value?.lastAutoStep ?? null);
const lastStepAgo = computed(() => {
  if (!lastStep.value?.ts) return '';
  const min = Math.round((Date.now() - lastStep.value.ts) / 60_000);
  return min >= 60 ? `${Math.round(min / 60)} 小时前` : `${min} 分钟前`;
});
const signalKinds = computed(() => {
  const byKind = live.value?.signals?.byKind ?? {};
  return Object.entries(byKind).map(([k, v]) => ({ kind: k, count: v }));
});
const signalSources = computed(() => {
  const bySource = live.value?.signals?.bySource ?? {};
  return Object.entries(bySource).sort((a, b) => b[1] - a[1]).slice(0, 8);
});

// ===== history 派生 =====
const history = computed(() => data.value?.history ?? []);
function fmtTime(ts: number | null): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString();
}
function fmtPct(v: number | undefined): string {
  return typeof v === 'number' ? `${Math.round(v * 100)}%` : '-';
}
function fmtContrast(v: number | undefined): string {
  if (typeof v !== 'number') return '-';
  const pct = Math.round(v * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}
</script>

<template>
  <div class="harnessing-view">
    <NSpace vertical :size="16">
      <NAlert type="info" :bordered="false">
        Harnessing 自动观察回路：工具失败信号自动收集 → 每 ~6h 一次 Propose–Probe–Compose 观察步（只读）。
        采纳项需在 agent 侧显式调用 <code>lcmg_harness_step mode="apply"</code> 才写入经验库。
      </NAlert>

      <!-- live：插件内存态 -->
      <NCard title="实时观察状态" size="small">
        <NSpin :show="loading">
          <template v-if="live">
            <NGrid :cols="4" :x-gap="12" responsive="screen" item-responsive>
              <NGi span="1">
                <NStatistic label="总开关" size="small">
                  <NTag :type="live.enabled === false ? 'error' : 'success'" size="small">
                    {{ live.enabled === false ? 'off' : 'enabled' }}
                  </NTag>
                </NStatistic>
              </NGi>
              <NGi span="1">
                <NStatistic label="自动观察步" size="small">
                  <NTag :type="live.autoEnabled === false ? 'warning' : 'success'" size="small">
                    {{ live.autoEnabled === false ? 'off' : '~6h observe' }}
                  </NTag>
                </NStatistic>
              </NGi>
              <NGi span="1">
                <NStatistic label="信号池" size="small">
                  {{ live.signals?.count ?? 0 }} 条 / {{ live.signals?.totalOccurrences ?? 0 }} 次
                </NStatistic>
              </NGi>
              <NGi span="1">
                <NStatistic label="最近自动步" size="small">
                  <template v-if="lastStep">
                    {{ lastStepAgo }} ·
                    <NTag :type="lastStep.ran ? 'success' : 'default'" size="small">
                      {{ lastStep.ran ? `ran (adopt ${lastStep.adopted ?? 0})` : `skipped: ${lastStep.skipped ?? '?'}` }}
                    </NTag>
                  </template>
                  <template v-else>未运行</template>
                </NStatistic>
              </NGi>
            </NGrid>

            <NSpace vertical :size="4" style="margin-top: 12px" v-if="(signalKinds.length || signalSources.length)">
              <div v-if="signalKinds.length" class="signal-line">
                失败分类：<NTag v-for="k in signalKinds" :key="k.kind" size="small" style="margin-right: 6px">{{ k.kind }} × {{ k.count }}</NTag>
              </div>
              <div v-if="signalSources.length" class="signal-line">
                失败来源 Top8：<NTag v-for="[src, cnt] in signalSources" :key="src" size="small" type="warning" style="margin-right: 6px">{{ src }} × {{ cnt }}</NTag>
              </div>
            </NSpace>
          </template>
          <NAlert v-else-if="data?.liveError" type="warning" :bordered="false">
            插件实时态不可达：{{ data.liveError }}（历史数据不受影响）
          </NAlert>
          <NEmpty v-else description="等待数据..." />
        </NSpin>
      </NCard>

      <!-- stats -->
      <NCard title="演进统计（已采纳沉淀）" size="small">
        <NGrid :cols="3" :x-gap="12" responsive="screen" item-responsive>
          <NGi span="1">
            <NStatistic label="经验总数" size="small">{{ data?.stats.total ?? 0 }}</NStatistic>
          </NGi>
          <NGi span="1">
            <NStatistic label="按作用域" size="small">
              <NTag v-for="(v, k) in (data?.stats.byScope ?? {})" :key="k" size="small" style="margin-right: 6px">{{ k }} × {{ v }}</NTag>
              <span v-if="!(data?.stats.total)">-</span>
            </NStatistic>
          </NGi>
          <NGi span="1">
            <NStatistic label="按组件" size="small">
              <NTag v-for="(v, k) in (data?.stats.byComponent ?? {})" :key="k" size="small" style="margin-right: 6px">{{ k }} × {{ v }}</NTag>
              <span v-if="!(data?.stats.total)">-</span>
            </NStatistic>
          </NGi>
        </NGrid>
      </NCard>

      <!-- history 表 -->
      <NCard title="演进历史（带证据链的经验）" size="small">
        <template #header-extra>
          <NSpace>
            <NTag size="small">observe-only 视图</NTag>
            <NButton size="tiny" @click="refresh" :loading="loading">刷新</NButton>
          </NSpace>
        </template>
        <NAlert v-if="data?.historyError" type="warning" :bordered="false" style="margin-bottom: 8px">
          历史查询失败：{{ data.historyError }}
        </NAlert>
        <NEmpty v-if="!history.length" description="暂无采纳沉淀 —— 观察步的采纳项经 mode=apply 写入后在此展示" />
        <NTable v-else size="small" :single-line="false">
          <thead>
            <tr>
              <th style="width: 26%">标题</th>
              <th style="width: 8%">作用域</th>
              <th style="width: 12%">组件</th>
              <th style="width: 16%">探针对比</th>
              <th style="width: 12%">采纳时间</th>
              <th>摘要</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in history" :key="item.id">
              <td>{{ item.title }}</td>
              <td>
                <NTag size="small" :type="item.scope === 'domain' ? 'warning' : 'info'">{{ item.scope }}</NTag>
              </td>
              <td>{{ item.component }}</td>
              <td>
                {{ fmtPct(item.evidence.baseline) }} → {{ fmtPct(item.evidence.candidate) }}
                （<span :style="{ color: (item.evidence.contrast ?? 0) >= 0 ? '#18a058' : '#d03050' }">{{ fmtContrast(item.evidence.contrast) }}</span>）
              </td>
              <td>{{ item.evidence.adoptedAt ? new Date(item.evidence.adoptedAt).toLocaleString() : fmtTime(item.createdAt) }}</td>
              <td class="summary-cell">{{ item.summary }}</td>
            </tr>
          </tbody>
        </NTable>
      </NCard>
    </NSpace>
  </div>
</template>

<style scoped>
.harnessing-view {
  padding: 16px;
}
.signal-line {
  font-size: 12px;
  color: var(--n-text-color-2, #666);
}
.summary-cell {
  max-width: 420px;
  white-space: normal;
  word-break: break-all;
  font-size: 12px;
  color: var(--n-text-color-2, #666);
}
</style>
