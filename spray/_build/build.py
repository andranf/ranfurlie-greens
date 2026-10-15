#!/usr/bin/env python3
"""Build a Ranfurlie spraying page from a recipe, the product library and config.json.

  python3 spray/_build/build.py spray/_build/recipes/<slug>.json [--latest] [--fragment OUT]

Writes spray/<slug>/index.html. --latest also writes spray/index.html (the crew's
bookmark, always the newest spray). --fragment writes the page without its
doctype wrapper (for publishing as a Claude artifact).

The page has two views: the mixing guide (front and centre on the spray day until
the mix is signed) and the spraying dashboard (reads the greens data.json).
Sign-offs post to the Zapier "Spray sign-offs" hook in config.json.

Every product id in the recipe must already be in products.json, read off its
current AU label and SDS. The build stops if one is missing rather than guessing.

EVERY TIME a recipe is built and published (Andy, 16 Oct 2026: "this is a MUST"):
post the link in #spraying (C06KFFNE5R7) and tag the applicator. Set "applicator":
["Name", "Slack ID"] in the recipe from today's TurfDog board (the daily course setup
brief in #dailycoursesetup names who's on the sprayer). The build prints the post,
ready to send.
"""
import argparse, html, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SPRAY = os.path.dirname(HERE)


def shown(amt_l, unit):
    if unit == "mL":
        return f"{round(amt_l * 1000):d}", "mL"
    return (f"{amt_l:.2f}" if amt_l < 10 else f"{amt_l:.1f}"), "L"


def merge_checks(base, extra):
    out = [list(c) for c in base]
    ids = [c[0] for c in out]
    for c in extra or []:
        if c[0] in ids:
            out[ids.index(c[0])] = list(c)
        else:
            out.append(list(c))
            ids.append(c[0])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("recipe")
    ap.add_argument("--latest", action="store_true")
    ap.add_argument("--fragment")
    a = ap.parse_args()

    R = json.load(open(a.recipe, encoding="utf-8"))
    lib = json.load(open(os.path.join(HERE, "products.json"), encoding="utf-8"))
    cfg = json.load(open(os.path.join(HERE, "config.json"), encoding="utf-8"))

    if not R.get("date_iso"):
        m = re.match(r"(\d{4}-\d{2}-\d{2})", R["slug"])
        if not m:
            sys.exit("Add date_iso (YYYY-MM-DD) to the recipe.")
        R["date_iso"] = m.group(1)
    if not re.fullmatch(r"[a-z0-9-]{6,80}", R["slug"]):
        sys.exit("slug must be lower-case letters, numbers and dashes.")

    prods = []
    for e in R["products"]:
        base = lib.get(e["id"])
        if base is None:
            sys.exit(f"'{e['id']}' is not in products.json. Read its label and SDS and add it first.")
        p = dict(base)
        p.update({k: v for k, v in e.items() if k not in ("rate_lha", "unit")})
        amt = e["rate_lha"] * R["area_ha"]
        p["amt"] = round(amt, 4)
        p["show"], p["u"] = shown(amt, e.get("unit", "L"))
        prods.append(p)
    R["products"] = prods

    if abs(R["area_ha"] * R["rate_lha"] - R["mix_l"]) > 1:
        print("WARNING: area x water rate does not equal the mix volume")
    prod_l = sum(p["amt"] for p in prods)
    if "fill_l" not in R:
        R["fill_l"] = int(round(R["mix_l"] * 2 / 3 / 50) * 50)
    if R["fill_l"] + prod_l > R["mix_l"]:
        sys.exit("First fill plus products is more than the mix volume. Lower fill_l.")

    R["webhook"] = cfg.get("webhook", "")
    R["data_url"] = cfg.get("data_url", "")
    R["crew"] = cfg.get("crew", [])
    R["post_checks"] = merge_checks(cfg.get("post_checks", []), R.get("post_checks"))

    facts = "".join(
        f'<span class="fact">{html.escape(x)}</span>'
        for x in [f'{R["area_ha"]:.2f} ha', f'{R["rate_lha"]} L/ha', f'{R["mix_l"]} L mix',
                  R["nozzles"], R["speed"], R["pressure"]])
    demo = (f'<div class="demo"><div class="wrap gut"><p class="pill"><strong>Demo:</strong> '
            f'{html.escape(R["demo"])}</p></div></div>') if R.get("demo") else ""
    data = json.dumps(R, ensure_ascii=False).replace("</", "<\\/")
    tpl = open(os.path.join(HERE, "template.html"), encoding="utf-8").read()
    page = (tpl.replace("{{WHEN}}", html.escape(f'{R["sprayer"]} · {R["date"]}'))
               .replace("{{TITLE}}", html.escape(R["title"]))
               .replace("{{FACTS}}", facts).replace("{{DEMO}}", demo)
               .replace("{{NSTEPS}}", str(3 + len(prods) + 2))
               .replace("{{CAP}}", f'{R["tank_cap_l"]:,}').replace("{{MIX}}", str(R["mix_l"]))
               .replace("{{RECIPE}}", data))
    left = re.findall(r"\{\{[A-Z]+\}\}", page)
    if left:
        sys.exit(f"Template placeholders not filled: {left}")
    full = ('<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
            + page + '\n</html>\n')

    out = os.path.join(SPRAY, R["slug"], "index.html")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "w", encoding="utf-8").write(full)
    print("wrote", os.path.relpath(out, os.path.dirname(SPRAY)))
    if a.latest:
        open(os.path.join(SPRAY, "index.html"), "w", encoding="utf-8").write(full)
        print("wrote spray/index.html")
    if a.fragment:
        open(a.fragment, "w", encoding="utf-8").write(page)
        print("wrote", a.fragment)

    lvl = R["fill_l"]
    print(f'\nFill {lvl} L')
    for i, p in enumerate(prods, 1):
        lvl += p["amt"]
        print(f'  {i}. {p["name"]:<20} {p["show"]:>6} {p["u"]:<2}  sheet {p["sheet"]}  -> {lvl:6.1f} L')
    print(f'Top up {R["mix_l"] - lvl:.1f} L to {R["mix_l"]} L')
    print(f'Post-application checks: {len(R["post_checks"])} · crew {len(R["crew"])} · date {R["date_iso"]}')
    print_slack_post(R, prods, cfg)


KIT = {"overalls": "overalls", "hat": "hat", "gloves": "elbow gloves", "goggles": "goggles",
       "shield": "face shield", "mask": "mist mask", "apron": "apron", "boots": "boots"}


def print_slack_post(R, prods, cfg):
    """The #spraying post that goes out with every new recipe, tagging the applicator."""
    app = R.get("applicator")
    url = cfg.get("page_url", "https://andranf.github.io/ranfurlie-greens/spray/") + R["slug"] + "/"
    changed = any(p.get("sheet") not in (None, i) for i, p in enumerate(prods, 1))
    kit = [KIT[k] for k in KIT if any(k in p.get("ppe", []) for p in prods)]
    lines = [f':test_tube: **Today\'s tank: {R["title"]} ({R["sprayer"].replace("Toro ", "")})**',
             (f'<@{app[1]}> ' if app else '') + 'step-by-step mixing guide, open it on your phone at the shed:',
             url, '',
             f'**Setup:** {R["area_ha"]:g} ha · {R["rate_lha"]} L/ha · {R["mix_l"]} L mix · '
             f'{R["nozzles"]} · {R["speed"]} · {R["pressure"]}', '',
             '**Mixing order' + (' (changed from the sheet):**' if changed else ':**'),
             f'1. Water to {R["fill_l"]} L, agitator on']
    for i, p in enumerate(prods, 2):
        amt = f'{p["name"]} {p["show"]} {p["u"]}'
        lines.append(f'{i}. **{amt}** ({p["note"].rstrip(".").split(" (")[0].lower()})' if p.get("note") else f'{i}. {amt}')
    top = f'{len(prods) + 2}. Top up to {R["mix_l"]} L'
    if R.get("ph_max"):
        top += f', then **check pH: must be under {R["ph_max"]}**. If it\'s {R["ph_max"]} or above, don\'t spray. Call Ben or Andy.'
    lines += [top, '']
    if kit:
        lines.append(':warning: ' + (R.get("ppe_note", "").strip() + ' ' if R.get("ppe_note") else '') +
                     'Kit: ' + ', '.join(kit) + '.')
    if R.get("spray_rules"):
        lines.append('. '.join(r.rstrip('.') for r in R["spray_rules"]) + '.')
    lines.append('Sign off the mix on the page once it\'s in the tank, then do the post-application checklist once it\'s sprayed out.')
    print('\n==== Post to #spraying (C06KFFNE5R7) — every recipe, tag the applicator ====')
    if not app:
        print('!! NO APPLICATOR SET. Add "applicator": ["Name", "Slack ID"] from today\'s TurfDog board, then rebuild.')
    print('\n'.join(lines))


if __name__ == "__main__":
    main()
