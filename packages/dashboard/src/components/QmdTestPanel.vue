<script setup lang="ts">
/**
 * QMD MCP 测试面板（v1.2.0 性能诊断）。
 *
 * 用途：手动测试 QMD MCP 连通性 + 查询延迟，10x/20x 反复测试 + 平均延迟统计。
 * 用于排查 assemble 路径中 L2_qmd 延迟超 20s 的根因（区分 MCP 握手 vs 查询耗时）。
 *
 * 默认 baseUrl：从系统配置 retrieval.qmd.mcpEndpoint 读取，用户可手动覆盖。
 * 测试流程：每次都执行完整 initialize + tools/call "query"（模拟冷启动）。
 */
import { computed, onMounted, ref } from 'vue';
import {
  NCard,
  NSpace,
  NInput,
  NInputNumber,
  NSelect,
  NButton,
  NTag,
  NTable,
  NAlert,
  NStatistic,
  NGrid,
  NGi,
  NSwitch,
  useMessage,
} from 'naive-ui';
import {
  fetchQmdTestDefaultUrl,
  runQmdTest,
  type QmdTestResponse,
} from '../api/qmd-test';

const message = useMessage();

// ===== 表单状态 =====
const baseUrl = ref<string>('');
const query = ref<string>('知识图谱检索');
const iterations = ref<number>(10);
const limit = ref<number>(5);
const useCustomUrl = ref<boolean>(false);

const iterationOptions = [
  { label: '10 次', value: 10 },
  { label: '20 次', value: 20 },
  { label: '5 次（快速验证）', value: 5 },
  { label: '1 次（单次连通性）', value: 1 },
];

// ===== 测试状态 =====
const loading = ref<boolean>(false);
const result = ref<QmdTestResponse | null>(null);
const errorMsg = ref<string>('');

// ===== 初始化：获取系统配置中的默认 QMD MCP 地址 =====
onMounted(async () => {
  try {
    const resp = await fetchQmdTestDefaultUrl();
    if (resp.ok && resp.defaultUrl) {
      baseUrl.value = resp.defaultUrl;
    } else {
      baseUrl.value = 'http://127.0.0.1:8081';
    }
  } catch (e) {
    baseUrl.value = 'http://127.0.0.1:8081';
    message.warning('获取系统配置 QMD 地址失败，使用默认 127.0.0.1:8081');
  }
});

// ===== 执行测试 =====
async function executeTest(): Promise<void> {
  if (!query.value.trim()) {
    message.error('测试 query 不能为空');
    return;
  }
  if (!baseUrl.value.trim()) {
    message.error('QMD MCP 地址不能为空');
    return;
  }
  loading.value = true;
  errorMsg.value = '';
  result.value = null;

  try {
    const finalBaseUrl = useCustomUrl.value ? baseUrl.value.trim() : '';
    const resp = await runQmdTest(finalBaseUrl, query.value.trim(), iterations.value, limit.value);
    result.value = resp;
    if (!resp.ok) {
      errorMsg.value = resp.error ?? '测试失败';
      message.error(errorMsg.value);
    } else {
      message.success(
        `测试完成：${resp.successCount}/${resp.iterations} 成功，平均 ${resp.avgLatencyMs}ms`,
      );
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
    message.error(`测试请求失败: ${errorMsg.value}`);
  } finally {
    loading.value = false;
  }
}

// ===== 重置结果 =====
function resetResult(): void {
  result.value = null;
  errorMsg.value = '';
}

// ===== 响应式状态：用于模板中的延迟分类标签颜色 =====
function latencyTagType(latencyMs: number): 'success' | 'warning' | 'error' {
  if (latencyMs < 1000) return 'success';
  if (latencyMs < 3000) return 'warning';
  return 'error';
}

function latencyLabel(latencyMs: number): string {
  if (latencyMs < 1000) return `${latencyMs}ms`;
  return `${(latencyMs / 1000).toFixed(2)}s`;
}

// ===== 统计卡片数据 =====
const stats = computed(() => {
  if (!result.value || !result.value.ok) return null;
  return {
    avg: result.value.avgLatencyMs,
    min: result.value.minLatencyMs,
    max: result.value.maxLatencyMs,
    rate: result.value.successRate,
    avgInit: result.value.avgInitMs,
    avgQuery: result.value.avgQueryMs,
    total: result.value.totalMs,
  };
});
</script>

<template>
  <NCard size="small" :bordered="true" class="qmd-test-panel">
    <div class="panel-header">
      <h3 style="margin: 0; font-size: var(--fs-subtitle)">QMD MCP 性能测试</h3>
      <span class="muted">
        完整 initialize + query 流程，10x/20x 反复测试，统计平均延迟
      </span>
    </div>

    <NSpace vertical :size="12" style="margin-top: 12px">
      <!-- 地址选择：使用系统配置 / 手动输入 -->
      <NGrid :cols="'1 m:2'" :x-gap="12" :y-gap="8" responsive="screen">
        <NGi>
          <div class="form-row">
            <span class="form-label">地址来源</span>
            <NSwitch v-model:value="useCustomUrl" size="small">
              <template #checked>手动输入</template>
              <template #unchecked>系统配置</template>
            </NSwitch>
          </div>
        </NGi>
        <NGi>
          <div class="form-row">
            <span class="form-label">QMD MCP 地址</span>
            <NInput
              v-model:value="baseUrl"
              size="small"
              :placeholder="'http://127.0.0.1:8081'"
              :disabled="!useCustomUrl"
              style="flex: 1"
            />
          </div>
        </NGi>
      </NGrid>

      <!-- 测试参数 -->
      <NGrid :cols="'1 m:3'" :x-gap="12" :y-gap="8" responsive="screen">
        <NGi>
          <div class="form-row">
            <span class="form-label">测试 query</span>
            <NInput
              v-model:value="query"
              size="small"
              placeholder="输入测试查询文本"
              style="flex: 1"
            />
          </div>
        </NGi>
        <NGi>
          <div class="form-row">
            <span class="form-label">迭代次数</span>
            <NSelect
              v-model:value="iterations"
              :options="iterationOptions"
              size="small"
              style="width: 100%"
            />
          </div>
        </NGi>
        <NGi>
          <div class="form-row">
            <span class="form-label">返回条数 limit</span>
            <NInputNumber
              v-model:value="limit"
              :min="1"
              :max="50"
              size="small"
              style="width: 100%"
            />
          </div>
        </NGi>
      </NGrid>

      <!-- 操作按钮 -->
      <NSpace :size="8">
        <NButton
          type="primary"
          size="small"
          :loading="loading"
          :disabled="loading"
          @click="executeTest"
        >
          开始测试
        </NButton>
        <NButton
          v-if="result"
          size="small"
          :disabled="loading"
          @click="resetResult"
        >
          清除结果
        </NButton>
      </NSpace>

      <!-- 错误提示 -->
      <NAlert
        v-if="errorMsg"
        type="error"
        :show-icon="true"
        title="测试失败"
      >
        {{ errorMsg }}
      </NAlert>

      <!-- 统计概览 -->
      <div v-if="result && result.ok && stats" class="stats-grid">
        <NGrid :cols="'2 s:3 m:4 l:7'" :x-gap="8" :y-gap="8" responsive="screen">
          <NGi>
            <NStatistic label="平均延迟" :value="latencyLabel(stats.avg)">
              <template #suffix>
                <NTag :type="latencyTagType(stats.avg)" size="small" style="margin-left: 4px">
                  {{ stats.avg < 1000 ? '优' : stats.avg < 3000 ? '可接受' : '过慢' }}
                </NTag>
              </template>
            </NStatistic>
          </NGi>
          <NGi>
            <NStatistic label="最小延迟" :value="latencyLabel(stats.min)" />
          </NGi>
          <NGi>
            <NStatistic label="最大延迟" :value="latencyLabel(stats.max)" />
          </NGi>
          <NGi>
            <NStatistic label="成功率" :value="`${stats.rate}%`">
              <template #suffix>
                <NTag
                  :type="stats.rate === 100 ? 'success' : stats.rate >= 80 ? 'warning' : 'error'"
                  size="small"
                  style="margin-left: 4px"
                >
                  {{ stats.rate === 100 ? '稳定' : stats.rate >= 80 ? '波动' : '不稳定' }}
                </NTag>
              </template>
            </NStatistic>
          </NGi>
          <NGi>
            <NStatistic label="平均握手" :value="latencyLabel(stats.avgInit)" />
          </NGi>
          <NGi>
            <NStatistic label="平均查询" :value="latencyLabel(stats.avgQuery)" />
          </NGi>
          <NGi>
            <NStatistic label="总耗时" :value="latencyLabel(stats.total)" />
          </NGi>
        </NGrid>
      </div>

      <!-- 详细结果表 -->
      <div v-if="result && result.results.length > 0" class="detail-table">
        <div class="detail-title">逐次迭代详情</div>
        <NTable size="small" :bordered="true" :single-line="false">
          <thead>
            <tr>
              <th style="width: 50px">#</th>
              <th style="width: 80px">状态</th>
              <th style="width: 100px">总延迟</th>
              <th style="width: 100px">握手</th>
              <th style="width: 100px">查询</th>
              <th style="width: 80px">结果数</th>
              <th>错误信息</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(r, idx) in result.results"
              :key="idx"
              :class="{ 'row-error': !r.success }"
            >
              <td>{{ idx + 1 }}</td>
              <td>
                <NTag :type="r.success ? 'success' : 'error'" size="small">
                  {{ r.success ? '成功' : '失败' }}
                </NTag>
              </td>
              <td>
                <NTag :type="latencyTagType(r.latencyMs)" size="small">
                  {{ latencyLabel(r.latencyMs) }}
                </NTag>
              </td>
              <td>{{ r.initMs != null ? latencyLabel(r.initMs) : '-' }}</td>
              <td>{{ r.queryMs != null ? latencyLabel(r.queryMs) : '-' }}</td>
              <td>{{ r.resultCount }}</td>
              <td class="error-cell">{{ r.error ?? '' }}</td>
            </tr>
          </tbody>
        </NTable>
      </div>

      <!-- 解读提示 -->
      <div v-if="result && result.ok && result.successCount > 0" class="interpretation-hint">
        <span class="muted">
          解读：握手耗时高 → MCP 服务冷启动/session 创建慢；查询耗时高 → QMD 索引/embedding 慢；
          成功率低 → MCP 不稳定，assemble 路径会降级到 CLI（额外 30s 超时）。
        </span>
      </div>
    </NSpace>
  </NCard>
</template>

<style scoped>
.qmd-test-panel {
  width: 100%;
}
.panel-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
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
  min-width: 70px;
}
.stats-grid {
  padding: 12px;
  background: var(--color-bg-secondary, rgba(0, 0, 0, 0.02));
  border-radius: 6px;
}
.detail-table {
  margin-top: 4px;
}
.detail-title {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
  margin-bottom: 6px;
  font-weight: 600;
}
.row-error {
  background-color: rgba(255, 77, 79, 0.06);
}
.error-cell {
  color: var(--color-danger, #ff4d4f);
  font-size: var(--fs-caption);
  word-break: break-all;
}
.interpretation-hint {
  padding: 8px 12px;
  background: var(--color-bg-secondary, rgba(0, 0, 0, 0.02));
  border-radius: 4px;
  font-size: var(--fs-caption);
  line-height: 1.6;
}
.muted {
  color: var(--color-text-secondary);
  font-size: var(--fs-caption);
}
</style>
