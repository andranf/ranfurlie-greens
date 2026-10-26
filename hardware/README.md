# Hardware map

Public page: https://andranf.github.io/ranfurlie-greens/hardware/

The crew pin two kinds of things with phone GPS:

- **Problems** (leak, head fault, broken or sunken box, wet or boggy spot, blocked or slow drain, other). Each one posts to
  #irrigation or #drainage with a link preview of the exact spot; the link opens the map at the pin.
- **Hardware that stays put** (isolation, sluice and MV valves, QCVs, valve boxes, sprinkler heads, decoders and splices,
  air valves, drain pits and outlets, cleanouts). Hardware marked *Needs work* or *Failed* also posts to the channel.
  This is what builds the Cirrus Pro layers.

## Files

| File | What it is | Written by |
|---|---|---|
| `index.html` | The map page | Claude |
| `ref.json` | Reference layers: 674 CirrusPRO head positions, 240 as-built plan points (LI-IV, SV, MV, DP, DO). The plan lines and drainage areas were taken off the map (24 Oct 2026) | `_build/build_ref.py` from `_build/cirrus_ref.txt` |
| `live.json` | Every pin (records) and a short event log | Zapier workflow "Hardware map" |
| `p/<PIN>.html` | One small page per Slack post: its link preview shows the spot, then it opens the map at the pin | Zapier workflow |
| `snaps/<PIN>.jpg` | The aerial snapshot with the pin drawn on (made by the page when the pin is saved) | Zapier workflow |
| `og.jpg` | The link preview image for the main page | Claude |
| `network.json` | The mainline: pipes, sluice / MV / LI-IV valves, the pump, and heads linked to valves | First pass by `_build/build_network.py`; after that only the page (Mainline > Edit > Save) through the Zapier workflow |
| `network.test.json` | The copy the page uses in test mode (`?test=1`) | Zapier workflow |
| `tiles/mm/` | MetroMap Jan 2026 aerial (the CirrusPRO backdrop) as map tiles, z14-19 | `_build/make_tiles.py` |
| `tiles/plan/` | The 2000 irrigation as-built drawing (CirrusPRO layer) as transparent tiles, z15-19 | `_build/make_tiles.py` |
| `_build/workflow.ts` | Source of the Zapier workflow (keep in step with the published version) | Claude |

## How a pin gets saved

The page queues every change in the phone's outbox (so it survives no signal) and posts it to the Zapier catch hook.
The workflow makes one atomic commit (live.json plus any snapshot and pin page), waits for GitHub Pages to serve the
pin page (up to about 2.5 minutes) so Slack can show the preview, then posts. Fixed problems get a thread reply and a ✅.

Zapier can drop a run (for example when its daily compute limit is hit, as on 27 Oct 2026, until 00:00 UTC). So the phone
keeps every pin change, shutdown and mainline save until it shows up in `live.json` / `network.json`, and sends it
again every 15 minutes for up to 12 hours (the hook ignores repeats by `ev`; a re-sent pin goes without its snapshot).
A mainline save that someone else's save has overtaken is handed back as unsaved edits instead of being sent again.

Test mode: open the page with `?test=1`. Slack goes to Andy's DM, records are marked `test` and hidden from everyone
else. Post `{"kind":"purge_test","__test":"1"}` to the hook to clear them.

## Mainline (the Mainline tab on the map)

- Pipes and valves come from the 2000 as-built drawing in CirrusPRO (`Irrigation_asbuilt_2000_v3.png`). The mainline is a
  faint dash-dot line on that drawing, so the first pass (24 Oct 2026, `_build/mainline_routes.py`) needs checking on the
  ground. All 28 sluice valves, 11 MV valves and 74 LI-IVs from the as-built sit on the traced line.
- The pump is the shed between the dam and the maintenance shed (Andy). The dam postdates the drawing, so the pipe from
  the pump to the 250 mm mains is an assumption.
- Sluice and MV valves sit in the main. Each LI-IV sits on a short take-off beside the main, so shutting it only shuts
  its lateral. Heads feed off the nearest main unless they're linked to a valve (Edit > tap an LI-IV > Link heads).
- The simulation runs from the pump through every open valve. "Find valves to shut" finds the ring of working valves
  around a head or pipe; valves logged as seized (in Edit, or as a Failed valve pin on the hardware map) are skipped.
- Moving valves: drag a valve onto the pipe it's really on (it snaps on and the old spot joins back up), or tap it >
  Move it > tap the pipe. A valve keeps its name, links and history when it moves. "GPS pin nearby" moves it onto a
  valve the crew have pinned on the hardware map.
- Tees: in Edit, tees show as orange rings. Tap one to add a valve on each leg that has one (5 m from the tee). A valve
  sitting right on a tee shuts every way out; its card offers to put it on its leg.
- Reshaping pipes: tap a pipe > Reshape. Drag the yellow diamonds to move bends, drag the small dots to add a bend, tap a
  diamond to take it out, or Make it straight. Redraw: tap along the real route and the ends stay put. Add a join: puts a
  junction on the pipe to drag or branch a new pipe from. A pipe here is the stretch between two valves or junctions.
- Edits: Mainline > Edit. Drag valves and junctions, add valves, draw pipes, delete pipes, link heads, then Save. The page
  posts the whole network to the hook (`kind: "net"`), which commits `network.json` with a log line. Nothing in the page
  needs changing when the network changes.
- `_build/build_network.py` rebuilds the first pass from the drawing. Running it again throws away the crew's edits.
- `_build/smooth_network.py` evens out wobbly runs in place (keeps every valve, link and edit; ran once on 24 Oct 2026).
- Cirrus Pro: the Layers button in the Mainline tab gives the mainline and valve layers as KML, each under 200 points.

## Valves shut on the course

"Try it on the map" and "Find valves" only change your own map. Once valves are really shut:

- Tap the valve > **I've shut it**, or in the finder **We've shut them**. Say what it's for, pick *Today* or *Staying off
  for now*, and who. The page posts `kind: "shut"`; the workflow adds it to `live.json` under `shuts` and posts
  ":no_entry: Water off" to #irrigation (what for, valves, what's off, who, time, link to the map).
- Everyone's map shows those valves red and pulsing, the heads they feed dry, and "Water off on the course" in the
  Mainline panel. **What's shut** lists every open shutdown with *It's back on*, *Show*, *Staying off* and the Slack thread.
- Back on: tap the valve > **It's back on** (one valve), or **All back on**. The thread gets a reply with how long it was
  off; when the last valve is back on the post gets a ✅. Some valves back on gets a "still shut: ..." reply.
- Reminders in the thread while anything is still shut. *Today*: 3pm, then 7pm tagging Andy, Ben and Neil (before night
  irrigation), then 7am each morning. *Staying off*: 7am each morning. They stop once all are back on (14 at most).
- The Slack link (`?shut=SHUT-ID`) opens the mainline map with that shutdown's list.
- Test mode: with `?test=1` it all goes to Andy's DM. `"__fast": "1"` with `__test` runs the three reminders 20 s apart.
  `purge_test` also clears test shutdowns.

## Aerials

The base map is the MetroMap Jan 2026 aerial that is already in CirrusPRO, cut into tiles (light on phones: only the
tiles on screen load). Esri shows past its edges, and the Layers sheet can switch back to Esri. Slack snapshots use
the same MetroMap tiles.

## Cirrus Pro layers: rules

1. **Vector only.** Import hardware as KML (Layers sheet on the page, one file per type). Never as images.
2. **Small layers.** Keep each layer under 200 points (CirrusPRO calls that "Small"; 200 to 999 is Medium, 1000+ Large).
   The page splits any type that gets near the limit by hole group (1-4, 5-9, 10-13, 14-18, practice).
3. **Off by default.** Imported KML/vector layers come in switched off on every device; CirrusPRO only stores their
   on/off per device, and phones start with them all off. Image layers are the opposite: a new image layer is ON
   for every user until each user turns it off, which is the likely cause of the phone crashes.
4. **Names.** `HW <type>`, for example `HW Isolation valves`, `HW Quick couplers`.
5. **Replacing a layer.** The CirrusPRO import tool can't replace the points in an existing layer. Import the new KML, check it, then remove
   the old layer. Removing is permanent in CirrusPRO: only with Andy's OK.
6. Record each import in `live.json` under `cirrus`, keyed by layer name (`{"HW Isolation valves": {"count": 12, "imported": "<ISO time>"}}`), so the Layers sheet shows what is current.

## Image layers already in CirrusPRO (24 Oct 2026)

15 image layers. 11 of them are the sprinkler arc images at 9000 x 7232 px (65 megapixels, about 260 MB of phone memory
each when drawn), plus the 4500 x 3616 MetroMap backdrop. Any user whose CirrusPRO preferences don't yet have an
entry for an image layer gets it switched on, so a phone can try to draw several at once and the browser tab dies.
Fix (needs Andy's OK, removal is permanent): remove the superseded arc versions (v1, v2, v3), and re-import the v4 arc
images downsized to 4096 px wide or less.

## Refreshing the reference layers

Re-extract stations and the Irrigation/Drainage vector layers from CirrusPRO into `_build/cirrus_ref.txt`
(format in `build_ref.py`), then `python3 hardware/_build/build_ref.py`.

The CirrusPRO image layers (MetroMap, the 2000 as-built, the drainage overlay) can be pulled with the GitHub Actions
workflow "Fetch CirrusPRO image layers" (file names from CirrusPRO's RasterItem list); the result is a build artifact.
