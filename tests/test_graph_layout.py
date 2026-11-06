import copy
import asyncio
import importlib.util
import itertools
import json
import random
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch
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
        if result.get('preservesPortOrder'):
            continue
        bottom = 0
        for side in ("inputs", "outputs"):
            if len(n[side]) < 2 and not (side == 'outputs' and any('inputAnchor' in s for s in n[side])):
                continue
            top = n.get("inputTop", n.get("startY", 0)+4)
            output_rows = sorted(n['inputs'][s['inputAnchor']]['y']
                                 if 'inputAnchor' in s else s['y'] for s in n[side]) if side == 'outputs' else []
            for row,i in enumerate(item[side]):
                slot = n[side][i]
                slot["x"] = 10 if side == "inputs" else n["size"][0]-9
                slot["y"] = top+10 if side == 'inputs' else output_rows[row]
                if side == 'inputs':
                    top += slot.get("height",20)
            # The frontend pads the output bottom by 2, not the input bottom.
            bottom = max(bottom, top if side == 'inputs' and n[side] else max(output_rows,default=-10)+12)
        n["size"][1] = max(n["size"][1], bottom+n.get("freeHeight",0))
    return data


class LayoutTests(unittest.TestCase):
    def test_geometry_cache_matches_uncached_after_moves_and_port_changes(self):
        ns = [node(1,0,0,outputs=2),node(2,500,180,inputs=2),node(3,220,35)]
        es = [edge(1,2),edge(1,2,output=1,input=1),edge(3,2,input=1)]
        cache = layout.GeometryCache()
        for step in range(6):
            ns[step % 3]['pos'][1] += 17
            ns[0]['outputs'][0]['y'] += 3
            ns[2]['size'][0] += 4
            for precise in (False,True):
                plain_report = []
                expected = layout.evaluate(ns,es,precise,plain_report)
                token = layout._geometry_cache.set(cache)
                try:
                    cached_report = []
                    actual = layout.evaluate(ns,es,precise,cached_report)
                    self.assertEqual(actual,expected)
                    self.assertEqual(cached_report,plain_report)
                    hits = cache.curves.cache_info().hits
                    self.assertEqual(layout.evaluate(ns,es,precise),expected)
                    self.assertGreater(cache.curves.cache_info().hits,hits)
                finally:
                    layout._geometry_cache.reset(token)

    def test_layer_order_matches_exhaustive_optimum_and_preserves_ties(self):
        peers = {'a':[0,4],'b':[1],'c':[3,5],'d':[2],'e':[]}
        layer = list(peers)
        preferred = {n:i for i,n in enumerate(layer)}
        def score(order):
            return (sum(a>b for i,n in enumerate(order) for m in order[i+1:] for a in peers[n] for b in peers[m]),
                    sum(preferred[n]>preferred[m] for i,n in enumerate(order) for m in order[i+1:]))
        result = layout.minimum_crossing_order(layer,peers,preferred)
        self.assertEqual(score(result),min(map(score,itertools.permutations(layer))))
        self.assertEqual(layout.minimum_crossing_order(layer,{n:[] for n in layer},preferred),layer)

    def test_structural_seed_resolves_shared_target_port_order(self):
        ns = [node(1,0,300),node(2,0,0),node(3,500,150,inputs=2)]
        es = [edge(1,3),edge(2,3,input=1)]
        graph = layout.nx.DiGraph([('1','3'),('2','3')])
        result = layout.layered_seed(ns,graph,{'1':0,'2':0,'3':1},350,180,[250,100],random.Random(0),es,
                                     dense=True,order_hint={'1':300,'2':0,'3':150})
        self.assertLess(result[0]['pos'][1],result[1]['pos'][1])
        self.assertFalse(any(layout.evaluate(result,es,True).values()))
        self.assertEqual(layout.port_orders(result),layout.port_orders(ns))

    def test_cache_is_released_when_solver_raises(self):
        with patch.object(layout,'solve_layout',side_effect=ValueError('test')):
            with self.assertRaises(ValueError):
                layout.solve({})
        self.assertIsNone(layout._geometry_cache.get())

    def test_constraint_compaction_moves_chain_jointly_and_preserves_ports(self):
        ns = [node(1,0,0,selected=False),node(2,700,0),node(3,1400,0)]
        es = [edge(1,2),edge(2,3)]
        original = copy.deepcopy(ns)
        result = layout.compact_constraints(ns,es)
        self.assertLess(layout.wire_cost(result,es),layout.wire_cost(ns,es)*.6)
        self.assertFalse(any(layout.evaluate(result,es,True).values()))
        self.assertEqual(result[0],original[0])
        self.assertEqual(layout.port_orders(result),layout.port_orders(original))
        self.assertEqual(ns,original)
        self.assertTrue(all(abs(n['pos'][1])<.01 for n in result))

    def test_constraint_compaction_rejects_blocked_curves_and_handles_cancel(self):
        ns = [node(1,0,0),node(2,900,200),node(3,450,20,selected=False)]
        es = [edge(1,2)]
        checks = layout.evaluate(ns,es,True)
        result = layout.compact_constraints(ns,es)
        self.assertTrue(layout.no_more_conflicts(layout.evaluate(result,es,True),checks))
        self.assertEqual(result[2],ns[2])
        self.assertLessEqual(layout.wire_cost(result,es),layout.wire_cost(ns,es))
        with patch.object(layout,'linprog',side_effect=AssertionError('must not solve after cancellation')):
            self.assertEqual(layout.compact_constraints(ns,es,lambda:True),ns)

    def test_constraint_compaction_keeps_plan_when_solver_times_out(self):
        ns = [node(1,0,0),node(2,900,0)]
        with patch.object(layout,'linprog',return_value=types.SimpleNamespace(success=False)):
            self.assertEqual(layout.compact_constraints(ns,[edge(1,2)]),ns)

    def test_joint_compaction_opens_room_beyond_local_main_image_minimum(self):
        data = json.loads((Path(__file__).with_name('fixtures')/'layout_compaction_trap.json').read_bytes())
        ns,es = data['nodes'],data['edges']
        original = copy.deepcopy(data)
        token = layout._geometry_cache.set(layout.GeometryCache())
        try:
            compacted = layout.compact_constraints(ns,es)
            result = layout.refine_wires(compacted,es,seconds=3)
        finally:
            layout._geometry_cache.reset(token)
        self.assertFalse(any(layout.evaluate(result,es,True).values()))
        self.assertLess(layout.wire_cost(result,es),layout.wire_cost(ns,es)*.9)
        self.assertEqual(layout.port_orders(result),layout.port_orders(ns))
        self.assertEqual([n['size'] for n in result],[n['size'] for n in ns])
        self.assertEqual(data,original)
        for old,new in zip(ns,result):
            if not old.get('selected'):
                self.assertEqual(old,new)

    def test_single_port_order_does_not_move_native_widget_or_output_rows(self):
        n = node(5,0,0)
        n['inputs'][0]['y'] = 36
        original = copy.deepcopy(n)
        layout.place_ports(n,'inputs',[0])
        layout.place_ports(n,'outputs',[0])
        self.assertEqual(n['inputs'],original['inputs'])
        self.assertEqual(n['outputs'],original['outputs'])
        self.assertEqual(n['size'],original['size'])
        # A dynamic output anchored to an input must still follow that input.
        n['outputs'][0]['inputAnchor'] = 0
        layout.place_ports(n,'outputs',[0])
        self.assertEqual(n['outputs'][0]['y'],36)

    def test_position_only_layout_retains_existing_custom_port_order(self):
        ns = [node(1,0,0,inputs=2,outputs=2),node(2,1000,0,inputs=2,outputs=2)]
        for n in ns:
            for side in ('inputs','outputs'):
                n[side][0]['y'],n[side][1]['y'] = 34,14
        data = dict(nodes=ns,edges=[edge(1,2)])
        with patch.object(layout,'reorder',side_effect=AssertionError('must retain display order')), \
             patch.object(layout,'refine_ports',side_effect=AssertionError('must not refine ports')):
            result = layout.solve(data,seconds=.2)
        self.assert_plan(data,result)
        self.assertTrue(result['preservesPortOrder'])
        for candidate in result['candidates']:
            self.assertTrue(candidate['preservesPortOrder'])
            for n in candidate['nodes']:
                self.assertEqual(n['inputs'],[1,0])
                self.assertEqual(n['outputs'],[1,0])

    def test_fixed_order_search_can_remove_crossings_by_moving_nodes(self):
        data = dict(nodes=[node(1,0,0),node(2,0,200),node(3,700,0,inputs=2)],
                    edges=[edge(1,3,input=1),edge(2,3)])
        fixed = copy.deepcopy(data['nodes'])
        fixed[0]['pos'][1],fixed[1]['pos'][1] = 140,-100
        progress = []
        with patch.object(layout,'layered_seed',return_value=fixed), \
             patch.object(layout,'reorder',side_effect=AssertionError('unnecessary port change')):
            result = layout.solve(data,seconds=.5,progress=progress.append)
        self.assert_plan(data,result)
        self.assertGreater(result['before']['crossings'],0)
        self.assertTrue(result['preservesPortOrder'])
        self.assertIn('ports_fixed',[p['stage'] for p in progress])
        self.assertNotIn('ports_flexible',[p['stage'] for p in progress])

    def test_reordering_remains_available_after_fixed_order_search(self):
        data = dict(nodes=[node(1,0,0,outputs=2),node(2,500,0,inputs=2)],
                    edges=[edge(1,2,input=1),edge(1,2,output=1)])
        progress = []
        result = layout.solve(data,seconds=1,progress=progress.append)
        self.assert_plan(data,result)
        self.assertFalse(result['preservesPortOrder'])
        stages = [p['stage'] for p in progress]
        self.assertLess(stages.index('ports_fixed'),stages.index('ports_flexible'))

    def test_zero_conflict_fixed_order_wins_over_cheaper_reordered_layout(self):
        ns = [node(1,0,0,outputs=2),node(2,1000,0,inputs=2)]
        first = copy.deepcopy(ns)
        first[1]['pos'][0] = 300
        changed = copy.deepcopy(first)
        changed[1]['pos'][0] = 174
        layout.place_ports(changed[0],'outputs',[1,0])
        layout.place_ports(changed[1],'inputs',[1,0])
        data = dict(nodes=ns,edges=[edge(1,2)])
        with patch.object(layout,'compact',return_value=first), \
             patch.object(layout,'layered_seed',side_effect=lambda ns,*a,**kw:ns), \
             patch.object(layout,'compact_constraints',side_effect=lambda ns,*a:ns), \
             patch.object(layout,'align_layout',side_effect=lambda ns,*a:ns), \
             patch.object(layout,'tighten_spacing',side_effect=lambda ns,*a,**kw:ns), \
             patch.object(layout,'settle_sources',side_effect=lambda ns,*a:ns), \
             patch.object(layout,'route_input_lanes',side_effect=lambda ns,*a:ns), \
             patch.object(layout,'refine_wires',return_value=changed):
            result = layout.solve(data,seconds=0)
        self.assert_plan(data,result)
        self.assertTrue(result['preservesPortOrder'])
        self.assertGreater(result['candidates'][0]['cost'],layout.wire_cost(changed,data['edges']))
        self.assertTrue(all(c['preservesPortOrder'] for c in result['candidates']))

    def test_equivalent_pool_limits_distinct_ties_and_deduplicates_translation(self):
        pool = []
        checks = dict(crossings=0,nodeIntersections=0,overlaps=0)
        for positions in itertools.permutations((0,300,600)):
            ns = [node(i,x,0) for i,x in enumerate(positions)]
            layout.retain_ranked(pool,ns,[],checks,limit=5)
        self.assertEqual(len(pool),5)
        self.assertEqual(len({item[2] for item in pool}),5)
        shifted = copy.deepcopy(pool[0][3])
        for n in shifted:
            n['pos'][0] += 3000
            n['pos'][1] -= 200
        layout.retain_ranked(pool,shifted,[],checks,limit=5)
        self.assertEqual(len(pool),5)
        self.assertEqual(pool[0][3][0]['pos'][1],0)
        # A genuinely better result removes former ties; a worse one is excluded.
        better = [node(i,i*180,0) for i in range(3)]
        layout.retain_ranked(pool,better,[],checks)
        self.assertEqual(len(pool),1)
        layout.retain_ranked(pool,ns,[],checks)
        self.assertEqual(len(pool),1)
        self.assertNotEqual(layout.layout_identity(better+[node(9,-500,0,selected=False)]),
                            layout.layout_identity(shifted+[node(9,-500,0,selected=False)]))

    def test_ranked_candidates_keep_fifteen_percent_gap_and_matching_conflicts(self):
        pool = []
        clear = dict(crossings=0,nodeIntersections=0,overlaps=0)
        for x in (300,350,384,385):
            layout.retain_ranked(pool,[node(1,0,0),node(2,x,0)],[],clear)
        self.assertEqual(len(pool),3)
        self.assertEqual(pool[-1][1],layout.candidate_cost_limit(pool[0][1]))
        layout.retain_ranked(pool,[node(1,0,0),node(2,180,0)],[],dict(clear,crossings=1))
        self.assertEqual(len(pool),3,'fewer pixels cannot compensate for an extra crossing')

    def test_solve_returns_equivalent_candidates_and_default_plan(self):
        data = dict(nodes=[node(1,0,0),node(2,1000,0)],edges=[])
        first = [node(1,0,0),node(2,174,0)]
        second = [node(1,190,0),node(2,0,0)]
        with patch.object(layout,'compact',return_value=first), \
             patch.object(layout,'layered_seed',side_effect=lambda ns,*a,**kw:ns), \
             patch.object(layout,'compact_constraints',side_effect=lambda ns,*a:ns), \
             patch.object(layout,'align_layout',side_effect=lambda ns,*a:ns), \
             patch.object(layout,'tighten_spacing',side_effect=lambda ns,*a,**kw:ns), \
             patch.object(layout,'settle_sources',side_effect=lambda ns,*a:ns), \
             patch.object(layout,'route_input_lanes',side_effect=lambda ns,*a:ns), \
             patch.object(layout,'refine_wires',return_value=second):
            result = layout.solve(data,seconds=0)
        self.assertEqual(result['status'],'ok')
        self.assertEqual(len(result['candidates']),2)
        self.assertGreater(result['candidates'][1]['cost'],result['candidates'][0]['cost']+1)
        self.assertEqual(result['nodes'],result['candidates'][0]['nodes'])
        for candidate in result['candidates']:
            self.assert_plan(data,dict(result,nodes=candidate['nodes']))

    def test_incident_curve_reentry_along_entire_node_edge_is_not_exempt(self):
        ns = [node(17,0,0),node(38,174,440)]
        ns[0]['size'][1] = 380
        report = []
        checks = layout.evaluate(ns,[edge(17,38)],True,report)
        self.assertGreater(checks['nodeIntersections'],0)
        self.assertTrue(any(c.get('node')=='17' for c in report))

    def test_joint_input_lane_straightens_bypass_and_packs_detour_below_it(self):
        ns = [node(55,0,140),node(62,450,160),node(61,1000,0,inputs=3,selected=False)]
        for n,size in zip(ns,([300,330],[390,290],[325,576])):
            n['size'] = size
            n['outputs'][0]['x'] = size[0]-9
        es = [edge(55,62),edge(55,61),edge(62,61,input=1)]
        original = copy.deepcopy(ns)
        result = layout.route_input_lanes(ns,es)
        a,m,b = result
        self.assertAlmostEqual(a['pos'][1]+14,b['pos'][1]+14)
        self.assertAlmostEqual(m['pos'][1]-30,b['pos'][1]+14+24)
        self.assertAlmostEqual(b['pos'][0]-m['pos'][0]-390,24)
        self.assertAlmostEqual(m['pos'][0]-a['pos'][0]-300,24)
        self.assertFalse(any(layout.evaluate(result,es,True).values()))
        self.assertEqual(result[2],ns[2])
        self.assertEqual(ns,original)
        self.assertLess(layout.wire_cost(result,es),layout.wire_cost(ns,es))

    def test_bypass_below_direct_wire_is_tried_before_any_port_exchange(self):
        ns = [node(55,0,0),node(62,450,-400),node(61,1000,0,inputs=3)]
        for n,size in zip(ns,([300,350],[390,400],[325,576])):
            n['size'] = size
            n['outputs'][0]['x'] = size[0]-9
        data = dict(nodes=ns,edges=[edge(55,62),edge(55,61),edge(62,61,input=1)])
        before = copy.deepcopy(data)
        with patch.object(layout,'reorder',side_effect=AssertionError('position-only solution exists')), \
             patch.object(layout,'refine_ports',side_effect=AssertionError('must route before exchanging ports')):
            result = layout.solve(data,seconds=.5)
        self.assert_plan(data,result)
        self.assertTrue(result['preservesPortOrder'])
        rebuilt = materialize(data,result)['nodes']
        source,middle,target = rebuilt
        self.assertAlmostEqual(source['pos'][1]+14,target['pos'][1]+14)
        self.assertGreater(middle['pos'][1]-30,source['pos'][1]+14)
        self.assertEqual(data,before)

    def test_joint_lane_moves_selected_blocker_and_keeps_fixed_blocker(self):
        ns = [node(1,0,180),node(2,700,0,selected=False),node(3,300,0)]
        es = [edge(1,2)]
        result = layout.route_input_lanes(ns,es)
        self.assertAlmostEqual(result[0]['pos'][1]+14,result[1]['pos'][1]+14)
        self.assertFalse(any(layout.evaluate(result,es,True).values()))
        ns[2]['selected'] = False
        result = layout.route_input_lanes(ns,es)
        self.assertEqual(result[2],ns[2])
        self.assertFalse(any(layout.evaluate(result,es,True).values()))
        self.assertEqual(layout.route_input_lanes(ns,es,cancelled=lambda:True),ns)

    def test_output_fanout_aligns_input_edges_not_centres_of_unequal_boxes(self):
        ns = [node(1,0,0),node(2,650,-180),node(3,850,0),node(4,600,400),node(5,1100,-180)]
        ns[2]['size'] = [250,300]
        ns[2]['outputs'][0]['x'] = 241
        es = [edge(1,2),edge(1,3),edge(1,4),edge(2,5)]
        result = layout.refine_wires(ns,es)
        self.assertAlmostEqual(result[1]['pos'][0],result[2]['pos'][0])
        self.assertAlmostEqual(result[2]['pos'][0],result[3]['pos'][0])
        self.assertFalse(any(layout.evaluate(result,es,True).values()))
        self.assertEqual(layout.common_output_groups([edge(55,62),edge(55,61),edge(62,61)]),[])

    def test_joint_lane_keeps_existing_unequal_width_column(self):
        for left_aligned in (False,True):
            with self.subTest(left_aligned=left_aligned):
                ns = [node(55,0,140),node(62,450,160),node(61,1000,0,inputs=3,selected=False),
                      node(54,0 if left_aligned else -50,700)]
                for n,size in zip(ns,([300,330],[390,290],[325,576],[400,80])):
                    n['size'] = size
                    n['outputs'][0]['x'] = size[0]-9
                es = [edge(55,62),edge(55,61),edge(62,61,input=1)]
                result = layout.route_input_lanes(ns,es)
                self.assertAlmostEqual(result[0]['pos'][0]-result[3]['pos'][0],0 if left_aligned else 50)
                self.assertGreater(result[0]['pos'][0],ns[0]['pos'][0])
                self.assertFalse(any(layout.evaluate(result,es,True).values()))

    def test_final_spacing_keeps_unequal_width_left_column(self):
        ns = [node(1,0,0),node(2,800,0),node(3,800,500),node(4,1600,500)]
        ns[2]['size'][0] = 250
        ns[2]['outputs'][0]['x'] = 241
        es = [edge(1,2),edge(1,3),edge(3,4)]
        result = layout.tighten_spacing(ns,es,preserve_straight=True,cost_function=layout.wire_cost)
        self.assertAlmostEqual(result[1]['pos'][0],result[2]['pos'][0])
        self.assertFalse(any(layout.evaluate(result,es,True).values()))
        self.assertLess(layout.wire_cost(result,es),layout.wire_cost(ns,es))

    def test_joint_lane_accepts_a_cyclic_intermediate_branch(self):
        ns = [node(1,0,0),node(2,400,300,inputs=2),node(3,800,300),node(4,1200,0,inputs=2)]
        es = [edge(1,4),edge(1,2),edge(2,3),edge(3,2,input=1),edge(3,4,input=1)]
        original = copy.deepcopy(ns)
        result = layout.route_input_lanes(ns,es)
        self.assertTrue(layout.no_more_conflicts(layout.evaluate(result,es,True),layout.evaluate(ns,es,True)))
        self.assertEqual(ns,original)

    def test_wire_polish_aligns_sockets_of_unequal_height_chain(self):
        ns = [node(1,0,0),node(2,800,-100),node(3,1600,100)]
        ns[0]["size"][1] = 240
        ns[0]["outputs"][0]["y"] = 150
        ns[1]["size"][1] = 400
        ns[1]["inputs"][0]["y"] = 30
        ns[1]["outputs"][0]["y"] = 80
        es = [edge(1,2),edge(2,3)]
        original = copy.deepcopy(ns)
        result = layout.refine_wires(ns,es)
        for e in es:
            a,b = result[int(e["source"])-1],result[int(e["target"])-1]
            self.assertAlmostEqual(a["pos"][1]+a["outputs"][0]["y"],b["pos"][1]+b["inputs"][0]["y"])
            self.assertLessEqual(b["pos"][0]-a["pos"][0]-a["size"][0],24.01)
        self.assertFalse(any(layout.evaluate(result,es,True).values()))
        self.assertLess(layout.layout_cost(result,es),layout.layout_cost(ns,es))
        self.assertEqual(ns,original)
        self.assertEqual([n['size'] for n in ns],[n['size'] for n in result])

    def test_wire_polish_groups_distant_sources_by_their_only_consumer(self):
        ns = [node(1,0,0),node(2,350,350),node(3,1000,0,inputs=2)]
        ns[1]["size"][0] = 210
        ns[1]["outputs"][0]["x"] = 201
        es = [edge(1,3),edge(2,3,input=1)]
        result = layout.refine_wires(ns,es)
        self.assertAlmostEqual(result[0]["pos"][0]+75,result[1]["pos"][0]+105)
        self.assertFalse(any(layout.evaluate(result,es,True).values()))
        self.assertEqual(layout.refine_wires(result,es),result)

    def test_common_consumer_keeps_terminal_preview_as_a_side_branch(self):
        es = [edge(1,4),edge(2,4),edge(3,5),edge(3,4),edge(4,6)]
        groups = layout.common_consumer_groups(es)
        self.assertIn(('4',['1','2','3']),groups)
        # Two continuing consumers do not form a unique main destination.
        self.assertNotIn(('4',['1','2','3']),layout.common_consumer_groups(es+[edge(5,7)]))

    def test_wire_cost_prefers_straight_ports_over_box_centres(self):
        centred = [node(1,0,0),node(2,400,-160)]
        centred[1]['size'][1] = 400
        straight = copy.deepcopy(centred)
        straight[1]['pos'][1] = 0
        self.assertLess(layout.wire_cost(straight,[edge(1,2)]),layout.wire_cost(centred,[edge(1,2)]))

    def test_wire_polish_preserves_straight_bypass_over_intermediate_node(self):
        ns = [node(1,0,0),node(2,500,100),node(3,1000,0,inputs=2)]
        es = [edge(1,3),edge(1,2),edge(2,3,input=1)]
        result = layout.refine_wires(ns,es)
        self.assertAlmostEqual(result[0]['pos'][1]+14,result[2]['pos'][1]+14)
        self.assertFalse(any(layout.evaluate(result,es,True).values()))
        self.assertGreater(result[1]['pos'][1]-30,result[0]['pos'][1]+14)

    def test_wire_polish_respects_fixed_nodes_and_cancellation(self):
        ns = [node(1,0,0,selected=False),node(2,600,140),node(3,1200,0),
              node(4,300,0,selected=False)]
        es = [edge(1,2),edge(2,3)]
        result = layout.refine_wires(ns,es)
        self.assertEqual(result[0],ns[0])
        self.assertEqual(result[3],ns[3])
        self.assertTrue(layout.no_more_conflicts(layout.evaluate(result,es,True),layout.evaluate(ns,es,True)))
        self.assertEqual(layout.refine_wires(ns,es,cancelled=lambda:True),ns)

    def test_cancellation_in_final_wire_stage_does_not_apply_a_plan(self):
        stopped = [False]
        def progress(value):
            if value['stage'] == 'wires':
                stopped[0] = True
        result = layout.solve({'nodes':[node(1,0,0),node(2,900,0)],'edges':[edge(1,2)]},
                              seconds=0,progress=progress,cancelled=lambda:stopped[0])
        self.assertEqual(result['status'],'cancelled')
        self.assertNotIn('nodes',result)

    def test_parallel_text_outputs_sort_by_target_socket_not_node_top(self):
        source = node(57,0,0,inputs=4,outputs=4)
        source.update(size=[400,710],inputTop=0)
        for i in range(4):
            source["inputs"][i].update(x=10,y=10+i*164,height=164)
            source["outputs"][i].update(x=391,y=10+i*164,inputAnchor=i)
        target = node(63,600,240,inputs=4,selected=False)
        target["size"] = [202,86]
        es = [edge(57,63,output=i,input=j) for i,j in [(0,0),(3,1),(1,2),(2,3)]]
        ns = [source,target]
        self.assertGreater(layout.evaluate(ns,es,True)["crossings"],0)
        target_before = copy.deepcopy(target)
        layout.reorder(ns,es)
        self.assertEqual(source["outputsOrder"],[0,3,1,2])
        self.assertEqual(target,target_before)
        self.assertFalse(any(layout.evaluate(ns,es,True).values()))
        self.assertEqual(source["size"],[400,710])

    def test_both_parallel_endpoints_do_not_swap_from_stale_positions(self):
        ns = [node(57,0,0,outputs=4),node(63,400,0,inputs=4)]
        es = [edge(57,63,output=i,input=j) for i,j in [(0,0),(3,1),(1,2),(2,3)]]
        layout.reorder(ns,es)
        self.assertFalse(any(layout.evaluate(ns,es,True).values()))
        first = copy.deepcopy(ns)
        layout.reorder(ns,es)
        self.assertEqual(ns,first)

    def test_dense_seed_uses_each_nodes_height(self):
        ns = [node(1,0,0),node(2,0,500),node(3,0,1000),node(4,900,0,inputs=3)]
        ns[3]["size"][1] = 1000
        es = [edge(i,4,input=i-1) for i in (1,2,3)]
        graph = layout.nx.DiGraph([(str(i),'4') for i in (1,2,3)])
        ranks = {'1':0,'2':0,'3':0,'4':1}
        packed = layout.layered_seed(ns,graph,ranks,350,1100,[450,300],random.Random(0),es,dense=True)
        ys = sorted(n["pos"][1] for n in packed[:3])
        self.assertLess(ys[-1]-ys[0],300)
        self.assertEqual([n["size"] for n in packed],[n["size"] for n in ns])

    def test_search_compares_more_than_first_zero_conflict_candidate(self):
        data = {"nodes":[node(1,0,0),node(2,900,0)],"edges":[edge(1,2)]}
        result = layout.solve(data,seconds=1)
        self.assertGreaterEqual(result['trials'],9)
        self.assert_plan(data,result)

    def test_saved_main_image_layout_parallel_edges_and_branched_outputs(self):
        data = json.loads((Path(__file__).with_name('fixtures')/'layout_main_image.json').read_text(encoding='utf-8'))
        source = next(n for n in data['nodes'] if n['id']=='57')
        rows = sorted(slot['y'] for slot in source['outputs'])
        for i,slot in enumerate(source['outputs']):
            slot['y'] = rows[i]
        source.pop('outputsOrder',None)
        before = copy.deepcopy(data)
        result = layout.solve(data,seconds=12)
        self.assertEqual(result['status'],'ok',result)
        self.assertFalse(any(result['checks'].values()),result)
        rebuilt = copy.deepcopy(data)
        by_id = {n['id']:n for n in rebuilt['nodes']}
        for item in result['nodes']:
            n = by_id[item['id']]
            n['pos'] = item['pos']
            for side in ('inputs','outputs'):
                layout.place_ports(n,side,item[side])
        self.assertFalse(any(layout.evaluate(rebuilt['nodes'],rebuilt['edges'],True).values()))
        self.assertEqual(data,before)
        self.assertEqual([n['size'] for n in rebuilt['nodes']],[n['size'] for n in data['nodes']])

    def test_short_source_can_approach_its_own_consumer(self):
        ns = [node(1,0,0),node(2,0,600),node(3,500,600),node(4,1000,0)]
        es = [edge(1,4),edge(2,3),edge(3,4)]
        result = layout.settle_sources(ns,es)
        self.assertGreater(result[0]['pos'][0],300)
        self.assertLessEqual(result[0]['pos'][0],802)
        self.assertTrue(layout.no_more_conflicts(layout.evaluate(result,es,True),layout.evaluate(ns,es,True)))

    def test_reorder_uses_widget_top_above_reserved_socket_start(self):
        n = node(1, 0, 0, inputs=2)
        n.update(startY=28, inputTop=4)
        n["inputs"][0]["y"] = 42
        n["inputs"][1].update(y=14, height=24)
        layout.reorder([n], [])
        self.assertEqual(n["inputsOrder"], [1, 0])
        self.assertEqual([s["y"] for s in n["inputs"]], [38, 14])

    def test_reorder_retains_nonuniform_output_rows(self):
        n = node(1, 0, 0, outputs=3)
        for slot, y in zip(n["outputs"], [14, 178, 342]):
            slot["y"] = y
        targets = [node(i+2, 500, y, selected=False) for i, y in enumerate([200, 0, 100])]
        layout.reorder([n, *targets], [edge(1, i+2, output=i) for i in range(3)])
        self.assertEqual(n["outputsOrder"], [1, 2, 0])
        self.assertEqual([s["y"] for s in n["outputs"]], [342, 14, 178])

    def test_output_rows_follow_reordered_compound_input_heights(self):
        n = node(1, 0, 0, inputs=3, outputs=3)
        n.update(inputTop=0, freeHeight=24, size=[400, 400])
        for i, (height, y) in enumerate([(164, 10), (24, 174), (164, 198)]):
            n["inputs"][i].update(height=height, y=y)
            n["outputs"][i].update(y=y, inputAnchor=i)
        sources = [node(i+2, -500, y, selected=False) for i, y in enumerate([300, 0, 100])]
        layout.reorder([n, *sources], [edge(i+2, 1, input=i) for i in range(3)])
        self.assertEqual(n["inputsOrder"], [1, 2, 0])
        self.assertEqual([s["y"] for s in n["inputs"]], [198, 10, 34])
        self.assertEqual(sorted(s["y"] for s in n["outputs"]), [10, 34, 198])
        self.assertEqual(n["size"][1], 400)

    def assert_plan(self, data, result):
        self.assertEqual(result["status"], "ok", result)
        rebuilt = materialize(data, result)
        checks = layout.evaluate(rebuilt["nodes"], rebuilt["edges"], True)
        self.assertEqual(checks,result['checks'])
        self.assertFalse(any(checks.values()), result)
        self.assertEqual(rebuilt["edges"], data["edges"])
        for n, old in zip(rebuilt["nodes"], data["nodes"]):
            if not old.get("selected"):
                self.assertEqual(n, old)

    def test_nonplanar(self):
        for graph in (layout.nx.complete_graph(5), layout.nx.complete_bipartite_graph(3,3)):
            data = {"nodes": [node(n, n*300, 0) for n in graph],
                    "edges": [edge(a,b) for a,b in graph.edges]}
            progress = []
            result = layout.solve(data, seconds=1, progress=progress.append)
            self.assertFalse(result["planar"])
            self.assertGreater(result["trials"], 0)
            self.assertIn("nonplanar", [p["stage"] for p in progress])
            self.assertEqual(result["status"], "ok", result)
            rebuilt = materialize(data, result)
            actual = layout.evaluate(rebuilt["nodes"], rebuilt["edges"], True)
            self.assertTrue(layout.better(actual, layout.layout_cost(rebuilt["nodes"], rebuilt["edges"]),
                                         result["before"], layout.layout_cost(data["nodes"], data["edges"])))
            self.assertTrue(result["partial"])

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

    def test_no_improvement_keeps_current_layout(self):
        data = {"nodes":[node(1,0,0),node(2,161,0)],"edges":[]}
        # Square outer boxes (including title): switching to a column cannot
        # legitimately improve the bounding perimeter of this already close pair.
        for n in data['nodes']:
            n['size'][1] = 120
        result = layout.solve(data,seconds=0)
        self.assertEqual(result["status"],"not_improved")
        self.assertNotIn("nodes",result)

    def test_close_pair_does_not_block_other_gaps(self):
        ns = [node(1,0,0), node(2,170,0), node(3,1600,0), node(4,3000,0)]
        es = [edge(1,2), edge(2,3), edge(3,4)]
        original = copy.deepcopy(ns)
        result = layout.tighten_spacing(ns, es)
        gaps = [b["pos"][0]-a["pos"][0]-a["size"][0] for a,b in zip(result,result[1:])]
        self.assertEqual(gaps, [20,48,48])
        self.assertFalse(any(layout.evaluate(result,es,True).values()))
        self.assertEqual(ns, original)
        self.assertEqual([n["size"] for n in result], [n["size"] for n in ns])
        self.assertEqual(layout.tighten_spacing(result,es), result)

    def test_spacing_preserves_unequal_size_rows_and_columns(self):
        ns = [node(1,0,0), node(2,900,0), node(3,0,1000), node(4,900,1000)]
        # A wider/taller node is centred on the same row and column as its peers.
        ns[3].update(size=[250,180], pos=[850,950])
        ns[3]["outputs"][0]["x"] = 241
        es = [edge(1,2),edge(3,4)]
        result = layout.tighten_spacing(ns,es)
        cx = lambda n: n["pos"][0]+n["size"][0]/2
        cy = lambda n: n["pos"][1]+(n["size"][1]-30)/2
        self.assertEqual(cx(result[0]),cx(result[2]))
        self.assertEqual(cx(result[1]),cx(result[3]))
        self.assertEqual(cy(result[0]),cy(result[1]))
        self.assertEqual(cy(result[2]),cy(result[3]))
        self.assertLess(cx(result[1])-cx(result[0]),300)
        self.assertLess(cy(result[2])-cy(result[0]),200)
        self.assertFalse(any(layout.evaluate(result,es,True).values()))

    def test_spacing_respects_fixed_obstacle_and_external_link(self):
        ns = [node(1,0,0,selected=False), node(2,400,0), node(3,1800,0),
              node(4,1000,180,selected=False), node(5,1800,500)]
        es = [edge(1,2),edge(2,3),edge(3,5)]
        before = layout.evaluate(ns,es,True)
        result = layout.tighten_spacing(ns,es)
        self.assertEqual(result[0],ns[0])
        self.assertEqual(result[3],ns[3])
        self.assertTrue(layout.no_more_conflicts(layout.evaluate(result,es,True),before))
        self.assertLess(layout.layout_cost(result,es),layout.layout_cost(ns,es))

    def test_disconnected_notes_have_compactness_cost(self):
        ns = [node(1,0,0,inputs=0,outputs=0),node(2,1500,900,inputs=0,outputs=0)]
        data = {"nodes":ns,"edges":[]}
        result = layout.solve(data,seconds=0)
        self.assert_plan(data,result)
        rebuilt = materialize(data,result)["nodes"]
        self.assertLess(layout.layout_cost(rebuilt,[]),layout.layout_cost(ns,[])/2)
        self.assertEqual([n["size"] for n in rebuilt],[n["size"] for n in ns])

    def test_spacing_cancellation_retains_input(self):
        ns = [node(1,0,0),node(2,1000,0)]
        self.assertEqual(layout.tighten_spacing(ns,[edge(1,2)],cancelled=lambda:True),ns)

    def test_solve_finishes_with_aligned_compact_chain(self):
        data = {"nodes":[node(i,i*1000,0) for i in range(5)],
                "edges":[edge(i,i+1) for i in range(4)]}
        result = layout.solve(data,seconds=0)
        self.assert_plan(data,result)
        ns = materialize(data,result)["nodes"]
        self.assertLess(max(n["pos"][0]+150 for n in ns)-min(n["pos"][0] for n in ns),1000)
        self.assertEqual(len({n["pos"][1] for n in ns}),1)
        for a,b in zip(ns,ns[1:]):
            self.assertLessEqual(b["pos"][0]-a["pos"][0]-150,49)

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
        with patch.object(layout, "compact", side_effect=lambda ns,*a: ns), \
             patch.object(layout, "layered_seed", side_effect=lambda ns,*a,**kw: ns), \
             patch.object(layout, "compact_constraints", side_effect=lambda ns,*a: ns), \
             patch.object(layout, "align_layout", side_effect=lambda ns,*a: ns), \
             patch.object(layout, "tighten_spacing", side_effect=lambda ns,*a,**kw: ns), \
             patch.object(layout, "route_input_lanes", side_effect=lambda ns,*a: ns), \
             patch.object(layout, "refine_wires", side_effect=lambda ns,*a: ns), \
             patch.object(layout, "repair_conflicts", side_effect=lambda ns,*a: ns), \
             patch.object(layout, "settle_sources", side_effect=lambda ns,*a: ns):
            failure = layout.solve(data,seconds=0)
        self.assertEqual(failure["status"],"not_improved")
        self.assertTrue(failure["conflicts"])
        self.assertIn("before",failure)
        self.assertIn("elapsed",failure)

    def test_imperfect_candidate_is_aligned_without_more_conflicts(self):
        ns = [node(1,0,0),node(2,600,0),node(3,0,300),node(4,600,300),
              node(5,1200,100),node(6,1700,250)]
        es = [edge(1,4),edge(3,2),edge(5,6)]
        before = layout.evaluate(ns,es,True)
        self.assertGreater(before["crossings"],0)
        result = layout.align_layout(ns,es)
        self.assertTrue(layout.no_more_conflicts(layout.evaluate(result,es,True),before))
        self.assertAlmostEqual(result[4]["pos"][1],result[5]["pos"][1])

    def test_priority_and_equal_conflict_compaction(self):
        zero = {"crossings":0,"nodeIntersections":0,"overlaps":0}
        crossed = dict(zero,crossings=1)
        self.assertTrue(layout.better(crossed,200,crossed,300))
        self.assertFalse(layout.better(crossed,300,crossed,300))
        self.assertFalse(layout.better(dict(zero,overlaps=1),1,crossed,300))
        self.assertFalse(layout.no_more_conflicts(dict(crossed,nodeIntersections=1),crossed))

    def test_cancelled_during_refinement_has_no_plan(self):
        data = {"nodes":[node(1,0,0),node(2,400,0)],"edges":[edge(1,2)]}
        stopped = [False]
        def cancel_in_align(value):
            if value["stage"] == "align": stopped[0] = True
        result = layout.solve(data,seconds=1,progress=cancel_in_align,cancelled=lambda:stopped[0])
        self.assertEqual(result["status"],"cancelled")
        self.assertNotIn("nodes",result)

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
        # Final polish aligns actual connected sockets rather than box centres.
        straight = 0
        for e in data["edges"]:
            a,b = by_id[e['source']],by_id[e['target']]
            if abs(a['pos'][1]+a['outputs'][e['output']]['y']-
                   b['pos'][1]-b['inputs'][e['input']]['y']) < .01:
                straight += 1
        self.assertGreaterEqual(straight,3)
        # Both centred and left-aligned columns are supported. Different finalists
        # may use either convention, but the two branches must remain one column.
        left_delta = abs(by_id["2"]["pos"][0]-by_id["5"]["pos"][0])
        centre_delta = abs(by_id["2"]["pos"][0]+by_id["2"]["size"][0]/2-
                           by_id["5"]["pos"][0]-by_id["5"]["size"][0]/2)
        self.assertLess(min(left_delta,centre_delta),.01)


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

    async def test_verify_requires_actual_improvement_not_zero_conflicts(self):
        data = {"nodes":[node(1,0,0),node(2,600,0),node(3,0,300),node(4,600,300)],
                "edges":[edge(1,4),edge(3,2)]}
        baseline = copy.deepcopy(data)
        # Retain the crossing but shorten both long wires.
        baseline["nodes"][1]["pos"][0] = 1200
        baseline["nodes"][3]["pos"][0] = 1200
        data.update(verify=True,baseline=baseline)
        response = await self.client.post("/layout",json=data)
        result = await response.json()
        self.assertEqual(result["status"],"ok",result)
        self.assertTrue(result["partial"])
        self.assertGreater(result["checks"]["crossings"],0)
        data["baseline"] = {k:copy.deepcopy(data[k]) for k in ("nodes","edges")}
        response = await self.client.post("/layout",json=data)
        self.assertEqual((await response.json())["status"],"not_improved")

    async def test_verify_rejects_overlap_improvement_that_adds_crossing(self):
        data = {"nodes":[node(1,0,0),node(2,600,0),node(3,0,300),node(4,600,300)],
                "edges":[edge(1,4),edge(3,2)]}
        baseline = copy.deepcopy(data)
        baseline['nodes'][1]['pos'] = [0,0]
        before = layout.evaluate(baseline['nodes'],baseline['edges'],True)
        after = layout.evaluate(data['nodes'],data['edges'],True)
        self.assertLess(after['overlaps'],before['overlaps'])
        self.assertGreater(after['crossings'],before['crossings'])
        data.update(verify=True,baseline=baseline)
        response = await self.client.post('/layout',json=data)
        self.assertEqual((await response.json())['status'],'not_improved')
        data["nodes"][1]["pos"] = [0,0]
        response = await self.client.post("/layout",json=data)
        self.assertEqual((await response.json())["status"],"not_improved")


if __name__ == "__main__":
    unittest.main()
