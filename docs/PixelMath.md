# 像素与数学节点

每个节点的“信息”页现在提供独立的接线、参数及例子：

| 节点 | 详细帮助 |
| --- | --- |
| 像素读写 | [读取 RGB](LiuxinyuReadPixel.md) · [修改 RGB](LiuxinyuWritePixel.md) |
| 基本计算 | [多输入数学运算](LiuxinyuMath.md) · [数字取整](LiuxinyuRound.md) |
| 整数运算 | [阶乘](LiuxinyuFactorial.md) · [最大公因数](LiuxinyuGCD.md) · [最小公倍数](LiuxinyuLCM.md) · [最近素数](LiuxinyuNearestPrime.md) |
| 符号处理 | [绝对值](LiuxinyuAbsolute.md) · [取负](LiuxinyuNegate.md) |
| 函数 | [三角与反三角](LiuxinyuTrigonometry.md) · [双曲与反双曲](LiuxinyuHyperbolic.md) |

## 像素

- **读取图片像素 RGB**：输入 IMAGE、X、Y；R/G/B 输出 0～255 整数。图片批次逐张读取，输出三个对应的执行列表；单张各输出一项。
- **修改图片像素 RGB**：输入 IMAGE、X、Y、R/G/B；可选 Z 是批次图片索引。**Z 不接线：全部图片同一位置改色；Z 接入 0：仅第一张。** 输出完整图片批次，不修改上游张量。
- X/Y/Z 均从 0 开始，越界报错。RGBA 保留透明度；灰度读取时复制为 RGB，改色时输出三通道图。
- 读取先将通道限制在 0～1，再乘 255 取最近整数（恰好一半取偶数）；写入使用 RGB/255，保留原 dtype/device。

## 数学

数字输入可连接 INT 或 FLOAT。多输入节点连接后自动增加插口，受当前 ComfyUI 原生接口限制，最多 100 个。

- **多输入数学运算**：加、减、乘、除、幂、开根、对数、最大值、最小值、取模、整除、平均、方差、样本方差、标准差、中位数；输出 FLOAT。
  输入按插口序号排序，右至左表示反转输入序列后累计。例如 10、3、2：左至右减法 `(10-3)-2=5`；右至左 `(2-3)-10=-11`。
  每步 a、b：幂 `a^b`；开根 `a^(1/b)`（负数只支持整数奇次根）；对数 `log_b(a)`。
  平均/方差/标准差/中位数始终一次计算所有输入，不受方向影响。方差与标准差为总体统计（除以 N）；样本方差除以 N-1。
  取模遵循 Python `%`（余数与除数同号），整除向负无穷取整。除零、非法实数定义域、非有限结果报错。
- **数字取整**：四舍五入、向上、向下、截断；四舍五入的半数远离零，如 -2.5→-3。输出 INT。
- **阶乘**：非负整数，0!=1。输出 INT。
- **最大公因数 / 最小公倍数**：动态多输入，要求整数（接受 3.0，拒绝 3.2）；输出非负 INT。
- **最近素数**：支持小数，距离相同取较小者，小于 2 返回 2；输入上限 2^53-1。使用确定性素性检测。只提供这一个节点，素数与质数同义。
- **绝对值 / 取负**：各为独立节点，输出 FLOAT。
- **三角与反三角函数**：sin/cos/tan/asin/acos/atan；可选弧度或角度。单位用于正三角函数的输入、反三角函数的输出。
- **双曲与反双曲函数**：sinh/cosh/tanh/asinh/acosh/atanh，输出 FLOAT。

浮点运算采用 Python 双精度；三角函数接近奇点时有常规浮点误差。大整数结果在 JavaScript 界面中超过 2^53-1 时可能无法精确显示。

后端测试：`python_embeded/python.exe -X utf8 -s ComfyUI/custom_nodes/comfyui-liuxinyu-packs/tests/test_pixel_math.py`。
