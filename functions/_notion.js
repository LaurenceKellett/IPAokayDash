/**
 * Shared Notion API helpers for the IPAokay Dashboard Pages Functions.
 * Mirrors the pattern used in the Task Manager worker (notionFetch/notionQueryAll).
 */

export const NOTION_VERSION = '2022-06-28';
export const NOTION_API = 'https://api.notion.com/v1';

export function notionHeaders(env) {
  return {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

export async function notionFetch(env, path, init) {
  const res = await fetch(NOTION_API + path, { ...init, headers: notionHeaders(env) });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Notion API error ${res.status}: ${text}`);
    err.status = res.status >= 400 && res.status < 500 ? res.status : 502;
    throw err;
  }
  return res.json();
}

export async function notionQuery(env, dbId, body) {
  return notionFetch(env, `/databases/${dbId}/query`, { method: 'POST', body: JSON.stringify(body || {}) });
}

export async function notionQueryAll(env, dbId, body) {
  let results = [];
  let cursor;
  do {
    const page = await notionQuery(env, dbId, { ...body, start_cursor: cursor });
    results = results.concat(page.results);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return results;
}

// ==================== Property readers ====================

export function getTitleText(prop) {
  return (prop && prop.title ? prop.title.map((t) => t.plain_text).join('') : '') || '';
}
export function getRichText(prop) {
  return (prop && prop.rich_text ? prop.rich_text.map((t) => t.plain_text).join('') : '') || '';
}
// Same as getRichText, but drops any segment that's a hyperlink (has an
// href) — used for fields like the brewery Summary, which leads with a
// location tag and a link to the brewery page before the actual
// descriptive text, none of which should be pulled through.
export function getRichTextSkipLinks(prop) {
  return (prop && prop.rich_text
    ? prop.rich_text.filter((t) => !t.href).map((t) => t.plain_text).join('')
    : '') || '';
}
// Notion text can contain literal HTML anchor markup typed straight into
// the field (not a real Notion hyperlink, so getRichTextSkipLinks' href
// check won't catch it) — e.g. "Breweries that relate to this include
// <a href="...">Other Brewery</a>". Unwrap anchors to their link text, then
// drop any other stray tags, so only plain prose is ever pulled through.
export function stripHtmlLinks(text) {
  return (text || '')
    .replace(/<a\b[^>]*>(.*?)<\/a>/gis, '$1')
    .replace(/<\/?[^>]+>/g, '');
}
// Many brewery Summary fields lead with a duplicate location line and a
// website link before the actual description, e.g. "Breda, Netherlands\n
// craftnationbeers.com\n\nCraft Nation is a brewery based in...". The
// location is already shown separately (the 📍 field) and the link is gone
// once stripHtmlLinks unwraps it, so that whole leading block is just
// noise — drop it and start from the real descriptive paragraphs. Only
// strips when the first line clearly echoes the known location (allowing
// for a leading 📍/🔗 marker), so summaries that just start straight into
// prose (most of them) are left untouched.
export function stripBrewerySummaryPreamble(text, location) {
  if (!text || !location) return text || '';
  const breakIndex = text.indexOf('\n\n');
  if (breakIndex === -1) return text;
  const preamble = text.slice(0, breakIndex);
  const rest = text.slice(breakIndex).replace(/^\n+/, '');
  const firstLine = preamble.split('\n')[0].trim();
  const loc = location.trim().toLowerCase();
  const matchesLocation = loc && firstLine.length <= loc.length + 20 && firstLine.toLowerCase().endsWith(loc);
  return matchesLocation ? rest : text;
}
// The location is already shown on its own line (the 📍 field, with a
// location pin icon) above the summary, so drop it back out of the prose
// itself where it's just restating the same fact — "Craft Nation is a
// brewery based in Breda, Netherlands." becomes "Craft Nation is a
// brewery.". Only matches the known connector phrasings this dataset's
// generated summaries actually use (located/based/nestled/situated in
// ...), each optionally followed by further "City, Country"-style
// continuations. The clause is only ever removed when it closes cleanly —
// at real sentence-end, or at a comma immediately followed by a lowercase
// word resuming the main clause (e.g. "...London, is renowned" or
// "...London, with a legacy"). A capitalized word after the comma instead
// (e.g. "...Zealand, Yeastie Boys has...") means the "continuation" run
// into the NEXT clause's actual subject, not another place name, so
// nothing fires and the sentence is left alone rather than mangled.
export function stripLocationFromSummary(text, location) {
  if (!text || !location) return text || '';
  const parts = location.split(',').map((s) => s.trim()).filter(Boolean);
  const candidates = [...new Set([location.trim(), parts[0], parts[parts.length - 1]])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const loc of candidates) {
    const escaped = loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // No 'i' flag: the connector words only ever appear lowercase in this
    // generated prose, and dropping the flag keeps the continuation's
    // [A-Z] check honestly case-sensitive — with /i it matches ANY word
    // and swallows whatever text follows (e.g. "is"/"has been").
    const connector = '\\b(?:located|based|nestled|situated)\\s+in\\s+(?:the\\s+heart\\s+of\\s+)?' + escaped + '\\b';
    const continuation = '(?:,[ \\t]*[A-Z][a-zA-Z]+(?:\\s+[A-Z][a-zA-Z]+)*)*';
    const closer = '(?:(?=[.!?])|,[ \\t]*(?=[a-z]))';
    // Appositive form, bounded by a comma on both sides — e.g. "Kona
    // Brewing Co, nestled in the heart of Hawaii, is a vibrant...".
    const appositive = new RegExp(',[ \\t]*' + connector + continuation + closer, 'g');
    out = out.replace(appositive, (m) => (m.trimStart()[0] === ',' ? ' ' : ''));
    // Declarative form running to the end of the sentence (or a resumed
    // main clause) — e.g. "...brewery located in Peckham, South London, UK."
    const declarative = new RegExp(connector + continuation + closer, 'g');
    out = out.replace(declarative, '');
    const hyphenPattern = new RegExp('\\b' + escaped.replace(/\s+/g, '\\s+') + '-based\\b[ \\t]*', 'g');
    out = out.replace(hyphenPattern, '');
  }
  // Only collapse space/tab runs and comma/period artifacts left behind —
  // never touch newlines, or a multi-paragraph summary gets squashed flat.
  return out
    .replace(/[ \t]*,[ \t]*,/g, ',')
    .replace(/,[ \t]*\./g, '.')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}
export function getNumber(prop) {
  return prop && typeof prop.number === 'number' ? prop.number : null;
}
export function getSelectName(prop) {
  return (prop && prop.select && prop.select.name) || null;
}
export function getStatusName(prop) {
  return (prop && prop.status && prop.status.name) || null;
}
export function getUrl(prop) {
  return (prop && prop.url) || null;
}
export function getDateStart(prop) {
  return (prop && prop.date && prop.date.start) || null;
}
export function getRelationIds(prop) {
  return (prop && prop.relation ? prop.relation.map((r) => r.id) : []) || [];
}
export function getFileUrl(prop) {
  const file = prop && prop.files && prop.files[0];
  if (!file) return null;
  if (file.type === 'file') return file.file.url;
  if (file.type === 'external') return file.external.url;
  return null;
}

// ==================== Brew Tag -> family grouping ====================
// Best-effort clustering of Notion's Brew Tag select options into broad
// style families, purely to keep charts and the Styles tab readable. Not a
// taxonomic authority — tweak this map if new tags get added in Notion.
export const BREW_TAG_FAMILIES = {
  IPA: 'IPA',
  'New England IPA (NEIPA)': 'IPA',
  'Hazy IPA': 'IPA',
  'Session IPA': 'IPA',
  'American IPA': 'IPA',
  'East Coast IPA': 'IPA',
  'MIlkshake IPA': 'IPA',
  'West Coast IPA': 'IPA',
  'Double IPA (DIPA)': 'IPA',
  'Double Dry-Hopped IPA (DDHIPA)': 'IPA',
  'Double Dry-Hopped New England IPA (DDH NEIPA)': 'IPA',
  'Triple Dry-Hopped West Coast IPA (TDH)': 'IPA',

  APA: 'Pale Ale',
  'Pale Ale': 'Pale Ale',
  'Hazy Pale Ale': 'Pale Ale',
  'West Coast Pale': 'Pale Ale',
  'Session Pale Ale': 'Pale Ale',
  'American Pale Ale': 'Pale Ale',
  'New England Pale': 'Pale Ale',
  'Double Dry-Hopped Pale': 'Pale Ale',

  Sour: 'Sour & Fruit',
  Gose: 'Sour & Fruit',
  Lambic: 'Sour & Fruit',
  'Cherry Beer': 'Sour & Fruit',
  'Belgian Fruit Beer': 'Sour & Fruit',

  'Red Ale': 'Ale & Amber',
  'Amber Ale': 'Ale & Amber',
  'Brown Ale': 'Ale & Amber',
  Ale: 'Ale & Amber',
  Bitter: 'Ale & Amber',

  Trappist: 'Belgian',
  'White Ale': 'Belgian',
  'Belgian Beer': 'Belgian',
  'Belgian Blonde': 'Belgian',
  'Belgian Strong Pale': 'Belgian',
  'Saison Ale': 'Belgian',
  Witbier: 'Belgian',
  Wine: 'Belgian',

  'Session Lager': 'Lager & Pilsner',
  Lager: 'Lager & Pilsner',
  Helles: 'Lager & Pilsner',
  'Golden Ale': 'Lager & Pilsner',
  Pilsner: 'Lager & Pilsner',
  'Session Blonde': 'Lager & Pilsner',
  Radler: 'Lager & Pilsner',

  'Milk Stout': 'Stout & Porter',
  Porter: 'Stout & Porter',
  Stout: 'Stout & Porter',

  'Hefeweizen Bier': 'Wheat & German',
  'German Beer': 'Wheat & German',
  'Wheat Beer': 'Wheat & German',

  'Alcohol-free': 'Alcohol-free',

  // Generic catch-alls that don't imply any particular style — grouped
  // with everything else in "Other" explicitly rather than relying on the
  // undocumented fallback below.
  Beer: 'Other',
  Experimental: 'Other',
};

export function brewTagFamily(tag) {
  if (!tag) return 'Other';
  return BREW_TAG_FAMILIES[tag] || 'Other';
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export function errorResponse(status, message) {
  return json({ error: message }, status);
}
