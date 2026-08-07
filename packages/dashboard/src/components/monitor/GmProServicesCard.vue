<script setup lang="ts">
import { NCard, NTag, NEmpty } from 'naive-ui';
import type { GmProServiceStatus } from '../../api/gm-pro';

defineProps<{
  services: GmProServiceStatus | null;
}>();

function statusTagType(status: string): 'success' | 'error' | 'warning' {
  if (status === 'connected' || status === 'running' || status === 'ok' || status === 'configured' || status === 'initialized') return 'success';
  if (status === 'disconnected' || status === 'not-initialized' || status === 'error') return 'error';
  return 'warning';
}
</script>

<template>
  <NCard title="gm-pro 服务状态" size="small">
    <template v-if="services">
      <div class="svc-header-row">
        <NTag type="info" size="small">v{{ services.version }}</NTag>
        <span class="muted" style="font-size:var(--fs-caption)">
          {{ services.timestamp ? String(services.timestamp).slice(0, 19).replace('T', ' ') : '—' }}
        </span>
      </div>
      <table class="svc-table" v-if="(services.services ?? []).length">
        <thead>
          <tr>
            <th>服务</th>
            <th>状态</th>
            <th>详情</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="svc in (services.services ?? [])" :key="svc.name">
            <td class="mono svc-name">{{ svc.name }}</td>
            <td>
              <NTag size="tiny" :type="statusTagType(svc.status)">
                {{ svc.status }}
              </NTag>
            </td>
            <td class="svc-detail">
              <template v-if="svc.detail">
                <span v-if="typeof svc.detail === 'object' && !Array.isArray(svc.detail)">
                  <span v-for="(v, k) in (svc.detail as Record<string, unknown>)" :key="k" class="svc-detail-kv">
                    <span class="muted">{{ k }}:</span> {{ typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v).slice(0, 80) }}
                  </span>
                </span>
                <span v-else class="muted">{{ String(svc.detail).slice(0, 120) }}</span>
              </template>
              <span v-else class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
      <NEmpty v-else description="服务列表为空" style="padding:8px 0" />
    </template>
    <NEmpty v-else description="gm-pro 服务不可达" style="padding:12px 0">
      <template #extra>
        <span class="muted" style="font-size:var(--fs-caption)">请确认 graph-memory-pro HTTP 服务 (端口 7850) 已启动且 GM_PRO_AUTH_TOKEN 配置正确。</span>
      </template>
    </NEmpty>
  </NCard>
</template>

<style scoped>
.svc-header-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.svc-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-caption);
}
.svc-table th {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-tertiary);
  font-weight: 500;
  white-space: nowrap;
}
.svc-table td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--color-border-subtle);
  vertical-align: middle;
}
.svc-name {
  font-weight: 500;
  min-width: 90px;
}
.svc-detail {
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.svc-detail-kv {
  display: inline-block;
  margin-right: 12px;
  font-size: var(--fs-caption);
}
</style>