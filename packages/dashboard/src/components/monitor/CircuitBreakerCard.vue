<script setup lang="ts">
import { ref } from 'vue';
import { NCard, NTag, NEmpty, NSpace, NButton, NPopconfirm, useMessage } from 'naive-ui';
import StatusIndicator from '../StatusIndicator.vue';
import { invokeResetBreaker } from '../../api/maintain';
import type { HealthSnapshot } from '../../api/health';

defineProps<{
  db: HealthSnapshot | null;
}>();

const emit = defineEmits<{
  reset: [name: string];
}>();

const message = useMessage();
const resetting = ref<string | null>(null);

async function handleReset(name: string): Promise<void> {
  if (resetting.value) return;
  resetting.value = name;
  try {
    const res = await invokeResetBreaker(name);
    if (res.success) {
      message.success(`熔断器 ${name.toUpperCase()} 已重置`);
      emit('reset', name);
    } else {
      message.error(`重置失败: ${res.error || '未知错误'}`);
    }
  } catch (err: any) {
    message.error(`重置失败: ${err?.message || String(err)}`);
  } finally {
    resetting.value = null;
  }
}
</script>

<template>
  <NCard title="熔断状态" size="small">
    <template v-if="db">
      <NSpace vertical :size="8">
        <div class="cb-row">
          <StatusIndicator label="LCM" :available="db.cbLcmAvailable" :failures="db.cbLcmFailures" />
          <NPopconfirm @positive-click="handleReset('lcm')">
            <template #trigger>
              <NButton
                size="tiny"
                :type="db.cbLcmAvailable ? 'default' : 'warning'"
                :loading="resetting === 'lcm'"
                :disabled="resetting !== null && resetting !== 'lcm'"
              >
                重置
              </NButton>
            </template>
            确定要重置 LCM 熔断器吗？这将清零失败计数并关闭熔断状态。
          </NPopconfirm>
        </div>
        <div class="cb-row">
          <StatusIndicator label="QMD" :available="db.cbQmdAvailable" :failures="db.cbQmdFailures" />
          <NPopconfirm @positive-click="handleReset('qmd')">
            <template #trigger>
              <NButton
                size="tiny"
                :type="db.cbQmdAvailable ? 'default' : 'warning'"
                :loading="resetting === 'qmd'"
                :disabled="resetting !== null && resetting !== 'qmd'"
              >
                重置
              </NButton>
            </template>
            确定要重置 QMD 熔断器吗？这将清零失败计数并关闭熔断状态。
          </NPopconfirm>
        </div>
        <div class="cb-row">
          <StatusIndicator label="Neo4j" :available="db.cbNeo4jAvailable" :failures="db.cbNeo4jFailures" />
          <NPopconfirm @positive-click="handleReset('neo4j')">
            <template #trigger>
              <NButton
                size="tiny"
                :type="db.cbNeo4jAvailable ? 'default' : 'warning'"
                :loading="resetting === 'neo4j'"
                :disabled="resetting !== null && resetting !== 'neo4j'"
              >
                重置
              </NButton>
            </template>
            确定要重置 Neo4j 熔断器吗？这将清零失败计数并关闭熔断状态。
          </NPopconfirm>
        </div>
      </NSpace>
    </template>
    <NEmpty v-else description="无历史数据" style="padding: 12px 0" />
  </NCard>
</template>

<style scoped>
.cb-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}
</style>