# Growth potential video (Greens Live, Today page)

Replaced the hand-made "Course briefing" clip on 21 Oct 2026 (Andy: the video wasn't being rebuilt
with each dashboard update; he asked for a growth potential recap referencing PACE Turf that is
updated every run).

- **What it is:** a ~48 s 1920x1080 recap. Latest day's greens (cool-season) and couch (warm-season)
  growth potential, how the PACE Turf model works, the last 30 days, the next 7 days and three
  plain-English takeaways.
- **When it rebuilds:** GitHub Actions (`.github/workflows/gp-video.yml`) on every push of
  `data.json`, plus a 7:35am fallback each day. No PC or Claude task is involved.
- **Outputs:** `videos/gp-recap.mp4`, `videos/gp-recap.jpg` (poster), `videos/gp-recap.json`
  (the numbers on screen) and `videos/videos.json` (what the Today page plays).
- **Do not** push `videos/videos.json` from the PC any more. If something does, the workflow runs
  again and puts the growth potential entry back.

Model: GP = exp(-0.5 x ((T - Topt) / var)^2), T = daily mean air temperature (on-course station,
from `data.json` daily[].tmean). Cool season Topt 20 C, var 5.5; warm season Topt 31 C, var 7
(Gelernter and Stowell 2005, PACE Turf). Greens GP history is `daily[].gp` straight from the
dashboard. Forecast: Open-Meteo, then MET Norway, then the dashboard's own 3-day hourly forecast.

Local test: `python3 _video/build.py --repo . --preview /tmp/frames` writes stills;
`python3 _video/build.py --repo . --force` renders the full video.
