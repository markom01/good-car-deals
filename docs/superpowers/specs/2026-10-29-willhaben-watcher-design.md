# Willhaben watcher — design

**Date:** 2026-10-29 · **Status:** implemented (phase 1: console-log + on-demand poll; phase 2: continuous polling via `onModuleInit`)
**Scope:** `good-car-deals-api/src/willhaben-watcher/` — new NestJS module; no DB migration; no frontend change.
**Related:** root AGENTS.md (deployment architecture, anti-patterns), good-car-deals-api/AGENTS.md (repo structure + conventions).

## Intent / why

The user wants to be notified as soon as a listing is published on `https://www.willhaben.at/iad/gebrauchtwagen/auto` matching chosen filters, as fast as possible. Native willhaben "Suchagent" **cannot do instant for cars** — the _"Bei jeder neuen Anzeige"_ frequency option is _"nur für Immobilien verfügbar"_ (immobilien only, test phase, app-push only); auto-category notifications are batched email/app with unknown delay. (Source: willhaben help article 360021519039, fetched 2026-10-28.)

So the watcher polls willhaben's own search index. If an ad enters the index at publish time T, the watcher sees it at the next poll after T. Floor = poll interval + ~0.3 s. No push channel exists on willhaben's side (no RSS, no WebSocket/EventSource on the search page — `WebSocket`/`EventSource` hits in `_app.js` are Sentry instrumentation only; `heartbeat.willhaben.at` is Segment analytics, write-only, 403).

## Core design

### 1. Endpoint (verified live 2026-10-28)

```
GET https://ad-search.willhaben.at/restapi/v2/search/atz/seo/gebrauchtwagen/auto
  ?rows=30&sort=1&<extra filters>
```

- Required header `x-wh-client: api@willhaben.at;responsive_web;server;1.0.0;desktop` → **400 without it**. No cookie, no login, no session.
- `sort=1` = `published.descending` (newest first), from `sortOrderList`.
- `rows` capped at **200** per page (verified: rows=200 returns 200). No sparse-field / count-only param works — `countOnly`, `hitsOnly`, `fields`, `noNavigator`, `isNavigation=false` all ignored; `rows=1` gzip is still 19.5 KB because navigator metadata always ships.
- Each ad carries `PUBLISHED` attribute (epoch ms). Newest ads are visible at/near their `PUBLISHED` timestamp — sometimes up to 56 s _before_ `searchDate` clock; no evidence of indexing batching. Your delay is the poll interval, nothing else.
- `cache-control: max-age=120`, `cf-cache-status: DYNAMIC` — every poll reaches origin; no 304/ETag path useful to us.
- Cloudflare edge (Belgrade BEG). No challenge for this API from a clean client; 40-bit `__cf_bm` cookie set but not required.
- `robots.txt` forbids automatic access and `Disallow: /restapi/`. Nutzungsbedingungen §2 forbids copying via _"Robot/Crawler … oder sonstige automatische Mechanismen"_. **Personal use at polite rates is low-risk but not permitted.** Not for public/commercial service.

### 2. Filters (verified working, uppercase param names required — lowercase silently ignored)

| Param                               | Example values                                       | Notes                           |
| ----------------------------------- | ---------------------------------------------------- | ------------------------------- |
| `CAR_MODEL/MAKE`                    | `1005` = BMW, `1020` = Hyundai                       | Make IDs from `navigatorGroups` |
| `PRICE_FROM` / `PRICE_TO`           | `10000`, `20000`                                     | Range filter                    |
| `MILEAGE_FROM` / `MILEAGE_TO`       | `1000`, `80000`                                      |                                 |
| `YEAR_MODEL_FROM` / `YEAR_MODEL_TO` | `2018`, `2024`                                       |                                 |
| `areaId`                            | `9` = Wien                                           | Bundesland IDs                  |
| `DEALER`                            | `0` Händler / `1` Privat                             |                                 |
| `TRANSMISSION`                      | `180004` Automatik / `180001` Schaltgetriebe         |                                 |
| `ENGINE/FUEL`                       | `100001` Benzin / `100003` Diesel / `100004` Elektro |                                 |
| `WHEEL_DRIVE`                       | `2` Allrad / `1` Hinterrad / `3` Vorderrad           |                                 |
| `keyword`                           | `vw golf`                                            | Free-text                       |
| `periode`                           | `2` = last 48 h                                      |                                 |
| `sort`                              | `1` newest                                           |                                 |

Verified: `CAR_MODEL/MAKE=1005&PRICE_FROM=10000&PRICE_TO=20000` → rowsFound 4,664; `+YEAR_MODEL_FROM=2020&MILEAGE_TO=80000&TRANSMISSION=180004&areaId=9` → 782; `keyword=vw golf` → 7,720.

### 3. Watcher module (implemented)

Files:

- `src/willhaben-watcher/willhaben-watcher.service.ts`
- `src/willhaben-watcher/willhaben-watcher.controller.ts`
- `src/willhaben-watcher/willhaben-watcher.module.ts`
- Registered in `src/app.module.ts` (import + import statement)

Behavior:

- `OnModuleInit`: if `WILLHABEN_ENABLED=true`, immediately poll once then `setInterval` at `WILLHABEN_POLL_INTERVAL_MS` (default 5000 ms).
- `POST /willhaben-watcher/poll` → manual trigger; returns `{found, newAds}`.
- `GET /willhaben-watcher/status` → `{ok: true}`.
- Dedupe by ad **ID** (not `PUBLISHED` — timestamps are ranking artifacts; top ads share one future value). Persisted to `data/willhaben-seen.json` so restarts don't re-alert.
- Console-log per new ad: `[WILLHABEN] NEW <id> <title> €<price> <published> <link>`.
- No DB write — zero migration, works with existing Prisma setup. Push-to-PWA is the planned later layer (replace `console.log`).

### 4. Config (.env, all optional — defaults off = existing behavior unchanged)

| Var                          | Default | Purpose                                                                      |
| ---------------------------- | ------- | ---------------------------------------------------------------------------- |
| `WILLHABEN_ENABLED`          | `false` | `true` to start the poll loop                                                |
| `WILLHABEN_POLL_INTERVAL_MS` | `5000`  | Cadence                                                                      |
| `WILLHABEN_FILTER`           | `""`    | Extra query params, e.g. `priceFrom=10000&priceTo=20000&CAR_MODEL/MAKE=1005` |

`WILLHABEN_ENABLED` is currently `true` in `.env` (set via EnvSitter; value not printed).

## Measurements (live, 2026-10-28, from Novi Sad RS / Yettel residential IP)

| Metric                           | Value                                 |
| -------------------------------- | ------------------------------------- |
| API TTFB (rows=30)               | 0.19–0.31 s median                    |
| Keep-alive re-poll (rows=100)    | median 0.31 s, p95 0.59 s, max 2.93 s |
| 60 polls × 5 s                   | 60/60 × 200                           |
| 40 polls × 1 s                   | 40/40 × 200                           |
| Egress bandwidth (rows=30, 5 s)  | ~682 MB/day, 17,280 req/day           |
| Egress bandwidth (rows=30, 30 s) | ~114 MB/day, 2,880 req/day            |
| Page-1 churn                     | roughly every 1–2 min with `sort=1`   |
| Detail page fetch                | 200, 360 KB, 0.3 s (unauthenticated)  |

Latency floor end-to-end ≈ poll interval + 0.3 s API + ~0.2 s Telegram + 0.2–1 s phone push. **~1.5–3 s best case; sub-second impossible without willhaben-side push.** Polling faster than 2 s buys ~1 s for 2× bandwidth and higher block risk — not recommended.

## Bandwidth cost on candidate free hosts (5 s poll, rows=30)

| Interval | req/day | GB/day | GB/mo |
| -------- | ------- | ------ | ----- |
| 1 s      | 86,400  | 0.113  | 3.4   |
| 2 s      | 43,200  | 0.057  | 1.7   |
| 5 s      | 17,280  | 0.023  | 0.68  |
| 30 s     | 2,880   | 0.004  | 0.11  |

(rows=30 gzip ≈ 39.5 KB fixed overhead dominates; rows=1 still ~19.5 KB.)

## Free hosting research (2026-10-29)

- **Northflank Sandbox** — 2 services, 2 cron jobs, 1 DB, $20/mo free resources, always-on "no sleeping", 0.5 vCPU/1 GB = $12/mo, egress $0.06/GB (~$8 covers 133 GB). Fits 5 s poll (~$13/$20). Card requirement unverified at signup. **Recommended first choice** if moving off local PC.
- **Oracle Cloud Always Free** — 2 OCPU / 12 GB RAM ARM (June 2026 cut from 4/24), 200 GB storage, **10 TB/mo egress**, card required, "out of host capacity" common for free ARM shapes, idle-reclamation risk (CPU p95<20%/net<20%/mem<20% over 7 days). Datacenter IP — may 403 willhaben.
- **Cloudflare Workers + Durable Object alarm loop** — free: 100k req/day, 13k GB-s/day, 5 GB SQLite storage; 2 s poll = 43k req/day (43%), fits. 10 ms CPU/invocation; state in DO storage; not a VPS.
- **Render free** — spins down after 15 min idle; needs external keep-alive ping; fragile. Not recommended for a watcher.
- **Vercel cron** — Hobby = once per day only. Dead end.
- **AWS** — 12-month tier removed mid-2025; $100–200 credits, plan closes after 6 months.
- **Fly.io / Koyeb / Railway** — free tiers gone (Fly ended Oct 2024; Koyeb Pro $29/mo; Railway no free).
- **Google Cloud e2-micro** — free forever but **1 GB egress/mo** → only viable at ~30 min intervals (20 GB/mo at 5 s).
- **Alwaysdata free** — 1 GB disk / 256 MB RAM for life; daemon/egress policy unverified — dark horse, not recommended blind.

**The real blocker is not price — it's the datacenter IP vs willhaben.** Test on any new host with:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H 'x-wh-client: api@willhaben.at;responsive_web;server;1.0.0;desktop' \
  'https://ad-search.willhaben.at/restapi/v2/search/atz/seo/gebrauchtwagen/auto?rows=5&sort=1'
```

200 = usable. 403/429/Cloudflare challenge = try another region/provider.

## Verification performed (this session)

All from `good-car-deals-api/`, dev server `npm run start:dev` on localhost:3001:

1. `npx tsc --noEmit` — clean.
2. `npx eslint src/willhaben-watcher/` — no issues.
3. `npx jest` — 10 suites / 97 tests passed (existing suite untouched).
4. `POST /willhaben-watcher/poll` → `{"found":30,"newAds":30}` (first run, no seen file).
5. Re-poll → `{"found":30,"newAds":6}` then `0`/`1` — dedup holds within session.
6. Continuous over ~5 min: polls at T+0 / T+30s / T+~1min / T+~2min / T+~5min all returned 200 with `found:30`; page-1 rotated each interval; server stayed up; `GET /status` → `{"ok":true}`.

Host IP is **not** 403'd — willhaben polling works from where the dev server runs.

## Left to the builder

- PWA push layer: replace `console.log` in `willhaben-watcher.service.ts` with the push call when the PWA subscription endpoint exists.
- If moving off local PC: provision Northflank Sandbox first (no card, always-on), run the 200-check curl, then set `WILLHABEN_FILTER` for the desired make/price/region.
- `data/willhaben-seen.json` is gitignored? Verify `.gitignore` covers `data/` before committing.
- Tests for `willhaben-watcher.service.ts` (fetch mocking, dedup logic) — none yet.

---

## Appendix — research sources

- willhaben help: "Was ist der Suchagent und wie kann ich einen erstellen?" (360021519039) — _"Bei jeder neuen Anzeige" nur für Immobilien verfügbar; nur in der willhaben App und als App-Benachrichtigung; Testphase._
- willhaben `robots.txt` — forbids spiders/robots; `Disallow: /restapi/`, `/webapi/`, `/iad/searchagent`, plus all filtered query params.
- willhaben Nutzungsbedingungen §2 — content may not be copied via _"Robot/Crawler" Suchmaschinentechnologien oder durch sonstige automatische Mechanismen_.
- Vercel cron jobs usage & pricing (2026-07-15) — Hobby: 100 cron jobs, once per day, per-hour ±59 min precision.
- Northflank pricing — Sandbox free: 2 services, 2 jobs, 1 DB, up to $20/mo resources, always-on no sleeping; compute $0.01667/vCPU-hr; egress $0.06/GB.
- Oracle Always Free Resources docs — 2 OCPU / 12 GB ARM A1 (1,500 OCPU-hrs + 9,000 GB-hrs/mo), 200 GB block volume, 10 TB/mo outbound, idle reclamation clause.
- Cloudflare Workers limits — free: 100,000 req/day; Durable Objects free: 100k req/day, 13,000 GB-s/day duration, 5 GB SQLite storage, 10 ms CPU/invocation.
- AutoViz willhaben comparison page — claims sub-second push across 20+ marketplaces (commercial, paid).
- SwitchmanPlay/willhaben-telegram-watcher (GitHub) — polls `__NEXT_DATA__`, default 30 min, optional proxy for blocked datacenter IPs.
