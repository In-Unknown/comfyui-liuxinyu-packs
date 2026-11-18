"""Math grammar, exact-input evaluation and conservative symbolic proof regression."""

import ast
import json
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

PACK = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACK), str(PACK.parents[1])]

from function_series import SeriesFormula, SeriesEvaluator, int64, INT_MAX, INT_MIN
from function_series_analysis import analyze


class SeriesTests(unittest.TestCase):
    def test_rich_geometric_metadata_and_boundaries(self):
        report = analyze("sum(n=0 to INF)(1/2)^n", {"n": 10})["series"][0]
        self.assertNotIn("analysis_failure", report)
        self.assertEqual(report["analysis"]["收敛速度"]["status"], "已证明")
        self.assertIn("精确余项", report["analysis"]["误差界"]["classification"])
        quantities = {q["label"]: q["value"] for q in report["analysis"]["有界性"]["quantities"]}
        self.assertIn("极限端", quantities["取到条件"])
        boundary = analyze("sum(n=0 to INF)(-1)^n", {"n": 6})["series"][0]
        self.assertEqual(boundary["convergence"], "确定发散")
        self.assertIn("下极限", str(boundary["analysis"]["边界性质"]))

    def test_rich_power_tail_and_alternating_rate(self):
        import sympy as sp
        report = analyze("sum(n=1 to INF)1/n^2", {"n": 20})["series"][0]
        self.assertNotIn("analysis_failure", report)
        N = sp.Symbol("N", positive=True, integer=True)
        upper = sp.sympify(report["error_function"]["upper"], locals={"N": N})
        self.assertEqual(sp.simplify(upper-1/N), 0)
        values = {q["label"]: q["value"] for q in report["analysis"]["误差界"]["quantities"]}
        self.assertEqual(sp.simplify(sp.sympify(values["截断误差下界"], locals={"N": N})-1/(N+1)), 0)
        alternate = analyze("sum(n=0 to INF)(-1)^n/(2n+1)", {"n": 20})["series"][0]
        self.assertEqual(alternate["analysis"]["绝对收敛与条件收敛"]["classification"], "条件收敛")
        self.assertIn("重排敏感", alternate["analysis"]["求和顺序敏感性"]["classification"])
        self.assertIn("O(N^(-1))", str(alternate["analysis"]["收敛速度"]))

    def test_rich_parameter_derivatives_and_power_boundary(self):
        domains = {"x": {"min": "-1", "max": "1", "step": "1", "count": 3}}
        report = analyze("sum(n=0 to INF)x^n", {"n": 5}, parameter_domains=domains, evaluate_numerics=False)["series"][0]
        self.assertNotIn("analysis_failure", report)
        self.assertIn("二阶导数矩阵", str(report["analysis"]["正则性与可微性"]))
        report = analyze("sum(n=1 to INF)x^n/n", {"n": 5}, parameter_domains=domains, evaluate_numerics=False)["series"][0]
        self.assertNotIn("analysis_failure", report)
        entries = {q["label"]: q["value"] for q in report["analysis"]["参数区域"]["quantities"]}
        self.assertEqual(entries["边界 x=-1"], "条件收敛")
        self.assertEqual(entries["边界 x=1"], "发散")

    def test_separable_double_sum_order_and_rectangle(self):
        report = analyze("sum(n=1 to INF)sum(m=1 to INF)1/(2^n*3^m)", {"n": 4, "m": 5})
        self.assertTrue(all(s["convergence"]=="确定收敛" for s in report["series"]))
        outer = next(s for s in report["series"] if s["name"]=="n")
        self.assertNotIn("analysis_failure", outer)
        self.assertEqual(outer["convergence"], "确定收敛")
        quantities = {q["label"]: q["value"] for q in outer["analysis"]["求和顺序敏感性"]["quantities"]}
        self.assertEqual(quantities["先内后外"], "1/2")
        self.assertEqual(quantities["先外后内"], "1/2")
        self.assertIn("N", quantities["有限矩形和"])
        self.assertIn("M", quantities["有限矩形和"])

    def test_finite_observations_and_backward_error(self):
        evaluator = SeriesEvaluator(SeriesFormula("sum(n=0 to 2)[10^10*(1-n)+n*(2-n)]"), {})
        evaluator.evaluate({})
        value = evaluator.metrics["n"]["sample"]
        observations = value["finite_observations"]
        self.assertEqual(observations["positive_terms"], 2)
        self.assertEqual(observations["negative_terms"], 1)
        self.assertEqual(observations["sign_changes"], 1)
        self.assertEqual(observations["max_index"], "1")
        self.assertEqual(observations["min_index"], "2")
        self.assertEqual(value["backward_error"], "0.0")

    def test_parameter_removable_singularity_from_reference_document(self):
        report = analyze("sum(n=0 to INF)x^n/(n+1)", {"n": 10}, evaluate_numerics=False,
                         parameter_domains={"x": {"min": "0", "max": "1/2", "step": "1/2", "count": 2}})["series"][0]
        self.assertNotIn("analysis_failure", report)
        singularity = report["analysis"]["参数奇异性：0"]
        self.assertEqual(singularity["classification"], "可去奇点")
        values = {q["label"]: q["value"] for q in singularity["quantities"]}
        self.assertEqual(values["连续补充值"], "1")
        self.assertEqual(report["analysis"]["参数奇异性：1"]["classification"], "对数分支点")

    def test_double_sum_preserves_original_domain_holes(self):
        report = analyze("sum(n=1 to INF)sum(m=1 to INF)((n-2)/(n-2))/(2^n*3^m)", {"n": 3,"m": 3})["series"][0]
        self.assertNotEqual(report["convergence"], "确定收敛")
        self.assertEqual(report["analysis"]["求和顺序敏感性"]["classification"], "原式定义域检查")

    def evaluate(self, text, counts=None, values=None):
        plan = SeriesFormula(text)
        engine = SeriesEvaluator(plan, counts or {})
        return engine.text(engine.evaluate(values or {}))

    def test_decimal_precision_and_large_integers(self):
        self.assertEqual(self.evaluate("0.1+0.2"), "0.3")
        self.assertEqual(self.evaluate("0.1+0.2-0.3"), "0.0")
        self.assertEqual(self.evaluate("1/3+1/3+1/3-1"), "0.0")
        self.assertEqual(self.evaluate("9223372036854775807-9223372036854775806"), "1.0")
        self.assertEqual(self.evaluate("1e100 + 1 - 1e100"), "1.0")
        self.assertEqual(int64(str(INT_MAX), "值"), INT_MAX)
        self.assertEqual(int64(str(INT_MIN), "值"), INT_MIN)
        import math
        from decimal import Decimal
        large_factorial = self.evaluate("2000!")
        self.assertGreater(len(large_factorial), 4300)
        self.assertEqual(Decimal(large_factorial), Decimal(math.factorial(2000)))
        for value in (str(INT_MAX + 1), str(INT_MIN - 1), 1.0, True, "1.5"):
            with self.assertRaises(ValueError): int64(value, "值")

    def test_finite_and_nested_scope(self):
        self.assertEqual(self.evaluate("∑(k=1 to 3) k"), "6.0")
        self.assertEqual(self.evaluate("sum(k=1 to 2) sum(项数=1 to k) 项数"), "4.0")
        self.assertEqual(self.evaluate("(sum(k=1 to 3) k)+(sum(m=1 to 2) m)"), "9.0")
        self.assertEqual(self.evaluate("sum(k=1 to 3) [k] + sum(m=1 to 2) [m]"), "9.0")
        self.assertEqual(self.evaluate("sum([项数=1] to [3]) [项数]"), "6.0")
        self.assertEqual(self.evaluate("sum(k=3 to 1) k"), "0.0")
        self.assertEqual(self.evaluate("sum(k=1 to INF) sum(m=1 to ∞) (k+m)", {"k": 2, "m": 3}), "21.0")
        self.assertEqual(self.evaluate("sum(k=1 to INF) [1]", {"k": 5000}), "5000.0")

    def test_operators(self):
        self.assertEqual(self.evaluate("|-3|×3!"), "18.0")
        self.assertEqual(self.evaluate("|1-|3||"), "2.0")
        self.assertEqual(self.evaluate("-2^2"), "-4.0")
        self.assertEqual(self.evaluate("2^3^2"), "512.0")
        self.assertEqual(self.evaluate("(2+1)!"), "6.0")
        self.assertEqual(self.evaluate("5//2"), "2.0")
        self.assertEqual(self.evaluate("-5%2"), "1.0")
        for expression in ("(-1)!", "1.5!"):
            with self.assertRaises(ValueError): self.evaluate(expression)
        with self.assertRaises(ValueError): self.evaluate("(1+1/10^100)!")
        with self.assertRaises(ValueError): self.evaluate("sum(k=1+1/10^100 to 2) k")

    def test_implicit_numeric_multiplication(self):
        self.assertEqual(self.evaluate("2n+0.5n+3(n+1)", values={"n": "2"}), "14.0")
        self.assertEqual(self.evaluate("2项数", values={"项数": "3"}), "6.0")
        self.assertEqual(self.evaluate("2sin(0)+2e3"), "2000.0")
        self.assertEqual(SeriesFormula("2xy").variables, ["xy"])
        self.assertEqual(self.evaluate("sum(n=0 to ∞)(-1)^n/(2n+1)", {"n": 3}), self.evaluate("sum(n=0 to INF)(-1)^n/(2*n+1)", {"n": 3}))
        self.assertEqual(self.evaluate("1/2n", values={"n": "4"}), "2.0")

    def test_measured_conditioning_and_zero_sum(self):
        for expression, expected in [("sum(n=0 to 2)[10^10*(1-n)+n*(2-n)]", "20000000001"),
                                     ("sum(n=1 to 3)n", "1"), ("sum(n=0 to 1)(-1)^n", None)]:
            evaluator = SeriesEvaluator(SeriesFormula(expression), {})
            evaluator.evaluate({})
            sample = evaluator.metrics["n"]["sample"]
            self.assertEqual(sample.get("condition_exact"), expected)
            self.assertEqual(sample["summation_roundoff"], "0.0")
            if expected is None:
                self.assertEqual(sample["condition"], "∞")
                self.assertIsNone(sample["relative_roundoff"])

    def test_leibniz_computed_proof_and_metrics(self):
        report = analyze("sum(n=0 to INF)(-1)^n/(2n+1)", {"n": 5000})["series"][0]
        self.assertEqual(report["tail_bound"], "1/10001")
        self.assertEqual(report["partial_sum_bounds"]["lower"], "2/3")
        self.assertEqual(report["partial_sum_bounds"]["upper"], "1")
        self.assertTrue(any(step["result"] == "1/2" for step in report["calculations"]))
        self.assertTrue(any(step["status"] == "无判别力" for step in report["calculations"]))
        sample = report["numerics"]["sample"]
        self.assertAlmostEqual(float(sample["condition"]), 6.67264769154, places=10)
        self.assertEqual(sample["summation_roundoff"], "0.0")
        self.assertIn("total_error", sample)
        self.assertEqual(report["gaps"], [])

    def test_parameter_interval_and_boundary_proofs(self):
        domain = {"x": {"min": "0", "max": "1/2", "step": "1/4", "count": 3}}
        report = analyze("sum(n=0 to INF)x^n", {"n": 20}, parameter_domains=domain)["series"][0]
        self.assertEqual(report["convergence"], "确定收敛")
        self.assertEqual(report["tail_bound"], "1/524288")
        self.assertEqual(report["numerics"]["invocations"], 3)
        self.assertEqual(report["gaps"], [])
        domain["x"].update({"max": "1", "step": "1/2"})
        report = analyze("sum(n=0 to INF)x^n", {"n": 20}, parameter_domains=domain)["series"][0]
        self.assertEqual(report["range_classification"], "范围内既有收敛点也有发散点")
        self.assertIn("{1}", report["regions"][1]["condition"])
        self.assertEqual(report["parameter_cases"][-1]["convergence"], "确定发散")
        self.assertEqual(report["parameter_cases"][0]["convergence"], "确定收敛")

    def test_parameter_power_and_alternating_power_ranges(self):
        domain = {"p": {"min": "2", "max": "3", "step": "1", "count": 2}}
        report = analyze("sum(n=1 to INF)1/n^p", {"n": 10}, parameter_domains=domain)["series"][0]
        self.assertEqual(report["convergence"], "确定收敛")
        self.assertEqual(report["tail_bound"], "1/10")
        domain["p"].update({"min": "1/2", "max": "3/2", "step": "1/2", "count": 3})
        report = analyze("sum(n=1 to INF)(-1)^n/n^p", {"n": 10}, parameter_domains=domain)["series"][0]
        self.assertEqual(report["convergence"], "确定收敛")
        self.assertEqual(report["proof_scope"], "配置闭区间的笛卡尔积")
        self.assertIn("条件收敛", report["properties"]["绝对收敛与条件收敛"])
        self.assertEqual(report["numerics"]["invocations"], 3)

    def test_parameter_hole_and_failure_details(self):
        domain = {"x": {"min": "0", "max": "1", "step": "1/2", "count": 3}}
        report = analyze("sum(n=0 to INF)((x-0.5)/(x-0.5))*x^n", {"n": 5}, parameter_domains=domain)
        entry = report["series"][0]
        self.assertFalse(report["complete"])
        self.assertNotEqual(entry["convergence"], "确定收敛")
        self.assertIn("numerical_failure", entry)
        self.assertTrue(any(step["operation"] == "参数域分母检查" for step in entry["calculations"]))

    def test_float_diagnostics_measure_accumulation_and_range(self):
        evaluator = SeriesEvaluator(SeriesFormula("sum(n=1 to 3)sin(n)"), {})
        evaluator.evaluate({})
        sample = evaluator.metrics["n"]["sample"]
        self.assertEqual(sample["algorithm"], "mpmath.fsum")
        self.assertFalse(sample["term_values_exact"])
        self.assertIn("summation_roundoff", sample)
        self.assertEqual(sample["reference"]["precision"], evaluator.mp.dps + 30)
        self.assertGreaterEqual(float(sample["reference"]["absolute_difference"]), 0)
        for value, category in [("1e400", "溢出"), ("1e-400", "下溢为零")]:
            engine = SeriesEvaluator(SeriesFormula(f"sum(n=1 to 2){value}"), {})
            engine.evaluate({})
            self.assertEqual(engine.metrics["n"]["sample"]["binary64_result_class"], category)

    def test_variable_discovery_and_invalid_grammar(self):
        self.assertEqual(SeriesFormula("sum(项数=1 to 4) x^项数 + y").variables, ["x", "y"])
        for expression in ("sum(k=1 to 2) sum(k=1 to 3) k", "k+(sum(k=1 to 2) k)",
                           "(sum(k=1 to 2) k)+k", "__import__('os')", "x.foo", "3!!", "sum(k=k to 4) k"):
            with self.subTest(expression=expression), self.assertRaises(ValueError): SeriesFormula(expression)

    def test_symbolic_classification_and_bounds(self):
        for expression, status, method, bound in [
            ("sum(k=1 to INF) 1/k", "确定发散", "p 级数", False),
            ("sum(k=1 to INF) 1/k^2", "确定收敛", "p 级数", True),
            ("sum(k=1 to INF) (-1)^(k+1)/k", "确定收敛", "莱布尼茨", True),
            ("sum(k=1 to INF) 1/2^k", "确定收敛", "比值", True),
            ("sum(k=1 to INF) k", "确定发散", "必要条件", False),
            ("sum(k=0 to INF) 1/k!", "确定收敛", "比值", True),
            ("sum(k=1 to INF) sin(k)/k", "确定收敛", "Dirichlet", True),
            ("sum(k=2 to INF) 1/(k*log(k)^2)", "确定收敛", "积分", True),
        ]:
            with self.subTest(expression=expression):
                report = analyze(expression, {"k": 10}, timeout=8)["series"][0]
                self.assertEqual(report["convergence"], status, report)
                self.assertTrue(any(method in proof["method"] for proof in report["proof"]), report)
                if bound: self.assertIn("严格", report["properties"]["误差界"])
                if "(-1)" in expression:
                    self.assertIn("条件收敛", report["properties"]["绝对收敛与条件收敛"])

    def test_unknown_parameters_and_nested_total_error(self):
        report = analyze("sum(k=1 to INF) x^k", {"k": 20}, timeout=6)["series"][0]
        self.assertEqual(report["convergence"], "暂时无法确定")
        report = analyze("sum(k=1 to INF) sum(m=1 to INF) 1/(k*m)^2", {"k": 4, "m": 5}, timeout=6)
        self.assertEqual(report["series"][0]["convergence"], "确定收敛")
        self.assertEqual(report["series"][1]["convergence"], "确定收敛")
        self.assertIn("矩形截断", report["series"][0]["analysis"]["误差界"]["classification"])
        self.assertIn("嵌套式", report["precision_note"])

    def test_variable_exponent_is_not_a_p_series_bound(self):
        report = analyze("sum(k=1 to INF) 1/k^k", {"k": 10}, timeout=6)["series"][0]
        self.assertEqual(report["convergence"], "确定收敛")
        self.assertNotIn("积分尾界", report["properties"]["误差界"])

    def test_singular_prefix_not_silently_discarded(self):
        report = analyze("sum(k=1 to INF) 1/(k-10)^2", {"k": 5}, timeout=6)["series"][0]
        self.assertNotEqual(report["convergence"], "确定收敛")
        self.assertTrue(any(word in report["properties"]["证明状态"] for word in ("奇点", "零点")))
        report = analyze("sum(k=1 to INF) ((k-10)/(k-10))/k^2", {"k": 5}, timeout=6)["series"][0]
        self.assertNotEqual(report["convergence"], "确定收敛")
        self.assertIn("约分", report["properties"]["证明状态"])

    def test_timeout_preserves_unknown_and_returns(self):
        report = analyze("sum(k=1 to INF) 1/k", {"k": 5}, timeout=0.001)
        self.assertFalse(report["complete"])
        self.assertEqual(report["series"][0]["convergence"], "暂时无法确定")

    def test_term_count_int64_and_per_invocation_semantics(self):
        from function_series import series_counts
        plan = SeriesFormula("sum(k=1 to INF) [sum(m=1 to INF) [1]]")
        counts = series_counts(plan, {"series": {"k": "5000", "m": str(INT_MAX)}}, {"terms1": "2"})
        self.assertEqual(counts, {"k": 2, "m": INT_MAX})
        for count in (0, -1, 1.0, True, str(INT_MAX + 1)):
            with self.assertRaises(ValueError): series_counts(plan, {"series": {"k": count}}, {})

    def test_analytic_tail_bound_dominates_high_precision_error(self):
        import mpmath
        from function_series_analysis import prove_series
        plan = SeriesFormula("sum(k=1 to INF) [(-1)^(k+1)/k]")
        report = prove_series(plan, plan.series[0], {"k": 10}, lambda event: None)
        self.assertIn("11", report["properties"]["误差界"])
        mp = mpmath.mp.clone(); mp.dps = 60
        partial = mp.mpf(self.evaluate(plan.expression, {"k": 10}))
        self.assertLess(abs(partial - mp.log(2)), mp.mpf(1) / 11)

    def test_ramanujan_tail_has_computed_certificate(self):
        import sympy as sp
        import mpmath
        expression = "sum(k=0 to INF)[((4*k)!*(1103+26390*k))/((k!)^4*396^(4*k))]"
        report = analyze(expression, {"k": 3})["series"][0]
        self.assertEqual(report["convergence"], "确定收敛")
        self.assertTrue(any(step["operation"] == "尾部有理比值的系数界" for step in report["calculations"]))
        bound = sp.sympify(report["tail_bound"])
        self.assertTrue(bound.is_Rational)
        mp = mpmath.mp.clone(); mp.dps = 100
        reference = mp.mpf(9801) / (2 * mp.sqrt(2) * mp.pi)
        partial = mp.mpf(self.evaluate(expression, {"k": 3}))
        self.assertLess(abs(reference - partial), mp.mpf(str(sp.N(bound, 90))))

    def test_abel_and_limit_comparison_paths(self):
        report = analyze("sum(k=1 to INF) [(1-1/k)*(-1)^k/k]", {"k": 10}, timeout=6)["series"][0]
        self.assertEqual(report["convergence"], "确定收敛", report)
        self.assertTrue(any("Abel" in step["method"] for step in report["proof"]), report)
        report = analyze("sum(k=1 to INF) [(k+1)/(k^3+1)]", {"k": 10}, timeout=6)["series"][0]
        self.assertEqual(report["convergence"], "确定收敛", report)
        self.assertTrue(any("极限比较" in step["method"] for step in report["proof"]), report)


class PipelineRegressionTests(unittest.TestCase):
    def test_factorial_recurrence_reuses_and_resets_exactly(self):
        import math
        from fractions import Fraction
        evaluator = SeriesEvaluator(SeriesFormula("1"), {})
        original = math.factorial
        with patch("function_series.math.factorial", wraps=original) as factorial:
            for k in (0, 1, 4, 9, 9, 2, 3, 100):
                self.assertEqual(evaluator.factorial_at("site", Fraction(k)), original(k))
            self.assertEqual(factorial.call_count, 3)
        self.assertEqual(len(evaluator.factorial_states), 1)

    def test_dyadic_diagnostics_match_exact_fraction_arithmetic(self):
        from fractions import Fraction
        evaluator = SeriesEvaluator(SeriesFormula("1"), {})
        values = [evaluator.mp.sqrt(2)*10**20, Fraction(1,3), -evaluator.mp.sqrt(2)*10**20]
        expected = sum((evaluator.exact_fraction(value) for value in values), Fraction(0))
        total = Fraction(0)
        for value in values:
            total = evaluator.add_measured(total, value)
        self.assertEqual(evaluator.exact_fraction(total), expected)
        self.assertEqual(expected, Fraction(1,3))
        # The long exact dyadic sum retains small terms beyond working precision.
        total = evaluator.add_measured(evaluator.mp.mpf(2)**400, evaluator.mp.mpf(1))
        total = evaluator.add_measured(total, -evaluator.mp.mpf(2)**400)
        self.assertEqual(evaluator.exact_fraction(total), 1)

    def test_nested_reference_repeats_expression_once(self):
        events, calls = [], []
        original = SeriesEvaluator.evaluate
        def observe(evaluator, coordinates):
            calls.append(evaluator.mp.dps)
            return original(evaluator, coordinates)
        evaluator = SeriesEvaluator(SeriesFormula("sum(n=1 to 3)sum(m=1 to 4)sin(n+m)"), {}, progress=events.append)
        with patch.object(SeriesEvaluator, "evaluate", observe):
            value = evaluator.evaluate({})
        self.assertEqual(calls, [80, 110])
        self.assertEqual(evaluator.metrics["m"]["invocations"], 3)
        self.assertEqual(evaluator.operations, 15)
        self.assertTrue(evaluator.mp.isfinite(value))
        for metric in evaluator.metrics.values():
            self.assertEqual(metric["sample"]["reference"]["precision"], 110)
        self.assertEqual(events[0]["phase"], "numerical")
        self.assertEqual(events[-1]["phase"], "reference")

    def test_numerical_timeout_preserves_proof_and_phase_identity(self):
        import function_series_analysis as module
        original = module.run_phase
        def limited(payload, reports, progress, interrupt, timeout):
            return original(payload, reports, progress, interrupt, 0.001 if payload["phase"]=="numerical" else timeout)
        with patch.object(module, "run_phase", limited):
            report = analyze("sum(n=0 to INF)(1/2)^n", {"n": 5000})
        entry = report["series"][0]
        self.assertFalse(report["complete"])
        self.assertEqual(entry["convergence"], "确定收敛")
        self.assertEqual(entry["phases"]["proof"]["state"], "completed")
        self.assertEqual(entry["phases"]["properties"]["state"], "completed")
        self.assertEqual(entry["phases"]["numerical"]["state"], "timeout")
        self.assertIn("数值诊断", report["summary"])
        self.assertNotIn("符号分析超时", report["summary"])

    def test_slow_series_does_not_block_other_series_stages(self):
        seen = []
        def phase(payload, reports, progress, interrupt, timeout):
            for name in payload["reports"]:
                stage = payload["phase"]
                seen.append((name, stage))
                state = "timeout" if name=="n" and stage=="proof" else "completed"
                reports[name].setdefault("phases", {})[stage] = {"state":state,"label":stage,"reason":"test budget"}
        with patch("function_series_analysis.run_phase", phase):
            analyze("sum(n=0 to INF)(1/2)^n+sum(m=1 to INF)1/m^2", {"n":4,"m":4})
        self.assertEqual(set(seen), {(name,stage) for name in ("n","m") for stage in ("proof","properties","numerical")})

    def test_reference_timeout_preserves_finished_measurements(self):
        import function_series_analysis as module
        original = module.run_phase
        def limited(payload, reports, progress, interrupt, timeout):
            return original(payload, reports, progress, interrupt, 0.001 if payload["phase"]=="reference" else timeout)
        with patch.object(module, "run_phase", limited):
            report = analyze("sum(n=0 to INF)sqrt(2)/2^n", {"n":10})
        entry = report["series"][0]
        self.assertEqual(entry["convergence"], "确定收敛")
        self.assertEqual(entry["phases"]["numerical"]["state"], "completed")
        self.assertEqual(entry["phases"]["reference"]["state"], "timeout")
        self.assertEqual(entry["numerics"]["sample"]["N"], "10")
        self.assertEqual(entry["numerics"]["sample"]["condition"], "1.0")

    def test_separate_reference_matches_inline_reference(self):
        expression = "sum(n=1 to 3)sum(m=1 to 4)sin(n+m)"
        evaluator = SeriesEvaluator(SeriesFormula(expression), {})
        evaluator.evaluate({})
        report = analyze(expression, {})
        self.assertTrue(report["complete"], report["summary"])
        for entry in report["series"]:
            self.assertEqual(entry["numerics"]["sample"]["reference"], evaluator.metrics[entry["name"]]["sample"]["reference"])

    def test_ratio_rate_keeps_polynomial_correction(self):
        entry = analyze("sum(n=1 to INF)n^2/2^n", {"n":12}, evaluate_numerics=False)["series"][0]
        values = {q["label"]:q["value"] for q in entry["analysis"]["收敛速度"]["quantities"]}
        self.assertEqual(values["多项式指数 α"], "2")
        self.assertEqual(values["比值极限 q"], "1/2")
        self.assertIn("N^(2)", values["余项上界阶"])


class GridIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from aiohttp import web
        from server import PromptServer
        cls.server = SimpleNamespace(routes=web.RouteTableDef(), client_id=None, send_sync=lambda *args: None)
        cls.server_patch = patch.object(PromptServer, "instance", cls.server, create=True)
        cls.server_patch.start()
        import function_grid_node
        cls.module = function_grid_node

    @classmethod
    def tearDownClass(cls):
        cls.server_patch.stop()

    def test_original_outputs_plus_exact_output(self):
        Grid = self.module.LiuxinyuFunctionGrid
        output = Grid.execute(expression="0.1+0.2", axes_json="{}").result
        self.assertEqual(output[0], [0.3])
        self.assertEqual(output[2], ["0.3"])
        self.assertEqual(Grid.GET_NODE_INFO_V1()["output_is_list"], [True, False, False])
        self.assertEqual(Grid.GET_NODE_INFO_V1()["output_name"], ["值执行列表", "采样坐标", "高精度数列"])

    def test_help_serves_current_document_with_revalidation(self):
        import asyncio
        from pathlib import Path
        response = asyncio.run(self.module.function_grid_help(None))
        source = Path(self.module.__file__).with_name("docs") / "LiuxinyuFunctionGrid.md"
        self.assertEqual(response.body, source.read_bytes())
        self.assertEqual(response.headers["Cache-Control"], "no-cache, must-revalidate")
        self.assertIn("值执行列表", response.text)
        self.assertIn("高精度数列", response.text)
        self.assertIn("拉马努金", response.text)

    def test_exact_64bit_coordinates_and_decimal_grid(self):
        Grid = self.module.LiuxinyuFunctionGrid
        config = {"axes": {"x": {"min": str(INT_MAX - 1), "max": str(INT_MAX), "step": "1", "precision": "0"}}}
        output = Grid.execute(expression=f"x-{INT_MAX-1}", axes_json=json.dumps(config)).result
        self.assertEqual(output[2], ["0.0", "1.0"])
        self.assertEqual(output[1]["exact_axes"]["x"], [str(INT_MAX - 1), str(INT_MAX)])
        config = {"axes": {"x": {"min": "0.1", "max": "0.3", "step": "0.1", "precision": "1"}}}
        output = Grid.execute(expression="x+0.2", axes_json=json.dumps(config)).result
        self.assertEqual(output[2], ["0.3", "0.4", "0.5"])

    def test_divergent_series_still_computes_finite_sum(self):
        Grid = self.module.LiuxinyuFunctionGrid
        output = Grid.execute(expression="sum(k=1 to INF) k", axes_json='{"series":{"k":"3"}}')
        self.assertEqual(output.result[2], ["6.0"])

    def test_execution_reports_all_completed_phases_with_mixed_terms(self):
        events = []
        def record(name, event, *args):
            events.append(json.loads(json.dumps(event)))
        with patch.object(self.server, "send_sync", record):
            self.module.LiuxinyuFunctionGrid.execute(expression="sum(n=1 to 3)n+sum(m=1 to 3)sin(m)", axes_json="{}")
        result = [e["analysis"] for e in events if e["kind"]=="complete"][-1]
        self.assertTrue(result["complete"], result)
        self.assertTrue(all(entry["phases"]["numerical"]["state"]=="completed" for entry in result["series"]))

    def test_execution_error_reports_failed_stage(self):
        events = []
        def record(name, event, *args):
            events.append(json.loads(json.dumps(event)))
        with patch.object(self.server, "send_sync", record), self.assertRaises(ValueError):
            self.module.LiuxinyuFunctionGrid.execute(expression="sum(n=0 to 2)1/(n-1)", axes_json="{}")
        result = [e["analysis"] for e in events if e["kind"]=="complete"][-1]
        self.assertFalse(result["complete"])
        self.assertEqual(result["series"][0]["phases"]["numerical"]["state"], "failed")

    def test_ordinary_overflow_does_not_destroy_high_precision(self):
        output = self.module.LiuxinyuFunctionGrid.execute(expression="10^400", axes_json="{}").result
        self.assertEqual(output[0], [None])
        self.assertEqual(output[2], ["1" + "0" * 400 + ".0"])


if __name__ == "__main__":
    unittest.main()
