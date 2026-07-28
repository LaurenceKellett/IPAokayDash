/**
 * GET /api/data
 *
 * Serves the last-synced dataset straight from KV. No Notion calls happen
 * here, so page loads are instant regardless of how large the Beers/
 * Breweries databases get.
 */
import { json, errorResponse } from '../_notion.js';

export async function onRequestGet({ env }) {
  const raw = await env.DASH_KV.get('dataset');
  if (!raw) {
    return errorResponse(404, 'No data synced yet — click "Sync now".');
  }
  return json(JSON.parse(raw));
}
