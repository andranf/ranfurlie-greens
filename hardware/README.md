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
| `ref.json` | Reference layers: 674 CirrusPRO head positions, 240 as-built plan points (LI-IV, SV, MV, DP, DO), buried and irrigation lines, drainage areas | `_build/build_ref.py` from `_build/cirrus_ref.txt` |
| `live.json` | Every pin (records) and a short event log | Zapier workflow "Hardware map" |
| `p/<PIN>.html` | One small page per Slack post: its link preview shows the spot, then it opens the map at the pin | Zapier workflow |
| `snaps/<PIN>.jpg` | The aerial snapshot with the pin drawn on (made by the page when the pin is saved) | Zapier workflow |
| `og.jpg` | The link preview image for the main page | Claude |
| `_build/workflow.ts` | Source of the Zapier workflow (keep in step with the published version) | Claude |

## How a pin gets saved

The page queues every change in the phone's outbox (so it survives no signal) and posts it to the Zapier catch hook.
The workflow makes one atomic commit (live.json plus any snapshot and pin page), waits for GitHub Pages to serve the
pin page (up to about 2.5 minutes) so Slack can show the preview, then posts. Fixed problems get a thread reply and a ✅.

Test mode: open the page with `?test=1`. Slack goes to Andy's DM, records are marked `test` and hidden from everyone
else. Post `{"kind":"purge_test","__test":"1"}` to the hook to clear them.

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
