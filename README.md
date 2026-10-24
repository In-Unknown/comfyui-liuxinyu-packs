# liuxinyu 节点包使用说明

在 ComfyUI 添加节点的搜索框中输入下表的中文名称。更新 Python 节点后重启 ComfyUI，更新界面脚本后刷新浏览器。文档里的箭头表示端口连线，示例文字不是可直接导入的工作流文件。

## 按任务查找

| 我想做什么 | 从这里开始 |
| --- | --- |
| 多个详情页各自加载、拼接，避免混成一张 | [分包子流：接线与使用场景](docs/LiuxinyuPacketStart.md) |
| 弄清数组、执行列表、图片批次的区别 | [数据形式入门](docs/DataLists.md) |
| 长图先观察，再按比例位置正式裁切 | [切分预览、边界检查、最终切分](docs/SplitPreview.md) |
| 将 LLM 的 JSON 文本交给切分节点 | [字符串转为字面量：两个输出怎么选](docs/LiuxinyuStringToLiteral.md) |
| 把几个数字放进一个数组 | [多个数值组成数组](docs/LiuxinyuNumberArray.md) |
| 将一个任意值重复 N 次供下游处理 | [批量任意为执行列表](docs/LiuxinyuRepeatAnyToExecutionList.md) |
| 查看宽高、颜色数量、明暗范围 | [图片信息节点](docs/LiuxinyuImageInfo.md) |
| 读取或修改像素，进行数学计算 | [像素与数学节点](docs/PixelMath.md) |
| 查看长图、挑选图片保存 | [预览超长图片](docs/LiuxinyuPreviewLongImage.md) · [选择保存](docs/SaveSelectedFromBatch.md) |
| 找目录、组合路径、筛选图片文件 | [加载目录](docs/LoadDirectory.md) · [相对路径](docs/ResolveRelativePath.md) · [目录匹配](docs/MatchPath.md) |
| 从路径加载图片 | [加载图像](docs/LoadImageFromPath.md) · [加载图片批次](docs/LoadImageBatchFromPath.md) |
| 了解重复运行为什么没有重新保存或计算 | [临时缓存](docs/ImageCache.md) |
| 执行 cmd 命令 | [运行 cmd 命令](docs/RunCmd.md) |

第一次做多目录详情页，建议依次阅读“数据形式入门 → 分包子流 → 长图切分”。先用两个目录、每个目录两三张图确认结果，再扩大数量。

## 开发者说明

[公共流畅预览](docs/SmoothImagePreview.md) 和 [缩略图排列规则](docs/ThumbnailGrid.md) 说明预览组件的接入方法。普通用户无需配置这些组件。
