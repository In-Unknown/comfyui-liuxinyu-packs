"""Evaluate a scalar expression on a rectangular decimal sampling grid."""

import ast
import json
import math
from decimal import Decimal, InvalidOperation

from aiohttp import web
from server import PromptServer
from comfy_api.latest import io
from comfy.model_management import throw_exception_if_processing_interrupted
from comfy.utils import ProgressBar


FUNCTIONS = {
    "sin": math.sin, "cos": math.cos, "tan": math.tan,
    "asin": math.asin, "acos": math.acos, "atan": math.atan, "atan2": math.atan2,
    "sqrt": math.sqrt, "abs": abs, "ln": math.log, "log": math.log,
    "log10": math.log10, "exp": math.exp, "floor": math.floor, "ceil": math.ceil,
    "round": round, "min": min, "max": max, "pow": math.pow,
}
CONSTANTS = {"pi": math.pi, "e": math.e}


class Formula(ast.NodeTransformer):
    def __init__(self):
        self.variables = []

    def generic_visit(self, node):
        raise ValueError(f"公式不支持此语法：{type(node).__name__}。请填写数学表达式。")

    def visit_Expression(self, node):
        node.body = self.visit(node.body)
        return node

    def visit_Constant(self, node):
        if type(node.value) not in (int, float):
            raise ValueError("公式中的常量需要是实数。")
        try:
            value = float(node.value)
        except OverflowError as error:
            raise ValueError("公式中的数值超出双精度范围。") from error
        if not math.isfinite(value):
            raise ValueError("公式中的数值必须有限。")
        return node

    def visit_Name(self, node):
        if node.id in FUNCTIONS:
            raise ValueError(f"{node.id} 是函数名，请写成 {node.id}(...)。")
        if node.id not in CONSTANTS and node.id not in self.variables:
            self.variables.append(node.id)
        return node

    def visit_BinOp(self, node):
        if not isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow)):
            raise ValueError("只支持 +、-、*、/、//、%、^ 和 ** 运算。")
        node.left, node.right = self.visit(node.left), self.visit(node.right)
        if isinstance(node.op, ast.Pow):
            return ast.copy_location(ast.Call(func=ast.Name(id="pow", ctx=ast.Load()),
                                             args=[node.left, node.right], keywords=[]), node)
        return node

    def visit_UnaryOp(self, node):
        if not isinstance(node.op, (ast.UAdd, ast.USub)):
            raise ValueError("仅支持正号和负号。")
        node.operand = self.visit(node.operand)
        return node

    def visit_Call(self, node):
        if not isinstance(node.func, ast.Name) or node.func.id not in FUNCTIONS or node.keywords:
            raise ValueError("请使用支持的数学函数及位置参数，例如 sin(x)、sqrt(x)、log(x, 10)。")
        name, count = node.func.id, len(node.args)
        valid = count >= 2 if name in ("min", "max") else (
            count in (1, 2) if name in ("log", "round") else count == (2 if name in ("atan2", "pow") else 1))
        if not valid:
            raise ValueError(f"函数 {name} 的参数数量不正确。")
        node.args = [self.visit(arg) for arg in node.args]
        return node


def parse_formula(expression):
    try:
        tree = ast.parse(expression.strip().replace("^", "**"), mode="eval")
    except SyntaxError as error:
        raise ValueError(f"公式语法错误：第 {error.lineno} 行，第 {error.offset} 列。") from error
    parser = Formula()
    tree = ast.fix_missing_locations(parser.visit(tree))
    return parser.variables, compile(tree, "<函数生成精度数列>", "eval")


def decimal_ticks(value, precision, label):
    try:
        number = Decimal(str(value))
    except InvalidOperation as error:
        raise ValueError(f"{label} 需要是数字。") from error
    if not number.is_finite():
        raise ValueError(f"{label} 需要是有限数值。")
    sign, digits, exponent = number.as_tuple()
    coefficient = int("".join(map(str, digits)))
    power = exponent + precision
    if power < 0:
        coefficient, remainder = divmod(coefficient, 10 ** -power)
        if remainder:
            raise ValueError(f"{label} 最多允许 {precision} 位小数。")
    else:
        coefficient *= 10 ** power
    return -coefficient if sign else coefficient


async def inspect_formula(request):
    try:
        data = await request.json()
        variables, _ = parse_formula(data.get("expression", ""))
        return web.json_response({"variables": variables})
    except (ValueError, TypeError, KeyError, RecursionError) as error:
        return web.json_response({"error": str(error)}, status=400)


PromptServer.instance.routes.post("/liuxinyu/function_grid/inspect")(inspect_formula)


def axis_settings(variables, axes_json, kwargs):
    try:
        stored = json.loads(axes_json or "{}")
    except json.JSONDecodeError:
        stored = {}
    axes = stored.get("axes", {}) if isinstance(stored, dict) else {}
    if not isinstance(axes, dict):
        axes = {}
    result = []
    for index, name in enumerate(variables):
        number = index + 1
        config = axes.get(name, {}) if isinstance(axes.get(name), dict) else {}

        def read(field, default):
            key = f"{field}{number}"
            return kwargs[key] if key in kwargs else config.get(field, default)

        precision = read("precision", 2)
        if type(precision) is not int:
            try:
                precision = int(precision)
            except (TypeError, ValueError, OverflowError):
                precision = 2
        if not 0 <= precision <= 15:
            raise ValueError(f"变量 {name} 的小数位数需要是 0～15 的整数。")
        lo = decimal_ticks(read("min", 0.0), precision, f"{name} 的最小值")
        hi = decimal_ticks(read("max", 1.0), precision, f"{name} 的最大值")
        step = decimal_ticks(read("step", 0.1), precision, f"{name} 的间隔")
        if step <= 0 or hi < lo:
            raise ValueError(f"变量 {name} 的间隔必须大于 0，最大值不能小于最小值。")
        scale = 10 ** precision
        count = (hi - lo) // step + 1
        try:
            if not all(math.isfinite(value) for value in (lo / scale, hi / scale)):
                raise OverflowError
            if count > 1 and (lo / scale == (lo + step) / scale
                              or (lo + (count - 1) * step) / scale == (lo + (count - 2) * step) / scale):
                raise ValueError(f"变量 {name} 的间隔在当前数值范围内小于双精度分辨能力，请增大间隔或缩小数值范围。")
        except OverflowError as error:
            raise ValueError(f"变量 {name} 的范围超出双精度范围。") from error
        result.append({"name": name, "min": lo, "step": step, "scale": scale, "count": count})
    return result


class LiuxinyuFunctionGrid(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuFunctionGrid", display_name="函数生成精度数列", category="utils/math",
            accept_all_inputs=True,
            description=(
                "输入数学表达式，自动识别中英文变量；每个变量对应一组最小值、最大值、间隔、小数位数端口，"
                "顺序为公式中从左到右。采样包含 min，max 正好落在间隔上时才包含。"
                "采样位置用十进制整数步进生成，函数值使用双精度计算。支持 ^ 或 ** 乘方、pi、e、"
                "sin/cos/tan（弧度）、asin/acos/atan/atan2、sqrt、abs、ln、log、log10、exp、floor、ceil、round、min、max、pow。"
                "结果是完整嵌套 ARRAY，按最外层拆分并由下游节点逐项执行；采样坐标包含 order、shape、axes。常数公式返回单项数组。"
                "所有采样点结果保存在内存中；计算遇到无定义或非有限结果时报告对应坐标。"
            ),
            inputs=[
                io.String.Input(
                    "expression", display_name="函数", default="sin(x) + y", multiline=True,
                    tooltip="数学表达式；变量按公式中从左到右的顺序，依次对应下方动态生成的各变量端口。",
                ),
                io.String.Input("axes_json", default="{}", socketless=True),
            ],
            outputs=[io.Array.Output(display_name="多维数列", is_output_list=True), io.Dict.Output(display_name="采样坐标")],
        )

    @classmethod
    def execute(cls, **kwargs):
        expression = kwargs.get("expression", "")
        variables, code = parse_formula(expression)
        settings = axis_settings(variables, kwargs.get("axes_json", "{}"), kwargs)
        axes = {}
        for axis in settings:
            coordinates = []
            for index in range(axis["count"]):
                if index % 4096 == 0:
                    throw_exception_if_processing_interrupted()
                coordinates.append((axis["min"] + index * axis["step"]) / axis["scale"])
            axes[axis["name"]] = coordinates
        shape = [axis["count"] for axis in settings]
        total = math.prod(shape)
        progress = ProgressBar(total)
        completed = 0
        values = {}
        environment = {"__builtins__": {}, **FUNCTIONS, **CONSTANTS}

        def evaluate():
            nonlocal completed
            if completed % 1024 == 0:
                throw_exception_if_processing_interrupted()
                progress.update_absolute(completed)
            try:
                value = float(eval(code, environment, values))
                if not math.isfinite(value):
                    raise ValueError("结果不是有限实数")
            except (ArithmeticError, ValueError, TypeError) as error:
                position = ", ".join(f"{name}={number}" for name, number in values.items()) or "常数公式"
                raise ValueError(f"函数在 {position} 处无法计算：{error}") from error
            completed += 1
            return value

        def build(depth):
            if depth == len(settings):
                return evaluate()
            name = settings[depth]["name"]
            result = []
            for value in axes[name]:
                values[name] = value
                result.append(build(depth + 1))
            return result

        result = build(0) if settings else [evaluate()]
        progress.update_absolute(total)
        metadata = {"order": [axis["name"] for axis in settings], "shape": shape or [1], "axes": axes}
        return io.NodeOutput(result, metadata)
