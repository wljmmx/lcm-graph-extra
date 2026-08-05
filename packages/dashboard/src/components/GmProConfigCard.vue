<script setup lang="ts">
/**
 * Graph Memory Pro 配置卡片（v2.1.13）：按 /api/gm-pro/config/schema 动态渲染全字段表单。
 *
 * 从后端 schema 文档获取可更新字段列表，按分组渲染表单，
 * 用户修改后通过 PATCH /api/gm-pro/config 批量提交。
 */
import { computed, reactive, watch } from 'vue';
import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import {
  NCard, NForm, NFormItem, NInputNumber, NInput,
  NButton, NSpace, NAlert, NDivider, NTag, useMessage,
} from 'naive-ui';
import { fetchGmProConfig, fetchGmProConfigSchema, updateGmProConfig } from '../api/config';
import type { SchemaFieldDoc } from '../api/config';

const message = useMessage();
const queryClient = useQueryClient();

// ===== Schema 读取 =====
const { data: schemaData } = useQuery({
  queryKey: ['gm-pro-config-schema'],
  queryFn: fetchGmProConfigSchema,
  staleTime: 300_000,
});

const { data: configData, isLoading } = useQuery({
  queryKey: ['gm-pro-config-runtime'],
  queryFn: fetchGmProConfig,
});

// ===== 按分组归类字段 =====
interface FieldGroup {
  name: string;
  label: string;
  fields: SchemaFieldDoc[];
}

const fieldGroups = computed<FieldGroup[]>(() => {
  const fields = schemaData.value?.fields ?? [];
  const groupMap = new Map<string, SchemaFieldDoc[]>();

  for (const f of fields) {
    const groupKey = f.path.includes('.') ? f.path.split('.')[0] : 'general';
    if (!groupMap.has(groupKey)) groupMap.set(groupKey, []);
    groupMap.get(groupKey)!.push(f);
  }

  const groupLabels: Record<string, string> = {
    general: '图谱检索',
    embedding: 'Embedding',
    llm: 'LLM',
  };

  return Array.from(groupMap.entries()).map(([name, fields]) => ({
    name,
    label: groupLabels[name] ?? name,
    fields,
  }));
});

// ===== 本地编辑态 =====
const editValues = reactive<Record<string, unknown>>({});

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

// 同时监听 configData 和 schemaData，确保两者都加载后才填充编辑值
watch([configData, schemaData], ([configVal, schemaVal]) => {
  if (configVal?.config && schemaVal?.fields) {
    const cfg = configVal.config as Record<string, unknown>;
    for (const f of schemaVal.fields) {
      editValues[f.path] = getByPath(cfg, f.path) ?? f.defaultValue;
    }
  }
}, { immediate: true });

// ===== 配置写入 =====
const configMutation = useMutation({
  mutationFn: (updates: Record<string, unknown>) => updateGmProConfig(updates),
  onSuccess: (data) => {
    if (data.ok) {
      const appliedCount = data.applied?.length ?? 0;
      const rejectedCount = data.rejected?.length ?? 0;
      if (appliedCount > 0 && rejectedCount === 0) {
        message.success(`已更新 ${appliedCount} 项配置`);
      } else if (appliedCount > 0 && rejectedCount > 0) {
        message.warning(`已更新 ${appliedCount} 项，${rejectedCount} 项被拒绝`);
      } else if (rejectedCount > 0) {
        message.error(`${rejectedCount} 项配置更新被拒绝`);
      } else {
        message.info('没有需要更新的配置');
      }
      void queryClient.invalidateQueries({ queryKey: ['gm-pro-config-runtime'] });
    } else {
      message.error(data.error ?? '保存失败');
    }
  },
  onError: (err: Error) => {
    message.error(err.message);
  },
});

function saveConfig(): void {
  const updates: Record<string, unknown> = {};
  const fields = schemaData.value?.fields ?? [];
  for (const f of fields) {
    if (f.updatable && editValues[f.path] !== undefined) {
      updates[f.path] = editValues[f.path];
    }
  }
  configMutation.mutate(updates);
}
</script>

<template>
  <NCard title="Graph Memory Pro 配置" size="small">
    <template #header-extra>
      <NSpace align="center" :size="8">
        <NTag v-if="isLoading" size="small" type="info">加载中…</NTag>
        <NButton
          type="primary"
          size="small"
          :loading="configMutation.isPending.value"
          @click="saveConfig"
        >
          保存配置
        </NButton>
      </NSpace>
    </template>

    <NAlert v-if="configData && !configData.ok" type="error" style="margin-bottom: 12px">
      {{ configData.error ?? '配置读取失败' }}
    </NAlert>

    <NAlert
      v-if="configData && configData.ok && !configData.configExists"
      type="warning"
      style="margin-bottom: 12px"
    >
      openclaw.json 尚未配置 graph-memory-pro 插件，保存后将自动创建配置段。
    </NAlert>

    <NSpace vertical :size="16">
      <div v-for="group in fieldGroups" :key="group.name">
        <NDivider v-if="fieldGroups.length > 1" title-placement="left" style="margin: 0 0 8px">
          {{ group.label }}
        </NDivider>
        <NForm label-placement="left" label-width="180" size="small">
          <NFormItem
            v-for="field in group.fields"
            :key="field.path"
            :label="field.description"
          >
            <!-- number → NInputNumber -->
            <NInputNumber
              v-if="field.type === 'number'"
              size="small"
              style="width: 160px"
              :value="editValues[field.path] as number"
              @update:value="(v: number | null) => { editValues[field.path] = v ?? 0; }"
            />
            <!-- string → NInput -->
            <NInput
              v-else
              size="small"
              style="width: 260px"
              :value="String(editValues[field.path] ?? '')"
              @update:value="(v: string) => { editValues[field.path] = v; }"
            />
            <template #feedback>
              <span style="font-size: 11px; color: var(--color-text-tertiary)">
                {{ field.path }} · 默认: {{ String(field.defaultValue ?? '—') }}
              </span>
            </template>
          </NFormItem>
        </NForm>
      </div>
    </NSpace>
  </NCard>
</template>