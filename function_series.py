"""Restricted math grammar and local arbitrary-precision series evaluation."""

import ast
import copy
from decimal import Decimal, InvalidOperation, localcontext, ROUND_CEILING
from fractions import Fraction
from itertools import chain
import math
import re

import mpmath


INT_MIN = -(2 ** 63)
INT_MAX = 2 ** 63 - 1
FUNCTION_NAMES = {
    "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sqrt", "abs",
    "ln", "log", "log10", "exp", "floor", "ceil", "round", "min", "max", "pow", "factorial",
}
TOKEN = re.compile(r"\s*(?:(?P<number>(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)|"
                   r"(?P<name>[^\W\d]\w*)|(?P<op>\*\*|//|[∑∞+\-*/%^!|(),=\[\]]))", re.UNICODE)


def int64(value, label, positive=False):
    # UI sends decimal text: JS Number cannot represent the full signed 64-bit range.
    if isinstance(value, bool) or isinstance(value, float):
        raise ValueError(f"{label} 必须是整数或整数字符串，不能通过浮点数传递。")
    if isinstance(value, str) and not re.fullmatch(r"[+-]?\d+", value.strip()):
        raise ValueError(f"{label} 必须是十进制整数。")
    if not isinstance(value, (str, int)):
        raise ValueError(f"{label} 必须是整数。")
    result = int(value)
    if not (1 if positive else INT_MIN) <= result <= INT_MAX:
        raise ValueError(f"{label} 范围为 {1 if positive else INT_MIN}～{INT_MAX}。")
    return result


def call(name, *args):
    return ast.Call(func=ast.Name(id=name, ctx=ast.Load()), args=list(args), keywords=[])


class NumericOperators(ast.NodeTransformer):
    def visit_Call(self, node):
        slot = ast.dump(node)
        self.generic_visit(node)
        if node.func.id == "factorial":
            return call("__factorial", ast.Constant(slot), *node.args)
        return node

    def visit_BinOp(self, node):
        self.generic_visit(node)
        return call("__binary", ast.Constant(type(node.op).__name__), node.left, node.right)


class SeriesFormula:
    """Pratt parser; never parses or evaluates arbitrary Python input."""

    def __init__(self, expression):
        if not isinstance(expression, str):
            raise ValueError("函数必须是数学表达式字符串。")
        self.expression = expression
        text = expression.strip().replace("×", "*")
        self.tokens = []
        cursor = 0
        while cursor < len(text):
            match = TOKEN.match(text, cursor)
            if not match:
                raise ValueError(f"公式第 {cursor + 1} 个字符附近无法解析：{text[cursor:cursor + 15]!r}。")
            kind, value = match.lastgroup, match.group(match.lastgroup)
            if (self.tokens and self.tokens[-1][0] == "number"
                    and (kind == "name" and value not in ("to", "INF") or value == "(")):
                self.tokens.append(("op", "*"))
            self.tokens.append((kind, value))
            cursor = match.end()
        self.tokens.append(("end", ""))
        self.position = 0
        self.series = []
        self.indices = set()
        self.tree = self.expression_node()
        if self.peek():
            raise ValueError(f"公式多余内容：{self.peek()!r}。求和范围外的运算请用括号明确分组。")
        self.variables = []
        self._names(self.tree, set())
        numeric_tree = NumericOperators().visit(copy.deepcopy(self.tree))
        self.code = compile(ast.fix_missing_locations(ast.Expression(numeric_tree)), "<函数生成精度数列>", "eval")

    def peek(self):
        return self.tokens[self.position][1]

    def take(self, expected=None):
        kind, text = self.tokens[self.position]
        if expected is not None and text != expected:
            raise ValueError(f"公式应为 {expected!r}，实际为 {text or '结尾'!r}。")
        if kind == "end":
            raise ValueError("公式不完整。")
        self.position += 1
        return kind, text

    def expression_node(self, minimum=0):
        kind, text = self.take()
        if text in ("+", "-"):
            left = ast.UnaryOp(op=ast.UAdd() if text == "+" else ast.USub(), operand=self.expression_node(25))
        elif text in ("(", "["):
            left = self.expression_node()
            self.take(")" if text == "(" else "]")
        elif text == "|":
            left = call("abs", self.expression_node())
            self.take("|")
        elif text in ("sum", "∑"):
            left = self.summation()
        elif kind == "number":
            left = call("__num", ast.Constant(text))
        elif kind == "name":
            if text.startswith("__") or text in ("INF", "to"):
                raise ValueError(f"{text} 仅可用于规定的求和语法，不能作为普通变量。")
            if self.peek() == "(":
                if text not in FUNCTION_NAMES:
                    raise ValueError(f"不支持函数 {text}。")
                self.take("(")
                args = [self.expression_node()]
                while self.peek() == ",":
                    self.take(",")
                    args.append(self.expression_node())
                self.take(")")
                valid = len(args) >= 2 if text in ("min", "max") else (
                    len(args) in (1, 2) if text in ("log", "round") else len(args) == (2 if text in ("atan2", "pow") else 1))
                if not valid:
                    raise ValueError(f"函数 {text} 的参数数量不正确。")
                left = call(text, *args)
            elif text in FUNCTION_NAMES:
                raise ValueError(f"{text} 是函数名，需要括号和参数。")
            else:
                left = ast.Name(id=text, ctx=ast.Load())
        else:
            raise ValueError(f"不支持的公式内容：{text!r}。")
        operators = {"+": (10, ast.Add), "-": (10, ast.Sub), "*": (20, ast.Mult),
                     "/": (20, ast.Div), "//": (20, ast.FloorDiv), "%": (20, ast.Mod),
                     "^": (30, ast.Pow), "**": (30, ast.Pow)}
        while True:
            token = self.peek()
            if token == "!" and 40 >= minimum:
                self.take()
                if isinstance(left, ast.Call) and left.func.id == "factorial":
                    raise ValueError("不支持连续 !!；若需重复阶乘，请明确写 factorial(factorial(...))。")
                left = call("factorial", left)
                continue
            if token not in operators or operators[token][0] < minimum:
                break
            precedence, operation = operators[token]
            self.take()
            right = self.expression_node(precedence if token in ("^", "**") else precedence + 1)
            if token == "//":
                left = call("floor", ast.BinOp(left=left, op=ast.Div(), right=right))
            elif token == "%":
                left = call("__mod", left, right)
            else:
                left = ast.BinOp(left=left, op=operation(), right=right)
        return left

    def summation(self):
        self.take("(")
        bracket = self.peek() == "["
        if bracket:
            self.take("[")
        kind, name = self.take()
        if kind != "name" or name in FUNCTION_NAMES | {"sum", "INF", "to", "pi", "e"} or name.startswith("__"):
            raise ValueError("求和索引必须是合法中英文名称，不能使用函数名或保留字。")
        if name in self.indices:
            raise ValueError(f"求和索引 {name!r} 重复；全部求和索引必须全局唯一。")
        self.indices.add(name)
        self.take("=")
        start = self.expression_node()
        if bracket:
            self.take("]")
        self.take("to")
        bracket = self.peek() == "["
        if bracket:
            self.take("[")
        if self.peek() in ("INF", "∞"):
            self.take()
            end = ast.Constant(None)
        else:
            end = self.expression_node()
        if bracket:
            self.take("]")
        self.take(")")
        entry = {"name": name, "start": start, "end": end, "infinite": isinstance(end, ast.Constant)}
        self.series.append(entry)
        # Square brackets explicitly delimit the summand; an ungrouped summand
        # extends to this expression's closing delimiter/end.
        if self.peek() == "[":
            self.take("[")
            body = self.expression_node()
            self.take("]")
        else:
            body = self.expression_node()
        entry["body"] = body
        return call("__sum", ast.Constant(name), start, end,
                    ast.Lambda(args=ast.arguments(posonlyargs=[], args=[ast.arg(arg=name)],
                                                kwonlyargs=[], kw_defaults=[], defaults=[]), body=body))

    def _names(self, node, scope):
        if isinstance(node, ast.Name):
            name = node.id
            if name in self.indices and name not in scope:
                raise ValueError(f"求和索引 {name!r} 在自身作用域之外使用。")
            if name not in scope and name not in ("pi", "e") and name not in self.variables:
                self.variables.append(name)
        elif isinstance(node, ast.Call):
            if node.func.id == "__sum":
                name, start, end, body = node.args
                self._names(start, scope)
                self._names(end, scope)
                self._names(body.body, scope | {name.value})
            elif node.func.id != "__num":
                for arg in node.args:
                    self._names(arg, scope)
        else:
            for child in ast.iter_child_nodes(node):
                self._names(child, scope)

    def inspect(self):
        return {"variables": self.variables,
                "series": [{"name": item["name"], "infinite": item["infinite"]} for item in self.series]}


def series_counts(plan, stored, kwargs):
    if not isinstance(stored, dict):
        raise ValueError("采样与项数配置必须是 JSON 对象。")
    configs = stored.get("series", {})
    if not isinstance(configs, dict):
        raise ValueError("series 项数配置必须是按索引名称保存的字典。")
    result = {}
    for index, item in enumerate(entry for entry in plan.series if entry["infinite"]):
        name = item["name"]
        result[name] = int64(kwargs.get(f"terms{index + 1}", configs.get(name, "5000")), f"{name} 运行项数", positive=True)
    return result


class SeriesEvaluator:
    def __init__(self, plan, counts, coordinate_texts=(), interrupt=lambda: None, progress=lambda value: None,
                 collect_metrics=True, working_precision=None):
        self.plan, self.counts = plan, counts
        self.interrupt, self.progress = interrupt, progress
        self.operations = 0
        self.metrics = {}
        self.coordinates = {}
        self.sum_stack = []
        self.collect_metrics = collect_metrics
        self.factorial_states = {}
        self.literal_values = {}
        self.metric_values = {}
        self.reference_targets = None
        self.evaluate_reference = True
        self.binary64_limits = (Fraction.from_float(float.fromhex("0x1.fffffffffffffp+1023")), Fraction(1,2**1075), Fraction(1,2**1022))
        literals = [n.args[0].value for n in ast.walk(plan.tree) if isinstance(n, ast.Call) and n.func.id == "__num"]
        # Preserve the integer part plus guard digits even for large inputs/cancellation.
        places = []
        for value in [*literals, *coordinate_texts]:
            try:
                decimal = Decimal(str(value))
                places.append(max(0, decimal.adjusted()) + len(decimal.as_tuple().digits))
            except InvalidOperation:
                fraction = Fraction(str(value))
                places.append(len(Decimal(abs(fraction.numerator)).as_tuple().digits)
                              + len(Decimal(fraction.denominator).as_tuple().digits))
        self.mp = mpmath.mp.clone()
        self.mp.dps = max(80, max(places, default=0) + 50, working_precision or 0)
        self.environment = {"__builtins__": {}, "__num": self.literal, "__sum": self.sum, "__binary": self.binary,
                            "__factorial": self.factorial_at,
                            "pi": self.mp.pi, "e": self.mp.e, "abs": abs,
                            "min": lambda *args: self.extreme(min, args), "max": lambda *args: self.extreme(max, args),
                            "pow": lambda a, b: self.binary("Pow", a, b), "ln": self.wrap(self.mp.log), "factorial": self.factorial,
                            "round": self.round, "__mod": lambda a, b: self.binary("Mod", a, b),
                            "floor": lambda a: Fraction(math.floor(a)), "ceil": lambda a: Fraction(math.ceil(a))}
        for name in FUNCTION_NAMES - self.environment.keys():
            self.environment[name] = self.wrap(getattr(self.mp, name))

    def as_mpf(self, value):
        if isinstance(value,Fraction):
            numerator=self.exact_binary(Fraction(value.numerator))
            if value.denominator==1:
                return self.mp.fadd(numerator,0)
            return self.mp.fdiv(numerator,self.exact_binary(Fraction(value.denominator)))
        return self.mp.mpf(value)

    def literal(self, text):
        if text not in self.literal_values:
            self.literal_values[text] = Fraction(text)
        return self.literal_values[text]

    def factorial_at(self, slot, value):
        if value < 0 or not self.is_integer(value):
            raise ValueError("阶乘只接受非负整数。")
        self.interrupt()
        integer = int(value)
        previous = self.factorial_states.get(slot)
        if previous and 0 <= integer - previous[0] <= 64:
            result = previous[1] * math.prod(range(previous[0]+1, integer+1))
        else:
            result = math.factorial(integer)
        self.factorial_states[slot] = (integer, result)
        return Fraction(result)

    def exact_binary(self, value):
        if not isinstance(value, Fraction):
            return value
        denominator = value.denominator
        if denominator & (denominator-1):
            return None
        numerator = value.numerator
        if not numerator:
            return self.mp.mpf(0)
        magnitude = abs(numerator)
        zeros = (magnitude & -magnitude).bit_length()-1
        magnitude >>= zeros
        return self.mp.make_mpf((int(numerator<0), magnitude, zeros-(denominator.bit_length()-1), magnitude.bit_length()))

    def exact_fraction(self, value):
        if isinstance(value, Fraction):
            return value
        sign, mantissa, exponent, _ = value._mpf_
        if abs(exponent)>1000000:
            raise ValueError(f"二进制指数 {exponent} 超出精确诊断展开预算（1000000 位）")
        numerator = -mantissa if sign else mantissa
        return Fraction(numerator << exponent) if exponent>=0 else Fraction(numerator, 1 << -exponent)

    def add_measured(self, total, value):
        if isinstance(total,Fraction) and isinstance(value,Fraction):
            return total+value
        a, b = self.exact_binary(total), self.exact_binary(value)
        if a is not None and b is not None:
            if max(abs(a._mpf_[2]),abs(b._mpf_[2]))>1000000:
                raise ValueError("精确诊断的二进制指数跨度超过 1000000 位")
            return self.mp.fadd(a,b,exact=True)
        return self.exact_fraction(total)+self.exact_fraction(value)

    def less_measured(self, a, b):
        if isinstance(a,Fraction) != isinstance(b,Fraction):
            a,b = self.exact_fraction(a),self.exact_fraction(b)
        return a<b

    def wrap(self, function):
        return lambda *args: function(*(self.as_mpf(value) for value in args))

    def is_integer(self, value):
        return value.denominator == 1 if isinstance(value, Fraction) else self.mp.isint(value)

    def extreme(self, function, values):
        return function(values) if all(isinstance(value, Fraction) for value in values) else function(self.as_mpf(value) for value in values)

    def binary(self, operation, a, b):
        if not (isinstance(a, Fraction) and isinstance(b, Fraction)):
            a, b = self.as_mpf(a), self.as_mpf(b)
        operations = {"Add": lambda: a + b, "Sub": lambda: a - b, "Mult": lambda: a * b,
                      "Div": lambda: a / b, "Mod": lambda: a - b * math.floor(a / b)}
        if operation == "Pow":
            if isinstance(a, Fraction) and isinstance(b, Fraction) and b.denominator == 1:
                return a ** b.numerator
            return self.mp.power(self.as_mpf(a), self.as_mpf(b))
        return operations[operation]()

    def factorial(self, value):
        if value < 0 or not self.is_integer(value):
            raise ValueError("阶乘只接受非负整数。")
        self.interrupt()
        return Fraction(math.factorial(int(value)))

    def round(self, value, places=0):
        if not self.is_integer(places):
            raise ValueError("round 的小数位数必须是整数。")
        if isinstance(value, Fraction):
            return Fraction(round(value, int(places)))
        scale = self.mp.power(10, int(places))
        return self.mp.nint(value * scale) / scale

    def sum(self, name, start, end, body):
        if not self.is_integer(start) or (end is not None and not self.is_integer(end)):
            raise ValueError(f"求和 {name} 的起止值必须为整数。")
        first = int64(int(start), f"{name} 起点")
        last = first + self.counts[name] - 1 if end is None else int64(int(end), f"{name} 终点")
        # Measure the actual inputs to this invocation, including nested contexts.
        input_sum = Fraction(0)
        absolute_sum = Fraction(0)
        exact_terms = True
        metric_failure = None
        overflows = underflows = subnormals = 0
        positive_terms = negative_terms = zero_terms = sign_changes = 0
        previous_sign = 0
        partial_min = partial_max = None
        min_index = max_index = None
        context = {**self.coordinates, **dict(self.sum_stack)}

        rational = self.exact_fraction
        binary_limits = tuple(self.exact_binary(value) for value in self.binary64_limits)

        # The truncation count is per invocation, including inside an outer loop.
        def terms():
            nonlocal input_sum, absolute_sum, exact_terms, metric_failure, overflows, underflows, subnormals
            nonlocal positive_terms, negative_terms, zero_terms, sign_changes, previous_sign
            nonlocal partial_min, partial_max, min_index, max_index
            for index in range(first, last + 1):
                self.operations += 1
                if self.operations % 1024 == 0:
                    self.interrupt()
                    self.progress({"phase": "reference" if self.reference_targets is not None else "numerical",
                                   "index": name, "current": str(index), "last": str(last)})
                self.sum_stack.append((name, str(index)))
                try:
                    value = body(Fraction(index))
                finally:
                    self.sum_stack.pop()
                if not isinstance(value, Fraction) and (not self.mp.isfinite(value) or self.mp.im(value)):
                    raise ValueError(f"求和 {name}={index} 时通项不是有限实数。")
                exact_terms &= isinstance(value, Fraction)
                if self.collect_metrics and metric_failure is None:
                    try:
                        sample = value
                        input_sum = self.add_measured(input_sum, sample)
                        absolute_sum = self.add_measured(absolute_sum, abs(sample))
                        sign = (sample > 0) - (sample < 0)
                        positive_terms += sign > 0
                        negative_terms += sign < 0
                        zero_terms += sign == 0
                        if sign:
                            sign_changes += previous_sign != 0 and sign != previous_sign
                            previous_sign = sign
                        if partial_min is None or self.less_measured(input_sum, partial_min):
                            partial_min, min_index = input_sum, index
                        if partial_max is None or self.less_measured(partial_max, input_sum):
                            partial_max, max_index = input_sum, index
                        magnitude = abs(sample)
                        overflow_limit,zero_limit,normal_limit = self.binary64_limits if isinstance(sample,Fraction) else binary_limits
                        overflows += magnitude > overflow_limit
                        underflows += 0 < magnitude <= zero_limit
                        subnormals += zero_limit < magnitude < normal_limit
                    except ValueError as error:
                        metric_failure = str(error)
                yield value
        self.interrupt()
        iterator = terms()
        exact = Fraction(0)
        result = None
        for value in iterator:
            if isinstance(value, Fraction):
                exact += value
                continue
            result = self.mp.fsum(chain([self.as_mpf(exact), value], (self.as_mpf(item) for item in iterator)))
            break
        if result is None:
            result = exact
        if not self.collect_metrics:
            if self.reference_targets:
                target = self.reference_targets.get(name)
                if target and target["record"]["context"] == context:
                    value = self.as_mpf(result)
                    error = abs(self.as_mpf(target["value"])-value)
                    target["record"]["reference"] = {
                        "precision": self.mp.dps, "value": self.mp.nstr(value,24),
                        "absolute_difference": self.mp.nstr(error,24),
                        "relative_difference": self.mp.nstr(error/abs(value),24) if value else None,
                        "kind": "整个表达式提高 30 位工作精度重算一次，按相同参数及外层索引对照该有限和；差异是数值估计",
                    }
            return result
        count = max(0, last - first + 1)
        record = {"context": context, "N": str(count), "first": str(first), "last": str(last),
                  "algorithm": "精确有理数累加" if isinstance(result, Fraction) else "mpmath.fsum",
                  "working_digits": self.mp.dps, "term_values_exact": exact_terms,
                  "binary64_term_overflow": overflows, "binary64_term_underflow": underflows,
                  "binary64_term_subnormal": subnormals}
        if not isinstance(result, Fraction):
            record["computed_mpf"] = list(result._mpf_)

        def number(value):
            return self.mp.nstr(self.as_mpf(value), 24)

        def upper_decimal(value):
            with localcontext() as ctx:
                ctx.prec = 24
                ctx.rounding = ROUND_CEILING
                return str(Decimal(value.numerator) / Decimal(value.denominator))

        if metric_failure:
            record["blocked"] = {"operation": "精确展开有限精度通项", "reason": metric_failure}
        else:
            input_sum, absolute_sum = rational(input_sum), rational(absolute_sum)
            condition = absolute_sum / abs(input_sum) if input_sum else None
            roundoff = abs(rational(result) - input_sum)
            record["finite_observations"] = {
                "scope": f"本次调用 {name}={first}…{last} 的已计算通项；非空部分和",
                "status": "精确有理数计算" if exact_terms else "有限精度通项观测",
                "positive_terms": positive_terms, "negative_terms": negative_terms, "zero_terms": zero_terms,
                "sign_changes": sign_changes,
                "sign_change_frequency": number(Fraction(sign_changes, max(1, positive_terms + negative_terms - 1))),
                "positive_sum": number((absolute_sum + input_sum) / 2),
                "negative_magnitude": number((absolute_sum - input_sum) / 2),
                "partial_min": number(partial_min) if partial_min is not None else None,
                "partial_max": number(partial_max) if partial_max is not None else None,
                "min_index": str(min_index), "max_index": str(max_index),
                "monotonicity": "常数" if not positive_terms and not negative_terms else "非单调" if positive_terms and negative_terms else "单调不减" if positive_terms else "单调不增",
            }
            record["backward_error"] = number(roundoff / absolute_sum) if absolute_sum else ("0" if not roundoff else None)
            record["backward_error_formula"] = "η = |计算结果 − 已计算通项的精确和| / Σ|已计算通项|"
            record.update({"sum": number(input_sum), "sum_abs": number(absolute_sum),
                           "condition": number(condition) if condition is not None else "∞" if absolute_sum else "未定义（全零）",
                           "condition_formula": "κ = Σ|a_n| / |Σa_n|",
                           "lost_digits": number(max(self.mp.mpf(0), self.mp.log10(self.as_mpf(condition)))) if condition else None,
                           "summation_roundoff": number(roundoff),
                           "summation_roundoff_upper": upper_decimal(roundoff),
                           "roundoff_scope": "原始有理数通项→有限项和" if exact_terms else "已计算通项→有限项和",
                           "relative_roundoff": number(roundoff / abs(input_sum)) if input_sum else None,
                           "roundoff_exact_zero": roundoff == 0})
            if condition is not None and condition.numerator.bit_length() + condition.denominator.bit_length() <= 1024:
                record["condition_exact"] = str(condition)
            try:
                ordinary = float(result)
                record["binary64_result"] = str(ordinary)
                if math.isfinite(ordinary):
                    conversion_error = abs(Fraction.from_float(ordinary) - rational(result))
                    record["output_conversion_error"] = number(conversion_error)
                    record["output_conversion_error_upper"] = upper_decimal(conversion_error)
                    record["output_relative_error"] = number(abs(Fraction.from_float(ordinary) - input_sum) / abs(input_sum)) if input_sum else None
                    record["binary64_result_class"] = "零" if result == 0 else "下溢为零" if ordinary == 0 else "次正规数" if abs(ordinary) < float.fromhex("0x1p-1022") else "正常有限值"
                else:
                    record["binary64_result_class"] = "溢出"
            except OverflowError:
                record["binary64_result_class"] = "溢出"
            # A separately labelled comparison model, not a bound assigned to fsum.
            u = Fraction(1, 2 ** 53)
            k = max(0, count - 1)
            if k * u < 1:
                gamma = k * u / (1 - k * u)
                record["binary64_sequential_model"] = {
                    "u": "2^-53", "k": str(k), "gamma": number(gamma),
                    "absolute_bound": number(gamma * absolute_sum),
                    "relative_bound": number(gamma * condition) if condition is not None else None,
                    "assumptions": "输入项视为精确；顺序加法采用就近舍入，运算保持正常有限范围",
                }
        previous = self.metrics.get(name)
        if previous is None:
            self.metrics[name] = {"invocations": 1, "sample": record, "coverage": "已计算的全部调用",
                                 "range_risks": {"overflow": overflows, "underflow": underflows, "subnormal": subnormals}}
            self.metric_values[name] = result
        else:
            previous["invocations"] += 1
            previous["range_risks"]["overflow"] += overflows
            previous["range_risks"]["underflow"] += underflows
            previous["range_risks"]["subnormal"] += subnormals
            old = previous["sample"]
            def rank(entry):
                value = entry.get("condition")
                return self.mp.inf if value == "∞" else self.mp.mpf(value) if value and not value.startswith("未定义") else self.mp.mpf(-1)
            if (rank(record) > rank(old) or rank(record) == rank(old)
                    and self.mp.mpf(record.get("output_conversion_error", "0")) > self.mp.mpf(old.get("output_conversion_error", "0"))):
                previous["sample"] = record
                self.metric_values[name] = result
            previous["coverage"] = "展示求和条件数最大的调用及其参数；invocations 为全部调用次数"
        self.progress({"phase": "numerical", "state": "sum_completed", "index": name, "current": str(last), "last": str(last)})
        return result

    def evaluate(self, coordinates):
        self.coordinates = {key: str(value) for key, value in coordinates.items()}
        if self.collect_metrics:
            self.progress({"phase": "numerical", "state": "started", "parameters": self.coordinates})
        env = {**self.environment, **{name: Fraction(str(value)) for name, value in coordinates.items()}}
        value = eval(self.plan.code, env)
        if not isinstance(value, Fraction) and (not self.mp.isfinite(value) or self.mp.im(value)):
            raise ValueError("结果不是有限实数。")
        if self.collect_metrics and self.evaluate_reference:
            targets = {name: {"record": metric["sample"], "value": self.metric_values[name]}
                       for name,metric in self.metrics.items() if not metric["sample"]["term_values_exact"]
                       and all(metric["sample"]["context"].get(key)==str(number) for key,number in coordinates.items())
                       and "reference" not in metric["sample"]}
            if targets:
                self.progress({"phase": "reference", "state": "started", "parameters": self.coordinates})
                reference = SeriesEvaluator(self.plan,self.counts,interrupt=self.interrupt,progress=self.progress,
                                            collect_metrics=False,working_precision=self.mp.dps+30)
                reference.reference_targets=targets
                try:
                    reference.evaluate(coordinates)
                except (ArithmeticError,ValueError,TypeError) as error:
                    for target in targets.values():
                        target["record"]["reference_failure"]={"operation":"高精度参考重算","reason":str(error)}
                self.progress({"phase": "reference", "state": "completed", "parameters": self.coordinates})
        return value

    def text(self, value):
        if isinstance(value, Fraction):
            denominator = value.denominator
            twos = fives = 0
            while denominator % 2 == 0:
                denominator //= 2; twos += 1
            while denominator % 5 == 0:
                denominator //= 5; fives += 1
            if denominator == 1:
                with localcontext() as context:
                    context.prec = max(self.mp.dps, len(Decimal(value.numerator).as_tuple().digits) + max(twos, fives) + 2)
                    text = format(Decimal(value.numerator) / Decimal(value.denominator), "f")
                    return text if "." in text else text + ".0"
            value = self.as_mpf(value)
        return self.mp.nstr(value, n=self.mp.dps, strip_zeros=True)
