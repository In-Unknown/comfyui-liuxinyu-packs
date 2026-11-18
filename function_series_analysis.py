"""Symbolic series reports in a disposable worker, with explicit proof boundaries."""

import ast
import json
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from function_series import SeriesFormula, SeriesEvaluator


PROPERTY_NAMES = ["收敛性", "证明状态", "收敛速度", "绝对收敛与条件收敛", "误差界", "数值稳定性",
                  "振荡性", "单调性", "有界性", "正则性与可微性", "求和顺序敏感性"]
UNKNOWN = "暂时无法确定"
_WORKER_SLOT = threading.BoundedSemaphore(1)


def empty_report(item, counts):
    return {"name": item["name"], "infinite": item["infinite"],
            "terms": str(counts.get(item["name"], "有限端点决定")), "convergence": UNKNOWN,
            "properties": {}, "proof": [], "calculations": [], "active_step": "等待建立符号表达式"}


def calculation(report, attribute, operation, expression, result, status="已计算", reason=None):
    step = {"attribute": attribute, "operation": operation, "expression": str(expression),
            "result": str(result), "status": status}
    if reason:
        step["reason"] = reason
    report["calculations"].append(step)


def attach_metrics(report, metrics):
    report["numerics"] = metrics
    sample = metrics["sample"]
    property_result(report, "数值稳定性", "实际有限项求和诊断", sample.get("roundoff_scope", "有限项求值"),
        f"索引 {sample['first']}…{sample['last']}；参数/外层索引={sample['context']}",
        {label: sample[key] for label, key in [("项数", "N"), ("工作精度", "working_digits"), ("算法", "algorithm"),
         ("条件数", "condition"), ("消去敏感度（十进制位）", "lost_digits"), ("累加绝对前向误差", "summation_roundoff"),
         ("累加相对前向误差", "relative_roundoff"), ("分量相对后向误差", "backward_error"),
         ("双精度转换误差", "output_conversion_error"), ("双精度结果分类", "binary64_result_class")]
         if key in sample and sample[key] is not None},
        ["κ=Σ|a_n|/|Σa_n|；精确展开已计算通项，累加得到参照和及绝对值和。",
         "前向误差=|实际累加结果−参照和|；后向误差 η=前向误差/Σ|a_n|。",
         "η 对应允许各非零输入项独立作相对扰动时，使参照和变为实际结果所需的最小最大扰动量。"],
        status="实际运算诊断")
    if report.get("tail_bound") and sample.get("term_values_exact") and "output_conversion_error_upper" in sample:
        import sympy as sp
        bound = sp.sympify(report["tail_bound"])
        if not bound.free_symbols and not bound.has(sp.Subs, sp.Integral):
            rounding = sp.Rational(sample["summation_roundoff_upper"])
            output = sp.Rational(sample["output_conversion_error_upper"])
            sample["total_error"] = {
                "scope": "该单层有限和转换为双精度→该级数的无穷和",
                "formula": "B_total = B_truncation + B_summation + B_output",
                "terms": [report["tail_bound"], str(rounding), str(output)],
                "display_approximation": str(sp.N(bound + rounding + output, 16)),
                "certificate": "截断界已证；有理数运算精确；求和及输出误差向上舍入为十进制上界",
            }


def parameter_analysis(report, term, n, start, parameters, domains, counts, sp):
    """Prove geometric/power families on the configured closed parameter intervals."""
    from sympy.calculus.util import function_range
    props = report["properties"]
    ranges = {p: sp.Interval(sp.Rational(domains[str(p)]["min"]), sp.Rational(domains[str(p)]["max"]))
              for p in parameters if str(p) in domains}
    report["parameter_ranges"] = {str(p): str(interval) for p, interval in ranges.items()}
    if len(ranges) != len(parameters):
        missing = sorted(str(p) for p in parameters if p not in ranges)
        calculation(report, "收敛性", "参数范围读取", term, missing, "缺少输入", "这些参数没有配置范围，或属于待代入的外层索引")
        return False

    def interval(value):
        if not value.free_symbols:
            return value, value
        if len(value.free_symbols) == 1:
            p = next(iter(value.free_symbols))
            if p in ranges:
                result = function_range(value, p, ranges[p])
                return result.inf, result.sup
        if value.is_Add:
            pairs = [interval(arg) for arg in value.args]
            return sum(x[0] for x in pairs), sum(x[1] for x in pairs)
        if value.is_Mul:
            lo = hi = sp.S.One
            for arg in value.args:
                a, b = interval(arg)
                products = [lo*a, lo*b, hi*a, hi*b]
                lo, hi = sp.Min(*products), sp.Max(*products)
            return lo, hi
        raise NotImplementedError(f"区间运算尚未消去表达式 {value} 的参数相关性")

    # Check original-domain holes separately before using this family proof.
    if start.free_symbols or start.is_integer is not True:
        return False
    ratio = sp.simplify(term.subs(n, n + 1) / term)
    coefficient, exponent = term.as_coeff_exponent(n)
    try:
        if not ratio.has(n):
            first = sp.simplify(term.subs(n, start))
            lo, hi = interval(ratio)
            first_lo, first_hi = interval(first)
            q = sp.Max(sp.Abs(lo), sp.Abs(hi))
            calculation(report, "收敛性", "几何公比范围", f"a_(n+1)/a_n = {ratio}", f"r ∈ [{lo}, {hi}], q = {q}")
            calculation(report, "有界性", "首项范围", first, f"[{first_lo}, {first_hi}]")
            if (lo >= 0) is sp.S.true and (first_lo >= 0) is sp.S.true:
                props["单调性"] = "配置范围内 a_n≥0，S_(N+1)−S_N=a_(起点+N)≥0，部分和单调不减。"
                props["振荡性"] = "首项与公比均非负，所有项同号。"
            elif (lo >= 0) is sp.S.true and (first_hi <= 0) is sp.S.true:
                props["单调性"] = "配置范围内 a_n≤0，部分和单调不增。"
                props["振荡性"] = "首项非正且公比非负，所有项同号。"
            else:
                props["单调性"] = f"公比 r∈[{lo},{hi}]：r≥0 时部分和沿首项符号单调；r<0 时逐项交替。"
                props["振荡性"] = f"r<0 且首项≠0 为交错项；r≥0 为同号项；首项=0 时各项全零。"
            calculation(report, "单调性", "通项符号与部分和差分", "S_(N+1)−S_N = a_0 r^N", props["单调性"], "已证明")
            if q.is_finite is True and (q < 1) is sp.S.true:
                report["convergence"] = "确定收敛"
                report["proof_scope"] = "配置闭区间的笛卡尔积"
                props["收敛性"] = "配置范围内一致绝对收敛"
                props["证明状态"] = f"|r|≤{q}<1；|a_n|≤M q^(n-起点)，由几何级数与 Weierstrass 判别得到一致绝对收敛。"
                maximum = sp.Max(sp.Abs(first_lo), sp.Abs(first_hi))
                bound = maximum * sp.Pow(q, counts[report["name"]], evaluate=False) / (1-q)
                props["误差界"] = f"配置范围统一尾界：M q^N/(1-q) = {bound}"
                props["收敛速度"] = f"q={q}；统一几何收敛 O(q^N)"
                props["绝对收敛与条件收敛"] = "配置范围内绝对收敛"
                props["有界性"] = f"所有部分和 |S_N|≤M/(1-q)={sp.simplify(maximum/(1-q))}"
                props["求和顺序敏感性"] = "范围内各点绝对收敛，任意重排保持和"
                calculation(report, "误差界", "几何尾项求和", "Σ_(j=N)^∞ M q^j", bound, "已证明")
                report["tail_bound"] = str(bound)
                report["uniform_tail_function"] = str(maximum*q**sp.Symbol("N", integer=True, positive=True)/(1-q))
                if first.is_polynomial(*parameters) and ratio.is_polynomial(*parameters):
                    derivative_bound = [str(sp.diff(first, p)) + "; " + str(sp.diff(ratio, p)) for p in sorted(parameters, key=str)]
                    props["正则性与可微性"] = f"首项和公比为多项式，参数域紧且 q={q}<1；导数由 C(q^j+j q^(j-1)) 控制，可逐项求导。"
                    calculation(report, "正则性与可微性", "首项/公比的参数导数", str(sorted(parameters, key=str)), derivative_bound, "已证明")
                report["proof"].append({"method": "参数区间几何比较", "detail": props["证明状态"]})
                return True
            if len(parameters) == 1:
                p = next(iter(parameters)); domain = ranges[p]
                convergent = sp.solveset(sp.Abs(ratio) < 1, p, domain=domain)
                divergent = sp.solveset(sp.Abs(ratio) >= 1, p, domain=domain)
                zeros = sp.solveset(first, p, domain=domain)
                if not any(s.has(sp.ConditionSet) for s in (convergent, divergent, zeros)):
                    convergent = convergent.union(zeros)
                    divergent = divergent - zeros
                    report["regions"] = [{"condition": str(convergent), "convergence": "确定收敛"},
                                         {"condition": str(divergent), "convergence": "确定发散"}]
                    props["证明状态"] = f"求解 |{ratio}|<1 并检查首项 {first}=0：收敛域 {convergent}；非零首项且 |r|≥1 的发散域 {divergent}。"
                    calculation(report, "收敛性", "求解参数不等式与边界", f"|{ratio}|<1；{first}=0", props["证明状态"], "已证明")
                    if divergent == sp.EmptySet:
                        report["convergence"] = "确定收敛"
                    elif convergent == sp.EmptySet:
                        report["convergence"] = "确定发散"
                    else:
                        report["range_classification"] = "范围内既有收敛点也有发散点"
                    return True
        signed = sp.simplify(term / ((-1) ** n))
        alternating_coefficient, alternating_power = signed.as_coeff_exponent(n)
        if (start >= 1 and not alternating_coefficient.has(n) and not alternating_power.has(n)
                and alternating_power.free_symbols):
            pmin, pmax = interval(-alternating_power)
            clo, chi = interval(alternating_coefficient)
            maximum = sp.Max(sp.Abs(clo), sp.Abs(chi))
            calculation(report, "收敛性", "交错幂级数参数范围", f"a_n=(-1)^n*({alternating_coefficient})/n^({-alternating_power})",
                        f"p∈[{pmin},{pmax}]，|c|≤{maximum}")
            if (pmin > 0) is sp.S.true and maximum.is_finite is True:
                report["convergence"] = "确定收敛"
                report["proof_scope"] = "配置闭区间的笛卡尔积"
                bound = maximum * (start + counts[report["name"]]) ** (-pmin)
                report["tail_bound"] = str(bound)
                report["uniform_tail_function"] = str(maximum*(start+sp.Symbol("N", integer=True, positive=True))**(-pmin))
                props.update({"收敛性": "配置范围内一致收敛", "证明状态": f"p≥{pmin}>0；n^(-p) 随 n 单调趋零，参数范围内幅值≤{maximum}/n^{pmin}，由一致莱布尼茨判别收敛。",
                    "误差界": f"统一首个遗漏项界 {bound}", "收敛速度": f"O(N^(-{pmin}))",
                    "振荡性": "非零系数时相邻项异号；系数为零时各项为零。",
                    "单调性": "每个参数点的奇、偶部分和分别单调，从两侧夹逼；方向由首项符号决定。",
                    "有界性": f"|S_N|≤首项幅值≤{maximum}*{start}^(-{pmin})"})
                props["绝对收敛与条件收敛"] = ("整个范围绝对收敛" if (pmin > 1) is sp.S.true else
                    f"按 p>1 / 0<p≤1 分类：p∈[{pmin},{pmax}]；p>1 绝对收敛，0<p≤1 且 c≠0 条件收敛，c=0 绝对收敛。")
                props["求和顺序敏感性"] = "绝对收敛区域重排保持和；条件收敛区域由实级数重排定理可改变和。"
                calculation(report, "证明状态", "幅值导数与统一极限", f"d(n^({alternating_power}))/dn",
                            sp.diff(n ** alternating_power, n), "已证明", f"p≥{pmin}>0，导数≤0；sup |c/n^p|≤{maximum}/n^{pmin}→0")
                calculation(report, "误差界", "统一莱布尼茨尾界", "sup |R_N| ≤ M/(起点+N)^p_min", bound, "已证明")
                if alternating_coefficient.is_polynomial(*parameters) and alternating_power.is_polynomial(*parameters):
                    derivatives = {str(p): str(sp.diff(term, p)) for p in parameters}
                    props["正则性与可微性"] = f"参数导数幅值由 C(1+log(n))/n^{pmin} 控制；n>exp(1/{pmin}) 后 log(n)/n^{pmin} 单调趋零，导数交错级数一致收敛，可逐项求导。"
                    calculation(report, "正则性与可微性", "参数求导与统一交错支配", derivatives, props["正则性与可微性"], "已证明")
                return True
        if not coefficient.has(n) and not exponent.has(n) and exponent.free_symbols:
            pmin, pmax = interval(-exponent)
            clo, chi = interval(coefficient)
            calculation(report, "收敛性", "p 级数指数范围", f"a_n=({coefficient}) n^({exponent})", f"p∈[{pmin},{pmax}], c∈[{clo},{chi}]")
            if start >= 1 and (pmin > 1) is sp.S.true and clo.is_finite and chi.is_finite:
                report["convergence"] = "确定收敛"
                maximum = sp.Max(sp.Abs(clo), sp.Abs(chi)); last = start + counts[report["name"]] - 1
                bound = maximum * last ** (1-pmin) / (pmin-1)
                props.update({"收敛性": "配置范围内一致绝对收敛", "证明状态": f"|a_n|≤{maximum}/n^{pmin}，p_min={pmin}>1。",
                              "误差界": f"统一积分尾界 {bound}", "收敛速度": f"O(N^{1-pmin})",
                              "绝对收敛与条件收敛": "配置范围内绝对收敛", "求和顺序敏感性": "各点绝对收敛，重排保持和"})
                report["tail_bound"] = str(bound)
                report["uniform_tail_function"] = str(maximum*(start+sp.Symbol("N", integer=True, positive=True)-1)**(1-pmin)/(pmin-1))
                props["振荡性"] = "n≥1 时 n^(-p)>0，各参数点的通项符号由系数 c 决定。"
                props["单调性"] = "c≥0 的点部分和单调不减，c≤0 的点单调不增。"
                props["有界性"] = f"|S_N|≤{maximum}*(1+1/({pmin}-1))={sp.simplify(maximum*(1+1/(pmin-1)))}"
                if coefficient.is_polynomial(*parameters) and exponent.is_polynomial(*parameters):
                    epsilon = (pmin - 1) / 2
                    derivatives = {str(p): str(sp.diff(term, p)) for p in parameters}
                    props["正则性与可微性"] = f"参数导数由 C(1+log(n))/n^{pmin} 控制；取 ε={epsilon}，log(n)≤n^ε/(e ε)，比较指数 {pmin-epsilon}>1，可逐项求导。"
                    calculation(report, "正则性与可微性", "参数导数及统一比较", derivatives, props["正则性与可微性"], "已证明")
                calculation(report, "误差界", "统一积分比较", f"∫_{last}^∞ {maximum}/t^{pmin} dt", bound, "已证明")
                return True
            if start >= 1 and len(parameters) == 1:
                p = next(iter(parameters)); domain = ranges[p]
                zeros = sp.solveset(coefficient, p, domain=domain)
                convergent = sp.solveset(-exponent > 1, p, domain=domain).union(zeros)
                divergent = domain - convergent
                if not any(s.has(sp.ConditionSet) for s in (convergent, divergent)):
                    report["regions"] = [{"condition": str(convergent), "convergence": "确定收敛"},
                                         {"condition": str(divergent), "convergence": "确定发散"}]
                    props["证明状态"] = f"非零系数的 p 级数按 p>1 分界；收敛域 {convergent}，发散域 {divergent}。"
                    calculation(report, "收敛性", "求解 p 级数参数分界", f"{-exponent}>1；{coefficient}=0", props["证明状态"], "已证明")
                    if divergent == sp.EmptySet: report["convergence"] = "确定收敛"
                    elif convergent == sp.EmptySet: report["convergence"] = "确定发散"
                    else: report["range_classification"] = "范围内既有收敛点也有发散点"
                    return True
    except (NotImplementedError, ValueError, TypeError) as error:
        calculation(report, "收敛性", "参数区间求解", term, type(error).__name__, "步骤受阻", str(error))
    return False


def symbolic(node, symbols, sp):
    if isinstance(node, ast.Constant):
        return sp.oo if node.value is None else node.value
    if isinstance(node, ast.Name):
        return {"pi": sp.pi, "e": sp.E}.get(node.id, symbols.get(node.id))
    if isinstance(node, ast.UnaryOp):
        value = symbolic(node.operand, symbols, sp)
        return -value if isinstance(node.op, ast.USub) else value
    if isinstance(node, ast.BinOp):
        a, b = symbolic(node.left, symbols, sp), symbolic(node.right, symbols, sp)
        operations = {ast.Add: lambda: a + b, ast.Sub: lambda: a - b, ast.Mult: lambda: a * b,
                      ast.Div: lambda: a / b, ast.Pow: lambda: a ** b,
                      ast.FloorDiv: lambda: sp.floor(a / b), ast.Mod: lambda: sp.Mod(a, b)}
        return operations[type(node.op)]()
    name = node.func.id
    if name == "__num":
        return sp.Rational(node.args[0].value)
    if name == "__sum":
        key, start, end, term = node.args
        return sp.Sum(symbolic(term.body, symbols, sp),
                      (symbols[key.value], symbolic(start, symbols, sp), symbolic(end, symbols, sp)))
    args = [symbolic(arg, symbols, sp) for arg in node.args]
    functions = {"abs": sp.Abs, "__mod": sp.Mod, "ln": sp.log, "min": sp.Min, "max": sp.Max,
                 "pow": lambda a, b: a ** b, "log10": lambda a: sp.log(a, 10),
                 "ceil": sp.ceiling}
    if name == "round":
        raise NotImplementedError("round 的舍入分段暂不参与符号证明。")
    return functions.get(name, getattr(sp, name, None))(*args)


def basic_proof(plan, item, counts, emit, domains=None, parameter_values=None):
    import sympy as sp

    report = empty_report(item, counts)
    properties = report["properties"]

    def stage(label):
        report["active_step"] = label
        publish()
        emit({"kind": "progress", "name": item["name"], "stage": label})

    def publish():
        emit({"kind": "report", "report": report})

    def limit(value):
        try:
            result = sp.limit(value, n, sp.oo)
            calculation(report, "证明状态", "符号极限", f"lim_({n}→∞) {value}", result)
            return result
        except (NotImplementedError, ValueError, TypeError) as error:
            calculation(report, "证明状态", "符号极限", value, type(error).__name__, "步骤受阻", str(error))
            return sp.Symbol("尚未求出的极限", real=True)

    def tail_nonnegative(value):
        offset = sp.Dummy("offset", nonnegative=True)
        return sp.simplify(value.subs(n, start + offset)).is_nonnegative is True

    def proof(status, method, detail):
        report["convergence"] = status
        properties["收敛性"] = status
        properties["证明状态"] = method + "：" + detail
        report["proof"].append({"method": method, "detail": detail})
        calculation(report, "收敛性", method, detail, status, "已证明")
        publish()

    stage("建立精确有理数表达式与索引作用域")
    symbols = {name: sp.Symbol(name, real=True) for name in plan.variables}
    symbols.update({name: sp.Rational(value) for name, value in (parameter_values or {}).items()})
    symbols.update({entry["name"]: sp.Symbol(entry["name"], integer=True) for entry in plan.series})
    for entry in plan.series:
        lower = symbolic(entry["start"], symbols, sp)
        if lower.is_integer is True and lower.is_positive is True:
            symbols[entry["name"]] = sp.Symbol(entry["name"], integer=True, positive=True)
        elif lower == 0:
            symbols[entry["name"]] = sp.Symbol(entry["name"], integer=True, nonnegative=True)
    start = symbolic(item["start"], symbols, sp)
    if start.is_integer is True and start.is_positive is True:
        symbols[item["name"]] = sp.Symbol(item["name"], integer=True, positive=True)
    elif start == 0:
        symbols[item["name"]] = sp.Symbol(item["name"], integer=True, nonnegative=True)
    n = symbols[item["name"]]
    term = symbolic(item["body"], symbols, sp)
    end = symbolic(item["end"], symbols, sp)
    report.update({"term": str(term), "start": str(start), "end": str(end)})
    properties["正则性与可微性"] = (
        "分析对象：离散部分和序列；外部参数数目：0。" if not plan.variables else
        "参数 " + "、".join(plan.variables) + "；依次检验配置域、统一支配函数及导数级数。")
    if not item["infinite"]:
        report["convergence"] = "有限和"
        properties["收敛性"] = "有限和，不适用无穷级数收敛判别。"
        properties["证明状态"] = "按闭区间整数端点执行，空区间为 0；实际通项的定义域仍须检查。"
        properties["误差界"] = ("外层为有限和；总误差由各内层截断误差沿外层运算传播。"
                              if term.has(sp.Sum) else "数学截断误差为 0；数值运算误差单独计算。")
        properties["求和顺序敏感性"] = "有限个已定义项在精确算术下可重排；浮点舍入结果可能改变。"
        properties["收敛速度"] = "有限和无趋于无穷的收敛速度。"
        properties["有界性"] = "有限个实数项的部分和有界；数值诊断逐项记录最小值、最大值及首次取到的索引。"
        if term.is_nonnegative is True:
            properties["单调性"] = "按索引追加项时，有限部分和单调不减。"
            properties["振荡性"] = "已证通项非负，无交错回摆。"
        elif term.is_nonpositive is True:
            properties["单调性"] = "按索引追加项时，有限部分和单调不增。"
        if plan.variables and term.is_polynomial(*(symbols[name] for name in plan.variables)) and not (start.free_symbols | end.free_symbols):
            properties["正则性与可微性"] = "固定有限整数端点，通项关于采样变量为多项式；有限和仍为多项式，可逐项任意阶求导。"
        publish()
        return report
    properties["误差界"] = "正在检验交错余项、积分比较及几何支配的前提。"
    publish()
    stage("核对参数、嵌套求和与定义域")
    if term.has(sp.Sum):
        nested = list(term.atoms(sp.Sum))
        if any(any(limit[-1] == sp.oo for limit in entry.limits) for entry in nested):
            properties["证明状态"] = f"通项包含 {len(nested)} 个内层求和；转入多重索引区域和绝对可和性检验。"
            properties["求和顺序敏感性"] = "检验多重绝对值和、行列迭代和及矩形区域极限。"
            publish()
            return report
        term = term.doit()
        report["term"] = str(term)
    parameters = (term.free_symbols | start.free_symbols) - {n}
    if parameters:
        domain_safe = True
        substitutions = {n: start + sp.Dummy("index_offset", nonnegative=True)}
        substitutions.update({symbols[name]: sp.Rational(value["min"]) + sp.Dummy(name, nonnegative=True)
                              for name, value in (domains or {}).items() if name in symbols})
        for source in ast.walk(item["body"]):
            if isinstance(source, ast.BinOp) and isinstance(source.op, ast.Div):
                denominator = symbolic(source.right, symbols, sp)
                shifted = sp.simplify(denominator.subs(substitutions))
                if shifted.is_nonzero is not True:
                    domain_safe = False
                    calculation(report, "收敛性", "参数域分母检查", denominator, shifted, "需要逐点核验", "范围内非零性未由符号不等式确定，保留原式逐点检查")
            if isinstance(source, ast.BinOp) and isinstance(source.op, ast.Pow):
                power = symbolic(source.right, symbols, sp)
                base = symbolic(source.left, symbols, sp)
                if base.free_symbols & parameters and power.has(n) and start.is_nonnegative is not True:
                    domain_safe = False
                    calculation(report, "收敛性", "负指数起点检查", f"{base}**({power})", start, "需要逐点核验", "先逐点排除底数为零的负指数项")
        outer_indices = {symbols[entry["name"]] for entry in plan.series if entry["name"] != item["name"]}
        if domain_safe and parameters.issubset(outer_indices):
            ratio = sp.simplify(term.subs(n,n+1)/term)
            first = sp.simplify(term.subs(n,start))
            if not ratio.free_symbols and (sp.Abs(ratio)<1) is sp.S.true and first.is_finite is True:
                bound = sp.Abs(first)*sp.Abs(ratio)**counts[item["name"]]/(1-sp.Abs(ratio))
                report["tail_bound"] = str(bound)
                report["absolute_convergence"] = True
                report["proof_scope"] = "每个符合外层索引范围的调用；外层索引保持固定"
                properties["误差界"] = f"固定外层索引的几何尾界：{bound}。"
                properties["绝对收敛与条件收敛"] = "每个外层索引处绝对收敛"
                proof("确定收敛", "外层索引固定后的几何级数", f"首项 {first} 为有限实数，公比 {ratio} 的绝对值小于 1。")
                return report
            coefficient, power = term.as_coeff_exponent(n)
            if (start.is_positive is True and not coefficient.has(n) and coefficient.is_finite is True
                    and coefficient.is_real is True and not power.free_symbols and (power < -1) is sp.S.true):
                bound=sp.Abs(coefficient)*(start+counts[item["name"]]-1)**(power+1)/(-power-1)
                report["tail_bound"]=str(bound)
                report["absolute_convergence"]=True
                report["proof_scope"]="每个符合外层索引范围的调用；外层索引保持固定"
                properties["误差界"]=f"固定外层索引后的 p 级数积分尾界：{bound}。"
                properties["绝对收敛与条件收敛"]="每个外层索引处绝对收敛"
                proof("确定收敛","外层索引固定后的 p 级数",f"系数 {coefficient} 有限；指数 p={-power}>1，绝对值级数由积分比较收敛。")
                return report
        if domain_safe and domains and parameter_analysis(report, term, n, start, parameters, domains, counts, sp):
            publish()
            return report
        if domains:
            calculation(report, "收敛性", "转入采样点证明", str(parameters), domains, "继续分析", "区间判别未覆盖此表达式，按已配置采样点代入参数分别证明")
        properties["证明状态"] = "结论依赖参数/外层索引 " + "、".join(sorted(str(s) for s in parameters)) + " 的取值；具体区域与取值条件见参数分析。"
        if not start.free_symbols:
            ratio = sp.simplify(term.subs(n, n + 1) / term)
            if not ratio.has(n):
                properties["证明状态"] += f" 几何公比 r={ratio}；在每项有定义且 |r|<1 时绝对收敛，首项非零且 |r|≥1 时发散。"
                properties["误差界"] = f"条件式严格尾界：当每项有定义且 |{ratio}|<1，|R_N|≤|a_(起点+N)|/(1-|{ratio}|)，N={counts[item['name']]}。"
                properties["收敛速度"] = f"在 |{ratio}|<1 的条件下几何收敛；接近边界时无统一速度保证。"
                if len(parameters) == 1 and start.is_nonnegative is True:
                    parameter = next(iter(parameters))
                    if sp.simplify(term / parameter ** n).free_symbols == set() and ratio == parameter:
                        properties["正则性与可微性"] = f"几何幂级数在 |{parameter}|<1 内局部一致绝对收敛，解析且可逐项求导；边界点单独代入判别。"
        publish()
        return report
    if start.is_integer is not True or start.is_finite is not True:
        properties["证明状态"] = f"起点检查：{start}；整数属性={start.is_integer}，有限性={start.is_finite}；这两个条件决定整数求和范围。"
        publish()
        return report
    # Preserve domain holes from the original AST: simplification may cancel a
    # denominator such as (n-10)/(n-10), but evaluation still divides by zero.
    from sympy.calculus.util import continuous_domain
    for source in ast.walk(item["body"]):
        if isinstance(source, ast.BinOp) and isinstance(source.op, (ast.Div, ast.Mod, ast.FloorDiv)):
            denominator = symbolic(source.right, symbols, sp)
            if denominator.is_zero is not False:
                zeros = sp.solveset(denominator, n, domain=sp.S.Integers).intersect(sp.Interval(start, sp.oo))
                if zeros != sp.EmptySet:
                    properties["证明状态"] = f"约分前的原式分母 {denominator} 的整数零点求解结果：{zeros}；该集合决定原式除零位置。"
                    publish()
                    return report
        if isinstance(source, ast.Call) and source.func.id == "factorial":
            argument = symbolic(source.args[0], symbols, sp)
            if argument.is_integer is not True or not tail_nonnegative(argument):
                properties["证明状态"] = f"阶乘参数 {argument}：整数属性={argument.is_integer}；全索引非负检查={tail_nonnegative(argument)}；阶乘定义域要求两项同时成立。"
                publish()
                return report
        if ((isinstance(source, ast.Call) and source.func.id in ("sqrt", "ln", "log", "log10", "asin", "acos"))
                or isinstance(source, ast.BinOp) and isinstance(source.op, ast.Pow)):
            original = symbolic(source, symbols, sp)
            if original.is_real is not True:
                domain = continuous_domain(original, n, sp.S.Reals)
                if sp.Interval(start, sp.oo).is_subset(domain) is not True:
                    properties["证明状态"] = f"原式 {original} 的实数定义域为 {domain}；求和要求 [{start},∞) 中的整数索引全部属于该域，包含关系检验停在此条件。"
                    publish()
                    return report
    # A convergence test concerns the tail. Check the actual initial terms and
    # continuous-extension singularities so a finite singular prefix is not hidden.
    for offset in range(4):
        value = term.subs(n, start + offset)
        if value.is_finite is not True or value.is_real is not True:
            properties["证明状态"] = f"{n}={start+offset} 时通项={value}；有限性={value.is_finite}，实数性={value.is_real}；实数级数要求两项同时成立。"
            publish()
            return report
    safe_factorials = {factor: sp.S.One for factor in term.atoms(sp.factorial)
                       if factor.args[0].is_integer is True and tail_nonnegative(factor.args[0])}
    singular = sp.singularities(term.xreplace(safe_factorials), n)
    relevant = singular.intersect(sp.Interval(start, sp.oo)).intersect(sp.S.Integers)
    if relevant != sp.EmptySet:
        properties["证明状态"] = f"通项奇点集合与整数求和域的交集={relevant}；这些位置需要定义域处理。"
        publish()
        return report
    if term.is_real is not True:
        from sympy.calculus.util import continuous_domain
        domain = continuous_domain(term, n, sp.S.Reals)
        if sp.Interval(start, sp.oo).is_subset(domain) is not True:
            properties["证明状态"] = f"连续实数定义域={domain}；目标求和范围=[{start},∞)；包含关系检验停在此条件。"
            publish()
            return report
    amplitude = sp.simplify(sp.Abs(term))
    stage("通项趋零必要条件、比值与根值判别")
    limit_term = limit(amplitude)
    if limit_term.is_zero is False:
        proof("确定发散", "通项趋零必要条件", f"lim |{term}| ({n}→∞) = {limit_term} ≠ 0。")
    elif limit_term is sp.S.NaN:
        properties["证明状态"] = "通项极限未定义，继续尝试其他严格判别。"
    ratio = sp.simplify(term.subs(n, n + 1) / term) if term != 0 else sp.S.Zero
    constant_ratio = not ratio.has(n) and ratio.is_finite is True
    ratio_limit = limit(sp.Abs(ratio))
    report["ratio_facts"] = {"ratio": str(ratio), "absolute_limit": str(ratio_limit)}
    calculation(report, "证明状态", "比值判别的适用条件", f"lim |a_({n}+1)/a_{n}|", ratio_limit,
                "无判别力" if ratio_limit == 1 else "已计算", "极限等于 1，继续比较判别或交错判别" if ratio_limit == 1 else None)
    absolute = None
    if amplitude != 0 and amplitude.is_rational_function(n):
        numerator, denominator = sp.fraction(sp.cancel(amplitude))
        p = sp.degree(denominator, n) - sp.degree(numerator, n)
        compared = limit(amplitude * n ** p)
        if compared.is_positive is True and compared.is_finite is True:
            absolute = bool(p > 1)
            calculation(report, "绝对收敛与条件收敛", "绝对值级数的极限比较",
                        f"lim |a_{n}| / (1/{n}^{p})", compared, "已证明",
                        f"有限正比值；p={p}，绝对值级数{'收敛' if absolute else '发散'}")
            if not absolute:
                properties["绝对收敛与条件收敛"] = f"|a_n| 与 1/n^{p} 的比值极限为 {compared}>0，绝对值级数发散。"
                if tail_nonnegative(term) or tail_nonnegative(-term):
                    proof("确定发散", "同号级数的极限比较", f"通项同号；与 p={p}≤1 的 p 级数比较，比值极限为 {compared}>0。")
    if (ratio_limit < 1) is sp.S.true:
        absolute = True
        proof("确定收敛", "比值判别法", f"lim |a_({n}+1)/a_{n}| = {ratio_limit} < 1，因此绝对收敛。")
    elif (ratio_limit > 1) is sp.S.true:
        proof("确定发散", "比值判别法", f"lim |a_({n}+1)/a_{n}| = {ratio_limit} > 1。")
    exponent = None
    coefficient, power = amplitude.as_coeff_exponent(n)
    if not coefficient.has(n) and not power.has(n) and power.is_real is True and coefficient.is_positive is True and start >= 1:
        exponent = -power
        if (exponent > 1) is sp.S.true:
            absolute = True
            proof("确定收敛", "p 级数比较判别", f"|a_{n}| = {coefficient}/{n}**({exponent})，p={exponent}>1。")
        elif (exponent <= 1) is sp.S.true:
            absolute = False
            properties["绝对收敛与条件收敛"] = f"绝对值级数为 p={exponent} 的 p 级数，发散。"
            if term.is_nonnegative is True:
                proof("确定发散", "p 级数判别", f"a_{n} = {term}，p={exponent}≤1 且通项非负。")
    next_index = start + counts[item["name"]]
    last = next_index - 1

    def at_next(value):
        # Keep factorial/power tails in exact symbolic form rather than expanding
        # thousands of integer digits just to display a rigorous inequality.
        if value.is_rational_function(n) and all(abs(power.exp) <= 16 for power in value.atoms(sp.Pow) if power.exp.is_number):
            return sp.cancel(value.subs(n, next_index))
        factorial_args = [entry.args[0].subs(n, next_index) for entry in value.atoms(sp.factorial)]
        power_args = [entry.exp.subs(n, next_index) for entry in value.atoms(sp.Pow)]
        if (factorial_args and all(arg.is_integer is True and 0 <= arg <= 128 for arg in factorial_args)
                and all(arg.is_number and abs(arg) <= 1024 for arg in power_args)):
            return sp.simplify(value.subs(n, next_index))
        return sp.Subs(value, n, next_index)
    stage("莱布尼茨判别与严格截断余项界")
    alternating = sp.simplify(term / ((-1) ** n))
    alternating_amplitude = sp.simplify(sp.Abs(alternating))
    decreasing = None
    alternating_proved = False
    if alternating_amplitude == amplitude and not alternating.has((-1) ** n):
        ratio_abs = sp.simplify(sp.Abs(ratio))
        # A positive amplitude times (r-1) has the sign of r-1. This avoids
        # expanding factorial differences or introducing polygamma functions.
        decreasing = tail_nonnegative(1-ratio_abs)
        difference = sp.Mul(amplitude, ratio_abs-1, evaluate=False)
        if not decreasing:
            difference = sp.factor(amplitude.subs(n, n + 1) - amplitude)
            decreasing = tail_nonnegative(-difference)
        if not decreasing:
            derivative = sp.diff(amplitude, n)
            decreasing = tail_nonnegative(-derivative)
            calculation(report, "证明状态", "幅值导数", f"d({amplitude})/d{n}", derivative)
        calculation(report, "单调性", "幅值的离散差分", f"b_({n}+1)-b_{n}", difference,
                    "已证明" if decreasing else "符号条件未决", f"索引范围 {n}≥{start}；b_n≥0；r(n)={ratio_abs}；差分≤0：{decreasing}")
        if (alternating.is_nonnegative is True or alternating.is_nonpositive is True) and decreasing and limit_term == 0:
            alternating_proved = True
            proof("确定收敛", "莱布尼茨判别法", f"a_{n}=(-1)**{n}·({alternating})；幅值非负、单调不增且趋于 0。")
            bound = at_next(amplitude)
            report["tail_bound"] = str(bound)
            calculation(report, "误差界", "首个遗漏项界", f"|R_N|≤b_({start}+N)，N={counts[item['name']]}", bound, "已证明")
            properties["误差界"] = f"严格截断界 |R_N| ≤ |a_(起点+N)| = {bound}；N={counts[item['name']]}，数值运算误差独立列出。"
            properties["收敛速度"] = f"由首个遗漏项控制：O({amplitude})。"
            properties["振荡性"] = "已证交错符号；偶、奇部分和从两侧夹逼（零项可使严格性退化）。"
            first_term = sp.simplify(term.subs(n, start))
            second_term = sp.simplify(term.subs(n, start + 1))
            lower, upper = sp.Min(first_term, first_term + second_term), sp.Max(first_term, first_term + second_term)
            report["partial_sum_bounds"] = {"lower": str(lower), "upper": str(upper), "N": "N≥1"}
            properties["有界性"] = f"S_N 为从 {start} 开始的前 N 项和：{lower}≤S_N≤{upper}（N≥1）。"
            properties["单调性"] = ("S_(2m) 单调不减，S_(2m+1) 单调不增；整体从两侧夹逼。"
                                     if first_term.is_positive is True else "S_(2m) 单调不增，S_(2m+1) 单调不减；整体从两侧夹逼。")
            pair = sp.Mul(alternating, 1-ratio_abs, evaluate=False)
            calculation(report, "单调性", "相邻两项合并", f"a_{n}+a_({n}+1)", f"(-1)^{n} * ({pair})", "已证明", properties["单调性"])
            calculation(report, "有界性", "奇偶部分和夹逼", f"S_1={first_term}; S_2={first_term+second_term}", f"[{lower}, {upper}]", "已证明")
    if absolute is True and constant_ratio:
        q = sp.Abs(ratio)
        bound = at_next(amplitude) / (1 - q)
        report["tail_bound"] = str(bound)
        properties["误差界"] = f"严格几何尾界 |R_N| ≤ |a_(起点+N)|/(1-|r|) = {bound}；N={counts[item['name']]}，数值运算误差独立列出。"
        properties["收敛速度"] = f"几何收敛，公比绝对值 {q}，尾界 O(({q})**N)。"
    elif absolute is True and exponent is not None and last >= 1:
        bound = sp.simplify(coefficient * last ** (1 - exponent) / (exponent - 1))
        report["tail_bound"] = str(bound)
        properties["误差界"] = f"严格积分尾界 |R_N| ≤ ∫_{last}^∞ {coefficient}/x**({exponent}) dx = {bound}；数值运算误差独立列出。"
        properties["收敛速度"] = f"严格尾界为 O(N**({1-exponent}))。"
    elif absolute is True and "tail_bound" not in report:
        # Unlike a ratio limit, a supremum on the whole remaining tail yields a bound.
        ratio_abs = sp.simplify(sp.Abs(ratio))
        if sp.diff(ratio_abs, n).is_nonpositive is True:
            q = sp.simplify(ratio_abs.subs(n, next_index))
            if q.is_nonnegative is True and (q < 1) is sp.S.true:
                bound = at_next(amplitude) / (1 - q)
                report["tail_bound"] = str(bound)
                properties["误差界"] = f"尾部比值单调不增，j≥{next_index} 时 |a_(j+1)/a_j|≤{q}<1；严格 |R_N|≤{bound}，数值运算误差独立列出。"
                properties["收敛速度"] = f"从首个遗漏项开始由公比上界 {q} 的几何尾控制。"
        if "tail_bound" not in report:
            offset = sp.Symbol("t", nonnegative=True)
            shifted = sp.cancel(ratio_abs.subs(n, next_index + offset))
            if shifted.is_rational_function(offset):
                numerator, denominator = sp.fraction(shifted)
                p, d = sp.Poly(numerator, offset), sp.Poly(denominator, offset)
                coefficients = [d.nth(i) for i in range(max(p.degree(), d.degree()) + 1)]
                if d.nth(0).is_positive is True and all(c.is_nonnegative is True for c in coefficients):
                    candidates = [sp.S.Zero]
                    valid = True
                    for i, coefficient in enumerate(coefficients):
                        if coefficient == 0:
                            if p.nth(i).is_nonpositive is not True: valid = False
                        else:
                            candidates.append(p.nth(i) / coefficient)
                    if valid:
                        q = sp.Max(*candidates)
                        residual = sp.Poly(sp.expand(q * denominator - numerator), offset)
                        certified = all(c.is_nonnegative is True for c in residual.all_coeffs())
                        calculation(report, "误差界", "尾部有理比值的系数界", f"j={next_index}+t；r(j)={shifted}",
                                    f"q={q}；qQ(t)-P(t)={residual.as_expr()}", "已证明" if certified else "条件未决",
                                    "t≥0，分母为正；差多项式各系数非负，则 r(j)≤q")
                        if certified and (q < 1) is sp.S.true:
                            bound = at_next(amplitude) / (1-q)
                            report["tail_bound"] = str(bound)
                            properties["误差界"] = f"尾部逐项比值≤{q}<1；严格 |R_N|≤{bound}。"
                            properties["收敛速度"] = f"从 j={next_index} 起由几何比值上界 q={q} 控制。"
            if "tail_bound" not in report:
                calculation(report, "误差界", "几何尾界前提检查", f"sup_(j≥{next_index}) |a_(j+1)/a_j|", ratio_abs,
                            "步骤受阻", "比值导数与有理系数比较未给出小于 1 的全尾部上界")
    publish()
    stage("Dirichlet 判别、符号组合判别与绝对收敛")
    # Exact special case: harmonic trigonometric partial sums have a geometric bound.
    for trig in term.atoms(sp.sin, sp.cos):
        argument = trig.args[0]
        frequency = sp.diff(argument, n)
        weight = sp.simplify(term / trig)
        if (frequency.has(n) or sp.diff(argument, n, 2) != 0 or frequency.is_real is not True
                or sp.sin(frequency / 2).is_zero is not False):
            continue
        if tail_nonnegative(weight) and tail_nonnegative(-sp.diff(weight, n)) and limit(weight) == 0:
            bound = at_next(weight) / sp.Abs(sp.sin(frequency / 2))
            proof("确定收敛", "Dirichlet 判别法", f"三角项任意连续部分和的绝对值≤1/|sin({frequency}/2)|；权重 {weight} 非负单调趋零。")
            properties["误差界"] = f"由分部求和得到严格 |R_N|≤{bound}；N={counts[item['name']]}，数值运算误差独立列出。"
            properties["振荡性"] = f"三角振荡因子的角频率为 {frequency}；任意连续段部分和的幅值界为 1/|sin({frequency}/2)|。"
            weight_coefficient, weight_power = weight.as_coeff_exponent(n)
            if (not weight_coefficient.has(n) and not weight_power.has(n)
                    and weight_coefficient.is_positive is True and (weight_power < -1) is sp.S.true and last >= 1):
                absolute = True
                report["proof"].append({"method": "直接比较判别法", "detail": f"三角因子绝对值≤1，故 |a_{n}|≤{weight}；右侧为 p>1 的级数。"})
            break
    publish()
    if report["convergence"] == UNKNOWN:
        stage("Abel 判别：收敛交错基级数与单调有界因子")
        for multiplier in sp.Mul.make_args(term):
            if not multiplier.has(n) or multiplier.is_real is not True:
                continue
            multiplier_limit = limit(multiplier)
            if multiplier_limit.is_finite is not True:
                continue
            derivative = sp.diff(multiplier, n)
            if not (tail_nonnegative(derivative) or tail_nonnegative(-derivative)):
                continue
            base = sp.simplify(term / multiplier)
            signed_amplitude = sp.simplify(base / ((-1) ** n))
            base_amplitude = sp.simplify(sp.Abs(signed_amplitude))
            if ((signed_amplitude.is_nonnegative is True or signed_amplitude.is_nonpositive is True)
                    and base_amplitude.subs(n, start).is_finite is True
                    and tail_nonnegative(-sp.diff(base_amplitude, n)) and limit(base_amplitude) == 0):
                proof("确定收敛", "Abel 判别法",
                      f"基级数通项 {base} 满足莱布尼茨判别；乘子 {multiplier} 单调且极限 {multiplier_limit} 有限，故有界。")
                bound = at_next(base_amplitude) * (sp.Abs(multiplier_limit) + sp.Abs(multiplier_limit - at_next(multiplier)))
                properties["误差界"] = f"由分部求和及基级数的交错部分和界得到严格 |R_N|≤{bound}；数值运算误差独立列出。"
                break
    if report["convergence"] == UNKNOWN and term.is_rational_function(n) and tail_nonnegative(term):
        stage("有理通项的极限比较判别")
        numerator, denominator = sp.fraction(sp.cancel(term))
        p = sp.degree(denominator, n) - sp.degree(numerator, n)
        comparison = limit(term * n ** p)
        if comparison.is_finite is True and comparison.is_positive is True:
            absolute = bool(p > 1)
            proof("确定收敛" if absolute else "确定发散", "极限比较判别法",
                  f"与 1/{n}**({p}) 比较，通项比值极限={comparison}，为有限正数；p={p}。")
    if report["convergence"] == UNKNOWN and tail_nonnegative(term) and tail_nonnegative(-sp.diff(term, n)):
        stage("积分判别：核对连续性、正性、单调性并解析积分")
        from sympy.calculus.util import continuous_domain
        domain = continuous_domain(term, n, sp.S.Reals)
        if sp.Interval(start, sp.oo).is_subset(domain) is True:
            integral = sp.integrate(term, (n, start, sp.oo))
            if not integral.has(sp.Integral) and integral.is_finite is True:
                absolute = True
                proof("确定收敛", "积分判别法", f"连续延拓在 [{start},∞) 非负、单调不增，广义积分={integral} 有限。")
                properties["误差界"] = f"严格积分尾界 |R_N|≤{sp.Integral(term, (n, last, sp.oo))}；数值运算误差独立列出。"
                properties["收敛速度"] = "由所列积分尾界控制；未进一步简化渐近阶。"
            elif integral == sp.oo:
                absolute = False
                proof("确定发散", "积分判别法", "通项连续、非负、单调不增，但对应广义积分为 +∞。")
    if report["convergence"] == UNKNOWN:
        root_limit = limit(amplitude ** (1 / n))
        if (root_limit < 1) is sp.S.true:
            absolute = True
            proof("确定收敛", "根值判别法", f"lim |a_{n}|**(1/{n}) = {root_limit}<1，因此绝对收敛。")
        elif (root_limit > 1) is sp.S.true:
            proof("确定发散", "根值判别法", f"lim |a_{n}|**(1/{n}) = {root_limit}>1。")
        else:
            result = sp.Sum(term, (n, start, sp.oo)).is_convergent()
            if result is sp.S.true or result is sp.S.false:
                proof("确定收敛" if result is sp.S.true else "确定发散", "SymPy 符号组合判别",
                      "精确表达式的 Sum.is_convergent 返回 " + str(result) +
                      "；证明来源为 SymPy 符号组合判别，输入和返回值记录在计算步骤中。")
    if report["convergence"] == "确定收敛" and absolute is None:
        try:
            absolute_result = sp.Sum(amplitude, (n, start, sp.oo)).is_convergent()
        except (NotImplementedError, ValueError, TypeError):
            absolute_result = None
        if absolute_result is sp.S.true or absolute_result is sp.S.false:
            absolute = bool(absolute_result)
    if absolute is True:
        report["absolute_convergence"] = True
        properties["绝对收敛与条件收敛"] = "已证明绝对收敛。"
        properties["求和顺序敏感性"] = "本单层实数级数绝对收敛，由重排定理，任意双射重排保持和。"
    elif absolute is False and report["convergence"] == "确定收敛":
        report["absolute_convergence"] = False
        properties["绝对收敛与条件收敛"] = "已证明条件收敛：原级数收敛而绝对值级数发散。"
        properties["求和顺序敏感性"] = "由实数级数重排定理，任意重排可能改变和或破坏收敛，必须保留指定顺序。"
    stage("单调性、有界性及参数正则性")
    calculation(report, "振荡性", "索引范围上的符号判断", term,
                f"全程非负={tail_nonnegative(term)}；全程非正={tail_nonnegative(-term)}；交错结构已证={alternating_proved}")
    if term.is_nonnegative is True:
        properties["振荡性"] = "通项非负，部分和没有符号交替引起的回摆。"
        properties["单调性"] = "部分和单调不减。"
    elif term.is_nonpositive is True:
        properties["单调性"] = "部分和单调不增。"
    if report["convergence"] == "确定收敛" and not alternating_proved:
        properties["有界性"] = "收敛序列有界定理：取 ε=1，尾部位于 (S−1,S+1)，再与有限前缀的最大、最小值合并得到双侧界。"
    elif report["convergence"] == "确定发散" and (term.is_nonnegative is True or term.is_nonpositive is True):
        properties["有界性"] = "部分和单调且不收敛，因此无界。"
    if properties["误差界"].startswith("正在检验"):
        if report["convergence"] == "确定发散":
            properties["误差界"] = "无穷和发散，截断误差没有有限目标值；本次有限项的运算误差列在数值诊断。"
        else:
            failed = [step for step in report["calculations"] if step["attribute"] == "误差界"]
            properties["误差界"] = (f"尾界推导停止在 {failed[-1]['operation']}：{failed[-1].get('reason', failed[-1]['result'])}；输入 {failed[-1]['expression']}"
                                     if failed else f"对通项 {term}，现有交错、积分与几何比较未构造出覆盖 j≥{next_index} 的可求和支配项。")
    publish()
    return report


def property_result(report, title, classification, subject, domain, quantities, steps, status="已证明"):
    result = {"title": title, "classification": classification, "subject": str(subject),
              "domain": str(domain), "status": status,
              "quantities": [{"label": key, "value": str(value)} for key, value in quantities.items()],
              "steps": [str(step) for step in steps]}
    report.setdefault("analysis", {})[title] = result
    return result


def parameter_function_properties(report, function, parameter, region, sp):
    """Analyze a proved real sum function, keeping extension values separate."""
    from sympy.calculus.util import function_range
    x, F = parameter, function
    derivative = sp.factor(sp.diff(F,x))
    quantities = {"和函数": F, "一阶导数": derivative, "二阶导数": sp.factor(sp.diff(F,x,2)),
                  "绝对敏感度": sp.Abs(derivative), "相对条件数（F≠0）": sp.Abs(sp.cancel(x*derivative/F)) if F!=0 else "使用绝对敏感度"}
    steps = [f"在已证明的收敛区域 {region} 对和函数进行符号微分。"]
    failures = []
    def compute(label, expression, operation):
        try:
            result = operation()
            quantities[label] = result
            steps.append(f"{expression} → {result}")
            return result
        except (NotImplementedError, ValueError, TypeError) as error:
            failures.append(f"{label}：输入 {expression}；{type(error).__name__}: {error}")
            return None
    compute("零点集合", f"{F}=0", lambda: sp.solveset(F,x,domain=region))
    compute("正值区域", f"{F}>0", lambda: sp.solve_univariate_inequality(F>0,x,relational=False).intersect(region))
    compute("负值区域", f"{F}<0", lambda: sp.solve_univariate_inequality(F<0,x,relational=False).intersect(region))
    compute("递增区域（导数>0）", f"{derivative}>0", lambda: sp.solve_univariate_inequality(derivative>0,x,relational=False).intersect(region))
    compute("递减区域（导数<0）", f"{derivative}<0", lambda: sp.solve_univariate_inequality(derivative<0,x,relational=False).intersect(region))
    compute("驻点集合", f"{derivative}=0", lambda: sp.solveset(derivative,x,domain=region))
    value_range = compute("函数值域", f"F({region})", lambda: function_range(F,x,region))
    if F.is_rational_function(x):
        compute("绝对敏感度值域", f"|{derivative}|，{x}∈{region}", lambda: function_range(sp.Abs(derivative),x,region))
        if F!=0:
            compute("相对条件数值域（F≠0）", f"|{x}F'/F|，{x}∈{region}", lambda: function_range(sp.Abs(sp.cancel(x*derivative/F)),x,region-sp.solveset(F,x,domain=region)))
    if value_range is not None:
        quantities.update({"下确界": value_range.inf, "上确界": value_range.sup})
        if value_range.inf.is_finite:
            compute("最小值取到位置", f"{F}={value_range.inf}", lambda: sp.solveset(F-value_range.inf,x,domain=region))
        if value_range.sup.is_finite:
            compute("最大值取到位置", f"{F}={value_range.sup}", lambda: sp.solveset(F-value_range.sup,x,domain=region))
    property_result(report,"参数函数范围与符号","导数、敏感度、值域与零点",F,region,quantities,steps+failures,
                    "符号计算；部分方程待解" if failures else "已证明")
    singularities = sp.singularities(F,x)
    if isinstance(singularities,sp.FiniteSet):
        for point in sorted(singularities,key=str):
            left, right = sp.limit(F,x,point,dir="-"), sp.limit(F,x,point,dir="+")
            data = {"位置": point,"左侧极限": left,"右侧极限": right}
            if left==right and left.is_finite is True:
                kind="可去奇点"
                data["连续补充值"]=left
                proof=[f"两侧极限相等且有限：{left}；以该值补全闭式。原级数在收敛内部由连续性定理取同一值。"]
            elif F.is_rational_function(x):
                numerator,denominator=sp.fraction(sp.cancel(F))
                t=sp.Symbol("h")
                numerator_order=min(monomial[0] for monomial,c in sp.Poly(numerator.subs(x,point+t),t).terms() if c!=0)
                denominator_order=min(monomial[0] for monomial,c in sp.Poly(denominator.subs(x,point+t),t).terms() if c!=0)
                kind="极点"
                data["阶数"]=denominator_order-numerator_order
                data["留数"]=sp.residue(F,x,point)
                proof=["约分后分母零点阶数减去分子零点阶数得到极点阶数；洛朗展开的负一次项系数给留数。"]
            else:
                kind="实侧边界奇异行为"
                proof=[f"分别沿实数左侧、右侧计算极限；左={left}，右={right}。"]
                monodromy=sp.S.Zero
                for logarithm in F.atoms(sp.log):
                    argument=logarithm.args[0]
                    coefficient=sp.expand(F).coeff(logarithm)
                    if (argument.is_polynomial(x) and argument.subs(x,point)==0
                            and coefficient.is_rational_function(x) and coefficient!=0):
                        h=sp.Symbol("h")
                        multiplicity=min(m[0] for m,c in sp.Poly(argument.subs(x,point+h),h).terms() if c!=0)
                        monodromy+=2*sp.pi*sp.I*multiplicity*coefficient
                monodromy=sp.simplify(monodromy)
                if monodromy!=0:
                    kind="对数分支点"
                    data["绕行一周的闭式变化"]=monodromy
                    proof.append(f"对数自变量零点的绕数使 log 增加 2πi·重数；闭式净变化={monodromy}，存在分支。")
            property_result(report,f"参数奇异性：{point}",kind,F,"闭式实变量分析；与级数收敛域同时核对",data,proof)
        if F.is_rational_function(x) or F.has(sp.log):
            property_result(report,"解析延拓","由已求出的和函数闭式延拓",F,"连接原收敛开区间的解析分支",
                {"延拓表达式": F,"奇异候选集合": singularities},
                ["闭式在原收敛开区间与级数和相等；恒等定理确定连接该区间的解析分支。",
                 "沿避开极点及分支点的路径延续闭式；可去奇点按有限极限补全。"])


def rich_analysis(report, plan, item, counts, emit, domains, parameter_values):
    """Keep mathematical objects, certificates and parameter conditions alongside results."""
    import sympy as sp
    from sympy.calculus.util import function_range, continuous_domain

    symbols = {name: sp.Symbol(name, real=True) for name in plan.variables}
    symbols.update({name: sp.Rational(value) for name, value in (parameter_values or {}).items()})
    symbols.update({entry["name"]: sp.Symbol(entry["name"], integer=True) for entry in plan.series})
    for entry in plan.series:
        lower = symbolic(entry["start"], symbols, sp)
        if lower.is_integer is True and lower.is_positive is True:
            symbols[entry["name"]] = sp.Symbol(entry["name"], integer=True, positive=True)
        elif lower == 0:
            symbols[entry["name"]] = sp.Symbol(entry["name"], integer=True, nonnegative=True)
    start = symbolic(item["start"], symbols, sp)
    n = symbols[item["name"]] = sp.Symbol(item["name"], integer=True, positive=True) if start.is_positive else sp.Symbol(item["name"], integer=True, nonnegative=True) if start == 0 else symbols[item["name"]]
    term = symbolic(item["body"], symbols, sp)
    end = symbolic(item["end"], symbols, sp)
    N = sp.Symbol("N", integer=True, positive=True)
    parameters = sorted((term.free_symbols | start.free_symbols | end.free_symbols) - {n}, key=str)
    scope = f"{n}≥{start}；N 表示已计算项数，首个遗漏索引={start}+N"
    if report.get("proof_scope"):
        scope += "；" + report["proof_scope"]
    report["series_expression"] = f"∑({n}={start} to {end}) ({term})"

    def stage(text):
        report["active_step"] = text
        emit({"kind": "report", "report": report})
        emit({"kind": "progress", "name": item["name"], "stage": text})

    def put(title, classification, subject, quantities, steps, domain=scope, status="已证明"):
        return property_result(report, title, classification, subject, domain, quantities, steps, status)

    def error_function(bound, method, conditions=scope, lower=None, exact=None):
        data = {"截断误差上界 E(N)": bound, "当前项数": counts.get(item["name"], "有限端点"),
                "目标精度条件": f"ε>0；取整数 N≥1 使 {bound} ≤ ε"}
        if item["name"] in counts:
            data["当前严格上界"] = sp.Subs(bound, N, counts[item["name"]])
            # Display enormous/small bounds in log space without expanding
            # factorials or integer powers at the requested truncation index.
            logarithm = sp.expand_log(sp.log(bound), force=False)
            logarithm = logarithm.replace(
                lambda value: value.func == sp.log and value.args[0].func == sp.factorial,
                lambda value: sp.loggamma(value.args[0].args[0]+1))
            if not logarithm.has(sp.factorial) and logarithm.free_symbols <= {N}:
                magnitude = (logarithm/sp.log(10)).subs(N, counts[item["name"]]).evalf(18)
                if magnitude.is_real is True and magnitude.is_finite is True:
                    data["当前上界的十进对数（近似）"] = magnitude
        if lower is not None: data["截断误差下界"] = lower
        if exact is not None: data["精确余项 R(N)"] = exact
        report["error_function"] = {"variable": "N", "upper": str(bound), "domain": str(conditions), "method": method}
        put("误差界", "精确余项与严格界" if exact is not None else "严格截断界", "无穷和 − 前 N 项和", data, [method], conditions)

    stage("整理各属性的证明对象、适用范围和已执行步骤")
    if report.get("uniform_tail_function"):
        put("一致收敛", "配置参数区域的一致尾界", "区域内全部参数点",
            {"统一误差函数": report["uniform_tail_function"], "当前统一上界": report["tail_bound"]},
            [report["properties"]["证明状态"], "该上界与具体参数点无关，并随 N→∞ 趋于 0。"], domain=report.get("parameter_ranges", {}))
    for title in PROPERTY_NAMES[2:]:
        steps = [step for step in report["calculations"] if step["attribute"] == title]
        description = report["properties"].get(title)
        if description:
            put(title, description, "当前级数", {},
                [f"{step['operation']}：{step['expression']} → {step['result']}；{step.get('reason', '')}" for step in steps],
                status="分析记录")
    if not plan.variables:
        put("正则性与可微性", "数值级数", "外部参数空间", {"自由参数个数": 0},
            ["表达式的自由符号集合减去求和索引为空；分析对象为离散部分和序列。"], status="已计算")
    if not item["infinite"]:
        if not term.has(sp.Sum):
            error_function(sp.S.Zero, "固定有限求和完整执行后，数学截断余项等于 0。")
        return

    if term.has(sp.Sum):
        stage("多重求和：索引区域、可分离结构与绝对值总和")
        sums = list(term.atoms(sp.Sum))
        order = [f"{n}：{start}…∞"] + [f"{v}：{a}…{b}" for s in sums for v, a, b in s.limits]
        put("求和顺序敏感性", "嵌套迭代求和", term, {"外层与内层索引": " → ".join(order)},
            ["执行顺序是先求内层，再把内层结果交给外层；每个无穷索引的运行项数独立。"], status="结构已解析")
        # Prove a two-dimensional Cartesian product using separable factors.
        if isinstance(term, sp.Sum) and len(term.limits) == 1:
            m, a, b = term.limits[0]
            kernel = term.function
            if b == sp.oo and not (a.free_symbols | start.free_symbols) and not kernel.has(sp.Sum):
                substitutions = {n: start+sp.Dummy("outer_offset", nonnegative=True), m: a+sp.Dummy("inner_offset", nonnegative=True)}
                for source in ast.walk(item["body"]):
                    if isinstance(source, ast.BinOp) and isinstance(source.op, (ast.Div, ast.Mod, ast.FloorDiv)):
                        denominator = symbolic(source.right, symbols, sp)
                        check = sp.simplify(denominator.subs(substitutions))
                        if check.is_nonzero is not True:
                            put("求和顺序敏感性", "原式定义域检查", kernel,
                                {"原始分母": denominator, "平移后分母": check, "全域非零性": check.is_nonzero},
                                ["换序证明要求原始通项在全部整数索引上有定义；分母的符号检查停在此式。"], status="条件待解")
                            return
                factors = sp.separatevars(kernel, symbols=[n, m], dict=True)
                if factors and not (kernel.free_symbols - {n, m}):
                    c, f, g = factors["coeff"], factors[n], factors[m]
                    evidence, absolute_values, values, partials = [], [], [], []
                    valid = True
                    for v, lo, factor, length in [(n, start, f, N), (m, a, g, sp.Symbol("M", integer=True, positive=True))]:
                        domain = continuous_domain(factor, v, sp.S.Reals)
                        if sp.Interval(lo, sp.oo).is_subset(domain) is not True:
                            valid = False
                            evidence.append(f"{factor} 的连续实数定义域={domain}；目标索引范围=[{lo},∞)")
                            break
                        absolute_sum = sp.Sum(sp.Abs(factor), (v, lo, sp.oo))
                        convergence = absolute_sum.is_convergent()
                        evidence.append(f"Σ|{factor}|：{convergence}")
                        if convergence is not sp.S.true:
                            valid = False
                            break
                        absolute_values.append(absolute_sum.doit())
                        values.append(sp.summation(factor, (v, lo, sp.oo)))
                        partials.append(sp.summation(factor, (v, lo, lo + length - 1)))
                    if valid:
                        total = sp.simplify(c * values[0] * values[1])
                        rect = sp.simplify(c * partials[0] * partials[1])
                        absolute_total = sp.Abs(c) * absolute_values[0] * absolute_values[1]
                        put("求和顺序敏感性", "绝对收敛，换序不变", kernel,
                            {"绝对值总和": absolute_total, "先内后外": total, "先外后内": total,
                             "有限矩形和": rect, "矩形独立扩张极限": total, "对角区域扩张极限": total},
                            evidence + [f"分离恒等式 a_({n},{m})=({c})·({f})·({g})。",
                                        "Tonelli：绝对值双重和等于两个绝对值和的乘积，有限。",
                                        "Fubini：行、列迭代和及穷尽全部索引的有限区域极限相同。"])
                        put("绝对收敛与条件收敛", "多重绝对收敛", sp.Abs(kernel), {"绝对值总和": absolute_total}, evidence)
                        report["convergence"] = "确定收敛"
                        report["properties"]["证明状态"] = "分离变量后两个因子级数绝对收敛，Tonelli 与 Fubini 给出多重绝对收敛。"
                        report["properties"]["求和顺序敏感性"] = "已证明笛卡尔积索引区域内行、列、矩形及对角穷尽求和一致。"
                        report["proof"].append({"method": "Tonelli 与 Fubini", "detail": report["properties"]["证明状态"]})
                        put("误差界", "矩形截断的精确余项", "双重无穷和 − N×M 矩形和",
                            {"精确余项": sp.simplify(total - rect), "严格绝对误差": sp.Abs(total - rect)},
                            [f"无限和={total}；有限矩形和={rect}，两者相减。"], domain="N,M≥1；两轴独立趋于∞")
                    else:
                        put("求和顺序敏感性", "绝对可和性检验停在因子级数", kernel,
                            {"分离系数": c, "外层因子": f, "内层因子": g}, evidence, status="条件待解")
        return

    stage("余项函数、渐近阶与几何参数区域")
    facts = report.get("ratio_facts", {})
    ratio = sp.sympify(facts["ratio"], locals=symbols) if facts else sp.simplify(term.subs(n, n + 1) / term) if term != 0 else sp.S.Zero
    first = sp.simplify(term.subs(n, start))
    # Geometric identities are accompanied by their explicit definition domain.
    geometric = not ratio.has(n) and start.is_integer is True and not start.free_symbols
    if geometric and first.is_finite is not False:
        r, A = ratio, first
        domain = f"原式各项有定义；A={A}；r={r}；|r|<1"
        remainder = A * r ** N / (1-r)
        bound = sp.Abs(A) * sp.Abs(r) ** N / sp.Abs(1-r)
        total = sp.cancel(A/(1-r)) if r != 1 else None
        put("参数区域", "几何公比分区", "参数与级数性质", {"首项 A": A, "公比 r": r,
            "零级数域": f"{A}=0", "绝对收敛域": f"{A}=0 或 |{r}|<1",
            "发散域": f"{A}≠0 且 |{r}|≥1", "正边界": f"{r}=1", "负边界": f"{r}=-1"},
            ["A≠0 时通项 A r^j 趋零等价于 |r|<1；有限和恒等式 S_N=A(1-r^N)/(1-r)。"], domain="原式定义域")
        if parameters or (sp.Abs(r) < 1) is sp.S.true:
            error_function(bound, "有限几何和恒等式与 r^N→0 相减，得到精确余项。", domain, exact=remainder)
            put("收敛速度", "几何收敛；r=0 时有限终止", remainder,
                {"渐近阶": f"O(|{r}|^N)", "精确误差系数": sp.Abs(A/(1-r)),
                 "相邻误差比": sp.Abs(r), "误差目标所需项数": f"0<|r|<1，A≠0：N≥max(1,ceil(log(ε·|1-r|/|A|)/log(|r|)))"},
                ["|R_(N+1)|/|R_N|=|r|；A=0 或 r=0 时 N≥1 的尾项为零。"], domain)
            put("绝对收敛与条件收敛", "绝对收敛", "原级数与绝对值级数",
                {"原级数和": total, "绝对值级数和": sp.Abs(A)/(1-sp.Abs(r)), "条件收敛域": "空集"},
                ["分别应用公比 r 与 |r| 的几何和公式。"], domain)
            put("振荡性", "负公比衰减振荡；非负公比同向变化", "通项与部分和",
                {"下极限": total, "上极限": total, "渐近振荡幅度": 0, "余项幅值": bound,
                 "符号周期": "r<0 且 A≠0：2；r≥0：同号"}, ["R_N=A r^N/(1-r)；|r|<1 时余项趋零。"], domain)
            put("单调性", "按公比与首项符号分区", "部分和 S_N",
                {"相邻部分和差": A*r**N, "严格递增": "A>0 且 r>0", "严格递减": "A<0 且 r>0",
                 "常数": "A=0 或 r=0（N≥1）", "非单调": "A≠0 且 r<0"},
                ["S_(N+1)−S_N=A r^N；直接判定差分符号。"], domain)
            put("有界性", "部分和的确界与取到条件", "N≥1 的部分和",
                {"r≥0 时下确界": f"min({A}, {total})", "r≥0 时上确界": f"max({A}, {total})",
                 "r<0 时下确界": sp.Min(A, A*(1+r)), "r<0 时上确界": sp.Max(A, A*(1+r)),
                 "取到条件": "r<0：两界在 N=1、2 取到；0<r<1 且 A≠0：首项端取到，极限端随 N→∞ 逼近；A=0 或 r=0：常数"},
                ["正公比的部分和单调趋于 A/(1-r)；负公比的奇偶部分和分别夹逼，极值在前两个部分和。"], domain)
            put("求和顺序敏感性", "重排不变", "单层实数级数", {"绝对值和": sp.Abs(A)/(1-sp.Abs(r))},
                ["绝对值级数可和，由绝对收敛级数重排定理，任意双射重排保持和。"], domain)
            if parameters and A.is_polynomial(*parameters) and r.is_polynomial(*parameters):
                stage("参数函数：梯度、二阶导数、条件数与一致收敛")
                derivatives = {str(p): sp.factor(sp.diff(total, p)) for p in parameters}
                hessian = sp.hessian(total, parameters)
                quantities = {"和函数": total, "参数顺序": ", ".join(map(str, parameters)), "二阶导数矩阵": hessian,
                    "连续与解析区域": f"|{r}|<1", "局部统一尾界": "紧集 K：|A|≤M，|r|≤q<1 ⇒ sup_K |R_N|≤M q^N/(1-q)",
                    "逐点绝对收敛": f"|{r}|<1", "正规收敛": "每个紧子集上 Σ sup_K|a_n| ≤ M/(1-q)<∞",
                    "一致连续性": "和函数在收敛域内部的每个紧子集上连续，由紧性得到一致连续",
                    "导数支配级数": "C·(q^j+j q^(j-1))；总和 C·(1/(1-q)+1/(1-q)^2)",
                    "逐项积分区域": "收敛域内部的紧线段或紧矩形", "奇异候选集合": sp.denom(total)}
                for p in parameters:
                    quantities[f"关于 {p} 的偏导"] = derivatives[str(p)]
                    quantities[f"关于 {p} 的绝对敏感度"] = sp.Abs(derivatives[str(p)])
                    quantities[f"关于 {p} 的相对条件数（F≠0）"] = sp.Abs(sp.cancel(p*derivatives[str(p)]/total)) if total != 0 else "F=0，使用绝对敏感度"
                put("正则性与可微性", "局部一致绝对收敛、解析、可逐项求导积分", total, quantities,
                    ["多项式 A、r 在紧集上及其各阶导数有界；|r| 的最大值 q<1。",
                     "各阶参数导数由多项式(j)·q^(j-k) 支配，可求和；Weierstrass 判别给各阶局部一致收敛。",
                     "连续性由一致极限定理，逐项求导由导数级数一致收敛定理，紧区域逐项积分由一致收敛定理。"], domain)
                if len(parameters) == 1 and str(parameters[0]) in domains:
                    p = parameters[0]
                    interval = sp.Interval(sp.Rational(domains[str(p)]["min"]), sp.Rational(domains[str(p)]["max"]))
                    convergence_domain = sp.solveset(sp.Abs(r)<1, p, domain=interval)
                    if convergence_domain.is_Interval:
                        value_range = function_range(total, p, convergence_domain)
                        put("参数函数范围", "收敛区域上的函数值域", total,
                            {"参数区域": convergence_domain, "函数值域": value_range, "下确界": value_range.inf,
                             "上确界": value_range.sup, "导数": derivatives[str(p)],
                             "零点集合": sp.solveset(total, p, domain=convergence_domain)},
                            ["在收敛区域内对精确和函数求导、求零点并计算值域。"], convergence_domain)
                        parameter_function_properties(report,total,p,convergence_domain,sp)
                if len(parameters)==1 and r==parameters[0] and A==1:
                    put("全收敛域的一致性", "整个 (-1,1) 上逐点收敛且非一致收敛", "几何幂级数",
                        {"全域通项上确界": 1, "全域余项上确界": "+∞", "紧子区间统一尾界": "q^N/(1-q)，0≤q<1"},
                        ["对每个 N，sup_(|x|<1)|x^N|=1；一致收敛要求通项一致趋零，此必要条件失败。",
                         "x→1− 时 |x^N/(1-x)|→∞，故每个固定 N 的全域余项上确界为∞。"], domain="完整收敛开区间 (-1,1)")
        if r == 1 or r == -1 or parameters:
            put("边界性质", "两种不同的发散边界", "A≠0 时的部分和",
                {"r=1": "S_N=N A；A>0 趋于+∞，A<0 趋于−∞",
                 "r=-1": "S_(2k)=0，S_(2k+1)=A；下极限=min(0,A)，上极限=max(0,A)",
                 "r<-1": "奇偶子序列幅值趋于∞；下极限=−∞，上极限=+∞",
                 "r>1": "沿 A 的符号单调无界"},
                ["把 r=±1 代入有限和，r<-1 使用奇偶子序列，r>1 使用同号项增长。"], "原式有定义且 A≠0")
        return

    stage("幂律、交错余项与积分夹逼")
    props = report["properties"]
    absolute_proved = report.get("absolute_convergence") is True
    conditional = report.get("absolute_convergence") is False and report["convergence"] == "确定收敛"
    if absolute_proved or conditional:
        put("绝对收敛与条件收敛", "绝对收敛" if absolute_proved else "条件收敛",
            "Σ a_n 与 Σ |a_n|", {"原级数": "收敛", "绝对值级数": "收敛" if absolute_proved else "发散",
            "正项和与负项绝对值和": "均有限" if absolute_proved else "均为+∞"},
            [entry["detail"] for entry in report["proof"]] + [props["绝对收敛与条件收敛"]])
        put("求和顺序敏感性", "重排不变" if absolute_proved else "重排敏感", "单层实数级数", {},
            ["绝对收敛级数的任意双射重排保持和。" if absolute_proved else
             "原级数收敛而绝对值级数发散，正项和、负项绝对值和均为∞；黎曼重排定理给出任意指定实数和及趋于±∞的重排。"])
    if report["convergence"] == "确定收敛" and not parameters:
        put("振荡性", "上下极限相等", "无穷部分和序列",
            {"下极限": f"Σ_({n}={start})^∞ ({term})", "上极限": f"Σ_({n}={start})^∞ ({term})", "渐近振荡幅度": 0},
            [props.get("证明状态", "原级数已证明收敛"), "收敛序列的上下极限均等于其极限。"])
    # A rational amplitude with affine denominator includes shifted alternating harmonics.
    signed = sp.simplify(term / (-1)**n)
    alternating = any(p["method"] == "莱布尼茨判别法" for p in report["proof"])
    amplitude = sp.simplify(sp.Abs(signed if alternating else term))
    t = sp.Symbol("t", nonnegative=True)
    shifted = sp.simplify(term.subs(n, start+t))
    if shifted.is_nonnegative or shifted.is_nonpositive:
        direction = "常数" if shifted == 0 else "严格递增" if shifted.is_positive else "严格递减" if shifted.is_negative else "单调不减" if shifted.is_nonnegative else "单调不增"
        put("单调性", direction, "部分和", {"差分": term.subs(n, start+N), "起始项数": 1},
            [f"索引平移 {n}={start}+t，t≥0：a_n={shifted}。", "S_(N+1)−S_N=a_(起点+N)，其符号决定单调性。"])
    if alternating:
        bound = amplitude.subs(n, start+N)
        error_function(bound, f"幅值 {amplitude} 单调趋零；莱布尼茨余项界为首个遗漏项。")
        put("振荡性", "收敛振荡", "通项与部分和", {"符号周期": 2, "余项幅值上界": bound,
            "渐近振荡幅度": 0, "偶奇间距": amplitude.subs(n, start+2*N)},
            ["交错因子 (-1)^n，幅值单调趋零；奇偶部分和分别单调夹逼同一个极限。"])
        put("单调性", "交错夹逼，奇偶子序列单调", "部分和", {"相邻差分": term.subs(n, start+N),
            "隔项差分": sp.Mul(term.subs(n, start+N), (1+ratio).subs(n, start+N), evaluate=False)},
            ["相邻差分随通项变号；隔项差分按奇偶索引分别保持符号。"])
        if report.get("partial_sum_bounds"):
            bounds = report["partial_sum_bounds"]
            put("有界性", "奇偶夹逼界", "全部非空部分和", {"下界": bounds["lower"], "上界": bounds["upper"], "项数范围": bounds["N"]},
                ["首两个部分和包围全部后续奇偶部分和；由幅值单调性递推。"])
    c, power = amplitude.as_coeff_exponent(n)
    if not c.has(n) and not power.has(n) and start.is_positive and not parameters and power.is_real:
        p = -power
        if (p>1) is sp.S.true and absolute_proved:
            lower = c*(start+N)**(1-p)/(p-1)
            upper = c*(start+N-1)**(1-p)/(p-1)
            # Two-sided tail bounds refer to the positive absolute-value tail.
            error_function(upper, "正值递减函数的矩形面积比较：∫_(s+N)^∞ c x^(-p)dx ≤ Σ_(s+N)^∞ c n^(-p) ≤ ∫_(s+N−1)^∞ c x^(-p)dx。",
                           lower=lower if shifted.is_nonnegative or shifted.is_nonpositive else None)
            if shifted.is_nonnegative or shifted.is_nonpositive:
                put("收敛速度", "幂律收敛", "绝对余项", {"渐近等价": f"|R_N| ~ ({c/(p-1)}) N^({1-p})", "渐近阶": f"Θ(N^({1-p}))",
                    "首项常数": c/(p-1), "充分项数条件": f"N≥max(1,ceil(1-({start})+(({c})/(({p}-1)ε))^(1/({p}-1))))"},
                    [f"积分下界={lower}，上界={upper}，两界除以 N^({1-p}) 均趋于 {c/(p-1)}，夹逼得到等价式。"])
                total_bound = c*start**(-p)+c*start**(1-p)/(p-1)
                put("有界性", "统一绝对上界", "所有部分和", {"|S_N| 上界": total_bound},
                    [f"首项加积分：Σ_({n}={start})^∞ |a_n| ≤ {c*start**(-p)}+∫_{start}^∞ {c}x^(-{p})dx={total_bound}。"])
    if alternating and amplitude.is_rational_function(n):
        numerator, denominator = sp.fraction(sp.cancel(amplitude))
        power = sp.degree(numerator, n)-sp.degree(denominator, n)
        constant = sp.LC(sp.Poly(numerator,n))/sp.LC(sp.Poly(denominator,n))
        put("收敛速度", "交错有理通项的幂律上界", "绝对余项",
            {"渐近阶": f"O(N^({power}))", "幅值渐近等价": f"b_n ~ ({constant}) n^({power})", "误差函数": amplitude.subs(n,start+N)},
            [f"分子与分母次数差={power}，首项系数比={constant}；结合莱布尼茨余项界。"])
    if absolute_proved and not parameters and facts:
        q = sp.sympify(facts["absolute_limit"])
        if q.is_positive is True and (q < 1) is sp.S.true:
            stage("由通项比值推导几何速度与多项式修正")
            r = sp.simplify(sp.Abs(ratio))
            quantities = {"幅值比值 r(n)": r, "比值极限 q": q,
                          "每项渐近增加十进位数": (-sp.log(q)/sp.log(10)).evalf(16),
                          "尾部渐近等价": f"Σ_(j≥{start}+N) b_j ~ b_({start}+N)/(1-({q}))",
                          "几何上界族": "任取 q<ρ<1，|R_N|=O(ρ^N)"}
            steps = [f"b_(n+1)/b_n→q={q}∈(0,1)。对任意 ρ∈(q,1)，存在 n₀ 使 n≥n₀ 时比值≤ρ。",
                     "用几何级数支配尾部，逐项比值极限给 Σ_(j≥k)b_j / b_k→1/(1-q)。"]
            if r.is_rational_function(n):
                alpha = sp.limit(n*(r/q-1), n, sp.oo)
                residual = sp.limit(n**2*(r/q-1-alpha/n), n, sp.oo)
                if alpha.is_finite is True and residual.is_finite is True:
                    quantities.update({"多项式指数 α": alpha, "二阶余量极限": residual,
                                       "幅值渐近等价": f"b_n ~ C·({q})^n·n^({alpha})，C>0",
                                       "余项上界阶": f"O(({q})^N·N^({alpha}))"})
                    steps += [f"计算 α=lim n(r(n)/q−1)={alpha}，lim n²(r(n)/q−1−α/n)={residual}。",
                              "故 r(n)=q(1+α/n+O(n⁻²))；对归一化项 b_n/(q^n n^α) 的相邻比值取对数，余量 O(n⁻²) 可和，乘积趋于有限正常数 C。"]
            if alternating:
                quantities["交错余项渐近等价"] = f"|R_N| ~ b_({start}+N)/(1+({q}))"
                steps.append("交错尾除以首个遗漏项，各项比值趋于 (-q)^j；同一几何支配允许极限与求和交换，极限为 1/(1+q)。")
            put("收敛速度", "几何衰减与通项渐近修正", "绝对余项及绝对值尾和", quantities, steps)
    if (absolute_proved and not parameters and not alternating and not geometric
            and (shifted.is_nonnegative or shifted.is_nonpositive)
            and not amplitude.has(sp.factorial) and sp.count_ops(amplitude)<30
            and sp.simplify(-sp.diff(amplitude,n).subs(n,start+t)).is_nonnegative is True
            and "error_function" not in report):
        stage("正项尾部的解析积分夹逼与渐近比较")
        upper = sp.integrate(amplitude,(n,start+N-1,sp.oo))
        lower = sp.integrate(amplitude,(n,start+N,sp.oo))
        if not upper.has(sp.Integral, sp.Piecewise) and upper.is_finite is True:
            error_function(upper, f"正值递减通项 {amplitude}：把尾部矩形面积夹在前后两个广义积分之间。", lower=lower)
            ratio_limit = sp.limit(lower/upper,N,sp.oo)
            put("收敛速度", "积分夹逼渐近等价" if ratio_limit==1 else "解析积分尾界", "绝对余项",
                {"渐近等价" if ratio_limit==1 else "衰减上界": upper, "下界/上界极限": ratio_limit},
                [f"下界={lower}，上界={upper}；其比值极限={ratio_limit}。"])
    if parameters and all(str(p) in plan.variables for p in parameters):
        stage("参数幂级数：收敛半径、边界与一致性质")
        for power_term in term.atoms(sp.Pow):
            if power_term.exp != n or not (power_term.base.free_symbols & set(parameters)):
                continue
            z = power_term.base
            coefficient = sp.simplify(term / power_term)
            if coefficient.free_symbols - {n} or start.is_nonnegative is not True:
                continue
            coefficient_ratio = sp.simplify(sp.Abs(coefficient.subs(n,n+1)/coefficient))
            L = sp.limit(coefficient_ratio,n,sp.oo)
            if not (L.is_nonnegative is True and L.is_finite is True):
                continue
            radius = sp.oo if L == 0 else 1/L
            boundary = {}
            if radius != sp.oo:
                for sign in (-1,1):
                    boundary_term = sp.simplify(coefficient*(sign*radius)**n)
                    result = sp.Sum(boundary_term,(n,start,sp.oo)).is_convergent()
                    absolute_result = sp.Sum(sp.Abs(boundary_term),(n,start,sp.oo)).is_convergent()
                    classification = "绝对收敛" if absolute_result is sp.S.true else "条件收敛" if result is sp.S.true and absolute_result is sp.S.false else "发散" if result is sp.S.false else "符号判别条件待解"
                    boundary[str(sign*radius)] = classification
            put("参数区域", "幂级数内部、边界与外部", term,
                {"幂底 z": z, "系数 c_n": coefficient, "系数比值极限": L, "收敛半径": radius,
                 "绝对收敛内部": f"|{z}|<{radius}", "发散外部": f"|{z}|>{radius}",
                 **{f"边界 {z}={point}": value for point,value in boundary.items()}},
                [f"lim |c_(n+1)/c_n|={L}；乘上 |z| 后用比值判别求收敛半径。",
                 "每个实边界代入原项，独立调用原级数和绝对值级数的符号收敛判别。"], domain="原式定义域；实参数")
            derivative_series = {f"关于 {p} 的逐项导数": sp.Sum(sp.diff(term,p),(n,start,sp.oo)) for p in parameters}
            put("正则性与可微性", "收敛内部解析、局部一致绝对收敛", term,
                {"区域": f"|{z}|<{radius}", "收敛半径": radius, **derivative_series},
                ["幂级数在收敛半径内的紧子区间上一致绝对收敛；各阶导数幂级数保持相同收敛半径。",
                 "幂底为多项式时，复合后在该开区域解析，紧区域上可逐项求导与积分。"],
                domain=f"|{z}|<{radius}；幂底关于参数为多项式" if not z.is_polynomial(*parameters) else f"|{z}|<{radius}")
            if len(parameters)==1 and z==parameters[0] and coefficient.is_rational_function(n):
                stage("参数和函数闭式、零点、符号、极值与可去奇点")
                x=parameters[0]
                interior=sp.Interval.open(-radius,radius)
                closed=sp.summation(term,(n,start,sp.oo))
                if isinstance(closed,sp.Piecewise):
                    for value,condition in closed.args:
                        if not value.has(sp.Sum) and interior.is_subset(condition.as_set()) is True:
                            closed=value
                            break
                if not closed.has(sp.Sum,sp.Piecewise):
                    parameter_function_properties(report,closed,x,interior,sp)
            break
        # A variable exponent changes both convergence class and the uniform rate.
        signed_power = sp.simplify(term/(-1)**n)
        cp, ep = term.as_coeff_exponent(n)
        ca, ea = signed_power.as_coeff_exponent(n)
        alternating_family = not ca.has(n) and not ea.has(n) and bool(ea.free_symbols)
        c, exponent = (ca, ea) if alternating_family else (cp, ep)
        p = -exponent
        if start.is_positive and not c.has(n) and not p.has(n) and p.free_symbols:
            threshold = 0 if alternating_family else 1
            region = f"原式有定义；p={p}>{threshold}；c={c}"
            put("参数区域", "按指数及零系数分区", term,
                {"指数 p": p, "系数 c": c, "绝对收敛域": f"{c}=0 或 {p}>1",
                 "条件收敛域": f"{c}≠0 且 0<{p}≤1" if alternating_family else "空集",
                 "发散域": f"{c}≠0 且 {p}≤{threshold}", "临界指数": "0 与 1" if alternating_family else "1"},
                ["p>1 时绝对值级数由积分判别收敛；p≤1 时非零绝对值级数发散。"]+
                (["p>0 时 n^(-p) 单调趋零，莱布尼茨判别给原级数收敛；p≤0 时通项趋零必要条件失败。"] if alternating_family else []), domain="原式定义域")
            E = sp.Abs(c)*(start+N)**(-p) if alternating_family else sp.Abs(c)*(start+N-1)**(1-p)/(p-1)
            error_function(E, "莱布尼茨首个遗漏项界" if alternating_family else "正值递减幂函数的积分上界", region)
            put("收敛速度", "参数相关幂律界", "截断余项",
                {"误差函数": E, "渐近阶": f"O(N^({-p if alternating_family else 1-p}))",
                 "统一范围条件": f"|c|≤M，p≥p_min>{threshold}",
                 "统一误差界": f"M*(N+{start})^(-p_min)" if alternating_family else f"M*(N+{start}-1)^(1-p_min)/(p_min-1)"},
                ["把 |c| 换成其区域上界 M，把指数换成最小指数 p_min，得到覆盖整个参数区域的支配函数。"], region)
            if c.is_polynomial(*parameters) and p.is_polynomial(*parameters):
                put("正则性与可微性", "收敛开域内任意阶连续可微", term,
                    {"区域": f"{p}>{threshold}", "k 阶导数支配形式": "C_k (1+log(n)^k) n^(-p_min)",
                     "导数幅值最终递减起点": "n>exp(k/p_min)" if alternating_family else "n≥起点",
                     "统一尾界": E},
                    ["在收敛开域的紧子集上，c、p 及其各阶导数有界，p 的最小值严格高于临界指数。",
                     "逐次参数微分产生有限次 log(n) 因子。",
                     "每个 log(n)^j n^(-p_min) 在 n>exp(j/p_min) 后递减趋零，交错判别给导数级数一致收敛。" if alternating_family else
                     "取 ε=(p_min−1)/2>0，log(n)^k≤C_(k,ε)n^ε；比较指数 p_min−ε>1，导数级数一致绝对收敛。",
                     "逐项求导定理逐阶应用，紧线段内可逐项积分。"], domain=region)
        derivatives = {f"关于 {p} 的通项偏导": sp.diff(term,p) for p in parameters}
        derivatives.update({f"关于 {p}、{q} 的通项二阶偏导": sp.diff(term,p,q) for i,p in enumerate(parameters) for q in parameters[i:]})
        put("参数微分计算", "通项的梯度与二阶导数", term, derivatives,
            ["对原通项直接符号求导；和函数逐项求导的条件见正则性证明。"], status="符号计算")
    # Preserve constructive tail results obtained by the general proof engine.
    if report.get("tail_bound") and "error_function" not in report:
        put("误差界", "当前截断位置的严格界", "当前级数尾部",
            {"当前项数": counts[item["name"]], "严格上界": report["tail_bound"]},
            [props["误差界"]]+[s.get("reason",s["result"]) for s in report["calculations"] if s["attribute"]=="误差界"])


def prove_series(plan, item, counts, emit, domains=None, parameter_values=None):
    report = basic_proof(plan, item, counts, emit, domains, parameter_values)
    try:
        rich_analysis(report, plan, item, counts, emit, domains or {}, parameter_values)
    except (NotImplementedError, ValueError, TypeError, ArithmeticError) as error:
        report["analysis_failure"] = {"operation": report["active_step"], "reason": f"{type(error).__name__}: {error}"}
    emit({"kind": "report", "report": report})
    return report


def worker(payload):
    from fractions import Fraction
    from itertools import product
    plan = SeriesFormula(payload["expression"])
    counts = payload["counts"]
    domains = payload.get("parameter_domains", {})
    phase=payload.get("phase","proof")
    items=[item for item in reversed(plan.series) if payload.get("target") in (None,item["name"])]
    reports=payload.get("reports",{})

    def emit(event):
        if event["kind"] == "report":
            reports[event["report"]["name"]] = event["report"]
        print(json.dumps(event, ensure_ascii=False), flush=True)

    if phase == "reference":
        # Reuse the measured results and their exact binary mantissas. Recompute
        # each selected parameter coordinate once, regardless of nesting depth.
        groups = {}
        for name, entry in reports.items():
            sample = entry.get("numerics", {}).get("sample", {})
            if sample.get("computed_mpf") and "reference" not in sample:
                coordinates = tuple((key, sample["context"][key]) for key in plan.variables)
                groups.setdefault(coordinates, {})[name] = sample
        for coordinates, samples in groups.items():
            last_publish = 0
            def reference_progress(event):
                nonlocal last_publish
                now = time.monotonic()
                if now-last_publish < 0.2:
                    return
                last_publish = now
                for entry in reports.values():
                    entry["active_step"] = f"高精度参考重算；参数={dict(coordinates)}；索引 {event.get('index','')} {event.get('current','')}/{event.get('last','')}"
                    entry["numerical_progress"] = {**event, "phase":"reference"}
                    emit({"kind":"report", "report":entry})
            evaluator = SeriesEvaluator(plan, counts, interrupt=lambda:None, progress=reference_progress,
                                        collect_metrics=False, working_precision=max(s["working_digits"] for s in samples.values())+30)
            evaluator.reference_targets = {name:{"record":sample,"value":evaluator.mp.make_mpf(tuple(sample["computed_mpf"]))}
                                           for name,sample in samples.items()}
            reference_progress({"state":"started"})
            try:
                evaluator.evaluate(dict(coordinates))
            except (ArithmeticError, ValueError, TypeError) as error:
                for name, sample in samples.items():
                    sample["reference_failure"] = {"operation":"高精度参考重算", "reason":str(error)}
                    reports[name].setdefault("phase_errors", {})[phase] = sample["reference_failure"]
            for entry in reports.values():
                if entry["name"] in samples and "reference" in samples[entry["name"]]:
                    entry["active_step"] = f"高精度参考重算完成；参数={dict(coordinates)}"
                emit({"kind":"report", "report":entry})
        emit({"kind":"done"})
        return

    for item in items if phase != "numerical" else []:
        # Emit a placeholder before a potentially slow symbolic operation.
        current = reports.get(item["name"],empty_report(item,counts))
        emit({"kind": "report", "report": current})
        try:
            if phase=="proof":
                stages=current.get("phases",{})
                current=basic_proof(plan,item,counts,emit,domains)
                current["phases"]=stages
            else:
                rich_analysis(current,plan,item,counts,emit,domains,None)
                for case in current.get("parameter_cases",[]):
                    try:
                        rich_analysis(case,plan,item,counts,lambda event:None,domains,case["parameters"])
                    except (NotImplementedError,ValueError,TypeError,ArithmeticError) as error:
                        case["analysis_failure"]={"operation":case.get("active_step"),"reason":str(error)}
        except Exception as error:
            current = reports[item["name"]]
            detail=f"{type(error).__name__}：{str(error)[:300]}"
            current["phase_errors"]={**current.get("phase_errors",{}),phase: {"operation":current.get("active_step"),"reason":detail}}
            emit({"kind": "incomplete", "name": item["name"],
                  "reason": detail})
        reports[item["name"]] = current
        emit({"kind":"report","report":current})
    numerical = phase=="numerical"
    if numerical or (phase=="proof" and plan.variables and any(current["convergence"] == UNKNOWN for current in reports.values())):
        if all(name in domains for name in plan.variables):
            names = plan.variables
            expected = 1
            for name in names:
                expected *= domains[name]["count"]
            last_publish=0
            active_numeric_phase="numerical"
            def numeric_progress(event):
                nonlocal last_publish,active_numeric_phase
                if event.get("phase"):
                    active_numeric_phase=event["phase"]
                now=time.monotonic()
                if now-last_publish<0.2 and event.get("state") not in ("started","completed"):
                    return
                last_publish=now
                for entry in reports.values():
                    entry["numerical_progress"]={**event,"phase":active_numeric_phase}
                    entry["active_step"]=("高精度参考重算" if active_numeric_phase=="reference" else "有限项数值诊断")+f"；索引 {event.get('index','')} {event.get('current','')}/{event.get('last','')}"
                    if entry["name"] in evaluator.metrics:
                        attach_metrics(entry,evaluator.metrics[entry["name"]])
                    emit({"kind":"report","report":entry})
            evaluator = SeriesEvaluator(plan, counts, [domains[name][key] for name in names for key in ("min", "max", "step")],progress=numeric_progress)
            evaluator.evaluate_reference = False
            emit({"kind": "progress", "stage": f"计算有限项和、绝对值和与条件数；共 {expected} 个采样点"})
            for ordinal, indices in enumerate(product(*(range(domains[name]["count"]) for name in names)), 1):
                coordinates = {name: str(Fraction(domains[name]["min"]) + index * Fraction(domains[name]["step"]))
                               for name, index in zip(names, indices)}
                for item in items if phase=="proof" else []:
                    current = reports[item["name"]]
                    if names and current["convergence"] == UNKNOWN:
                        try:
                            case = None
                            if len(names) == 1 and current.get("regions"):
                                import sympy as sp
                                point = sp.Rational(coordinates[names[0]])
                                for region in current["regions"]:
                                    region_set = sp.sympify(region["condition"])
                                    if isinstance(region_set, set): region_set = sp.FiniteSet(*region_set)
                                    if region_set.contains(point) is sp.S.true:
                                        case = {"convergence": region["convergence"], "proof": [],
                                                "calculations": [{"attribute": "收敛性", "operation": "代入已证明的参数区域",
                                                    "expression": f"{names[0]}={point} ∈ {region['condition']}", "result": "True", "status": "已证明"}],
                                                "properties": {"证明状态": current["properties"]["证明状态"]}}
                                        break
                            if case is None:
                                def case_progress(event):
                                    if event["kind"] == "progress":
                                        current["active_step"] = f"参数={coordinates}；{event['stage']}"
                                        emit({"kind": "report", "report": current})
                                case = basic_proof(plan, item, counts, case_progress, domains, coordinates)
                            case.update({"parameters":coordinates,"reason":case["properties"].get("证明状态"),"name":item["name"],"infinite":item["infinite"]})
                            current.setdefault("parameter_cases", []).append(case)
                        except Exception as error:
                            current.setdefault("parameter_cases", []).append({"parameters": coordinates,
                                "convergence": UNKNOWN, "reason": f"{type(error).__name__}: {error}"})
                try:
                    if numerical:
                        for current in reports.values():
                            current["active_step"] = f"有限项数值诊断，参数={coordinates}，采样点 {ordinal}/{expected}"
                            emit({"kind": "report", "report": current})
                        evaluator.evaluate(coordinates)
                except (ValueError, ArithmeticError, TypeError) as error:
                    for current in reports.values():
                        current["numerical_failure"] = {"parameters": coordinates, "operation": "有限项求值", "reason": str(error)}
                for current in reports.values():
                    if current["name"] in evaluator.metrics:
                        attach_metrics(current, evaluator.metrics[current["name"]])
                    current["grid_progress"] = {"completed": ordinal, "total": expected}
                    emit({"kind": "report", "report": current})
            for current in reports.values():
                cases = current.get("parameter_cases", [])
                statuses = {case["convergence"] for case in cases}
                if len(cases) == expected and len(statuses) == 1 and UNKNOWN not in statuses:
                    current["convergence"] = next(iter(statuses))
                    current["proof_scope"] = "配置的离散采样网格（逐点证明）"
                    emit({"kind": "report", "report": current})
        else:
            for current in reports.values():
                current["numerical_failure"] = {"operation": "读取参数采样配置", "reason": "缺少参数范围：" + ", ".join(name for name in plan.variables if name not in domains)}
                emit({"kind": "report", "report": current})
    emit({"kind": "done"})


def run_phase(payload, reports, progress, interrupt, timeout):
    phase=payload["phase"]
    label={"proof":"收敛证明","properties":"属性推导","numerical":"数值诊断","reference":"高精度复核"}[phase]
    names=list(payload["reports"])
    started=time.monotonic()
    process = None
    reader = None
    completed=False
    failure=None
    for name in names:
        reports[name].setdefault("phases",{})[phase]={"label":label,"state":"running"}
    try:
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        process = subprocess.Popen([sys.executable, "-u", str(Path(__file__).resolve()), "--worker"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, encoding="utf-8", creationflags=flags)
        process.stdin.write(json.dumps(payload) + "\n")
        process.stdin.close()
        events = queue.Queue()

        def read():
            for line in process.stdout:
                try:
                    events.put(json.loads(line))
                except ValueError:
                    continue
            events.put(None)

        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        started = time.monotonic()
        while time.monotonic() - started < timeout:
            interrupt()
            try:
                event = events.get(timeout=0.1)
            except queue.Empty:
                continue
            if event is None:
                break
            if event["kind"] == "report":
                entry=event["report"]
                stages=reports[entry["name"]].get("phases",{})
                entry["phases"]=stages
                reports[entry["name"]]=entry
            elif event["kind"] == "incomplete":
                failure=event["reason"]
            elif event["kind"] == "done":
                completed=True
                break
            progress(event)
    except (OSError, subprocess.SubprocessError) as error:
        failure=f"分析进程启动或通信失败：{error}"
    finally:
        if process:
            if process.poll() is None:
                process.kill()
            process.wait()
            if reader:
                reader.join(timeout=1)
            if process.returncode and not completed:
                detail=process.stderr.read()[-1500:]
                if detail: failure=detail
            for stream in (process.stdout, process.stderr):
                stream.close()
    elapsed=time.monotonic()-started
    for name in names:
        entry=reports[name]
        detail=failure or entry.get("phase_errors",{}).get(phase,{}).get("reason")
        if phase=="numerical" and entry.get("numerical_failure"):
            detail=entry["numerical_failure"]["reason"]
        state="failed" if detail else "completed" if completed else "timeout"
        stage={"label":label,"state":state,"seconds":round(elapsed,3),"budget_seconds":timeout,
               "operation":entry.get("active_step")}
        if state!="completed":
            stage["reason"]=detail or f"{label}达到 {timeout:g} 秒预算；停止于 {entry.get('active_step')}。本阶段已经产生的结果已保存。"
        entry.setdefault("phases",{})[phase]=stage
        progress({"kind":"report","report":entry})


def analyze(expression, counts, progress=lambda event: None, interrupt=lambda: None, timeout=20, parameter_domains=None, evaluate_numerics=True):
    plan=SeriesFormula(expression)
    reports={item["name"]:empty_report(item,counts) for item in plan.series}
    if not reports:
        return {"series":[],"summary":"没有求和级数；按普通表达式采样。","complete":True}
    waiting=time.monotonic()
    progress({"kind":"progress","stage":"等待分析器；证明、属性和数值诊断分别计时"})
    while not _WORKER_SLOT.acquire(timeout=0.1):
        interrupt()
        if time.monotonic()-waiting>timeout:
            return {"series":list(reports.values()),"complete":False,"summary":"分析器排队等待超时；当前请求尚未开始计算。"}
    try:
        for phase in ("proof","properties"):
            for item in reversed(plan.series):
                interrupt()
                name=item["name"]
                run_phase({"expression":expression,"counts":counts,"parameter_domains":parameter_domains or {},
                           "phase":phase,"target":name,"reports":{name:reports[name]}},
                          reports,progress,interrupt,timeout)
        if evaluate_numerics:
            run_phase({"expression":expression,"counts":counts,"parameter_domains":parameter_domains or {},
                       "phase":"numerical","reports":reports},reports,progress,interrupt,timeout)
            if any(entry.get("numerics",{}).get("sample",{}).get("computed_mpf") for entry in reports.values()):
                run_phase({"expression":expression,"counts":counts,"parameter_domains":parameter_domains or {},
                           "phase":"reference","reports":reports},reports,progress,interrupt,timeout)
    finally:
        _WORKER_SLOT.release()
    complete=all(stage["state"]=="completed" for entry in reports.values() for stage in entry.get("phases",{}).values())
    issues=[f"{entry['name']} · {stage['label']}：{stage['reason']}" for entry in reports.values()
            for stage in entry.get("phases",{}).values() if stage["state"]!="completed"]
    reason="证明、属性推导与数值诊断已完成；包含近似通项时已完成高精度复核。" if complete and evaluate_numerics else "证明与属性推导已完成；有限项计算在执行阶段进行。" if complete else "\n".join(issues)
    for entry in reports.values():
        gap_methods = {
            "振荡性": "同号检查与 (-1)^n / 三角因子分解没有给出全索引符号划分",
            "单调性": "通项符号、幅值差分与导数检查尚未给出覆盖全部索引的正负判定",
            "有界性": "现有收敛/符号检查未提供部分和夹逼区间或统一上界",
            "收敛速度": "已完成判别没有构造出随截断项数 N 变化的尾界",
            "绝对收敛与条件收敛": "绝对值级数的比较/符号判别没有返回确定真假",
            "求和顺序敏感性": "需要绝对收敛或条件收敛的分类作为重排定理前提",
            "正则性与可微性": "需要参数域内的统一支配级数或导数级数界",
        }
        entry["gaps"] = [{"attribute": key, "operation": entry.get("active_step"),
                          "reason": entry.get("incomplete") or gap_methods.get(key) or entry["properties"].get("证明状态") or "本属性的符号步骤尚未执行",
                          "input": entry.get("term", expression)}
                         for key in PROPERTY_NAMES if key not in entry["properties"] and key not in entry.get("analysis", {}) and key != "数值稳定性"]
    return {"series": list(reports.values()), "complete": complete, "summary": reason,
            "precision_note": "误差分项：级数截断、有限项运算、输出转换。合成界的适用对象为所标明的单层级数；嵌套式与复合表达式分别分析。"}


if __name__ == "__main__" and "--worker" in sys.argv:
    sys.stdout.reconfigure(encoding="utf-8")
    worker(json.loads(sys.stdin.readline()))
