# JSON Schema 中文要求生成包

`schema_chinese` 把 JSON Schema Draft 2020-12 编译成结构化的中文要求。转换由固定规则完成，不使用 LLM、不收费调用模型、不自动联网；独立使用时不加载 ComfyUI、PyTorch 或前端。

它区分三件事：**规则是什么意思**、**当前值违反了哪条规则**、**可以怎样修改**。`describe_schema` 只解释规则，不虚构业务意图；`explain_error` 解释校验器已经发现的错误。对于能严格推导的有限枚举组合，可以生成更直接的要求或修改建议。复杂条件通过分组和编号完整表达，不为缩短文字漏掉分支。

## 安装与导入

Python 3.10 及以上，依赖 `jsonschema>=4.18`、`referencing>=0.30`。本目录是可独立安装的 Python 项目：

```powershell
codex-python -m pip install "C:\Apps\ComfyUI_windows_portable\ComfyUI\custom_nodes\comfyui-liuxinyu-packs\schema_chinese"
```

安装后在任意 Python 项目中使用：

```python
from schema_chinese import describe_schema

text = describe_schema({
    "type": "integer",
    "minimum": 1,
    "maximum": 5,
})
print(text)
```

输出：

```text
当前值必须是整数；当前值必须 ≥ 1；当前值必须 ≤ 5
```

ComfyUI 节点包会沿既有共用模块加载机制导入本包，不需要另安装一份。不要为了使用表单重复安装到无关 Python 环境。

## 输入与输出

| 接口／参数 | 含义 |
| --- | --- |
| `describe_schema(schema, **options) -> str` | 输入 Schema 字典、布尔值，或 JSON 字符串；返回完整中文文本 |
| `describe(schema, **options) -> Description` | 返回结构化要求树、引用定义、说明信息和完整性状态 |
| `root_schema=None` | 描述一个局部 Schema 时，提供用于解析本地引用的根文档；完整文档通常不需要设置 |
| `path=()` | 当前值的位置，以字段名和从 0 开始的数组下标组成元组／列表，例如 `("出图要求", "主图", "配置", 0)`；显示为点分隔路径，数组显示第1项 |
| `path_label=None` | 可选路径显示函数，接收原始字段名／下标序列并返回文字；用于显示名，不改写真实键、值或作者自定义报错。describe、describe_schema、explain_error 均支持 |
| `resources=None` | URI 到外部 Schema 文档的映射；只读取显式提供的资源，不发 HTTP 请求 |
| `format_assertion=False` | 默认方言下 format 为注解；只有调用者明确采用格式断言语义时才设为 True，具体格式支持仍取决于其校验器 |
| `max_depth=64` / `max_rules=10000` | 最大展开深度／Schema 编译访问预算；超限抛出错误，不返回偷偷截断的要求 |
| `explain_error(error, root_schema=None) -> str` | 输入 `jsonschema.ValidationError`，生成当前错误的说明；优先采用失败规则位置的 `x-error-message` |

`Description` 包含：

- `requirement`：`Rule` 要求树。每项有 `kind`、中文 `text`、`children`、`schema_path`；逻辑组合与原始来源可检查，不把全部结构压成一句话。
- `definitions`：引用使用的命名规则；递归通过“规则 R1”等名字表达，不无限展开。
- `notices`：格式和内容注解、未知扩展、未解析引用等说明。
- `complete`：引用目标是否全部可用。`False` 不是校验失败，而是描述所需上下文不完整，不能把输出当成完整要求。
- `text`：要求、命名规则及说明组成的完整文本。

`schema_path` 是当前输入文档内的关键字路径；命名引用的来源以 `规则 Rn` 开头。字段名中原有的点不会改名，因此点分隔的显示路径不是可逆 JSON Pointer。机器处理应保留路径元组及 Schema 原文。

## 组合规则示例

```python
from schema_chinese import describe_schema

schema = {
    "anyOf": [
        {"const": "制作"},
        {"const": "外包制作"},
    ]
}
print(describe_schema(schema, path=("制作方式",)))
```

```text
以下条件至少满足一项：
  1. 制作方式等于 "制作"
  2. 制作方式等于 "外包制作"
```

`allOf` 为全部满足，`anyOf` 为至少一项，`oneOf` 为恰好一项。`not` 生成“不能满足以下条件”，保留内部组合的范围；不能把“不能全部成立”误写成“全部不能成立”。`if / then / else` 分别显示判断条件、成立时要求、不成立时要求；判断条件本身不是必须满足的条件。只有 if 或孤立 then/else 不凭空产生断言。

对于必填对象中有限枚举的否定合取，例如禁止三个 status 全部为 waiting/skip、而每个 status 只允许 waiting/ready/skip，可以严格化简为“a.status、b.status、c.status 至少一个取 ready”。若有未分析的额外条件、可选键或无法确定的引用，不使用该化简，完整描述原始条件。测试对三字段的全部 27 种组合比较了原 Schema 与化简结果。

## 类型、对象和数组的语义

- `minimum` 等不自动要求数值类型；`properties` 不自动要求对象类型；`minLength` 不自动要求字符串类型。未明确限制类型时，会保留“仅当当前值是该类型时”。
- `properties` 说明“字段存在时”的值要求；只有 `required` 要求键存在。空字符串、null、缺少键是不同情况。`dependentRequired` 以键是否存在触发，值为 null 也算存在；`dependentSchemas` 约束整个对象，而不是触发字段的值。
- `additionalProperties` 只看同一 Schema 层的 properties/patternProperties 名称匹配；`unevaluatedProperties` 看相关规则成功求值后的已评估标记，二者不混译。
- `prefixItems` 不要求那些位置必须存在；`items` 管理 prefixItems 之后的项；长度由 minItems/maxItems 限制。`contains` 默认至少匹配一项，可由 minContains/maxContains 修改；没有 contains 时，这两个数量关键字不产生要求。
- `uniqueItems` 比较完整 JSON 值，不猜测“编码唯一”等业务要求。`unevaluatedItems` 保留已评估语义，不简单翻译为“额外项”。
- integer 和 number 的数学语义保留；number 包含整数，布尔值不等于数值 0/1。字符串长度按 Unicode 码点，不等于 UTF-8 字节数或人眼看到的字形数。

## 正则、格式与注解

正则要求生成“包含匹配指定 ECMA-262 表达式的片段”，保留精确表达式；不会擅自解释为邮箱、手机号，也不会把未锚定模式误写成整串匹配。这里提供规则级的准确说明，不承诺把任意正则表达式全部改写成不含技术符号的短句。

默认 Draft 2020-12 中 format 是注解。contentEncoding/contentMediaType/contentSchema 也不会因此自动解码、解析并判定失败。title/description/default/examples 和 `x-error-message` 不被当作校验条件：作者的自然语言可能与规则不一致，正式规则描述不能直接用它代替规则。

未知关键字按默认方言的扩展注解处理，并列入说明，不猜测其语义。只接受默认 Draft 2020-12 方言，其他 `$schema` 显式报错；不声称支持任意自定义 vocabulary。开启 format_assertion 只表达调用者明确指定的语义，不负责给第三方校验器开启格式检查。

## 引用、递归与上下文

```python
from schema_chinese import describe

result = describe(
    {"$ref": "https://example.test/quantity"},
    resources={
        "https://example.test/quantity": {"type": "integer", "minimum": 1}
    },
)
assert result.complete
print(result.text)
```

支持本地 JSON Pointer（含转义和 URI 百分号编码）、锚点、嵌套 `$id` 资源、提供的外部资源和命名递归。引用旁的同级约束仍须满足。动态引用明确保留动态作用域选择语义；描述上下文当前解析到的规则不能代替所有运行时动态作用域。

没有提供的引用不会触发网络请求；输出明确写出目标缺失，`complete=False`。受控自然语言能表达复杂结构，但“表达完整”需要上下文完整；它不同于凭空恢复未提供的外部文档。引用 URL 的认证信息和查询参数不写入缺失资源诊断。

## 错误解释和作者报错

```python
from jsonschema import Draft202012Validator
from schema_chinese import explain_error

schema = {
    "type": "string", "minLength": 1,
    "x-error-message": {"minLength": "请填写项目名称。"}
}
error = next(Draft202012Validator(schema).iter_errors(""))
assert explain_error(error) == "请填写项目名称。"
```

作者报错优先级沿用表单约定：失败 Schema 位置对应关键字文案 → 该位置 default 文案／字符串文案 → 自动解释。不改变是否通过校验，不把报错注解放入填写结果。组合错误不再只列前三条猜测：无法安全给出简短修改建议时，给出完整组合要求。通用的规则解释不承诺求出最小修改集合或唯一可行输入；这些属于另外的约束求解任务。

## 命令行

```powershell
codex-python -m schema_chinese .\schema.json --output .\requirements.txt
codex-python -m schema_chinese .\schema.json --resources .\resources.json
```

输入支持 UTF-8 BOM；输出文件为 UTF-8。退出码 0 表示描述完成，1 表示输入／描述失败，2 表示已生成包含缺失引用说明的结果。命令行不改输入文件。

## 验证

节点包的 `tests/test_schema_chinese.py` 独立加载本包，不加载 ComfyUI。覆盖类型作用范围、必填与可选、组合和条件、数组与对象规则、注解、静态／动态／循环引用、缺失资源、资源作用域、复杂度上限、有限域推导真值表和标准校验关键字覆盖。`tests/test_template_form.py` 验证实际表单接入、自定义报错优先级和原有行为。

这是一套可审查的确定性转换规则，测试不是对所有 Schema 的形式化正确性证明。输出含受控术语及必要的精确模式；规则自身很长时，完整描述也可能很长，不能保证任意逻辑都存在同样简短的等价中文。
