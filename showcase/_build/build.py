#!/usr/bin/env python3
"""Builds showcase/index.html from the live dashboard data in this repo.

Run from anywhere:  python3 showcase/_build/build.py
Reads ../../data.json, ../../irrigation|drainage|bunkers/data.json and the 3D scene
embedded in irrigation/index.html, then fills template.html.
"""
import json, math, os, re, html
from datetime import date, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'showcase', 'index.html')

D = json.load(open(os.path.join(ROOT, 'data.json')))
IRR = json.load(open(os.path.join(ROOT, 'irrigation', 'data.json')))
DRN = json.load(open(os.path.join(ROOT, 'drainage', 'data.json')))
BNK = json.load(open(os.path.join(ROOT, 'bunkers', 'data.json')))
_s = open(os.path.join(ROOT, 'irrigation', 'index.html')).read()
_i = _s.index('const SCENE = ') + len('const SCENE = ')
SCENE, _ = json.JSONDecoder().raw_decode(_s[_i:])

YMAX = 681.0  # data frame is x east / y north; flip so north is up on screen


def fy(p):
    return (p[0], YMAX - p[1])


def pts(ring):
    return ' '.join(f'{x:.1f},{y:.1f}' for x, y in (fy(p) for p in ring))


def f1(v):
    return f'{v:.1f}'.rstrip('0').rstrip('.') if isinstance(v, float) else str(v)


# ---------------------------------------------------------------- moisture ramp
RAMP = [(8, (199, 115, 31)), (12, (224, 174, 69)), (16, (214, 216, 160)),
        (20, (127, 184, 216)), (25, (44, 120, 190)), (30, (27, 79, 143))]


def ramp(v):
    if v is None:
        return '#c9d3cb'
    if v <= RAMP[0][0]:
        c = RAMP[0][1]
    elif v >= RAMP[-1][0]:
        c = RAMP[-1][1]
    else:
        for (a, ca), (b, cb) in zip(RAMP, RAMP[1:]):
            if a <= v <= b:
                t = (v - a) / (b - a)
                c = tuple(round(ca[i] + (cb[i] - ca[i]) * t) for i in range(3))
                break
    return '#%02x%02x%02x' % c


# ---------------------------------------------------------------- latest TurfRad
tr_dates = sorted({t['date'] for t in D['turfrad']})
TR_DATE = tr_dates[-1]
green_moist = {t['green']: t['moist_mean'] for t in D['turfrad'] if t['date'] == TR_DATE}
fw_dates = sorted({t['date'] for t in D['turfrad_fw']})
fw_moist = {t['hole']: t['moist_mean'] for t in D['turfrad_fw'] if t['date'] == fw_dates[-1]}


def centroid(ring):
    xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def seg_dist(p, a, b):
    ax, ay = a; bx, by = b; px, py = p
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy or 1
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def nearest_hole(c):
    best = None
    for h, v in IRR['holes'].items():
        d = seg_dist(c, v['t'], v['g'])
        if best is None or d < best[0]:
            best = (d, h)
    return best[1]


# ---------------------------------------------------------------- isometric hero
TH = math.radians(-22)
K = 0.6
A, B, C_, Dm = math.cos(TH), K * math.sin(TH), -math.sin(TH), K * math.cos(TH)


def proj(x, y):  # x,y already flipped
    return A * x + C_ * y, B * x + Dm * y


MAT = f'matrix({A:.5f} {B:.5f} {C_:.5f} {Dm:.5f} 0 0)'
bound = SCENE['bound']
bproj = [proj(*fy(p)) for p in bound]
bx0 = min(p[0] for p in bproj); bx1 = max(p[0] for p in bproj)
by0 = min(p[1] for p in bproj); by1 = max(p[1] for p in bproj)
GAP = 205
LAYERS = 4
# right-most point of the sheet, used as the label anchor
anchor = max(bproj, key=lambda p: p[0] - 0.25 * p[1])
LABEL_X = bx1 + 46


def sheet(fill, opacity, stroke='#13304A', sop=0.35, dash=''):
    da = f' stroke-dasharray="{dash}"' if dash else ''
    return (f'<polygon points="{pts(bound)}" fill="{fill}" fill-opacity="{opacity}" stroke="{stroke}" '
            f'stroke-opacity="{sop}" stroke-width="1.2" vector-effect="non-scaling-stroke"{da}/>')


def hero_svg():
    """The hero as stacked, separately composited SVG layers.

    Each layer is its own <svg> with the same viewBox, positioned over the others, so the
    page can float and separate them with GPU transforms without re-drawing the map.
    Moving parts (TurfRad scan sweep, water in the drainage pipes, job pins) live in small
    overlay SVGs that travel with their layer.
    """
    cm = D['course_map']
    by = lambda L: [c for c in cm if c['layer'] == L]
    vb_x = bx0 - 30
    vb_y = by0 - GAP * (LAYERS - 1) - 40
    vb_w = (LABEL_X + 300) - vb_x
    vb_h = (by1 + 30) - vb_y
    vbm_w = (bx1 + 30) - vb_x
    VB = f'{vb_x:.0f} {vb_y:.0f} {vb_w:.0f} {vb_h:.0f}'
    VBM = f'{vb_x:.0f} {vb_y:.0f} {vbm_w:.0f} {vb_h:.0f}'
    pct = lambda i: -GAP * i / vb_h * 100

    def svg(cls, i, body, defs=''):
        return (f'<svg class="sl {cls}" style="--dz:{pct(i):.3f}%;--i:{i}" viewBox="{VB}" '
                f'preserveAspectRatio="xMidYMid meet" aria-hidden="true">{defs}{body}</svg>')

    def shadow(i):
        if not i:
            return ''
        return (f'<g transform="translate(0 16)"><g transform="{MAT}"><polygon points="{pts(bound)}" fill="#13304A" '
                f'fill-opacity=".16" filter="url(#soft{i})"/></g></g>')

    def soft(i):
        return (f'<defs><filter id="soft{i}" x="-10%" y="-10%" width="120%" height="130%">'
                f'<feGaussianBlur stdDeviation="9"/></filter></defs>') if i else ''

    def label(i, a, b):
        ax, ay = anchor
        ly = ay - 6
        return (f'<g class="lbl"><path d="M{ax+6:.1f} {ay:.1f} L{LABEL_X-12:.1f} {ly:.1f}" class="lead"/>'
                f'<circle cx="{ax:.1f}" cy="{ay:.1f}" r="3.5" class="leaddot"/>'
                f'<text x="{LABEL_X:.1f}" y="{ly-6:.1f}" class="lt">{html.escape(a)}</text>'
                f'<text x="{LABEL_X:.1f}" y="{ly+20:.1f}" class="ls">{html.escape(b)}</text></g>')

    layers = []

    # L0 the course
    inner = [sheet('#F7F9F5', 1, sop=.5)]
    for w in SCENE['water']:
        inner.append(f'<polygon points="{pts(w["ring"])}" fill="#9CC7DE"/>')
    for t in SCENE['trees']:
        if t[2] < 3.2:
            continue
        x, y = fy(t)
        inner.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{t[2]*.7:.1f}" fill="#7FA486" fill-opacity=".3"/>')
    colors = {'fairway': '#B5D3A8', 'approach': '#97C08E', 'tee': '#6FA675', 'green': '#2E6A46', 'bunker': '#E9D7A8'}
    for L in ('fairway', 'approach', 'tee', 'green', 'bunker'):
        for c in by(L):
            inner.append(f'<polygon points="{pts(c["pts"])}" fill="{colors[L]}"/>')
    layers.append(svg('l0', 0, f'<g transform="{MAT}">{"".join(inner)}</g>' +
                      label(0, 'The course', 'Every green, tee, fairway and bunker')))

    # L1 moisture
    inner = [sheet('#FBFCFA', .88)]
    for L in ('approach', 'tee'):
        for c in by(L):
            inner.append(f'<polygon points="{pts(c["pts"])}" fill="#13304A" fill-opacity=".07"/>')
    for c in by('bunker'):
        inner.append(f'<polygon points="{pts(c["pts"])}" fill="#13304A" fill-opacity=".06"/>')
    for c in by('fairway'):
        h = nearest_hole(centroid(c['pts']))
        inner.append(f'<polygon points="{pts(c["pts"])}" fill="{ramp(fw_moist.get(h))}" fill-opacity=".9"/>')
    for c in by('green'):
        v = green_moist.get(c['hole'])
        inner.append(f'<polygon points="{pts(c["pts"])}" fill="{ramp(v)}" stroke="#13304A" stroke-opacity=".5" '
                     f'stroke-width="1" vector-effect="non-scaling-stroke"/>')
    dt = datetime.strptime(TR_DATE, '%Y-%m-%d')
    layers.append(svg('l1', 1, shadow(1) + f'<g transform="{MAT}">{"".join(inner)}</g>' +
                      label(1, 'How wet it is', f'TurfRad scan, {dt.day} {dt:%b}'), soft(1)))
    # the radar sweep, clipped to the sheet, travelling with layer 1
    fx0 = min(fy(p)[0] for p in bound) - 60; fx1 = max(fy(p)[0] for p in bound) + 60
    fy0 = min(fy(p)[1] for p in bound) - 40; fy1 = max(fy(p)[1] for p in bound) + 40
    scan = (f'<defs><clipPath id="sheetclip"><polygon points="{pts(bound)}"/></clipPath>'
            f'<linearGradient id="scang" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#69C3EE" stop-opacity="0"/>'
            f'<stop offset=".82" stop-color="#69C3EE" stop-opacity=".38"/><stop offset=".97" stop-color="#ffffff" stop-opacity=".95"/>'
            f'<stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient></defs>'
            f'<g transform="{MAT}"><g clip-path="url(#sheetclip)"><rect class="sweepband" x="{fx0-120:.0f}" y="{fy0:.0f}" '
            f'width="120" height="{fy1-fy0:.0f}" fill="url(#scang)" style="--travel:{fx1-fx0+120:.0f}px"/></g></g>')
    layers.append(svg('l1 fx scan', 1, scan))

    # L2 underground
    net = DRN['net']
    inner = [sheet('#FBFCFA', .84, dash='6 5')]
    for w in SCENE['water']:
        inner.append(f'<polygon points="{pts(w["ring"])}" fill="none" stroke="#1C74C4" stroke-opacity=".5" '
                     f'stroke-width="1" vector-effect="non-scaling-stroke"/>')
    for c in by('green') + by('fairway'):
        inner.append(f'<polygon points="{pts(c["pts"])}" fill="none" stroke="#13304A" stroke-opacity=".18" '
                     f'stroke-width="1" vector-effect="non-scaling-stroke"/>')
    for a in net['ag']:
        for ln in a['lines']:
            inner.append(f'<polyline points="{pts(ln)}" fill="none" stroke="#2B7A78" stroke-width="1" '
                         f'stroke-opacity=".8" vector-effect="non-scaling-stroke"/>')
    for p in net['pipes']:
        inner.append(f'<polyline points="{pts(p["pts"])}" fill="none" stroke="#13304A" stroke-width="2.4" '
                     f'vector-effect="non-scaling-stroke"/>')
    extra = []
    for p in net['pits'] + net['outfalls']:
        sx, sy = proj(*fy((p['x'], p['y'])))
        extra.append(f'<rect x="{sx-3:.1f}" y="{sy-3:.1f}" width="6" height="6" fill="#13304A"/>')
    layers.append(svg('l2', 2, shadow(2) + f'<g transform="{MAT}">{"".join(inner)}</g>' + ''.join(extra) +
                      label(2, "What's underground", 'Drainage plans, hole by hole'), soft(2)))
    flow = ''.join(f'<polyline class="water" style="--k:{k%5}" points="{pts(p["pts"])}"/>' for k, p in enumerate(net['pipes']))
    layers.append(svg('l2 fx flow', 2, f'<g transform="{MAT}">{flow}</g>'))

    # L3 jobs
    inner = [sheet('#FBFCFA', .74, dash='2 6')]
    for c in by('fairway') + by('green'):
        inner.append(f'<polygon points="{pts(c["pts"])}" fill="#2E6A46" fill-opacity=".09"/>')
    layers.append(svg('l3', 3, shadow(3) + f'<g transform="{MAT}">{"".join(inner)}</g>' +
                      label(3, 'Jobs the crew reported', 'Posts and photos in Slack'), soft(3)))
    pins = ([('irr', p) for p in IRR['pins'] if p.get('live')] +
            [('drn', p) for p in DRN['pins'] if p.get('live')] +
            [('bnk', p) for p in BNK['pins'] if p.get('live')])
    seen = set(); pg = []; n = 0
    for k, (kind, p) in enumerate(pins):
        sx, sy = proj(*fy((p['x'], p['y'])))
        key = (kind, round(sx / 4), round(sy / 4))
        if key in seen:
            continue
        seen.add(key)
        pulse = ' pulse' if n % 4 == 0 else ''
        pg.append(f'<g class="pin {kind}{pulse}" style="--n:{n};--d:{(n % 7) * .45:.2f}s">'
                  f'<line x1="{sx:.1f}" y1="{sy:.1f}" x2="{sx:.1f}" y2="{sy-16:.1f}"/>'
                  f'<circle class="ring" cx="{sx:.1f}" cy="{sy-16:.1f}" r="5"/>'
                  f'<circle class="head" cx="{sx:.1f}" cy="{sy-16:.1f}" r="5"/></g>')
        n += 1
    layers.append(svg('l3 fx pins', 3, ''.join(pg)))

    out = (f'<div class="stack" id="stack" role="img" aria-label="Ranfurlie Golf Club in four layers: the course map, '
           f'the latest moisture scan, the drainage plans and the open jobs from Slack, stacked over the same ground." '
           f'data-vb="{VB}" data-vbm="{VBM}" style="--ar:{vb_w:.0f}/{vb_h:.0f};--arm:{vbm_w:.0f}/{vb_h:.0f}">'
           + ''.join(layers) + '</div>')
    counts = {'irr': sum(1 for p in IRR['pins'] if p.get('live')),
              'drn': sum(1 for p in DRN['pins'] if p.get('live')),
              'bnk': sum(1 for p in BNK['pins'] if p.get('live'))}
    return out, counts


# ---------------------------------------------------------------- one green, close up
def green_poly(hole):
    g = [c for c in D['course_map'] if c['layer'] == 'green' and c['hole'] == hole][0]
    return [fy(p) for p in g['pts']]


def perimeter_points(ring, n, start=0.0):
    segs = list(zip(ring, ring[1:] + ring[:1]))
    lens = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in segs]
    tot = sum(lens)
    outp = []
    for i in range(n):
        target = ((start + i / n) % 1) * tot
        acc = 0
        for (a, b), L in zip(segs, lens):
            if acc + L >= target:
                t = (target - acc) / L if L else 0
                outp.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
                break
            acc += L
    return outp


def green_json(hole, nheads, start, names, pad=26, bunkers_h=None):
    ring = green_poly(hole)
    cx, cy = centroid(ring)
    appr = []
    for c in D['course_map']:
        if c['layer'] == 'approach' and c.get('hole') == hole:
            r = [fy(p) for p in c['pts']]
            if math.hypot(centroid(r)[0] - cx, centroid(r)[1] - cy) < 45:
                appr.append([[round(x - cx, 1), round(y - cy, 1)] for x, y in r])
    heads = perimeter_points(ring, nheads, start)
    # push heads ~1.5 m outside the edge, like a real green-edge head
    hp = []
    for (x, y) in heads:
        dx, dy = x - cx, y - cy; L = math.hypot(dx, dy) or 1
        hp.append((x + dx / L * 1.5, y + dy / L * 1.5))
    bk = []
    if bunkers_h:
        for b in BNK['bunkers']:
            if b['h'] == bunkers_h and 'greenside' in b['d'] and math.hypot(b['c'][0] - cx, (YMAX - b['c'][1]) - cy) < 40:
                for r in b['p']:
                    bk.append([[round(p[0] - cx, 1), round((YMAX - p[1]) - cy, 1)] for p in r])
    return {
        'green': [[round(x - cx, 1), round(y - cy, 1)] for x, y in ring],
        'heads': [{'n': names[i], 'x': round(hp[i][0] - cx, 1), 'y': round(hp[i][1] - cy, 1)} for i in range(nheads)],
        'bunkers': bk,
        'appr': appr,
    }


G18 = green_json('18', 6, 0.08, ['18G1', '18G2', '18G3', '18G4', '18G5', '18G6'], bunkers_h=18)
# real run times, Spatially Claude greens brief, Sat 17 Oct 2026 (base at 100%)
G18['times'] = {'18G1': 900, '18G2': 1470, '18G3': 1410, '18G4': 1290, '18G5': 1230, '18G6': 780}
G18['read'] = {'18G2': 8.8, '18G3': 8.8, '18G4': 10.1}
G8 = green_json('8', 5, 0.12, ['8G1', '8G2', '8G3', '8G4', '8G5'], bunkers_h=8)
G8['part'] = ['8G1', '8G2', '8G4', '8G5']

# ---------------------------------------------------------------- scheduled tasks (31, as of 19 Oct 2026)
def hourly(h0, h1, m):
    return [f'{h:02d}:{m:02d}' for h in range(h0, h1 + 1)]


TASKS = [
    # ring: 0 water, 1 turf, 2 course & crew, 3 machinery, 4 safety, 5 office
    ('Course setup, morning check', 2, ['04:45'], 'daily', 'Re-checks the comp, tee times, weather and soil moisture, verifies all 18 pins and slopes, and posts the crew brief to #dailycoursesetup.'),
    ('Daily notes watchdog', 2, hourly(4, 19, 52), 'daily', 'Keeps the TurfDog daily notes exactly as they should be and puts them back if anything gets lost.'),
    ('Claude Inbox', 5, hourly(5, 21, 7), 'daily', 'Picks up anything said to Claude in Slack ("we\'re out of anti-foam"), logs it, reminds the team until it\'s ticked, and drafts the order email for me to send.'),
    ('Irrigation board', 0, hourly(5, 19, 20), 'daily', 'Logs parts in and out from #irrigation, reads Cirrus Pro alarms and rebuilds the live irrigation page.'),
    ('Drainage board', 0, hourly(5, 19, 25), 'daily', 'Same for #drainage: materials used, open jobs and the live drainage page.'),
    ('Machinery board', 3, hourly(5, 19, 35), 'daily', 'Reads Toro Intelli360 hours and the fault log, projects services from use, rebuilds the machinery page and posts the mechanic\'s worklist on weekdays.'),
    ('Bunker board', 0, hourly(5, 19, 45), 'daily', 'Same for #bunkers: sand and materials, audit condition and the live bunker page.'),
    ('Irrigation worklist', 0, ['05:56'], 'weekdays', 'Turns crew posts, Cirrus alarm emails and station notes into job cards in #irrigation, greens heads first.'),
    ('Growth and GvX', 1, ['06:00'], 'daily', 'Works out the day\'s greens growth figures (GvX) from clippings and weather.'),
    ('Sand dusting call', 1, ['06:00'], 'daily', 'Works out whether the greens need dusting and how much, and posts the call to #topdressing.'),
    ('Turf watch', 1, ['06:00'], 'daily', 'Checks GreenKeeper, the weather station and the soil probes for anything the greens need today.'),
    ('Pre-starts and SWPs', 4, hourly(6, 14, 5), 'daily', 'Checks every machine on the TurfDog board has a pre-start done and a signed SWP, and tags whoever is missing one.'),
    ('Drainage worklist', 0, ['06:10'], 'weekdays', 'Turns #drainage posts into job cards with a daily header.'),
    ('Bunker worklist', 0, ['06:15'], 'weekdays', 'Turns #bunkers posts into job cards and keeps the bunker audit up to date.'),
    ('Lunchroom roster', 2, ['06:15'], 'weekdays', 'Posts the week\'s lunchroom and washdown roster to #course-team, with swaps from the thread.'),
    ('Sand call backstop', 1, ['06:25'], 'daily', 'Makes sure the dusting call actually went up.'),
    ('Friday catch-up', 5, ['06:45'], 'Fridays', 'A prioritised list of everything from the week\'s inbox that still needs me.'),
    ('Time in lieu poll', 2, ['06:58'], 'Sundays', 'Schedules the TIL request post at a random time after 9am, so nobody has to sit by their phone to get in first.'),
    ('Urgent inbox scan', 5, ['07:00', '14:00'], 'daily', 'Flags anything genuinely urgent in my work email to my phone.'),
    ('Bunker map video', 0, ['07:05'], 'daily', 'When the bunker jobs change, renders a map video of the open work for #bunkers.'),
    ('Job board review', 2, ['08:30'], 'daily', 'Reads the day\'s job board against the weather and keeps notes on how we set the crew up.'),
    ('Training reminder', 4, ['08:52'], 'daily', 'Chases the current training module until every staff member has done it, then switches itself off.'),
    ('The Safety Cut', 4, ['09:00'], 'weekdays', 'A short safety message for the crew in #ohs.'),
    ('Greens report', 1, ['09:30'], 'daily', 'Keeps this month\'s Greens Report for the committee building in Notion, day by day.'),
    ('SWP sign-off push', 4, ['09:47'], 'weekdays', 'One safe work procedure at a time in #ohs, tagging everyone who still needs to sign it.'),
    ('Roster check-in', 2, ['13:30'], 'weekdays', 'Picks up roster swaps and cover requests from the thread.'),
    ('Daily course briefing', 2, ['15:00'], 'daily', 'Writes tomorrow\'s briefing into TurfDog: field, weather, greens data and the spray plan.'),
    ('Spray look-ahead', 1, ['16:00'], 'Sundays', 'Lays out the week of spraying ahead, ready for Monday.'),
    ('Spatially Claude: greens', 0, ['17:00'], 'daily', 'Per-head run times for every green from the morning\'s scan, written into Cirrus Pro and explained in #spatially-claude.'),
    ('Spatially Claude: course', 0, ['17:30'], 'daily', 'The same for fairways, tees, surrounds, the range and the practice greens: 590 heads, each with its own time.'),
    ('Course setup, evening plan', 2, ['18:00'], 'daily', 'Checks tomorrow\'s pins against the slope and wind rules and posts the plan to #dailycoursesetup.'),
]
assert len(TASKS) == 31, len(TASKS)
WEEKDAY_RUNS = sum(len(t[2]) for t in TASKS if t[3] in ('daily', 'weekdays'))
TASKS_JSON = [{'n': t[0], 'r': t[1], 't': t[2], 'd': t[3], 'x': t[4]} for t in TASKS]

# ---------------------------------------------------------------- forward look snapshot
def forward_snapshot():
    wa = [w for w in D['wetting_agent'] if w['zone'] == 'greens'][0]
    fp = D['fairway_params'][0]
    dw = [x for x in D['disease_watch'] if x['level_peak'] in ('moderate', 'high')]
    return {
        'built': D.get('_built'),
        'week': [{k: w.get(k) for k in ('date', 'cat', 'label', 'detail')} for w in D['week_ahead']],
        'wa': {k: wa.get(k) for k in ('effectiveness', 'due_date', 'last_app', 'cum_et_mm', 'product')},
        'fw': {k: fp.get(k) for k in ('need_holes', 'need_kl', 'as_of', 'course_now', 'et_today_mm')},
        'disease': [{k: x.get(k) for k in ('label', 'level_today', 'level_peak', 'peak_date')} for x in dw],
        'clocks': [{k: c.get(k) for k in ('clock', 'area', 'gdd', 'target_gdd', 'last_app', 'window_open_day', 'days_since')}
                   for c in D['clocks']],
    }


# ---------------------------------------------------------------- go
hero, pin_counts = hero_svg()
tpl = open(os.path.join(HERE, 'template.html')).read()
ms = D.get('_built', '')
repl = {
    '<!--HERO_SVG-->': hero,
    '__TASKS__': json.dumps(TASKS_JSON, separators=(',', ':')),
    '__G18__': json.dumps(G18, separators=(',', ':')),
    '__G8__': json.dumps(G8, separators=(',', ':')),
    '__FWD__': json.dumps(forward_snapshot(), separators=(',', ':')),
    '{{WEEKDAY_RUNS}}': str(WEEKDAY_RUNS),
    '{{TASK_COUNT}}': str(len(TASKS)),
    '{{MACHINES_ACTIVE}}': str(json.load(open(os.path.join(ROOT, 'machinery', 'data.json')))['m_summary'][0]['active']),
}
for k, v in repl.items():
    assert k in tpl, k
    tpl = tpl.replace(k, v)
open(OUT, 'w').write(tpl)
print('wrote', OUT, f'{os.path.getsize(OUT)//1024} KB', 'weekday runs', WEEKDAY_RUNS, 'pins', pin_counts, 'TurfRad', TR_DATE)
