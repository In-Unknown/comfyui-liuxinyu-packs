import copy
import asyncio
import importlib.util
import json
import random
from pathlib import Path
import sys
import types
import unittest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer


sys.modules.setdefault("server", types.SimpleNamespace(PromptServer=types.SimpleNamespace(
    instance=types.SimpleNamespace(routes=types.SimpleNamespace(post=lambda path: lambda f: f)))))
spec = importlib.util.spec_from_file_location("layout", Path(__file__).parents[1] / "graph_layout.py")
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)


def node(name, x, y, inputs=1, outputs=1, selected=True):
    return {"id": str(name), "pos": [x,y], "size": [150,80], "selected": selected,
            "inputs": [{"x": 10, "y": 14+i*20} for i in range(inputs)],
            "outputs": [{"x": 141, "y": 14+i*20} for i in range(outputs)]}


def edge(a, b, output=0, input=0):
    return {"source": str(a), "target": str(b), "output": output, "input": input}


def materialize(data, result):
    data = copy.deepcopy(data)
    by_id = {n["id"]: n for n in data["nodes"]}
    for item in result["nodes"]:
        n = by_id[item["id"]]
        n["pos"] = item["pos"]
        bottom = 0
        for side in ("inputs", "outputs"):
            top = n.get("startY", 0)+4
            for i in item[side]:
                slot = n[side][i]
                slot["x"] = 10 if side == "inputs" else n["size"][0]-9
                slot["y"] = top+10
                top += slot.get("height",20) if side == "inputs" else 20
            bottom = max(bottom, top)
        n["size"][1] = max(n["size"][1], bottom+2+n.get("freeHeight",0))
    return data


class LayoutTests(unittest.TestCase):
    def assert_plan(self, data, result):
        self.assertEqual(result["status"], "ok", result)
        rebuilt = materialize(data, result)
        self.assertFalse(any(layout.evaluate(rebuilt["nodes"], rebuilt["edges"], True).values()))
        self.assertEqual(rebuilt["edges"], data["edges"])
        for n, old in zip(rebuilt["nodes"], data["nodes"]):
            if not old.get("selected"):
                self.assertEqual(n, old)

    def test_nonplanar(self):
        for graph in (layout.nx.complete_graph(5), layout.nx.complete_bipartite_graph(3,3)):
            data = {"nodes": [node(n, n*300, 0) for n in graph],
                    "edges": [edge(a,b) for a,b in graph.edges]}
            self.assertEqual(layout.solve(data)["status"], "nonplanar")

    def test_diamond(self):
        data = {"nodes": [node(1,0,0), node(2,400,-200), node(3,400,200), node(4,800,0,2)],
                "edges": [edge(1,2), edge(1,3), edge(2,4,input=1), edge(3,4,input=0)]}
        before = copy.deepcopy(data)
        result = layout.solve(data, seconds=3)
        self.assertEqual(result["status"], "ok", result)
        self.assertEqual(data, before)
        self.assertEqual(result["checks"], {"crossings":0,"nodeIntersections":0,"overlaps":0})

    def test_actual_collision_checks(self):
        ns = [node(1,0,0),node(2,600,250),node(3,0,250),node(4,600,0)]
        es = [edge(1,2),edge(3,4)]
        self.assertGreater(layout.evaluate(ns,es,True)["crossings"],0)
        ns.append(node(5,300,100,selected=False))
        self.assertGreater(layout.evaluate(ns,es,True)["nodeIntersections"],0)
        ns[1]["pos"] = ns[0]["pos"][:]
        self.assertGreater(layout.evaluate(ns,es,True)["overlaps"],0)

    def test_external_fixed_geometry(self):
        ns = [node(1,0,0), node(2,500,0), node(3,250,0,selected=False)]
        self.assertGreater(layout.evaluate(ns,[edge(1,2)],True)["nodeIntersections"],0)
        data = {"nodes": ns,"edges":[edge(1,2)]}
        result = layout.solve(data,seconds=3)
        self.assertEqual(result["status"],"ok",result)
        self.assertNotIn("3",[n["id"] for n in result["nodes"]])

    def test_not_found_is_not_impossibility(self):
        data = {"nodes":[node(1,0,0),node(2,0,0)],"edges":[edge(1,2)]}
        self.assertEqual(layout.solve(data,seconds=0)["status"],"not_found")

    def test_parallel_overlap(self):
        p = layout.np.array([(0,0),(100,0)])
        self.assertTrue(layout.intersect(p,p,shared=[p[0]],clearance=.6))
        q = layout.np.array([(0,0),(100,100)])
        self.assertFalse(layout.intersect(p,q,shared=[p[0]],clearance=.6))

    def test_fixture(self):
        path = Path(__file__).with_name("fixtures") / "layout_theta.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        result = layout.solve(data,seconds=8)
        self.assertEqual(result["status"],"ok",result)
        # Scramble the readable area so success requires moving nodes too.
        ys = [n["pos"][1] for n in data["nodes"]]
        random.Random(6).shuffle(ys)
        for n, y in zip(data["nodes"], ys):
            n["pos"][1] = y
        result = layout.solve(data,seconds=8)
        self.assertEqual(result["status"],"ok",result)
        self.assertTrue(any(n["pos"] != next(p["pos"] for p in result["nodes"] if p["id"] == n["id"])
                            for n in data["nodes"]))
        self.assert_plan(data, result)

    def test_user_loop_with_fixed_inlet(self):
        data = json.loads((Path(__file__).with_name("fixtures") / "layout_loop.json").read_text())
        for seed in (0, 1, 2):
            data["seed"] = seed
            result = layout.solve(data, seconds=8)
            self.assert_plan(data, result)
            plan = {n["id"]: n for n in result["nodes"]}
            inlet = next(n for n in data["nodes"] if n["id"] == "12")
            self.assertGreater(plan["2"]["pos"][0], inlet["pos"][0]+inlet["size"][0])

    def test_fan_reconvergence_and_disconnected_component(self):
        ns = [node(0,0,0),node(9,1000,0,4),node(20,350,600)]
        es = []
        for i in range(1,5):
            ns.append(node(i,400,(-2+i)*180))
            es.extend([edge(0,i),edge(i,9,input=4-i)])
        data = {"nodes":ns,"edges":es}
        self.assert_plan(data, layout.solve(data,seconds=8))

    def test_progress_and_cancellation(self):
        data = {"nodes":[node(1,0,0),node(2,0,0)],"edges":[edge(1,2)]}
        progress = []
        result = layout.solve(data, progress=progress.append, cancelled=lambda: True)
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(progress[0]["stage"], "topology")
        failure = layout.solve(data,seconds=0)
        self.assertTrue(failure["conflicts"])
        self.assertIn("before",failure)
        self.assertIn("elapsed",failure)

    def test_twenty_node_chain(self):
        data = {"nodes": [node(i,0,0) for i in range(20)],
                "edges": [edge(i,i+1) for i in range(19)]}
        self.assert_plan(data,layout.solve(data,seconds=8))

    def test_horizontal_centres_with_different_heights(self):
        ns = [node(1,0,200),node(2,400,0),node(3,800,-100)]
        ns[1]["size"][1] = 160
        ns[2]["size"][1] = 120
        es = [edge(1,2),edge(2,3)]
        before = copy.deepcopy(ns)
        aligned = layout.align_layout(ns,es)
        centres = [n["pos"][1]+(n["size"][1]-30)/2 for n in aligned]
        self.assertLess(max(centres)-min(centres),1e-8)
        self.assertFalse(any(layout.evaluate(aligned,es,True).values()))
        self.assertEqual(ns,before)

    def test_vertical_centres_for_independent_sources(self):
        ns = [node(1,0,0),node(2,90,250),node(3,600,0,2)]
        ns[0]["size"][0] = 270
        ns[0]["outputs"][0]["x"] = 261
        ns[1]["size"][0] = 180
        ns[1]["outputs"][0]["x"] = 171
        es = [edge(1,3),edge(2,3,input=1)]
        aligned = layout.align_layout(ns,es)
        self.assertAlmostEqual(aligned[0]["pos"][0]+135,aligned[1]["pos"][0]+90)
        self.assertFalse(any(layout.evaluate(aligned,es,True).values()))

    def test_loop_suffix_alignment_retains_zero_crossings(self):
        data = json.loads((Path(__file__).with_name("fixtures") / "layout_loop.json").read_text())
        result = layout.solve(data,seconds=8)
        self.assert_plan(data,result)
        by_id = {n["id"]:n for n in materialize(data,result)["nodes"]}
        centres = [by_id[i]["pos"][1]+(by_id[i]["size"][1]-30)/2 for i in ("4","5","6","7","13","10")]
        self.assertLess(max(centres)-min(centres),1e-8)
        self.assertAlmostEqual(by_id["2"]["pos"][0]+by_id["2"]["size"][0]/2,
                               by_id["5"]["pos"][0]+by_id["5"]["size"][0]/2)


class LayoutEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        app = web.Application()
        app.router.add_post("/layout", layout.layout_request)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()

    async def test_stream_and_verify(self):
        data = {"nodes":[node(1,0,0),node(2,400,0)],"edges":[edge(1,2)],"stream":True}
        response = await self.client.post("/layout",json=data)
        events = [json.loads(line) for line in (await response.text()).splitlines()]
        self.assertEqual(events[0]["event"],"progress")
        result = events[-1]["data"]
        self.assertEqual(result["status"],"ok")
        rebuilt = materialize(data,result)
        rebuilt["verify"] = True
        response = await self.client.post("/layout",json=rebuilt)
        self.assertEqual((await response.json())["status"],"ok")

    async def test_disconnect_stops_worker_and_releases_lock(self):
        # A planar two-node directed cycle is difficult with fixed left/right
        # cubic sockets. It keeps search running until the client disconnects.
        data = {"nodes":[node(1,0,0),node(2,0,0)],"edges":[edge(1,2),edge(2,1)],"stream":True}
        response = await self.client.post("/layout",json=data)
        await response.content.readline()
        response.close()
        for _ in range(60):
            if not layout._busy:
                break
            await asyncio.sleep(.05)
        self.assertFalse(layout._busy)


if __name__ == "__main__":
    unittest.main()
