import asyncio
import math
from pathlib import Path
import sys
import unittest

PACK = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACK.parents[1]), str(PACK)]

import execution
import torch
import math_nodes as m
from pixel_nodes import LiuxinyuReadPixel as Read, LiuxinyuWritePixel as Write


class PixelMathTests(unittest.TestCase):
    def test_pixel_all_and_selected(self):
        original = torch.rand(3, 4, 5, 4)
        snapshot = original.clone()
        for z in (None, 0, 2):
            result = Write.execute(original, 1, 2, 255, 128, 0, z)[0]
            expected = snapshot.clone()
            expected[slice(None) if z is None else z, 2, 1, :3] = torch.tensor([1, 128/255, 0])
            torch.testing.assert_close(result, expected)
            torch.testing.assert_close(original, snapshot)
        self.assertEqual(Read.execute(Write.execute(original, 1, 2, 255, 128, 0)[0], 1, 2)[1], [128]*3)

    def test_gray_and_pixel_errors(self):
        gray = torch.full((2, 3, 4, 1), 0.5, dtype=torch.float64)
        self.assertEqual(Read.execute(gray, 0, 0)[0], [128, 128])
        output = Write.execute(gray, 0, 0, 255, 0, 0)[0]
        self.assertEqual(output.shape, (2, 3, 4, 3))
        self.assertEqual(output.dtype, gray.dtype)
        for kwargs in ({"x": 4}, {"y": -1}, {"z": 2}, {"r": 256}):
            args = dict(image=gray, x=0, y=0, r=0, g=0, b=0)
            args.update(kwargs)
            with self.assertRaises(ValueError):
                Write.execute(**args)

    def calculate(self, values, op, direction="从左至右"):
        return m.LiuxinyuMath.execute({f"number{i}": n for i,n in enumerate(values)}, op, direction)[0]

    def test_operations(self):
        for op, expected in [("加",15),("减",5),("乘",60),("除",10/3/2),
                             ("最大值",10),("最小值",2),("平均",5),("方差",38/3),
                             ("样本方差",19),("中位数",3),("标准差",math.sqrt(38/3)),
                             ("取模",1),("整除",1)]:
            with self.subTest(op=op):
                self.assertAlmostEqual(self.calculate([10,3,2],op), expected)
        self.assertEqual(self.calculate([10,3,2],"减","从右至左"),-11)
        self.assertEqual(self.calculate([2,3,2],"幂"),64)
        self.assertAlmostEqual(self.calculate([-8,3],"开根"),-2)
        self.assertAlmostEqual(self.calculate([8,2],"对数"),3)
        self.assertEqual(m.LiuxinyuMath.execute({"number10": 2,"number2":3,"number0":10},"减","从左至右")[0],5)

    def test_math_domains(self):
        for values, op in [([1,0],"除"), ([-8,2],"开根"), ([2,0],"开根"),
                           ([-1,2],"对数"), ([2,1],"对数"), ([-1,0.5],"幂"), ([float('nan'),2],"加")]:
            with self.subTest(values=values,op=op), self.assertRaises(ValueError):
                self.calculate(values,op)

    def test_integer_nodes(self):
        for mode, expected in [("四舍五入",-3),("向上取整",-2),("向下取整",-3),("截断小数",-2)]:
            self.assertEqual(m.LiuxinyuRound.execute(-2.5,mode)[0],expected)
        self.assertEqual(m.LiuxinyuFactorial.execute(0)[0],1)
        self.assertEqual(m.LiuxinyuFactorial.execute(6)[0],720)
        values = {"number0":12,"number1":18,"number2":-30}
        self.assertEqual(m.LiuxinyuGCD.execute(values)[0],6)
        self.assertEqual(m.LiuxinyuLCM.execute(values)[0],180)
        with self.assertRaises(ValueError): m.LiuxinyuFactorial.execute(2.5)

    def test_primes(self):
        for value, expected in [(-7,2),(2,2),(4,3),(4.1,5),(12,11),(100,101)]:
            self.assertEqual(m.LiuxinyuNearestPrime.execute(value)[0],expected)
        for value in range(2,2000):
            self.assertEqual(m._is_prime(value),all(value % d for d in range(2,math.isqrt(value)+1)))
        self.assertFalse(m._is_prime(341550071728321))

    def test_functions(self):
        self.assertEqual(m.LiuxinyuAbsolute.execute(-3)[0],3.0)
        self.assertEqual(m.LiuxinyuNegate.execute(-3)[0],3.0)
        self.assertAlmostEqual(m.LiuxinyuTrigonometry.execute(30,"sin","角度")[0],0.5)
        self.assertAlmostEqual(m.LiuxinyuTrigonometry.execute(0.5,"asin","角度")[0],30)
        for fn in ("sinh","cosh","tanh","asinh","acosh","atanh"):
            value = 2 if fn == "acosh" else 0.5
            self.assertAlmostEqual(m.LiuxinyuHyperbolic.execute(value,fn)[0],getattr(math,fn)(value))

    def test_executor_autogrow_and_lists(self):
        for node, raw, expected in [
            (m.LiuxinyuMath, {"numbers.number0":10,"numbers.number2":3,"numbers.number10":2,
                              "operation":"减","direction":"从左至右"}, [[5.0]]),
            (m.LiuxinyuGCD, {"numbers.number0":12,"numbers.number1":18}, [[6]]),
            (Read, {"image": torch.ones(2,3,4,3),"x":0,"y":0}, [[255,255]]*3),
        ]:
            inputs, missing, data = execution.get_input_data(raw,node,"test")
            self.assertFalse(missing)
            outputs, _, _, _ = asyncio.run(execution.get_output_data("pixel-math", "test",node,inputs,v3_data=data))
            self.assertEqual(outputs, expected)


if __name__ == "__main__":
    unittest.main()
