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

const IMAGE_BATCH_LIMIT = 20;

export async function onRequestPost({ env }) {
  try {
    const [breweryPages, beerPages] = await Promise.all([
      notionQueryAll(env, env.NOTION_BREWERIES_DB_ID, {}),
      notionQueryAll(env, env.NOTION_BEERS_DB_ID, {}),
    ]);

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
    const prevRaw = await env.DASH_KV.get('dataset');
    const prev = prevRaw ? JSON.parse(prevRaw) : null;
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

    // Cache a batch of not-yet-cached images into R2.
    const toCache = beers.filter((b) => b._rawImageUrl && !b.imageCached).slice(0, IMAGE_BATCH_LIMIT);
    let imagesCachedThisRun = 0;
    for (const beer of toCache) {
      try {
        const imgRes = await fetch(beer._rawImageUrl);
        if (!imgRes.ok) continue;
        const key = `beer/${beer.id}`;
        await env.DASH_IMAGES.put(key, imgRes.body, {
          httpMetadata: { contentType: imgRes.headers.get('content-type') || 'image/jpeg' },
        });
        beer.imageKey = key;
        beer.imageCached = true;
        imagesCachedThisRun++;
      } catch {
        // leave uncached; will retry on next sync
      }
    }

    const imagesRemaining = beers.filter((b) => b._rawImageUrl && !b.imageCached).length;
    for (const b of beers) delete b._rawImageUrl;

    const dataset = {
      lastSyncedAt: new Date().toISOString(),
      beers,
      breweries,
    };
    await env.DASH_KV.put('dataset', JSON.stringify(dataset));

    return json({
      ok: true,
      lastSyncedAt: dataset.lastSyncedAt,
      totals: { beers: beers.length, breweries: breweries.length },
      imagesCachedThisRun,
      imagesRemaining,
    });
  } catch (err) {
    return errorResponse(err.status || 500, err.message || 'Sync failed');
  }
}
