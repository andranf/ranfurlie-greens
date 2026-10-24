#!/usr/bin/env python3
"""Build hardware/network.json (mainline, sluice valves, pump) from the first-pass trace in mainline_routes.py.

Needs the CirrusPRO image layer Irrigation_asbuilt_2000_v3.png (fetch with the "Fetch CirrusPRO image layers"
GitHub workflow). Usage:  python3 build_network.py <path to Irrigation_asbuilt_2000_v3.png>

Only run this to start the network again from the drawing. Once the crew edit the network on the map, network.json
is the record (the page saves edits straight to it), and re-running this would throw those edits away.
"""
import json, math, os, sys, datetime
import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from skimage.graph import route_through_array

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from mainline_routes import ROUTES, PUMP  # noqa: E402

AB = dict(w=3289, h=2311, w0=145.23795958625612, e0=145.25110681155834, n0=-38.11694297598153, s0=-38.12420949834375)


def px2ll(x, y):
    return [round(AB['n0'] + (AB['s0'] - AB['n0']) * y / AB['h'], 7), round(AB['w0'] + (AB['e0'] - AB['w0']) * x / AB['w'], 7)]


def ll2px(lat, lng):
    return ((lng - AB['w0']) / (AB['e0'] - AB['w0']) * AB['w'], (lat - AB['n0']) / (AB['s0'] - AB['n0']) * AB['h'])


M_PER_PX = (AB['e0'] - AB['w0']) * 111320 * math.cos(math.radians(38.12)) / AB['w']


def cost_map(path):
    im = Image.open(path)
    a = np.array(im)
    strong = a == 1                                   # solid white strokes (pipes, heads, text)
    lab, n = ndi.label(strong, structure=np.ones((3, 3)))
    sizes = ndi.sum(strong, lab, range(n + 1))
    dash = ndi.binary_dilation(strong & (sizes[lab] < 90), iterations=1)   # the dash-dot mainline breaks into small pieces
    tr = im.info['transparency']
    alpha = np.array(list(tr) + [255] * (256 - len(tr)))[a]
    ink = alpha > 120
    c = np.full(a.shape, 8.0)
    c[ink] = 3.0
    c[strong] = 4.0
    c[dash] = 1.0
    return c


def rdp(pts, eps):
    if len(pts) < 3: return pts
    a, b = np.array(pts[0], float), np.array(pts[-1], float)
    ab = b - a; L = np.hypot(*ab)
    best, idx = -1, 0
    for i in range(1, len(pts) - 1):
        p = np.array(pts[i], float)
        d = abs(ab[0] * (p - a)[1] - ab[1] * (p - a)[0]) / L if L else np.hypot(*(p - a))
        if d > best: best, idx = d, i
    if best > eps:
        return rdp(pts[:idx + 1], eps)[:-1] + rdp(pts[idx:], eps)
    return [pts[0], pts[-1]]


def snap_path(c, p, q, pad=22):
    x0, x1 = int(min(p[0], q[0]) - pad), int(max(p[0], q[0]) + pad)
    y0, y1 = int(min(p[1], q[1]) - pad), int(max(p[1], q[1]) + pad)
    x0, y0 = max(0, x0), max(0, y0); x1, y1 = min(c.shape[1] - 1, x1), min(c.shape[0] - 1, y1)
    sub = c[y0:y1 + 1, x0:x1 + 1]
    path, _ = route_through_array(sub, (int(p[1]) - y0, int(p[0]) - x0), (int(q[1]) - y0, int(q[0]) - x0), fully_connected=True, geometric=True)
    return [(x + x0, y + y0) for y, x in path]


def main():
    c = cost_map(sys.argv[1])
    traced = []
    for rid, mm, wps in ROUTES:
        pts = []
        for p, q in zip(wps, wps[1:]):
            seg = snap_path(c, p, q)
            pts += seg if not pts else seg[1:]
        pts = [wps[0]] + pts[1:-1] + [wps[-1]]          # keep the exact waypoint ends so routes meet
        pts = rdp([tuple(map(float, p)) for p in pts], 1.6)
        traced.append([rid, mm, pts])

    # ---- graph: nodes at route ends; a route end that lands on another route splits that route there
    nodes = []          # [x, y, kind]
    def node_at(x, y, kind='j', tol=6):
        for i, nd in enumerate(nodes):
            if math.hypot(nd[0] - x, nd[1] - y) <= tol: return i
        nodes.append([x, y, kind]); return len(nodes) - 1

    ends = []
    for r in traced:
        a = node_at(*r[2][0]); b = node_at(*r[2][-1]); ends.append((a, b))
    # split points: any node lying on the interior of a route
    pipes = []          # [a, b, pts(list of xy incl ends), mm, route]
    for (rid, mm, pts), (a, b) in zip(traced, ends):
        cuts = []
        for ni, (nx, ny, _) in enumerate(nodes):
            if ni in (a, b): continue
            best = None
            for i in range(len(pts) - 1):
                (x1, y1), (x2, y2) = pts[i], pts[i + 1]
                dx, dy = x2 - x1, y2 - y1; L2 = dx * dx + dy * dy or 1e-9
                t = max(0, min(1, ((nx - x1) * dx + (ny - y1) * dy) / L2))
                px, py = x1 + t * dx, y1 + t * dy
                d = math.hypot(px - nx, py - ny)
                if best is None or d < best[0]: best = (d, i, t)
            if best and best[0] <= 14: cuts.append((best[1] + best[2], best[1], ni))
        cuts.sort()
        cur = [pts[0]]; start = a; k = 0
        for pos, i, ni in cuts:
            while k < i: k += 1; cur.append(pts[k])
            cur.append((nodes[ni][0], nodes[ni][1]))
            pipes.append([start, ni, cur, mm, rid]); start = ni; cur = [(nodes[ni][0], nodes[ni][1])]
        while k < len(pts) - 1: k += 1; cur.append(pts[k])
        cur[-1] = (nodes[b][0], nodes[b][1])
        pipes.append([start, b, cur, mm, rid])

    # ---- pump: its own node, joined to the nearest junction where the 250 mm mains meet
    pj = node_at(2780, 458)
    src = len(nodes); nodes.append([PUMP[0], PUMP[1], 'src'])
    pipes.append([src, pj, [PUMP, (nodes[pj][0], nodes[pj][1])], "", "Pump"])

    # ---- valves from the as-built plan points (LI-IV / SV / MV): put each on the mainline if it is within 5 m (8 m for
    #      sluice and MV valves, whose symbols are drawn beside the line). Sluice and MV valves sit in the main itself.
    #      An LI-IV is a lateral isolation valve: it goes on a short stub off the main (a tap), so closing it shuts the
    #      lateral but not the main. Heads are linked to an LI-IV on the map (feeds); until then they feed off the main.
    ref = json.load(open(os.path.join(HERE, '..', 'ref.json')))
    placed, offline = [], []
    for code, typ, lat, lng in ref['plan']:
        if typ not in ('sv', 'mv', 'iv'): continue
        x, y = ll2px(lat, lng)
        best = None
        for pi, (a, b, pts, mm, rid) in enumerate(pipes):
            for i in range(len(pts) - 1):
                (x1, y1), (x2, y2) = pts[i], pts[i + 1]
                dx, dy = x2 - x1, y2 - y1; L2 = dx * dx + dy * dy or 1e-9
                t = max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / L2))
                px, py = x1 + t * dx, y1 + t * dy
                d = math.hypot(px - x, py - y)
                if best is None or d < best[0]: best = (d, pi, i, t, px, py)
        dm = best[0] * M_PER_PX
        if dm <= 9.0:
            placed.append((code, typ, best, (x, y)))
        else:
            offline.append((code, typ, round(dm, 1)))
    # insert valves (split pipes); process per pipe in order along it
    by_pipe = {}
    stubs = []
    for code, typ, (d, pi, i, t, px, py), plan_xy in placed:
        by_pipe.setdefault(pi, []).append((i + t, i, px, py, code, typ, plan_xy))
    new_pipes = []
    for pi, (a, b, pts, mm, rid) in enumerate(pipes):
        vs = sorted(by_pipe.get(pi, []))
        if not vs: new_pipes.append([a, b, pts, mm, rid]); continue
        cur = [pts[0]]; start = a; k = 0
        for pos, i, px, py, code, typ, plan_xy in vs:
            if typ == 'iv':
                # tap on the main, valve on a stub towards where the plan shows it
                if math.hypot(px - nodes[start][0], py - nodes[start][1]) < 2:
                    tap = start
                else:
                    while k < i: k += 1; cur.append(pts[k])
                    tap = len(nodes); nodes.append([px, py, 'j'])
                    cur.append((px, py)); new_pipes.append([start, tap, cur, mm, rid]); start = tap; cur = [(px, py)]
                vx, vy = plan_xy
                if math.hypot(vx - px, vy - py) < 5:
                    (x1, y1), (x2, y2) = pts[i], pts[min(i + 1, len(pts) - 1)]
                    dx, dy = x2 - x1, y2 - y1; L = math.hypot(dx, dy) or 1
                    side = 1 if (vx - px) * (-dy) + (vy - py) * dx >= 0 else -1
                    vx, vy = px + side * -dy / L * 6, py + side * dx / L * 6
                vi = len(nodes); nodes.append([vx, vy, 'iv', code])
                stubs.append([tap, vi, [(px, py), (vx, vy)], "", "LI stub"])
                continue
            if math.hypot(px - nodes[start][0], py - nodes[start][1]) < 2 and nodes[start][2] == 'j':
                nodes[start][2] = typ; nodes[start].append(code); continue
            while k < i: k += 1; cur.append(pts[k])
            vi = len(nodes); nodes.append([px, py, typ, code])
            cur.append((px, py)); new_pipes.append([start, vi, cur, mm, rid]); start = vi; cur = [(px, py)]
        while k < len(pts) - 1: k += 1; cur.append(pts[k])
        new_pipes.append([start, b, cur, mm, rid])
    pipes = new_pipes + stubs

    # ---- dead ends
    deg = {}
    for a, b, *_ in pipes: deg[a] = deg.get(a, 0) + 1; deg[b] = deg.get(b, 0) + 1
    for i, nd in enumerate(nodes):
        if nd[2] == 'j' and deg.get(i, 0) == 1: nd[2] = 'end'
        if nd[2] == 'j' and deg.get(i, 0) == 0: nd[2] = 'gone'

    # ---- name each run after the holes whose heads sit closest to it
    import re as _re
    run_holes = {}
    for name, lat, lng in ref['heads']:
        hx, hy = ll2px(lat, lng); best = None
        for a, b, pts, mm, rid in pipes:
            if rid in ("LI stub", "Pump"): continue
            for i in range(len(pts) - 1):
                (x1, y1), (x2, y2) = pts[i], pts[i + 1]
                dx, dy = x2 - x1, y2 - y1; L2 = dx * dx + dy * dy or 1e-9
                t = max(0, min(1, ((hx - x1) * dx + (hy - y1) * dy) / L2))
                d = math.hypot(x1 + t * dx - hx, y1 + t * dy - hy)
                if best is None or d < best[0]: best = (d, rid)
        m = _re.match(r"(\d+)", name)
        if best and m and best[0] * M_PER_PX < 120:
            h = int(m.group(1))
            if 1 <= h <= 18: run_holes.setdefault(best[1], {}).setdefault(h, 0); run_holes[best[1]][h] += 1
    def ordn(n): return f"{n}{'th' if 11 <= n % 100 <= 13 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"
    run_name = {}
    for rid, mm, _ in traced:
        hs = sorted(run_holes.get(rid, {}).items(), key=lambda kv: -kv[1])
        top = sorted(h for h, c in hs[:3] if c >= max(3, hs[0][1] * 0.25)) if hs else []
        nm = "Main" + (" by the " + (", ".join(ordn(h) for h in top[:-1]) + " and " + ordn(top[-1]) if len(top) > 1 else ordn(top[0])) if top else "")
        run_name[rid] = nm
    run_name["Pump"] = "Pump to the mains"; run_name["LI stub"] = "LI-IV take-off"
    pipes = [[a, b, pts, mm, run_name.get(rid, rid)] for a, b, pts, mm, rid in pipes]
    print({k: v for k, v in run_name.items()})

    out_nodes = []
    for i, nd in enumerate(nodes):
        o = {"id": f"n{i}", "k": nd[2]}
        o["lat"], o["lng"] = px2ll(nd[0], nd[1])
        if len(nd) > 3: o["ref"] = nd[3]
        if nd[2] == 'src': o["name"] = "Pump shed"; o["note"] = "Connection to the mains assumed (the dam and pump postdate the 2000 drawing)"
        out_nodes.append(o)
    out_pipes = []
    for j, (a, b, pts, mm, rid) in enumerate(pipes):
        o = {"id": f"p{j}", "a": f"n{a}", "b": f"n{b}", "pts": [px2ll(x, y) for x, y in pts[1:-1]]}
        if mm: o["mm"] = mm
        o["run"] = rid
        if rid == "Pump to the mains": o["note"] = "Assumed: pump shed to the 250 mm mains"
        if rid == "LI-IV take-off": o["stub"] = 1
        out_pipes.append(o)
    net = {
        "v": 1,
        "updated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "First pass traced from the 2000 irrigation as-built (CirrusPRO layer), 24 Oct 2026. Valves from the as-built plan points.",
        "nodes": out_nodes,
        "pipes": out_pipes,
        "feeds": {},
        "log": [],
    }
    path = os.path.join(HERE, '..', 'network.json')
    s = json.dumps(net, separators=(",", ":"))
    open(path, "w").write(s)
    kinds = {}
    for nd in nodes: kinds[nd[2]] = kinds.get(nd[2], 0) + 1
    L = 0
    for a, b, pts, *_ in pipes:
        L += sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1))
    print(f"network.json: {len(out_nodes)} nodes {kinds}, {len(out_pipes)} pipes, {L * M_PER_PX / 1000:.2f} km, {len(s) / 1024:.1f} KB")
    print("valves on the mainline:", len(placed), " not within 5 m of it:", len(offline))
    offc = {}
    for code, typ, dm in offline: offc[typ] = offc.get(typ, 0) + 1
    print("LI-IV stubs:", len(stubs))
    print("off-line by type:", offc)
    json.dump({"offline": offline}, open('/tmp/claude-0/-home-claude/0ea4db0e-68d9-582b-8f7c-cd4e4d881e50/scratchpad/trace/offline.json', 'w'))


if __name__ == "__main__":
    main()
