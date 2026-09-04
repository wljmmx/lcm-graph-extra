<script setup lang="ts">
/**
 * QMD MCP 测试工具（独立页面）。
 *
 * 与运维工具区分，单独路由 /qmd-test。
 *
 * 功能：
 * - 配置区：MCP 地址（系统配置/手动输入）+ 测试 query + 迭代次数 + limit + 超时时间
 * - Tab 1 "结果统计"：平均/最小/最大延迟、成功率、握手 vs 查询耗时、逐次迭代详情表
 * - Tab 2 "日志与查询结果"：完整交互日志 + 每次迭代的查询结果内容
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
  NTabs,
  NTabPane,
  NEmpty,
  NCollapse,
  NCollapseItem,
  useMessage,
} from 'naive-ui';
import {
  fetchQmdTestDefaultUrl,
  runQmdTest,
  type QmdTestResponse,
  type QmdTestLogEntry,
  type QmdTestQueryResult,
  type TestMode,
} from '../api/qmd-test';

const message = useMessage();

// ===== 表单状态 =====
const baseUrl = ref<string>('');
const query = ref<string>('知识图谱检索');
const iterations = ref<number>(10);
const limit = ref<number>(5);
const timeoutMs = ref<number>(10000);
const useCustomUrl = ref<boolean>(false);
const mode = ref<TestMode>('rest');

const iterationOptions = [
  { label: '10 次', value: 10 },
  { label: '20 次', value: 20 },
  { label: '5 次（快速验证）', value: 5 },
  { label: '1 次（单次连通性）', value: 1 },
];

const modeOptions = [
  {
    label: 'REST /query（推荐，稳定快速）',
    value: 'rest' as TestMode,
  },
  {
    label: 'MCP /mcp（完整握手 + tools/call，易超时）',
    value: 'mcp' as TestMode,
  },
];

// ===== 测试状态 =====
const loading = ref<boolean>(false);
const result = ref<QmdTestResponse | null>(null);
const errorMsg = ref<string>('');
const activeTab = ref<string>('stats');

// ===== 初始化：获取系统配置中的默认 QMD MCP 地址 =====
onMounted(async () => {
  try {
    const resp = await fetchQmdTestDefaultUrl();
    if (resp.ok && resp.defaultUrl) {
      baseUrl.value = resp.defaultUrl;
    } else {
      baseUrl.value = 'http://127.0.0.1:8081';
    }
  } catch {
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
    const resp = await runQmdTest(
      finalBaseUrl,
      query.value.trim(),
      iterations.value,
      limit.value,
      timeoutMs.value,
      mode.value,
    );
    result.value = resp;
    if (!resp.ok) {
      errorMsg.value = resp.error ?? '测试失败';
      message.error(errorMsg.value);
    } else {
      message.success(
        `测试完成（${mode.value.toUpperCase()}）：${resp.successCount}/${resp.iterations} 成功，平均 ${resp.avgLatencyMs}ms`,
      );
      activeTab.value = 'stats';
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

// ===== 辅助函数 =====
function latencyTagType(latencyMs: number): 'success' | 'warning' | 'error' {
  if (latencyMs < 1000) return 'success';
  if (latencyMs < 3000) return 'warning';
  return 'error';
}

function latencyLabel(latencyMs: number): string {
  if (latencyMs < 1000) return `${latencyMs}ms`;
  return `${(latencyMs / 1000).toFixed(2)}s`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function phaseTagType(phase: QmdTestLogEntry['phase']): 'default' | 'info' | 'success' | 'warning' | 'error' {
  switch (phase) {
    case 'initialize': return 'info';
    case 'query': return 'success';
    case 'error': return 'error';
    case 'info': return 'default';
    default: return 'default';
  }
}

function phaseLabel(phase: QmdTestLogEntry['phase']): string {
  switch (phase) {
    case 'initialize': return '握手';
    case 'query': return '查询';
    case 'error': return '错误';
    case 'info': return '信息';
    default: return phase;
  }
}

// ===== 统计卡片数据 =====
const isMcpMode = computed(() => result.value?.mode === 'mcp');

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
    timeout: result.value.timeoutMs,
  };
});

// ===== 展开面板：查询结果按迭代折叠 =====
const queryResultCollapseItems = computed(() => {
  if (!result.value?.queryResults) return [];
  return result.value.queryResults.map((qr: QmdTestQueryResult) => ({
    title: `迭代 #${qr.iteration} — ${qr.success ? `${qr.count} 条结果` : '失败'}`,
    qr,
  }));
});

// ===== 日志总数 =====
const logCount = computed(() => result.value?.logs?.length ?? 0);
</script>

<template>
  <NSpace vertical :size="16">
    <!-- ===== 配置区 ===== -->
    <NCard size="small" :bordered="true">
      <div class="section-header">
        <h3 style="margin: 0; font-size: var(--fs-subtitle)">QMD MCP 测试配置</h3>
        <span class="muted">支持 REST /query（直连，稳定）和 MCP /mcp（完整握手）两种模式</span>
      </div>

      <NSpace vertical :size="12" style="margin-top: 12px">
        <!-- 测试模式选择（独占一行，含说明） -->
        <div class="form-row" style="align-items: flex-start;">
          <span class="form-label">测试模式</span>
          <div style="flex: 1">
            <NSelect
              v-model:value="mode"
              :options="modeOptions"
              size="small"
              style="max-width: 420px"
            />
            <div class="mode-hint">
              <span v-if="mode === 'rest'" class="muted">
                REST 模式：直接 POST /query 调用 store.search()，无需 initialize 握手，绕过 MCP transport 层，适合排查 QMD 索引/embedding 性能
              </span>
              <span v-else class="muted">
                MCP 模式：stateless 直接 tools/call "query"（无 initialize，无会话），与 assemble L2_qmd 实际调用路径一致；长时间 tools/call 可能超时挂起
              </span>
            </div>
          </div>
        </div>

        <!-- 地址选择 + 超时 -->
        <NGrid :cols="'1 m:3'" :x-gap="12" :y-gap="8" responsive="screen">
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
          <NGi>
            <div class="form-row">
              <span class="form-label">单次超时</span>
              <NInputNumber
                v-model:value="timeoutMs"
                :min="1000"
                :max="60000"
                :step="1000"
                size="small"
                style="width: 100%"
              />
              <span class="form-label-suffix">ms</span>
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
      </NSpace>
    </NCard>

    <!-- ===== 结果展示区（两个 Tab） ===== -->
    <NCard v-if="result" size="small" :bordered="true">
      <NTabs v-model:value="activeTab" type="line" animated>
        <!-- ===== Tab 1: 结果统计 ===== -->
        <NTabPane name="stats" tab="结果统计">
          <NSpace vertical :size="12">
            <!-- 统计概览 -->
            <div v-if="result.ok && stats" class="stats-grid">
              <NGrid :cols="'2 s:3 m:4 l:8'" :x-gap="8" :y-gap="8" responsive="screen">
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
                <NGi v-if="isMcpMode">
                  <NStatistic label="平均握手" :value="latencyLabel(stats.avgInit)" />
                </NGi>
                <NGi>
                  <NStatistic label="平均查询" :value="latencyLabel(stats.avgQuery)" />
                </NGi>
                <NGi>
                  <NStatistic label="总耗时" :value="latencyLabel(stats.total)" />
                </NGi>
                <NGi>
                  <NStatistic label="超时设置" :value="latencyLabel(stats.timeout)" />
                </NGi>
              </NGrid>
            </div>

            <!-- 逐次迭代详情表 -->
            <div v-if="result.results.length > 0" class="detail-section">
              <div class="detail-title">逐次迭代详情</div>
              <NTable size="small" :bordered="true" :single-line="false">
                <thead>
                  <tr>
                    <th style="width: 50px">#</th>
                    <th style="width: 80px">状态</th>
                    <th style="width: 100px">总延迟</th>
                    <th v-if="isMcpMode" style="width: 100px">握手</th>
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
                    <td v-if="isMcpMode">{{ r.initMs != null ? latencyLabel(r.initMs) : '-' }}</td>
                    <td>{{ r.queryMs != null ? latencyLabel(r.queryMs) : '-' }}</td>
                    <td>{{ r.resultCount }}</td>
                    <td class="error-cell">{{ r.error ?? '' }}</td>
                  </tr>
                </tbody>
              </NTable>
            </div>

            <!-- 解读提示 -->
            <div v-if="result.ok && result.successCount > 0" class="interpretation-hint">
              <span class="muted" v-if="isMcpMode">
                解读：握手耗时高 → MCP 服务冷启动/session 创建慢；查询耗时高 → QMD 索引/embedding 慢；
                成功率低 → MCP 不稳定，assemble 路径会降级到 CLI（额外 30s 超时）。
              </span>
              <span class="muted" v-else>
                解读：REST 模式无握手开销，延迟直接反映 QMD store.search() 性能（含 embedding/rerank）；
                若 REST 稳定但 MCP 超时，说明问题在 MCP transport 层（enableJsonResponse 长任务挂起）。
              </span>
            </div>
          </NSpace>
        </NTabPane>

        <!-- ===== Tab 2: 日志与查询结果 ===== -->
        <NTabPane name="logs" tab="日志与查询结果">
          <NSpace vertical :size="16">
            <!-- 交互日志区 -->
            <div class="detail-section">
              <div class="detail-title">
                交互日志（{{ logCount }} 条）
              </div>
              <div v-if="result.logs && result.logs.length > 0" class="log-container">
                <div
                  v-for="(log, idx) in result.logs"
                  :key="idx"
                  class="log-line"
                  :class="{ 'log-error': log.phase === 'error' }"
                >
                  <span class="log-time">{{ formatTime(log.timestamp) }}</span>
                  <NTag :type="phaseTagType(log.phase)" size="tiny" style="min-width: 40px; justify-content: center;">
                    {{ phaseLabel(log.phase) }}
                  </NTag>
                  <span v-if="log.iteration > 0" class="log-iter">#{{ log.iteration }}</span>
                  <span class="log-msg">{{ log.message }}</span>
                  <span v-if="log.durationMs != null" class="log-duration">
                    [{{ log.durationMs }}ms]
                  </span>
                </div>
              </div>
              <NEmpty v-else description="无日志" style="padding: 24px 0" />
            </div>

            <!-- 查询结果区 -->
            <div class="detail-section">
              <div class="detail-title">查询结果输出（按迭代折叠）</div>
              <NCollapse v-if="queryResultCollapseItems.length > 0" accordion>
                <NCollapseItem
                  v-for="item in queryResultCollapseItems"
                  :key="item.qr.iteration"
                  :name="String(item.qr.iteration)"
                >
                  <template #header>
                    <NSpace :size="6" align="center">
                      <NTag
                        :type="item.qr.success ? 'success' : 'error'"
                        size="small"
                      >
                        {{ item.qr.success ? '成功' : '失败' }}
                      </NTag>
                      <span>{{ item.title }}</span>
                    </NSpace>
                  </template>

                  <div v-if="item.qr.items.length > 0">
                    <NTable size="small" :bordered="true" :single-line="false">
                      <thead>
                        <tr>
                          <th style="width: 60px">#</th>
                          <th style="width: 80px">score</th>
                          <th style="width: 150px">file</th>
                          <th style="width: 120px">title</th>
                          <th>snippet</th>
                          <th style="width: 60px">line</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="(it, i) in item.qr.items" :key="i">
                          <td>{{ i + 1 }}</td>
                          <td>
                            <NTag
                              v-if="it.score != null"
                              :type="it.score >= 0.5 ? 'success' : it.score >= 0.3 ? 'warning' : 'default'"
                              size="small"
                            >
                              {{ (it.score * 100).toFixed(0) }}%
                            </NTag>
                            <span v-else>-</span>
                          </td>
                          <td class="mono-cell">{{ it.file || '-' }}</td>
                          <td>{{ it.title || '-' }}</td>
                          <td class="snippet-cell">{{ it.snippet || '-' }}</td>
                          <td>{{ it.line ?? '-' }}</td>
                        </tr>
                      </tbody>
                    </NTable>
                  </div>
                  <NEmpty v-else description="无查询结果" style="padding: 16px 0" />
                </NCollapseItem>
              </NCollapse>
              <NEmpty v-else description="无查询结果" style="padding: 24px 0" />
            </div>
          </NSpace>
        </NTabPane>
      </NTabs>
    </NCard>

    <!-- 空状态提示 -->
    <NCard v-else size="small" :bordered="true">
      <NEmpty description="配置测试参数后点击「开始测试」" style="padding: 48px 0">
        <template #extra>
          <span class="muted">
            <template v-if="mode === 'rest'">
              REST 模式：直接 POST /query，统计查询延迟并输出交互日志与查询结果
            </template>
            <template v-else>
              MCP 模式：stateless 直接 tools/call "query"，统计查询延迟并输出交互日志与查询结果
            </template>
          </span>
        </template>
      </NEmpty>
    </NCard>
  </NSpace>
</template>

<style scoped>
.section-header {
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
.form-label-suffix {
  font-size: var(--fs-caption);
  color: var(--color-text-secondary);
}
.mode-hint {
  margin-top: 4px;
  line-height: 1.5;
}
.stats-grid {
  padding: 12px;
  background: var(--color-bg-secondary);
  border-radius: var(--radius-md);
}
.detail-section {
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
  color: var(--color-danger);
  font-size: var(--fs-caption);
  word-break: break-all;
}
.interpretation-hint {
  padding: 8px 12px;
  background: var(--color-bg-secondary);
  border-radius: var(--radius-sm);
  font-size: var(--fs-caption);
  line-height: 1.6;
}
.muted {
  color: var(--color-text-secondary);
  font-size: var(--fs-caption);
}

/* 日志区样式 */
.log-container {
  max-height: 500px;
  overflow-y: auto;
  background: var(--color-bg-secondary);
  border-radius: var(--radius-md);
  padding: 8px 12px;
  font-family: var(--font-family-mono);
  font-size: 12px;
  line-height: 1.8;
}
.log-line {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 0;
}
.log-error {
  color: var(--color-danger);
}
.log-time {
  color: var(--color-text-secondary);
  white-space: nowrap;
  flex-shrink: 0;
}
.log-iter {
  color: var(--color-primary, #2080f0);
  font-weight: 600;
  flex-shrink: 0;
  min-width: 30px;
}
.log-msg {
  flex: 1;
  word-break: break-all;
}
.log-duration {
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

/* 查询结果表格 */
.mono-cell {
  font-family: var(--font-family-mono);
  font-size: var(--fs-caption);
  word-break: break-all;
}
.snippet-cell {
  font-size: var(--fs-caption);
  word-break: break-all;
  max-width: 400px;
}
</style>
