/**
 * naive-ui 主题覆盖 + ECharts 配色导出。
 *
 * - lightThemeOverrides / darkThemeOverrides：与 tokens.css 色板对齐
 * - echartsThemeColors / echartsDarkThemeColors：8 色调色板 + 坐标轴/tooltip/legend 样式
 *
 * 在 App.vue 中通过 <NConfigProvider :theme-overrides="lightThemeOverrides"> 注入。
 * ECharts 图表可通过 echartsThemeColors 直接引用。
 *
 * v2.3.3 色温系统：中性色全部混入品牌色温度（冷色品牌，偏蓝），不再使用纯白/纯灰。
 */
import type { GlobalThemeOverrides } from 'naive-ui';

/**
 * 亮色主题覆盖。
 *
 * 关键：primary/success/warning/error/info 与 tokens.css 完全对齐，
 * naive-ui 自带 hover/pressed/suppl 由框架派生，此处只覆盖基色。
 * v2.3.3：表面色从纯白 #ffffff 改为染色表面（白 + 1.5% 蓝），文字/边框/分割线偏品牌蓝。
 */
export const lightThemeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#2080f0',
    primaryColorHover: '#4098fc',
    primaryColorPressed: '#1060c5',
    primaryColorSuppl: 'rgba(32, 128, 240, 0.12)',

    successColor: '#18a058',
    successColorHover: '#36ad6a',
    successColorPressed: '#0c7a43',
    successColorSuppl: 'rgba(24, 160, 88, 0.12)',

    warningColor: '#f0a020',
    warningColorHover: '#fcb040',
    warningColorPressed: '#c97c0a',
    warningColorSuppl: 'rgba(240, 160, 32, 0.12)',

    errorColor: '#d03050',
    errorColorHover: '#de5169',
    errorColorPressed: '#a8223c',
    errorColorSuppl: 'rgba(208, 48, 80, 0.12)',

    infoColor: '#7090c0',
    infoColorHover: '#8aa6cc',
    infoColorPressed: '#56709a',
    infoColorSuppl: 'rgba(112, 144, 192, 0.12)',

    // 文字：偏冷蓝灰（与 tokens.css --color-text-* 对齐）
    textColorBase: '#0f1520',
    textColor1: '#0f1520',
    textColor2: '#3a4560',
    textColor3: '#7a8ba0',

    // 表面：染色（白 + 1.5% 蓝），不再用纯白
    bodyColor: '#f4f6fa',       // 页面底色 = --color-bg-base
    cardColor: '#fafbfd',       // 卡片 = --color-surface
    modalColor: '#fafbfd',
    popoverColor: '#fafbfd',
    tableColor: '#fafbfd',
    tableHeaderColor: '#edf0f7', // 表头 = --color-surface-2

    // 边框/分割线：偏品牌蓝
    borderColor: '#e4e8f5',      // = --color-border
    dividerColor: '#e4e8f5',    // = --color-divider（原 #f2f3f5 偏中性）

    borderRadius: '6px',
    borderRadiusSmall: '4px',

    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif',
    fontFamilyMono:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: '14px',
    fontSizeSmall: '13px',
  },
  Card: {
    titleFontSizeSmall: '14px',
    paddingSmall: '12px 16px',
    borderRadius: '8px',
    // 卡片使用染色阴影（带品牌色温度 + 发丝边框）
    color: '#fafbfd',
  },
  Button: {
    borderRadiusMedium: '6px',
    borderRadiusSmall: '4px',
  },
  Input: {
    borderRadius: '6px',
  },
  DataTable: {
    borderRadius: '8px',
    fontSizeSmall: '13px',
    thColor: '#edf0f7',         // 偏蓝表头（原 #f7f8fa）
    thTextColor: '#3a4560',      // 偏蓝灰（原 #4e5969）
  },
};

/**
 * 暗色主题覆盖（S3 启用）。
 *
 * 注意：useTheme 中 `{ ...lightThemeOverrides, ...darkThemeOverrides }` 是浅合并，
 * 因此 darkThemeOverrides 必须显式覆盖 light 中所有需要变更的组件级配置
 * （如 DataTable.thColor），否则亮色字面值会穿透到暗色模式。
 *
 * v2.3.3：暗色表面改用偏蓝深色（原 #1f1f24 偏中性），与 tokens.css 对齐。
 */
export const darkThemeOverrides: GlobalThemeOverrides = {
  common: {
    // 表面：偏蓝深色（原 #18181c/#1f1f24 偏中性）
    bodyColor: '#14171f',       // = --color-bg-base dark
    cardColor: '#1a1e2a',       // = --color-surface dark
    modalColor: '#1a1e2a',
    popoverColor: '#1a1e2a',
    tableColor: '#1a1e2a',
    tableHeaderColor: '#232838', // = --color-surface-2 dark

    textColorBase: 'rgba(255, 255, 255, 0.92)',
    textColor1: 'rgba(255, 255, 255, 0.92)',
    textColor2: 'rgba(255, 255, 255, 0.72)',
    textColor3: 'rgba(255, 255, 255, 0.52)',

    borderColor: 'rgba(255, 255, 255, 0.12)',
    dividerColor: 'rgba(255, 255, 255, 0.10)',
  },
  Card: {
    color: '#1a1e2a',
  },
  DataTable: {
    // 显式覆盖亮色 thColor，避免浅合并穿透导致暗色表头呈浅灰
    thColor: '#232838',
    thTextColor: 'rgba(255, 255, 255, 0.72)',
  },
};

/**
 * ECharts 8 色调色板（与 naive-ui 语义色对齐）。
 *
 * 用法：在 EChart option 中设置 color: echartsThemeColors。
 */
export const echartsThemeColors: string[] = [
  '#2080f0', // primary
  '#18a058', // success
  '#f0a020', // warning
  '#d03050', // error
  '#7090c0', // info
  '#7c3aed', // purple (扩展)
  '#0ea5e9', // sky (扩展)
  '#f59e0b', // amber (扩展)
];

export const echartsDarkThemeColors: string[] = [
  '#4098fc',
  '#36ad6a',
  '#fcb040',
  '#de5169',
  '#8aa6cc',
  '#9270ed',
  '#38bdf8',
  '#fbbf24',
];

/**
 * ECharts 基础 option 片段：坐标轴 / tooltip / legend 样式。
 *
 * 用法：在 computed option 中展开 `...echartsBaseOption`，再合并 series。
 *
 * 注：axisLabel/legend fontSize 最小 12px，对齐 tokens.css 的 --fs-caption
 * （WCAG 1.4.4 最小字号要求）。
 * v2.3.3：坐标轴/legend 字色对齐染色 token（偏蓝灰），splitLine 偏蓝。
 */
export const echartsBaseOption = {
  textStyle: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  tooltip: {
    backgroundColor: 'rgba(15, 21, 32, 0.92)',  // 偏蓝深色（原 rgba(31,35,41,0.92)）
    borderWidth: 0,
    textStyle: { color: '#fff', fontSize: 12 },
  },
  legend: {
    textStyle: { color: '#3a4560', fontSize: 12 },  // 偏蓝灰（原 #4e5969）
    icon: 'roundRect',
    itemWidth: 12,
    itemHeight: 8,
  },
  xAxis: {
    axisLine: { lineStyle: { color: '#e4e8f5' } },  // 偏蓝（原 #e5e6eb）
    axisLabel: { color: '#7a8ba0', fontSize: 12 },   // 冷灰蓝（原 #86909c 弃用色）
    splitLine: { show: false },
  },
  yAxis: {
    axisLine: { show: false },
    axisLabel: { color: '#7a8ba0', fontSize: 12 },
    splitLine: { lineStyle: { color: '#e4e8f5', type: 'dashed' } },  // 偏蓝（原 #f2f3f5）
  },
};

/**
 * ECharts 暗色基础 option 片段。
 *
 * 与 echartsDarkThemeColors 配套使用：暗色模式下坐标轴/splitLine/legend/tooltip
 * 需切换为浅色字面值（ECharts 不支持 CSS var()，必须字面量）。
 *
 * 字色与 tokens.css [data-theme="dark"] 对齐：
 *   - 主文本 rgba(255,255,255,0.92) = --color-text-primary
 *   - 次文本 rgba(255,255,255,0.72) = --color-text-secondary
 *   - 三级 rgba(255,255,255,0.52) = --color-text-tertiary
 *   - 边框 rgba(255,255,255,0.12) = --color-border
 *   - 分隔线 rgba(255,255,255,0.10) = --color-divider
 */
export const echartsDarkBaseOption = {
  textStyle: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  tooltip: {
    backgroundColor: 'rgba(26, 30, 42, 0.92)',  // 偏蓝深色（原 rgba(50,50,55,0.92)）
    borderWidth: 0,
    textStyle: { color: '#fff', fontSize: 12 },
  },
  legend: {
    textStyle: { color: 'rgba(255, 255, 255, 0.72)', fontSize: 12 },
    icon: 'roundRect',
    itemWidth: 12,
    itemHeight: 8,
  },
  xAxis: {
    axisLine: { lineStyle: { color: 'rgba(255, 255, 255, 0.12)' } },
    axisLabel: { color: 'rgba(255, 255, 255, 0.52)', fontSize: 12 },
    splitLine: { show: false },
  },
  yAxis: {
    axisLine: { show: false },
    axisLabel: { color: 'rgba(255, 255, 255, 0.52)', fontSize: 12 },
    splitLine: { lineStyle: { color: 'rgba(255, 255, 255, 0.10)', type: 'dashed' } },
  },
};
