/* Activity Dock - Twitch: Device Code auth + EventSub WebSocket + Helix helpers
 * Runs entirely in the browser (Twitch's id/api endpoints allow CORS from any origin). */
(function (AD) {
  'use strict';
  const AUTH_KEY = 'ad.twitch.auth.v1';
  const ID_BASE = 'https://id.twitch.tv/oauth2';
  const WS_DEFAULT = 'wss://eventsub.wss.twitch.tv/ws';
  const HELIX_DEFAULT = 'https://api.twitch.tv/helix';

  // Scopes we ask for. If the saved token is missing any of these we ask the user to re-connect.
  const SCOPES = [
    'moderator:read:followers',   // channel.follow
    'channel:read:subscriptions', // subs, gifts, resubs
    'bits:read',                  // cheers / power-ups
    'channel:read:redemptions',   // channel point redeems
    'user:read:chat',             // chat messages + chat notices
    'channel:read:hype_train',
    'channel:read:ads',
    'moderator:read:shoutouts',
    'channel:read:charity',
  ];

  const S = () => AD.settings.get().twitch;
  const state = {
    status: 'disconnected', // disconnected | auth | connecting | connected | error
    detail: '',
    user: null,             // {id, login, name, avatar}
    sessionId: null,
    subs: {},               // type -> 'enabled' | 'failed: reason'
    deviceAuth: null,       // {user_code, verification_uri, expires_at}
  };
  let auth = AD.store.get(AUTH_KEY, null);
  let ws = null, wsReconnecting = null, keepaliveTimer = null, reconnectTimer = null, backoff = 1000;
  let validateTimer = null, refreshTimer = null, deviceAbort = null;
  const badges = new Map();      // "set/id" -> url
  const cheermotes = new Map();  // "prefix" -> [{min_bits, id, color, url}] sorted desc
  const avatars = new Map();     // userId -> url | null
  let avatarQueue = new Set(), avatarTimer = null;

  function setStatus(status, detail) {
    state.status = status; state.detail = detail || '';
    AD.bus.emit('twitch:status', state);
  }
  function saveAuth(a) { auth = a; if (a) AD.store.set(AUTH_KEY, a); else AD.store.del(AUTH_KEY); AD.bus.emit('twitch:auth', !!a); }
  // Another tab may have rotated the (one-time-use) refresh token; pick it up.
  window.addEventListener('storage', (e) => { if (e.key === AUTH_KEY) { try { auth = e.newValue ? JSON.parse(e.newValue) : null; } catch (_) { } } });

  const form = (o) => new URLSearchParams(o);
  async function idPost(path, params) {
    const res = await fetch(ID_BASE + path, { method: 'POST', body: form(params) });
    let data = null; try { data = await res.json(); } catch (_) { }
    return { ok: res.ok, status: res.status, data };
  }

  /* ---------------- Device Code Flow ---------------- */
  async function startDeviceAuth() {
    const clientId = (S().clientId || '').trim();
    if (!clientId) throw new Error('Enter your Twitch Client ID first.');
    cancelDeviceAuth();
    const r = await idPost('/device', { client_id: clientId, scopes: SCOPES.join(' ') });
    if (!r.ok) throw new Error('Twitch rejected the request (' + r.status + '): ' + (r.data?.message || 'check the Client ID and that the app is a "Public" client'));
    const d = r.data;
    state.deviceAuth = { user_code: d.user_code, verification_uri: d.verification_uri, expires_at: Date.now() + d.expires_in * 1000 };
    setStatus('auth', 'Waiting for you to approve on twitch.tv');
    const ctrl = { cancelled: false }; deviceAbort = ctrl;
    const interval = Math.max(5, d.interval || 5) * 1000;
    (async () => {
      while (!ctrl.cancelled && Date.now() < state.deviceAuth.expires_at) {
        await AD.sleep(interval);
        if (ctrl.cancelled) return;
        const t = await idPost('/token', { client_id: clientId, scopes: SCOPES.join(' '), device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
        if (t.ok && t.data?.access_token) {
          state.deviceAuth = null;
          saveAuth({ clientId, access_token: t.data.access_token, refresh_token: t.data.refresh_token, expires_at: Date.now() + (t.data.expires_in || 14400) * 1000, scope: t.data.scope || SCOPES, user: null });
          AD.log('Twitch: authorised');
          connect().catch((e) => AD.log('error', 'Twitch connect failed: ' + e.message));
          return;
        }
        const msg = t.data?.message || '';
        if (/authorization_pending/i.test(msg)) continue;
        if (/slow_down/i.test(msg)) { await AD.sleep(interval); continue; }
        state.deviceAuth = null;
        setStatus('error', 'Authorisation failed: ' + (msg || t.status));
        return;
      }
      if (!ctrl.cancelled) { state.deviceAuth = null; setStatus('error', 'Device code expired - try again'); }
    })();
    return state.deviceAuth;
  }
  function cancelDeviceAuth() { if (deviceAbort) deviceAbort.cancelled = true; deviceAbort = null; state.deviceAuth = null; }

  /* ---------------- token maintenance ---------------- */
  let refreshing = null;
  function refreshToken() { return refreshing || (refreshing = doRefresh().finally(() => { refreshing = null; })); }
  async function doRefresh() {
    // Another dock (second OBS dock / browser tab) may have rotated the one-time refresh token already.
    const stored = AD.store.get(AUTH_KEY, null);
    if (stored?.access_token && stored.refresh_token !== auth?.refresh_token && stored.expires_at > Date.now() + 5 * 60_000) { auth = stored; AD.log('Twitch: using token refreshed by another dock'); scheduleRefresh(); return; }
    if (!auth?.refresh_token) throw new Error('No refresh token - please connect again');
    const used = auth.refresh_token;
    const r = await idPost('/token', { client_id: auth.clientId, grant_type: 'refresh_token', refresh_token: used });
    if (!r.ok || !r.data?.access_token) {
      const msg = r.data?.message || ('HTTP ' + r.status);
      const again = AD.store.get(AUTH_KEY, null);
      if (again?.access_token && again.refresh_token !== used) { auth = again; AD.log('Twitch: refresh raced with another dock - adopted its token'); scheduleRefresh(); return; }
      if (r.status === 400 || r.status === 401) { saveAuth(null); }
      throw new Error('Token refresh failed: ' + msg);
    }
    saveAuth({ ...auth, access_token: r.data.access_token, refresh_token: r.data.refresh_token || auth.refresh_token, expires_at: Date.now() + (r.data.expires_in || 14400) * 1000, scope: r.data.scope || auth.scope });
    AD.log('Twitch: token refreshed');
    scheduleRefresh();
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (!auth) return;
    // refresh ~10 min before expiry, with random jitter so two docks don't collide
    const inMs = Math.max(30_000, (auth.expires_at - Date.now()) - 10 * 60_000 - Math.floor(Math.random() * 120_000));
    refreshTimer = setTimeout(() => refreshToken().catch((e) => { AD.log('warn', e.message); setStatus('error', e.message); }), Math.min(inMs, 2 ** 31 - 1));
  }
  async function validate() {
    if (S().skipValidate) { return { user_id: '12345', login: 'devuser', scopes: SCOPES, expires_in: 99999 }; }
    const res = await fetch(ID_BASE + '/validate', { headers: { Authorization: 'OAuth ' + auth.access_token } });
    if (res.status === 401) { await refreshToken(); return validate(); }
    if (!res.ok) throw new Error('validate failed: HTTP ' + res.status);
    const v = await res.json();
    auth.expires_at = Date.now() + (v.expires_in || 0) * 1000; auth.scope = v.scopes || auth.scope; saveAuth(auth);
    return v;
  }
  function missingScopes() { const have = new Set(auth?.scope || []); return SCOPES.filter((s) => !have.has(s)); }

  /* ---------------- Helix ---------------- */
  async function helix(path, { method = 'GET', body, query, _retry = true } = {}) {
    if (!auth) throw new Error('Not authorised');
    const base = (S().helixUrl || HELIX_DEFAULT).replace(/\/$/, '');
    let url = base + '/' + path.replace(/^\//, '');
    if (query) { const q = new URLSearchParams(); for (const [k, v] of Object.entries(query)) (Array.isArray(v) ? v : [v]).forEach((x) => x != null && q.append(k, x)); url += (url.includes('?') ? '&' : '?') + q; }
    const res = await fetch(url, { method, headers: { Authorization: 'Bearer ' + auth.access_token, 'Client-Id': auth.clientId, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401 && _retry && !S().skipValidate) { await refreshToken(); return helix(path, { method, body, query, _retry: false }); }
    if (res.status === 429) { const reset = Number(res.headers.get('Ratelimit-Reset')) * 1000; await AD.sleep(Math.max(1000, reset - Date.now())); return helix(path, { method, body, query, _retry }); }
    let data = null; try { data = await res.json(); } catch (_) { }
    if (!res.ok) { const err = new Error((data?.message || res.statusText || 'Helix error') + ' (' + res.status + ')'); err.status = res.status; err.data = data; throw err; }
    return data;
  }

  async function loadUser() {
    if (S().skipValidate) { state.user = { id: '12345', login: 'devuser', name: 'DevUser', avatar: null }; return state.user; }
    const v = await validate();
    let u = { id: v.user_id, login: v.login, name: v.login, avatar: null };
    try { const d = await helix('users'); if (d?.data?.[0]) { const x = d.data[0]; u = { id: x.id, login: x.login, name: x.display_name, avatar: x.profile_image_url }; avatars.set(x.id, x.profile_image_url); } } catch (e) { AD.log('warn', 'users lookup failed: ' + e.message); }
    state.user = u; auth.user = u; saveAuth(auth);
    return u;
  }
  async function loadBadgesAndCheermotes() {
    const bid = state.user.id;
    const ingest = (d) => { for (const set of d?.data || []) for (const v of set.versions || []) badges.set(set.set_id + '/' + v.id, v.image_url_1x || v.image_url_2x); };
    await Promise.allSettled([
      helix('chat/badges/global').then(ingest),
      helix('chat/badges', { query: { broadcaster_id: bid } }).then(ingest),
      helix('bits/cheermotes', { query: { broadcaster_id: bid } }).then((d) => {
        for (const cm of d?.data || []) {
          const tiers = (cm.tiers || []).map((t) => ({ min_bits: t.min_bits, id: String(t.id), color: t.color, url: t.images?.dark?.animated?.['1'] || t.images?.dark?.static?.['1'] })).sort((a, b) => b.min_bits - a.min_bits);
          cheermotes.set(cm.prefix.toLowerCase(), tiers);
        }
      }),
    ]);
    AD.log('Twitch: loaded ' + badges.size + ' badges, ' + cheermotes.size + ' cheermotes');
  }

  /* ---------------- avatars (batched) ---------------- */
  function getAvatar(userId) {
    if (!userId) return null;
    if (avatars.has(userId)) return avatars.get(userId);
    if (!auth || S().skipValidate) return null;
    avatarQueue.add(userId);
    if (!avatarTimer) avatarTimer = setTimeout(flushAvatars, 400);
    return null;
  }
  async function flushAvatars() {
    avatarTimer = null;
    const ids = [...avatarQueue].slice(0, 100); ids.forEach((i) => avatarQueue.delete(i));
    if (!ids.length) return;
    try {
      const d = await helix('users', { query: { id: ids } });
      const found = {};
      for (const u of d?.data || []) { avatars.set(u.id, u.profile_image_url); found[u.id] = u.profile_image_url; }
      ids.forEach((i) => { if (!avatars.has(i)) avatars.set(i, null); });
      if (avatars.size > 3000) { for (const k of [...avatars.keys()].slice(0, 1000)) avatars.delete(k); }
      AD.bus.emit('avatars', found);
    } catch (e) { AD.log('warn', 'avatar lookup failed: ' + e.message); }
    if (avatarQueue.size) avatarTimer = setTimeout(flushAvatars, 400);
  }

  /* ---------------- EventSub WebSocket ---------------- */
  function subscriptionList() {
    const uid = state.user.id, s = S();
    const b = { broadcaster_user_id: uid };
    const list = [
      ['channel.follow', '2', { ...b, moderator_user_id: uid }],
      ['channel.subscribe', '1', b],
      ['channel.subscription.gift', '1', b],
      ['channel.subscription.message', '1', b],
      ['channel.cheer', '1', b],
      ['channel.bits.use', '1', b],
      ['channel.raid', '1', { to_broadcaster_user_id: uid }],
      ['channel.channel_points_custom_reward_redemption.add', '1', b],
      ['channel.channel_points_automatic_reward_redemption.add', '2', b],
      ['channel.charity_campaign.donate', '1', b],
      ['channel.shoutout.create', '1', { ...b, moderator_user_id: uid }],
      ['channel.shoutout.receive', '1', { ...b, moderator_user_id: uid }],
    ];
    if (s.chat || s.notices) list.push(['channel.chat.notification', '1', { ...b, user_id: uid }]);
    if (s.chat) list.push(['channel.chat.message', '1', { ...b, user_id: uid }]);
    if (s.hype) list.push(['channel.hype_train.begin', '2', b], ['channel.hype_train.progress', '2', b], ['channel.hype_train.end', '2', b]);
    if (s.ads) list.push(['channel.ad_break.begin', '1', b]);
    if (s.streamStatus) list.push(['stream.online', '1', b], ['stream.offline', '1', b]);
    return list;
  }
  async function createSubscriptions(sessionId) {
    state.subs = {};
    const results = await Promise.allSettled(subscriptionList().map(([type, version, condition]) =>
      helix('eventsub/subscriptions', { method: 'POST', body: { type, version, condition, transport: { method: 'websocket', session_id: sessionId } } })
        .then(() => { state.subs[type] = 'enabled'; })
        .catch((e) => {
          let why = e.message;
          if (e.status === 403) why = 'not allowed - ' + (/subscri|cheer|bits|hype|redemption|reward|charity/.test(type) ? 'needs Affiliate/Partner or missing scope' : 'missing scope');
          if (e.status === 409) why = 'already subscribed';
          state.subs[type] = 'failed: ' + why;
        })));
    const ok = Object.values(state.subs).filter((v) => v === 'enabled').length;
    AD.log('Twitch: ' + ok + '/' + results.length + ' EventSub subscriptions active');
    AD.bus.emit('twitch:status', state);
    if (!ok) throw new Error('No EventSub subscriptions could be created');
  }

  function openSocket(url, isReconnect) {
    const sock = new WebSocket(url);
    sock.onopen = () => AD.log('Twitch: websocket open' + (isReconnect ? ' (reconnect)' : ''));
    sock.onmessage = (m) => { let msg; try { msg = JSON.parse(m.data); } catch (_) { return; } onMessage(sock, msg, isReconnect); };
    sock.onclose = (e) => {
      if (sock !== ws && sock !== wsReconnecting) return;
      if (sock === wsReconnecting) { wsReconnecting = null; return; }
      ws = null; clearTimeout(keepaliveTimer);
      AD.log('warn', 'Twitch: websocket closed (' + e.code + (e.reason ? ' ' + e.reason : '') + ')');
      if (sock._manual) { if (sock._giveUp) return; setStatus('disconnected'); return; }
      const fatal = e.code === 4001 || e.code === 4002 || e.code === 4005 || e.code === 4006;
      setStatus('connecting', 'Reconnecting…');
      scheduleReconnect(fatal ? 5000 : undefined);
    };
    sock.onerror = () => { /* onclose follows */ };
    return sock;
  }
  function armKeepalive(seconds) {
    clearTimeout(keepaliveTimer);
    keepaliveTimer = setTimeout(() => { AD.log('warn', 'Twitch: keepalive timeout - reconnecting'); try { ws?.close(); } catch (_) { } }, (seconds + 8) * 1000);
  }
  function scheduleReconnect(ms) {
    clearTimeout(reconnectTimer);
    const wait = ms ?? backoff; backoff = Math.min(backoff * 2, 30_000);
    reconnectTimer = setTimeout(() => connect().catch((e) => { setStatus('error', e.message); scheduleReconnect(); }), wait);
  }
  let lastKeepaliveSec = 30;
  async function onMessage(sock, msg, isReconnect) {
    const type = msg.metadata?.message_type;
    if (sock === ws || sock === wsReconnecting) armKeepalive(lastKeepaliveSec);
    switch (type) {
      case 'session_welcome': {
        lastKeepaliveSec = msg.payload.session.keepalive_timeout_seconds || 30;
        if (isReconnect) { // new socket ready: swap
          const old = ws; ws = sock; wsReconnecting = null; try { old?.close(); } catch (_) { }
          state.sessionId = msg.payload.session.id; AD.log('Twitch: reconnect complete');
          return;
        }
        state.sessionId = msg.payload.session.id;
        try { await createSubscriptions(state.sessionId); backoff = 1000; setStatus('connected'); }
        catch (e) {
          // Nothing could be subscribed (wrong scopes / not affiliate for everything?) - stop and show why instead of hammering Twitch.
          const first = Object.values(state.subs).find((v) => v !== 'enabled') || '';
          setStatus('error', e.message + (first ? ' (' + first.replace(/^failed: /, '') + ')' : '') + ' - use Reconnect to retry');
          sock._manual = true; sock._giveUp = true; sock.close();
        }
        return;
      }
      case 'session_keepalive': return;
      case 'session_reconnect': {
        const url = msg.payload.session.reconnect_url; AD.log('Twitch: reconnect requested');
        wsReconnecting = openSocket(url, true);
        return;
      }
      case 'revocation': {
        const t = msg.payload.subscription?.type; state.subs[t] = 'revoked: ' + msg.payload.subscription?.status; AD.log('warn', 'Twitch: subscription revoked ' + t);
        AD.bus.emit('twitch:status', state); return;
      }
      case 'notification': {
        try { const ev = mapNotification(msg.payload.subscription, msg.payload.event); if (ev) AD.bus.emit('event', ev); }
        catch (e) { AD.log('error', 'Twitch: failed to map ' + msg.payload.subscription?.type + ': ' + (e.stack || e)); }
        return;
      }
    }
  }

  async function connect() {
    if (!auth) { setStatus('disconnected', 'Not connected'); return; }
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    clearTimeout(reconnectTimer);
    setStatus('connecting', 'Checking token…');
    try {
      await loadUser();
      scheduleRefresh();
      clearInterval(validateTimer); validateTimer = setInterval(() => validate().catch((e) => AD.log('warn', 'validate: ' + e.message)), 60 * 60_000);
      if (!badges.size) loadBadgesAndCheermotes();
      setStatus('connecting', 'Opening EventSub socket…');
      const url = (S().wsUrl || WS_DEFAULT);
      ws = openSocket(url, false);
    } catch (e) {
      setStatus('error', e.message); throw e;
    }
  }
  function disconnect() {
    clearTimeout(reconnectTimer); clearTimeout(keepaliveTimer); clearInterval(validateTimer); clearTimeout(refreshTimer);
    if (ws) ws._manual = true; if (wsReconnecting) wsReconnecting._manual = true;
    try { ws?.close(); } catch (_) { } try { wsReconnecting?.close(); } catch (_) { }
    ws = null; wsReconnecting = null; state.sessionId = null; state.subs = {};
    setStatus('disconnected');
  }
  async function logout() {
    disconnect();
    if (auth?.access_token) { try { await idPost('/revoke', { client_id: auth.clientId, token: auth.access_token }); } catch (_) { } }
    saveAuth(null); state.user = null; setStatus('disconnected', 'Signed out');
  }

  /* ---------------- mapping EventSub -> normalized events ---------------- */
  const E = AD.events;
  const usr = (e, p) => (e[p + '_id'] || e[p + '_login'] || e[p + '_name']) ? { id: e[p + '_id'], login: e[p + '_login'], name: e[p + '_name'] || e[p + '_login'] } : null;
  const ANON = { id: null, login: null, name: 'Anonymous' };
  const emoteUrl = (id) => 'https://static-cdn.jtvnw.net/emoticons/v2/' + id + '/default/dark/1.0';
  function cheermote(prefix, bits) {
    const tiers = cheermotes.get(String(prefix).toLowerCase()); if (!tiers) return null;
    return tiers.find((t) => bits >= t.min_bits) || tiers[tiers.length - 1];
  }
  function fragsFromChat(frags) {
    return (frags || []).map((f) => {
      if (f.type === 'emote' && f.emote?.id) return { type: 'emote', text: f.text, url: emoteUrl(f.emote.id) };
      if (f.type === 'cheermote' && f.cheermote) { const cm = cheermote(f.cheermote.prefix, f.cheermote.bits); return { type: 'cheermote', text: f.text, bits: f.cheermote.bits, url: cm?.url, color: cm?.color }; }
      if (f.type === 'mention') return { type: 'mention', text: f.text };
      return { type: 'text', text: f.text };
    });
  }
  function fragsFromEmotePositions(text, emotes) {
    if (!emotes?.length) return null;
    const cps = Array.from(text || ''); const out = []; let pos = 0;
    for (const em of [...emotes].sort((a, b) => a.begin - b.begin)) {
      if (em.begin > pos) out.push({ type: 'text', text: cps.slice(pos, em.begin).join('') });
      out.push({ type: 'emote', text: cps.slice(em.begin, em.end + 1).join(''), url: emoteUrl(em.id) });
      pos = em.end + 1;
    }
    if (pos < cps.length) out.push({ type: 'text', text: cps.slice(pos).join('') });
    return out;
  }
  function fragsFromCheerText(text) {
    if (!text) return null; const out = []; const re = /([A-Za-z]+)(\d+)/g; let last = 0, m;
    while ((m = re.exec(text))) {
      const cm = cheermotes.size ? cheermote(m[1], Number(m[2])) : null; if (!cm && !/^cheer$/i.test(m[1])) continue;
      if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
      out.push({ type: 'cheermote', text: m[0], bits: Number(m[2]), url: cm?.url, color: cm?.color }); last = m.index + m[0].length;
    }
    if (!out.length) return null; if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
    return out;
  }
  function badgeList(arr) { return (arr || []).map((b) => ({ title: b.set_id + (b.info ? ' ' + b.info : ''), set: b.set_id, url: badges.get(b.set_id + '/' + b.id) || null })); }
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const AUTO_REWARDS = { single_message_bypass_sub_mode: 'Send a message in sub-only mode', send_highlighted_message: 'Highlight my message', random_sub_emote_unlock: 'Unlock a random sub emote', chosen_sub_emote_unlock: 'Unlock a sub emote', chosen_modified_sub_emote_unlock: 'Modify a sub emote', message_effect: 'Message effect', gigantify_an_emote: 'Gigantify an emote', celebration: 'On-screen celebration' };

  function mapNotification(sub, e) {
    const t = sub.type; let ts = Date.now();
    switch (t) {
      case 'channel.follow':
        return E.make('tw_follow', { user: usr(e, 'user'), title: 'New follower' });
      case 'channel.subscribe': {
        const tier = AD.tierName(e.tier);
        if (e.is_gift) return E.make('tw_giftrecv', { user: usr(e, 'user'), title: 'Received a gift sub (' + tier + ')', meta: { tier: e.tier } });
        return E.make('tw_sub', { user: usr(e, 'user'), title: 'Subscribed (' + tier + ')', meta: { tier: e.tier } });
      }
      case 'channel.subscription.gift': {
        const n = Number(e.total || 1), tier = AD.tierName(e.tier);
        return E.make('tw_gift', { user: e.is_anonymous ? ANON : usr(e, 'user'), title: 'Gifted ' + plural(n, 'sub') + ' (' + tier + ')', text: e.cumulative_total ? 'Total gifted: ' + e.cumulative_total : '', amount: { value: n, unit: 'subs', display: n + ' × ' + tier }, meta: { tier: e.tier, total: n } });
      }
      case 'channel.subscription.message': {
        const m = Number(e.cumulative_months || 0), streak = e.streak_months, tier = AD.tierName(e.tier);
        return E.make('tw_resub', { user: usr(e, 'user'), title: 'Resubscribed - ' + plural(m, 'month') + ' (' + tier + ')' + (streak ? ', ' + streak + ' streak' : ''), text: e.message?.text || '', fragments: fragsFromEmotePositions(e.message?.text, e.message?.emotes), amount: { value: m, unit: 'months', display: m + ' mo' }, meta: { tier: e.tier, cumulative_months: m, streak_months: streak, duration_months: e.duration_months } });
      }
      case 'channel.cheer': {
        const bits = Number(e.bits || 0);
        return E.make('tw_cheer', { user: e.is_anonymous ? ANON : usr(e, 'user'), title: 'Cheered ' + AD.fmtNum(bits) + ' bits', text: e.message || '', fragments: fragsFromCheerText(e.message), amount: { value: bits, unit: 'bits', display: AD.fmtNum(bits) + ' bits' } });
      }
      case 'channel.bits.use': {
        const bits = Number(e.bits || 0);
        if (!e.type || e.type === 'cheer') { // regular cheers normally arrive via channel.cheer - only map here if that one is not active
          if (state.subs['channel.cheer'] === 'enabled') return null;
          return E.make('tw_cheer', { user: usr(e, 'user'), title: 'Cheered ' + AD.fmtNum(bits) + ' bits', text: e.message?.text || '', fragments: fragsFromChat(e.message?.fragments), amount: { value: bits, unit: 'bits', display: AD.fmtNum(bits) + ' bits' } });
        }
        const pu = e.power_up || e.custom_power_up || {};
        const what = e.type === 'power_up' ? (AUTO_REWARDS[pu.type] || pu.type || 'Power-up') : e.type === 'combo' ? 'Combo' : (pu.name || e.type);
        return E.make('tw_cheer', { user: usr(e, 'user'), title: what + ' - ' + AD.fmtNum(bits) + ' bits', text: e.message?.text || '', fragments: fragsFromChat(e.message?.fragments), amount: { value: bits, unit: 'bits', display: AD.fmtNum(bits) + ' bits' }, meta: { bits_type: e.type } });
      }
      case 'channel.raid': {
        const v = Number(e.viewers || 0);
        return E.make('tw_raid', { user: usr(e, 'from_broadcaster_user'), title: 'Raiding with ' + plural(v, 'viewer'), amount: { value: v, unit: 'viewers', display: v + ' viewers' } });
      }
      case 'channel.channel_points_custom_reward_redemption.add': {
        const r = e.reward || {}; const cost = Number(r.cost || 0);
        return E.make('tw_redeem', { user: usr(e, 'user'), title: 'Redeemed ' + (r.title || 'a reward'), text: e.user_input || '', amount: { value: cost, unit: 'points', display: AD.fmtNum(cost) + ' pts' }, meta: { reward: r.title, reward_id: r.id, redemption_id: e.id, status: e.status } });
      }
      case 'channel.channel_points_automatic_reward_redemption.add': {
        const r = e.reward || {}; const cost = Number(r.channel_points ?? r.cost ?? 0); const label = AUTO_REWARDS[r.type] || r.type || 'reward';
        const text = e.message?.text || e.user_input || '';
        return E.make('tw_redeem', { user: usr(e, 'user'), title: 'Redeemed ' + label, text, fragments: fragsFromChat(e.message?.fragments), amount: { value: cost, unit: 'points', display: AD.fmtNum(cost) + ' pts' }, meta: { reward: label, automatic: true, emote: r.emote?.name || r.unlocked_emote?.name } });
      }
      case 'channel.charity_campaign.donate': {
        const a = e.amount || {}; const val = Number(a.value || 0) / Math.pow(10, a.decimal_places || 0);
        const display = AD.fmtMoney(val * 1e6, a.currency);
        return E.make('tw_cheer', { user: usr(e, 'user'), title: 'Donated ' + display + ' to ' + (e.charity_name || 'charity'), amount: { value: val, unit: 'currency', display, currency: a.currency }, meta: { charity: true } });
      }
      case 'channel.shoutout.create':
        return E.make('tw_shoutout', { user: usr(e, 'to_broadcaster_user'), title: 'You gave a shoutout to ' + (e.to_broadcaster_user_name || ''), amount: { value: Number(e.viewer_count || 0), unit: 'viewers', display: e.viewer_count + ' viewers' } });
      case 'channel.shoutout.receive':
        return E.make('tw_shoutout', { user: usr(e, 'from_broadcaster_user'), title: 'Gave you a shoutout', amount: { value: Number(e.viewer_count || 0), unit: 'viewers', display: e.viewer_count + ' viewers' } });
      case 'channel.chat.message': {
        if (!S().chat) return null;
        const user = { ...usr(e, 'chatter_user'), color: e.color || null, badges: badgeList(e.badges) };
        const bits = e.cheer?.bits ? Number(e.cheer.bits) : 0;
        return E.make('tw_chat', { id: 'tw-' + e.message_id, user, title: '', text: e.message?.text || '', fragments: fragsFromChat(e.message?.fragments), amount: bits ? { value: bits, unit: 'bits', display: AD.fmtNum(bits) + ' bits' } : null, meta: { message_type: e.message_type, reply: e.reply ? { to: e.reply.parent_user_name, text: e.reply.parent_message_body } : null, highlighted: e.message_type === 'channel_points_highlighted' || !!e.channel_points_custom_reward_id, shared_from: e.source_broadcaster_user_name && e.source_broadcaster_user_id !== state.user?.id ? e.source_broadcaster_user_name : null, first: e.message_type === 'user_intro' } });
      }
      case 'channel.chat.notification': return mapChatNotice(e);
      case 'channel.hype_train.begin':
        return E.make('tw_hype', { title: (e.is_shared_train ? 'Shared ' : '') + 'Hype Train started! Level ' + e.level, text: 'Goal ' + AD.fmtNum(e.goal) + ' - ' + AD.fmtNum(e.total) + ' so far', amount: { value: e.level, unit: 'level', display: 'Lvl ' + e.level }, meta: { phase: 'begin', ...hypeMeta(e) } });
      case 'channel.hype_train.progress': {
        if (state._hypeLevel === e.level) return null; state._hypeLevel = e.level;
        return E.make('tw_hype', { title: 'Hype Train level ' + e.level + '!', text: AD.fmtNum(e.progress) + ' / ' + AD.fmtNum(e.goal), amount: { value: e.level, unit: 'level', display: 'Lvl ' + e.level }, meta: { phase: 'progress', ...hypeMeta(e) } });
      }
      case 'channel.hype_train.end': {
        state._hypeLevel = null;
        const top = (e.top_contributions || []).map((c) => c.user_name + ' (' + AD.fmtNum(c.total) + ' ' + c.type + ')').join(', ');
        return E.make('tw_hype', { title: 'Hype Train ended at level ' + e.level, text: top ? 'Top: ' + top : '', amount: { value: e.level, unit: 'level', display: 'Lvl ' + e.level }, meta: { phase: 'end', ...hypeMeta(e) } });
      }
      case 'channel.ad_break.begin': {
        const secs = Number(e.duration_seconds || 0);
        return E.make('tw_ad', { user: e.is_automatic ? null : usr(e, 'requester_user'), title: (e.is_automatic ? 'Automatic ad' : 'Ad') + ' break started - ' + secs + 's', meta: { seconds: secs, automatic: !!e.is_automatic } });
      }
      case 'stream.online': return E.make('tw_stream', { title: 'Stream is live', meta: { online: true } });
      case 'stream.offline': return E.make('tw_stream', { title: 'Stream went offline', meta: { online: false } });
      default:
        return E.make('tw_notice', { title: t, text: JSON.stringify(e).slice(0, 200) });
    }
  }
  const hypeMeta = (e) => ({ level: e.level, total: e.total, goal: e.goal, progress: e.progress, shared: !!e.is_shared_train, id: e.id });

  // Chat notices: only the ones not already delivered by a dedicated subscription (unless that one failed)
  const COVERED = { sub: 'channel.subscribe', resub: 'channel.subscription.message', sub_gift: 'channel.subscription.gift', community_sub_gift: 'channel.subscription.gift', raid: 'channel.raid' };
  const NOTICE_ONLY = new Set(['announcement', 'watch_streak', 'bits_badge_tier', 'modiversary', 'unraid']);
  function mapChatNotice(e) {
    const nt = e.notice_type; if (!nt) return null;
    const shared = nt.startsWith('shared_chat_'); const base = shared ? nt.slice(12) : nt;
    const fromChannel = shared && e.source_broadcaster_user_name ? e.source_broadcaster_user_name : null;
    if (!shared && COVERED[base] && state.subs[COVERED[base]] === 'enabled') return null;
    if (!S().notices && (shared || NOTICE_ONLY.has(base))) return null;
    const user = e.chatter_is_anonymous ? ANON : { ...usr(e, 'chatter_user'), color: e.color || null, badges: badgeList(e.badges) };
    const text = e.message?.text || '', fragments = fragsFromChat(e.message?.fragments);
    const sys = e.system_message || '';
    const d = e[nt] || e[base] || {};
    const via = fromChannel ? { shared_from: fromChannel } : {};
    switch (base) {
      case 'sub': return E.make('tw_sub', { user, title: 'Subscribed (' + AD.tierName(d.sub_tier) + ')' + (fromChannel ? ' in ' + fromChannel : ''), meta: { tier: d.sub_tier, ...via } });
      case 'resub': { const m = Number(d.cumulative_months || 0); return E.make('tw_resub', { user, title: 'Resubscribed - ' + plural(m, 'month') + (fromChannel ? ' in ' + fromChannel : ''), text, fragments, amount: { value: m, unit: 'months', display: m + ' mo' }, meta: { tier: d.sub_tier, ...via } }); }
      case 'sub_gift': return E.make('tw_gift', { user, title: 'Gifted a sub to ' + (d.recipient_user_name || 'someone') + (fromChannel ? ' in ' + fromChannel : ''), amount: { value: 1, unit: 'subs', display: '1 × ' + AD.tierName(d.sub_tier) }, meta: { tier: d.sub_tier, total: 1, ...via } });
      case 'community_sub_gift': { const n = Number(d.total || 1); return E.make('tw_gift', { user, title: 'Gifted ' + plural(n, 'sub') + ' to the community' + (fromChannel ? ' in ' + fromChannel : ''), amount: { value: n, unit: 'subs', display: n + ' × ' + AD.tierName(d.sub_tier) }, meta: { tier: d.sub_tier, total: n, ...via } }); }
      case 'gift_paid_upgrade': return E.make('tw_sub', { user, title: 'Upgraded their gift sub to a paid sub', meta: via });
      case 'prime_paid_upgrade': return E.make('tw_sub', { user, title: 'Upgraded from Prime to a paid sub (' + AD.tierName(d.sub_tier) + ')', meta: via });
      case 'pay_it_forward': return E.make('tw_gift', { user, title: 'Paid it forward with a gift sub' + (d.recipient_user_name ? ' to ' + d.recipient_user_name : ''), amount: { value: 1, unit: 'subs', display: '1 sub' }, meta: via });
      case 'raid': { const v = Number(d.viewer_count || 0); return E.make('tw_raid', { user: { id: d.user_id, login: d.user_login, name: d.user_name }, title: 'Raiding with ' + plural(v, 'viewer') + (fromChannel ? ' (in ' + fromChannel + ')' : ''), amount: { value: v, unit: 'viewers', display: v + ' viewers' }, meta: via }); }
      case 'unraid': return E.make('tw_notice', { user, title: 'Raid cancelled', meta: via });
      case 'announcement': return E.make('tw_notice', { user, title: 'Announcement', text, fragments, meta: { announcement: true, color: d.color, ...via } });
      case 'bits_badge_tier': return E.make('tw_notice', { user, title: 'Earned the ' + AD.fmtNum(d.tier) + ' bits badge', text, fragments, meta: via });
      case 'charity_donation': { const a = d.amount || {}; const val = Number(a.value || 0) / Math.pow(10, a.decimal_places || 0); return E.make('tw_cheer', { user, title: 'Donated ' + AD.fmtMoney(val * 1e6, a.currency) + ' to ' + (d.charity_name || 'charity'), text, fragments, amount: { value: val, unit: 'currency', display: AD.fmtMoney(val * 1e6, a.currency), currency: a.currency }, meta: { charity: true, ...via } }); }
      case 'watch_streak': return E.make('tw_notice', { user, title: 'Watch streak: ' + plural(Number(d.watch_streak || 0), 'stream'), text, fragments, meta: via });
      case 'modiversary': return E.make('tw_notice', { user, title: 'Modiversary - ' + plural(Number(d.years || 0), 'year') + ' as a mod', meta: via });
      default: return E.make('tw_notice', { user, title: sys || nt, text, fragments, meta: via });
    }
  }

  AD.twitch = {
    SCOPES, state, startDeviceAuth, cancelDeviceAuth, connect, disconnect, logout, helix, getAvatar, missingScopes,
    hasAuth: () => !!auth, authUser: () => auth?.user || state.user, badges, cheermotes,
    /** call once at startup */
    init() {
      if (auth?.user) state.user = auth.user;
      if (auth && S().enabled) connect().catch((e) => AD.log('warn', 'Twitch autoconnect: ' + e.message));
    },
  };
})(window.AD);
