import test from 'node:test';
import assert from 'node:assert/strict';
import { updateCreator, classifyShort, isoToSeconds, isBlocked, bestThumbnail, entryFor } from './refresh.mjs';

const ch = { channel_id: 'UCabc', name: 'Test', primary_category: 'Business', categories: ['Business'], subcategories: ['Investing'], language: 'en', subscribers: '10' };
const NOW = Date.parse('2026-11-18T12:00:00Z');
const opts = { cutoffDay: '2026-05-22', now: NOW, avatar: 'a.jpg', refreshAfterMs: 72 * 3600e3 };

function vid(id, day, dur = 'PT10M', views = 5) {
  return { id, snippet: { title: id, channelTitle: 'Test', publishedAt: day + 'T00:00:00Z', thumbnails: { high: { url: 'https://i.ytimg.com/vi/x/hqdefault.jpg' } } },
    contentDetails: { duration: dur }, statistics: { viewCount: String(views), likeCount: '1' }, status: { embeddable: true } };
}
// Fake API: playlists newest first.
function fakeYt({ uploads = [], shorts = [], videos = {} }) {
  const calls = [];
  return { calls, async get(endpoint, p) {
    calls.push(endpoint);
    if (endpoint === 'playlistItems') {
      const list = p.playlistId.startsWith('UUSH') ? shorts : uploads;
      return { items: list.map(([id, day]) => ({ contentDetails: { videoId: id }, snippet: { publishedAt: day + 'T00:00:00Z' } })) };
    }
    if (endpoint === 'videos') return { items: p.id.split(',').map((id) => videos[id]).filter(Boolean) };
    throw new Error('unexpected ' + endpoint);
  } };
}

test('helpers match the app rules', () => {
  assert.equal(isoToSeconds('PT1M30S'), 90);
  assert.equal(isoToSeconds('PT2H5M'), 7500);
  assert.equal(classifyShort(60, false), true);
  assert.equal(classifyShort(120, false), false);
  assert.equal(classifyShort(120, true), true);
  assert.equal(classifyShort(200, true), false);
  assert.equal(isBlocked('The SRJMotivation Channel'), true);
  assert.match(bestThumbnail({ high: { url: 'https://x/hqdefault.jpg' } }), /maxresdefault/);
});

test('first sight: full crawl, window respected, ambiguous short resolved by shorts playlist', async () => {
  const yt = fakeYt({
    uploads: [['n1', '2026-11-10'], ['n2', '2026-10-01'], ['old', '2025-01-01']],
    shorts: [['n2', '2026-10-01']],
    videos: { n1: vid('n1', '2026-11-10'), n2: vid('n2', '2026-10-01', 'PT2M') },
  });
  const r = await updateCreator(yt, ch, null, opts);
  assert.deepEqual(r.videos.map((v) => v.videoId), ['n1', 'n2']);
  assert.equal(r.videos[1].isShort, true);
  assert.equal(r.videos[0].topic, 'Investing');
  assert.equal(r.videos[0].avatarUrl, 'a.jpg');
});

test('incremental: stops at known video, costs one page + one details call', async () => {
  const prev = { refreshedAtMillis: NOW - 3600e3, videos: [
    { ...vid('k1', '2026-11-01'), videoId: 'k1', published: '2026-11-01', views: 5, likes: 1, seconds: 600, isShort: false, avatarUrl: 'a.jpg', topic: 'Investing' }] };
  const yt = fakeYt({ uploads: [['new', '2026-11-17'], ['k1', '2026-11-01']], videos: { new: vid('new', '2026-11-17') } });
  const r = await updateCreator(yt, ch, prev, opts);
  assert.deepEqual(r.videos.map((v) => v.videoId), ['new', 'k1']);
  assert.deepEqual(yt.calls, ['playlistItems', 'videos']);
});

test('due refresh: updates counts and drops deleted videos', async () => {
  const row = (id, day) => ({ videoId: id, published: day, views: 1, likes: 0, title: id, seconds: 600, isShort: false, avatarUrl: 'a.jpg' });
  const prev = { refreshedAtMillis: NOW - 100 * 3600e3, videos: [row('keep', '2026-11-01'), row('gone', '2026-10-30')] };
  const yt = fakeYt({ uploads: [['keep', '2026-11-01']], videos: { keep: vid('keep', '2026-11-01', 'PT10M', 999) } });
  const r = await updateCreator(yt, ch, prev, opts);
  assert.deepEqual(r.videos.map((v) => v.videoId), ['keep']);
  assert.equal(r.videos[0].views, 999);
  assert.equal(r.refreshedAtMillis, NOW);
});

test('entry counts and ordering fields', () => {
  const e = entryFor(ch, [{ isShort: false, published: '2026-11-02' }, { isShort: true, published: '2026-11-09' }], NOW, 5);
  assert.equal(e.videoCount, 1); assert.equal(e.shortCount, 1); assert.equal(e.lastUpload, '2026-11-09'); assert.equal(e.ok, true);
});
