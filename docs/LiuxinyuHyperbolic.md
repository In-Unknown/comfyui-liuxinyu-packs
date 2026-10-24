# 双曲与反双曲函数

输入一个数字，选择 sinh、cosh、tanh、asinh、acosh、atanh，输出 FLOAT。用于数学公式、平滑压缩数值等；不使用“角度/弧度”选择。

| 函数 | 说明 | 示例 |
| --- | --- | --- |
| sinh | 双曲正弦 | sinh(0)=0 |
| cosh | 双曲余弦 | cosh(0)=1 |
| tanh | 将实数平滑映射到 -1～1 之间 | tanh(1)≈0.7616 |
| asinh | sinh 的反函数 | asinh(0)=0 |
| acosh | cosh 的非负反函数，输入至少为 1 | acosh(1)=0 |
| atanh | tanh 的反函数，输入严格在 -1～1 之间 | atanh(0)=0 |

例：先计算 tanh(1)，再把结果交给另一个本节点并选择 atanh，会得到约 1。

acosh(0) 或 atanh(1) 超出实数定义域，会报错。sinh/cosh 对极大输入可能溢出；本节点输出必须为有限实数。这里的 sinh 不是普通 sin，要计算角度请用“三角与反三角函数”。
