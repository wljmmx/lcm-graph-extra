/**
 * naive-ui 主题覆盖 + ECharts 配色导出。
 *
 * - lightThemeOverrides / darkThemeOverrides：与 tokens.css 色板对齐
 * - echartsThemeColors / echartsDarkThemeColors：8 色调色板 + 坐标轴/tooltip/legend 样式
 *
 * 在 App.vue 中通过 <NConfigProvider :theme-overrides="lightThemeOverrides"> 注入。
 * ECharts 图表可通过 echartsThemeColors 直接引用。
 */
import type { GlobalThemeOverrides } from 'naive-ui';

/**
 * 亮色主题覆盖。
 *
 * 关键：primary/success/warning/error/info 与 tokens.css 完全对齐，
 * naive-ui 自带 hover/pressed/suppl 由框架派生，此处只覆盖基色。
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

    textColorBase: '#1f2329',
    textColor1: '#1f2329',
    textColor2: '#4e5969',
    textColor3: '#86909c',

    bodyColor: '#ffffff',
    cardColor: '#ffffff',
    modalColor: '#ffffff',
    popoverColor: '#ffffff',

    borderColor: '#e5e6eb',
    dividerColor: '#f2f3f5',

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
    thColor: '#f7f8fa',
    thTextColor: '#4e5969',
  },
};

/**
 * 暗色主题覆盖（S3 启用，预留）。
 */
export const darkThemeOverrides: GlobalThemeOverrides = {
  common: {
    bodyColor: '#18181c',
    cardColor: '#1f1f24',
    modalColor: '#1f1f24',
    popoverColor: '#1f1f24',

    textColorBase: 'rgba(255, 255, 255, 0.92)',
    textColor1: 'rgba(255, 255, 255, 0.92)',
    textColor2: 'rgba(255, 255, 255, 0.72)',
    textColor3: 'rgba(255, 255, 255, 0.52)',

    borderColor: 'rgba(255, 255, 255, 0.12)',
    dividerColor: 'rgba(255, 255, 255, 0.08)',
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
 */
export const echartsBaseOption = {
  textStyle: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  tooltip: {
    backgroundColor: 'rgba(31, 35, 41, 0.92)',
    borderWidth: 0,
    textStyle: { color: '#fff', fontSize: 12 },
  },
  legend: {
    textStyle: { color: '#4e5969', fontSize: 12 },
    icon: 'roundRect',
    itemWidth: 12,
    itemHeight: 8,
  },
  xAxis: {
    axisLine: { lineStyle: { color: '#e5e6eb' } },
    axisLabel: { color: '#86909c', fontSize: 11 },
    splitLine: { show: false },
  },
  yAxis: {
    axisLine: { show: false },
    axisLabel: { color: '#86909c', fontSize: 11 },
    splitLine: { lineStyle: { color: '#f2f3f5', type: 'dashed' } },
  },
};
