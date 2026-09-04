/* Activity Dock - YouTube
 *  A) Official Data API (in-browser): API key, or OAuth via Google's device flow ("TV & limited input" client).
 *     Uses liveChatMessages.streamList (long-lived) when available, else liveChatMessages.list polling.
 *  B) Unofficial feed via the local server (server.js) -> Server-Sent Events. No quota, no Google setup.
 */
(function (AD) {
  'use strict';
  const AUTH_KEY = 'ad.youtube.auth.v1', SUBS_KEY = 'ad.youtube.subs.v1', SC_KEY = 'ad.youtube.superchats.v1';
  const API = 'https://youtube.googleapis.com/youtube/v3/';
  const OAUTH_DEVICE = 'https://oauth2.googleapis.com/device/code';
  const OAUTH_TOKEN = 'https://oauth2.googleapis.com/token';
  const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
  const COST = { videos: 1, channels: 1, liveBroadcasts: 1, subscriptions: 1, search: 100, list: 5, stream: 5 };

  const S = () => AD.settings.get().youtube;
  const E = AD.events;
  const state = {
    status: 'disconnected', // disconnected | auth | connecting | connected | idle | error
    detail: '',
    mode: null,             // 'official' | 'helper'
    method: null,           // 'stream' | 'poll' | 'sse'
    videoId: null, title: null, liveChatId: null, channelId: null,
    helperOk: null,         // last helper probe result
    helperVersion: null,
    quota: AD.store.get('ad.youtube.quota', { day: '', units: 0 }),
    deviceAuth: null,
    user: null,             // {title, channelId, avatar}
  };
  let auth = AD.store.get(AUTH_KEY, null);
  let running = false, gen = 0;       // gen invalidates old loops
  let sse = null, pollTimer = null, subsTimer = null, retryTimer = null, streamAbort = null, resolveTimer = null;
  let seenIds = new Set(), seenOrder = [];
  let knownSubscribers = null;
  let deviceCtrl = null;

  function setStatus(status, detail) { state.status = status; state.detail = detail || ''; AD.bus.emit('youtube:status', state); }
  function saveAuth(a) { auth = a; if (a) AD.store.set(AUTH_KEY, a); else AD.store.del(AUTH_KEY); AD.bus.emit('youtube:auth', !!a); }
  window.addEventListener('storage', (e) => { if (e.key === AUTH_KEY) { try { auth = e.newValue ? JSON.parse(e.newValue) : null; } catch (_) { } } });
  function addQuota(n) {
    const day = new Date().toISOString().slice(0, 10);
    if (state.quota.day !== day) state.quota = { day, units: 0 };
    state.quota.units += n; AD.store.set('ad.youtube.quota', state.quota); AD.bus.emit('youtube:status', state);
  }
  function remember(id) {
    if (!id) return false; if (seenIds.has(id)) return true;
    seenIds.add(id); seenOrder.push(id); if (seenOrder.length > 5000) { for (const x of seenOrder.splice(0, 2500)) seenIds.delete(x); }
    return false;
  }

  /* ---------------- OAuth device flow (Google "TV and Limited Input devices" client) ---------------- */
  async function startDeviceAuth() {
    const s = S(); const clientId = (s.clientId || '').trim(), secret = (s.clientSecret || '').trim();
    if (!clientId || !secret) throw new Error('Enter the Google OAuth Client ID and Client Secret first.');
    cancelDeviceAuth();
    const res = await fetch(OAUTH_DEVICE, { method: 'POST', body: new URLSearchParams({ client_id: clientId, scope: SCOPE }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Google rejected the request: ' + (d.error_description || d.error || res.status) + ' (the OAuth client must be type "TV and Limited Input devices")');
    state.deviceAuth = { user_code: d.user_code, verification_uri: d.verification_url || d.verification_uri || 'https://www.google.com/device', expires_at: Date.now() + d.expires_in * 1000 };
    setStatus('auth', 'Waiting for you to approve on google.com/device');
    const ctrl = { cancelled: false }; deviceCtrl = ctrl; let interval = Math.max(5, d.interval || 5) * 1000;
    (async () => {
      while (!ctrl.cancelled && Date.now() < state.deviceAuth.expires_at) {
        await AD.sleep(interval); if (ctrl.cancelled) return;
        const r = await fetch(OAUTH_TOKEN, { method: 'POST', body: new URLSearchParams({ client_id: clientId, client_secret: secret, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) });
        const t = await r.json().catch(() => ({}));
        if (r.ok && t.access_token) {
          state.deviceAuth = null;
          saveAuth({ clientId, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000, user: null });
          AD.log('YouTube: authorised'); AD.bus.emit('youtube:status', state);
          start().catch((e) => AD.log('error', 'YouTube start: ' + e.message));
          return;
        }
        if (t.error === 'authorization_pending') continue;
        if (t.error === 'slow_down') { interval += 5000; continue; }
        state.deviceAuth = null; setStatus('error', 'Authorisation failed: ' + (t.error_description || t.error || r.status)); return;
      }
      if (!ctrl.cancelled) { state.deviceAuth = null; setStatus('error', 'Device code expired - try again'); }
    })();
    return state.deviceAuth;
  }
  function cancelDeviceAuth() { if (deviceCtrl) deviceCtrl.cancelled = true; deviceCtrl = null; state.deviceAuth = null; }
  async function refreshToken() {
    if (!auth?.refresh_token) throw new Error('YouTube: no refresh token - please connect again');
    const s = S();
    const r = await fetch(OAUTH_TOKEN, { method: 'POST', body: new URLSearchParams({ client_id: auth.clientId || s.clientId, client_secret: (s.clientSecret || '').trim(), refresh_token: auth.refresh_token, grant_type: 'refresh_token' }) });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access_token) { if (t.error === 'invalid_grant') saveAuth(null); throw new Error('YouTube token refresh failed: ' + (t.error_description || t.error || r.status) + (t.error === 'invalid_grant' ? ' - connect again (tokens from apps in "Testing" status expire after 7 days)' : '')); }
    saveAuth({ ...auth, access_token: t.access_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000 });
  }
  async function bearer() { if (!auth) return null; if (Date.now() > auth.expires_at - 60_000) await refreshToken(); return auth.access_token; }
  async function logout() { stop(); if (auth?.access_token) { try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(auth.refresh_token || auth.access_token), { method: 'POST' }); } catch (_) { } } saveAuth(null); state.user = null; setStatus('disconnected', 'Signed out'); }

  /* ---------------- Data API ---------------- */
  function officialConfigured() { return !!(auth || (S().apiKey || '').trim()); }
  async function api(resource, params, { cost = 1, _retry = true } = {}) {
    const url = new URL(API + resource);
    for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') url.searchParams.set(k, v);
    const headers = {}; const tok = await bearer();
    if (tok) headers.Authorization = 'Bearer ' + tok; else if ((S().apiKey || '').trim()) url.searchParams.set('key', S().apiKey.trim()); else throw new Error('YouTube: add an API key or connect with Google first');
    addQuota(cost);
    const res = await fetch(url, { headers });
    const data = await res.json().catch(() => null);
    if (res.status === 401 && tok && _retry) { await refreshToken(); return api(resource, params, { cost: 0, _retry: false }); }
    if (!res.ok) { const reason = data?.error?.errors?.[0]?.reason || ''; const err = new Error('YouTube API: ' + (data?.error?.message || res.status) + (reason ? ' [' + reason + ']' : '')); err.status = res.status; err.reason = reason; throw err; }
    return data;
  }
  const isQuotaError = (e) => e?.reason === 'quotaExceeded' || /quota/i.test(e?.message || '');
  const parseVideoId = (v) => { v = (v || '').trim(); const m = /(?:v=|youtu\.be\/|\/live\/|\/shorts\/|\/embed\/)([\w-]{11})/.exec(v); return m ? m[1] : (/^[\w-]{11}$/.test(v) ? v : ''); };

  async function resolveTarget() {
    const s = S(); const vid = parseVideoId(s.videoId);
    if (s.source === 'video' || (s.source === 'auto' && vid && !auth)) {
      if (!vid) throw new Error('Paste your live stream URL / video ID');
      const d = await api('videos', { part: 'snippet,liveStreamingDetails', id: vid }, { cost: COST.videos });
      const v = d.items?.[0]; if (!v) throw new Error('Video not found: ' + vid);
      const chatId = v.liveStreamingDetails?.activeLiveChatId;
      if (!chatId) throw new Error(v.liveStreamingDetails?.actualEndTime ? 'That stream has ended' : 'No active live chat on that video yet (start the stream first)');
      return { videoId: vid, title: v.snippet?.title, liveChatId: chatId, channelId: v.snippet?.channelId };
    }
    if (auth) {
      // note: broadcastStatus / mine / id are mutually exclusive filters; broadcastStatus already means "my broadcasts".
      // broadcastType=all also includes the persistent "default stream" broadcast most streamers use.
      const d = await api('liveBroadcasts', { part: 'snippet,status', broadcastStatus: 'active', broadcastType: 'all', maxResults: 5 }, { cost: COST.liveBroadcasts });
      let b = (d.items || []).find((x) => x.snippet?.liveChatId) || null;
      if (!b) { // "upcoming" broadcasts can already have a chat (waiting room)
        const u = await api('liveBroadcasts', { part: 'snippet,status', broadcastStatus: 'upcoming', broadcastType: 'all', maxResults: 5 }, { cost: COST.liveBroadcasts });
        b = (u.items || []).find((x) => x.snippet?.liveChatId && x.status?.lifeCycleStatus !== 'created') || null;
      }
      if (!b) return null;
      return { videoId: b.id, title: b.snippet.title, liveChatId: b.snippet.liveChatId, channelId: b.snippet.channelId };
    }
    // API key + channel: search.list costs 100 units, so only when the user asked for it
    const ch = (s.channel || '').trim();
    if (!ch) throw new Error('Enter your live stream URL (cheapest), or your channel and enable the search-based lookup');
    let channelId = ch;
    if (!/^UC[\w-]{22}$/.test(ch)) { const d = await api('channels', { part: 'id', forHandle: ch.replace(/^.*\/@/, '@').replace(/^(?!@)/, '@') }, { cost: COST.channels }); channelId = d.items?.[0]?.id; if (!channelId) throw new Error('Channel not found: ' + ch); }
    const d = await api('search', { part: 'id', channelId, eventType: 'live', type: 'video', maxResults: 1 }, { cost: COST.search });
    const videoId = d.items?.[0]?.id?.videoId; if (!videoId) return null;
    const v = await api('videos', { part: 'snippet,liveStreamingDetails', id: videoId }, { cost: COST.videos });
    const it = v.items?.[0]; if (!it?.liveStreamingDetails?.activeLiveChatId) return null;
    return { videoId, title: it.snippet?.title, liveChatId: it.liveStreamingDetails.activeLiveChatId, channelId };
  }

  /* --- streamList: long-lived HTTP response containing a JSON array of responses; parse incrementally --- */
  async function runStream(myGen) {
    const url = new URL(API + 'liveChat/messages/stream');
    url.searchParams.set('liveChatId', state.liveChatId); url.searchParams.set('part', 'id,snippet,authorDetails'); url.searchParams.set('maxResults', '500'); url.searchParams.set('profileImageSize', '32');
    let pageToken = null, first = true, failures = 0, sess401 = false;
    while (running && myGen === gen) {
      if (pageToken) url.searchParams.set('pageToken', pageToken); else url.searchParams.delete('pageToken');
      const headers = {}; const tok = await bearer(); if (tok) headers.Authorization = 'Bearer ' + tok; else url.searchParams.set('key', S().apiKey.trim());
      streamAbort = new AbortController();
      let res;
      try { addQuota(COST.stream); res = await fetch(url, { headers, signal: streamAbort.signal }); }
      catch (e) { if (!running || myGen !== gen) return; failures++; AD.log('warn', 'YouTube stream: ' + e.message); await AD.sleep(Math.min(30000, 2000 * failures)); continue; }
      if (!res.ok) {
        const data = await res.json().catch(() => null); const errObj = Array.isArray(data) ? data[0]?.error : data?.error; const reason = errObj?.errors?.[0]?.reason || '';
        const err = new Error('YouTube stream: ' + (errObj?.message || res.status) + (reason ? ' [' + reason + ']' : '')); err.status = res.status; err.reason = reason;
        if (res.status === 401 && auth && !sess401) { sess401 = true; await refreshToken().catch(() => { }); continue; }
        if (reason === 'liveChatEnded' || reason === 'liveChatDisabled' || reason === 'liveChatNotFound') { onChatEnded(reason); return; }
        if (isQuotaError(err)) { onQuota(err); return; }
        if (res.status >= 400 && res.status < 500 || res.status === 501) { AD.log('warn', err.message + ' - falling back to polling'); state.method = 'poll'; AD.bus.emit('youtube:status', state); return runPoll(myGen); }
        failures++; AD.log('warn', err.message); await AD.sleep(Math.min(30000, 2000 * failures)); continue;
      }
      failures = 0; setStatus('connected', 'Streaming chat' + (state.title ? ': ' + state.title : ''));
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', depth = 0, inStr = false, escp = false, start = -1;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i = 0;
          for (; i < buf.length; i++) {
            const c = buf[i];
            if (inStr) { if (escp) escp = false; else if (c === '\\') escp = true; else if (c === '"') inStr = false; continue; }
            if (c === '"') inStr = true;
            else if (c === '{') { if (depth === 0) start = i; depth++; }
            else if (c === '}') { depth--; if (depth === 0 && start >= 0) { try { const obj = JSON.parse(buf.slice(start, i + 1)); if (obj.nextPageToken) pageToken = obj.nextPageToken; handleListResponse(obj, first); first = false; if (obj.offlineAt) { onChatEnded('offline'); return; } } catch (e) { AD.log('warn', 'stream parse: ' + e.message); } start = -1; } }
          }
          if (depth === 0) buf = ''; else if (start > 0) { buf = buf.slice(start); start = 0; }
        }
      } catch (e) { if (!running || myGen !== gen) return; AD.log('warn', 'YouTube stream closed: ' + e.message); }
      if (!running || myGen !== gen) return;
      AD.log('YouTube stream ended - reconnecting'); await AD.sleep(1000);
    }
  }
  /* --- classic polling --- */
  async function runPoll(myGen) {
    let pageToken = null, first = true, failures = 0;
    const loop = async () => {
      if (!running || myGen !== gen) return;
      try {
        const d = await api('liveChat/messages', { liveChatId: state.liveChatId, part: 'id,snippet,authorDetails', maxResults: 2000, pageToken, profileImageSize: 32 }, { cost: COST.list });
        failures = 0; pageToken = d.nextPageToken || pageToken; handleListResponse(d, first); first = false;
        setStatus('connected', 'Polling chat' + (state.title ? ': ' + state.title : ''));
        if (d.offlineAt) { onChatEnded('offline'); return; }
        const wait = Math.max((d.pollingIntervalMillis || 5000), (Number(S().pollMin) || 0) * 1000);
        pollTimer = setTimeout(loop, wait);
      } catch (e) {
        if (!running || myGen !== gen) return;
        if (e.reason === 'liveChatEnded' || e.reason === 'liveChatDisabled' || e.reason === 'liveChatNotFound') return onChatEnded(e.reason);
        if (isQuotaError(e)) return onQuota(e);
        failures++; AD.log('warn', e.message); pollTimer = setTimeout(loop, Math.min(60000, 5000 * failures));
      }
    };
    loop();
  }
  function onChatEnded(reason) {
    AD.log('YouTube: chat ended (' + reason + ')');
    AD.bus.emit('event', E.make('yt_system', { title: reason === 'liveChatDisabled' ? 'Live chat is disabled on this stream' : 'YouTube stream ended', meta: { reason } }));
    state.liveChatId = null; state.videoId = null; setStatus('idle', 'Waiting for the next stream…');
    resolveTimer = setTimeout(() => { if (running) start().catch(() => { }); }, auth ? 60_000 : 5 * 60_000);
  }
  function onQuota(err) {
    AD.log('error', err.message);
    if (state.helperOk) { AD.log('warn', 'YouTube: quota exceeded - switching to the helper'); AD.bus.emit('event', E.make('yt_system', { title: 'YouTube API quota exceeded - switched to helper feed' })); return startHelper(); }
    setStatus('error', 'Daily API quota exceeded (resets at midnight Pacific). Start the local server (start-dock.bat / node server.js) to keep going without quota.');
    running = false;
  }

  /* --- subscribers (OAuth only; public subscriptions only) --- */
  let lastSubsPoll = 0;
  async function pollSubscribers(myGen) {
    if (!auth || !S().subscribers) return;
    clearTimeout(subsTimer);
    // start() may run every minute while idle; keep this at one request per 2 minutes
    if (Date.now() - lastSubsPoll < 110_000) { subsTimer = setTimeout(() => pollSubscribers(myGen), 120_000 - (Date.now() - lastSubsPoll)); return; }
    lastSubsPoll = Date.now();
    try {
      const d = await api('subscriptions', { part: 'subscriberSnippet', myRecentSubscribers: 'true', maxResults: 50 }, { cost: COST.subscriptions });
      const items = d.items || [];
      const firstRun = knownSubscribers === null;
      if (firstRun) {
        knownSubscribers = new Set(AD.store.get(SUBS_KEY, []));
        // never seen anything: show the 50 most recent public subscribers as history so the feed is not empty
        if (!knownSubscribers.size && S().history !== false) for (const it of items.slice().reverse()) { knownSubscribers.add(it.id); const sn = it.subscriberSnippet || {}; AD.bus.emit('event', E.make('yt_subscriber', { id: 'ytsub-' + it.id, ts: Date.parse(it.snippet?.publishedAt) || Date.now(), user: { name: sn.title, id: sn.channelId, avatar: sn.thumbnails?.default?.url }, title: 'New subscriber', meta: { history: true, source: 'catchup' } })); }
      }
      let newOnes = 0;
      for (const it of items.slice().reverse()) {
        if (knownSubscribers.has(it.id)) continue; knownSubscribers.add(it.id); newOnes++;
        const sn = it.subscriberSnippet || {};
        AD.bus.emit('event', E.make('yt_subscriber', { id: 'ytsub-' + it.id, ts: Date.parse(it.snippet?.publishedAt) || Date.now(), user: { name: sn.title, id: sn.channelId, avatar: sn.thumbnails?.default?.url }, title: 'New subscriber', meta: firstRun ? { history: true, source: 'catchup' } : {} }));
      }
      if (firstRun && newOnes) AD.log('YouTube catch-up: ' + newOnes + ' new subscribers since last session');
      AD.store.set(SUBS_KEY, [...knownSubscribers].slice(-500));
      if (knownSubscribers.size > 2000) knownSubscribers = new Set([...knownSubscribers].slice(-500));
    } catch (e) { if (isQuotaError(e)) { AD.log('warn', 'subscriber poll: ' + e.message); return; } AD.log('warn', 'subscriber poll: ' + e.message); }
    if (running && myGen === gen) subsTimer = setTimeout(() => pollSubscribers(myGen), 120_000);
  }

  /* --- Super Chat / Super Sticker history: superChatEvents.list covers the last 30 days (OAuth only, 1 unit) --- */
  let superChatsLoaded = false;
  async function loadSuperChatHistory() {
    if (!auth || superChatsLoaded || S().history === false) return; superChatsLoaded = true;
    try {
      const d = await api('superChatEvents', { part: 'snippet', maxResults: 50 }, { cost: 1 });
      const seen = new Set(AD.store.get(SC_KEY, [])); let n = 0;
      for (const it of (d.items || []).slice().reverse()) {
        const sn = it.snippet || {}; const isNew = !seen.has(it.id); seen.add(it.id);
        const amt = Number(sn.amountMicros || 0) / 1e6, disp = sn.displayString || AD.fmtMoney(sn.amountMicros, sn.currency);
        const ev = E.make(sn.isSuperStickerEvent ? 'yt_sticker' : 'yt_superchat', { id: 'ytsc-' + it.id, ts: Date.parse(sn.createdAt) || Date.now(), user: { name: sn.supporterDetails?.displayName, id: sn.supporterDetails?.channelId, avatar: sn.supporterDetails?.profileImageUrl }, title: (sn.isSuperStickerEvent ? 'Super Sticker ' : 'Super Chat ') + disp, text: sn.commentText || sn.superStickerMetadata?.altText || '', amount: { value: amt, unit: 'currency', display: disp, currency: sn.currency }, meta: { tier: sn.messageType, history: true, source: 'catchup' } });
        AD.bus.emit('event', ev); if (isNew) n++;
      }
      AD.store.set(SC_KEY, [...seen].slice(-300));
      AD.log('YouTube: loaded ' + (d.items || []).length + ' super chats from the last 30 days (' + n + ' new)');
    } catch (e) { AD.log('warn', 'super chat history: ' + e.message); }
  }

  /* --- map official liveChatMessage resources --- */
  function handleListResponse(d, isHistory) {
    for (const it of d.items || []) {
      if (remember(it.id)) continue;
      try { const ev = mapOfficial(it); if (ev) { if (isHistory) ev.meta.history = true; AD.bus.emit('event', ev); } }
      catch (e) { AD.log('warn', 'YouTube map failed: ' + e.message); }
    }
  }
  function ytUser(a) {
    if (!a) return null;
    const badges = [];
    if (a.isChatOwner) badges.push({ title: 'Owner', set: 'owner' });
    if (a.isChatModerator) badges.push({ title: 'Moderator', set: 'moderator' });
    if (a.isChatSponsor) badges.push({ title: 'Member', set: 'member' });
    if (a.isVerified) badges.push({ title: 'Verified', set: 'verified' });
    return { name: a.displayName, id: a.channelId, avatar: a.profileImageUrl, badges, color: a.isChatOwner ? '#ffd600' : a.isChatModerator ? '#5e84f1' : a.isChatSponsor ? '#2ba640' : null };
  }
  function mapOfficial(it) {
    const sn = it.snippet || {}, a = ytUser(it.authorDetails), ts = Date.parse(sn.publishedAt) || Date.now(), base = { id: 'yt-' + it.id, ts, user: a };
    switch (sn.type) {
      case 'textMessageEvent': return S().chat ? E.make('yt_chat', { ...base, title: '', text: sn.displayMessage || sn.textMessageDetails?.messageText || '' }) : null;
      case 'superChatEvent': { const d = sn.superChatDetails || {}; const disp = d.amountDisplayString || AD.fmtMoney(d.amountMicros, d.currency); return E.make('yt_superchat', { ...base, title: 'Super Chat ' + disp, text: d.userComment || '', amount: { value: Number(d.amountMicros || 0) / 1e6, unit: 'currency', display: disp, currency: d.currency }, meta: { tier: d.tier } }); }
      case 'superStickerEvent': { const d = sn.superStickerDetails || {}; const disp = d.amountDisplayString || AD.fmtMoney(d.amountMicros, d.currency); return E.make('yt_sticker', { ...base, title: 'Super Sticker ' + disp, text: d.superStickerMetadata?.altText || '', amount: { value: Number(d.amountMicros || 0) / 1e6, unit: 'currency', display: disp, currency: d.currency }, meta: { tier: d.tier } }); }
      case 'newSponsorEvent': { const d = sn.newSponsorDetails || {}; return E.make('yt_member', { ...base, title: (d.isUpgrade ? 'Upgraded membership' : 'New member') + (d.memberLevelName ? ' (' + d.memberLevelName + ')' : ''), meta: { level: d.memberLevelName, upgrade: !!d.isUpgrade } }); }
      case 'memberMilestoneChatEvent': { const d = sn.memberMilestoneChatDetails || {}; const m = Number(d.memberMonth || 0); return E.make('yt_milestone', { ...base, title: 'Member for ' + m + ' month' + (m === 1 ? '' : 's') + (d.memberLevelName ? ' (' + d.memberLevelName + ')' : ''), text: d.userComment || '', amount: { value: m, unit: 'months', display: m + ' mo' }, meta: { level: d.memberLevelName } }); }
      case 'membershipGiftingEvent': { const d = sn.membershipGiftingDetails || {}; const n = Number(d.giftMembershipsCount || 1); return E.make('yt_giftmember', { ...base, title: 'Gifted ' + n + ' membership' + (n === 1 ? '' : 's') + (d.giftMembershipsLevelName ? ' (' + d.giftMembershipsLevelName + ')' : ''), amount: { value: n, unit: 'subs', display: n + ' members' }, meta: { level: d.giftMembershipsLevelName } }); }
      case 'giftMembershipReceivedEvent': { const d = sn.giftMembershipReceivedDetails || {}; return E.make('yt_giftrecv', { ...base, title: 'Received a gift membership' + (d.memberLevelName ? ' (' + d.memberLevelName + ')' : ''), meta: { level: d.memberLevelName, gifter: d.gifterChannelId } }); }
      case 'giftEvent': return E.make('yt_superchat', { ...base, title: 'Sent a gift' + (sn.displayMessage ? ': ' + sn.displayMessage : ''), text: '', meta: { gift: true } });
      case 'fanFundingEvent': { const d = sn.fanFundingEventDetails || {}; return E.make('yt_superchat', { ...base, title: 'Fan funding ' + (d.amountDisplayString || ''), text: d.userComment || '', amount: { value: Number(d.amountMicros || 0) / 1e6, unit: 'currency', display: d.amountDisplayString, currency: d.currency } }); }
      case 'pollEvent': return E.make('yt_system', { ...base, title: 'Poll: ' + (sn.pollDetails?.metadata?.questionText || sn.displayMessage || ''), meta: { poll: sn.pollDetails } });
      case 'userBannedEvent': { const d = sn.userBannedDetails || {}; return E.make('yt_system', { ...base, user: ytUser({ displayName: d.bannedUserDetails?.displayName, channelId: d.bannedUserDetails?.channelId, profileImageUrl: d.bannedUserDetails?.profileImageUrl }), title: (d.banType === 'temporary' ? 'Timed out' : 'Banned') + (d.banDurationSeconds ? ' for ' + d.banDurationSeconds + 's' : '') }); }
      case 'messageDeletedEvent': AD.bus.emit('event:delete', 'yt-' + (sn.messageDeletedDetails?.deletedMessageId || '')); return null;
      case 'messageRetractedEvent': AD.bus.emit('event:delete', 'yt-' + (sn.messageRetractedDetails?.retractedMessageId || '')); return null;
      case 'chatEndedEvent': return E.make('yt_system', { ...base, title: 'Chat ended' });
      case 'sponsorOnlyModeStartedEvent': return E.make('yt_system', { ...base, title: 'Members-only chat enabled' });
      case 'sponsorOnlyModeEndedEvent': return E.make('yt_system', { ...base, title: 'Members-only chat disabled' });
      case 'tombstone': return null;
      default: return E.make('yt_system', { ...base, title: sn.type || 'event', text: sn.displayMessage || '' });
    }
  }

  /* ---------------- helper (unofficial) via SSE ---------------- */
  function helperBase() { return (S().helperUrl || 'http://127.0.0.1:8520').replace(/\/$/, ''); }
  async function probeHelper() {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 2500);
      const r = await fetch(helperBase() + '/api/yt/status', { signal: ctrl.signal, cache: 'no-store' }); clearTimeout(t);
      const d = await r.json(); state.helperOk = !!d.ok; state.helperVersion = d.version || null;
    } catch (_) { state.helperOk = false; }
    AD.bus.emit('youtube:status', state);
    return state.helperOk;
  }
  function startHelper() {
    const s = S(); const vid = parseVideoId(s.videoId), ch = (s.channel || '').trim();
    if (!vid && !ch) { setStatus('error', 'Enter your channel (@handle or URL) or a live video URL'); return; }
    const myGen = ++gen; running = true; state.mode = 'helper'; state.method = 'sse'; closeStreams();
    const q = new URLSearchParams(); if (vid && (s.source !== 'channel')) q.set('video', vid); else q.set('channel', ch);
    setStatus('connecting', 'Connecting to helper…');
    sse = new EventSource(helperBase() + '/api/yt/stream?' + q);
    let first = true;
    sse.addEventListener('status', (m) => { const d = JSON.parse(m.data); Object.assign(state, { videoId: d.videoId || null, title: d.title || null, channelId: d.channelId || state.channelId }); setStatus(d.state === 'live' ? 'connected' : d.state === 'error' ? 'error' : 'idle', d.message || (d.state === 'live' ? 'Reading chat' + (d.title ? ': ' + d.title : '') : 'Waiting for the stream to go live…')); });
    sse.addEventListener('batch', (m) => { const d = JSON.parse(m.data); for (const raw of d.items || []) { if (remember(raw.id)) continue; try { const ev = mapHelper(raw); if (ev) { if (first || d.history) ev.meta.history = true; AD.bus.emit('event', ev); } } catch (e) { AD.log('warn', 'helper map: ' + e.message); } } first = false; });
    sse.addEventListener('delete', (m) => { const d = JSON.parse(m.data); for (const id of d.ids || []) AD.bus.emit('event:delete', 'yt-' + id); });
    sse.onerror = () => { if (myGen !== gen) return; if (sse.readyState === EventSource.CLOSED) { state.helperOk = false; setStatus('error', 'Helper stopped - waiting for it to come back'); retryTimer = setTimeout(() => running && start().catch(() => { }), 15_000); } else setStatus('connecting', 'Helper connection lost - retrying…'); };
    sse.onopen = () => { state.helperOk = true; AD.bus.emit('youtube:status', state); };
  }
  function mapHelper(r) {
    const a = r.author || {}; const badges = (a.badges || []).map((b) => ({ title: b.title, set: b.type, url: b.url || null }));
    const user = a.name ? { name: a.name, id: a.channelId, avatar: a.avatar, badges, color: a.isOwner ? '#ffd600' : a.isMod ? '#5e84f1' : a.isMember ? '#2ba640' : null } : null;
    const fragments = (r.runs || []).map((x) => x.emoji ? { type: 'emote', text: x.emoji.alt || '', url: x.emoji.url } : { type: 'text', text: x.text || '' });
    const base = { id: 'yt-' + r.id, ts: r.ts || Date.now(), user, text: r.text || '', fragments: fragments.length ? fragments : null };
    switch (r.kind) {
      case 'chat': return S().chat ? E.make('yt_chat', { ...base, title: '' }) : null;
      case 'superchat': return E.make('yt_superchat', { ...base, title: 'Super Chat ' + (r.amount?.display || ''), amount: { value: r.amount?.value || 0, unit: 'currency', display: r.amount?.display || '' }, meta: { color: r.amount?.color } });
      case 'sticker': return E.make('yt_sticker', { ...base, title: 'Super Sticker ' + (r.amount?.display || ''), text: r.text || '', amount: { value: r.amount?.value || 0, unit: 'currency', display: r.amount?.display || '' }, meta: { color: r.amount?.color, sticker: r.sticker } });
      case 'member': return E.make('yt_member', { ...base, title: r.headline || 'New member', meta: { level: r.level } });
      case 'milestone': return E.make('yt_milestone', { ...base, title: r.headline || 'Membership milestone', meta: { level: r.level } });
      case 'gift': return E.make('yt_giftmember', { ...base, title: r.headline || 'Gifted memberships', amount: r.count ? { value: r.count, unit: 'subs', display: r.count + ' members' } : null });
      case 'giftrecv': return E.make('yt_giftrecv', { ...base, title: r.headline || 'Received a gift membership' });
      case 'system': return E.make('yt_system', { ...base, title: r.headline || r.text || 'YouTube', text: r.headline ? r.text : '' });
      default: return null;
    }
  }

  /* ---------------- lifecycle ---------------- */
  function closeStreams() {
    clearTimeout(pollTimer); clearTimeout(subsTimer); clearTimeout(retryTimer); clearTimeout(resolveTimer); subsTimer = null;
    try { streamAbort?.abort(); } catch (_) { } streamAbort = null;
    try { sse?.close(); } catch (_) { } sse = null;
  }
  async function start() {
    const s = S(); if (!s.enabled) return;
    closeStreams(); const myGen = ++gen; running = true;
    const wantOfficial = s.mode === 'official' || (s.mode === 'auto' && officialConfigured());
    if (!wantOfficial) {
      if (s.mode === 'auto' && !state.helperOk) await probeHelper();
      if (state.helperOk || s.mode === 'unofficial') return startHelper();
      setStatus('error', 'Nothing configured: start the local server (start-dock.bat / node server.js) for the free helper, or add a YouTube API key / Google sign-in');
      resolveTimer = setTimeout(() => running && start().catch(() => { }), 30_000); return;
    }
    state.mode = 'official'; setStatus('connecting', 'Looking up your live stream…');
    let target = null;
    try { target = await resolveTarget(); }
    catch (e) { if (isQuotaError(e)) return onQuota(e); setStatus('error', e.message); AD.log('warn', 'YouTube: ' + e.message); resolveTimer = setTimeout(() => running && start().catch(() => { }), 2 * 60_000); return; }
    if (myGen !== gen) return;
    if (auth) { loadSuperChatHistory(); pollSubscribers(myGen); }
    if (!target) { setStatus('idle', 'No live stream found - will check again' + (auth ? ' in 1 min' : ' in 10 min')); resolveTimer = setTimeout(() => running && start().catch(() => { }), auth ? 60_000 : 10 * 60_000); return; }
    Object.assign(state, target);
    AD.log('YouTube: live chat ' + target.liveChatId + ' (' + target.title + ')');
    if (auth && !state.user) api('channels', { part: 'snippet', mine: 'true' }, { cost: COST.channels }).then((d) => { const c = d.items?.[0]; if (c) { state.user = { title: c.snippet.title, channelId: c.id, avatar: c.snippet.thumbnails?.default?.url }; AD.bus.emit('youtube:status', state); } }).catch(() => { });
    if (s.useStream !== false) { state.method = 'stream'; runStream(myGen); } else { state.method = 'poll'; runPoll(myGen); }
  }
  function stop() { running = false; gen++; closeStreams(); state.liveChatId = null; setStatus('disconnected'); }

  AD.youtube = {
    state, start, stop, startDeviceAuth, cancelDeviceAuth, logout, probeHelper, parseVideoId,
    hasAuth: () => !!auth, officialConfigured, helperBase,
    init() { probeHelper().then(() => { if (S().enabled) start().catch((e) => AD.log('warn', 'YouTube autostart: ' + e.message)); }); },
  };
})(window.AD);
