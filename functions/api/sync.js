/**
 * POST /api/sync
 *
 * Pulls the Beers + Breweries data sources from Notion, joins them, and
 * writes the result to KV (env.DASH_KV, key "dataset") for /api/data to
 * serve instantly with no live Notion calls.
 *
 * Notion's beer photos are on expiring signed URLs, so newly-seen images
 * get downloaded once and cached into R2 (env.DASH_IMAGES). To stay well
 * under the Workers per-request subrequest limit, only a batch of
 * previously-uncached images is processed per click — click "Sync now"
 * again to keep backfilling until "imagesRemaining" hits 0. Once an image
 * is cached it's never re-fetched from Notion.
 */
import {
  notionQueryAll,
  getTitleText,
  getRichText,
  getNumber,
  getSelectName,
  getStatusName,
  getUrl,
  getDateStart,
  getRelationIds,
  getFileUrl,
  brewTagFamily,
  json,
  errorResponse,
} from '../_notion.js';

const IMAGE_BATCH_LIMIT = 40;
const IMAGE_FETCH_CONCURRENCY = 8;

export async function onRequestPost({ env }) {
  try {
    let breweryPages, beerPages;
    try {
      [breweryPages, beerPages] = await Promise.all([
        notionQueryAll(env, env.NOTION_BREWERIES_DB_ID, {}),
        notionQueryAll(env, env.NOTION_BEERS_DB_ID, {}),
      ]);
    } catch (e) {
      throw new Error(
        `Querying Notion failed (breweries db id "${env.NOTION_BREWERIES_DB_ID}", beers db id "${env.NOTION_BEERS_DB_ID}", token set: ${!!env.NOTION_TOKEN}): ${e.message}`
      );
    }

    const breweries = breweryPages.map((page) => {
      const p = page.properties;
      return {
        id: page.id,
        name: getTitleText(p['Name']),
        summary: getRichText(p['Summary']),
        location: getRichText(p['📍']),
        website: getUrl(p['Website']),
        ipaokayLink: getUrl(p['IPAOkay Link']),
        instagram: getRichText(p['Instagram']),
        hashtags: getRichText(p['Hashtags']),
        affiliate: getStatusName(p['Affiliate']),
      };
    });

    // Preserve image-cache bookkeeping across syncs.
    let prev;
    try {
      const prevRaw = await env.DASH_KV.get('dataset');
      prev = prevRaw ? JSON.parse(prevRaw) : null;
    } catch (e) {
      throw new Error(`Reading previous dataset from KV failed: ${e.message}`);
    }
    const prevBeerById = Object.fromEntries((prev?.beers || []).map((b) => [b.id, b]));

    const beers = beerPages.map((page) => {
      const p = page.properties;
      const brewTag = getSelectName(p['Brew Tag']);
      const rawImageUrl = getFileUrl(p['Image']);
      const prevBeer = prevBeerById[page.id];
      return {
        id: page.id,
        name: getTitleText(p['Beer name']),
        abv: getNumber(p['ABV %']),
        rating: getNumber(p['Rating']),
        brewTag,
        brewTagFamily: brewTagFamily(brewTag),
        brewTagDetail: getRichText(p['Brew Tag Detail']),
        breweryIds: getRelationIds(p['Breweries']),
        createdTime: page.created_time,
        posted: getDateStart(p['Posted']),
        photograph: getStatusName(p['Photograph']),
        content: getStatusName(p['Content']),
        beerLink: getUrl(p['Beer Link']),
        // Not persisted: the raw Notion URL expires within hours, so it's only
        // used transiently below to populate R2 the first time we see it.
        _rawImageUrl: rawImageUrl,
        imageKey: prevBeer?.imageKey || null,
        imageCached: !!prevBeer?.imageCached,
      };
    });

    // Diagnostics for "no photos ever show up": if literally no beer came
    // back with a raw image URL, the `Image` files property either isn't
    // populated or the property name in Notion doesn't match — surface the
    // actual property names on the first page so that's easy to tell apart
    // from a fetch/R2 failure below.
    const imagesFoundOnPages = beers.filter((b) => b._rawImageUrl).length;
    const diagnostics = {};
    if (imagesFoundOnPages === 0 && beerPages.length > 0) {
      diagnostics.noImageUrlsFound = true;
      diagnostics.beerPropertyNames = Object.keys(beerPages[0].properties);
      diagnostics.imagePropertyType = beerPages[0].properties['Image']?.type || null;
    }

    // Cache a batch of not-yet-cached images into R2, a few at a time in
    // parallel so a full batch fits comfortably inside one request's wall
    // time without blowing the subrequest limit.
    if (!env.DASH_IMAGES) {
      diagnostics.r2NotBound = true;
    }
    const toCache = env.DASH_IMAGES
      ? beers.filter((b) => b._rawImageUrl && !b.imageCached).slice(0, IMAGE_BATCH_LIMIT)
      : [];
    let imagesCachedThisRun = 0;
    const imageErrors = [];
    async function cacheOne(beer) {
      try {
        const imgRes = await fetch(beer._rawImageUrl);
        if (!imgRes.ok) {
          if (imageErrors.length < 5) imageErrors.push(`${beer.name}: fetch ${imgRes.status}`);
          return;
        }
        const key = `beer/${beer.id}`;
        await env.DASH_IMAGES.put(key, imgRes.body, {
          httpMetadata: { contentType: imgRes.headers.get('content-type') || 'image/jpeg' },
        });
        beer.imageKey = key;
        beer.imageCached = true;
        imagesCachedThisRun++;
      } catch (e) {
        if (imageErrors.length < 5) imageErrors.push(`${beer.name}: ${e.message}`);
      }
    }
    for (let i = 0; i < toCache.length; i += IMAGE_FETCH_CONCURRENCY) {
      await Promise.all(toCache.slice(i, i + IMAGE_FETCH_CONCURRENCY).map(cacheOne));
    }
    if (imageErrors.length) diagnostics.imageErrors = imageErrors;

    const imagesRemaining = beers.filter((b) => b._rawImageUrl && !b.imageCached).length;
    for (const b of beers) delete b._rawImageUrl;

    const dataset = {
      lastSyncedAt: new Date().toISOString(),
      beers,
      breweries,
    };
    try {
      await env.DASH_KV.put('dataset', JSON.stringify(dataset));
    } catch (e) {
      throw new Error(`Writing dataset to KV failed: ${e.message}`);
    }

    return json({
      ok: true,
      lastSyncedAt: dataset.lastSyncedAt,
      totals: { beers: beers.length, breweries: breweries.length },
      imagesCachedThisRun,
      imagesRemaining,
      ...(Object.keys(diagnostics).length ? { diagnostics } : {}),
    });
  } catch (err) {
    return errorResponse(err.status || 500, err.message || 'Sync failed');
  }
}
