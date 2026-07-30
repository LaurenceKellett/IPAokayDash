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
// Best-effort clustering of the 43 Notion Brew Tag select options into
// broad style families, purely to keep charts readable. Not a taxonomic
// authority — tweak this map if new tags get added in Notion.
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
