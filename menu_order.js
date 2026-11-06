// 本包右键菜单的显示顺序。上下调整 ID 即可排序；显示文字由各功能维护。
export const MENU_ORDER = Object.freeze([
  "canvas-background", // 画布背景
  "graph-layout", // 整理节点
  "viewport-origin", // 视窗回归原点
  "workflow-sync", // 检查/同步后端工作流文件
  "workflow-differences", // 查看未保存差异
]);
