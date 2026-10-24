# 可复用的图片预览基底

入口是 `smooth_image_grid.js`；交互与图片资源逻辑在 `smooth_preview.js`。
目前「从批次中选择保存图片」和「GPT Image 2 · 中转站图片编辑」使用公共网格，
「预览超长图片」复用公共缩放控制器和清晰图恢复队列，保留自己的裁切网格与单图图块浏览。

## 交互和清晰度

- 画布滚轮事件在捕获阶段切低清；从 DOM 预览转发滚轮时，也先通知所有预览再调用画布缩放。
- 缩放、画布平移和节点位置变化期间隐藏清晰层，只画预先准备的小图。停稳 250 毫秒后开始恢复。
- 恢复队列跨节点共用。按图片与画布可见视窗中心的距离排序，最多同时加载两张；画布外或被预览容器裁掉的图片不加载高清。缓存中的清晰图也分批恢复。
- 清晰度按图片实际显示宽度 × 画布缩放 × 屏幕像素比选择。取能覆盖该像素需求的最小档，最高恢复到源图能提供的细节。不能创造源图本来没有的像素。
- 恢复任务开始时才启动高清加载；再次缩放会取消尚未启动的任务。已经在加载的图片完成后也不能在交互期间自行切回高清。
- 清晰层与低清层互斥显示，透明图不会叠加两次。不要对整张高清图使用 CSS 高斯模糊来代替真正的小图。
- 异步加载的有效性以当前图库条目为准，不能比较工作流输出元数据的对象身份：恢复工作流时元数据可能被重新包装。加载回调必须先结清等待任务，再判断是否显示；销毁条目也必须结清，避免占满共用的两个加载名额。
- 布局用原图尺寸，与当前清晰度档位无关。缩放只改变绘制来源，不重新计算列数；容器调整尺寸时由 ResizeObserver 同步排版。

## 最少接入：普通图库

```js
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { attachSmoothImagePreview } from "./smooth_image_grid.js";

// 在目标节点创建后调用一次。不要给所有节点统一挂载。
const gallery = attachSmoothImagePreview(node, app, api);

// 普通 onExecuted 的 ui.images 自动接入。
// 分批实时预览可以直接更新，无需伪造 executed 事件：
gallery.setImages(images);
```

这个适配器添加零边距、可拖动调整尺寸的 DOM 控件，接管该节点的图片背景绘制，
保留原有 onExecuted / onRemoved 回调，删除节点时释放图片、计时器、观察器和待执行任务。
单击图片在节点里放大，左右键切图，Esc 或按钮返回网格，双击用原图地址打开图片。
接管后不要再调用核心的图片背景加载器，否则隐藏的原生图库仍可能解码整批原图。
原生执行输出和 IMAGE 张量不由这个图库修改。

GPT Image 2 的接入位于 `comfyui_mxwq_gpt_image/web/edit_preview.js`。
它可选导入 `/extensions/comfyui-liuxinyu-packs/smooth_image_grid.js`，并把实时生成的文件描述符交给图库；
没有安装 liuxinyu 包时仍使用原生预览。
若要把基底独立移植到其他包，可复制四个模块并保留相对导入：
`smooth_preview.js`、`smooth_image_grid.js`、`thumbnail_grid.js`、`preview_resize.js`。

## 自带选择等操作的节点

```js
const gallery = new SmoothImageGrid(container, app, api, {
  onClick(index) { /* 更新节点自己的选择值 */ },
});
gallery.setImages(ui.images);

// 每个 cell 内可以追加绝对定位的选择蒙层，不要给格子增加内边距。
for (const { cell } of gallery.entries) { /* 更新选择样式 */ }

// DOM widget 的 onDraw 与节点背景回调中调用；仍须停用重复的原生图片加载。
gallery.draw(String(node.pos));
// afterResize 可调用 gallery.layout()；它会复用观察器计算过的布局。
// 节点删除时必须调用：
gallery.dispose();
```

选择、保存目录、输出张量、执行进度属于调用节点，不放入通用图库。
重复的相同文件描述符不会重建图片；进度输出不断追加图片时复用已有的 DOM 和已解码资源。

## 文件描述符

普通 ComfyUI 描述符即可工作：

```js
{ filename: "image.png", subfolder: "", type: "temp" }
```

没有预生成缩略图时，只在首次需要显示该图时加载原图，生成最长边 192 像素的低清画布。
停稳时按当前尺寸生成足够清晰的中间画布，档位逐级翻倍；需要原图细节时直接显示原图。
每张图保留原图、低清画布和一个当前清晰画布，改变尺寸时复用画布，而非无限累积多个档位。
这种兼容方式仍有首次原图解码的成本；超大图片应使用后端小图或可见图块。

后端可以提供下面的额外信息，避免首次加载原图，并在解码前完成准确排版：

```js
{
  filename: "original.png", subfolder: "", type: "temp",
  preview_size: [1600, 1200],
  display: { thumbnails: [
    { filename: "small.png", width: 192, height: 144 },
    { filename: "medium.png", width: 768, height: 576 },
    { filename: "native.png", width: 1600, height: 1200 }
  ] }
}
```

数组按分辨率递增，PNG 保留透明度。预览用小文件，保存动作仍读取 `filename` 对应的原文件。
文件名或子目录必须在图像内容改变时变化；稳定 URL 才能可靠复用浏览器缓存。
liuxinyu 后端生成的所有派生文件通过 `preview_path()` 注册进现有临时缓存事务，同输入复用、输入变更清理。

长图取景预览额外提供原尺寸裁切图，避免网格放大后受 768 像素上限限制。
旧结果缺少这个档位时可以用原图恢复清晰；重新执行长图预览后会改用更小的原尺寸裁切文件。
长图单图浏览继续用 `long_preview_tiles.js`，只请求可见范围与相邻图块。

## 排列与边缘贴合

`layoutThumbnailGrid` 调用 ComfyUI 官方列数搜索，允许最后一行不满；质数数量不会被强迫排成一条。
同一比例的图片共用小数格线，`gap: 0`、DOM widget `margin: 0`、格子 `padding: 0`，不逐格取整。
符合容器和图片比例时自然贴边；保持等比时的合法留白不能靠拉伸或裁切消除。
混合比例的普通图片在格内 contain 居中；长图裁切缩略图用 `layoutThumbnailRows` 的等高、变宽排列，
避免正方形格子产生额外间隙。具体算法见 [ThumbnailGrid.md](ThumbnailGrid.md)。

透明的底角拖动区域由 `enablePreviewResize` 提供，避免零边距 DOM 覆盖画布的尺寸调整命中区。
不要用容器缩放后的屏幕尺寸重新排版；屏幕边界测量只用于停稳后的加载优先级。

## 检查

`tests/test_smooth_preview.cjs` 验证中心优先、屏外不加载、按缩放恢复原图细节、
100 次交互期间不重新采样、增量结果复用、平移、单图返回和回调清理。
`test_long_preview_lifecycle.cjs` 和 `test_long_preview_tiles.cjs` 覆盖长图原有行为，以及工作流恢复时元数据重新包装、高清恢复和共用队列释放。
这些是逻辑和调度测试；流畅度、连续拖动和边缘观感由用户在实际画布验收。
