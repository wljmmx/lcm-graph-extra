<script setup lang="ts">
/**
 * 能力档次切换组件（v1.1.0-5）。
 *
 * 功能：
 * - 显示当前能力档次（minimal/balanced/performance/full）
 * - 列出所有可选档次，含描述和预估开销
 * - 一键切换（二次确认）
 * - 切换成功后刷新状态
 *
 * 数据流：
 *   GET /api/capability-profile → 展示
 *   POST /api/capability-profile { id } → 切换
 */
import { ref, onMounted } from 'vue';
import { NCard, NSpace, NTag, NButton, NModal, useMessage } from 'naive-ui';
import { fetchCapabilityProfile, switchCapabilityProfile, type CapabilityProfile } from '../api/config';

const message = useMessage();

const loading = ref(false);
const switching = ref(false);
const current = ref<CapabilityProfile | null>(null);
const profiles = ref<CapabilityProfile[]>([]);
const errorMsg = ref('');
const confirmModal = ref(false);
const pendingId = ref('');

async function loadProfile() {
  loading.value = true;
  errorMsg.value = '';
  try {
    const resp = await fetchCapabilityProfile();
    if (resp.ok) {
      current.value = resp.current ?? null;
      profiles.value = resp.profiles ?? [];
    } else {
      errorMsg.value = resp.error ?? '加载失败';
    }
  } catch (e: any) {
    errorMsg.value = e?.message ?? String(e);
  } finally {
    loading.value = false;
  }
}

function requestSwitch(id: string) {
  pendingId.value = id;
  confirmModal.value = true;
}

async function doSwitch() {
  confirmModal.value = false;
  if (!pendingId.value) return;
  switching.value = true;
  try {
    const resp = await switchCapabilityProfile(pendingId.value);
    if (resp.ok && resp.current) {
      current.value = resp.current;
      message.success(`已切换到「${resp.current.label}」档次`);
    } else {
      message.error(resp.error ?? '切换失败');
    }
  } catch (e: any) {
    message.error(e?.message ?? String(e));
  } finally {
    switching.value = false;
    pendingId.value = '';
  }
}

function overheadColor(overhead: number): 'success' | 'info' | 'warning' | 'error' {
  if (overhead <= 3) return 'success';
  if (overhead <= 5) return 'info';
  if (overhead <= 8) return 'warning';
  return 'error';
}

onMounted(loadProfile);
</script>

<template>
  <NCard title="能力档次切换" size="small" :bordered="true">
    <template #header-extra>
      <NButton size="tiny" quaternary :loading="loading" @click="loadProfile">刷新</NButton>
    </template>

    <div v-if="errorMsg" class="cap-error">
      ⚠ {{ errorMsg }}
    </div>

    <div v-if="current" class="cap-current">
      <span class="cap-label">当前档次：</span>
      <NTag type="success" size="medium">{{ current.label }}</NTag>
      <NTag :type="overheadColor(current.estimatedOverhead)" size="small" style="margin-left: 8px">
        开销 {{ current.estimatedOverhead }}/10
      </NTag>
    </div>

    <div class="cap-desc">{{ current?.description }}</div>

    <NSpace v-if="profiles.length > 0" vertical :size="8" style="margin-top: 12px">
      <div
        v-for="p in profiles"
        :key="p.id"
        class="cap-profile-row"
        :class="{ active: p.id === current?.id }"
      >
        <div class="cap-profile-info">
          <span class="cap-profile-label">{{ p.label }}</span>
          <NTag :type="overheadColor(p.estimatedOverhead)" size="tiny">
            {{ p.estimatedOverhead }}/10
          </NTag>
          <NTag v-if="p.apiCount !== undefined" size="tiny" type="info">
            {{ p.apiCount }} APIs
          </NTag>
        </div>
        <div class="cap-profile-desc">{{ p.description }}</div>
        <NButton
          v-if="p.id !== current?.id"
          size="tiny"
          type="primary"
          :loading="switching"
          @click="requestSwitch(p.id)"
        >
          切换
        </NButton>
        <NTag v-else type="success" size="tiny">已启用</NTag>
      </div>
    </NSpace>

    <NModal
      v-model:show="confirmModal"
      preset="confirm"
      title="确认切换能力档次"
      content="切换能力档次将立即生效，可能影响检索性能和资源占用。确认继续？"
      positive-text="确认切换"
      negative-text="取消"
      @positive-click="doSwitch"
    />
  </NCard>
</template>

<style scoped>
.cap-error {
  color: var(--color-danger);
  padding: var(--space-sm) 0;
  font-size: var(--fs-label);
}
.cap-current {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  margin-bottom: var(--space-xs);
}
.cap-label {
  font-weight: 600;
  font-size: var(--fs-body);
}
.cap-desc {
  color: var(--color-text-secondary);
  font-size: var(--fs-label);
  margin: var(--space-xs) 0 var(--space-sm);
}
.cap-profile-row {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  padding: var(--space-sm) var(--space-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  transition: border-color var(--motion-base);
}
.cap-profile-row.active {
  border-color: var(--color-success);
  background: color-mix(in srgb, var(--color-success) 5%, transparent);
}
.cap-profile-info {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  min-width: 160px;
}
.cap-profile-label {
  font-weight: 500;
  font-size: var(--fs-body);
}
.cap-profile-desc {
  flex: 1;
  color: var(--color-text-tertiary);
  font-size: var(--fs-caption);
}
</style>
