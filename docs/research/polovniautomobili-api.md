# polovniautomobili.com — JSON API research

**Date:** 2026-10-29
**Status:** verified live (values below come from real responses, not docs)

## Verdict

The site does expose JSON endpoints. There is no public/official developer API
(no OpenAPI, `api/doc` returns `403 Access Denied`), but the frontend itself is a
Next.js app backed by a public REST service, and both are callable without auth:

1. **`core.polovniautomobili.com/api/v1/*`** — the real backend used by the Next.js
   frontend and the mobile web app. Public GETs, CORS enabled, no token needed.
2. **`www.polovniautomobili.com/_next/data/<buildId>/<page>.json`** — Next.js
   server-rendered page props as pure JSON. Works for search pages and ad detail
   pages.

Both replace HTML parsing entirely.

## Endpoint 1 — Core REST API

Base: `https://core.polovniautomobili.com/api/v1/`

| Endpoint                                                                     | Purpose                                             | Verified                                |
| ---------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------- |
| `GET classifieds/car/{adId}`                                                 | Full ad detail (~11 KB JSON)                        | 200                                     |
| `GET classifieds/car/{category}/{searchDomain}`                              | Search feed                                         | 500 (server error, unusable externally) |
| `GET classifieds/choices/{category}`                                         | All filter vocabularies (fuel, gearbox, chassis, …) | 200, 13 KB                              |
| `GET classifieds/choices/{category}/{filter}`                                | One filter vocabulary                               | 200                                     |
| `GET classifieds/{adId}/related-classifieds?brand=&model=&price=&year=`      | Related ads                                         | 200                                     |
| `GET home-page-classifieds/{category}/desktop`                               | Home listing feed, paginated                        | 200, 24/page                            |
| `GET home-page-classifieds/{category}/mobile`                                | Same, 8/page                                        | 200                                     |
| `GET brands/active/category/{category}/search-domain/{domain}`               | Brand list                                          | 500                                     |
| `GET models/active/brand/{brand}/category/{category}/search-domain/{domain}` | Model list                                          | 500                                     |
| `GET regions`                                                                | Region list                                         | 200                                     |
| `GET cities/major`                                                           | Major cities with lat/lon                           | 200, 18 KB                              |
| `GET classified/{adId}/map`                                                  | Seller location/phone block                         | 200                                     |
| `GET dealer/search/cities`                                                   | Dealer city filter                                  | 200                                     |
| `POST delta/search?<filters>`                                                | Search _analytics logging_ — not a search           | 422 without required body               |

The `classifieds/{category}/{searchDomain}` search route answers `500` for every
`searchDomain` value tried (`auto-oglasi`, `polovniautomobili`, `all`, `newest`,
`search`), so it is not usable from outside. Use endpoint 2 for search.

### Ad detail payload (trimmed)

```json
{
  "id": 30120777,
  "title": "Opel Astra K 1.6 CDTi S.S . SPORT",
  "brand": "Opel",
  "model": "Astra K",
  "year": 2018,
  "price": 6250,
  "basePrice": 6750,
  "discount": true,
  "discountPercentage": 7,
  "mileage": 167707,
  "engineVolume": 1598,
  "fuel": "Dizel",
  "power": 100,
  "horsePower": 136,
  "gearBox": "Manuelni 6 brzina",
  "chassis": "Karavan",
  "drive": "Prednji",
  "emissionClass": "Euro 6",
  "doors": "4/5 vrata",
  "seats": "5 sedišta",
  "wheelSide": "Levi volan",
  "airCondition": "Automatski",
  "registrationInPrice": false,
  "damaged": false,
  "fromAbroad": false,
  "status": "active",
  "publishDate": "2026-08-21 04:22:09",
  "renewDate": "2026-10-23 19:36:33",
  "description": "…",
  "images": [ … ],
  "owner": 2698047,
  "category": "car"
}
```

`publishDate` + `renewDate` are the fields that distinguish a genuinely new ad from
a bumped/renewed one — the same problem solved for Willhaben with
`FIRST_PUBLISHED` vs `PUBLISHED`.

## Endpoint 2 — Next.js data JSON

Search page:

```
GET https://www.polovniautomobili.com/_next/data/<buildId>/auto-oglasi/pretraga.json
    ?brand=Opel&model[0]=Astra&page=2&sort=basic
```

Returns `pageProps.searchResults`:

```json
{
  "totalItems": 1678,
  "page": 2,
  "pageCount": 68,
  "resultsPerPage": 25,
  "deltaApiQuery": "brand=Opel&model%5B0%5D=Astra&sort=basic",
  "results": [
    {
      "id": "30426635",
      "title": "Opel Astra …",
      "year": 2017,
      "mileage": 154000,
      "fuel": "Dizel",
      "engineVolume": 1598,
      "gearBox": "Manuelni 6 brzina",
      "power": 81,
      "price": 5490,
      "basePrice": 5990,
      "discount": true,
      "city": "Novi Sad",
      "imageMain": "https://cdn.polovniautomobili.com/…-370x278.jpg",
      "updatedAt": "2026-10-29 18:12:44",
      "status": "active",
      "brand": "Opel",
      "model": "Astra",
      "category": "car"
    }
  ]
}
```

110 KB per page of 25 (vs 780 KB HTML for the same page).

Ad detail page:

```
GET https://www.polovniautomobili.com/_next/data/<buildId>/auto-oglasi/<adId>/<slug>.json
```

68 KB JSON with `pageProps.page === "DetailsPage"`, `contactDetails`,
description, full spec set.

`<buildId>` is in `__NEXT_DATA__.buildId` on any HTML page (currently
`build-TfctsWXpff2fKS`). It changes on deploy, so cache it and refresh on 404.

## Constraints and risks

- **Undocumented.** No contract, no versioning promise, no support. Shape and
  paths can change with any deploy.
- **`robots.txt` disallows `/api/`.** That is a crawler directive, not an
  authorization. Automated use is still governed by the site Terms of Use.
- **`x-robots-tag: noindex, nofollow`** on API responses confirms it is internal.
- **`/api/doc` returns `403 Access Denied`** — they have docs, not for us.
- **No rate limiting observed** (5 sequential calls → 200), but do not rely on it.
- **Caching:** `cache-control: public, max-age=86400` on reference endpoints.
- **Cloud access:** `r.jina.ai` (cloud egress) fetched both `core.polovniautomobili.com/api/v1/regions`
  and the search page successfully, so the blanket "all cloud IPs get 403" claim
  is at least not true for every provider. Keep the residential path as fallback
  until Render is tested directly.
- **`sort=basic`** is the site default; other values come from the search form
  (`sort=newest`, price sorts). `page` is 1-based.

## What this changes for the scraper

Mapping from API fields to the existing `RawListingData` contract:

| RawListingData | Source                                                                           |
| -------------- | -------------------------------------------------------------------------------- |
| `title`        | `title`                                                                          |
| `listingUrl`   | `https://www.polovniautomobili.com/auto-oglasi/{id}/{slug}` (build from `title`) |
| `price`        | `price`                                                                          |
| `priceNote`    | `priceFixed` (detail) / `discount` flag                                          |
| `year`         | `year`                                                                           |
| `mileageKm`    | `mileage`                                                                        |
| `fuelType`     | `fuel`                                                                           |
| `engineVolume` | `engineVolume`                                                                   |
| `powerKw`      | `power`                                                                          |
| `transmission` | `gearBox`                                                                        |
| `location`     | `city`                                                                           |

Everything the current `ApiClientService` extracts from JSON is a
first-class field in the feed.

## Implemented

Branch `feat/json-api-scraper`:

- `good-car-deals-api/src/scraper/api-client.service.ts` — `fetchSearchPage(page)` reads
  `/_next/data/<buildId>/auto-oglasi/pretraga.json`, maps results to `RawListingData`,
  drops non-active ads; `isListingActive(adId)` reads
  `core.polovniautomobili.com/api/v1/classifieds/car/{id}`.
- `good-car-deals-api/src/scraper/http.service.ts` — `fetchJson<T>()` and `HttpError`
  (same impit transport, retries and proxy as `fetchPage`).
- `good-car-deals-api/src/scraper/scraper.service.ts` — paginates the JSON feed
  (`1..min(pageCount, 100)`), dedupes by URL, liveness through the detail API.
- No brand/model filter: the feed is scraped whole-site (`SCRAPER_BRAND` /
  `SCRAPER_MODEL` are unused). Each result's `brand` + `model` is stored as a
  brand-scoped label (`"Opel Astra"`) so per-model comps never mix brands.
- Listing URLs are `/auto-oglasi/<id>/<slug>` — the slug is generated from the
  title and is cosmetic (the site canonicalises any slug), but an **id-only URL
  renders the search page**, so the slug is required for working links.
- HTML parser kept as legacy fallback; it is no longer on the scrape path.

Live verification (2026-10-30): 100 pages → 2497 unique listings saved, 0 missing
year, 0 missing price, 0 missing mileage; all 2497 URLs slug-based (0 id-only);
sampled links across 5 brands resolve to the matching canonical ad page.
Whole feed reports 2792 pages / ~69.8k ads, so the 100-page cap is a slice.

## Not needed: REA

`morluto/rea` is a reverse-engineering toolkit (APK, Electron, native binaries,
browser network capture), not a client library for this site. The API was found
from the public JS bundles alone, so installing it adds nothing for this task.

It would only help if we needed to decompile the Android app
(`com.infostud.android.pa`) for authenticated flows — e.g. saved searches,
push notifications, or the mobile-only search endpoint.
