# 前端版本检测与自动刷新

本包全局扩展，无需添加节点。后端每 5 秒通过 ComfyUI websocket 询问页面版本，页面报告加载时的版本；版本不同，后端只命令对应页面刷新一次。连接恢复时也会主动报告。

## 输入与输出

没有节点输入、输出或手填版本号。版本来自包内 JS/CSS 内容以及启动时加载的根目录 Python 代码。前端文件修改后自动检测；Python 修改需重启后端，新启动版本才生效。此功能检测 liuxinyu 包，不代表所有第三方包或 ComfyUI 核心的版本管理。

## 使用示例

1. 首次安装后重启后端、手动刷新现有页面一次，加载握手代码。
2. 后续更新本包前端代码，打开的页面在下一次握手时自动刷新。
3. 更新 Python 并重启后端后，旧页面重新连接，报告旧版本，收到刷新指令。

页面刷新使用当前 URL，不新建页面。页面草稿恢复沿用 ComfyUI 自身的保存机制；刷新会结束正在输入但还未提交的临时编辑控件，建议代码更新前完成当前输入。后台执行不会因浏览器页面刷新而重启。

## 缓存和循环保护

本包扩展资源及版本模块使用 `Cache-Control: no-store`。同一标签页对同一目标版本只自动尝试刷新一次，若刷新后仍报告旧版本，显示提示，等待手动强制刷新。版本一致时不刷新。首次安装前的旧页面尚无握手代码，需要手动刷新。

## 开发与验证

`frontend_version.py` 沿用包根自动扫描注册；`frontend_version.js` 沿用扩展注册。后端启动创建询问任务，服务关闭时取消任务。

接口：`GET /liuxinyu/frontend/version.js` 返回加载版本模块；`POST /liuxinyu/frontend/version` 接受 `client_id` 和 `version`，只对已连接客户端回应。后端推送 `liuxinyu.frontend_version_query` 与定向 `liuxinyu.frontend_reload`。

命令行测试：`node --test tests/test_frontend_version.cjs`；便携 Python 执行 `tests/test_frontend_version.py`。测试模拟刷新，不操作用户浏览器。

## 刷新确认

自动刷新前关闭 ComfyUI 的 `Comfy.Window.UnloadConfirmation` 设置，取消浏览器的“重新加载站点？”确认框。设置会保存，手动刷新和关闭页面也沿用此设置。其他页面卸载处理正常执行。设置保存失败时保留当前页面，下次版本询问重试。
