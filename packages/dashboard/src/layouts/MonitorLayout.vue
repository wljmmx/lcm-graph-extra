<script setup lang="ts">
/**
 * MonitorLayout：监控子路由布局外壳。
 *
 * 顶部固定一条全局健康横幅，始终展示 4 个关键信号灯：
 *   gm-pro 服务 / 图谱健康 / 智能引擎 / 熔断状态
 * 异常时 Tag 飘红 + 点击直达对应子页面。
 */
import { computed, h } from 'vue';
import { RouterView, useRouter } from 'vue-router';
import {
  NTag,
  NSpace,
} from 'naive-ui';
import { useMonitorData } from '../composables/useMonitorData';

const router = useRouter();
const { db, graphHealth, gmProServices, gmProDoctor, gmProTuner, refreshStatus } = useMonitorData();

// ── 全局健康信号灯 ──
interface HealthSignal {
  key: string;
  label: string;
  type: 'success' | 'warning' | 'error' | 'default';
  text: string;
  route: string;
}

const healthSignals = computed<HealthSignal[]>(() => {
  const signals: HealthSignal[] = [];

  // 1. gm-pro 服务状态
  const svcOk = gmProServices.value && (gmProServices.value.services ?? []).length > 0;
  signals.push({
    key: 'gm-pro',
    label: 'gm-pro',
    type: svcOk ? 'success' : 'error',
    text: svcOk ? '运行中' : '不可达',
    route: '/monitor/services',
  });

  // 2. 图谱健康
  const gh = graphHealth.value;
  const ghOk = gh?.status === 'healthy';
  signals.push({
    key: 'graph',
    label: '图谱',
    type: ghOk ? 'success' : gh?.status === 'degraded' ? 'warning' : 'error',
    text: gh?.status ?? '未知',
    route: '/monitor/graph',
  });

  // 3. 智能引擎
  const tunerOk = gmProTuner.value?.enabled;
  const doctorOk = gmProDoctor.value && (gmProDoctor.value as any).neo4j?.ok;
  signals.push({
    key: 'ai',
    label: 'AI引擎',
    type: tunerOk || doctorOk ? 'success' : 'warning',
    text: tunerOk ? '调优中' : doctorOk ? '诊断OK' : '待检查',
    route: '/monitor/ai',
  });

  // 4. 熔断状态
  const d = db.value;
  const cbAllOk = d ? (d.cbLcmAvailable && d.cbQmdAvailable && d.cbNeo4jAvailable) : null;
  const cbFailures = d ? (d.cbLcmFailures + d.cbQmdFailures + d.cbNeo4jFailures) : 0;
  signals.push({
    key: 'breaker',
    label: '熔断器',
    type: cbAllOk === null ? 'default' : cbAllOk ? 'success' : cbFailures > 0 ? 'error' : 'warning',
    text: cbAllOk === null ? '—' : cbAllOk ? '全部正常' : `${cbFailures} 次失败`,
    route: '/monitor/services',
  });

  return signals;
});

function goTo(route: string) {
  router.push(route);
}
</script>

<template>
  <div class="monitor-layout">
    <!-- 全局健康横幅 -->
    <div class="health-banner">
      <NSpace align="center" :size="12">
        <span class="health-banner-title">系统状态</span>
        <NSpace :size="6">
          <NTag
            v-for="sig in healthSignals"
            :key="sig.key"
            :type="sig.type"
            size="small"
            :bordered="false"
            class="health-signal"
            style="cursor: pointer"
            @click="goTo(sig.route)"
          >
            {{ sig.label }}: {{ sig.text }}
          </NTag>
        </NSpace>
        <span style="flex: 1" />
        <NTag :type="refreshStatus.type" size="small" :bordered="false">
          {{ refreshStatus.label }}
        </NTag>
      </NSpace>
    </div>

    <!-- 子路由内容区 -->
    <div class="monitor-content">
      <RouterView />
    </div>
  </div>
</template>

<style scoped>
.monitor-layout {
  width: 100%;
}

.health-banner {
  padding: 8px 16px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  margin-bottom: 12px;
}

.health-banner-title {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.health-signal {
  transition: opacity 0.2s;
}
.health-signal:hover {
  opacity: 0.8;
}

.monitor-content {
  width: 100%;
}
</style>