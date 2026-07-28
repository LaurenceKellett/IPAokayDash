# 🍺 IPAokay Dashboard

A read-only analytics dashboard over the IPAokay **Beers** and **Breweries** Notion databases — scores, ABV/rating correlation, brew-tag and brewery breakdowns, and logging trends. Deployed to **dashboard.ipaokay.co.uk**.

This is a companion to the existing [IPAokay Publisher](../IPAOkay) app (`post.ipaokay.co.uk`), which already writes into the same two Notion databases. This dashboard only reads from them.

---

## Architecture

| Layer | Tech |
|---|---|
| Hosting | Cloudflare Pages (Git-connected — auto-deploys on push to `main`, no GitHub Actions needed) |
| Frontend | Vanilla JS, single `index.html` — no build step |
| Backend | Cloudflare Pages Functions (`functions/`) |
| Data store | Cloudflare KV (`DASH_KV`) — one JSON blob, refreshed on demand |
| Image cache | Cloudflare R2 (`DASH_IMAGES`) — Notion's file URLs expire, so photos are downloaded once and served from R2 |
| Source of truth | Notion API v2022-06-28 (read-only) |

This deliberately mirrors the **IPAokay Publisher** setup (Pages + Functions + Git auto-deploy, same Notion token) rather than the Task Manager's separate-Worker-plus-Pages split — one Cloudflare project, one custom domain, nothing extra to wire up. The **visual design** (Plus Jakarta Sans, Material Symbols Rounded, card layout, topbar "sync dot") is taken from the Task Manager project and the `LK Design System.md` tokens, re-themed to an amber/hop-green palette.

### Why manual sync + R2 image cache

Notion's `Image` file property returns temporary signed S3 URLs that expire after a few hours, so they can't be linked to directly. Clicking **Sync now**:

1. Pages Function `POST /api/sync` paginates both Notion data sources, joins Beers → Breweries, and writes the result to KV (`GET /api/data` serves this instantly — no live Notion calls on page load).
2. For any beer photo not yet cached, downloads the current signed URL once and stores it in R2, then serves it forever after from `GET /img/:id`.
3. To stay under Cloudflare's per-request subrequest limit, only ~20 new images are cached per click. On a database this size (990 photos), **click Sync now a handful of times** after first deploy to fully backfill the image cache — after that, only genuinely new beers need caching.

---

## Setup

### 1. Connect GitHub to Cloudflare Pages

Cloudflare dashboard → **Pages** → **Create application** → **Connect to Git** → select the `IPAokayDash` repository → build output directory `/` (root), no build command.

### 2. Create the KV namespace and R2 bucket

```bash
wrangler kv namespace create DASH_KV
wrangler r2 bucket create ipaokay-dashboard-images
```

Copy the KV namespace id into `wrangler.toml` (`REPLACE_WITH_KV_NAMESPACE_ID`), then in the Pages project → **Settings → Functions**, bind:
- KV namespace `DASH_KV` → the namespace you created
- R2 bucket `DASH_IMAGES` → `ipaokay-dashboard-images`

### 3. Set the Notion secret

Pages → **ipaokay-dashboard** → **Settings → Environment variables** → add `NOTION_TOKEN` (Secret) — reuse the same Notion integration token already used by the IPAokay Publisher project (it's already shared with both the Beers and Breweries databases).

### 4. Configure custom domain

Pages → **Custom domains** → add `dashboard.ipaokay.co.uk`.

### 5. First sync

Open the deployed site and click **Sync now**. Repeat a few times on first run so all ~990 beer photos get backfilled into R2 (see above).

### 6. Access control

Not handled by this app — layer Cloudflare Zero Trust / Access on top of the Pages project separately.

---

## Local development

```bash
npm install -g wrangler
wrangler pages dev . --kv DASH_KV --r2 DASH_IMAGES
```

You'll need a `NOTION_TOKEN` available locally (e.g. `.dev.vars`, gitignored) to exercise `/api/sync` against real Notion data.

---

## Data mapping

### Beers (`e65103a556c14be78386ee6124ac536b`)

| Dashboard field | Notion property |
|---|---|
| Name | `Beer name` (title) |
| ABV | `ABV %` (number, 0–1) |
| Rating | `Rating` (number, 0–100) |
| Brew Tag / Family | `Brew Tag` (select) — grouped into families in `functions/_notion.js` |
| Brewery | `Breweries` (relation) |
| Photo | `Image` (file) → cached to R2, served via `/img/:id` |
| Pipeline status | `Photograph`, `Content` (status) |
| Logged | `Created time` |
| Posted | `Posted` (date), `Beer Link` (url) |

Intentionally excluded: `Instagram Caption`, `Caption Prompt`, `Page Content`, `Page Content Prompt`, `Diary` relation, `Scheduled` button.

### Breweries (`950e83c73ade492bb8aa5360951ea150`)

| Dashboard field | Notion property |
|---|---|
| Name | `Name` (title) |
| Summary | `Summary` (text) |
| Location | `📍` (text) |
| Website / Instagram / Hashtags | as named |
| Affiliate status | `Affiliate` (status) |

Beer count and average rating per brewery are computed client-side from the joined Beers array rather than trusting Notion's own rollups, so they always reflect the latest sync.
