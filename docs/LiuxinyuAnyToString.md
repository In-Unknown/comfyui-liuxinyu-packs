# 任意转换为字符串

把任意输入转成字符串：字符串原样返回，其他值使用其文本表示。适合在字符串插口前统一类型。

例如整数 `123` 转为 `123`，浮点数 `0.5` 转为 `0.5`，布尔值 True 转为 `True`。转换遵循 Python 的 str() 规则，整数不带小数点。

本节点只做一对一转换，不拆列表。列表、对象等结构经 str() 得到的是 Python 风格文本（单引号、Python 字面量）；要标准 JSON 文本请改用[js对象转换为字符串](LiuxinyuJSObjectToString.md)。转换结果可接[字符串拼接](LiuxinyuStringConcatenate.md)、[切分字符串为数组](LiuxinyuStringArraySplit.md)等字符串节点。
