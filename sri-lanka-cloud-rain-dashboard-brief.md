# Project Brief — Sri Lanka Cloud & Rain Watch (Next.js)

> **For the coding agent:** This is the build brief. Read it fully before scaffolding. Do the phases in order and get each one working before you start the next. Anything marked **VERIFY** is an assumption you need to confirm against the live source before relying on it.

---

## 1. What we are building

A Next.js dashboard for **Sri Lanka only** that:

1. **Fetches** the INSAT-3DS satellite images IMD publishes every 30 minutes, and **stores** each new frame (no duplicates).
2. **Crops** each frame to Sri Lanka and computes **cloud-density metrics** per grid cell and per **estate** (estate boundaries come from KML files).
3. Shows the frames as a **timeline**: a slider and play button over a map of Sri Lanka.
4. **Predicts rainfall** by combining:
   - a **short-range nowcast** (0–3 h), made by moving the observed clouds forward along their recent motion, and
   - **Open-Meteo** numerical forecasts (hourly up to 16 days), sampled over Sri Lanka and at each estate.
5. Gives each estate a card with its current cloud state, its trend, the next-3-hour risk and the 7-day rain outlook.

**Audience:** IWMI colleagues and plantation/estate managers. The aim is situational awareness. This is **not** an official forecast, and the UI must say so.

---

## 2. Data sources (checked 12 Nov 2026)

### 2.1 IMD INSAT-3DS imagery (primary, observed)

Base: `https://mausam.imd.gov.in/Satellite/`
(This is where the images on `https://mausam.imd.gov.in/responsive/satellite.php` come from.)

| Key | URL | Size (px) | Notes |
|---|---|---|---|
| `ir1` | `3Dasiasec_ir1.jpg` | 2002 × 2242 | Thermal IR 10.8 µm, works day and night. **Main channel.** |
| `vis` | `3Dasiasec_vis.jpg` | 2002 × 2242 | Visible. Only useful in daylight (about 06:30–18:00 IST). |
| `wv`  | `3Dasiasec_wv.jpg`  | 2002 × 2242 | Water vapour (mid/upper-level moisture). |
| `ctbt`| `3Dasiasec_ctbt.jpg`| 1260 × 1313 | Cloud-top brightness temperature with **colour-coded °C bins**. Different layout and satellite (header said INSAT-3DR) and it **lags a few hours** behind the others. |
| (opt) | `3Dglobe_ir1.jpg`, `3Dglobe_vis.jpg`, `3Dglobe_wv.jpg` | 2002 × 2242 | Full globe. Not needed. |
| (opt) | `Converted/IR1.gif`, `VIS.gif`, `WV.gif`, `CTBT.gif` | — | IMD's own animations. Not needed; we build our own timeline. |

What we saw on the live server:
- `HEAD` requests return **`Last-Modified`** and `Content-Length`, with no `Cache-Control`. **Use `Last-Modified` plus a SHA-256 of the bytes to detect new frames.**
  Example: the IR1 image for the 05:30–05:57 GMT scan had `Last-Modified: 06:15:11 GMT`, so frames appear **about 15–20 min after the scan starts**.
- The image header says, for example, `INSAT-3DS IMG, Thermal Infrared1 Count @ 10.83 µm`, `GMT:12-11-2026/(0530-0557)`, `IST:12-11-2026/(1100-1127)`, `L1C MERCATOR (LINEAR STRETCH: 1%)`, with a grey scale from 427 to 911 counts.
- **Projection is Mercator**, with dotted lat/lon grid lines every 10° and coastlines and borders drawn over the image.

**Caveats you must handle:**
1. **The JPGs are display products, not calibrated data.** "Linear stretch 1%" means the grey levels are re-stretched in every image. The same pixel brightness can mean a different temperature in the next frame. Treat IR1 brightness as a **relative** cloud-top coldness index. Do not convert it to a temperature or to mm of rain directly.
2. **Overlay graphics** (yellow/green coastlines, borders, dotted grid, header text) sit on top of the data. Mask those colours before computing statistics (see §5.2).
3. **Resolution is coarse for estates.** By eye the Asia sector is about **29 px per degree (≈3.8 km/pixel)**, so Sri Lanka is only about **70 × 105 px** and one estate may cover 1–4 pixels. **VERIFY** this during calibration. Compute estate statistics over a **buffer of about 10–15 km** around each estate, not over the polygon alone.
4. The layout could change without notice. Before processing a frame, check its pixel dimensions and that the header strip looks right. If either check fails, store the raw image, flag it `needs_review` and skip the analysis.
5. **Attribution:** show "Satellite imagery: IMD / ISRO INSAT-3DS" in the UI. Confirm IMD's reuse terms before any public or commercial deployment.

### 2.2 Open-Meteo (model forecasts, free tier)

- Endpoint: `https://api.open-meteo.com/v1/forecast`. No API key is needed for non-commercial use.
- Hourly variables to request: `precipitation`, `precipitation_probability`, `rain`, `showers`, `cloud_cover`, `cloud_cover_low`, `cloud_cover_mid`, `cloud_cover_high`, `cape`, `relative_humidity_2m`, `weather_code`. Set `timezone=Asia/Colombo` and `forecast_days=7` (up to 16 is possible).
- Many locations can go in **one request** (comma-separated `latitude=`/`longitude=` lists).
- Other useful endpoints:
  - **Historical Weather API (ERA5, from 1940).** Use it for a monthly rainfall climatology per estate ("is this wetter than normal?").
  - **Historical Forecast API (from 2021).** Use it to backtest how good Open-Meteo has been at each estate.
  - **Ensemble API.** Use it for spread and uncertainty bands in Phase 3.
  - **Flood API (GloFAS).** Optional river discharge layer.
- **Free-tier limits:** 600 calls/min, 5,000/hour, 10,000/day. The free tier is **non-commercial only**. If Luminos or a client uses this commercially, it needs a paid API plan. Ask Open-Meteo to confirm if unsure.
- Licence: **CC BY 4.0**. Show "Weather data by Open-Meteo.com" in the UI.
- Budget: a **0.25° grid over Sri Lanka (land cells only, about 100–150 points) plus the estate centroids**, refreshed **every 3 hours**. Open-Meteo counts multi-location requests as several calls, so log the call count and stay well under 10,000/day.

### 2.3 Phase 2 upgrade: MOSDAC (ISRO) quantitative rainfall

ISRO's MOSDAC distributes **calibrated, georeferenced** INSAT-3D/3DR/3DS products. These include rainfall estimates from the **Hydro-Estimator (HEM)** and **IMSRA (IMR, 0.1° gridded)**, as HDF5 and (for some products) GeoTIFF.
- Downloads need an account. There is a Python `mdapi` tool, limited to 5,000 files per day per user.
- This is the proper route to **actual mm/h estimates**. Design the data model so a `source = 'mosdac_imr'` rainfall layer can be added later without a schema rewrite.
- Published validation shows these products overestimate heavy rain and are weaker for light rain. Treat them as estimates as well.

### 2.4 Ground truth for validation (Phase 3)

- **NASA GPM IMERG** (half-hourly, 0.1°, free Earthdata account). Use it as the "truth" label when training and scoring the model.
- Rain gauges from the estates or the Sri Lanka Department of Meteorology, **if** we can get them.

---

## 3. Recommended architecture

```
┌──────────────────────┐   every 10 min   ┌──────────────────────────────┐
│ Scheduler            │ ───────────────▶ │ Ingest worker (Python)       │
│ (GitHub Actions cron │                  │ 1. HEAD each channel         │
│  or Supabase pg_cron │                  │ 2. new? GET + sha256 dedupe  │
│  → Edge Function)    │                  │ 3. save raw + SL crop        │
└──────────────────────┘                  │ 4. mask overlays, metrics    │
                                          │ 5. nowcast (optical flow)    │
          every 3 h                       │ 6. Open-Meteo pull           │
                                          └──────────────┬───────────────┘
                                                         │
                               ┌─────────────────────────▼─────────────┐
                               │ Supabase                              │
                               │  • Storage: raw/, crops/, nowcast/    │
                               │  • Postgres + PostGIS: frames,        │
                               │    metrics, estates, forecasts        │
                               └─────────────────────────┬─────────────┘
                                                         │ (RLS, read-only anon)
                               ┌─────────────────────────▼─────────────┐
                               │ Next.js (App Router) on Vercel        │
                               │  MapLibre map + timeline + estate UI  │
                               └───────────────────────────────────────┘
```

**Why the analysis runs in a Python worker:** the image work (masking, georeferencing, optical flow) is much easier with `numpy`, `opencv-python`, `Pillow` and optionally `pysteps` than in Node. Next.js stays a thin UI plus API layer.

- **Simplest scheduler:** a GitHub Actions workflow on `schedule: '*/10 * * * *'` that runs `worker/ingest.py` with Supabase credentials as secrets. GitHub cron can be delayed by a few minutes, which is fine because we dedupe.
- Alternative: Supabase `pg_cron` calling an endpoint. Vercel Cron frequency depends on the Vercel plan, so check before relying on it.
- Poll **every 10 minutes**, not every 30, so we pick up each frame soon after it appears. `HEAD` requests are cheap.

**Stack:**
- Next.js 15 (App Router, TypeScript), Tailwind, shadcn/ui
- **MapLibre GL JS** for the map. Use the `image` source for satellite overlays; free basemap from OpenFreeMap or MapTiler.
- Recharts (or ECharts) for time series
- Supabase (Postgres + PostGIS + Storage)
- `@tmcw/togeojson` to parse KML in the browser or API route
- Worker: Python 3.11, `requests`, `numpy`, `Pillow`, `opencv-python-headless`, `shapely`, `supabase-py` (optional `pysteps`)

---

## 4. Estates (KML)

The user will drop the KML files into `data/kml/`. The current set is:

`Dewalakande`, `Ederapolla`, `Ganepalla`, `Kalupahana`, `Kelani`, `Kiriporuwa`, `Lavent`, `Urumiwella`, `We Oya`

Requirements:
- A seed script `scripts/import-kml.ts` parses each KML to GeoJSON. Normalise it to `MultiPolygon` in EPSG:4326, then insert one row per estate into `estates` (name, slug, geometry, centroid, area_ha).
- An **admin "Estates" page** for uploading new KML or KMZ files. Show a preview on the map, then save. More estates are expected later.
- Store a `buffer_km` per estate (default 12). The **analysis area** is `ST_Buffer(geom::geography, buffer_km*1000)`.
- Precompute, per channel layout, which crop pixels fall inside each estate's analysis area. Save this as a pixel mask so the per-frame statistics are fast.

---

## 5. Image processing pipeline (worker)

### 5.1 Georeferencing (one-off calibration per image layout)

The image is Mercator, so pixel ↔ lat/lon is:

```
x = x0 + kx * lon
y = y0 - ky * ln( tan(π/4 + lat/2) )      # lat in radians
```

- Find `x0, kx, y0, ky` from the dotted 10° grid lines. Find the pixel columns of 70°E, 80°E and 90°E and the pixel rows of 0°, 10°N and 20°N. Then fit by least squares. Write a script `worker/calibrate.py` that finds the dotted lines automatically, or that accepts hand-picked control points.
- Save the result in `worker/calibration.json`, keyed by channel layout (`asiasec_2002x2242`, `ctbt_1260x1313`).
- **Check it:** draw a Natural Earth 10 m Sri Lanka coastline over the crop and save `calibration_check.png`. The drawn coastline must sit on IMD's coastline within 1–2 px. Do not continue until it does.
- **Crop box for Sri Lanka:** lat **4.5°N to 11.0°N**, lon **77.5°E to 84.0°E**. This includes surrounding sea, so incoming systems are visible. Store the crop's exact corner lat/lons with each frame.
- **Map display:** because the source is already Mercator, the cropped image can go straight into MapLibre (Web Mercator) as an `image` source with its 4 corner coordinates. No reprojection is needed for display.

### 5.2 Cleaning

- Mask overlay pixels: strongly saturated yellow, green or cyan pixels on the grey IR/WV/VIS images (coastlines, borders, grid). Fill them by a median of neighbouring pixels (`cv2.inpaint` or a 3×3 median of unmasked neighbours).
- The header and legend strip lies outside the crop, so it is ignored automatically.
- Read the scan time:
  - Primary: `Last-Modified` header, rounded down to the nearest :00 or :30 after subtracting about 15 min. Store it as `scan_start_utc`.
  - Optional: OCR the header with `pytesseract` to read the exact `GMT:dd-mm-yyyy/(HHMM-HHMM)`, and keep it if the parse succeeds.
  - Always store `last_modified_utc` and `fetched_at_utc` as well.

### 5.3 Metrics per frame

On the cleaned IR1 crop (grey 0–255; brighter means colder, higher cloud):
- **Per-frame normalisation:** because of the 1% stretch, also compute percentiles over the **whole** 2002×2242 frame. Express each pixel as a within-frame percentile, which is steadier than raw grey values.
- **Cloud index (0–1)** per pixel = normalised brightness.
- **Cold-cloud flag** = pixel at or above the frame's ~90th percentile **and** at or above an absolute grey floor (tune this; start at 200). Deep convective cloud is what usually rains in Sri Lanka.
- Aggregate per **0.1° grid cell** and per **estate analysis area**: `mean_cloud_index`, `cold_cloud_fraction`, `max_cloud_index`, and the 1-hour trend (Δ against the frame 2 steps back).
- **CTBT image (when available):** map its legend colours to °C bins. Build the colour → bin table once, by sampling the legend bar at the bottom. Then compute the **fraction of the area colder than −40 °C / −60 °C**. This is the best cold-cloud signal from the IMD JPGs because the colours are absolute. Store it with its own (older) timestamp.
- VIS: store it and show it, but use it in metrics only in daytime (solar elevation > 15°).

### 5.4 Nowcast (0–3 h, cloud advection)

- Take the last 3 IR1 crops (about 1 h) and compute dense optical flow (OpenCV Farnebäck, or `pysteps` Lucas–Kanade / DARTS).
- Smooth the motion field and push the latest cloud-index field forward to **+30, +60, +120, +180 min** (semi-Lagrangian advection; `pysteps.extrapolation` does this).
- Save the projected fields as PNGs for the map, plus projected per-estate `cold_cloud_fraction`.
- Accuracy drops fast beyond about 2 h because convective cells grow and decay. Show a confidence that **fades with lead time**.

### 5.5 Rain risk score (Phase 1: transparent heuristic)

For each estate and each lead time *t*:

```
sat_signal(t)  = nowcast cold_cloud_fraction(t)          (0–1), weighted heavier for t ≤ 1h
model_signal(t)= Open-Meteo precipitation_probability(t)/100, boosted if precipitation(t) ≥ 1 mm
risk(t)        = w_sat(t) * sat_signal + (1 - w_sat(t)) * model_signal
w_sat: 0.7 at +30 min → 0.5 at +1 h → 0.3 at +3 h → 0 beyond 3 h (pure model)
Levels: Low < 0.3 ≤ Moderate < 0.55 ≤ High < 0.75 ≤ Very high
```

Keep the weights and thresholds in a config table so they can be tuned without redeploying.

### 5.6 Phase 3: learned model (once we have about 2–3 months of frames)

- Labels: GPM IMERG half-hourly rain over each estate's analysis area (and gauges if available).
- Features: satellite metrics and their trends, the CTBT cold fractions, Open-Meteo forecast values, hour of day, month, ENSO/monsoon phase.
- Model: gradient boosting (LightGBM). Predict P(rain ≥ 1 mm in next 1 h / 3 h). Validate with **time-based** splits.
- Report Brier score, ROC-AUC and a reliability diagram on an admin "Model" page.
- Replace the heuristic only if the model beats it on held-out months.

---

## 6. Database schema (Supabase / Postgres + PostGIS)

```sql
create extension if not exists postgis;

create table frames (
  id               bigserial primary key,
  channel          text not null check (channel in ('ir1','vis','wv','ctbt')),
  scan_start_utc   timestamptz not null,
  last_modified_utc timestamptz,
  fetched_at_utc   timestamptz not null default now(),
  sha256           text not null unique,
  width int, height int,
  raw_path         text,          -- storage: raw/{channel}/{yyyy}/{mm}/{dd}/{HHMM}.jpg
  crop_path        text,          -- storage: crops/{channel}/.../{HHMM}.webp
  crop_bounds      jsonb,         -- [[lon,lat] x4] corners for MapLibre
  status           text not null default 'ok',  -- ok | needs_review | failed
  unique (channel, scan_start_utc)
);

create table estates (
  id serial primary key,
  name text not null, slug text unique not null,
  geom geometry(MultiPolygon, 4326) not null,
  centroid geometry(Point, 4326),
  area_ha numeric, buffer_km numeric default 12,
  created_at timestamptz default now()
);

create table estate_frame_metrics (
  frame_id bigint references frames(id) on delete cascade,
  estate_id int references estates(id) on delete cascade,
  mean_cloud_index real, max_cloud_index real,
  cold_cloud_fraction real, trend_1h real,
  frac_below_m40 real, frac_below_m60 real,   -- from CTBT when available
  primary key (frame_id, estate_id)
);

create table grid_frame_metrics (          -- 0.1° cells over Sri Lanka
  frame_id bigint references frames(id) on delete cascade,
  cell_id int, mean_cloud_index real, cold_cloud_fraction real,
  primary key (frame_id, cell_id)
);

create table nowcasts (
  id bigserial primary key,
  base_frame_id bigint references frames(id),
  lead_min int not null,               -- 30, 60, 120, 180
  field_path text,                      -- storage PNG for map
  created_at timestamptz default now()
);

create table estate_nowcast (
  nowcast_id bigint references nowcasts(id) on delete cascade,
  estate_id int references estates(id),
  cold_cloud_fraction real, risk real, risk_level text,
  primary key (nowcast_id, estate_id)
);

create table om_forecasts (            -- Open-Meteo
  id bigserial primary key,
  fetched_at_utc timestamptz not null,
  location_type text check (location_type in ('grid','estate')),
  location_id int not null,
  valid_time_utc timestamptz not null,
  precipitation real, precipitation_probability real, rain real, showers real,
  cloud_cover real, cloud_cover_low real, cloud_cover_mid real, cloud_cover_high real,
  cape real, rh_2m real, weather_code int,
  unique (location_type, location_id, fetched_at_utc, valid_time_utc)
);

create table config (key text primary key, value jsonb);   -- risk weights, thresholds
create table ingest_log (id bigserial primary key, ts timestamptz default now(),
  job text, ok boolean, message text, om_calls int);
```

- Turn on RLS. Give `anon` read-only access to everything except `ingest_log` and `config`. Use the service role key only in the worker.
- **Retention (keeps Storage small):**
  - Keep **crops forever**. As WebP each crop is about 20–60 KB, so roughly 10 MB/day for all channels.
  - Keep **raw full frames for 14 days**, then delete them with a nightly job.
  - Keep `om_forecasts`: the latest run for every valid time, plus one run a day for backtesting. Prune the rest.

---

## 7. Dashboard UI

**Layout (desktop):** a full-height map on the left (about 70%) and an estate panel on the right. Stack them on mobile.

1. **Map (MapLibre)**
   - Basemap: light, muted. Sri Lanka district boundaries are optional (geoBoundaries ADM2).
   - **Satellite layer** (`image` source using the stored crop and `crop_bounds`). The channel switcher offers IR · VIS · WV · CTBT, and there is an opacity slider.
   - **Estates layer:** polygons, plus the buffer shown as a dashed outline, coloured by current **risk level**. Click an estate to select it.
   - **Nowcast layer** (toggle): projected cloud field for the chosen lead time.
   - **Open-Meteo layer** (toggle): a 0.25° grid heatmap of precipitation for the chosen hour.
2. **Timeline bar** (under the map)
   - The last **24 h** of frames by default, with a range picker for 3 h / 24 h / 72 h / 7 d / custom.
   - Play/pause (adjustable fps), step back/forward, and a "Live" button that jumps to the latest frame.
   - The bar continues past "now" into **+30 to +180 min (nowcast)** and then **+hours (Open-Meteo)**, shown in a different colour so observed and predicted are clearly separate.
   - Preload neighbouring frames for smooth playback.
   - Show the frame's IST time prominently, plus how old the data is ("Latest frame: 11:00 IST · 47 min ago"). Turn the indicator amber after 60 min without a new frame and red after 120 min.
3. **Estate panel**
   - A list of estate cards: name, risk badge for the next 3 h, a cloud-index sparkline for the last 6 h, and expected rain for the next 24 h from Open-Meteo.
   - Selected estate detail:
     - a **combined chart** with the last 24 h observed cloud index, the nowcast, and the Open-Meteo hourly precipitation bars plus probability line for 7 days;
     - the monthly climatology comparison (ERA5);
     - a "Download CSV" button.
4. **Header:** title, last-updated time, a link to an "About & caveats" modal, and attribution for IMD / ISRO INSAT-3DS and Open-Meteo (CC BY 4.0).
5. **Admin (protected with Supabase Auth):** estate KML upload, risk-config editor, ingest health (last runs, failures, Open-Meteo call count), and the frame review queue (`needs_review`).

**Caveats modal text (must ship):** "Cloud metrics are derived from IMD's display imagery, not calibrated satellite data. Nowcasts extrapolate cloud motion and are unreliable beyond about 2 hours. Rain risk combines this with Open-Meteo model forecasts. Use for situational awareness only; refer to the Department of Meteorology, Sri Lanka for official forecasts and warnings."

---

## 8. Project structure

```
/app
  /(dashboard)/page.tsx            – map + timeline + estate panel
  /estates/[slug]/page.tsx         – shareable estate detail
  /admin/...                       – estates, config, health
  /api/frames/route.ts             – list frames by channel + time range
  /api/estates/route.ts            – GeoJSON of estates + latest risk
  /api/estates/[slug]/series/route.ts – metrics + nowcast + OM series
  /api/forecast/grid/route.ts      – OM grid for a valid time
/components  (Map, TimelineBar, ChannelSwitcher, EstateCard, EstateChart, CaveatsModal)
/lib         (supabase client, time utils IST/UTC, risk levels, types)
/data/kml    – estate KML files (provided)
/scripts     – import-kml.ts, seed-grid.ts (0.1° and 0.25° land cells for SL)
/worker      – ingest.py, process.py, nowcast.py, openmeteo.py, calibrate.py,
               calibration.json, requirements.txt
/.github/workflows/ingest.yml      – */10 cron for satellite, 0 */3 for Open-Meteo
/supabase/migrations               – schema above
```

**Environment variables:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (worker only), `IMD_BASE_URL=https://mausam.imd.gov.in/Satellite/`, `OPEN_METEO_BASE=https://api.open-meteo.com`, `MAP_STYLE_URL`.

**Being polite to IMD:**
- Send a descriptive `User-Agent` with a contact email.
- Use `HEAD` before `GET`, and only `GET` when `Last-Modified` or `Content-Length` has changed.
- Make at most 4 requests per poll, with timeouts and exponential backoff. Never hammer the server.

---

## 9. Build phases and acceptance criteria

**Phase 0: Calibration (do first)**
- `calibrate.py` produces `calibration.json` and `calibration_check.png`, and the coastline overlay lines up within 2 px.

**Phase 1: MVP**
- The ingest worker runs on cron, stores new IR1/VIS/WV/CTBT frames with no duplicates, and saves the Sri Lanka crops.
- The 9 estates are imported from KML, and per-estate and grid metrics are computed for every frame.
- Open-Meteo is pulled every 3 h for the grid and the estates.
- The dashboard shows the map, the satellite overlay with channel switcher, the 24 h timeline with playback, estate polygons and estate cards with Open-Meteo charts.
- The heuristic risk is shown, using Open-Meteo only until the nowcast exists.
- Done when: 48 h of unattended running produces about 96 IR1 frames with less than 5% missing, and the dashboard loads in under 3 s.

**Phase 2: Nowcast and MOSDAC**
- Optical-flow nowcast with +30/60/120/180 min fields and the blended risk score.
- Timeline extended into the future.
- Optional: MOSDAC IMR/HEM ingestion as a calibrated rain layer.

**Phase 3: Validation and learned model**
- Ingest IMERG and score the heuristic against it.
- Train the LightGBM model, add the admin "Model" page with metrics, and switch to the model only if it is better.
- Optional: alerts (email or WhatsApp) when an estate goes to High or Very high.

---

## 10. Open questions for the user

1. Is this for IWMI internal / research use, or a commercial Luminos product? This decides whether we need the Open-Meteo commercial plan and whether IMD's reuse terms allow it.
2. Can we get estate rain-gauge data (even daily) for validation?
3. Should the dashboard be public, or behind a login?
4. Is there a preferred alert channel later (WhatsApp, email)?
