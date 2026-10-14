#!/usr/bin/env python3
"""Build a Ranfurlie tank-mix page from a recipe and the product library.

  python3 spray/_build/build.py spray/_build/recipes/<slug>.json [--latest] [--fragment OUT]

Writes spray/<slug>/index.html. --latest also writes spray/index.html (the crew's
bookmark, always the newest spray). --fragment writes the page without its
doctype wrapper (for publishing as a Claude artifact).

Every product id in the recipe must already be in products.json, read off its
current AU label and SDS. The build stops if one is missing rather than guessing.
"""
import argparse, html, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SPRAY = os.path.dirname(HERE)


def shown(amt_l, unit):
    if unit == "mL":
        return f"{round(amt_l * 1000):d}", "mL"
    return (f"{amt_l:.2f}" if amt_l < 10 else f"{amt_l:.1f}"), "L"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("recipe")
    ap.add_argument("--latest", action="store_true")
    ap.add_argument("--fragment")
    a = ap.parse_args()

    R = json.load(open(a.recipe, encoding="utf-8"))
    lib = json.load(open(os.path.join(HERE, "products.json"), encoding="utf-8"))

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
               .replace("{{NSTEPS}}", str(3 + len(prods) + 4))
               .replace("{{CAP}}", f'{R["tank_cap_l"]:,}').replace("{{MIX}}", str(R["mix_l"]))
               .replace("{{RECIPE}}", data))
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


if __name__ == "__main__":
    main()
