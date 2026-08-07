<script setup lang="ts">
/**
 * 通用配置卡片（P1-1）：按 /api/config/schema 动态渲染全字段表单。
 *
 * 从后端 schema 文档获取可更新字段列表，按分组渲染表单，
 * 用户修改后通过 PATCH /api/config 批量提交。
 *
 * v2025.6 增强：
 * - 支持枚举字段（summaryStrategy/cliFallbackSearchType/logging.level/llmProvider…）→ NSelect 下拉
 * - 支持敏感字段（apiKey/password/token）→ NInput password 掩码
 * - 支持 0-1 比例/阈值字段 → NInputNumber 自动加 min/max
 * - 分组标签扩展：llmProvider/distillationLlm/embedding/webhook/moa/logging/stubLargeToolPayloads/backupConfig/llmTimeouts/neo4j
 */
import { computed, reactive, watch } from 'vue';
import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import {
  NCard, NForm, NFormItem, NInputNumber, NSwitch, NInput, NSelect,
  NButton, NSpace, NAlert, NDivider, NTag, useMessage,
} from 'naive-ui';
import { fetchConfig, fetchConfigSchema, updateConfig } from '../api/config';
import type { SchemaFieldDoc } from '../api/config';

const message = useMessage();
const queryClient = useQueryClient();

// ===== Schema 读取 =====
const { data: schemaData } = useQuery({
  queryKey: ['config-schema'],
  queryFn: fetchConfigSchema,
  staleTime: 300_000,
});

const { data: configData, isLoading } = useQuery({
  queryKey: ['config-runtime'],
  queryFn: fetchConfig,
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
    general: '通用',
    compaction: '上下文压缩 (Compaction)',
    experience: '经验提取 (Experience)',
    ttl: 'TTL 清理',
    retrieval: '双引擎检索 (Retrieval)',
    lcmMonitor: '上下文监控 (LCM Monitor)',
    llmTimeouts: 'LLM 调用超时',
    backupConfig: '自动备份',
    stubLargeToolPayloads: '大工具负载分片',
    webhook: 'Webhook 回调',
    logging: '日志',
    llmProvider: '主 LLM Provider',
    distillationLlm: '蒸馏 LLM',
    embedding: 'Embedding 模型',
    dashboardSnapshot: '能力档次服务',
    moa: 'MoA 多模型协作',
    neo4j: 'Neo4j 连接（只读）',
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
// 优先使用 schema 默认值填充，config 加载后覆盖实际值
watch([configData, schemaData], ([configVal, schemaVal]) => {
  if (schemaVal?.fields) {
    const cfg = (configVal?.config as Record<string, unknown>) ?? {};
    for (const f of schemaVal.fields) {
      editValues[f.path] = getByPath(cfg, f.path) ?? f.defaultValue;
    }
  }
}, { immediate: true });

// ===== 配置写入 =====
const configMutation = useMutation({
  mutationFn: (updates: Record<string, unknown>) => updateConfig(updates),
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
      void queryClient.invalidateQueries({ queryKey: ['config-runtime'] });
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

// ===== 字段渲染辅助（与 GmPro 卡片保持一致） =====

/** 从 description 中解析枚举选项（如 "策略：strategy | hybrid | full"） */
function parseEnumOptions(field: SchemaFieldDoc): string[] | null {
  // 匹配 "：a | b | c" 或 ": a | b | c" 结尾/中间的模式
  const match = field.description.match(/[：:]\s*([^：:|]+(?:\s*\|\s*[^：:|]+)+)/);
  if (match) {
    return match[1].split('|').map(s => s.trim()).filter(Boolean);
  }
  return null;
}

/** 判断字段是否为敏感信息（API Key / password / token 等） */
function isSensitiveField(field: SchemaFieldDoc): boolean {
  const lower = field.path.toLowerCase();
  return lower.endsWith('apikey') || lower.endsWith('authtoken') || lower.includes('password') ||
    field.description.toLowerCase().includes('密钥') || field.description.toLowerCase().includes('token');
}

/** 是否只读字段（updatable=false，展示为 disabled 输入框） */
function isReadonly(field: SchemaFieldDoc): boolean {
  return !field.updatable;
}

/** 获取数字字段的最小值 */
function getMin(field: SchemaFieldDoc): number | undefined {
  if (field.description.includes('0-1') || field.description.includes('（0-1）')) return 0;
  if (field.description.includes('阈值') || field.description.includes('占比') || field.description.includes('比例')) return 0;
  return undefined;
}

/** 获取数字字段的最大值 */
function getMax(field: SchemaFieldDoc): number | undefined {
  if (field.description.includes('0-1') || field.description.includes('（0-1）')) return 1;
  if (field.description.includes('占比') || field.description.includes('比例')) return 1;
  return undefined;
}
</script>

<template>
  <NCard title="通用配置" size="small">
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

    <NSpace vertical :size="16">
      <div v-for="group in fieldGroups" :key="group.name">
        <NDivider v-if="fieldGroups.length > 1" title-placement="left" style="margin: 0 0 8px">
          {{ group.label }}
        </NDivider>
        <NForm label-placement="left" label-width="220" size="small">
          <NFormItem
            v-for="field in group.fields"
            :key="field.path"
            :label="field.description"
          >
            <!-- 只读字段：禁用样式的 NInput，提示「只读」 -->
            <template v-if="isReadonly(field)">
              <NInput
                size="small"
                style="width: 260px"
                :value="String(editValues[field.path] ?? '')"
                disabled
                clearable
              />
              <template #feedback>
                <span style="font-size: 11px; color: var(--color-text-tertiary)">
                  {{ field.path }} · 只读 · 默认: {{ String(field.defaultValue ?? '—') }}
                </span>
              </template>
            </template>

            <!-- boolean → NSwitch -->
            <NSwitch
              v-else-if="field.type === 'boolean'"
              size="small"
              :value="editValues[field.path] as boolean"
              @update:value="(v: boolean) => { editValues[field.path] = v; }"
            />

            <!-- enum string → NSelect -->
            <NSelect
              v-else-if="field.type === 'string' && parseEnumOptions(field)"
              size="small"
              style="width: 320px"
              :value="String(editValues[field.path] ?? '')"
              :options="parseEnumOptions(field)!.map(opt => ({ label: opt, value: opt }))"
              @update:value="(v: string) => { editValues[field.path] = v; }"
            />

            <!-- sensitive string → NInput password + show-password-on="click" -->
            <NInput
              v-else-if="field.type === 'string' && isSensitiveField(field)"
              size="small"
              style="width: 280px"
              type="password"
              show-password-on="click"
              placeholder="已配置（脱敏显示，留空不修改）"
              :value="String(editValues[field.path] ?? '')"
              @update:value="(v: string) => { editValues[field.path] = v; }"
            />

            <!-- number → NInputNumber 带 min/max -->
            <NInputNumber
              v-else-if="field.type === 'number'"
              size="small"
              style="width: 180px"
              :min="getMin(field)"
              :max="getMax(field)"
              :value="editValues[field.path] as number"
              @update:value="(v: number | null) => { editValues[field.path] = v ?? 0; }"
            />

            <!-- plain string → NInput -->
            <NInput
              v-else
              size="small"
              style="width: 320px"
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
