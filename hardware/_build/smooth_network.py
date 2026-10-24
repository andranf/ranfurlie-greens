#!/usr/bin/env python3
"""Smooth the mainline in hardware/network.json in place (keeps every node, valve, link and edit).

The first-pass trace follows the drawing pixel by pixel, so runs came out wobbly. Each run of main between two
junctions or ends is treated as one line: resampled every metre, short spikes knocked out (moving median, +-9 m),
wobble evened out (moving average, +-9 m), thinned to within EPS metres (Douglas-Peucker), bends rounded a little
(Chaikin corner cutting), then valves and LI-IV take-off points along it are slid onto the new line (they move at most a
few metres) and the run is cut back into its pipes at them. Junctions, pipe ends and the pump don't move.

Usage: python3 smooth_network.py [network.json] [eps_m] [rounds]
"""
import json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
K = math.cos(math.radians(38.12))


def xy(p): return (p[1] * 111320 * K, p[0] * 110574)


def ll(q): return [q[1] / 110574, q[0] / (111320 * K)]


def rdp(pts, eps):
    if len(pts) < 3: return pts
    a, b = xy(pts[0]), xy(pts[-1]); dx, dy = b[0] - a[0], b[1] - a[1]; L = math.hypot(dx, dy) or 1e-9
    best, idx = -1, 0
    for i in range(1, len(pts) - 1):
        p = xy(pts[i]); d = abs(dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / L
        if d > best: best, idx = d, i
    if best > eps: return rdp(pts[:idx + 1], eps)[:-1] + rdp(pts[idx:], eps)
    return [pts[0], pts[-1]]


def chaikin(pts, rounds, cut=0.2, max_m=2.5):
    """round the bends: cut each corner back by 20% of the segment, but never more than max_m metres"""
    for _ in range(rounds):
        if len(pts) < 3: return pts
        out = [pts[0]]
        for i in range(len(pts) - 1):
            p, q = pts[i], pts[i + 1]
            a, b = xy(p), xy(q); L = math.hypot(b[0] - a[0], b[1] - a[1]) or 1e-9
            c = min(cut, max_m / L)
            if i > 0: out.append([p[0] + (q[0] - p[0]) * c, p[1] + (q[1] - p[1]) * c])
            if i < len(pts) - 2: out.append([p[0] + (q[0] - p[0]) * (1 - c), p[1] + (q[1] - p[1]) * (1 - c)])
        out.append(pts[-1]); pts = out
    return pts


def smooth_line(pts, half_m=9.0, step=1.0):
    """resample every metre, knock out short spikes (moving median), then even out the wobble (moving average).
    Ends stay put: the window shrinks to nothing at each end."""
    P = [xy(q) for q in pts]
    out = [P[0]]
    for i in range(1, len(P)):
        a, b = P[i - 1], P[i]; L = math.hypot(b[0] - a[0], b[1] - a[1]); n = max(1, int(L / step))
        for k in range(1, n + 1): out.append((a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n))
    n = len(out); h = int(half_m / step)
    def filt(arr, f):
        res = []
        for i in range(n):
            w = min(h, i, n - 1 - i)
            res.append(f(arr[i - w:i + w + 1]))
        return res
    med = lambda a: sorted(a)[len(a) // 2]
    avg = lambda a: sum(a) / len(a)
    xs = filt(filt([q[0] for q in out], med), avg); ys = filt(filt([q[1] for q in out], med), avg)
    return [ll((x, y)) for x, y in zip(xs, ys)]


def project(line_xy, cum, P):
    """nearest point on the polyline to P: (distance along, point)"""
    best = None
    for i in range(len(line_xy) - 1):
        a, b = line_xy[i], line_xy[i + 1]; dx, dy = b[0] - a[0], b[1] - a[1]; L2 = dx * dx + dy * dy or 1e-12
        t = max(0, min(1, ((P[0] - a[0]) * dx + (P[1] - a[1]) * dy) / L2))
        q = (a[0] + t * dx, a[1] + t * dy); d = math.hypot(q[0] - P[0], q[1] - P[1])
        if best is None or d < best[0]: best = (d, cum[i] + t * math.sqrt(L2), q)
    return best[1], best[2]


def point_at(line_xy, cum, s):
    for i in range(len(line_xy) - 1):
        if cum[i + 1] >= s or i == len(line_xy) - 2:
            seg = cum[i + 1] - cum[i] or 1e-12; t = max(0, min(1, (s - cum[i]) / seg))
            a, b = line_xy[i], line_xy[i + 1]
            return (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])), i
    return line_xy[-1], len(line_xy) - 2


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "network.json")
    eps = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
    rounds = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    net = json.load(open(path))
    N = {n["id"]: n for n in net["nodes"]}
    mains = [p for p in net["pipes"] if not p.get("stub")]
    adj = {}
    for p in mains:
        adj.setdefault(p["a"], []).append(p); adj.setdefault(p["b"], []).append(p)
    through = lambda nid: len(adj.get(nid, [])) == 2 and N[nid]["k"] != "src"   # a valve or take-off in the middle of a run
    done = set(); before = after = moved = 0; maxmove = 0.0
    for p0 in mains:
        if p0["id"] in done: continue
        # walk both ways from p0 to the ends of its run
        def walk(pipe, frm):
            seq = []; cur = pipe; node = frm
            while True:
                nxt = cur["b"] if cur["a"] == node else cur["a"]
                seq.append((cur, node, nxt))
                if not through(nxt): break
                others = [q for q in adj[nxt] if q is not cur]
                if not others or others[0]["id"] in [s[0]["id"] for s in seq] or others[0] is pipe: break
                cur, node = others[0], nxt
            return seq
        fwd = walk(p0, p0["a"])
        back = walk(p0, p0["b"])[1:] if through(p0["a"]) else []
        run = [(c, b, a) for (c, a, b) in reversed(back)] + fwd   # list of (pipe, from, to) in order
        if any(c["id"] in done for c, _, _ in run): run = fwd
        for c, _, _ in run: done.add(c["id"])
        # the whole run as one line, remembering where its nodes sit
        line = [[N[run[0][1]]["lat"], N[run[0][1]]["lng"]]]
        for c, a, b in run:
            pts = c["pts"] if c["a"] == a else list(reversed(c["pts"]))
            line += pts + [[N[b]["lat"], N[b]["lng"]]]
        before += len(line)
        sm = chaikin(rdp(smooth_line(line), eps), rounds) if len(line) > 2 else line
        lx = [xy(q) for q in sm]; cum = [0.0]
        for i in range(1, len(lx)): cum.append(cum[-1] + math.hypot(lx[i][0] - lx[i - 1][0], lx[i][1] - lx[i - 1][1]))
        # slide the inside nodes onto the new line, in order
        inner = [b for _, _, b in run[:-1]]
        ss = []; last = 0.0
        for nid in inner:
            s, q = project(lx, cum, xy([N[nid]["lat"], N[nid]["lng"]]))
            s = max(s, last + 0.05); last = s; ss.append(s)
        cuts = [0.0] + ss + [cum[-1]]
        for k, nid in enumerate(inner):
            q, _ = point_at(lx, cum, ss[k]); old = xy([N[nid]["lat"], N[nid]["lng"]])
            mv = math.hypot(q[0] - old[0], q[1] - old[1]); maxmove = max(maxmove, mv); moved += mv > 0.05
            N[nid]["lat"], N[nid]["lng"] = [round(v, 7) for v in ll(q)]
        for k, (c, a, b) in enumerate(run):
            s0, s1 = cuts[k], cuts[k + 1]
            mid = [ll(lx[i]) for i in range(1, len(lx) - 1) if s0 + 0.05 < cum[i] < s1 - 0.05]
            mid = [[round(u, 7), round(v, 7)] for u, v in mid]
            c["pts"] = mid if c["a"] == a else list(reversed(mid))
            after += len(mid) + 1
    json.dump(net, open(path, "w"), separators=(",", ":"))
    print(f"{path}: {before} -> {after} points; {moved} valves/take-offs slid onto the line, furthest {maxmove:.1f} m "
          f"(straightened to {eps} m, {rounds} rounding passes)")


if __name__ == "__main__":
    main()
