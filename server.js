#!/usr/bin/env node
/* Activity Dock - local server (no dependencies, Node.js 18+)
 *
 *   node server.js            -> http://localhost:8520   (dock)   http://localhost:8520/overlay.html (overlay)
 *   node server.js --port 9000
 *
 * Provides:
 *   - static hosting of the dock + overlay (same origin => no OBS WebSocket needed for alerts)
 *   - /api/yt/stream   unofficial YouTube live-chat reader (Server-Sent Events), no Google API quota
 *   - /api/relay       dock -> overlay alert relay (SSE)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const VERSION = '1.1.0';
const args = process.argv.slice(2);
const argVal = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const PORT = Number(process.env.PORT || argVal('--port', 8520));
const HOST = argVal('--host', '127.0.0.1');
const ROOT = __dirname;
const VERBOSE = args.includes('--verbose');
// Browser origins allowed to call the API (the dock may be hosted on GitHub Pages while this server runs locally).
// Add more with: node server.js --allow-origin https://my.site,https://other.site
const EXTRA_ORIGINS = (argVal('--allow-origin', '') || '').split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean);
function originAllowed(origin) {
  if (!origin || origin === 'null') return true;                       // non-browser clients, file:// pages, same-origin requests
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.github\.io$/i.test(origin)) return true;  // GitHub Pages hosted dock
  return EXTRA_ORIGINS.includes(origin.replace(/\/$/, ''));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const vlog = (...a) => VERBOSE && log(...a);

/* ============================================================
   SSE helper
   ============================================================ */
class SseHub {
  constructor() { this.clients = new Set(); }
  add(req, res, origin) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...cors(origin) });
    res.write(': connected\n\n');
    this.clients.add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) { } }, 20000);
    req.on('close', () => { clearInterval(ka); this.clients.delete(res); this.onClose?.(); });
    return res;
  }
  send(event, data, only) {
    const frame = (event ? 'event: ' + event + '\n' : '') + 'data: ' + JSON.stringify(data) + '\n\n';
    for (const c of only ? [only] : this.clients) { try { c.write(frame); } catch (_) { } }
  }
  get size() { return this.clients.size; }
}
const relayHub = new SseHub();

/* ============================================================
   YouTube unofficial live chat reader
   ============================================================ */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const YT_HEADERS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+cb.20240101-01-p0.en+FX+000; SOCS=CAI; PREF=hl=en&gl=US' };

async function ytFetchText(url) {
  const res = await fetch(url, { headers: YT_HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return { text: await res.text(), url: res.url };
}
/** Extract the JSON object assigned to `name` (e.g. ytInitialData) from an HTML page by brace matching. */
function extractJson(html, name) {
  let i = html.indexOf(name); if (i < 0) return null;
  i = html.indexOf('{', i); if (i < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < html.length; j++) {
    const ch = html[j];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(i, j + 1)); } catch (e) { return null; } } }
  }
  return null;
}
const parseVideoId = (v) => { v = String(v || '').trim(); const m = /(?:v=|youtu\.be\/|\/live\/|\/shorts\/|\/embed\/)([\w-]{11})/.exec(v); return m ? m[1] : (/^[\w-]{11}$/.test(v) ? v : ''); };
function channelLiveUrl(ch) {
  ch = String(ch || '').trim();
  if (/^https?:\/\//i.test(ch)) { const u = new URL(ch); const p = u.pathname.replace(/\/+$/, '').replace(/\/(streams|videos|featured|community|about|shorts|playlists|live)$/i, ''); return 'https://www.youtube.com' + p + '/live?hl=en'; }
  if (/^UC[\w-]{22}$/.test(ch)) return 'https://www.youtube.com/channel/' + ch + '/live?hl=en';
  if (!ch.startsWith('@')) ch = '@' + ch;
  return 'https://www.youtube.com/' + encodeURIComponent(ch) + '/live?hl=en';
}
function runsText(o) { if (!o) return ''; if (o.simpleText) return o.simpleText; return (o.runs || []).map((r) => r.text || (r.emoji ? (r.emoji.shortcuts?.[0] || r.emoji.emojiId || '') : '')).join(''); }
function runsList(o) { return (o?.runs || []).map((r) => r.emoji ? { emoji: { alt: r.emoji.shortcuts?.[0] || r.emoji.emojiId || '', url: bestThumb(r.emoji.image?.thumbnails) } } : { text: r.text || '' }); }
function bestThumb(th) { if (!Array.isArray(th) || !th.length) return null; const t = th[th.length - 1]; let u = t.url || ''; if (u.startsWith('//')) u = 'https:' + u; return u; }
function argb(n) { if (n == null) return null; n = Number(n) >>> 0; return '#' + ((n & 0xffffff).toString(16).padStart(6, '0')); }
function parseAmount(s) {
  s = String(s || '').trim(); if (!s) return null;
  let n = s.replace(/[^\d.,]/g, '');
  const lastDot = n.lastIndexOf('.'), lastComma = n.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) n = lastComma > lastDot ? n.replace(/\./g, '').replace(',', '.') : n.replace(/,/g, '');
  else if (lastComma >= 0) { const commas = (n.match(/,/g) || []).length; const after = n.length - lastComma - 1; n = (commas > 1 || after === 3) ? n.replace(/,/g, '') : n.replace(',', '.'); }
  else if (lastDot >= 0) { const dots = (n.match(/\./g) || []).length; if (dots > 1) n = n.replace(/\./g, ''); }
  const value = parseFloat(n) || 0;
  const currency = s.replace(/[\d.,\s]/g, '') || '';
  return { display: s, value, currency };
}
function author(r) {
  const badges = []; let isOwner = false, isMod = false, isMember = false, isVerified = false;
  for (const b of r.authorBadges || []) {
    const x = b.liveChatAuthorBadgeRenderer || {}; const icon = x.icon?.iconType || ''; const tip = x.tooltip || '';
    if (icon === 'OWNER') { isOwner = true; badges.push({ type: 'owner', title: tip || 'Owner' }); }
    else if (icon === 'MODERATOR') { isMod = true; badges.push({ type: 'moderator', title: tip || 'Moderator' }); }
    else if (icon === 'VERIFIED') { isVerified = true; badges.push({ type: 'verified', title: tip || 'Verified' }); }
    else if (x.customThumbnail) { isMember = true; badges.push({ type: 'member', title: tip || 'Member', url: bestThumb(x.customThumbnail.thumbnails) }); }
    else if (tip) badges.push({ type: 'other', title: tip });
  }
  return { name: runsText(r.authorName), channelId: r.authorExternalChannelId || null, avatar: bestThumb(r.authorPhoto?.thumbnails), badges, isOwner, isMod, isMember, isVerified };
}
const usecToMs = (u) => { const n = Number(u || 0); return n ? Math.round(n / 1000) : Date.now(); };
/** Convert one live chat item renderer into the dock's helper schema. Returns null for ignorable items. */
function mapItem(item) {
  const key = Object.keys(item || {})[0]; const r = item?.[key]; if (!r) return null;
  const base = { id: r.id || (key + '-' + (r.timestampUsec || Date.now())), ts: usecToMs(r.timestampUsec) };
  switch (key) {
    case 'liveChatTextMessageRenderer':
      return { ...base, kind: 'chat', author: author(r), text: runsText(r.message), runs: runsList(r.message) };
    case 'liveChatPaidMessageRenderer': {
      const amount = parseAmount(runsText(r.purchaseAmountText)); if (amount) amount.color = argb(r.bodyBackgroundColor || r.headerBackgroundColor);
      return { ...base, kind: 'superchat', author: author(r), text: runsText(r.message), runs: runsList(r.message), amount };
    }
    case 'liveChatPaidStickerRenderer': {
      const amount = parseAmount(runsText(r.purchaseAmountText)); if (amount) amount.color = argb(r.backgroundColor || r.moneyChipBackgroundColor);
      return { ...base, kind: 'sticker', author: author(r), text: r.sticker?.accessibility?.accessibilityData?.label || 'Super Sticker', amount, sticker: bestThumb(r.sticker?.thumbnails) };
    }
    case 'liveChatMembershipItemRenderer': {
      const primary = runsText(r.headerPrimaryText), sub = runsText(r.headerSubtext), msg = runsText(r.message);
      const milestone = /member for|months?|years?/i.test(primary) && !/welcome/i.test(primary);
      if (milestone) return { ...base, kind: 'milestone', author: author(r), headline: primary, level: sub || null, text: msg, runs: runsList(r.message) };
      const level = (sub || primary).replace(/^welcome to\s*/i, '').replace(/!$/, '').trim();
      return { ...base, kind: 'member', author: author(r), headline: primary || sub || 'New member', level: level || null, text: msg, runs: runsList(r.message) };
    }
    case 'liveChatSponsorshipsGiftPurchaseAnnouncementRenderer': {
      const hdr = r.header?.liveChatSponsorshipsHeaderRenderer || {}; const text = runsText(hdr.primaryText);
      const count = Number((/(\d+)/.exec(text) || [])[1] || 1);
      const a = author({ authorName: hdr.authorName, authorPhoto: hdr.authorPhoto, authorBadges: hdr.authorBadges, authorExternalChannelId: r.authorExternalChannelId });
      return { ...base, kind: 'gift', author: a, headline: text || ('Gifted ' + count + ' memberships'), count };
    }
    case 'liveChatSponsorshipsGiftRedemptionAnnouncementRenderer':
      return { ...base, kind: 'giftrecv', author: author(r), headline: 'Received a gift membership', text: runsText(r.message) };
    case 'liveChatModeChangeMessageRenderer':
      return { ...base, kind: 'system', headline: runsText(r.text), text: runsText(r.subtext) };
    case 'liveChatDonationAnnouncementRenderer':
      return { ...base, kind: 'system', author: author(r), headline: runsText(r.text), text: runsText(r.subtext) };
    case 'liveChatViewerEngagementMessageRenderer': case 'liveChatPlaceholderItemRenderer': case 'liveChatAutoModMessageRenderer': case 'liveChatTickerPaidMessageItemRenderer': case 'liveChatTickerSponsorItemRenderer': case 'liveChatTickerPaidStickerItemRenderer':
      return null;
    default:
      vlog('unknown item', key); return null;
  }
}

class YouTubeReader {
  constructor(target) {
    this.target = target; // {video} | {channel}
    this.key = target.video ? 'v:' + target.video : 'c:' + target.channel.toLowerCase();
    this.hub = new SseHub(); this.hub.onClose = () => this.maybeStop();
    this.status = { state: 'starting', message: 'Starting…', videoId: null, title: null, channelId: null };
    this.stopped = false; this.timer = null; this.idleTimer = null; this.seen = new Map();
    this.run();
  }
  setStatus(s) { Object.assign(this.status, s); this.hub.send('status', this.status); }
  attach(req, res, origin) { clearTimeout(this.idleTimer); const c = this.hub.add(req, res, origin); this.hub.send('status', this.status, c); if (this.recent?.length) this.hub.send('batch', { items: this.recent.slice(-60), history: true }, c); }
  maybeStop() { if (this.hub.size) return; clearTimeout(this.idleTimer); this.idleTimer = setTimeout(() => { if (!this.hub.size) { this.stop(); readers.delete(this.key); log('YouTube reader stopped (no listeners):', this.key); } }, 60_000); }
  stop() { this.stopped = true; clearTimeout(this.timer); if (this._wake) this._wake(); }
  wait(ms) { return new Promise((r) => { this._wake = r; this.timer = setTimeout(r, ms); }); }

  async resolveVideo() {
    if (this.target.video) return { videoId: this.target.video };
    const { text: html, url } = await ytFetchText(channelLiveUrl(this.target.channel));
    const data = extractJson(html, 'ytInitialData') || {};
    let videoId = data.currentVideoEndpoint?.watchEndpoint?.videoId || (/"currentVideoEndpoint":\{[^}]*"url":"\/watch\?v=([\w-]{11})/.exec(html) || [])[1] || (/[?&]v=([\w-]{11})/.exec(url) || [])[1] || null;
    const channelId = (/"externalId":"(UC[\w-]{22})"/.exec(html) || [])[1] || (/<meta itemprop="identifier" content="(UC[\w-]{22})"/.exec(html) || [])[1] || null;
    if (channelId) this.status.channelId = channelId;
    if (!videoId) return null;
    let title = null;
    try { for (const c of data.contents?.twoColumnWatchNextResults?.results?.results?.contents || []) if (c.videoPrimaryInfoRenderer) title = runsText(c.videoPrimaryInfoRenderer.title); } catch (_) { }
    return { videoId, title };
  }
  async openChat(videoId) {
    const { text: html } = await ytFetchText('https://www.youtube.com/live_chat?v=' + videoId + '&is_popout=1&hl=en');
    const apiKey = (/"INNERTUBE_API_KEY":"([^"]+)"/.exec(html) || [])[1];
    const clientVersion = (/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/.exec(html) || /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(html) || [])[1] || '2.20240101.00.00';
    const data = extractJson(html, 'ytInitialData') || {};
    const lcr = data.contents?.liveChatRenderer;
    if (!lcr) {
      const msg = runsText(data.contents?.messageRenderer?.text) || 'Live chat unavailable';
      const err = new Error(msg); err.chatUnavailable = true; throw err;
    }
    let continuation = null;
    try {
      const items = lcr.header?.liveChatHeaderRenderer?.viewSelector?.sortFilterSubMenuRenderer?.subMenuItems || [];
      const live = items.find((i) => /live chat|all messages/i.test(i.title || '')) || items[items.length - 1];
      continuation = live?.continuation?.reloadContinuationData?.continuation || null;
    } catch (_) { }
    if (!continuation) { const c0 = lcr.continuations?.[0] || {}; continuation = (c0.invalidationContinuationData || c0.timedContinuationData || c0.reloadContinuationData || {}).continuation; }
    if (!continuation || !apiKey) throw new Error('Could not find chat continuation (YouTube layout changed?)');
    const title = runsText(data.contents?.liveChatRenderer?.header?.liveChatHeaderRenderer?.viewSelector?.sortFilterSubMenuRenderer?.title) || null;
    return { apiKey, clientVersion, continuation, initialActions: lcr.actions || [] };
  }
  async poll(sess) {
    const res = await fetch('https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=' + encodeURIComponent(sess.apiKey) + '&prettyPrint=false', {
      method: 'POST', headers: { ...YT_HEADERS, 'Content-Type': 'application/json', 'X-YouTube-Client-Name': '1', 'X-YouTube-Client-Version': sess.clientVersion, Origin: 'https://www.youtube.com', Referer: 'https://www.youtube.com/live_chat?v=' + this.status.videoId },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: sess.clientVersion, hl: 'en', gl: 'US', userAgent: UA, timeZone: 'UTC', utcOffsetMinutes: 0 } }, continuation: sess.continuation }),
    });
    if (!res.ok) { const e = new Error('get_live_chat HTTP ' + res.status); e.status = res.status; throw e; }
    const data = await res.json();
    const lc = data.continuationContents?.liveChatContinuation;
    if (!lc) { const e = new Error('chat ended'); e.ended = true; throw e; }
    const c0 = lc.continuations?.[0] || {}; const cd = c0.invalidationContinuationData || c0.timedContinuationData || c0.reloadContinuationData || c0.liveChatReplayContinuationData || {};
    return { actions: lc.actions || [], continuation: cd.continuation || sess.continuation, timeoutMs: Number(cd.timeoutMs || 5000) };
  }
  handleActions(actions, history) {
    const items = [], deleted = [];
    for (let a of actions) {
      if (a.replayChatItemAction) a = a.replayChatItemAction.actions?.[0] || {};
      if (a.addChatItemAction) { const it = mapItem(a.addChatItemAction.item); if (it && !this.seen.has(it.id)) { this.seen.set(it.id, 1); items.push(it); } }
      else if (a.markChatItemAsDeletedAction?.targetItemId) deleted.push(a.markChatItemAsDeletedAction.targetItemId);
      else if (a.removeChatItemAction?.targetItemId) deleted.push(a.removeChatItemAction.targetItemId);
      else if (a.markChatItemsByAuthorAsDeletedAction) { /* would need author->ids map; skip */ }
      else if (a.replaceChatItemAction?.replacementItem) { const it = mapItem(a.replaceChatItemAction.replacementItem); if (it && !this.seen.has(it.id)) { this.seen.set(it.id, 1); items.push(it); } }
    }
    if (this.seen.size > 6000) { let n = 0; for (const k of this.seen.keys()) { this.seen.delete(k); if (++n > 3000) break; } }
    if (items.length) { this.recent = (this.recent || []).concat(items).slice(-120); this.hub.send('batch', { items, history: !!history }); }
    if (deleted.length) this.hub.send('delete', { ids: deleted });
    return items.length;
  }
  async run() {
    let backoff = 5000;
    while (!this.stopped) {
      try {
        this.setStatus({ state: 'resolving', message: this.target.video ? 'Opening chat…' : 'Checking if the channel is live…' });
        const v = await this.resolveVideo();
        if (!v) { this.setStatus({ state: 'waiting', message: 'Channel is not live right now - checking again in 60s', videoId: null, title: null }); await this.wait(60_000); continue; }
        this.status.videoId = v.videoId; if (v.title) this.status.title = v.title;
        let sess;
        try { sess = await this.openChat(v.videoId); }
        catch (e) { if (e.chatUnavailable) { this.setStatus({ state: 'waiting', message: e.message + ' - retrying in 60s' }); await this.wait(60_000); continue; } throw e; }
        if (!this.status.title) { try { const { text } = await ytFetchText('https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=' + v.videoId); this.status.title = JSON.parse(text).title || null; } catch (_) { } }
        this.setStatus({ state: 'live', message: 'Reading live chat' });
        log('YouTube: reading chat of', v.videoId, this.status.title ? '(' + this.status.title + ')' : '');
        this.handleActions(sess.initialActions, true);
        backoff = 5000; let failures = 0;
        while (!this.stopped) {
          let r;
          try { r = await this.poll(sess); failures = 0; }
          catch (e) {
            if (e.ended) { log('YouTube: chat ended for', v.videoId); this.setStatus({ state: 'waiting', message: 'Stream ended - watching for the next one', videoId: null }); this.hub.send('batch', { items: [{ id: 'sys-end-' + Date.now(), ts: Date.now(), kind: 'system', headline: 'YouTube stream ended' }] }); await this.wait(this.target.video ? 5 * 60_000 : 30_000); break; }
            failures++; vlog('poll error', e.message); if (failures > 5) { break; } await this.wait(Math.min(2000 * failures, 15000)); continue;
          }
          sess.continuation = r.continuation;
          const n = this.handleActions(r.actions, false);
          await this.wait(n ? 1200 : Math.min(Math.max(r.timeoutMs, 1000), 5000));
        }
      } catch (e) {
        log('YouTube reader error:', e.message);
        this.setStatus({ state: 'error', message: e.message + ' - retrying in ' + Math.round(backoff / 1000) + 's' });
        await this.wait(backoff); backoff = Math.min(backoff * 2, 120_000);
      }
    }
  }
}
const readers = new Map();
function getReader(target) { const key = target.video ? 'v:' + target.video : 'c:' + target.channel.toLowerCase(); let r = readers.get(key); if (!r) { r = new YouTubeReader(target); readers.set(key, r); log('YouTube reader started:', key); } return r; }

/* ============================================================
   HTTP server
   ============================================================ */
function cors(origin) {
  // Only allowlisted origins get CORS headers, so arbitrary websites cannot read your chat or push fake alerts.
  if (!origin || !originAllowed(origin)) return { Vary: 'Origin' };
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600', Vary: 'Origin' };
}
function json(res, code, obj, origin) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) }); res.end(JSON.stringify(obj)); }
function readBody(req, limit = 256 * 1024) { return new Promise((resolve, reject) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > limit) { reject(new Error('too large')); req.destroy(); } }); req.on('end', () => resolve(b)); req.on('error', reject); }); }

const handler = async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const origin = req.headers.origin;
  try {
    if (req.method === 'OPTIONS') { res.writeHead(originAllowed(origin) ? 204 : 403, cors(origin)); return res.end(); }
    if (u.pathname.startsWith('/api/') && origin && !originAllowed(origin)) { log('blocked request from origin', origin, '(allow it with --allow-origin)'); return json(res, 403, { error: 'origin not allowed' }); }
    if (u.pathname === '/api/relay' && req.method === 'POST' && !/^application\/json/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'expected application/json' }, origin);
    if (u.pathname === '/api/health') return json(res, 200, { ok: true, app: 'activity-dock', version: VERSION, node: process.version, readers: [...readers.keys()] }, origin);
    if (u.pathname === '/api/relay' && req.method === 'POST') { const body = await readBody(req); let msg; try { msg = JSON.parse(body); } catch (_) { return json(res, 400, { error: 'bad json' }, origin); } relayHub.send(null, msg); return json(res, 200, { ok: true, listeners: relayHub.size }, origin); }
    if (u.pathname === '/api/relay/stream') { relayHub.add(req, res, origin); return; }
    if (u.pathname === '/api/yt/status') return json(res, 200, { ok: true, version: VERSION, readers: [...readers.values()].map((r) => ({ key: r.key, ...r.status, listeners: r.hub.size })) }, origin);
    if (u.pathname === '/api/yt/stream') {
      const video = parseVideoId(u.searchParams.get('video') || ''); const channel = (u.searchParams.get('channel') || '').trim();
      if (!video && !channel) return json(res, 400, { error: 'pass ?video=ID or ?channel=@handle' }, origin);
      const reader = getReader(video ? { video } : { channel });
      return reader.attach(req, res, origin);
    }
    if (u.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' }, origin);
    // static files
    let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT) || file.includes(path.sep + '.') || !MIME[path.extname(file)]) { res.writeHead(404); return res.end('Not found'); }
    fs.readFile(file, (err, data) => { if (err) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-cache' }); res.end(data); });
  } catch (e) { log('request error', e.message); try { json(res, 500, { error: e.message }, origin); } catch (_) { } }
};
const server = http.createServer(handler);

server.on('error', (e) => { if (e.code === 'EADDRINUSE') { console.error('\nPort ' + PORT + ' is already in use. Is another copy running? Try: node server.js --port 8521\n'); process.exit(1); } throw e; });
if (HOST === '127.0.0.1') { // "localhost" may resolve to ::1 first on Windows - listen there too (best effort)
  const v6 = http.createServer(handler); v6.on('error', () => { }); try { v6.listen(PORT, '::1'); } catch (_) { }
}
server.listen(PORT, HOST, () => {
  const base = 'http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT;
  console.log('\n  Activity Dock v' + VERSION + ' is running\n');
  console.log('  Dock     (OBS > Docks > Custom Browser Docks):  ' + base + '/');
  console.log('  Overlay  (OBS > Sources > Browser):            ' + base + '/overlay.html');
  if (EXTRA_ORIGINS.length) console.log('  Extra allowed origins: ' + EXTRA_ORIGINS.join(', '));
  console.log('\n  Keep this window open while streaming. Press Ctrl+C to stop.\n');
});
