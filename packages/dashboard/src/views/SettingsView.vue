<script setup lang="ts">
/**
 * 设置页（模块 6）：MOA 多模型协作 + 模型配置。
 *
 * 布局：
 *   顶部标题 + MOA 总开关 + 参数配置卡片 + 参考模型列表 + 聚合模型配置
 *
 * 状态管理：
 *   - TanStack Query 管理配置读取 (useQuery) + 写入 (useMutation)
 *   - 本地编辑态（editConfig）与服务器配置 (moaConfig) 分离
 *   - 模型列表单独管理（add/edit/remove 操作）
 */
import { computed, reactive, ref, watch } from 'vue';
import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import {
  NGrid, NGi, NCard, NSwitch, NInputNumber, NSelect, NButton,
  NDivider, NTag, NSpace, NSpin, NAlert, NModal, NForm,
  NFormItem, NInput, NCheckboxGroup, NCheckbox, NEmpty,
  useMessage, type FormInst,
} from 'naive-ui';
import { fetchMoaConfig, updateMoaConfig, fetchMoaStatus } from '../api/moa';
import type { MoaConfig, MoaModelConfig } from '../api/moa';
import CapabilityProfileSwitch from '../components/CapabilityProfileSwitch.vue';

const message = useMessage();
const queryClient = useQueryClient();

// ===== 配置读取 =====
const { data: configData, isLoading: configLoading, isError: configIsError } = useQuery({
  queryKey: ['moa-config'],
  queryFn: fetchMoaConfig,
  placeholderData: (prev: unknown) => prev,
});

const { data: statusData } = useQuery({
  queryKey: ['moa-status'],
  queryFn: fetchMoaStatus,
  refetchInterval: 30_000,
});

const moaConfig = computed<MoaConfig | null>(() => configData.value?.config ?? null);

// ===== 本地编辑态 =====
const editConfig = reactive({
  enabled: false,
  complexityThreshold: 0.6,
  mode: 'serial' as string,
  enabledTiers: [] as string[],
});

// 同步服务器配置到编辑态
watch(moaConfig, (cfg) => {
  if (cfg) {
    editConfig.enabled = cfg.enabled;
    editConfig.complexityThreshold = cfg.complexityThreshold;
    editConfig.mode = cfg.mode;
    editConfig.enabledTiers = [...cfg.enabledTiers];
  }
}, { immediate: true });

// ===== 配置写入 =====
const configMutation = useMutation({
  mutationFn: (updates: Record<string, unknown>) => updateMoaConfig(updates),
  onSuccess: (data) => {
    if (data.ok) {
      message.success('MOA 配置已保存');
      void queryClient.invalidateQueries({ queryKey: ['moa-config'] });
      void queryClient.invalidateQueries({ queryKey: ['moa-status'] });
    } else {
      message.error(data.error ?? '保存失败');
    }
  },
  onError: (err: Error) => {
    message.error(err.message);
  },
});

function saveConfig(): void {
  configMutation.mutate({
    enabled: editConfig.enabled,
    complexityThreshold: editConfig.complexityThreshold,
    mode: editConfig.mode,
    enabledTiers: editConfig.enabledTiers,
  });
}

// ===== 参考模型预设 =====
interface ReferencePreset {
  id: string;
  label: string;
  desc: string;
  config: MoaModelConfig;
}

const REFERENCE_PRESETS: ReferencePreset[] = [
  {
    id: 'qwen3.6-27b',
    label: 'Qwen3.6 27B',
    desc: 'Ollama 本地 · 通用推理',
    config: { provider: 'ollama', model: 'qwen3.6:27b', temperature: 0.6, timeoutMs: 900_000, systemPrompt: '' },
  },
  {
    id: 'qwen3.6-35b-a3b',
    label: 'Qwen3.6 35B-A3B',
    desc: 'Ollama 本地 · MoE 推理',
    config: { provider: 'ollama', model: 'qwen3.6:35b-a3b', temperature: 0.6, timeoutMs: 900_000, systemPrompt: '' },
  },
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek-V4 Flash',
    desc: 'DeepSeek API · 快速推理',
    config: { provider: 'deepseek', model: 'deepseek-v4-flash', temperature: 0.7, timeoutMs: 900_000, systemPrompt: '' },
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek-V4 Pro',
    desc: 'DeepSeek API · 深度推理',
    config: { provider: 'deepseek', model: 'deepseek-v4-pro', temperature: 0.6, timeoutMs: 900_000, systemPrompt: '' },
  },
  {
    id: 'qwyoth',
    label: 'Qwyoth',
    desc: 'Ollama 本地 · 多视角推理',
    config: { provider: 'ollama', model: 'Qwyoth', temperature: 0.6, timeoutMs: 900_000, systemPrompt: '' },
  },
];

// ===== 参考模型管理 =====
const referenceModels = ref<MoaModelConfig[]>([]);
const selectedReferencePresets = ref<string[]>([]);
const showModelModal = ref(false);
const editingModelIndex = ref<number | null>(null);
const modelFormRef = ref<FormInst | null>(null);

const modelForm = reactive<MoaModelConfig>({
  provider: 'ollama',
  model: '',
  temperature: 0.6,
  timeoutMs: 120_000,
  systemPrompt: '',
  apiKey: '',
  baseURL: '',
  keepAlive: '1h',
});

const providerOptions = [
  { label: 'Ollama', value: 'ollama' },
  { label: 'DeepSeek', value: 'deepseek' },
  { label: 'OpenAI', value: 'openai' },
  { label: '自定义', value: 'custom' },
  { label: 'OpenClaw Hooks', value: 'openclaw_hooks' },
];

// 判断某个参考模型是否匹配预设
function matchRefPreset(m: MoaModelConfig): string | null {
  for (const preset of REFERENCE_PRESETS) {
    if (m.provider === preset.config.provider && m.model === preset.config.model) {
      return preset.id;
    }
  }
  return null;
}

// 同步服务器参考模型到本地
watch(moaConfig, (cfg) => {
  if (cfg) {
    referenceModels.value = (cfg.referenceModels ?? []).map((m) => ({ ...m }));
    // 检测哪些预设已被选中
    selectedReferencePresets.value = (cfg.referenceModels ?? [])
      .map((m) => matchRefPreset(m))
      .filter((id): id is string => id !== null);
  }
}, { immediate: true });

function onRefPresetChange(presetIds: string[]): void {
  // 构建预设模型集合
  const presetModels = new Map<string, MoaModelConfig>();
  for (const p of REFERENCE_PRESETS) {
    presetModels.set(p.id, { ...p.config });
  }

  // 保留非预设的自定义模型
  const customModels = referenceModels.value.filter((m) => matchRefPreset(m) === null);

  // 选中预设 -> 模型列表
  const selectedModels = presetIds.map((id) => presetModels.get(id)!).filter(Boolean);

  referenceModels.value = [...selectedModels, ...customModels];
  selectedReferencePresets.value = presetIds;
  saveReferenceModels();
}

function openAddModel(): void {
  editingModelIndex.value = null;
  modelForm.provider = 'ollama';
  modelForm.model = '';
  modelForm.temperature = 0.6;
  modelForm.timeoutMs = 120_000;
  modelForm.systemPrompt = '';
  modelForm.apiKey = '';
  modelForm.baseURL = '';
  modelForm.keepAlive = '1h';
  showModelModal.value = true;
}

function openEditModel(index: number): void {
  editingModelIndex.value = index;
  const m = referenceModels.value[index];
  modelForm.provider = m.provider;
  modelForm.model = m.model;
  modelForm.temperature = m.temperature;
  modelForm.timeoutMs = m.timeoutMs;
  modelForm.systemPrompt = m.systemPrompt ?? '';
  modelForm.apiKey = m.apiKey ?? '';
  modelForm.baseURL = m.baseURL ?? '';
  modelForm.keepAlive = m.keepAlive ?? '1h';
  showModelModal.value = true;
}

function removeModel(index: number): void {
  referenceModels.value.splice(index, 1);
  saveReferenceModels();
}

function saveModel(): void {
  if (!modelForm.model.trim()) {
    message.warning('请输入模型名称');
    return;
  }
  if (editingModelIndex.value !== null) {
    referenceModels.value[editingModelIndex.value] = { ...modelForm };
  } else {
    referenceModels.value.push({ ...modelForm });
  }
  showModelModal.value = false;
  saveReferenceModels();
}

function cancelModel(): void {
  showModelModal.value = false;
}

function saveReferenceModels(): void {
  configMutation.mutate({
    referenceModels: referenceModels.value.map((m) => {
      // 移除空字符串的 apiKey（不覆盖已有）
      const clean: Record<string, unknown> = {
        provider: m.provider,
        model: m.model,
        temperature: m.temperature,
        timeoutMs: m.timeoutMs,
        systemPrompt: m.systemPrompt ?? '',
        baseURL: m.baseURL ?? '',
        keepAlive: m.keepAlive ?? '1h',
      };
      if (m.apiKey && m.apiKey !== '***') clean.apiKey = m.apiKey;
      return clean;
    }),
  });
}

// ===== 聚合模型预设 =====
interface AggregatorPreset {
  id: string;
  label: string;
  desc: string;
  config: MoaModelConfig;
}

const AGGREGATOR_PRESETS: AggregatorPreset[] = [
  {
    id: 'qwen3.6',
    label: 'Qwen3.6 27B',
    desc: '本地 Ollama，通用推理',
    config: { provider: 'ollama', model: 'qwen3.6:27b', temperature: 0.3, timeoutMs: 1_200_000, systemPrompt: '' },
  },
  {
    id: 'deepseek-r1',
    label: 'DeepSeek-R1 14B',
    desc: '本地 Ollama，强推理',
    config: { provider: 'ollama', model: 'deepseek-r1:14b', temperature: 0.3, timeoutMs: 1_200_000, systemPrompt: '' },
  },
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    desc: 'OpenAI 云端，高精度',
    config: { provider: 'openai', model: 'gpt-4o', temperature: 0.3, timeoutMs: 1_200_000, systemPrompt: '' },
  },
];

const selectedAggregatorPreset = ref<string>('');

// 判断当前聚合模型是否匹配某个预设
function detectPreset(cfg: MoaModelConfig | null | undefined): string {
  if (!cfg) return '';
  for (const preset of AGGREGATOR_PRESETS) {
    if (cfg.provider === preset.config.provider && cfg.model === preset.config.model) {
      return preset.id;
    }
  }
  return 'custom';
}

// 自定义聚合模型（高级设置）
const aggregatorCustom = reactive<MoaModelConfig>({
  provider: 'ollama',
  model: '',
  temperature: 0.3,
  timeoutMs: 1_200_000,
  systemPrompt: '',
  apiKey: '',
  baseURL: '',
  keepAlive: '1h',
});

const showAggregatorAdvanced = ref(false);

// 同步服务器配置到本地
watch(moaConfig, (cfg) => {
  if (cfg) {
    const presetId = detectPreset(cfg.aggregatorModel);
    selectedAggregatorPreset.value = presetId;
    if (cfg.aggregatorModel) {
      aggregatorCustom.provider = cfg.aggregatorModel.provider;
      aggregatorCustom.model = cfg.aggregatorModel.model;
      aggregatorCustom.temperature = cfg.aggregatorModel.temperature;
      aggregatorCustom.timeoutMs = cfg.aggregatorModel.timeoutMs;
      aggregatorCustom.systemPrompt = cfg.aggregatorModel.systemPrompt ?? '';
      aggregatorCustom.baseURL = cfg.aggregatorModel.baseURL ?? '';
      aggregatorCustom.keepAlive = cfg.aggregatorModel.keepAlive ?? '1h';
      showAggregatorAdvanced.value = presetId === 'custom';
    }
  }
}, { immediate: true });

function onAggregatorPresetChange(presetId: string): void {
  if (presetId === 'custom') {
    showAggregatorAdvanced.value = true;
    return;
  }
  showAggregatorAdvanced.value = false;
  const preset = AGGREGATOR_PRESETS.find((p) => p.id === presetId);
  if (!preset) return;
  configMutation.mutate({ aggregatorModel: { ...preset.config } });
}

function saveAggregatorCustom(): void {
  if (!aggregatorCustom.model.trim()) {
    message.warning('请输入聚合模型名称');
    return;
  }
  const clean: Record<string, unknown> = {
    provider: aggregatorCustom.provider,
    model: aggregatorCustom.model,
    temperature: aggregatorCustom.temperature,
    timeoutMs: aggregatorCustom.timeoutMs,
    systemPrompt: aggregatorCustom.systemPrompt ?? '',
    baseURL: aggregatorCustom.baseURL ?? '',
    keepAlive: aggregatorCustom.keepAlive ?? '1h',
  };
  if (aggregatorCustom.apiKey && aggregatorCustom.apiKey !== '***') {
    clean.apiKey = aggregatorCustom.apiKey;
  }
  configMutation.mutate({ aggregatorModel: clean });
}

const presetOptions = computed(() => [
  ...AGGREGATOR_PRESETS.map((p) => ({
    label: `${p.label} — ${p.desc}`,
    value: p.id,
  })),
  { label: '自定义（高级设置）', value: 'custom' },
]);

// ===== 状态标签 =====
const statusLabel = computed(() => {
  if (!moaConfig.value) return '未知';
  return moaConfig.value.enabled ? '已启用' : '已禁用';
});

const statusType = computed(() => {
  if (!moaConfig.value) return 'default';
  return moaConfig.value.enabled ? 'success' : 'warning';
});

const refModelCount = computed(() => statusData.value?.status?.referenceModelCount ?? 0);
</script>

<template>
  <div class="settings-view">
    <div class="settings-header">
      <h2 style="margin: 0">设置</h2>
      <div class="settings-header-meta">
        <NTag :type="statusType" size="small">
          MoA {{ statusLabel }}
        </NTag>
        <span v-if="statusData" class="muted" style="font-size: var(--fs-caption); margin-left: 8px">
          参考模型 {{ refModelCount }} 个{{ statusData.status?.hasAggregator ? ' · 聚合模型已配置' : '' }}
        </span>
      </div>
    </div>

    <!-- 加载/错误态 -->
    <NAlert
      v-if="configIsError"
      type="error"
      :show-icon="true"
      title="MOA 配置加载失败"
      style="margin-top: 12px"
    >
      无法读取配置，请检查后端服务是否正常。
      <template #action>
        <NButton size="small" @click="queryClient.invalidateQueries({ queryKey: ['moa-config'] })">
          重试
        </NButton>
      </template>
    </NAlert>

    <NSpin v-if="configLoading && !moaConfig" size="small" style="margin-top: 24px">
      <template #default>加载配置中…</template>
    </NSpin>

    <template v-if="moaConfig">
      <NSpace vertical :size="16" style="margin-top: 12px">
        <!-- ===== 区块 1：MOA 总控 ===== -->
        <NCard title="MoA 多模型协作" size="small">
          <template #header-extra>
            <NButton
              size="tiny"
              type="primary"
              :loading="configMutation.isPending.value"
              @click="saveConfig"
            >
              保存设置
            </NButton>
          </template>

          <NGrid :cols="'1 s:1 m:2'" :x-gap="16" :y-gap="12" responsive="screen">
            <!-- 总开关 -->
            <NGi>
              <div class="setting-row">
                <div>
                  <div class="setting-label">启用 MoA</div>
                  <div class="setting-desc">
                    开启后，高复杂度任务将自动启用多模型分层协作
                  </div>
                </div>
                <NSwitch v-model:value="editConfig.enabled" size="small" />
              </div>
            </NGi>

            <!-- 复杂度阈值 -->
            <NGi>
              <div class="setting-row">
                <div>
                  <div class="setting-label">复杂度阈值</div>
                  <div class="setting-desc">
                    当前：{{ editConfig.complexityThreshold.toFixed(2) }}
                  </div>
                </div>
                <NInputNumber
                  v-model:value="editConfig.complexityThreshold"
                  :min="0"
                  :max="1"
                  :step="0.05"
                  size="small"
                  style="width: 120px"
                />
              </div>
            </NGi>

            <!-- 协作模式 -->
            <NGi>
              <div class="setting-row">
                <div>
                  <div class="setting-label">协作模式</div>
                  <div class="setting-desc">
                    serial：串行调用 · parallel：并行调用
                  </div>
                </div>
                <NSelect
                  v-model:value="editConfig.mode"
                  :options="[
                    { label: '串行 (serial)', value: 'serial' },
                    { label: '并行 (parallel)', value: 'parallel' },
                  ]"
                  size="small"
                  style="width: 140px"
                />
              </div>
            </NGi>

            <!-- 生效层级 -->
            <NGi>
              <div class="setting-row">
                <div>
                  <div class="setting-label">生效层级</div>
                  <div class="setting-desc">
                    仅在指定压力层级下触发 MoA
                  </div>
                </div>
                <NCheckboxGroup v-model:value="editConfig.enabledTiers">
                  <NSpace>
                    <NCheckbox value="low">低压力</NCheckbox>
                    <NCheckbox value="medium">中压力</NCheckbox>
                  </NSpace>
                </NCheckboxGroup>
              </div>
            </NGi>
          </NGrid>
        </NCard>

        <!-- ===== 区块 2：参考模型 ===== -->
        <NCard title="参考模型" size="small">
          <template #header-extra>
            <NButton size="tiny" type="primary" @click="openAddModel">
              添加自定义
            </NButton>
          </template>

          <div class="setting-desc" style="margin-bottom: 12px">
            勾选预设模型快速启用，或点击「添加自定义」手动配置。参考模型从不同视角分析问题，建议 2-4 个。
          </div>

          <!-- 预设选择 -->
          <NCheckboxGroup :value="selectedReferencePresets" @update:value="onRefPresetChange">
            <NGrid :cols="'1 s:2 m:3'" :x-gap="8" :y-gap="4" responsive="screen">
              <NGi v-for="p in REFERENCE_PRESETS" :key="p.id">
                <NCheckbox :value="p.id">
                  <span class="preset-check-label">{{ p.label }}</span>
                  <span class="preset-check-desc">{{ p.desc }}</span>
                </NCheckbox>
              </NGi>
            </NGrid>
          </NCheckboxGroup>

          <!-- 已选模型列表 -->
          <template v-if="referenceModels.length > 0">
            <NDivider style="margin: 12px 0" />
            <div class="model-list">
              <div
                v-for="(m, idx) in referenceModels"
                :key="idx"
                class="model-item"
              >
                <div class="model-item-info">
                  <NTag size="tiny" :type="m.provider === 'ollama' ? 'info' : m.provider === 'deepseek' ? 'success' : m.provider === 'openai' ? 'warning' : 'default'">
                    {{ m.provider }}
                  </NTag>
                  <span class="model-name">{{ m.model }}</span>
                  <NTag v-if="matchRefPreset(m)" size="tiny" :bordered="false" type="success">预设</NTag>
                  <NTag v-else size="tiny" :bordered="false" type="warning">自定义</NTag>
                  <span class="muted" style="font-size: var(--fs-caption)">
                    temp={{ m.temperature }} · timeout={{ (m.timeoutMs / 1000).toFixed(0) }}s
                  </span>
                </div>
                <NSpace :size="4">
                  <NButton size="tiny" quaternary @click="openEditModel(idx)">编辑</NButton>
                  <NButton size="tiny" quaternary type="error" @click="removeModel(idx)">移除</NButton>
                </NSpace>
              </div>
            </div>
          </template>

          <NEmpty
            v-else
            description="暂无参考模型，请勾选预设或添加自定义模型"
            style="padding: 24px 0"
          />
        </NCard>

        <!-- ===== 区块 3：聚合模型 ===== -->
        <NCard title="聚合模型" size="small">
          <div class="setting-desc" style="margin-bottom: 12px">
            聚合模型负责合并多个参考模型的输出。选择一个预设模型，或使用自定义高级设置。
          </div>

          <div class="aggregator-preset-row">
            <div class="form-row" style="flex: 1">
              <span class="form-label">聚合模型</span>
              <NSelect
                :value="selectedAggregatorPreset"
                :options="presetOptions"
                size="small"
                style="width: 280px"
                placeholder="选择聚合模型"
                @update:value="onAggregatorPresetChange"
              />
            </div>
            <span v-if="selectedAggregatorPreset && selectedAggregatorPreset !== 'custom'" class="preset-applied">
              <NTag size="tiny" type="success">已应用</NTag>
            </span>
          </div>

          <!-- 高级设置（自定义模式） -->
          <template v-if="selectedAggregatorPreset === 'custom'">
            <NDivider style="margin: 12px 0" />
            <div class="advanced-header">
              <span class="advanced-title">高级设置</span>
              <NButton
                size="tiny"
                type="primary"
                :loading="configMutation.isPending.value"
                @click="saveAggregatorCustom"
              >
                保存聚合模型
              </NButton>
            </div>

            <NGrid :cols="'1 s:1 m:2'" :x-gap="16" :y-gap="12" responsive="screen" style="margin-top: 8px">
              <NGi>
                <div class="form-row">
                  <span class="form-label">提供商</span>
                  <NSelect
                    v-model:value="aggregatorCustom.provider"
                    :options="providerOptions"
                    size="small"
                    style="width: 160px"
                  />
                </div>
              </NGi>
              <NGi>
                <div class="form-row">
                  <span class="form-label">模型名</span>
                  <NInput
                    v-model:value="aggregatorCustom.model"
                    size="small"
                    style="width: 200px"
                    placeholder="qwen3.6:27b"
                  />
                </div>
              </NGi>
              <NGi>
                <div class="form-row">
                  <span class="form-label">Temperature</span>
                  <NInputNumber
                    v-model:value="aggregatorCustom.temperature"
                    :min="0"
                    :max="2"
                    :step="0.1"
                    size="small"
                    style="width: 100px"
                  />
                </div>
              </NGi>
              <NGi>
                <div class="form-row">
                  <span class="form-label">超时 (ms)</span>
                  <NInputNumber
                    v-model:value="aggregatorCustom.timeoutMs"
                    :min="1000"
                    :max="600000"
                    :step="10000"
                    size="small"
                    style="width: 120px"
                  />
                </div>
              </NGi>
              <NGi>
                <div class="form-row">
                  <span class="form-label">Base URL</span>
                  <NInput
                    v-model:value="aggregatorCustom.baseURL"
                    size="small"
                    style="width: 200px"
                    placeholder="可选"
                  />
                </div>
              </NGi>
              <NGi>
                <div class="form-row">
                  <span class="form-label">Keep Alive</span>
                  <NInput
                    v-model:value="aggregatorCustom.keepAlive"
                    size="small"
                    style="width: 100px"
                    placeholder="1h"
                  />
                </div>
              </NGi>
              <NGi>
                <div class="form-row">
                  <span class="form-label">API Key</span>
                  <NInput
                    v-model:value="aggregatorCustom.apiKey"
                    size="small"
                    style="width: 200px"
                    placeholder="留空保留现有值"
                    type="password"
                    show-password-on="click"
                  />
                </div>
              </NGi>
            </NGrid>
          </template>
        </NCard>
      </NSpace>

      <!-- v1.1.0-5: 能力档次切换（从维护页移入） -->
      <CapabilityProfileSwitch style="margin-top: 16px" />
    </template>
  </div>

  <!-- 参考模型添加/编辑弹窗 -->
  <NModal
    v-model:show="showModelModal"
    :title="editingModelIndex !== null ? '编辑参考模型' : '添加参考模型'"
    preset="card"
    style="width: 480px"
    :mask-closable="false"
  >
    <NForm ref="modelFormRef" :model="modelForm" label-placement="left" label-width="100" size="small">
      <NFormItem label="提供商" required>
        <NSelect
          v-model:value="modelForm.provider"
          :options="providerOptions"
          style="width: 100%"
        />
      </NFormItem>
      <NFormItem label="模型名" required>
        <NInput
          v-model:value="modelForm.model"
          placeholder="qwen3.6:27b"
          style="width: 100%"
        />
      </NFormItem>
      <NFormItem label="Temperature">
        <NInputNumber
          v-model:value="modelForm.temperature"
          :min="0"
          :max="2"
          :step="0.1"
          style="width: 100%"
        />
      </NFormItem>
      <NFormItem label="超时 (ms)">
        <NInputNumber
          v-model:value="modelForm.timeoutMs"
          :min="1000"
          :max="600000"
          :step="10000"
          style="width: 100%"
        />
      </NFormItem>
      <NFormItem label="Base URL">
        <NInput
          v-model:value="modelForm.baseURL"
          placeholder="可选"
          style="width: 100%"
        />
      </NFormItem>
      <NFormItem label="Keep Alive">
        <NInput
          v-model:value="modelForm.keepAlive"
          placeholder="1h"
          style="width: 100%"
        />
      </NFormItem>
      <NFormItem label="System Prompt">
        <NInput
          v-model:value="modelForm.systemPrompt"
          type="textarea"
          placeholder="可选，自定义系统提示"
          :autosize="{ minRows: 2, maxRows: 4 }"
          style="width: 100%"
        />
      </NFormItem>
      <NFormItem label="API Key">
        <NInput
          v-model:value="modelForm.apiKey"
          placeholder="留空保留现有值"
          type="password"
          show-password-on="click"
          style="width: 100%"
        />
      </NFormItem>
    </NForm>
    <template #footer>
      <NSpace justify="end">
        <NButton size="small" @click="cancelModel">取消</NButton>
        <NButton size="small" type="primary" @click="saveModel">保存</NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.settings-view {
  width: 100%;
}

.settings-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 4px;
}

.settings-header-meta {
  display: flex;
  align-items: center;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
}

.setting-label {
  font-weight: 500;
  font-size: var(--fs-body);
}

.setting-desc {
  font-size: var(--fs-caption);
  color: var(--color-text-tertiary);
  margin-top: 2px;
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.model-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--color-surface-2);
  border: 1px solid var(--color-border);
}

.model-item-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.model-name {
  font-weight: 500;
  font-family: var(--font-family-mono);
  font-size: var(--fs-body);
}

.form-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-label {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
  white-space: nowrap;
  min-width: 80px;
  text-align: right;
}

.aggregator-preset-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.preset-applied {
  display: flex;
  align-items: center;
}

.advanced-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.advanced-title {
  font-weight: 500;
  font-size: var(--fs-body);
  color: var(--color-text-secondary);
}

.preset-check-label {
  font-weight: 500;
  font-size: var(--fs-body);
}

.preset-check-desc {
  font-size: var(--fs-caption);
  color: var(--color-text-tertiary);
  margin-left: 4px;
}
</style>