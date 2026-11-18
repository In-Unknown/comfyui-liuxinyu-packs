# 窗口恢复与焦点故障取证

用于排查浏览器最小化后很快恢复、切换到其他应用后任务栏反复闪烁的问题。它记录故障现场，不是阻止窗口恢复的功能；正在记录、成功保存和已经定位根因是不同状态。

## 入口与操作

已加载 `focus_monitor.js` 的 ComfyUI 页面在产生焦点事件后，向本机后端提交记录，后端启动被动窗口观察和独立的 `LiuxinyuFocus` 跟踪实例。无需添加节点，也不会执行付费 API 请求。

1. 浏览器正常使用，不需要手动触发最小化或运行工作流。
2. 浏览器窗口在最小化后 2 秒内恢复，或后台收到任务栏闪烁事件时，保存一组现场。这个阈值也可能捕获用户主动恢复，不能把每次触发都视为故障。
3. 在后端地址的 `/liuxinyu/focus/status` 查看采集状态和最近保存结果；例如默认地址是 `http://127.0.0.1:8188/liuxinyu/focus/status`。
4. 检查返回的 `lastCapture` 指向的 JSON，以及同名 ETL 和摘要。不要仅检查 `recorder=recording`。

## 输入

这是共用诊断功能，没有节点端口或用户控件。

| 来源 | 记录内容 | 不记录的内容 |
| --- | --- | --- |
| 页面 | 焦点、可见性、调用栈、事件序号、元素标签与类名 | 输入框正文、工作流字段值、截图 |
| Windows | 前台窗口、最小化与恢复、任务栏闪烁、进程与线程、输入距今时间 | 键入的文字、按键内容 |
| 系统跟踪 | 焦点变化及用户活动的调用栈、进程与模块信息 | 持续 CPU 采样、全量窗口消息 |

## 输出与保存顺序

默认目录是 `ComfyUI/user/liuxinyu/diagnostics/`，按实际 ComfyUI 用户目录定位。所有文件留在本机。

| 文件或状态 | 含义 |
| --- | --- |
| `focus.jsonl` 及轮转文件 | 日常页面、窗口和采集器事件；单文件最多 2 MiB，保留 3 个备份 |
| `focus-incident-时间.json` | 触发原因、最近事件、原始保存状态、目标及当时前台进程的模块地址映射、WPR 导出结果 |
| `.events.etl` / `.images.etl` | 在 WPR 导出之前，直接通过 Windows `ControlTraceW` 保存的两个内存环形缓冲区 |
| `.etl` | WPR 合并导出的跟踪，包含其追加的进程与模块信息 |
| `.summary.json` | 合并跟踪的可读摘要；合并失败但原始事件已保存时，改生成 `.events.summary.json` |
| `lastCaptureResult.state` | `saved`：WPR 合并成功；`raw_saved`：合并失败，但原始事件文件已保存；`save_failed`：两者均未成功 |

保存顺序是：先落盘现场 JSON，再直接保存原始缓冲区和模块映射，然后查询和停止 WPR 完成合并。WPR 的 `0x80010106` 或超时不会抹掉前面已写入的原始现场。直接保存使用 FLUSH，不停止跟踪、不改变窗口、不调用浏览器焦点接口；只操作名称精确匹配的本包实例。

采集重新布防后，`recorder` 会回到 `recording`，但 `lastCaptureResult` 仍保留上次保存失败或降级的结果，并在后端重启后读取保留。原始文件可独立交给摘要工具，不依赖合并成功。

## 调用栈与归因

摘要分别保留最多 1000 个非空消息事件和 100 个相关空消息事件，旧跟踪中的大量空消息不会把焦点变化挤出摘要。新配置只采集 Focus / UserActivity（`0x22000`），取消 NullMessages；2026-11-11 的一份现场中，17140 / 17167 个事件都是空消息，它们本身不能证明谁要求恢复窗口。

窗口所属进程不等于发起恢复的进程，事件上下文 PID 也必须结合调用栈判断。模块地址需要对应故障当时的加载基址；导出符号的“最近函数加很大偏移”不能当成准确函数名。必要时离线加载对应版本符号进行解析。

例如，`explorer.exe` 的窗口激活路径和 Edge 的 `DefWindowProcW → OnDwpSysCommand` 路径只能说明所捕获操作经过这些代码，不能据此指控某个网页插件。真正 30～50 ms 的反复恢复与普通任务栏切换需要分开审查。

## 直接记录窗口操作调用

ETW 的焦点变化事件不覆盖每一次恢复和闪烁。2026-11-12 在从未显示的独立 Windows 桌面中验证：测试窗口产生了相隔 31 ms 的最小化／恢复事件，并调用闪烁接口，但 Focus / UserActivity 跟踪没有记录这个测试进程的事件。这是这条测试路径的覆盖缺口，不应外推为所有前台场景都没有事件。

`diagnostics/focus_calls.py` 提供另一条独立证据链：通过 Frida 在 Edge 主窗口进程和 Explorer 进程内观察窗口操作函数，记录调用发生之前的参数、实际调用进程／线程、目标 HWND、所属顶层窗口、最小化状态、返回结果、返回地址和原生调用栈。它不调用激活、恢复或闪烁函数，也不替换参数和返回值。这里采用进程内插桩，不应称作完全无侵入的系统事件读取。

| 覆盖路径 | 记录内容 |
| --- | --- |
| `ShowWindow` / `ShowWindowAsync` / `NtUserShowWindow` | 显示命令，如 `9`（恢复），以及调用前后的最小化状态 |
| `FlashWindowEx` / `FlashWindow` / `NtUserFlashWindowEx` | 目标窗口和闪烁标志，区分停止闪烁与请求闪烁 |
| `SetForegroundWindow` / `BringWindowToTop` / `SwitchToThisWindow` | 发起切换的进程和调用栈 |
| `SetActiveWindow` / `SetFocus` | 后台或最小化窗口的相关调用；跳过已在前台的普通焦点移动 |
| `SendMessageW` / `PostMessageW` / `SendNotifyMessageW` | 仅记录 `WM_SYSCOMMAND` 的系统命令，不读取其他消息中的文本 |
| `DefWindowProcW` / `NtUserMessageCall` | 接收方处理系统命令的路径，与发送方分开记录 |
| `SetWindowPlacement` / `SetWindowPos` | 显示状态设置；位置函数仅记录显示标志或已最小化窗口的调用 |

只记录发现的 Edge 顶层窗口及其子窗口。实际已附加的进程范围以状态文件为准；第三方未附加进程的发送调用不在这条记录范围内。原生栈中的模块和地址偏移也不自动等于某个网页、扩展或 JavaScript 源码行；需结合原有页面记录和对应版本符号继续定位。两条证据链配合使用，不能由“成功附加”推断任何故障都已覆盖。

### 启动与停止

这是显式启动的诊断工具，不随 ComfyUI 导入或启动自动附加进程。Frida 安装在诊断用 Python 环境，ComfyUI 内嵌 Python 不需要安装它：

```powershell
codex-python -m pip install frida
codex-python C:\Apps\ComfyUI_windows_portable\ComfyUI\custom_nodes\comfyui-liuxinyu-packs\diagnostics\focus_calls.py --directory C:\Apps\ComfyUI_windows_portable\ComfyUI\user\liuxinyu\diagnostics
```

长期运行应通过 `Start-Process -WindowStyle Hidden` 启动，并保存标准输出／错误日志。启动前检查 `focus-calls-state.json` 中的 PID 是否仍然运行，不重复启动。后台每 5 秒更新 Edge 窗口集合并检查附加状态；附加失败记录原因，最多每 60 秒重试同一进程。

在上述诊断目录新建空文件 `focus-calls.stop`，观察器在下一轮检查退出并解除自己的插桩。重新启动前移除这个停止标记。观察器退出不会关闭浏览器；后端重启不影响独立观察器，Windows 注销／重启后需重新启动它。

### 输出及验收

- `focus-calls.jsonl`：直接调用记录、模块范围、附加／脱离及错误。单文件最多 4 MiB，另保留 3 个轮转备份，不采集窗口标题或输入正文。它是日常日志；异常的独立封存见下节。
- `focus-calls-state.json`：观察器实际 PID、已附加进程、钩子数量、目标窗口、累计调用和错误计数。`active` 只表示当前发现的目标进程已附加。
- `call` 与 `return` 用会话 `session` + 调用 ID 配对；旧记录没有会话字段时才结合 PID 和进程存活区间。不同进程或重新附加后的调用 ID 可相同，不能单独按 ID 合并。
- 同进程恢复／闪烁、跨进程恢复／闪烁、异步发送与接收 `SC_RESTORE` 均已在隔离桌面实测。验收核对实际发起 PID、HWND、API、命令、最小化状态和非空原生调用栈，没有操作用户窗口。

测试证明这些路径能够取得责任调用的数据；它不是用户原始偶发故障已被复现或修复的声明。

## 偶发现场的独立封存

故障结束后，不能再依靠查询那个窗口或进程恢复当时状态。直接调用记录在操作发生时就保存发起 PID／线程、目标窗口所属 PID／线程／类名、顶层窗口、前台窗口、最小化状态、API 参数、调用栈、模块路径／加载基址和返回地址前后各 16 字节的代码。返回时另记结果和最小化状态；进程中途退出时可能没有返回记录，不能补造成功结果。栈采集失败通过 `stackError` 明示。

遇到后台闪烁请求、已最小化窗口的恢复请求，或最小化后 2 秒内的激活请求，观察器立即创建 `focus-evidence/incident-时间/`。这包含正常用户恢复的可能性，属于保留现场的触发条件，不是自动判定根因。

| 文件／目录 | 保留内容与时机 |
| --- | --- |
| `manifest.json` | 触发原因、触发调用、前置事件数、关联会话；先写入并同步到磁盘，再进行大文件复制 |
| `native-calls.jsonl` | 触发前最多 2000 条原生记录，以及之后 30 秒的记录；包括同组重复恢复和返回结果 |
| `files.json` / `files-after.json` | 触发时和收尾时分别保存日常日志、栈中涉及的代码文件、页面栈引用的本地 JS 和 `.map`，并列出逐项错误 |
| `sessions/会话.json` | 附加时立即保存进程模块路径和加载地址；用独立会话 ID 区分进程重启和 PID 重用 |
| `sessions/会话-files.json` | 提前备份 Edge 主程序／主 DLL 或 Explorer 主程序，保留版本文件与失败明细 |
| `objects/内容哈希.gz` | 压缩的文件内容快照；相同内容只保存一份，校验值使用 SHA-256 |
| `focus-preserved/现场名/` | 后端原有现场超过热目录 8 组后移入这里，保留 ETL、JSON、页面与原生调用日志，不再自动删除 |

独立现场包和代码对象不会随普通日志轮转删除，也不会因新现场超过 8 组而丢弃。无需当天保持进程运行；Windows 重启之后，已经写入的文件仍可离线读取。普通日志仍有界，现场封存需要用户根据磁盘余量主动归档或清理，不自动删除旧证据换空间。

文件快照按路径、大小和修改时间避免重复处理，再按内容哈希去重。读取时发现非日志文件正在变化，或空间不足、文件不可访问，会在 `files*.json`、`last-error.json` 或状态文件的 `evidence.lastError` 中留下错误，不把不完整的封存标为完整。`finalized=true` 仅表示尾随事件已收尾；还须检查文件清单中的错误。

保存的是明确列出的事件、调用数据和相关文件，不是整个浏览器内存转储。当前页面记录未对浏览器已经加载的每份脚本做独立内容校验；若本地脚本在页面未刷新时被替换，磁盘快照不能自动证明它就是页面仍在运行的旧版本。未附加进程的内部状态、未捕获的 JavaScript 局部变量也不会凭空出现在现场包中。

## 从页面调用记录定位到源码并验证修正

`diagnostics/focus_source_report.cjs` 将本机页面记录中的 JavaScript 堆栈解析到已安装前端的原始源码。对于带 `.js.map` 的压缩前端，它输出原始 Vue／TypeScript 文件、行列和相邻源码；本地扩展 `.js` 直接定位对应文件。三个内容相同的回调也按其调用位置区分，不通过搜索相同代码文本猜测责任位置。

例如，使用 Node.js 执行：

```powershell
node C:\Apps\ComfyUI_windows_portable\ComfyUI\custom_nodes\comfyui-liuxinyu-packs\diagnostics\focus_source_report.cjs C:\Apps\ComfyUI_windows_portable\ComfyUI\user\liuxinyu\diagnostics\focus.jsonl C:\Apps\ComfyUI_windows_portable\artifacts\focus-sources.json
```

| 参数／结果 | 说明 |
| --- | --- |
| 第一个参数 `INPUT.jsonl` | 已保存的逐行 JSON 页面日志；只解析带 `stack` 且标记 `suspicious` 的调用 |
| 第二个参数 `OUTPUT.json` | 输出调用时间、会话、方法、每个栈帧的源码位置和上下文 |
| 第三个参数 `PORTABLE_ROOT` | 可选，默认按工具所在目录定位便携版根目录 |
| `source-map` | 找到该资源对应的源码映射，输出原始源码位置 |
| `direct` | 直接定位未压缩的本地脚本；不能据此宣称有原始 TypeScript 映射 |
| 其他状态 | URL 不属于本机、资源不存在或没有可识别位置；明确保留原因，不凭相似代码猜位置 |

工具只读取本机 `assets/` 和 `extensions/` 对应目录中的脚本及映射，不运行所读取的代码、不请求远程资源、不修改页面。解析历史记录必须使用对应版本的资源；若已升级或修改前端，应优先使用当时保存的资源，不能把新版本行号套到旧事件上。

### 已验证的源码级闭环

`tests/test_focus_attribution.cjs` 直接提取当前安装前端中的三个 `blur → this.focus()` 回调，保留其真实生成代码位置，并接入本包页面记录和源码解析工具。验证结果：

| 原始位置 | 不启用既有保护 | 启用 `focus_guard.js` | 正常页面内回焦 |
| --- | --- | --- | --- |
| `LGraphCanvas.ts:1524` | 7 次后台回焦请求 | 0 次后台回焦请求 | 保留 |
| `LGraphCanvas.ts:7547` | 7 次后台回焦请求 | 0 次后台回焦请求 | 保留 |
| `LGraphCanvas.ts:8034` | 7 次后台回焦请求 | 0 次后台回焦请求 | 保留 |

这是执行实际前端回调的源码级单元回归，DOM／焦点由测试环境模拟，不是 Edge 窗口行为的端到端复现。保护代码原本已经存在；这次新增的是“从记录辨认具体源码位置，再检查该保护是否消除错误请求”的验收，不应说成新修复了用户那次偶发故障。

也不能因为测试通过就把所有快速恢复都归因给这三处。实际故障仍要匹配同一时段的页面调用、原生调用与窗口变化；对应时段没有这些页面调用时，应继续查其他路径。

## 资源、保留范围与限制

- 两个 ETW 环形缓冲区各约 8 MiB；不无限增长。新增的原始文件通常各约 8 MiB，仅触发时保存，不持续写入磁盘。
- 后端 ETW 每次触发后等待 3 秒收集同一轮事件，60 秒内合并；热目录保留最近 8 组，旧组移入 `focus-preserved/`，不再删除。独立原生封存在首次请求时立即写入，并保留 30 秒后续记录。
- 页面待发队列、后端事件环形队列和摘要都有上限，不能保证保留无限长的历史。
- 两种保存方式都可能因权限或系统错误失败；查看 JSON 中的原始返回码。后端采集恢复不代表上一次证据完整。
- 无需修改工作流，不读取或删除生成缓存，不操作用户窗口，不禁用浏览器扩展。

## 开发与验证

相关实现为 `focus_monitor.py`、`focus_recorder.py`、`diagnostics/focus_snapshot.py`、`diagnostics/focus_report.py` 和 `diagnostics/focus.wprp`。直接调用工具为 `diagnostics/focus_calls.py`、`focus_calls.frida`，独立封存为 `focus_evidence.py`。Python 入口沿用本包加载链路；辅助脚本在需要时显式导入，不新增节点。插桩源码使用 `.frida` 后缀，避免被 ComfyUI 当作前端 `.js` 扩展加载。

后端修改需要重启，运行中任务须先完成。修改 WPR 配置后，已有命名跟踪仍使用旧配置，需先保存并结束这个命名实例，再由后端启动新实例，不能取消其他 WPR 会话。前端若没有变化，无需为此刷新。

命令行验证包括 `tests/test_focus_recorder.py`、`tests/test_focus_report.py`、`tests/test_focus_monitor.py`。实际 Windows 验证应确认原始 ETL 可解码、有栈、会话仍处于内存模式且丢失计数可见；禁止用主动抢焦点或最小化用户窗口替代验证。

## 与现有焦点保护的区别

包内仍加载 focus_guard.js，它只处理经典画布及旧式属性输入框的已知焦点回调：页面不可见或没有焦点时，不执行画布自身的 focus；旧式属性输入框失焦且没有页内目标时，阻止其同步抢回焦点的回调。它不关闭本页所有焦点行为，也不能拦截其他进程恢复窗口或任务栏闪烁。

因此，诊断采集和这项局部保护同时存在。删除旧的 BackgroundFocusGuard 帮助页不等于脚本已卸载；当前行为以该脚本及本节为准。相关测试是 tests/test_focus_guard.cjs，采集工具的验证入口见本页前文。
