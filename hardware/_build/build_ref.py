#!/usr/bin/env python3
"""Build hardware/ref.json (reference layers for the hardware map) from cirrus_ref.txt.

cirrus_ref.txt is a compact extract taken from CirrusPRO (site 2) on 24 Oct 2026:
  S|  station GPS positions        name:dlat,dlng
  P|  as-built plan points         code:dlat,dlng   (imported KMZ layers "Irrigation" and "Drainage")
  L|  plan lines                   code:p/p/...     (IL irrigation lines, BL other buried lines)
  A|  drainage plan areas          code:p/p/...
Offsets are in millionths of a degree from LAT0/LNG0 (south and east are positive).

Re-run after re-extracting from CirrusPRO:  python3 hardware/_build/build_ref.py
"""
import json, os, re, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "cirrus_ref.txt")
OUT = os.path.join(HERE, "..", "ref.json")
LAT0, LNG0 = -38.11, 145.237

# stations CirrusPRO holds with no GPS position (24 Oct 2026), so they can't be drawn
NO_GPS = ["9M4", "9M5", "14P3", "4G6", "4A1", "9P2", "19C2", "9M1", "1M1", "9M3", "13T3", "13T4", "10F14",
          "19S5_1", "19S6_1", "4P3", "11P2", "7P1", "7T2", "1P3", "14P2", "9P3", "19S10", "19S11", "19S12", "7R1"]


def dec(s):
    a, b = s.split(",")
    return [round(LAT0 - int(a) / 1e6, 6), round(LNG0 + int(b) / 1e6, 6)]


def plan_type(code):
    if code.startswith("LI-IV"): return "iv"
    for p, t in (("SV", "sv"), ("MV", "mv"), ("DP", "dp"), ("DO", "do"), ("IL", "il"), ("BL", "bl"), ("DA", "da")):
        if code.startswith(p): return t
    return "other"


def natkey(s):
    return [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", s)]


def main():
    sec = {}
    for line in open(SRC).read().split("\n"):
        k, v = line.split("|", 1)
        sec[k] = v
    heads = []
    for tok in sec["S"].split():
        n, c = tok.split(":")
        heads.append([n] + dec(c))
    heads.sort(key=lambda r: natkey(r[0]))
    plan = []
    for tok in sec["P"].split():
        n, c = tok.split(":")
        plan.append([n, plan_type(n)] + dec(c))
    plan.sort(key=lambda r: (r[1], natkey(r[0])))
    lines = []
    for tok in sec["L"].split():
        n, c = tok.split(":")
        lines.append([n, plan_type(n), [dec(x) for x in c.split("/")]])
    lines.sort(key=lambda r: (r[1], natkey(r[0])))
    areas = []
    for tok in sec["A"].split():
        n, c = tok.split(":")
        areas.append([n, [dec(x) for x in c.split("/")]])
    areas.sort(key=lambda r: natkey(r[0]))
    out = {
        "v": 1,
        "generated": datetime.date.today().isoformat(),
        "source": "CirrusPRO site 2: station positions, and the imported Irrigation and Drainage layers (as-built plan positions)",
        "heads": heads,
        "noGps": sorted(NO_GPS, key=natkey),
        "plan": plan,
        "lines": lines,
        "areas": areas,
    }
    s = json.dumps(out, separators=(",", ":"))
    open(OUT, "w").write(s)
    print(f"ref.json: {len(heads)} heads, {len(plan)} plan points, {len(lines)} lines, {len(areas)} areas, {len(s)/1024:.1f} KB")


if __name__ == "__main__":
    main()
