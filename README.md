# Cedar Crest Planner

A phone-first 3D shot planner and shot tracker for **Cedar Crest Golf Course** in Dallas.
Plan each hole on real terrain, log every shot with your phone's GPS, and see where you
gain and lose strokes over time.

## What it does

**Plan**
- All 18 holes in 3D: real USGS 1 m elevation with fairways, greens, bunkers, water,
  trees and cart paths from OpenStreetMap. Tee, Top and Green camera views; drag to orbit.
- Yardages to the front, pin and back of the green, plus "plays like" yardage that adjusts
  for elevation, wind and temperature.
- Bunkers and water near your line, with reach and carry yardages.
- A saved plan per hole: club and target for each shot. Tap **Suggest best plan** and the
  app simulates hundreds of shots per club and aim point using your distances and misses,
  then picks the play with the lowest expected score. **Compare clubs** shows the
  alternatives and where ~80% of shots land.
- Live wind and temperature for the course (Open-Meteo), or enter them by hand.
- Move the pin to today's position; keep notes per hole.

**Play**
- Start a round (back, middle or forward tees). Stand at your ball, tap **Mark ball & hit**,
  pick the club. The lie (fairway, rough, sand, trees) is detected from the map.
- **On green** marks where you reached the green so the first-putt distance is measured.
  Then count putts, add penalties, and note whether you stuck to the plan.
- "What should I hit?" gives advice from where you're standing.
- Not at the course? Practice mode lets you place the ball by tapping the map.

**Stats**
- Strokes gained per 18 holes (off the tee, approach, around the green, putting),
  compared with a typical golfer of your handicap.
- Round history (score, putts, fairways, greens in regulation).
- Per-hole history, including your past shots drawn on the 3D hole and how you score
  when you follow the plan versus not.
- Club distances (median and typical range) and left/right spread. Once a club has 5+
  shots, the advice uses your real numbers.

Your data stays on the phone (local storage). Use **☰ → Export backup** now and then.

## Using it on your phone

The app needs to be served over HTTPS for GPS and offline use. Once deployed, open the
link in Safari (iPhone) or Chrome (Android) and choose **Add to Home Screen**. After the
first load it works offline on the course; only the weather needs a signal.

### Deploying with GitHub Pages

`.github/workflows/deploy.yml` builds and publishes the app on every push to `main`.
Enable it once: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
GitHub Pages needs a public repository on the free plan (a private one needs GitHub Pro
or a paid plan). No personal data is in the repo; rounds live only on your phone.

## Development

```bash
npm install
npm run dev        # local dev server
npm test           # logic tests (course data, strokes gained, advice, stats)
npm run build      # production build in dist/
```

### Refreshing the course data

```bash
NODE_USE_ENV_PROXY=1 npm run fetch-course   # NODE_USE_ENV_PROXY only needed behind a proxy
```

This downloads the course layout from the OpenStreetMap API and a 2 m elevation grid from
USGS 3DEP, writing `public/data/course.json` and `public/data/terrain.bin`. If the course
layout changes (or OpenStreetMap gets better), edit it on openstreetmap.org and re-run.

## How the numbers work

- **Strokes gained** uses Mark Broadie's PGA Tour baseline ("Every Shot Counts"), scaled
  up for your handicap (about +2% per handicap stroke). It's an approximation, best used
  to compare categories and track trends.
- If you don't mark your ball on the green, the first putt is assumed to be 25 ft.
- Wind: about 1% shorter per mph into the wind, 0.5% longer per mph downwind, ~1% of the
  distance sideways per mph of crosswind. Temperature: ~1.3% per 10°F from 70°F.
- GPS distances are total (carry plus roll).

## Credits

Course map © OpenStreetMap contributors (ODbL). Elevation: USGS 3D Elevation Program.
Weather: Open-Meteo. 3D: three.js.
