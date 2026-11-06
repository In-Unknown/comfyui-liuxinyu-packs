"""Selected-node layout search. All inputs are canvas geometry, never workflow values."""

import asyncio
import copy
import json
import math
import random
import threading
import time

import networkx as nx
import numpy as np
from aiohttp import web
from server import PromptServer


def validate(data):
    nodes, edges = data["nodes"], data["edges"]
    if not 1 <= len(nodes) <= 500 or len(edges) > 1000:
        raise ValueError("当前画布最多支持 500 个节点、1000 条连线。")
    ids = {n["id"] for n in nodes}
    if len(ids) != len(nodes):
        raise ValueError("节点 ID 重复。")
    selected = [n for n in nodes if n.get("selected")]
    if not 2 <= len(selected) <= 40:
        raise ValueError("请一次选择 2～40 个节点进行整理。")
    for n in nodes:
        for pair in (n["pos"], n["size"]):
            if len(pair) != 2 or not all(isinstance(x, (int, float)) and math.isfinite(x) and abs(x) < 1e7 for x in pair):
                raise ValueError("节点坐标或尺寸无效。")
        if min(n["size"]) < 0:
            raise ValueError("节点尺寸不能为负。")
        for side in ("inputs", "outputs"):
            if len(n[side]) > 150:
                raise ValueError("单侧最多支持 150 个端口。")
            for slot in n[side]:
                if not all(math.isfinite(float(slot[k])) and abs(float(slot[k])) < 1e7 for k in ("x", "y")):
                    raise ValueError("端口位置无效。")
    by_id = {n["id"]: n for n in nodes}
    for e in edges:
        if e["source"] not in ids or e["target"] not in ids:
            raise ValueError("连线端点未包含在布局快照中。")
        if not (0 <= e["output"] < len(by_id[e["source"]]["outputs"]) and
                0 <= e["input"] < len(by_id[e["target"]]["inputs"])):
            raise ValueError("连线端口不存在。")
    return nodes, edges


def curve(a, b, precise=False):
    """Native classic-canvas horizontal cubic; final subdivision error <= .25px."""
    a, b = np.array(a, dtype=float), np.array(b, dtype=float)
    d = max(30, float(np.linalg.norm(b - a)) * .25)
    p = np.array([a, a + (d, 0), b - (d, 0), b])
    if not precise:
        t = np.linspace(0, 1, 17)[:, None]
        return (1-t)**3*p[0] + 3*(1-t)**2*t*p[1] + 3*(1-t)*t*t*p[2] + t**3*p[3]
    points = [a]

    def split(p, depth=0):
        # Distance to the chord segment bounds the entire Bezier convex hull.
        v = p[3] - p[0]
        vv = float(v @ v)
        u = np.clip(((p[1:3] - p[0]) @ v) / max(vv, 1e-20), 0, 1)
        error = np.max(np.linalg.norm(p[1:3] - p[0] - u[:, None] * v, axis=1))
        if error <= .25 or depth >= 18:
            points.append(p[3])
            return
        q = (p[:-1] + p[1:]) / 2
        r = (q[:-1] + q[1:]) / 2
        mid = (r[0] + r[1]) / 2
        split(np.array([p[0], q[0], r[0], mid]), depth + 1)
        split(np.array([mid, r[1], q[2], p[3]]), depth + 1)

    split(p)
    return np.array(points)


def bounds(p):
    return (*np.min(p, axis=0), *np.max(p, axis=0))


def overlaps(a, b, margin=0):
    return a[0] <= b[2]+margin and b[0] <= a[2]+margin and a[1] <= b[3]+margin and b[1] <= a[3]+margin


def cross(a, b):
    return a[..., 0]*b[..., 1] - a[..., 1]*b[..., 0]


def intersect(p, q, shared=(), clearance=0):
    """Polyline intersection, including collinear overlap, except shared socket tips."""
    a, b = p[:-1, None, :], p[1:, None, :]
    c, d = q[None, :-1, :], q[None, 1:, :]
    v, w = b-a, d-c
    denom = cross(v, w)
    delta = c-a
    nonparallel = np.abs(denom) > 1e-9
    safe = np.where(nonparallel, denom, 1)
    t, u = cross(delta, w)/safe, cross(delta, v)/safe
    hit = nonparallel & (t >= 0) & (t <= 1) & (u >= 0) & (u <= 1)
    at = a + t[..., None]*v
    for tip in shared:
        hit &= np.linalg.norm(at-tip, axis=-1) > 12
    if np.any(hit):
        return True
    # Closest endpoint to the other segment catches parallel overlap and near misses.
    for start, direction, point in ((a, v, c), (a, v, d), (c, w, a), (c, w, b)):
        t = np.clip(np.sum((point-start)*direction, axis=-1) /
                    np.maximum(np.sum(direction*direction, axis=-1), 1e-20), 0, 1)
        at = start + t[..., None]*direction
        hit = np.linalg.norm(point-at, axis=-1) <= max(clearance, 1e-7)
        for tip in shared:
            hit &= (np.linalg.norm(at-tip, axis=-1) > 12) | (np.linalg.norm(point-tip, axis=-1) > 12)
        if np.any(hit):
            return True
    return False


def evaluate(nodes, edges, precise=False, report=None):
    by_id = {n["id"]: n for n in nodes}
    selected = {n["id"] for n in nodes if n.get("selected")}
    boxes = {}
    for n in nodes:
        x, y = n["pos"]
        w, h = n["size"]
        boxes[n["id"]] = (x, y-n.get("titleHeight", 30), x+w, y+h)
    box_hits = 0
    for i, n in enumerate(nodes):
        for m in nodes[i+1:]:
            if (n["id"] in selected or m["id"] in selected) and overlaps(boxes[n["id"]], boxes[m["id"]], 10):
                box_hits += 1
                if report is not None:
                    report.append({"kind": "overlap", "nodes": [n["id"], m["id"]]})
    curves = []
    for e in edges:
        src, dst = by_id[e["source"]], by_id[e["target"]]
        a, b = src["outputs"][e["output"]], dst["inputs"][e["input"]]
        p = curve((src["pos"][0]+a["x"], src["pos"][1]+a["y"]),
                  (dst["pos"][0]+b["x"], dst["pos"][1]+b["y"]), precise)
        curves.append((e, p, bounds(p)))
    edge_hits = node_hits = 0
    for i, (e, p, pb) in enumerate(curves):
        affected = e["source"] in selected or e["target"] in selected
        for f, q, qb in curves[i+1:]:
            if not (affected or f["source"] in selected or f["target"] in selected) or not overlaps(pb, qb, 1):
                continue
            shared = []
            if (e["source"], e["output"]) == (f["source"], f["output"]):
                shared.append(p[0])
            if (e["target"], e["input"]) == (f["target"], f["input"]):
                shared.append(p[-1])
            if intersect(p, q, shared, .6 if precise else 0):
                edge_hits += 1
                if report is not None:
                    report.append({"kind": "crossing", "edges": [e, f]})
        for node_id, box in boxes.items():
            if not (affected or node_id in selected) or not overlaps(pb, box, .3 if precise else 0):
                continue
            # Own socket necessarily lies just inside its node. Check only re-entry.
            q = p
            if node_id == e["source"]:
                q = q[np.linalg.norm(q-p[0], axis=1) > 20]
            if node_id == e["target"]:
                q = q[np.linalg.norm(q-p[-1], axis=1) > 20]
            if len(q) < 2:
                continue
            x, y, right, bottom = box
            # Ignore the immediate socket strip of incident nodes only.
            if node_id == e["source"]:
                right -= 10
            if node_id == e["target"]:
                x += 11
            inside = np.any((q[:, 0] > x) & (q[:, 0] < right) & (q[:, 1] > y) & (q[:, 1] < bottom))
            rect = np.array([(x,y), (right,y), (right,bottom), (x,bottom), (x,y)])
            if inside or intersect(q, rect, clearance=.3 if precise else 0):
                node_hits += 1
                if report is not None:
                    report.append({"kind": "throughNode", "edge": e, "node": node_id})
    return {"crossings": int(edge_hits), "nodeIntersections": int(node_hits), "overlaps": box_hits}


def place_ports(n, side, order):
    """Apply a display permutation without changing actual port identities."""
    slots = n[side]
    top = n.get("inputTop", n.get("startY", 0)+4)
    rows = sorted(n["inputs"][slot["inputAnchor"]]["y"]
                  if "inputAnchor" in slot else slot["y"] for slot in slots) if side == "outputs" else []
    for row, i in enumerate(order):
        slots[i]["x"] = 10 if side == "inputs" else n["size"][0]-9
        slots[i]["y"] = top+10 if side == "inputs" else rows[row]
        if side == "inputs":
            top += slots[i].get("height", 20)
    n[side+"Order"] = list(order)
    end = (top if slots else 0) if side == "inputs" else max(rows, default=-10)+12
    n["size"][1] = max(n["size"][1], end+n.get("freeHeight", 0))


def reorder(nodes, edges):
    by_id = {n["id"]: n for n in nodes}
    neighbours = {}
    for e in edges:
        neighbours.setdefault((e["source"], "outputs", e["output"]), []).append((e["target"], "inputs", e["input"]))
        neighbours.setdefault((e["target"], "inputs", e["input"]), []).append((e["source"], "outputs", e["output"]))
    # Read current opposite socket coordinates after each side is placed. Using
    # node tops ties every parallel edge; sorting both ends from a stale snapshot
    # can simply reverse the same crossing twice.
    for n in nodes:
        if not n.get("selected"):
            continue
        for side in ("inputs", "outputs"):
            def key(i):
                peers = neighbours.get((n["id"], side, i), [])
                y = sum(by_id[p]["pos"][1]+by_id[p][s][j]["y"] for p,s,j in peers)/len(peers) if peers else n["pos"][1]+n[side][i]["y"]
                return not peers, y, n[side][i]["y"]
            place_ports(n, side, sorted(range(len(n[side])), key=key))


def refine_ports(nodes, edges, cancelled=lambda: False, seconds=2):
    """Verify socket sweeps and conflict-local swaps against actual curves."""
    result = copy.deepcopy(nodes)
    checks = evaluate(result, edges, precise=True)
    cost = layout_cost(result, edges)
    deadline = time.monotonic()+seconds
    for reverse in (False, True):
        if cancelled() or time.monotonic() >= deadline:
            return result
        trial = copy.deepcopy(result)
        reorder(list(reversed(trial)) if reverse else trial, edges)
        measured = evaluate(trial, edges, precise=True)
        trial_cost = layout_cost(trial, edges)
        if no_more_conflicts(measured, checks) and better(measured, trial_cost, checks, cost):
            result, checks, cost = trial, measured, trial_cost
    # Average neighbour heights are only a heuristic for fan-in/fan-out. Try
    # concrete exchanges at endpoints of remaining conflicts as well.
    for _ in range(2):
        conflicts = []
        evaluate(result, edges, precise=True, report=conflicts)
        ports = set()
        for conflict in conflicts:
            for e in conflict.get("edges", [conflict["edge"]] if "edge" in conflict else []):
                ports.update(((e["source"], "outputs", e["output"]), (e["target"], "inputs", e["input"])))
        improved = False
        for index, n in enumerate(result):
            if not n.get("selected"):
                continue
            for side in ("inputs", "outputs"):
                n = result[index]
                order = sorted(range(len(n[side])), key=lambda i: n[side][i]["y"])
                for a in range(len(order)):
                    for b in range(a+1, len(order)):
                        if (n["id"],side,order[a]) not in ports and (n["id"],side,order[b]) not in ports:
                            continue
                        if cancelled() or time.monotonic() >= deadline:
                            return result
                        trial = copy.deepcopy(result)
                        swapped = order[:]
                        swapped[a], swapped[b] = swapped[b], swapped[a]
                        place_ports(trial[index], side, swapped)
                        if side == "inputs":
                            place_ports(trial[index], "outputs", sorted(range(len(n["outputs"])), key=lambda i: n["outputs"][i]["y"]))
                        measured = evaluate(trial, edges, precise=True)
                        trial_cost = layout_cost(trial, edges)
                        if no_more_conflicts(measured, checks) and better(measured, trial_cost, checks, cost):
                            result, checks, cost = trial, measured, trial_cost
                            order = swapped
                            improved = True
        if not improved:
            break
    return result


def repair_conflicts(nodes, edges, cancelled=lambda: False):
    """Move endpoints of reported conflicts before perturbing unrelated nodes."""
    result = copy.deepcopy(nodes)
    by_id = {n["id"]: i for i,n in enumerate(result)}
    graph = nx.DiGraph()
    graph.add_nodes_from(by_id)
    graph.add_edges_from((e["source"],e["target"]) for e in edges)
    deadline = time.monotonic()+3
    for _ in range(3):
        conflicts = []
        checks = evaluate(result, edges, precise=True, report=conflicts)
        if not any(checks.values()):
            break
        names = set()
        for c in conflicts:
            names.update(c.get("nodes", []))
            for e in c.get("edges", [c["edge"]] if "edge" in c else []):
                names.update((e["source"],e["target"]))
        accepted = False
        for name in sorted(names, key=lambda n:(graph.degree(n),n)):
            if not result[by_id[name]].get("selected"):
                continue
            branch = {name}
            pending = [name]
            while pending:
                for child in graph.successors(pending.pop()):
                    if child not in branch and graph.in_degree(child) == 1 and result[by_id[child]].get("selected"):
                        branch.add(child)
                        pending.append(child)
            for group in (branch, {name}) if len(branch)>1 else (branch,):
                for step in (16,32,64,128,256):
                    for axis,direction in ((1,-1),(1,1),(0,-1),(0,1)):
                        if cancelled() or time.monotonic() >= deadline:
                            return result
                        trial = copy.deepcopy(result)
                        for item in group:
                            trial[by_id[item]]["pos"][axis] += step*direction
                        measured = evaluate(trial,edges,precise=True)
                        if no_more_conflicts(measured,checks) and conflict_quality(measured)<conflict_quality(checks):
                            result = trial
                            accepted = True
                            break
                    if accepted:
                        break
                if accepted:
                    break
            if accepted:
                break
        if not accepted:
            break
    return result


def layered_seed(original, directed, ranks, width, height, centre, rng, edges=(), dense=False):
    """Barycentric sweeps include long-edge placeholders, but never add canvas nodes."""
    expanded = nx.DiGraph()
    expanded.add_nodes_from(directed)
    layers = {}
    for node_id, rank in ranks.items():
        layers.setdefault(rank, []).append(node_id)
    for index, (a, b) in enumerate(directed.edges):
        last = a
        for rank in range(ranks[a]+1, ranks[b]):
            dummy = (index, rank)
            expanded.add_edge(last, dummy)
            layers.setdefault(rank, []).append(dummy)
            last = dummy
        expanded.add_edge(last, b)
    for layer in layers.values():
        rng.shuffle(layer)
    y = {n: i-(len(layer)-1)/2 for layer in layers.values() for i,n in enumerate(layer)}
    for sweep in range(12):
        forward = sweep % 2 == 0
        for rank in sorted(layers, reverse=not forward):
            def barycentre(n):
                neighbours = list(expanded.predecessors(n) if forward else expanded.successors(n))
                return sum(y[p] for p in neighbours)/len(neighbours) if neighbours else y[n]
            layers[rank].sort(key=barycentre)
            y.update({n: i-(len(layers[rank])-1)/2 for i,n in enumerate(layers[rank])})
    by_id = {n["id"]: n for n in original}
    ypos = {n: y[n]*height for n in directed}
    if dense:
        # Pack visible boxes using each node's own height, including title bars.
        # Dummy lanes reserve room for long edges, not the tallest node's height.
        lane_height = {n: by_id[n]["size"][1]+by_id[n].get("titleHeight",30) if n in by_id else 48
                       for layer in layers.values() for n in layer}
        centres = {}
        port_offsets = {}
        for n in directed:
            half = (by_id[n]["size"][1]-by_id[n].get("titleHeight",30))/2
            for side in ("inputs","outputs"):
                port_offsets[n,side] = [slot["y"]-half for slot in by_id[n][side]]
        def peer_centre(n, p, forward):
            a,b = (p,n) if forward else (n,p)
            links = [e for e in edges if e["source"]==a and e["target"]==b]
            if links:
                delta = float(np.median([port_offsets[a,"outputs"][e["output"]]-port_offsets[b,"inputs"][e["input"]] for e in links]))
                return centres[p]+(delta if forward else -delta)
            # A dummy lane follows the socket height of its real endpoint.
            out = port_offsets.get((a,"outputs"),[0]) or [0]
            ins = port_offsets.get((b,"inputs"),[0]) or [0]
            delta = float(np.median(out)-np.median(ins))
            return centres[p]+(delta if forward else -delta)
        for layer in layers.values():
            top = -(sum(lane_height[n] for n in layer)+32*(len(layer)-1))/2
            for n in layer:
                centres[n] = top+lane_height[n]/2
                top += lane_height[n]+32
        for sweep in range(4):
            for rank in sorted(layers, reverse=sweep % 2 == 1):
                layer = layers[rank]
                wanted = []
                for n in layer:
                    peers = list(expanded.predecessors(n) if sweep % 2 == 0 else expanded.successors(n))
                    wanted.append(float(np.median([peer_centre(n,p,sweep % 2 == 0) for p in peers])) if peers else centres[n])
                packed = []
                for i,n in enumerate(layer):
                    packed.append(max(wanted[i], packed[-1]+(lane_height[layer[i-1]]+lane_height[n])/2+32) if i else wanted[i])
                shift = float(np.mean(wanted)-np.mean(packed))
                centres.update({n: c+shift for n,c in zip(layer,packed)})
        ypos = {n: centres[n]-(by_id[n]["size"][1]-by_id[n].get("titleHeight",30))/2 for n in directed}
    # Keep boundary dependencies facing forward. Centering a long layered chain
    # on its old bounding box can otherwise put its entrance behind a fixed source.
    column_x = {0: 0}
    for rank in range(1, max(ranks.values())+1):
        previous_width = max((by_id[n]["size"][0] for n in layers[rank-1] if n in by_id), default=40)
        column_x[rank] = column_x[rank-1]+previous_width+(48 if dense else min(160, width*.25))
    origin_x = float(np.mean([n["pos"][0]-column_x[ranks[n["id"]]] for n in original if n.get("selected")]))
    lower, upper, anchors_y = [], [], []
    for e in edges:
        a, b = by_id[e["source"]], by_id[e["target"]]
        if not a.get("selected") and b.get("selected"):
            lower.append(a["pos"][0]+a["size"][0]+100-column_x[ranks[b["id"]]])
            anchors_y.append(a["pos"][1]-ypos[b["id"]])
        elif a.get("selected") and not b.get("selected"):
            upper.append(b["pos"][0]-a["size"][0]-100-column_x[ranks[a["id"]]])
            anchors_y.append(b["pos"][1]-ypos[a["id"]])
    if lower:
        origin_x = max(origin_x, max(lower))
    if upper and (not lower or max(lower) <= min(upper)):
        origin_x = min(origin_x, min(upper))
    origin_y = float(np.mean(anchors_y)) if anchors_y else float(centre[1])
    candidate = copy.deepcopy(original)
    for n in candidate:
        if n.get("selected"):
            n["pos"] = [origin_x+column_x[ranks[n["id"]]], origin_y+ypos[n["id"]]]
    return candidate


def conflict_quality(checks):
    # Keep nodes readable before trading off the remaining wire crossings.
    return checks["overlaps"], checks["nodeIntersections"], checks["crossings"]


def layout_cost(nodes, edges):
    by_id = {n["id"]: n for n in nodes}
    total = 0
    for e in edges:
        a, b = by_id[e["source"]], by_id[e["target"]]
        if not (a.get("selected") or b.get("selected")):
            continue
        pa, pb = a["outputs"][e["output"]], b["inputs"][e["input"]]
        dx = b["pos"][0]+pb["x"]-a["pos"][0]-pa["x"]
        dy = b["pos"][1]+pb["y"]-a["pos"][1]-pa["y"]
        total += math.hypot(dx, dy)+3*max(0, -dx)
        if a.get("selected") and b.get("selected"):
            centres = [abs((b["pos"][axis]+(b["size"][axis]-(b.get("titleHeight",30) if axis else 0))/2)-
                           (a["pos"][axis]+(a["size"][axis]-(a.get("titleHeight",30) if axis else 0))/2))
                       for axis in (0,1)]
            # Prefer a shared row or column over a slightly shorter diagonal.
            total += 3*min(centres)
    chosen = [n for n in nodes if n.get("selected")]
    if chosen:
        # Include empty space around disconnected branches and Notes as well.
        width = max(n["pos"][0]+n["size"][0] for n in chosen)-min(n["pos"][0] for n in chosen)
        height = max(n["pos"][1]+n["size"][1] for n in chosen)-min(
            n["pos"][1]-n.get("titleHeight", 30) for n in chosen)
        total += .25*(width+height)
    return total


def better(checks, cost, before, before_cost):
    quality, old_quality = conflict_quality(checks), conflict_quality(before)
    return quality < old_quality or (quality == old_quality and cost < before_cost-1)


def no_more_conflicts(checks, previous):
    return all(checks[k] <= previous[k] for k in previous)


def tighten_spacing(nodes, edges, cancelled=lambda: False):
    """Close gaps by translating whole rows/columns, preserving their centres.

    A nearby pair only limits its own cut, not every other gap on the canvas.
    Try moving either side so fixed external endpoints can retain their anchors.
    """
    result = copy.deepcopy(nodes)
    checks = evaluate(result, edges, precise=True)
    cost = layout_cost(result, edges)
    selected = [i for i, n in enumerate(result) if n.get("selected")]
    by_id = {n["id"]: i for i, n in enumerate(result)}
    forward = []
    for e in edges:
        a, b = by_id[e["source"]], by_id[e["target"]]
        separation = result[b]["pos"][0]-result[a]["pos"][0]-result[a]["size"][0]
        if separation >= 0:
            forward.append((a, b, min(48, separation)))
    deadline = time.monotonic()+6

    def box(n, axis):
        return (n["pos"][axis]-(n.get("titleHeight", 30) if axis == 1 else 0),
                n["pos"][axis]+n["size"][axis])

    for _ in range(3):
        changed = False
        for axis, gap in ((0, 48), (1, 32)):
            # Equal visible centres remain in one group even for unequal sizes.
            groups = []
            for i in sorted(selected, key=lambda i: sum(box(result[i], axis))/2):
                centre = sum(box(result[i], axis))/2
                if groups and abs(centre-sum(box(result[groups[-1][0]], axis))/2) < 1e-6:
                    groups[-1].append(i)
                else:
                    groups.append([i])
            for cut in range(1, len(groups)):
                if cancelled() or time.monotonic() >= deadline:
                    return result
                lower = [i for group in groups[:cut] for i in group]
                upper = [i for group in groups[cut:] for i in group]
                # Preserve ordering of centre lines, including staggered boxes.
                distance = (sum(box(result[upper[0]], axis))-sum(box(result[lower[-1]], axis)))/2
                limit = distance-1
                for i in lower:
                    for j in upper:
                        a, b = box(result[i], 1-axis), box(result[j], 1-axis)
                        if a[0] <= b[1]+32 and b[0] <= a[1]+32:
                            limit = min(limit, box(result[j], axis)[0]-box(result[i], axis)[1]-gap)
                if limit <= 1:
                    continue
                for moving, direction in ((upper, -1), (lower, 1)):
                    # If the full move hits an obstacle or a curved wire, narrow
                    # the step, then refine the largest verified safe movement.
                    low, high, amount = 0, limit, limit
                    accepted = None
                    for attempt in range(9):
                        if cancelled() or time.monotonic() >= deadline:
                            return result
                        candidate = copy.deepcopy(result)
                        for i in moving:
                            candidate[i]["pos"][axis] += direction*amount
                        new_cost = layout_cost(candidate, edges)
                        ordered = axis != 0 or all(
                            candidate[b]["pos"][0]-candidate[a]["pos"][0]-candidate[a]["size"][0] >= gap-1e-6
                            for a, b, gap in forward)
                        if ordered and new_cost < cost-1:
                            measured = evaluate(candidate, edges, precise=True)
                            valid = no_more_conflicts(measured, checks)
                        else:
                            valid = False
                        if valid:
                            accepted = candidate, measured, new_cost
                            low = amount
                            if attempt == 0:
                                break
                        else:
                            high = amount
                        if high-low <= 1:
                            break
                        amount = (low+high)/2
                    if accepted is not None:
                        result, checks, cost = accepted
                        changed = True
                        break
        if not changed:
            break
    return result


def settle_sources(nodes, edges, cancelled=lambda: False):
    """Place a short source beside its own consumer rather than a distant inlet."""
    result = copy.deepcopy(nodes)
    checks = evaluate(result, edges, precise=True)
    cost = layout_cost(result, edges)
    graph = nx.DiGraph()
    graph.add_nodes_from(n["id"] for n in nodes)
    graph.add_edges_from((e["source"], e["target"]) for e in edges)
    by_id = {n["id"]: n for n in result}
    deadline = time.monotonic()+2
    for index,n in enumerate(result):
        if cancelled() or time.monotonic() >= deadline:
            break
        if not n.get("selected") or graph.in_degree(n["id"]) or graph.out_degree(n["id"]) != 1:
            continue
        target = next(graph.successors(n["id"]))
        cx = n["pos"][0]+n["size"][0]/2
        # Keep aligned peers feeding the same consumer, e.g. loop input constants.
        if any(m["id"]!=n["id"] and graph.has_edge(m["id"],target) and
               abs(m["pos"][0]+m["size"][0]/2-cx)<1e-6 for m in result):
            continue
        x = by_id[target]["pos"][0]-n["size"][0]-48
        if x <= n["pos"][0]+1:
            continue
        for amount in (1,.75,.5,.25):
            trial = copy.deepcopy(result)
            trial[index]["pos"][0] += (x-n["pos"][0])*amount
            measured = evaluate(trial,edges,precise=True)
            trial_cost = layout_cost(trial,edges)
            if no_more_conflicts(measured,checks) and trial_cost < cost-1:
                result,checks,cost = trial,measured,trial_cost
                by_id = {m["id"]:m for m in result}
                break
    return result


def compact(nodes, edges, cancelled=lambda: False):
    """Shrink verified layouts, retaining port identity and fixed boundary geometry."""
    result = copy.deepcopy(nodes)
    checks = evaluate(result, edges, precise=True)
    chosen = [n for n in result if n.get("selected")]
    # Coarse compression leaves room for the following alignment pass. The
    # final grouped pass closes individual gaps without breaking that alignment.
    for axis in (0, 1):
        anchor = min(n["pos"][0] for n in chosen) if axis == 0 else float(np.mean([n["pos"][1] for n in chosen]))
        for _ in range(14):
            if cancelled():
                return result
            candidate = copy.deepcopy(result)
            for n in candidate:
                if n.get("selected"):
                    n["pos"][axis] = anchor+(n["pos"][axis]-anchor)*.90
            measured = evaluate(candidate, edges, precise=True)
            if not no_more_conflicts(measured, checks):
                break
            result, checks = candidate, measured
    # Pull loose sources toward their consumers and straighten short chains.
    cost = layout_cost(result, edges)
    deadline = time.monotonic()+4
    for _ in range(2):
        for index in [i for i,n in enumerate(result) if n.get("selected")]:
            n = result[index]
            by_id = {m["id"]: m for m in result}
            left, right, heights = [], [], []
            for e in edges:
                if e["target"] == n["id"] and e["source"] != n["id"]:
                    a = by_id[e["source"]]
                    left.append(a["pos"][0]+a["size"][0]+100)
                    heights.append(a["pos"][1]+a["outputs"][e["output"]]["y"]-n["inputs"][e["input"]]["y"])
                elif e["source"] == n["id"] and e["target"] != n["id"]:
                    b = by_id[e["target"]]
                    right.append(b["pos"][0]-n["size"][0]-100)
                    heights.append(b["pos"][1]+b["inputs"][e["input"]]["y"]-n["outputs"][e["output"]]["y"])
            xs = []
            if left and right and max(left) <= min(right):
                xs = [max(left), min(right), (max(left)+min(right))/2]
            elif left and not right:
                xs = [max(left)]
            elif right and not left:
                xs = [min(right)]
            mid = float(np.median(heights)) if heights else n["pos"][1]
            ys = [mid, mid-n["size"][1]-90, mid+n["size"][1]+90] if heights else []
            for axis, values in ((0, xs), (1, ys)):
                for value in values:
                    if cancelled() or time.monotonic() >= deadline:
                        return result
                    candidate = copy.deepcopy(result)
                    candidate[index]["pos"][axis] = value
                    new_cost = layout_cost(candidate, edges)
                    if new_cost < cost-1:
                        measured = evaluate(candidate, edges, precise=True)
                        if no_more_conflicts(measured, checks):
                            result, cost, checks = candidate, new_cost, measured
    return result


def align_layout(nodes, edges, cancelled=lambda: False):
    """Align visible box centres in columns and connected rows, keeping valid geometry."""
    result = copy.deepcopy(nodes)
    checks = evaluate(result, edges, precise=True)
    indices = {n["id"]: i for i,n in enumerate(result) if n.get("selected")}
    graph = nx.DiGraph()
    graph.add_nodes_from(indices)
    graph.add_edges_from((e["source"], e["target"]) for e in edges
                         if e["source"] in indices and e["target"] in indices)
    dag = nx.is_directed_acyclic_graph(graph)
    reduced = nx.transitive_reduction(graph) if dag else graph
    main = nx.dag_longest_path(reduced) if dag else []
    primary = set(main)
    deadline = time.monotonic()+4

    def centre(n, axis):
        return n["pos"][axis]+(n["size"][axis]-(n.get("titleHeight",30) if axis == 1 else 0))/2

    def align(group, axis, preferred):
        nonlocal result, checks
        values = [preferred, float(np.median([centre(result[i],axis) for i in group]))]
        values.extend(centre(result[i],axis) for i in sorted(group))
        for value in dict.fromkeys(values):
            if cancelled() or time.monotonic() >= deadline:
                return False
            candidate = copy.deepcopy(result)
            for i in group:
                n = candidate[i]
                n["pos"][axis] += value-centre(n,axis)
            measured = evaluate(candidate,edges,precise=True)
            if no_more_conflicts(measured, checks):
                result, checks = candidate, measured
                return True
        return False

    # Nearby independent branches form columns. Do not collapse consecutive
    # stages into one column, or move a fixed external node to obtain alignment.
    columns = {i:{i} for i in indices.values()}
    pairs = []
    selected = list(indices)
    for p, a in enumerate(selected):
        for b in selected[p+1:]:
            if nx.has_path(graph,a,b) or nx.has_path(graph,b,a):
                continue
            i, j = indices[a], indices[b]
            distance = abs(centre(result[i],0)-centre(result[j],0))
            width = min(result[i]["size"][0],result[j]["size"][0])
            if distance <= width*.75:
                pairs.append((distance/max(width,1),i,j))
    for _, i, j in sorted(pairs):
        group = columns[i] | columns[j]
        if columns[i] == columns[j]:
            continue
        names = [result[k]["id"] for k in group]
        if any(nx.has_path(graph,a,b) or nx.has_path(graph,b,a)
               for p,a in enumerate(names) for b in names[p+1:]):
            continue
        anchor = next((k for k in sorted(group) if result[k]["id"] in primary), min(group))
        if align(group,0,centre(result[anchor],0)):
            for k in group:
                columns[k] = group

    # Align suffixes first: e.g. a return node and its final preview should
    # follow the main chain's centre instead of floating above it together.
    rows = {i:{i} for i in indices.values()}
    main_edges = list(zip(main,main[1:]))
    remaining = [e for e in reduced.edges if e not in main_edges]
    remaining.sort(key=lambda e: result[indices[e[1]]]["pos"][0], reverse=True)
    bypass = [e for e in graph.edges if not reduced.has_edge(*e)]
    bypass.sort(key=lambda e: abs(result[indices[e[1]]]["pos"][0]-result[indices[e[0]]]["pos"][0]))
    for a,b in list(reversed(main_edges))+remaining+bypass:
        i,j = indices[a],indices[b]
        if rows[i] == rows[j]:
            continue
        group = rows[i] | rows[j]
        if align(group,1,centre(result[i],1)):
            for k in group:
                rows[k] = group
    return result


def solve(data, seconds=45, progress=None, cancelled=lambda: False):
    nodes, edges = validate(data)
    selected = [n for n in nodes if n.get("selected")]
    graph = nx.Graph()
    graph.add_nodes_from(n["id"] for n in selected)
    graph.add_edges_from((e["source"], e["target"]) for e in edges
                         if e["source"] in graph and e["target"] in graph)
    if progress:
        progress({"stage": "topology", "nodes": len(selected), "edges": graph.number_of_edges(), "trials": 0})
    planar = nx.check_planarity(graph)[0]
    if not planar and progress:
        progress({"stage": "nonplanar", "trials": 0,
                  "message": "连接拓扑无法消除全部交叉，继续搜索可改善的布局。"})
    start = time.monotonic()
    original = copy.deepcopy(nodes)
    best = copy.deepcopy(nodes)
    rng = random.Random(data.get("seed", 0))

    def score(checks):
        return checks["crossings"]*100 + checks["nodeIntersections"]*130 + checks["overlaps"]*200

    initial = evaluate(nodes, edges, precise=True)
    before_cost = best_cost = layout_cost(nodes, edges)
    best_score = score(initial)
    best_checks = initial
    last_progress = 0
    directed = nx.DiGraph()
    directed.add_nodes_from(graph)
    directed.add_edges_from((e["source"], e["target"]) for e in edges if e["source"] in graph and e["target"] in graph)
    condensed = nx.condensation(directed)
    rank = {}
    for group in nx.topological_sort(condensed):
        r = max((rank[p]+1 for p in condensed.predecessors(group)), default=0)
        rank[group] = r
    ranks = {n: rank[condensed.graph["mapping"][n]] for n in graph}
    reverse_rank = {}
    for group in reversed(list(nx.topological_sort(condensed))):
        reverse_rank[group] = max((reverse_rank[p]+1 for p in condensed.successors(group)), default=0)
    late_ranks = {n: max(rank.values())-reverse_rank[condensed.graph["mapping"][n]] for n in graph}
    width = max(n["size"][0] for n in selected)+200
    height = max(n["size"][1] for n in selected)+100
    centre = np.mean([n["pos"] for n in selected], axis=0)
    trials = 0
    finalists = [((*conflict_quality(initial), before_cost), copy.deepcopy(original))]
    zero_since = start if not any(initial.values()) else None

    def retain(candidate, checks):
        if any(ns == candidate for _,ns in finalists):
            return
        finalists.append(((*conflict_quality(checks), layout_cost(candidate, edges)), copy.deepcopy(candidate)))
        finalists.sort(key=lambda item: item[0])
        del finalists[3:]

    while time.monotonic()-start < seconds:
        if cancelled():
            return {"status": "cancelled", "message": "已取消整理，画布保持原样。"}
        if trials == 0:
            candidate = copy.deepcopy(original)
        elif trials < 9 or trials % 45 == 1:
            variant = trials if trials < 9 else trials//45
            candidate = layered_seed(original, directed, late_ranks if (variant//2) % 2 == 0 else ranks,
                                     width, height, centre, rng, edges, dense=variant % 2 == 0)
        else:
            candidate = copy.deepcopy(current)
            choices = [n for n in candidate if n.get("selected")]
            if current_conflicts and rng.random() < .75:
                conflict = rng.choice(current_conflicts)
                ids = set(conflict.get("nodes", []))
                for e in conflict.get("edges", [conflict["edge"]] if "edge" in conflict else []):
                    ids.update((e["source"],e["target"]))
                choices = [n for n in choices if n["id"] in ids] or choices
            n = rng.choice(choices)
            if rng.random() < .25:
                m = rng.choice(choices)
                n["pos"][1], m["pos"][1] = m["pos"][1], n["pos"][1]
            else:
                axis = 0 if rng.random() < .15 else 1
                step = (n["size"][axis]+48)*.25
                n["pos"][axis] += rng.choice([-4,-2,-1,1,2,4])*step
        reorder(candidate, edges)
        candidate_conflicts = []
        coarse = evaluate(candidate, edges, report=candidate_conflicts)
        value = score(coarse)
        candidate_cost = layout_cost(candidate, edges)
        if better(coarse, candidate_cost, best_checks, best_cost) or value == 0:
            actual = evaluate(candidate, edges, precise=True)
            if better(actual, candidate_cost, best_checks, best_cost):
                best, best_checks, best_cost = copy.deepcopy(candidate), actual, candidate_cost
                best_score = score(actual)
                retain(candidate, actual)
            if not any(actual.values()):
                if zero_since is None:
                    zero_since = time.monotonic()
                # A valid first candidate is not necessarily compact or aligned.
                # Keep comparing early/late ranks and variable-height layouts.
                if candidate is not best and candidate_cost <= best_cost*1.3:
                    retain(candidate, actual)
            value = score(actual)
        elapsed = time.monotonic()-start
        if progress and elapsed-last_progress >= .5:
            progress({"stage": "search", "trials": trials+1, "before": initial, "best": best_checks,
                      "elapsed": round(elapsed, 1)})
            last_progress = elapsed
        temperature = max(8, 100*(1-(trials % 90)/90))
        if trials == 0 or trials % 90 == 1 or value < current_score or rng.random() < math.exp(min(0, (current_score-value)/temperature)):
            current, current_score = candidate, value
            current_conflicts = candidate_conflicts
        if trials % 90 == 0 and trials:
            current, current_score = copy.deepcopy(best), best_score
            current_conflicts = []
            evaluate(current, edges, report=current_conflicts)
        trials += 1
        if zero_since is not None and trials >= 9 and time.monotonic()-zero_since >= min(6, seconds*.8):
            break
    if cancelled():
        return {"status": "cancelled", "message": "已取消整理，画布保持原样。"}
    # Refine even an imperfect candidate; existing crossings no longer block
    # alignment of unrelated rows/columns. Retain the unrefined best as fallback.
    if progress:
        progress({"stage": "compact", "trials": trials, "before": initial, "best": best_checks,
                  "elapsed": round(time.monotonic()-start, 1)})
    deadline = time.monotonic()+20
    refinement_stopped = lambda: cancelled() or time.monotonic() >= deadline
    refined = []
    for _, draft in finalists:
        if refinement_stopped():
            break
        candidate = refine_ports(draft, edges, refinement_stopped)
        candidate = repair_conflicts(candidate, edges, refinement_stopped)
        candidate = compact(candidate, edges, refinement_stopped)
        if progress:
            progress({"stage": "align", "trials": trials, "before": initial,
                      "best": evaluate(candidate, edges, precise=True), "elapsed": round(time.monotonic()-start, 1)})
        candidate = align_layout(candidate, edges, refinement_stopped)
        candidate = refine_ports(candidate, edges, refinement_stopped)
        candidate = align_layout(candidate, edges, refinement_stopped)
        # Alignment and port exchanges may open new gaps. Close them together.
        candidate = tighten_spacing(candidate, edges, refinement_stopped)
        candidate = settle_sources(candidate, edges, refinement_stopped)
        refined.append(candidate)
    if cancelled():
        return {"status": "cancelled", "message": "已取消整理，画布保持原样。"}
    candidate = min([best, *refined], key=lambda ns: (
        *conflict_quality(evaluate(ns, edges, precise=True)), layout_cost(ns, edges)))
    conflicts = []
    checks = evaluate(candidate, edges, precise=True, report=conflicts)
    improved = better(checks, layout_cost(candidate, edges), initial, before_cost)
    result = {"status": "ok" if improved else "not_improved", "partial": any(checks.values()), "planar": planar,
              "trials": trials, "before": initial, "checks": checks, "conflicts": conflicts[:8],
              "elapsed": round(time.monotonic()-start, 2)}
    if improved:
        result["nodes"] = [{"id": n["id"], "pos": n["pos"],
                            **{side: n.get(side+"Order", sorted(range(len(n[side])), key=lambda i: n[side][i]["y"]))
                               for side in ("inputs", "outputs")}}
                           for n in candidate if n.get("selected")]
    else:
        result["message"] = "本次没有找到比现状更好的布局，画布保持原样。"
    return result


_busy = False


async def stream_layout(request, data):
    response = web.StreamResponse(headers={"Content-Type": "application/x-ndjson; charset=utf-8",
                                          "Cache-Control": "no-store", "X-Accel-Buffering": "no"})
    await response.prepare(request)
    loop = asyncio.get_running_loop()
    events = asyncio.Queue()
    stopped = threading.Event()

    def progress(value):
        loop.call_soon_threadsafe(events.put_nowait, value)

    async def send(event, value):
        await response.write((json.dumps({"event": event, "data": value}, ensure_ascii=False)+"\n").encode("utf-8"))

    worker = asyncio.create_task(asyncio.to_thread(solve, data, 45, progress, stopped.is_set))
    try:
        while not worker.done() or not events.empty():
            if request.transport is None or request.transport.is_closing():
                stopped.set()
                break
            try:
                value = await asyncio.wait_for(events.get(), timeout=.5)
                await send("progress", value)
            except asyncio.TimeoutError:
                continue
        result = await asyncio.shield(worker)
        if not stopped.is_set():
            await send("result", result)
            await response.write_eof()
    except (ConnectionError, asyncio.CancelledError):
        stopped.set()
    except Exception as error:
        if request.transport is not None and not request.transport.is_closing():
            await send("error", {"message": f"整理计算失败：{error}"})
    finally:
        stopped.set()
        # Keep the service lock until the worker has actually stopped.
        if not worker.done():
            await asyncio.shield(worker)
    return response


async def layout_request(request):
    global _busy
    if _busy:
        return web.json_response({"message": "已有一次整理正在计算，请稍后再试。"}, status=409)
    _busy = True
    try:
        data = await request.json()
        validate(data)
        if data.get("stream") and not data.get("verify"):
            return await stream_layout(request, data)
        if data.get("verify"):
            conflicts = []
            checks = await asyncio.to_thread(evaluate, data["nodes"], data["edges"], True, conflicts)
            accepted = not any(checks.values())
            before = None
            if "baseline" in data:
                baseline_nodes, baseline_edges = validate(data["baseline"])
                before = await asyncio.to_thread(evaluate, baseline_nodes, baseline_edges, True)
                accepted = better(checks, layout_cost(data["nodes"], data["edges"]), before,
                                  layout_cost(baseline_nodes, baseline_edges))
            result = {"status": "ok" if accepted else "not_improved", "checks": checks,
                      "before": before, "partial": any(checks.values()), "conflicts": conflicts[:8]}
        else:
            result = await asyncio.to_thread(solve, data)
        return web.json_response(result)
    except (ValueError, TypeError, KeyError, IndexError, OverflowError) as error:
        return web.json_response({"message": f"无法整理：{error}"}, status=400)
    finally:
        _busy = False


PromptServer.instance.routes.post("/liuxinyu/layout")(layout_request)
