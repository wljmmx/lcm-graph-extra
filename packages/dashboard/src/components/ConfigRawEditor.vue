<script setup lang="ts">
/**
 * ConfigRawEditor —— 高级用户 Raw JSON 配置编辑器（P3-3）。
 *
 * - 加载完整 raw JSON 配置（脱敏）
 * - 实时 JSON 语法校验 + 结构校验
 * - 保存写入 openclaw.json（需重启生效）
 * - 折叠在 NCard 中，默认收起，减少视觉干扰
 */
import { ref, computed, watch } from 'vue';
import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import {
  NButton, NAlert, NModal, NSpace, NText, NTag, NSpin,
  useMessage,
} from 'naive-ui';
import { fetchRawConfig, saveRawConfig, validateConfig } from '../api/config';

const message = useMessage();
const queryClient = useQueryClient();

// ===== 数据获取 =====
const { data: rawData, isLoading } = useQuery({
  queryKey: ['config-raw'],
  queryFn: fetchRawConfig,
  staleTime: 30_000,
});

const rawJson = ref('');
const showEditor = ref(false);
const validationErrors = ref<string[]>([]);
const isValidating = ref(false);

// 同步服务器数据到编辑器
watch(
  () => rawData.value?.config,
  (cfg) => {
    if (cfg && !rawJson.value) {
      rawJson.value = JSON.stringify(cfg, null, 2);
    }
  },
  { immediate: true },
);

// JSON 语法校验
const jsonValid = computed(() => {
  if (!rawJson.value.trim()) return false;
  try {
    JSON.parse(rawJson.value);
    return true;
  } catch {
    return false;
  }
});

// ===== 保存 =====
const saveMutation = useMutation({
  mutationFn: (json: string) => saveRawConfig(json),
  onSuccess: (data) => {
    if (data.ok) {
      message.success('配置已保存，需重启插件进程生效');
      void queryClient.invalidateQueries({ queryKey: ['config-raw'] });
      validationErrors.value = [];
    } else {
      message.error(data.error ?? '保存失败');
    }
  },
  onError: (err: Error) => {
    message.error(err.message);
  },
});

function openEditor(): void {
  if (rawData.value?.config) {
    rawJson.value = JSON.stringify(rawData.value.config, null, 2);
  }
  showEditor.value = true;
}

async function handleValidate(): Promise<void> {
  if (!jsonValid.value) {
    message.warning('JSON 格式错误，请修正后再校验');
    return;
  }
  isValidating.value = true;
  try {
    const result = await validateConfig(rawJson.value);
    if (result.ok) {
      message.success(result.message ?? '校验通过');
      validationErrors.value = [];
    } else {
      validationErrors.value = result.errors ?? [result.error ?? '未知错误'];
    }
  } catch (err) {
    validationErrors.value = [err instanceof Error ? err.message : String(err)];
  } finally {
    isValidating.value = false;
  }
}

function handleSave(): void {
  if (!jsonValid.value) {
    message.warning('JSON 格式错误，请修正后再保存');
    return;
  }
  saveMutation.mutate(rawJson.value);
}
</script>

<template>
  <div>
    <NButton size="small" quaternary type="primary" @click="openEditor">
      高级配置编辑器
    </NButton>

    <NModal
      v-model:show="showEditor"
      title="Raw JSON 配置编辑器"
      style="width: 800px; max-width: 90vw"
      preset="card"
      :mask-closable="true"
    >
      <template #header-extra>
        <NSpace :size="8">
          <NTag v-if="jsonValid" type="success" size="small">JSON 合法</NTag>
          <NTag v-else type="error" size="small">JSON 语法错误</NTag>
        </NSpace>
      </template>

      <NSpin :show="isLoading">
        <NAlert
          type="warning"
          :show-icon="true"
          style="margin-bottom: 12px"
        >
          此编辑器直接操作 openclaw.json 配置文件。修改后需重启插件进程生效。请谨慎操作。
        </NAlert>

        <NAlert
          v-if="validationErrors.length > 0"
          type="error"
          :show-icon="true"
          style="margin-bottom: 12px"
        >
          <template #header>
            校验错误（{{ validationErrors.length }} 条）
          </template>
          <ul style="margin: 4px 0; padding-left: 20px">
            <li v-for="(err, i) in validationErrors" :key="i">{{ err }}</li>
          </ul>
        </NAlert>

        <NText depth="3" style="display: block; margin-bottom: 6px; font-size: 12px">
          编辑完整 JSON 配置。敏感字段（apiKey/password 等）已被脱敏，空值表示保留现有。
        </NText>

        <textarea
          v-model="rawJson"
          class="raw-editor-textarea"
          rows="18"
          spellcheck="false"
          aria-label="Raw JSON 配置"
        />

        <NSpace justify="end" style="margin-top: 12px">
          <NButton
            size="small"
            :loading="isValidating"
            :disabled="!jsonValid"
            @click="handleValidate"
          >
            校验
          </NButton>
          <NButton
            type="primary"
            size="small"
            :loading="saveMutation.isPending.value"
            :disabled="!jsonValid"
            @click="handleSave"
          >
            保存
          </NButton>
        </NSpace>
      </NSpin>
    </NModal>
  </div>
</template>

<style scoped>
.raw-editor-textarea {
  width: 100%;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', 'Consolas', monospace;
  font-size: 13px;
  line-height: 1.5;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-code-bg, #f5f5f5);
  color: var(--color-text);
  resize: vertical;
  tab-size: 2;
}
[data-theme='dark'] .raw-editor-textarea {
  background: var(--color-code-bg, #1e1e1e);
}
</style>