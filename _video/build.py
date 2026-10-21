#!/usr/bin/env python3
"""Growth potential recap video for Greens Live (PACE Turf model).

Runs in GitHub Actions on every push of data.json (.github/workflows/gp-video.yml), so the clip on
the Greens Live "Today" page is rebuilt every time the dashboard updates. It can also run locally:

    python3 _video/build.py --repo .                 # full render -> videos/gp-recap.mp4 + videos.json
    python3 _video/build.py --repo . --preview DIR   # still frames only, for checking the layout

Steps: read data.json -> work out growth potential (GP) for the greens (cool season) and couch
(warm season) -> fetch a 7-day forecast (Open-Meteo, then MET Norway, then the dashboard's own
3-day hourly forecast) -> render _video/gp_recap.html frame by frame in headless Chromium ->
encode with ffmpeg -> write videos/gp-recap.mp4, videos/gp-recap.jpg and videos/videos.json.

GP model (PACE Turf; Gelernter and Stowell 2005): GP = exp(-0.5 * ((T - Topt) / var)^2), T = daily
mean air temperature. Cool season Topt 20 C, var 5.5. Warm season Topt 31 C, var 7. The greens
GP history comes straight from data.json (daily[].gp, already on this model); couch GP is worked
out here from the same daily mean temperatures.
"""
import argparse
import asyncio
import base64
import datetime as dt
import hashlib
import json
import math
import os
import subprocess
import sys
import urllib.request
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
TZ = ZoneInfo("Australia/Melbourne")
LAT, LON = -38.13, 145.28  # Ranfurlie, Cranbourne
COOL = (20.0, 5.5)
WARM = (31.0, 7.0)
UA = "ranfurlie-greens-gp-video/1.0 (+https://github.com/andranf/ranfurlie-greens)"
FPS = 30
HIST_DAYS = 30


def gp(t, model):
    opt, var = model
    return math.exp(-0.5 * ((t - opt) / var) ** 2)


def day_short(d):
    return f"{d:%a} {d.day} {d:%b}"


def day_long(d):
    return f"{d:%A} {d.day} {d:%B} {d:%Y}"


def join_days(names):
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " and " + names[-1]


def fnum(x):
    return f"{x:.1f}"


# ---------------------------------------------------------------- forecast sources
def _get_json(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def fc_open_meteo(today):
    url = ("https://api.open-meteo.com/v1/forecast?latitude=%s&longitude=%s"
           "&daily=temperature_2m_max,temperature_2m_min&timezone=Australia%%2FMelbourne&forecast_days=8") % (LAT, LON)
    j = _get_json(url)
    if j.get("error"):
        raise RuntimeError(j.get("reason", "open-meteo error"))
    dd = j["daily"]
    out = []
    for ds, hi, lo in zip(dd["time"], dd["temperature_2m_max"], dd["temperature_2m_min"]):
        d = dt.date.fromisoformat(ds)
        if d < today or hi is None or lo is None:
            continue
        out.append((d, float(hi), float(lo)))
    return out[:7], "Open-Meteo"


def fc_met_norway(today):
    j = _get_json("https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=%.2f&lon=%.2f" % (LAT, LON))
    per = {}
    for ts in j["properties"]["timeseries"]:
        t = dt.datetime.fromisoformat(ts["time"].replace("Z", "+00:00")).astimezone(TZ)
        dat = ts["data"]
        vals = []
        inst = dat.get("instant", {}).get("details", {})
        if "air_temperature" in inst:
            vals.append(inst["air_temperature"])
        n6 = dat.get("next_6_hours", {}).get("details", {})
        for k in ("air_temperature_max", "air_temperature_min"):
            if k in n6:
                vals.append(n6[k])
        if vals:
            p = per.setdefault(t.date(), {"v": [], "hours": set()})
            p["v"].extend(vals)
            p["hours"].add(t.hour)
    out = []
    for d in sorted(per):
        # whole days only: today is part-gone, and the last day is usually cut short
        if d <= today or len(per[d]["hours"]) < 4:
            continue
        hrs = per[d]["hours"]
        if min(hrs) > 6 or max(hrs) < 17:
            continue
        out.append((d, max(per[d]["v"]), min(per[d]["v"])))
    return out[:7], "MET Norway"


def fc_dashboard(today, data):
    per = {}
    for r in data.get("spray_window") or []:
        if r.get("temp_c") is None:
            continue
        d = dt.date.fromisoformat(r["date"])
        per.setdefault(d, []).append(float(r["temp_c"]))
    out = [(d, max(v), min(v)) for d, v in sorted(per.items()) if d >= today and len(v) >= 20]
    return out[:7], "dashboard hourly forecast"


def get_forecast(today, data, offline=None):
    if offline:
        rows = json.load(open(offline))
        return [(dt.date.fromisoformat(r[0]), r[1], r[2]) for r in rows["days"]], rows.get("source", "test")
    errors = []
    for fn in (fc_open_meteo, fc_met_norway):
        for attempt in range(2):
            try:
                rows, src = fn(today)
                if len(rows) >= 3:
                    return rows, src
                errors.append(f"{fn.__name__}: only {len(rows)} days")
                break
            except Exception as e:  # network, rate limit, format change
                errors.append(f"{fn.__name__}: {e}")
    rows, src = fc_dashboard(today, data)
    if errors:
        print("forecast fallbacks:", "; ".join(errors), file=sys.stderr)
    return rows, src


# ---------------------------------------------------------------- payload
def build_payload(data, now, offline_fc=None):
    today = now.date()
    daily = [r for r in data.get("daily", []) if r.get("tmean") is not None]
    if len(daily) < 7:
        raise SystemExit("data.json has fewer than 7 days of daily mean temperatures; nothing to build")
    daily.sort(key=lambda r: r["date"])
    for r in daily:
        r["_c"] = r["gp"] if r.get("gp") is not None else gp(r["tmean"], COOL)
        r["_w"] = gp(r["tmean"], WARM)

    last = daily[-1]
    asof = dt.date.fromisoformat(last["date"])
    hist_rows = daily[-HIST_DAYS:]
    hist = [{"d": r["date"], "lab": f"{dt.date.fromisoformat(r['date']).day} {dt.date.fromisoformat(r['date']):%b}",
             "t": round(r["tmean"], 1), "c": round(r["_c"], 4), "w": round(r["_w"], 4)} for r in hist_rows]

    def mean(xs):
        xs = [x for x in xs if x is not None]
        return sum(xs) / len(xs) if xs else None

    last14, prev14 = daily[-14:], daily[-28:-14]
    cool14 = last.get("gp14") if last.get("gp14") is not None else mean([r["_c"] for r in last14])
    by_date = {r["date"]: r for r in daily}
    prev_row = by_date.get((asof - dt.timedelta(days=14)).isoformat())
    cool14_prev = (prev_row.get("gp14") if prev_row and prev_row.get("gp14") is not None
                   else (mean([r["_c"] for r in prev14]) if len(prev14) >= 10 else None))
    warm14 = mean([r["_w"] for r in last14])
    warm14_prev = mean([r["_w"] for r in prev14]) if len(prev14) >= 10 else None
    t14, t14_prev = mean([r["tmean"] for r in last14]), (mean([r["tmean"] for r in prev14]) if len(prev14) >= 10 else None)

    stats = {"cool14": cool14, "cool14_prev": cool14_prev, "warm14": warm14, "warm14_prev": warm14_prev,
             "clip14": last.get("clip_per_day_14d"), "gvx21": last.get("gvx21")}

    # headline for the last 30 days
    d14 = (cool14 - cool14_prev) if cool14_prev is not None else 0
    # kept to one line on screen (about 40 characters)
    if d14 >= 0.08:
        headline_hist = "Greens GP has <em>climbed</em> with the warmth" if (t14_prev is None or t14 >= t14_prev) else "Greens GP has <em>climbed</em>"
    elif d14 <= -0.08:
        headline_hist = "Heat has <em>eased</em> greens GP" if t14 > COOL[0] else "Cooler days have <em>pulled</em> GP back"
    else:
        headline_hist = "Greens GP is <em>holding</em> steady"

    # forecast
    rows, source = get_forecast(today, data, offline_fc)
    fdays = []
    for d, hi, lo in rows:
        tm = (hi + lo) / 2
        c, w = gp(tm, COOL), gp(tm, WARM)
        fdays.append({"d": d.isoformat(), "dow": f"{d:%a}", "lab": f"{d.day} {d:%b}", "tmax": round(hi, 1), "tmin": round(lo, 1),
                      "t": round(tm, 1), "c": round(c, 4), "w": round(w, 4), "hot": bool(c < 0.6 and tm > COOL[0])})

    # crossover: the mean temperature above which couch GP is higher than bent/Poa GP
    cross = (WARM[1] * COOL[0] + COOL[1] * WARM[0]) / (WARM[1] + COOL[1])

    take = []
    if fdays:
        fc_c = mean([d["c"] for d in fdays])
        fc_w = mean([d["w"] for d in fdays])
        fc_t = mean([d["t"] for d in fdays])
        hot = [d for d in fdays if d["hot"]]
        worst = min(fdays, key=lambda d: d["c"])
        best_w = max(fdays, key=lambda d: d["w"])
        hot_names = [d["dow"] for d in hot]
        split = split_week(fdays)
        if hot:
            headline_fc = ("Heat on <em>%s</em> pulls greens growth back" % join_days(hot_names)) if len(hot) <= 3 else "Heat through the week <em>holds</em> greens growth back"
            take.append({"tone": "hot", "head": "Greens: heat on %s" % join_days(hot_names) if len(hot) <= 3 else "Greens: a hot week",
                         "detail": "Bent and Poa GP drops to %d%% on %s (%s °C mean). The week averages %d%%." % (round(worst["c"] * 100), worst["dow"], fnum(worst["t"]), round(fc_c * 100))})
        elif split:
            k, a1, a2 = split
            s1, s2 = fdays[:k], fdays[k:]
            r1 = s1[0]["dow"] if len(s1) == 1 else "%s to %s" % (s1[0]["dow"], s1[-1]["dow"])
            t1, t2 = mean([d["t"] for d in s1]), mean([d["t"] for d in s2])
            if a2 < a1:  # growth falls away
                if t2 < t1:
                    headline_fc = "Strong growth to %s, then a <em>cold change</em>" % s1[-1]["dow"] if a1 >= 0.7 else "A <em>cold change</em> from %s" % s2[0]["dow"]
                    why = "once the cold change arrives %s" % s2[0]["dow"]
                else:
                    headline_fc = "Heat from %s <em>pulls</em> greens growth back" % s2[0]["dow"]
                    why = "in the heat from %s" % s2[0]["dow"]
                take.append({"tone": "cool", "head": "Greens: %s to %s, %s from %s" % ("strong" if a1 >= 0.7 else "fair", s1[-1]["dow"], "slow" if a2 < 0.5 else "easing", s2[0]["dow"]),
                             "detail": "Bent and Poa GP averages %d%% %s, then %d%% %s." % (round(a1 * 100), r1, round(a2 * 100), why)})
            else:  # growth picks up
                if t2 > t1:
                    headline_fc = "Slow start, then <em>warming</em> from %s" % s2[0]["dow"]
                else:
                    headline_fc = "Heat <em>eases</em> from %s" % s2[0]["dow"]
                take.append({"tone": "cool", "head": "Greens: slow to %s, picking up from %s" % (s1[-1]["dow"], s2[0]["dow"]),
                             "detail": "Bent and Poa GP averages %d%% %s, then %d%% from %s." % (round(a1 * 100), r1, round(a2 * 100), s2[0]["dow"])})
        elif fc_c >= 0.8:
            headline_fc = "Close to <em>ideal</em> growing weather for the greens"
            take.append({"tone": "cool", "head": "Greens: near peak growth",
                         "detail": "Bent and Poa GP averages %d%% this week. Expect strong clip yields and quick recovery." % round(fc_c * 100)})
        elif fc_c >= 0.5:
            headline_fc = "A <em>solid</em> growing week for the greens"
            take.append({"tone": "cool", "head": "Greens: growing well",
                         "detail": "Bent and Poa GP averages %d%% this week, %s the 20 °C optimum." % (round(fc_c * 100), "cooler than" if fc_t < COOL[0] else "warmer than")})
        else:
            headline_fc = "A <em>cool</em> week: slow growth on the greens" if fc_t < COOL[0] else "Heat <em>holds</em> greens growth back"
            take.append({"tone": "cool" if fc_t < COOL[0] else "hot", "head": "Greens: slow growth",
                         "detail": "Bent and Poa GP averages %d%% this week. Recovery from wear and cultivation will be slow." % round(fc_c * 100)})
        if fc_w < 0.25:
            take.append({"tone": "warm", "head": "Couch: still slow",
                         "detail": "Warm-season GP averages %d%%, best on %s at %d%%. Couch recovers best once GP holds above 50%%." % (round(fc_w * 100), best_w["dow"], round(best_w["w"] * 100))})
        elif fc_w < 0.5:
            take.append({"tone": "warm", "head": "Couch: waking up",
                         "detail": "Warm-season GP averages %d%%, best on %s at %d%%. Couch recovers best once GP holds above 50%%." % (round(fc_w * 100), best_w["dow"], round(best_w["w"] * 100))})
        else:
            take.append({"tone": "warm", "head": "Couch: actively growing",
                         "detail": "Warm-season GP averages %d%%. Good conditions for recovery from wear and cultivation." % round(fc_w * 100)})
        over = [d for d in fdays if d["t"] > cross]
        if over:
            names = join_days([d["dow"] for d in over]) if len(over) <= 3 else "%d days this week" % len(over)
            hottest = max(over, key=lambda d: d["t"])
            take.append({"tone": "neutral", "head": "Couch overtakes the greens on %s" % names,
                         "detail": "Above a %s °C mean, warm-season GP passes cool-season GP. %s is forecast at %s °C." % (fnum(cross), hottest["dow"], fnum(hottest["t"]))})
        else:
            take.append({"tone": "neutral", "head": "Couch only overtakes the greens above %s °C" % fnum(cross),
                         "detail": "That is where warm-season GP passes cool-season GP. No day this week gets there."})
        fc_band = [min(d["t"] for d in fdays), max(d["t"] for d in fdays)]
    else:
        headline_fc, fc_band = "", None

    payload = {
        "build_label": "week of " + f"{today.day} {today:%B} {today:%Y}",
        "built": now.strftime("%Y-%m-%dT%H:%M%z"),
        "asof": asof.isoformat(), "asof_label": day_short(asof), "asof_long": day_long(asof),
        "latest": {"t": round(last["tmean"], 1), "cool": round(last["_c"], 4), "warm": round(last["_w"], 4), "label": day_short(asof)},
        "model": {"cool_opt": COOL[0], "cool_var": COOL[1], "warm_opt": WARM[0], "warm_var": WARM[1], "crossover": round(cross, 2)},
        "hist": hist, "stats": stats, "headline_hist": headline_hist,
        "forecast": {"source": source, "days": fdays}, "fc_band": fc_band, "headline_fc": headline_fc,
        "takeaways": take,
    }
    return payload


def split_week(days, min_gap=0.3):
    """Find the day where greens GP steps up or down for the rest of the week (a cold change or heat).
    Returns (index, mean before, mean after) when the step is at least min_gap, else None."""
    vals, n = [d["c"] for d in days], len(days)
    best, best_ss = None, -1
    for k in range(2, n - 1):
        a, b = sum(vals[:k]) / k, sum(vals[k:]) / (n - k)
        ss = k * (n - k) / n * (a - b) ** 2  # between-group sum of squares: the cleanest step
        if ss > best_ss:
            best, best_ss = (k, a, b), ss
    return best if best and abs(best[2] - best[1]) >= min_gap else None


def payload_hash(p):
    q = {k: v for k, v in p.items() if k not in ("built",)}
    return hashlib.sha256(json.dumps(q, sort_keys=True).encode()).hexdigest()[:16]


# ---------------------------------------------------------------- render
def ffmpeg_exe():
    try:
        import imageio_ffmpeg  # bundled static ffmpeg with libx264 (used in GitHub Actions)
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


async def render(payload, out_mp4=None, poster=None, preview_dir=None, preview_times=None, max_seconds=None, crf=23, grain="static"):
    from playwright.async_api import async_playwright
    html = "file://" + os.path.join(HERE, "gp_recap.html")
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=["--force-color-profile=srgb", "--hide-scrollbars", "--disable-lcd-text"])
        page = await browser.new_page(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.goto(html)
        await page.evaluate("document.fonts.ready.then(() => true)")
        total = await page.evaluate("(d) => window.__setup(d)", payload)
        await page.evaluate("(g) => { window.__grain = g; }", grain)
        await page.evaluate("document.fonts.ready.then(() => true)")
        marks = await page.evaluate("window.__marks()")
        if errs:
            raise RuntimeError("page error: " + "; ".join(errs))
        cdp = await page.context.new_cdp_session(page)

        async def shot(t, fmt="jpeg", q=92):
            await page.evaluate("(t) => window.__render(t)", t)
            r = await cdp.send("Page.captureScreenshot", {"format": fmt, "quality": q, "optimizeForSpeed": True} if fmt == "jpeg" else {"format": fmt})
            return base64.b64decode(r["data"])

        if preview_dir:
            os.makedirs(preview_dir, exist_ok=True)
            times = preview_times or [m["start"] + m["dur"] * f for m in marks for f in (0.35, 0.92)]
            for i, t in enumerate(times):
                with open(os.path.join(preview_dir, "f%02d_%05.2f.png" % (i, t)), "wb") as f:
                    f.write(await shot(t, "png"))
            print(json.dumps({"total": total, "marks": marks}))
        if out_mp4:
            n = int(math.ceil((max_seconds or total) * FPS)) + 1
            cmd = [ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(FPS), "-c:v", "mjpeg", "-i", "-",
                   "-c:v", "libx264", "-preset", "slow", "-crf", str(crf), "-tune", "animation", "-pix_fmt", "yuv420p",
                   "-r", str(FPS), "-movflags", "+faststart", out_mp4]
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
            for i in range(n):
                proc.stdin.write(await shot(min(i / FPS, total)))
            proc.stdin.close()
            if proc.wait() != 0:
                raise RuntimeError("ffmpeg failed")
            if errs:
                raise RuntimeError("page error during render: " + "; ".join(errs))
        if poster:
            today = next((m for m in marks if m["id"] == "today"), marks[0])
            with open(poster, "wb") as f:
                f.write(await shot(today["start"] + today["dur"] - 1.2, "jpeg", 84))
        await browser.close()
        return total


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=os.path.dirname(HERE))
    ap.add_argument("--preview", help="write still frames to this folder instead of a video")
    ap.add_argument("--forecast-file", help="offline forecast JSON for testing: {source, days: [[date, max, min], ...]}")
    ap.add_argument("--force", action="store_true", help="render even if nothing has changed")
    ap.add_argument("--now", help="pretend it is this Melbourne time (YYYY-MM-DDTHH:MM), for testing")
    ap.add_argument("--test-clip", help="render only the first N seconds to this file (encoding tests)")
    ap.add_argument("--crf", type=int, default=25)
    ap.add_argument("--grain", default="static", choices=["static", "moving", "off"])
    a = ap.parse_args()

    repo = os.path.abspath(a.repo)
    data = json.load(open(os.path.join(repo, "data.json")))
    now = dt.datetime.fromisoformat(a.now).replace(tzinfo=TZ) if a.now else dt.datetime.now(TZ)
    payload = build_payload(data, now, a.forecast_file)
    h = payload_hash(payload)

    if a.test_clip:
        path, secs = a.test_clip.split(":")
        asyncio.run(render(payload, out_mp4=path, max_seconds=float(secs), crf=a.crf, grain=a.grain))
        print(path, os.path.getsize(path))
        return
    if a.preview:
        asyncio.run(render(payload, preview_dir=a.preview))
        json.dump(payload, open(os.path.join(a.preview, "payload.json"), "w"), indent=1)
        return

    vdir = os.path.join(repo, "videos")
    os.makedirs(vdir, exist_ok=True)
    mp4, jpg, vjson = os.path.join(vdir, "gp-recap.mp4"), os.path.join(vdir, "gp-recap.jpg"), os.path.join(vdir, "videos.json")
    try:
        cur = json.load(open(vjson))
    except Exception:
        cur = []
    if (not a.force and os.path.exists(mp4) and len(cur) == 1 and cur[0].get("kind") == "gp-recap"
            and cur[0].get("inputs") == h):
        print("Growth potential video already up to date (inputs %s)." % h)
        return

    total = asyncio.run(render(payload, out_mp4=mp4 + ".tmp.mp4", poster=jpg, crf=a.crf, grain=a.grain))
    os.replace(mp4 + ".tmp.mp4", mp4)
    stamp = now.strftime("%Y%m%d%H%M")
    entry = {
        "file": "videos/gp-recap.mp4?v=" + stamp,
        "poster": "videos/gp-recap.jpg?v=" + stamp,
        "title": "Growth potential",
        "date": payload["asof"],
        "caption": ("PACE Turf growth potential for the greens (bent and Poa) and couch: the latest day, the last %d days "
                    "and the next %d. Rebuilt automatically every time this dashboard updates. Forecast: %s.")
                   % (len(payload["hist"]), len(payload["forecast"]["days"]), payload["forecast"]["source"]),
        "kind": "gp-recap",
        "built": payload["built"],
        "seconds": round(total, 1),
        "inputs": h,
    }
    json.dump([entry], open(vjson, "w"), indent=1, ensure_ascii=False)
    json.dump(payload, open(os.path.join(vdir, "gp-recap.json"), "w"), indent=1, ensure_ascii=False)
    print("Rendered %s (%.1f s, %.1f MB), data to %s, forecast from %s."
          % (mp4, total, os.path.getsize(mp4) / 1e6, payload["asof"], payload["forecast"]["source"]))


if __name__ == "__main__":
    main()
