"""Scalar arithmetic nodes using ComfyUI native growing inputs."""

from decimal import Decimal, ROUND_HALF_UP
import math
from numbers import Real, Integral
import statistics

from comfy_api.latest import io


def _number(value):
    if isinstance(value, bool) or not isinstance(value, Real) or (not isinstance(value, Integral) and not math.isfinite(value)):
        raise ValueError("输入须为有限整数或浮点数。")
    return value


def _integer(value):
    _number(value)
    if value != int(value):
        raise ValueError("此运算需要整数，不能输入小数部分非零的数值。")
    return int(value)


def _input(name="value"):
    return io.MultiType.Input(name, types=[io.Float, io.Int], display_name="数值")


def _many():
    return io.Autogrow.Input("numbers", template=io.Autogrow.TemplatePrefix(
        input=_input("number"), prefix="number", min=2, max=100))


def _values(numbers):
    values = [_number(numbers[key]) for key in sorted(numbers, key=lambda k: int(k.removeprefix("number")))]
    if len(values) < 2:
        raise ValueError("请连接至少两个数值。")
    return values


def _float_result(value):
    if isinstance(value, complex) or not math.isfinite(value):
        raise ValueError("结果不是有限实数，请检查定义域或数值大小。")
    return io.NodeOutput(float(value))


_OPERATIONS = ["加", "减", "乘", "除", "幂", "开根", "对数", "最大值", "最小值", "取模", "整除", "平均", "方差", "样本方差", "标准差", "中位数"]


def _binary(a, b, operation):
    if operation == "加": return a + b
    if operation == "减": return a - b
    if operation == "乘": return a * b
    if operation == "除": return a / b
    if operation == "幂": return math.pow(a, b)
    if operation == "开根":
        if b == 0:
            raise ValueError("根次数不能为 0。")
        if a < 0:
            if not b.is_integer() or int(b) % 2 == 0:
                raise ValueError("负数仅支持整数奇次实根。")
            return -math.pow(-a, 1 / b)
        return math.pow(a, 1 / b)
    if operation == "对数": return math.log(a, b)
    if operation == "最大值": return max(a, b)
    if operation == "最小值": return min(a, b)
    if operation == "取模": return a % b
    if operation == "整除": return a // b
    raise ValueError("未知运算。")


class LiuxinyuMath(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuMath", display_name="多输入数学运算", category="utils/math",
                         description="按输入序号排序。右至左先反转序列，再两两累计（10,3,2 的减法：左至右=5，右至左=-11）。幂=a^b；开根=a 的 b 次根；对数=log_b(a)。平均/方差/标准差/中位数对全部输入一次计算，方差为总体方差。",
                         inputs=[_many(), io.Combo.Input("operation", display_name="运算", options=_OPERATIONS),
                                 io.Combo.Input("direction", display_name="方向", options=["从左至右", "从右至左"])],
                         outputs=[io.Float.Output(display_name="结果")])

    @classmethod
    def execute(cls, numbers, operation, direction):
        values = [float(v) for v in _values(numbers)]
        aggregates = {"平均": statistics.fmean, "方差": statistics.pvariance,
                      "样本方差": statistics.variance, "标准差": statistics.pstdev, "中位数": statistics.median}
        if direction not in ("从左至右", "从右至左"):
            raise ValueError("未知计算方向。")
        try:
            if operation in aggregates:
                return _float_result(aggregates[operation](values))
            if direction == "从右至左":
                values.reverse()
            result = values[0]
            for value in values[1:]:
                result = _binary(result, value, operation)
                if not math.isfinite(result):
                    raise ValueError("中间结果超出有限实数范围。")
            return _float_result(result)
        except (ZeroDivisionError, OverflowError, ValueError) as exc:
            raise ValueError(f"{operation} 无法计算：{exc}") from exc


class LiuxinyuRound(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuRound", display_name="数字取整", category="utils/math",
                         description="四舍五入在恰好一半时远离零：2.5→3，-2.5→-3。向上/向下分别朝正/负无穷；截断朝零。",
                         inputs=[_input(), io.Combo.Input("mode", display_name="方式", options=["四舍五入", "向上取整", "向下取整", "截断小数"])],
                         outputs=[io.Int.Output(display_name="整数")])

    @classmethod
    def execute(cls, value, mode):
        value = _number(value)
        methods = {"四舍五入": lambda v: int(Decimal(str(v)).to_integral_value(rounding=ROUND_HALF_UP)),
                   "向上取整": math.ceil, "向下取整": math.floor, "截断小数": math.trunc}
        return io.NodeOutput(methods[mode](value))


class LiuxinyuFactorial(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuFactorial", display_name="阶乘", category="utils/math",
                         description="非负整数阶乘，0! = 1。", inputs=[_input()], outputs=[io.Int.Output(display_name="阶乘")])

    @classmethod
    def execute(cls, value):
        return io.NodeOutput(math.factorial(_integer(value)))


class LiuxinyuGCD(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuGCD", display_name="最大公因数", category="utils/math",
                         inputs=[_many()], outputs=[io.Int.Output(display_name="最大公因数")])

    @classmethod
    def execute(cls, numbers):
        return io.NodeOutput(math.gcd(*[_integer(v) for v in _values(numbers)]))


class LiuxinyuLCM(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuLCM", display_name="最小公倍数", category="utils/math",
                         inputs=[_many()], outputs=[io.Int.Output(display_name="最小公倍数")])

    @classmethod
    def execute(cls, numbers):
        return io.NodeOutput(math.lcm(*[_integer(v) for v in _values(numbers)]))


def _is_prime(n):
    if n < 2:
        return False
    for p in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
        if n % p == 0:
            return n == p
    d, s = n - 1, 0
    while d % 2 == 0:
        d //= 2
        s += 1
    # Deterministic Miller–Rabin for n < 2**64.
    for a in (2, 325, 9375, 28178, 450775, 9780504, 1795265022):
        if a % n == 0:
            continue
        x = pow(a, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(s - 1):
            x = x * x % n
            if x == n - 1:
                break
        else:
            return False
    return True


class LiuxinyuNearestPrime(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuNearestPrime", display_name="最近素数", category="utils/math",
                         description="返回距离最近的素数，距离相同时取较小者。小于 2 返回 2；支持至 2^53-1，以保持前端整数精度。",
                         inputs=[_input()], outputs=[io.Int.Output(display_name="素数")])

    @classmethod
    def execute(cls, value):
        value = _number(value)
        if value <= 2:
            return io.NodeOutput(2)
        if value > 2**53 - 1:
            raise ValueError("最近素数输入不能超过 2^53-1。")
        low, high = math.floor(value), math.ceil(value)
        while True:
            if value - low <= high - value:
                if _is_prime(low):
                    return io.NodeOutput(low)
                low -= 1
            else:
                if _is_prime(high):
                    return io.NodeOutput(high)
                high += 1


class LiuxinyuAbsolute(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuAbsolute", display_name="绝对值", category="utils/math",
                         inputs=[_input()], outputs=[io.Float.Output(display_name="绝对值")])

    @classmethod
    def execute(cls, value):
        return _float_result(abs(_number(value)))


class LiuxinyuNegate(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuNegate", display_name="取负", category="utils/math",
                         inputs=[_input()], outputs=[io.Float.Output(display_name="相反数")])

    @classmethod
    def execute(cls, value):
        return _float_result(-_number(value))


class LiuxinyuTrigonometry(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuTrigonometry", display_name="三角与反三角函数", category="utils/math",
                         description="角度单位用于正三角函数的输入及反三角函数的输出。",
                         inputs=[_input(), io.Combo.Input("function", display_name="函数", options=["sin", "cos", "tan", "asin", "acos", "atan"]),
                                 io.Combo.Input("unit", display_name="角度单位", options=["弧度", "角度"])],
                         outputs=[io.Float.Output(display_name="结果")])

    @classmethod
    def execute(cls, value, function, unit):
        value = _number(value)
        if function not in ("sin", "cos", "tan", "asin", "acos", "atan") or unit not in ("弧度", "角度"):
            raise ValueError("未知函数或角度单位。")
        inverse = function.startswith("a")
        if unit == "角度" and not inverse:
            value = math.radians(value)
        result = getattr(math, function)(value)
        return _float_result(math.degrees(result) if unit == "角度" and inverse else result)


class LiuxinyuHyperbolic(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuHyperbolic", display_name="双曲与反双曲函数", category="utils/math",
                         inputs=[_input(), io.Combo.Input("function", display_name="函数", options=["sinh", "cosh", "tanh", "asinh", "acosh", "atanh"])],
                         outputs=[io.Float.Output(display_name="结果")])

    @classmethod
    def execute(cls, value, function):
        if function not in ("sinh", "cosh", "tanh", "asinh", "acosh", "atanh"):
            raise ValueError("未知双曲函数。")
        return _float_result(getattr(math, function)(_number(value)))
