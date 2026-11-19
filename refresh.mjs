// Library robot: builds ONE shared library for every user.
// Run by GitHub Actions on a schedule. No dependencies; needs Node 20+.
//
// Each run:
//   1. loads the previous library (from the live site) so work is incremental,
//   2. asks YouTube only for NEW uploads of each creator (about 1 quota unit each),
//   3. refreshes stored view/like counts and drops deleted videos when a creator is due,
//   4. writes ./site/v1/index.json + ./site/v1/creators/<id>.json for the phones.
//
// Output file shapes match what the Android app already reads (ContentLibraryStore).

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const API = 'https://www.googleapis.com/youtube/v3/';
const DAY_MS = 86_400_000;

// Same rules as the app (VideoGates / ContentLibraryStore) so the feed does not change.
export const CHANNEL_BLOCKLIST = ['SRJMotivation', 'Henry Grey Earls', 'MulliganBrothers'];
export const EXCLUDED_CHANNEL_IDS = new Set([
  'UCyWN-BnWSKeHEnNOYvvpNnA',
  'UCj9QBB4bNTv29f4oFIreNmw',
  'UCjmynbA3C3Tm0koVy_8pfLw',
]);
const SHORT_MAX = 60;
const SHORTS_CEILING = 180;
const INDEX_VERSION = 2; // ContentLibraryStore.VERSION

export function isoToSeconds(d) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(d || '');
  if (!m) return null;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + Math.floor(+m[3] || 0);
}
export function isBlocked(title) {
  const n = (title || '').toLowerCase().trim();
  return !!n && CHANNEL_BLOCKLIST.some((t) => n.includes(t.toLowerCase()));
}
export function classifyShort(seconds, onShortsPlaylist) {
  if (seconds <= SHORT_MAX) return true;
  if (seconds <= SHORTS_CEILING) return onShortsPlaylist;
  return false;
}
export function bestThumbnail(t) {
  const url = [t?.maxres, t?.standard, t?.high, t?.medium, t?.default].map((x) => x?.url).find(Boolean);
  if (!url) return '';
  const up = url
    .replace(/\/(default|mqdefault|hqdefault|sddefault)\.(jpg|webp)/, '/maxresdefault.jpg');
  return up;
}
export const uploadsId = (c) => (c.startsWith('UC') ? 'UU' + c.slice(2) : '');
export const shortsId = (c) => (c.startsWith('UC') ? 'UUSH' + c.slice(2) : '');

// ---- quota-aware API client ------------------------------------------------------------
export class QuotaGone extends Error {}

export class Yt {
  constructor(key, budget, used = 0) {
    this.key = key; this.budget = budget; this.used = used;
  }
  async get(endpoint, params, cost = 1) {
    if (this.used + cost > this.budget) throw new QuotaGone('own budget reached');
    const url = new URL(API + endpoint);
    for (const [k, v] of Object.entries({ ...params, key: this.key })) url.searchParams.set(k, v);
    for (let attempt = 0; attempt < 3; attempt++) {
      let res;
      try { res = await fetch(url); } catch (e) { if (attempt === 2) throw e; await sleep(800 * (attempt + 1)); continue; }
      this.used += cost;
      if (res.ok) return res.json();
      if (res.status === 404) return null;
      const text = await res.text();
      if (res.status === 403 && /quota/i.test(text)) throw new QuotaGone('YouTube quota exhausted');
      if (res.status >= 500 && attempt < 2) { await sleep(800 * (attempt + 1)); continue; }
      throw new Error(`${endpoint} ${res.status}: ${text.slice(0, 200)}`);
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fetching --------------------------------------------------------------------------
/** Newest-first walk of a playlist. Stops at the cutoff day, or at an already-known id. */
export async function walkPlaylist(yt, playlistId, cutoffDay, knownIds, maxPages) {
  const found = new Map(); // videoId -> 'yyyy-mm-dd'
  let token;
  for (let p = 0; p < maxPages; p++) {
    const params = { part: 'snippet,contentDetails', playlistId, maxResults: 50 };
    if (token) params.pageToken = token;
    const body = await yt.get('playlistItems', params);
    if (!body) return found; // playlist does not exist: complete and empty
    let stop = false;
    for (const it of body.items || []) {
      const id = it.contentDetails?.videoId;
      const day = (it.snippet?.publishedAt || '').slice(0, 10);
      if (!id || !day) continue;
      if (day < cutoffDay) { stop = true; continue; }
      if (knownIds?.has(id)) { stop = true; continue; }
      found.set(id, day);
    }
    token = body.nextPageToken;
    if (stop || !token) return found;
  }
  return found;
}

export async function fetchDetails(yt, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const body = await yt.get('videos', { part: 'snippet,contentDetails,statistics,status', id: ids.slice(i, i + 50).join(',') });
    for (const v of body?.items || []) out.set(v.id, v);
  }
  return out; // ids missing from the map were deleted/private
}

function toVideo(v, ch, topic, avatar, isShort) {
  const secs = isoToSeconds(v.contentDetails?.duration);
  if (secs == null) return null;
  if (v.status?.embeddable === false) return null;
  if (isBlocked(v.snippet?.channelTitle)) return null;
  return {
    videoId: v.id,
    channelId: ch.channel_id,
    creator: v.snippet?.channelTitle || ch.name,
    title: v.snippet?.title || '',
    topic,
    seconds: secs,
    views: Number(v.statistics?.viewCount) || 0,
    likes: Number(v.statistics?.likeCount) || 0,
    published: (v.snippet?.publishedAt || '').slice(0, 10),
    isShort: isShort ?? classifyShort(secs, false),
    avatarUrl: avatar || '',
    thumbnailUrl: bestThumbnail(v.snippet?.thumbnails),
    language: ch.language || '',
  };
}

export function topicOf(ch) {
  const sub = (ch.subcategories || []).find((s) => s && s.trim());
  return sub || ch.primary_category || (ch.categories || [])[0] || '';
}

/** Which of these new videos sit in the 61-180 s grey zone and need the Shorts playlist? */
const ambiguous = (secs) => secs > SHORT_MAX && secs <= SHORTS_CEILING;

// ---- one creator -----------------------------------------------------------------------
export async function updateCreator(yt, ch, prev, opts) {
  const { cutoffDay, now, avatar, refreshAfterMs } = opts;
  const topic = topicOf(ch);
  const hadFile = !!prev;
  const old = prev?.videos ?? [];
  const known = new Set(old.map((v) => v.videoId));

  // 1. new uploads (full walk on first sight, usually a single page afterwards)
  const fresh = await walkPlaylist(yt, uploadsId(ch.channel_id), cutoffDay, hadFile ? known : null, hadFile ? 4 : 40);
  const newIds = [...fresh.keys()];

  // 2. refresh old rows when due (stats policy + deleted videos)
  const due = !prev || now - (prev.refreshedAtMillis || 0) >= refreshAfterMs;
  const toDetail = due ? [...new Set([...old.map((v) => v.videoId), ...newIds])] : newIds;
  const details = await fetchDetails(yt, toDetail);

  // 3. Shorts grey zone, only for NEW videos (old rows keep their classification)
  let shortSet = new Set();
  const needShorts = newIds.some((id) => ambiguous(isoToSeconds(details.get(id)?.contentDetails?.duration) ?? 0));
  if (needShorts) {
    const s = await walkPlaylist(yt, shortsId(ch.channel_id), cutoffDay, null, hadFile ? 2 : 20);
    shortSet = new Set(s.keys());
  }

  // 4. merge
  const byId = new Map(old.map((v) => [v.videoId, v]));
  if (due) {
    for (const [id, v] of [...byId]) {
      const d = details.get(id);
      if (!d) { byId.delete(id); continue; } // deleted or private
      byId.set(id, { ...v, views: Number(d.statistics?.viewCount) || 0, likes: Number(d.statistics?.likeCount) || 0, title: d.snippet?.title || v.title, avatarUrl: avatar || v.avatarUrl });
    }
  }
  for (const id of newIds) {
    const d = details.get(id);
    if (!d) continue;
    const secs = isoToSeconds(d.contentDetails?.duration);
    const row = toVideo(d, ch, topic, avatar || old[0]?.avatarUrl, secs == null ? null : classifyShort(secs, shortSet.has(id)));
    if (row) byId.set(id, row);
  }
  const today = new Date(now).toISOString().slice(0, 10);
  const videos = [...byId.values()]
    .filter((v) => v.published >= cutoffDay && v.published <= addDays(today, 1))
    .sort((a, b) => (a.published < b.published ? 1 : a.published > b.published ? -1 : 0))
    .slice(0, 400);
  return { videos, refreshedAtMillis: due ? now : prev.refreshedAtMillis, changed: due || newIds.length > 0 };
}

export const addDays = (isoDay, n) => new Date(Date.parse(isoDay + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);

export function entryFor(ch, videos, now, refreshedAtMillis) {
  const longs = videos.filter((v) => !v.isShort).length;
  const topic = topicOf(ch);
  const cats = [ch.primary_category, ...(ch.categories || [])].filter(Boolean).filter((x, i, arr) => arr.indexOf(x) === i);
  return {
    channelId: ch.channel_id,
    name: ch.name,
    topics: cats.length ? cats : [topic].filter(Boolean),
    subscribers: Number(ch.subscribers) || 0,
    videoCount: longs,
    shortCount: videos.length - longs,
    lastUpload: videos.reduce((m, v) => (v.published > m ? v.published : m), ''),
    fetchedAtMillis: now,
    refreshedAtMillis,
    ok: videos.length > 0,
  };
}

export const encodeCreator = (videos, refreshedAtMillis) => JSON.stringify({ videos, refreshedAtMillis });
export const revOf = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12);

// ---- previous state --------------------------------------------------------------------
async function loadPrevious(baseUrl, channels) {
  const state = { index: null, files: new Map() };
  if (!baseUrl) return state;
  try {
    const res = await fetch(`${baseUrl}/v1/index.json`);
    if (!res.ok) return state;
    state.index = await res.json();
  } catch { return state; }
  const ids = (state.index.creators || []).map((c) => c.channelId);
  const wanted = new Set(channels.map((c) => c.channel_id));
  let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < ids.length) {
      const id = ids[i++];
      if (!wanted.has(id)) continue;
      try {
        const r = await fetch(`${baseUrl}/v1/creators/${id}.json`);
        if (r.ok) state.files.set(id, await r.json());
      } catch { /* treated as missing: the creator is rebuilt */ }
    }
  }));
  return state;
}

const pacificDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

// ---- main ------------------------------------------------------------------------------
async function main() {
  const env = process.env;
  const key = env.YOUTUBE_API_KEY;
  if (!key) throw new Error('YOUTUBE_API_KEY is not set (add it as a GitHub secret).');
  const windowDays = Number(env.WINDOW_DAYS || 180);
  const budget = Number(env.DAILY_QUOTA_BUDGET || 8000);
  const refreshAfterMs = Number(env.REFRESH_AFTER_HOURS || 72) * 3_600_000;
  const outDir = env.OUT_DIR || 'site';
  const here = path.dirname(fileURLToPath(import.meta.url));
  const catalog = JSON.parse(await readFile(path.join(here, 'creators.json'), 'utf8'));
  const channels = catalog.channels.filter((c) => c.channel_id && !EXCLUDED_CHANNEL_IDS.has(c.channel_id));

  const now = Date.now();
  const cutoffDay = new Date(now - windowDays * DAY_MS).toISOString().slice(0, 10);
  const prev = await loadPrevious(env.LIBRARY_BASE_URL, channels);

  // Quota used so far today (YouTube resets at midnight Pacific).
  const sameDay = prev.index?.quota?.day === pacificDay(now);
  const yt = new Yt(key, budget, sameDay ? prev.index.quota.used : 0);
  console.log(`creators=${channels.length} window=${windowDays}d budget=${budget} usedToday=${yt.used} previous=${prev.files.size}`);

  // Avatars: 50 per call, ~9 calls.
  const avatars = new Map();
  try {
    for (let i = 0; i < channels.length; i += 50) {
      const body = await yt.get('channels', { part: 'snippet', id: channels.slice(i, i + 50).map((c) => c.channel_id).join(',') });
      for (const it of body?.items || []) {
        const t = it.snippet?.thumbnails;
        const url = t?.medium?.url || t?.default?.url || t?.high?.url;
        if (url) avatars.set(it.id, url);
      }
    }
  } catch (e) { if (!(e instanceof QuotaGone)) console.warn('avatars:', e.message); }

  // Creators never built, or most overdue, go first so a quota stop leaves the best coverage.
  const order = [...channels].sort((a, b) =>
    (prev.files.get(a.channel_id)?.refreshedAtMillis ?? 0) - (prev.files.get(b.channel_id)?.refreshedAtMillis ?? 0));

  const results = new Map(); // id -> {videos, refreshedAtMillis}
  let failed = 0; let stopped = false;
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (!stopped && next < order.length) {
      const ch = order[next++];
      try {
        const r = await updateCreator(yt, ch, prev.files.get(ch.channel_id), { cutoffDay, now, avatar: avatars.get(ch.channel_id), refreshAfterMs });
        results.set(ch.channel_id, r);
      } catch (e) {
        if (e instanceof QuotaGone) { stopped = true; console.warn(e.message); } else { failed++; console.warn(`${ch.name}: ${e.message}`); }
      }
    }
  }));

  // Write. A creator that failed keeps its previous file untouched; one never built is simply absent.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, 'v1', 'creators'), { recursive: true });
  const entries = [];
  for (const ch of channels) {
    const id = ch.channel_id;
    const r = results.get(id);
    const old = prev.files.get(id);
    const videos = r ? r.videos : old?.videos;
    if (!videos) continue;
    const refreshedAt = r ? r.refreshedAtMillis : old.refreshedAtMillis ?? 0;
    const text = encodeCreator(videos, refreshedAt);
    await writeFile(path.join(outDir, 'v1', 'creators', `${id}.json`), text);
    const prevEntry = prev.index?.creators?.find((c) => c.channelId === id);
    const e = entryFor(ch, videos, r?.changed || !prevEntry ? now : prevEntry.fetchedAtMillis, refreshedAt);
    entries.push({ ...e, rev: revOf(text) });
  }
  const index = {
    version: INDEX_VERSION,
    schema: 1,
    generatedAt: now,
    windowDays,
    quota: { day: pacificDay(now), used: yt.used },
    creators: entries,
  };
  await writeFile(path.join(outDir, 'v1', 'index.json'), JSON.stringify(index));
  await writeFile(path.join(outDir, '.nojekyll'), '');
  console.log(`published ${entries.length}/${channels.length} creators, quotaUsed=${yt.used}, failed=${failed}, stoppedEarly=${stopped}`);
  if (entries.length === 0) { console.error('nothing to publish; refusing to deploy an empty library'); process.exit(1); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
