# ComfyUI liuxinyu 节点包

面向日常工作流的图片、长图、文件路径、字符串、数学和分包子流工具。适合多目录详情页整理、长图切分与拼接、批次图片挑选保存、提示词组合，以及把多步处理限制在同一个对象范围内。

当前包含 **61 个用户节点**，另有 **5 个由分包与条件循环功能自动创建的内部节点**。下方按用途完整列出名称、用途和节点 ID。中文名称可直接在 ComfyUI 添加节点的搜索框中查找，ID 用于识别 API 工作流和错误报告。

## 阅读导航

- [环境与兼容范围](#环境与兼容范围)
- [安装与更新](#安装与更新)
- [快速上手](#快速上手)
- [全部节点目录](#全部节点目录)
- [数组、执行列表和图片批次](#数组执行列表和图片批次)
- [典型工作流与分包使用场景](#典型工作流与分包使用场景)
- [缓存、预览与文件保存](#缓存预览与文件保存)
- [常见问题排查](#常见问题排查)
- [开发与问题反馈](#开发与问题反馈)

## 环境与兼容范围

| 项目 | 要求或范围 |
| --- | --- |
| ComfyUI | 需要较新的后端及配套前端，支持 `comfy_api.latest`、V3 节点、Autogrow 动态输入。分包还使用原生循环边界和执行调度接口，旧版可能无法加载或执行。 |
| 当前核对环境 | Windows，ComfyUI **0.38.0**（核心提交 `6b747c04`），Python **3.13.14**，PyTorch **2.14.0+cu130**。这是当前核对环境，不是经过兼容性测试得出的最低版本。 |
| Python 依赖 | 复用 ComfyUI 环境中的 PyTorch、NumPy、Pillow、aiohttp。当前包没有独立 `requirements.txt`，正常 ComfyUI 环境无需另装模型或 API SDK；仅「结构化数据变换（JSONata）」需要额外安装 `jsonata-python==0.6.3`。 |
| 浏览器 | 使用与 ComfyUI 配套的现代浏览器前端。动态端口、图片预览和遮罩编辑器均依赖前端脚本，更新 JS 后需要刷新浏览器。 |
| Windows 专用功能 | 文件/目录选择按钮使用 Windows 原生对话框；“排序字符串数组”的中文拼音排序使用 Windows API；“运行cmd命令”调用 `cmd.exe`。 |
| Linux、macOS、无桌面环境 | 未完成跨平台全量验证，不承诺全功能兼容。可手动输入服务器路径；Windows 选择器、中文拼音排序、cmd 节点不能按 Windows 方式使用。 |
| 计算资源 | 本包不加载生成模型，也不要求独立 API Key。超长图、颜色统计和大规模排列组合可能占用大量内存；下游模型的显卡要求由下游决定。 |

**路径和对话框属于运行 ComfyUI 的电脑。** 在另一台电脑的浏览器访问 ComfyUI，不会让服务器读取浏览器所在电脑的磁盘；文件选择窗口也出现在服务器桌面。

## 安装与更新

### 安装

在 `ComfyUI/custom_nodes` 目录打开终端：

```shell
git clone https://github.com/In-Unknown/comfyui-liuxinyu-packs.git
```

也可下载 ZIP，解压为 `ComfyUI/custom_nodes/comfyui-liuxinyu-packs`。确认目录中直接包含 `__init__.py`，不要多嵌套一层同名文件夹。目录名建议保持不变，部分公共预览资源按此路径引用。

安装后重启 ComfyUI，再刷新浏览器。搜索“字符串转为字面量”或“预览超长图片”，确认节点已经加载。

### 更新

在本包目录运行：

```shell
git status --short
git pull --ff-only
```

如果第一步显示自己的修改，先备份或提交后再更新；提示分支分叉时先检查差异，不要直接强制覆盖。ZIP 安装不能直接 `git pull`，需备份本地修改后替换文件。

更新 Python 后重启 ComfyUI；更新 JS 后刷新浏览器，仍显示旧界面时再强制刷新。只修改 Markdown 帮助文档通常不需要重启后端。

## 快速上手

### 先确认文本节点能运行

1. 添加“字符串转为字面量”，填入 `["苹果", "香蕉"]`。
2. 将第一个 **字面量** 输出连接到“预览参数组合或字符串数组”。
3. 运行，预览中应能看到两项文本，先确认安装和显示正常。

### 查看一张图片或长图

```text
从路径加载图片 → 预览超长图片
```

填写 ComfyUI 所在电脑上的图片绝对路径，或在 Windows 桌面使用选择按钮。运行后点击缩略图进入单图查看；超长或超宽内容可滚动查看。预览不等于永久保存，需要保存时另接保存节点。

本文箭头表示端口连线，**不是可直接导入的工作流 JSON**。表格中的链接提供详细参数说明；已有节点帮助页也可从“选中节点 → 属性面板 → 信息”打开。

## 全部节点目录

按用途归类，实际添加菜单可能位于 `image`、`utils` 或 `liuxinyu/流程控制` 等分类。每个用户节点仅列一次。

| 分类 | 数量 | 主要用途 |
| --- | ---: | --- |
| [路径、加载与保存](#路径加载与保存8个) | 8 | 查找素材、读取图片、按路径保存 |
| [图片预览、拼接与合成](#图片预览拼接与合成4个) | 4 | 浏览长图、拼图、蒙版与组合 |
| [长图切分](#长图切分3个) | 3 | 观察切点、检查边界、正式裁切 |
| [图片信息与像素](#图片信息与像素3个) | 3 | 图像统计、像素读写 |
| [字符串与模板](#字符串与模板12个) | 12 | 文本拆合、排序、组合及预览 |
| [类型转换、数组与执行列表](#类型转换数组与执行列表12个) | 12 | JSON、字面量、数字，执行列表收集、顺合与 JSONata 变换 |
| [数学与函数采样](#数学与函数采样11个) | 11 | 多输入计算、整数运算与数列 |
| [分包子流与条件循环](#分包子流与条件循环5个) | 5 | 逐个对象独立处理，或比较数据并按条件反复更新 |
| [任务内存控制](#任务内存控制2个) | 2 | 暂停或恢复当前任务的逐步 RAM 检查与回收 |
| [系统命令](#系统命令1个) | 1 | 在 Windows 主机运行 cmd |

### 路径、加载与保存（8个）

| 节点 | 用途与关键行为 | 节点 ID |
| --- | --- | --- |
| [加载路径](docs/LoadPath.md) | 选取文件，输出完整路径、文件名、无后缀文件名及后缀；图片可显示预览。 | `LoadPath` |
| [加载目录](docs/LoadDirectory.md) | 输入或选择目录，输出完整路径、文件夹名和父目录。 | `LoadDirectory` |
| [在绝对路径中的相对路径](docs/ResolveRelativePath.md) | 组合根目录与相对路径，处理 `.`、`..`；仅计算路径，不验证文件存在。 | `ResolveRelativePath` |
| [从目录中匹配路径或目录](docs/MatchPath.md) | 按包含文本、正则或文件属性筛选文件/目录，支持递归；输出路径执行列表。 | `MatchPath` |
| [从路径加载图片](docs/LoadImageFromPath.md) | 读取单张图片，输出 IMAGE、宽度、高度。 | `LoadImageFromPath` |
| [从路径加载图像批次](docs/LoadImageBatchFromPath.md) | 读取单文件、目录或多文件 CSV，统一成同尺寸 IMAGE 批次。 | `LoadImageBatchFromPath` |
| [保存图像到绝对路径](docs/SaveImageToAbsolutePath.md) | 保存单张或批次，支持覆盖策略；批次写入同名子文件夹。 | `SaveImageToAbsolutePath` |
| [从批次中选择保存图片](docs/SaveSelectedFromBatch.md) | 预览并手选，或传入从 0 开始的多选序列；保存时按序号追加文件。 | `SaveSelectedFromBatch` |

### 图片预览、拼接与合成（4个）

| 节点 | 用途与关键行为 | 节点 ID |
| --- | --- | --- |
| [预览超长图片](docs/LiuxinyuPreviewLongImage.md) | 缩略图网格与可滚动单图；缩放/平移时优先小图，停稳后恢复当前尺度的清晰度。 | `LiuxinyuPreviewLongImage` |
| [从批次列表拼接图片](docs/LiuxinyuStitchImageBatchList.md) | 收取整个图片执行列表；横拼统一高度、竖拼统一宽度，无间隔；超过所选格式单边上限时分段输出，本节点不保存文件。 | `LiuxinyuStitchImageBatchList` |
| [遮罩区域图片排列组合](docs/ImageMaskCombinations.md) | 对同尺寸候选图穷举有序对，以一张作底、另一张填充蒙版区域，输出合成批次及组合索引。 | `ImageMaskCombinations` |
| [绘制蒙版绘制画笔于比例图像](docs/LiuxinyuRatioPaint.md) | 使用官方遮罩编辑器；底图改变但比例不变时复用并缩放画笔/蒙版，输出带笔迹图和 MASK。 | `LiuxinyuRatioPaint` |

### 长图切分（3个）

| 节点 | 用途与关键行为 | 节点 ID |
| --- | --- | --- |
| [切分预览（自动切块）](docs/LiuxinyuSplitLook.md) | 按“每块切分距离”切块，可设像素重叠；附带位置刻度，输出图片执行列表。 | `LiuxinyuSplitLook` |
| [切分检查图（边界放大）](docs/LiuxinyuSplitBoundaryPreview.md) | 按切点生成检查图，放大切线附近区域，便于避开文字和主体。 | `LiuxinyuSplitBoundaryPreview` |
| [最终切分（按边界）](docs/LiuxinyuSplitSegments.md) | 按整图比例切点输出无标尺、无标签的纯图片执行列表。 | `LiuxinyuSplitSegments` |

三个节点均支持上下或左右切分。边界只采用 `[0.1, 0.2]` 或 `[{"percent": 10}, {"percent": 20}]`；都表示整图 **10%、20% 的位置**，不是每段各占多少。详见[切分总说明](docs/SplitPreview.md)。

### 图片信息与像素（3个）

| 节点 | 用途与关键行为 | 节点 ID |
| --- | --- | --- |
| [图片信息节点](docs/LiuxinyuImageInfo.md) | 逐图输出宽高、不同 RGB 颜色数、明度中位数/极值及各通道极值；明度为 `0.299R + 0.587G + 0.114B`，范围 0～255。 | `LiuxinyuImageInfo` |
| [读取图片像素 RGB](docs/LiuxinyuReadPixel.md) | 按 X/Y 读取所有输入图片同一位置，输出 R/G/B 数值执行列表，范围 0～255。 | `LiuxinyuReadPixel` |
| [修改图片像素 RGB](docs/LiuxinyuWritePixel.md) | 按 X/Y 改色；Z 不连接时对全部图片生效，连接时只修改指定索引图片。坐标与索引从 0 开始。 | `LiuxinyuWritePixel` |

### 字符串与模板（12个）

| 节点 | 用途与关键行为 | 节点 ID |
| --- | --- | --- |
| [从文本文件中获取字符串](docs/LiuxinyuLoadTextFile.md) | 读取文本并输出字符数、行数；识别 UTF-8、带 BOM 的 UTF-16/32，兼容 GB18030，保留空格和换行。 | `LiuxinyuLoadTextFile` |
| [动态多块多行字符串](docs/LiuxinyuDynamicMultilineText.md) | 增加独立文本块，每路有自己的输入输出，连接上游时使用上游文本。 | `LiuxinyuDynamicMultilineText` |
| [字符串拼接](docs/LiuxinyuStringConcatenate.md) | 按输入顺序直接拼接，不加分隔符，输入口随连接增加。 | `LiuxinyuStringConcatenate` |
| [切分字符串为数组](docs/LiuxinyuStringArraySplit.md) | 按完整分隔文本切分，可保留分隔符及空元素；不是正则切分。 | `LiuxinyuStringArraySplit` |
| [组装字符串为字符串数组](docs/LiuxinyuStringArrayBuild.md) | 按输入顺序收集，已有字符串列表展开合并，输出供下游逐项处理。 | `LiuxinyuStringArrayBuild` |
| [从字符串数组读取字符串](docs/LiuxinyuStringArrayGet.md) | 以从 0 开始的下标读取一项，越界报错。 | `LiuxinyuStringArrayGet` |
| [拼装字符串数组为字符串](docs/LiuxinyuStringArrayJoin.md) | 将收到的字符串列表整体按顺序拼成一个字符串，不加分隔符。 | `LiuxinyuStringArrayJoin` |
| [排序字符串数组](docs/LiuxinyuStringArraySort.md) | 自然排序使 A9 排在 A10 前，中文使用 Windows 简体中文拼音排序，不去重。 | `LiuxinyuStringArraySort` |
| [字符串排列组合](docs/LiuxinyuStringCombinations.md) | 对多组候选求所有组合，输出 `t1`、`t2` 等参数；可按候选下标规则排除组合。 | `LiuxinyuStringCombinations` |
| [从模板生成文本](docs/LiuxinyuTextFromTemplate.md) | 替换 `{t1}`、`{t2}` 等占位符；接排列组合后逐条生成提示词。 | `LiuxinyuTextFromTemplate` |
| [预览参数组合或字符串数组](docs/LiuxinyuPreviewText.md) | 表格或文本方式浏览参数组合、字符串列表及单条文本，无输出。 | `LiuxinyuPreviewText` |
| [预览JS对象或数组](docs/LiuxinyuPreviewJSObject.md) | 树状展开对象/数组，查看类型、下标和值，可复制 JSON，无输出。 | `LiuxinyuPreviewJSObject` |

### 类型转换、数组与执行列表（12个）

| 节点 | 用途与关键行为 | 节点 ID |
| --- | --- | --- |
| [字符串转为字面量](docs/LiuxinyuStringToLiteral.md) | 解析数字、颜色、JSON 对象和数组等；“字面量”展开数组为执行列表，“完整字面量”保留整个数组/对象。 | `LiuxinyuStringToLiteral` |
| [字符串转为JS对象](docs/LiuxinyuStringToJSObject.md) | 解析标准 JSON，保留嵌套结构、布尔值和 null，不执行 JavaScript；数组整体输出。 | `LiuxinyuStringToJSObject` |
| [使用js点符号语句读取对象](docs/LiuxinyuReadJSObjectPath.md) | 用 `a.b[0]`、`[0]`、`["a.b"]` 等路径取值，数组支持 `length`，保留结果类型。 | `LiuxinyuReadJSObjectPath` |
| [js对象转换为字符串](docs/LiuxinyuJSObjectToString.md) | 字符串原样返回，对象、数组和参数组合转 JSON 文本，保留中文和结构。 | `LiuxinyuJSObjectToString` |
| [数字转换](docs/LiuxinyuNumberConvert.md) | 将数字、布尔值、数字字符串或一维数组转为浮点数及整数，数组逐项输出。 | `LiuxinyuNumberConvert` |
| [数字转换为字符串](docs/LiuxinyuNumberToString.md) | 将数字转为文本，不额外做四舍五入或补零。 | `LiuxinyuNumberToString` |
| [任意转换为字符串](docs/LiuxinyuAnyToString.md) | 使用 Python `str()` 将任意输入转为文本，字符串原样返回。 | `LiuxinyuAnyToString` |
| [多个数值组成数组](docs/LiuxinyuNumberArray.md) | 将动态数值输入组成完整数组；全为整数则保留整数，混入浮点数则统一为浮点数。 | `LiuxinyuNumberArray` |
| [批量任意为执行列表](docs/LiuxinyuRepeatAnyToExecutionList.md) | 将任意值整体重复 N 次，不拆图片批次、不深拷贝张量，N=0 输出空列表。 | `LiuxinyuRepeatAnyToExecutionList` |
| [执行列表收集为数组](docs/LiuxinyuCollectExecutionList.md) | 把完整执行列表收集为一个数组，保留顺序和嵌套数组，不展开数组元素。 | `LiuxinyuCollectExecutionList` |
| [顺合任意执行列表](docs/LiuxinyuConcatAnyExecutionLists.md) | 按输入口从上到下的顺序将各路执行列表首尾相接，保留内部顺序、重复项和类型，不递归拆分数组或图片批次；可串联继续顺合。 | `LiuxinyuConcatAnyExecutionLists` |
| [结构化数据变换（JSONata）](docs/LiuxinyuStructuredTransform.md) | 用 JSONata 表达式查询、分组、关联或变换 JSON 数据；输入经 data0、data1 等访问，可增至 100 路。需在 ComfyUI Python 中安装 `jsonata-python==0.6.3`。 | `LiuxinyuStructuredTransform` |

### 数学与函数采样（11个）

| 节点 | 用途与关键行为 | 节点 ID |
| --- | --- | --- |
| [多输入数学运算](docs/LiuxinyuMath.md) | 按指定方向两两累计，支持加减乘除、幂、根、对数、取模、取大/小等；平均、总体方差、标准差、中位数对全部输入一次计算。 | `LiuxinyuMath` |
| [数字取整](docs/LiuxinyuRound.md) | 四舍五入、向上、向下或截断；四舍五入在恰好一半时远离零，如 -2.5→-3。 | `LiuxinyuRound` |
| [阶乘](docs/LiuxinyuFactorial.md) | 非负整数阶乘，0!=1。 | `LiuxinyuFactorial` |
| [最小公倍数](docs/LiuxinyuLCM.md) | 计算多个整数的最小公倍数。 | `LiuxinyuLCM` |
| [最大公因数](docs/LiuxinyuGCD.md) | 计算多个整数的最大公因数。 | `LiuxinyuGCD` |
| [最近素数](docs/LiuxinyuNearestPrime.md) | 查找最近素数，等距取较小值，小于 2 返回 2。 | `LiuxinyuNearestPrime` |
| [绝对值](docs/LiuxinyuAbsolute.md) | 返回输入数值的绝对值。 | `LiuxinyuAbsolute` |
| [取负](docs/LiuxinyuNegate.md) | 返回输入数值的相反数。 | `LiuxinyuNegate` |
| [三角与反三角函数](docs/LiuxinyuTrigonometry.md) | 三角或反三角函数，支持弧度/角度单位。 | `LiuxinyuTrigonometry` |
| [双曲与反双曲函数](docs/LiuxinyuHyperbolic.md) | 双曲或反双曲函数，输入需满足相应定义域。 | `LiuxinyuHyperbolic` |
| [函数生成精度数列](docs/LiuxinyuFunctionGrid.md) | 解析表达式和变量，按范围、间隔与小数位采样，输出多维数列和坐标；表达式中的三角函数使用弧度。 | `LiuxinyuFunctionGrid` |

### 分包子流与条件循环（5个）

| 节点 | 用途与关键行为 | 节点 ID |
| --- | --- | --- |
| [分包执行子流回归](docs/LiuxinyuPacketStart.md) | 按最长输入逐包发出，等待本包子流回归后再发下一包；当前轮次从 1 开始。 | `LiuxinyuPacketStart` |
| [回归分包子流条件](docs/LiuxinyuPacketEnd.md) | 等待本包所有接入分支完成，全部包结束后按包顺序汇总各路结果。 | `LiuxinyuPacketEnd` |
| [跳回点](docs/LiuxinyuReturnPoint.md) | 提供初始数据与调回句柄，将回归数据作为下一轮输入。 | `LiuxinyuReturnPoint` |
| [条件回归](docs/LiuxinyuConditionalReturn.md) | 按句柄复制数据端口与类型；true 携带本轮数据跳回再执行一轮，false 离开循环、输出本轮结果并执行下游。 | `LiuxinyuConditionalReturn` |
| [判断哈希相等](docs/LiuxinyuHashEqual.md) | 比较两份数据的类型、SHA-256、MD5 并精确复核内容，返回单个布尔值。 | `LiuxinyuHashEqual` |

### 任务内存控制（2个）

| 节点 | 用途与关键行为 | 节点 ID |
| --- | --- | --- |
| [当前忽略内存检查和回收](docs/LiuxinyuIgnoreMemoryChecks.md) | 等全部已连接输入完成后，暂停本次任务调度步骤后的 RAM 检查和回收；数据按编号透传。 | `LiuxinyuIgnoreMemoryChecks` |
| [恢复内存检查和回收](docs/LiuxinyuRestoreMemoryChecks.md) | 等全部已连接输入完成后，恢复正常检查和回收，也可以作为流程终点。 | `LiuxinyuRestoreMemoryChecks` |

这两个节点无配置项，端口按需增长、类型跟随输入，没有固定数量上限。需要本地核心配套的 `Schema.dynamic_io_prefix`、`ExecutionList.set_ram_checks_enabled` 和执行器检查开关；只复制节点包到未包含这些接口的 ComfyUI 不足以启用功能。修改核心或节点 Python 后需要重启，更新前端脚本后刷新页面。

### 系统命令（1个）

| 节点 | 用途与关键行为 | 节点 ID |
| --- | --- | --- |
| [运行cmd命令](docs/RunCmd.md) | 在 Windows 主机运行单条或多行 cmd，合并返回标准输出和错误输出；可设超时及是否结束进程。 | `RunCmd` |

### 内部调度节点（5个）

以下节点标记为开发专用，由分包或条件循环自动创建，**无需手动添加或接线**。列出是为了让节点总数和错误报告中的 ID 都有出处。

| 内部节点 ID | 作用 |
| --- | --- |
| `LiuxinyuPacketSource` | 为当前包提供数据及轮次，作为展开后的子流输入。 |
| `LiuxinyuPacketStep` | 依次展开每包子流，在全部处理完毕后释放回归节点。 |
| `LiuxinyuPacketCollect` | 收集当前包各路结果，追加到此前包的结果中。 |
| `LiuxinyuReturnSource` | 提供当前轮完整数据，保持数组、字典和图片批次。 |
| `LiuxinyuConditionalStep` | 按布尔条件展开下一轮，或结束并释放条件回归节点。 |

## 数组、执行列表和图片批次

三者都能表示“多个”，但决定下游执行几次、在哪一步合并。**只看插口写着 IMAGE 或“数组”，不能确定执行方式。**

| 形式 | 含义 | 例子 |
| --- | --- | --- |
| 完整数组 ARRAY | 多个元素作为一个值传递 | “多个数值组成数组”的 `[0.1,0.2]`，一次提供全部切点。 |
| ComfyUI 执行列表 | 普通下游通常逐项执行，主动收集列表的节点则整体处理 | 匹配路径、长图切片、分包回归结果。 |
| IMAGE 图片批次 | 一个 `[B,H,W,C]` 张量，批内尺寸一致 | 一个值含四张图片，分包起点仍视为一个整体。 |

执行列表可以装尺寸不同的图片批次。例如两项列表，每项四张图，总计八张图，但分包起点处理的是两包。“批量任意为执行列表”也只重复整体，不拆开批次。

“字符串转为字面量”输入 `[0.1,0.2]`：第一个输出供普通下游依次收到 0.1、0.2；第二个 **完整字面量** 才是一次收到两个切点。更多例子见[数据形式入门](docs/DataLists.md)。

## 典型工作流与分包使用场景

### 多个详情页目录，各自加载、拼接

每个对象经过“拆成子项 → 逐项处理 → 合并”后，再处理下一个对象，防止不同目录的图片被同一个拼接节点合在一起。

```text
目录执行列表 → 分包起点 → 匹配图片路径 → 加载图片 → 拼接图片 → 分包回归 → 预览/保存
                 └────────── 分包回归条件 ─────────────────→ 条件输入
```

1. 用“在绝对路径中的相对路径”生成各产品目录，或用目录匹配筛选子目录，将结果接起点输入1。
2. 起点输出1接另一个目录匹配节点，对象选文件，正则填 `(?i)\.(png|jpe?g|webp)$`，按需设置递归。
3. 路径接“从路径加载图像批次”，例如宽790、高0。每次传入一个文件，各图按自己的比例缩放。
4. 接“从批次列表拼接图片”，选择纵向拼接，再将结果接回归输入1。
5. 起点条件直接连接配对回归的条件输入；回归输出1接预览或保存。

结果是先拼完目录 A，再拼目录 B。**拼接必须放在起点与回归之间**；回归后再接整体收集列表的拼接节点，仍会合并所有结果。

直接让加载节点一次读整个目录，会形成同尺寸批次；只设宽度时也按第一张图计算统一高度。长短不一的详情页应按上例逐文件加载。详见[分包接线](docs/LiuxinyuPacketStart.md)。

### 多张长图，各自切块、处理、再拼回

```text
长图执行列表 → 起点 → 最终切分 → 逐块处理 → 本包拼接 → 回归 → 多张处理后长图
                └──────────── 条件 ────────────────→ 条件输入
```

适用于一个对象的子项需要在内部汇合的任务。“切分预览”带标尺，正式处理选“最终切分”；带重叠的预览块直接拼接会重复内容，并非还原原图。

分包不是任意跳转或无限循环工具。多个输入按位置配对，非空短列表复用末项。嵌套必须为 `A起点 → B起点 → B回归 → A回归`，不支持交叉闭合。需要等待的分支必须接入回归；没有数据输出的保存、预览节点通常放在回归之后。

### 从文本切点到正式裁切

```text
文本 [0.1, 0.2] → 字符串转为字面量（完整字面量） → 切分数组
原图 ──────────────────────────────────────→ 最终切分
```

两刀得到三段：`0～10%`、`10%～20%`、`20%～100%`。也可输入 `[{"percent":10},{"percent":20}]`。先将同一数组接“切分检查图（边界放大）”检查是否切到文字或主体；左右切分时，位置按宽度解释。

### 提示词排列组合

```text
候选组1：[红色, 蓝色] ─┐
候选组2：[杯子, 花瓶] ─┴→ 字符串排列组合 → 从模板生成文本 → 文本预览/下游生成
```

候选可接字符串列表，或输入标准 JSON 数组文本，如 `["红色","蓝色"]`。模板填 `{t1}的{t2}`，两组各两项得到四种组合。普通文本中的逗号/换行不会自动成为多个候选；组合数量是各组长度的乘积，先用少量候选确认。

## 缓存、预览与文件保存

| 内容 | 位置与生命周期 |
| --- | --- |
| 处理结果缓存 | ComfyUI 缓存配合文件内容检查；输入或参数变更时重新处理，不变时尽量复用。 |
| 临时图片预览 | ComfyUI 配置的 temp 目录；每个预览节点保留最近一组，成功替换后清理旧组，旧执行历史的临时图可能失效。 |
| 永久结果 | 保存节点指定的路径，不会被预览缓存清理。 |
| 比例绘制图层 | ComfyUI input 中的 `liuxinyu_ratio_paint` 及官方编辑器相关文件，是继续编辑所需素材，应随工作流备份。 |
| 文本和节点设置 | 随工作流保存；路径指向的源文件不会自动打包进工作流。 |

预览的小图用于减轻缩放和平移负担，停稳后恢复显示尺度所需清晰度，不代表永久结果被缩小。临时 PNG 保留输入像素，实际保存质量还取决于输出格式，如 JPEG 本身有损。

本包预览缓存是**进程内、最近结果复用**，不是跨重启的持久断点。永久保存不随取消自动撤销；同样输入可能不重复自动保存，手动“保存所选”仍按每次点击追加。详见[缓存说明](docs/ImageCache.md)。

文件读写和 cmd 使用 ComfyUI 进程的权限。导入别人提供的工作流时，先检查绝对路径、覆盖选项和实际命令；目录属性表达式也只适合可信输入。

## 常见问题排查

| 现象 | 优先检查什么 |
| --- | --- |
| 搜不到节点或启动导入失败 | 检查目录层级、是否重启；看启动日志 `[comfyui-liuxinyu-packs]` 后的异常。缺少 V3、Autogrow、循环接口时检查核心及前端版本。 |
| 缺少 torch、PIL、numpy | 确认使用的是 ComfyUI 的 Python，修复该环境依赖；不要只装到另一套 Python，也不要为本包随意替换 CUDA/PyTorch。 |
| 动态输入、按钮或预览失效 | 刷新/强制刷新，检查 F12 控制台及 `/extensions/comfyui-liuxinyu-packs/` 资源；避免安装多份包或使用陈旧前端。 |
| 文件选择无反应、远程浏览器没有对话框 | 窗口依赖 Windows 桌面，出现在运行 ComfyUI 的机器；可手动填服务器绝对路径。 |
| 目录匹配后没有图片 | 检查文件/目录选项、递归、名称匹配或完整路径；目录不存在、无匹配或错误正则可能返回空列表。 |
| 图片拉伸或提示比例不一致 | 批次要求同尺寸；宽高均0时要求比例一致，只设一边时以第一张图计算统一另一边。保留不同高度时逐文件加载。 |
| 多个详情页变成一张长图 | 拼接收取了整个列表，将“匹配 → 加载 → 拼接”放进一对分包起点/回归之间。 |
| 分包没按批次内张数循环 | IMAGE 批次整体算一个值，需先转为逐张图的执行列表或数组；重复节点不负责拆图。 |
| 分包报缺少回归、缺输入或交叉闭合 | 条件直接配对，输出编号对应输入，需等待的分支接回归；嵌套按 A/B/B/A 闭合。 |
| 切分数组错误或只收到一个切点 | 接“完整字面量”输出；数值切点在0与1之间，对象形式使用 `percent`。 |
| 切换工作流后缩略图一直模糊 | 等画布停止缩放/平移，检查图片请求及控制台；确认前后端已更新后强制刷新，仍复现时记录操作步骤。 |
| 超长图拼接、编码或保存内存不足 | 降低加载宽度、拆分处理、减少同时驻留的大图；理论格式上限不保证内存/编码器能处理，拼接的格式选项也不负责保存。 |
| 重跑没有新增保存、历史预览失效 | 可能是缓存复用或旧临时图已替换。永久结果需显式保存，不把 temp 当素材备份。 |
| 比例绘制报图层丢失或笔迹消失 | 确认 input 配套图层还在；比例改变会启用空白层，编辑器保存后需再次运行。 |
| 数学运算报错 | 检查除数、对数底数/真数、开根及反函数定义域；阶乘需非负整数，三角函数确认角度单位。 |
| Linux/macOS 中文排序、cmd 报错 | 相关路径使用 Windows API/命令，当前没有跨平台替代实现。 |

先用一张图、两个目录或两三个候选重现，再扩大数据量。单纯文档更新无需重新跑大型生成工作流。

## 开发与问题反馈

### 进一步阅读

- 使用概念：[数据形式](docs/DataLists.md)、[分包子流](docs/LiuxinyuPacketStart.md)、[长图切分](docs/SplitPreview.md)、[像素与数学](docs/PixelMath.md)。
- 前端复用：[公共流畅预览](docs/SmoothImagePreview.md)、[缩略图排列规则](docs/ThumbnailGrid.md)，包含网格、缩放期间小图和稳定后清晰图加载。
- 自动扫描 Python 注册节点；新增/删除节点时同步维护本目录及 `docs/<节点ID>.md`。JavaScript 支持模块不计作节点。

### 开发检查

后端测试依赖 ComfyUI 模块，应使用其实际 Python。Windows 便携版在便携版根目录运行：

```powershell
.\python_embeded\python.exe -X utf8 -s -m unittest discover -s ComfyUI\custom_nodes\comfyui-liuxinyu-packs\tests -v
```

前端逻辑测试需要 Node.js，在本包目录用 PowerShell 执行：

```powershell
Get-ChildItem tests\*.cjs | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { throw "前端测试失败" } }
```

测试覆盖分包顺序/嵌套、图片切分、保存、缓存、像素/数学和预览生命周期等。模拟前端测试不能代替真实浏览器的视觉、性能和交互验证，也不代表所有版本及系统都兼容。

### 反馈与贡献

在 [GitHub Issues](https://github.com/In-Unknown/comfyui-liuxinyu-packs/issues) 提供系统、ComfyUI/前端版本、本包提交号（`git rev-parse --short HEAD`）、节点名称/ID、完整错误栈及最短复现步骤。图片问题补充尺寸、批次数及是否为执行列表；UI 问题可附截图、录屏和控制台错误。分享工作流前移除个人路径、隐私文本及其他节点的密钥。

提交改动时说明实际问题、预期行为和验证方式；文档改动检查链接及节点名称，代码改动运行相关测试。仓库目前没有单独的 LICENSE 文件，授权事项请联系维护者。
