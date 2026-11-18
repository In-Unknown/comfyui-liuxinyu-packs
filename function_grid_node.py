"""Evaluate a scalar expression on a rectangular decimal sampling grid."""

import asyncio
import json
import math
import threading
import time
from decimal import Decimal, InvalidOperation
from pathlib import Path

from aiohttp import web
from server import PromptServer
from comfy_api.latest import io
from comfy.model_management import throw_exception_if_processing_interrupted
from comfy.utils import ProgressBar
from function_series import SeriesFormula, SeriesEvaluator, series_counts, int64, INT_MIN, INT_MAX
from function_series_analysis import analyze, attach_metrics


async def function_grid_help(request):
    # Serve the one authoritative help file; browser reuse must revalidate it.
    content = Path(__file__).with_name("docs").joinpath("LiuxinyuFunctionGrid.md").read_bytes()
    return web.Response(body=content, content_type="text/markdown", charset="utf-8",
                        headers={"Cache-Control": "no-cache, must-revalidate"})


PromptServer.instance.routes.get(
    "/extensions/comfyui-liuxinyu-packs/docs/LiuxinyuFunctionGrid.md"
)(function_grid_help)


def parse_formula(expression):
    plan = SeriesFormula(expression)
    return plan.variables, plan.code


def decimal_ticks(value, precision, label):
    try:
        number = Decimal(str(value))
    except InvalidOperation as error:
        raise ValueError(f"{label} 需要是数字。") from error
    if not number.is_finite():
        raise ValueError(f"{label} 需要是有限数值。")
    if not Decimal(INT_MIN) <= number <= Decimal(INT_MAX):
        raise ValueError(f"{label} 范围必须在 {INT_MIN}～{INT_MAX} 内。")
    sign, digits, exponent = number.as_tuple()
    coefficient = int(Decimal((0, digits, 0)))
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
        return web.json_response(SeriesFormula(data.get("expression", "")).inspect())
    except (ValueError, TypeError, KeyError, RecursionError) as error:
        return web.json_response({"error": str(error)}, status=400)


PromptServer.instance.routes.post("/liuxinyu/function_grid/inspect")(inspect_formula)


async def analyze_formula(request):
    try:
        data = await request.json()
        expression = data.get("expression", "")
        plan = SeriesFormula(expression)
        stored = json.loads(data.get("axes_json", "{}"))
        counts = series_counts(plan, stored, {})
        domains = analysis_domains(axis_settings(plan.variables, data.get("axes_json", "{}"), {}))
        cancelled = threading.Event()

        def interrupt():
            if cancelled.is_set() or request.transport is None or request.transport.is_closing():
                raise RuntimeError("页面已取消此分析。")

        def progress(event):
            PromptServer.instance.send_sync("liuxinyu.function.analysis", {
                **event, "request_id": data.get("request_id"), "expression": expression,
            }, data.get("client_id"))

        try:
            result = await asyncio.to_thread(analyze, expression, counts, progress, interrupt, parameter_domains=domains)
        finally:
            cancelled.set()
        return web.json_response(result)
    except (ValueError, TypeError, KeyError, RuntimeError, RecursionError) as error:
        return web.json_response({"error": str(error)}, status=400)


PromptServer.instance.routes.post("/liuxinyu/function_grid/analyze")(analyze_formula)


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

        precision = int64(read("precision", "2"), f"变量 {name} 的小数位数")
        if precision < 0:
            raise ValueError(f"变量 {name} 的小数位数不能是负数。")
        lo = decimal_ticks(read("min", 0.0), precision, f"{name} 的最小值")
        hi = decimal_ticks(read("max", 1.0), precision, f"{name} 的最大值")
        step = decimal_ticks(read("step", 0.1), precision, f"{name} 的间隔")
        if step <= 0 or hi < lo:
            raise ValueError(f"变量 {name} 的间隔必须大于 0，最大值不能小于最小值。")
        scale = 10 ** precision
        count = (hi - lo) // step + 1
        result.append({"name": name, "min": lo, "max": hi, "step": step, "scale": scale, "precision": precision, "count": count})
    return result


def analysis_domains(settings):
    from fractions import Fraction
    return {axis["name"]: {"min": str(Fraction(axis["min"], axis["scale"])),
                           "max": str(Fraction(axis["max"], axis["scale"])),
                           "step": str(Fraction(axis["step"], axis["scale"])), "count": axis["count"]}
            for axis in settings}


class LiuxinyuFunctionGrid(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuFunctionGrid", display_name="函数生成精度数列", category="utils/math",
            accept_all_inputs=True,
            description=(
                "输入数学表达式，自动识别中英文变量；每个变量对应一组最小值、最大值、间隔、小数位数端口，"
                "顺序为公式中从左到右。采样包含 min，max 正好落在间隔上时才包含。"
                "采样位置用十进制整数步进生成，内部至少 80 位工作精度。支持 2n、0.5x、2(n+1) 等数字系数省略乘号，以及嵌套 sum(k=1 to INF) (通项)、∑、∞、阶乘 !、|绝对值|、×，"
                "收敛证明、属性推导、数值诊断与高精度复核独立计时，面板显示各阶段耗时和停止位置；执行时按完整项数计算。"
                "每个无限索引动态增加运行项数，按每次进入该求和的次数截断，索引全局唯一。支持 ^ 或 ** 乘方、pi、e、"
                "sin/cos/tan（弧度）、asin/acos/atan/atan2、sqrt、abs、ln、log、log10、exp、floor、ceil、round、min、max、pow。"
                "值执行列表将普通计算结果按最外层拆分，由下游节点逐项执行；采样坐标包含 order、shape、axes。常数公式返回单项数组。"
                "高精度数列为完整十进制字符串数组；普通输出为双精度。i 分析按属性展示对象、分类、定量结果、适用范围及证明过程，包含余项函数、参数区域与边界、导数与条件数、部分和极值和多重求和换序。"
                "收敛、发散、收敛性不确定分别使用中文通知；有限项计算按配置执行。"
                "所有采样点结果保存在内存中；计算遇到无定义或非有限结果时报告对应坐标。"
            ),
            inputs=[
                io.String.Input(
                    "expression", display_name="函数", default="sin(x) + y", multiline=True,
                    tooltip="数学表达式，支持 2n / 0.5x / 2(n+1)；xy 保留为一个变量。变量按公式中从左到右的顺序对应下方端口。",
                ),
                io.String.Input("axes_json", default="{}", socketless=True),
            ],
            outputs=[io.Array.Output(display_name="值执行列表", is_output_list=True), io.Dict.Output(display_name="采样坐标"),
                     io.Array.Output(display_name="高精度数列")],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, **kwargs):
        expression = kwargs.get("expression", "")
        plan = SeriesFormula(expression)
        variables = plan.variables
        stored = json.loads(kwargs.get("axes_json", "{}") or "{}")
        counts = series_counts(plan, stored, kwargs)
        node_id = cls.hidden.unique_id if cls.hidden else None

        def notify(event):
            PromptServer.instance.send_sync("liuxinyu.function.analysis", {
                **event, "node_id": node_id, "expression": expression,
            }, PromptServer.instance.client_id)

        settings = axis_settings(variables, kwargs.get("axes_json", "{}"), kwargs)
        report = analyze(expression, counts, notify, throw_exception_if_processing_interrupted,
                         parameter_domains=analysis_domains(settings), evaluate_numerics=False)
        for entry in report["series"]:
            entry.setdefault("phases", {})["numerical"] = {"label": "数值诊断", "state": "running"}
        report["complete"] = False
        report["summary"] = "进入有限项计算与数值诊断；各级数按配置的完整项数执行。"
        notify({"kind": "complete", "analysis": report})
        axes = {}
        exact_axes = {}
        for axis in settings:
            coordinates = []
            for index in range(axis["count"]):
                if index % 4096 == 0:
                    throw_exception_if_processing_interrupted()
                tick = axis["min"] + index * axis["step"]
                precision = axis["precision"]
                digits = format(Decimal(abs(tick)), "f").zfill(precision + 1)
                coordinates.append(("-" if tick < 0 else "") + (digits[:-precision] + "." + digits[-precision:] if precision else digits))
            exact_axes[axis["name"]] = coordinates
            axes[axis["name"]] = [float(value) for value in coordinates]
        shape = [axis["count"] for axis in settings]
        total = math.prod(shape)
        progress = ProgressBar(total)
        completed = 0
        values = {}
        numeric_started = time.monotonic()
        last_publish = 0

        def numeric_progress(event):
            nonlocal last_publish
            now = time.monotonic()
            if now-last_publish < 0.2:
                return
            last_publish = now
            for entry in report["series"]:
                entry["numerical_progress"] = event
                entry["active_step"] = ("高精度参考重算" if event.get("phase") == "reference" else "有限项计算与数值诊断")
                if event.get("phase") == "reference" and evaluator.metrics.get(entry["name"], {}).get("sample", {}).get("computed_mpf"):
                    entry["phases"]["reference"] = {"label": "高精度复核", "state": "running"}
                if entry["name"] in evaluator.metrics:
                    attach_metrics(entry, evaluator.metrics[entry["name"]])
                notify({"kind": "report", "report": entry})

        evaluator = SeriesEvaluator(plan, counts, [v for axis in exact_axes.values() for v in axis],
                                    throw_exception_if_processing_interrupted, progress=numeric_progress)
        ordinary_overflow = False
        ordinary_underflow = False

        def evaluate():
            nonlocal completed, ordinary_overflow, ordinary_underflow
            if completed % 1024 == 0:
                throw_exception_if_processing_interrupted()
                progress.update_absolute(completed)
            try:
                exact = evaluator.evaluate(values)
                try:
                    value = float(exact)
                except OverflowError:
                    value = None
                if value is None or not math.isfinite(value):
                    ordinary_overflow = True
                    value = None
                elif value == 0 and exact != 0:
                    ordinary_underflow = True
            except (ArithmeticError, ValueError, TypeError) as error:
                position = ", ".join(f"{name}={number}" for name, number in values.items()) or "常数公式"
                raise ValueError(f"函数在 {position} 处无法计算：{error}") from error
            completed += 1
            return value, evaluator.text(exact)

        def build(depth):
            if depth == len(settings):
                return evaluate()
            name = settings[depth]["name"]
            result = []
            exact_result = []
            for value in exact_axes[name]:
                values[name] = value
                ordinary, exact = build(depth + 1)
                result.append(ordinary)
                exact_result.append(exact)
            return result, exact_result

        try:
            if settings:
                result, exact_result = build(0)
            else:
                ordinary, exact = evaluate()
                result, exact_result = [ordinary], [exact]
        except Exception as error:
            for entry in report["series"]:
                entry["phases"]["numerical"] = {"label": "数值诊断", "state": "failed",
                                                "seconds": round(time.monotonic()-numeric_started, 3), "reason": str(error)}
                if entry["name"] in evaluator.metrics:
                    attach_metrics(entry, evaluator.metrics[entry["name"]])
            report["complete"] = False
            report["summary"] = f"有限项计算停止：{error}"
            notify({"kind": "complete", "analysis": report})
            raise
        progress.update_absolute(total)
        metadata = {"order": [axis["name"] for axis in settings], "shape": shape or [1], "axes": axes,
                    "exact_axes": exact_axes, "working_precision": evaluator.mp.dps}
        for entry in report["series"]:
            if entry["name"] in evaluator.metrics:
                attach_metrics(entry, evaluator.metrics[entry["name"]])
            entry["phases"]["numerical"] = {"label": "数值诊断", "state": "completed",
                                            "seconds": round(time.monotonic()-numeric_started, 3)}
            sample = evaluator.metrics.get(entry["name"], {}).get("sample", {})
            if sample.get("reference"):
                entry["phases"]["reference"] = {"label": "高精度复核", "state": "completed"}
            elif sample.get("reference_failure"):
                entry["phases"]["reference"] = {"label": "高精度复核", "state": "failed", "reason": sample["reference_failure"]["reason"]}
        report["complete"] = all(stage["state"] == "completed" for entry in report["series"] for stage in entry["phases"].values())
        report["summary"] = "有限项计算与数值诊断完成。" + ("各项分析阶段已完成。" if report["complete"] else "符号阶段的停止位置及已完成证明见各级数。")
        notify({"kind": "complete", "analysis": report})
        if ordinary_overflow:
            notify({"kind": "warning", "message": "部分结果超出普通浮点范围，普通输出对应位置为 null；高精度输出仍保留十进制值。"})
        if ordinary_underflow:
            notify({"kind": "warning", "message": "部分非零结果在普通浮点输出中下溢为 0；请使用高精度输出保留这些值。"})
        return io.NodeOutput(result, metadata, exact_result, ui={"liuxinyu_series_analysis": [report]})
