# JSON Schema 中文规则描述

本包提供独立 Python 导入包 `schema_chinese`，将 Draft 2020-12 的校验规则编译成中文要求，不需要模型 API。它是表单自动报错的共用能力，不是新增画布节点。

## 输入

| 参数 | 描述 | 数据类型 | 必需 |
| --- | --- | --- | --- |
| `schema` | 默认 Draft 2020-12 Schema；字典、布尔值或 JSON 字符串 | `DICT` / `BOOLEAN` / `STRING` | 是 |
| `root_schema` | 描述局部 Schema 时用于引用解析的根文档 | `DICT` / `BOOLEAN` / `STRING` | 否 |
| `path_label` | 可选的路径显示函数，接收原始路径序列并返回显示文字；describe、describe_schema、explain_error 均支持。不提供时保持原路径文字；不改写规则、值或作者自定义报错 | callable | 否 |
| `path` | 当前值的字段名／数组下标序列；默认根位置，显示完整点分隔路径 | `tuple` / `list` | 否 |
| `resources` | 外部 URI 到 Schema 的映射；不自动联网获取文档 | `DICT` | 否 |
| `format_assertion` | 默认 false；只有调用者明确采用格式断言语义时启用 | `BOOLEAN` | 否 |
| `max_depth` / `max_rules` | 默认 64 / 10000；超限明确失败，不截断语义 | `INT` | 否 |

## 输出

| 输出名称 | 描述 | 数据类型 |
| --- | --- | --- |
| `describe_schema(...)` | 完整中文要求，包含命名引用和必要说明 | `str` |
| `describe(...)` | 要求树、命名规则、说明、引用完整性状态 | `Description` |
| `explain_error(error, root_schema=...)` | 校验失败说明；作者报错优先，自动中文作为兜底 | `str` |

## 使用示例

```python
from schema_chinese import describe_schema

print(describe_schema({"type": "integer", "minimum": 1, "maximum": 5}))
# 当前值必须是整数；当前值必须 ≥ 1；当前值必须 ≤ 5
```

原始规则独立于当前填写结果：可以先生成整份规则说明，也可以在校验失败后调用 `explain_error`。作者的 `x-error-message` 只影响错误文案，不能改写正式规则描述或改变校验结果。

## 组合、引用与简化

通过要求树保留“全部／至少一项／恰好一项／否定”的作用范围，条件分支说明成立与不成立两种情况。类型专属关键字不会擅自断言类型，properties 不会擅自要求键存在。对象、数组、依赖、范围和已评估规则分别处理。可严格推导的有限枚举组合简化为直接的中文要求，不能安全化简时完整保留条件。

静态引用、资源作用域、锚点和递归使用现有 referencing 库处理；递归用命名规则有限表达。动态引用保留动态作用域语义。缺少引用文档时 `complete=False`，需要调用者提供上下文，不伪装成完整描述。正则表达式保留精确模式，默认 format/content 注解不作为验证失败条件。

## 安装、限制与验证

包可独立安装，只有 jsonschema/referencing 依赖，无 ComfyUI 或 PyTorch 依赖。安装命令、完整 API、命令行、关键字边界和测试说明见 [独立包使用文档](../schema_chinese/README.md)。不支持任意自定义方言或未知校验 vocabulary；不以作者 title/description 推测业务要求。简单条件合并成短句，复杂条件分组表达，不承诺所有长规则都能缩成一句话。

节点包沿既有共用模块预加载机制加载该包，原表单 `validation_message` 已导向 `schema_chinese.explain_error`。表单的注册 ID、端口、输出、确认和缓存机制保持既有语义。验证入口为 `tests/test_schema_chinese.py` 与 `tests/test_template_form.py`；导入包测试不加载 ComfyUI。独立包带 pyproject.toml，可构建 wheel，提供 `python -m schema_chinese` 命令行。
