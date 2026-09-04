/* Activity Dock - main UI (feed, settings, tests, relay to overlay) */
(function (AD) {
  'use strict';
  const { h, esc } = AD; const E = AD.events; const S = AD.settings;
  const VERSION = '1.0.0';
  const HIST_KEY = 'ad.history.v1', STATS_KEY = 'ad.stats.v1';
  const q = AD.parseHashParams();
  const DEV = q.dev === '1';
  const IS_HTTP = /^https?:$/.test(location.protocol);

  const history = [];                 // newest last
  const nodes = new Map();            // ev.id -> element
  let stats = AD.store.get(STATS_KEY, { since: Date.now(), follows: 0, subs: 0, gifts: 0, bits: 0, raids: 0, redeems: 0, money: 0, chat: 0 });
  let filter = { search: '' };
  let pendingNew = 0, paused = false, pausedQueue = [];
  let relay, serverBase = null, activeTab = 'twitch';

  /* =====================================================================
     Layout
     ===================================================================== */
  const $app = document.getElementById('app');
  const ICON = {
    gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
    play: '<svg viewBox="0 0 24 24"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>',
    sound: '<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14"/></svg>',
    mute: '<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>',
    close: '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    stats: '<svg viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
  };
  const svgBtn = (name, title, onclick, cls) => h('button.iconbtn' + (cls ? '.' + cls : ''), { title, html: ICON[name], onclick });
  /** Two-click confirmation (native confirm() dialogs are unreliable inside OBS docks). */
  function armed(label, fn, cls) {
    const btn = h('button.btn' + (cls || ''), label);
    btn.onclick = () => {
      if (btn.dataset.armed) { clearTimeout(btn._t); delete btn.dataset.armed; btn.textContent = label; btn.classList.remove('armed'); fn(); return; }
      btn.dataset.armed = '1'; btn.classList.add('armed'); btn.textContent = 'Click again to confirm';
      btn._t = setTimeout(() => { delete btn.dataset.armed; btn.classList.remove('armed'); btn.textContent = label; }, 3000);
    };
    return btn;
  }

  const $twPill = h('span.pill.twitch', { 'data-status': 'disconnected', title: 'Twitch', onclick: () => openSettings('twitch') }, h('span.dot'), h('span.lbl', 'Twitch'));
  const $ytPill = h('span.pill.youtube', { 'data-status': 'disconnected', title: 'YouTube', onclick: () => openSettings('youtube') }, h('span.dot'), h('span.lbl', 'YouTube'));
  const $pauseBtn = svgBtn('pause', 'Pause feed', togglePause);
  const $soundBtn = svgBtn('sound', 'Toggle sounds', () => { S.set('sounds.enabled', !S.get().sounds.enabled); refreshHeader(); AD.sounds.unlock(); });
  const $statsBtn = svgBtn('stats', 'Toggle session stats', () => { S.set('feed.showStats', S.get().feed.showStats === false); refreshStats(); });
  const $header = h('header.top',
    h('div.brand', h('span.logo'), h('span.t', 'Activity')),
    $twPill, $ytPill, $pauseBtn, $soundBtn, $statsBtn,
    svgBtn('trash', 'Clear feed', clearFeed),
    svgBtn('gear', 'Settings', () => openSettings()));

  const $filters = h('div.filters');
  const $health = h('div.health.hidden');
  const $stats = h('div.stats');
  const $feed = h('div.feed');
  const $newBadge = h('button.newbadge', { onclick: () => { jumpToNew(); } });
  const $feedWrap = h('div.feedwrap', $feed, $newBadge);
  const $drawer = h('div.drawer');
  $app.textContent = ''; /* remove the boot placeholder */
  $app.append($header, $filters, $health, $stats, $feedWrap, $drawer);

  /* =====================================================================
     Header / status
     ===================================================================== */
  function refreshHeader() {
    const t = AD.twitch.state, y = AD.youtube.state, s = S.get();
    $twPill.dataset.status = s.twitch.enabled ? t.status : 'disconnected';
    $twPill.title = 'Twitch: ' + (t.user ? t.user.name + ' - ' : '') + t.status + (t.detail ? ' - ' + t.detail : '');
    $ytPill.dataset.status = s.youtube.enabled ? y.status : 'disconnected';
    $ytPill.title = 'YouTube: ' + y.status + (y.detail ? ' - ' + y.detail : '');
    $ytPill.style.display = s.youtube.enabled || y.status !== 'disconnected' ? '' : 'none';
    $soundBtn.innerHTML = s.sounds.enabled ? ICON.sound : ICON.mute; $soundBtn.classList.toggle('active', s.sounds.enabled);
    $pauseBtn.innerHTML = paused ? ICON.play : ICON.pause; $pauseBtn.classList.toggle('active', paused);
    $pauseBtn.title = paused ? 'Resume feed (' + pausedQueue.length + ' queued)' : 'Pause feed';
    $statsBtn.classList.toggle('active', s.feed.showStats !== false);
  }
  AD.bus.on('twitch:status', () => { refreshHeader(); refreshHealth(); if ($drawer.classList.contains('open') && activeTab === 'twitch') renderTab(); });
  AD.bus.on('youtube:status', () => { refreshHeader(); refreshHealth(); if ($drawer.classList.contains('open') && activeTab === 'youtube') renderTab(); });
  AD.bus.on('twitch:auth', refreshHealth); AD.bus.on('youtube:auth', refreshHealth); AD.bus.on('settings', refreshHealth);
  /** One-line explanation of why nothing may be arriving (shown between the filters and the feed). */
  function refreshHealth() {
    const s = S.get(); const t = AD.twitch.state, y = AD.youtube.state; const lines = [];
    const SCOPE_WHAT = { 'moderator:read:followers': 'follows', 'channel:read:subscriptions': 'subs', 'bits:read': 'bits', 'channel:read:redemptions': 'redeems', 'user:read:chat': 'chat', 'channel:read:hype_train': 'hype train', 'channel:read:ads': 'ad breaks', 'moderator:read:shoutouts': 'shoutouts', 'channel:read:charity': 'charity' };
    if (s.twitch.enabled) {
      const missing = AD.twitch.hasAuth() ? AD.twitch.missingScopes() : [];
      if (!AD.twitch.hasAuth()) lines.push(t.status === 'error' ? ['err', 'Twitch login expired (' + (t.detail || 'error') + ') - click to sign in again', 'twitch'] : ['warn', 'Twitch is not connected in this ' + (navigator.userAgent.includes('OBS') ? 'OBS dock' : 'browser') + ' - click to connect', 'twitch']);
      else if (missing.length) lines.push(['warn', 'Twitch login is missing permissions for ' + missing.map((m) => SCOPE_WHAT[m] || m).join(', ') + ' - click, then "Sign out and reconnect"', 'twitch']);
      else if (t.status === 'error') lines.push(['err', 'Twitch: ' + (t.detail || 'error'), 'twitch']);
      else if (t.status === 'connecting' || t.status === 'auth') lines.push(['warn', 'Twitch: ' + (t.detail || 'connecting…'), 'twitch']);
      else if (t.status === 'disconnected') lines.push(['warn', 'Twitch is disconnected - click to connect', 'twitch']);
      else if (t.status === 'connected') {
        const bad = Object.entries(t.subs).filter(([, v]) => v !== 'enabled' && !/Affiliate/.test(v));
        const core = bad.filter(([k]) => /^channel\.(follow|subscribe|subscription\.gift|cheer|raid|channel_points_custom)/.test(k));
        if (core.length) lines.push(['warn', 'Twitch connected, but not receiving ' + core.map(([k]) => k.replace(/^channel\./, '').replace(/_/g, ' ').replace('channel points custom reward redemption.add', 'redeems').replace('subscription.gift', 'gift subs')).join(', ') + ' - open the Twitch tab for the reason', 'twitch']);
      }
    }
    if (s.youtube.enabled) {
      if (y.status === 'error') lines.push(['err', 'YouTube: ' + (y.detail || 'error'), 'youtube']);
      else if (y.status === 'idle') lines.push(['info', 'YouTube: ' + (y.detail || 'no live stream right now'), 'youtube']);
      else if (y.status === 'connecting') lines.push(['warn', 'YouTube: ' + (y.detail || 'connecting…'), 'youtube']);
    }
    $health.replaceChildren(...lines.map(([lvl, text, tab]) => h('div.hl.' + lvl, { onclick: () => openSettings(tab) }, h('span.dot'), text)));
    $health.classList.toggle('hidden', !lines.length);
  }
  AD.bus.on('twitch:auth', () => renderTabIf('twitch')); AD.bus.on('youtube:auth', () => renderTabIf('youtube'));
  function renderTabIf(tab) { if ($drawer.classList.contains('open') && activeTab === tab) renderTab(); }

  /* =====================================================================
     Filters
     ===================================================================== */
  const counts = {};
  function renderFilters() {
    const f = S.get().feed;
    $filters.replaceChildren();
    for (const p of [['all', 'All'], ['twitch', 'Twitch'], ['youtube', 'YouTube']]) {
      $filters.appendChild(h('button.chip.platform' + (f.platform === p[0] ? '.on' : ''), { 'data-p': p[0], onclick: () => { S.set('feed.platform', p[0]); renderFilters(); applyFilters(); } }, p[1]));
    }
    $filters.appendChild(h('span', { style: { width: '4px' } }));
    for (const g of E.GROUPS) {
      const on = f.groups[g.id] !== false;
      $filters.appendChild(h('button.chip' + (on ? '.on' : ''), { title: (on ? 'Hide ' : 'Show ') + g.label + ' (right-click: only this)', onclick: () => { S.set('feed.groups', { ...f.groups, [g.id]: !on }); renderFilters(); applyFilters(); }, oncontextmenu: (e) => { e.preventDefault(); const only = {}; E.GROUPS.forEach((x) => (only[x.id] = x.id === g.id)); const allOnlyThis = E.GROUPS.every((x) => (f.groups[x.id] !== false) === (x.id === g.id)); if (allOnlyThis) E.GROUPS.forEach((x) => (only[x.id] = true)); S.set('feed.groups', only); renderFilters(); applyFilters(); } }, g.label, h('span.n', String(counts[g.id] || 0))));
    }
    const $search = h('input.search', { type: 'search', placeholder: 'Search…', value: filter.search, oninput: (e) => { filter.search = e.target.value.trim().toLowerCase(); applyFilters(); } });
    $filters.appendChild($search);
  }
  function passes(ev) {
    const f = S.get().feed;
    if (f.platform !== 'all' && ev.platform !== f.platform && ev.platform !== 'system') return false;
    if (f.groups[E.groupOf(ev.type)] === false) return false;
    if (!f.showChat && E.isChat(ev)) return false;
    if (filter.search) { const hay = ((ev.user?.name || '') + ' ' + ev.title + ' ' + ev.text + ' ' + (ev.meta?.reward || '')).toLowerCase(); if (!hay.includes(filter.search)) return false; }
    return true;
  }
  function applyFilters() { for (const ev of history) nodes.get(ev.id)?.classList.toggle('hidden', !passes(ev)); updateEmpty(); }
  function updateCounts() { for (const g of E.GROUPS) counts[g.id] = 0; for (const ev of history) counts[E.groupOf(ev.type)]++; $filters.querySelectorAll('.chip:not(.platform)').forEach((c, i) => { const n = c.querySelector('.n'); if (n) n.textContent = String(counts[E.GROUPS[i].id] || 0); }); }

  /* =====================================================================
     Stats
     ===================================================================== */
  function bump(ev) {
    if (ev.test || ev.meta?.backfill) return; // test events and the initial 7-day backfill do not count as session activity
    switch (E.groupOf(ev.type)) {
      case 'follows': stats.follows++; break;
      case 'subs': stats.subs++; break;
      case 'gifts': if (ev.type === 'tw_gift' || ev.type === 'yt_giftmember') stats.gifts += ev.amount?.value || 1; break;
      case 'bits': if (ev.amount?.unit === 'bits') stats.bits += ev.amount.value; else if (ev.amount?.unit === 'currency') stats.money += ev.amount.value; break;
      case 'raids': if (ev.type === 'tw_raid') stats.raids++; break;
      case 'redeems': stats.redeems++; break;
      case 'chat': stats.chat++; break;
    }
    saveStats();
  }
  const saveStats = AD.throttle(() => AD.store.set(STATS_KEY, stats), 1000);
  function refreshStats() {
    const show = S.get().feed.showStats !== false; $stats.classList.toggle('hidden', !show); if (!show) return;
    const items = [['Follows', stats.follows], ['Subs', stats.subs], ['Gifted', stats.gifts], ['Bits', AD.fmtNum(stats.bits)], ['Raids', stats.raids], ['Redeems', stats.redeems]];
    if (stats.money) items.push(['$', stats.money.toFixed(2)]);
    items.push(['Chat', AD.fmtNum(stats.chat)]);
    $stats.replaceChildren(...items.map(([k, v]) => h('span.stat', k, h('b', String(v)))), h('span.stat', { title: 'Counting since ' + new Date(stats.since).toLocaleString() + '. Click to reset.', style: { cursor: 'pointer', marginLeft: 'auto' }, onclick: (e) => { const el = e.currentTarget; if (!el.dataset.armed) { el.dataset.armed = '1'; el.textContent = 'reset?'; setTimeout(() => { if (el.isConnected) { delete el.dataset.armed; el.textContent = '↺ ' + AD.relTime(stats.since); } }, 3000); return; } stats = { since: Date.now(), follows: 0, subs: 0, gifts: 0, bits: 0, raids: 0, redeems: 0, money: 0, chat: 0 }; saveStats(); refreshStats(); } }, '↺ ' + AD.relTime(stats.since)));
  }
  setInterval(() => { if (S.get().feed.showStats !== false) refreshStats(); }, 60_000);

  /* =====================================================================
     Feed rendering
     ===================================================================== */
  function readableColor(c) {
    if (!c || !/^#[0-9a-f]{6}$/i.test(c)) return c || null;
    const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (lum >= 0.35) return c;
    const mix = (x) => Math.round(x + (255 - x) * (0.35 - lum) * 1.6);
    return 'rgb(' + mix(r) + ',' + mix(g) + ',' + mix(b) + ')';
  }
  const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);
  function renderFragments(ev) {
    const out = document.createDocumentFragment();
    if (ev.fragments && ev.fragments.length) {
      for (const f of ev.fragments) {
        const url = safeUrl(f.url);
        if (f.type === 'emote' && url) out.appendChild(h('img.emote', { src: url, alt: f.text, title: f.text, loading: 'lazy' }));
        else if (f.type === 'cheermote') out.appendChild(h('span.cheermote', { style: f.color ? { '--cc': f.color } : null }, url ? h('img', { src: url, alt: '' }) : null, ' ' + (f.bits || f.text) + ' '));
        else if (f.type === 'mention') out.appendChild(h('span.mention', f.text));
        else out.appendChild(document.createTextNode(f.text || ''));
      }
    } else out.appendChild(document.createTextNode(ev.text || ''));
    return out;
  }
  function renderBadges(user) {
    if (!user?.badges?.length || !S.get().feed.avatars) return null;
    return h('span.badges', user.badges.slice(0, 4).map((b) => { const url = safeUrl(b.url); return url ? h('img', { src: url, alt: b.title, title: b.title }) : h('span.tb.' + (b.set || 'x'), { title: b.title }, (b.title || '').slice(0, 3)); }));
  }
  function avatarNode(ev, def) {
    const f = S.get().feed;
    let url = f.avatars ? safeUrl(ev.user?.avatar) : null;
    if (!url && f.avatars && ev.platform === 'twitch' && ev.user?.id) url = safeUrl(AD.twitch.getAvatar(ev.user.id));
    const av = h('span.av', { 'data-uid': ev.platform === 'twitch' ? ev.user?.id || '' : '' }, url ? h('img', { src: url, alt: '', loading: 'lazy' }) : E.iconEl(ev.type));
    if (ev.platform !== 'system') av.appendChild(h('span.pf.' + ev.platform, { title: ev.platform }));
    return av;
  }
  function render(ev) {
    const def = E.typeDef(ev.type); const f = S.get().feed; const chat = E.isChat(ev);
    const el = h('div.ev' + (chat ? '.chat' : '') + (ev.test ? '.test' : ''), { 'data-id': ev.id, style: { '--c': def.color, '--c22': AD.rgba(def.color, .22), '--uc': readableColor(ev.user?.color) } });
    if (chat && ev.meta?.highlighted) el.classList.add('highlight');
    if (chat && ev.meta?.first) el.classList.add('first');
    el.appendChild(avatarNode(ev, def));
    const body = h('div.body');
    if (chat) {
      const head = h('span.head'); const badges = renderBadges(ev.user); if (badges) head.appendChild(badges);
      head.appendChild(h('span.name', ev.user?.name || '?'));
      if (ev.meta?.shared_from) head.appendChild(h('span.shared', { title: 'Shared chat' }, ev.meta.shared_from));
      if (ev.amount) head.appendChild(h('span.amt', ev.amount.display));
      body.appendChild(head);
      if (ev.meta?.reply) body.appendChild(h('span.reply', '↪ @' + ev.meta.reply.to + ': ' + (ev.meta.reply.text || '').slice(0, 80)));
      body.appendChild(h('span.msg', renderFragments(ev)));
    } else {
      const head = h('div.head', h('span.kind', def.label));
      if (ev.user?.name) { const badges = renderBadges(ev.user); if (badges) head.appendChild(badges); head.appendChild(h('span.name', ev.user.name)); }
      if (ev.amount?.display) head.appendChild(h('span.amt', ev.amount.display));
      body.appendChild(head);
      if (ev.title) body.appendChild(h('div.title', ev.title));
      if (ev.text || ev.fragments?.length) body.appendChild(h('div.msg', renderFragments(ev)));
      if (ev.meta?.shared_from) body.appendChild(h('div.ctx', 'via shared chat: ' + ev.meta.shared_from));
    }
    el.appendChild(body);
    el.appendChild(h('span.time', { title: new Date(ev.ts).toLocaleString() + (ev.meta?.source === 'catchup' ? ' - found by catch-up (happened while the dock was closed or missed live)' : '') }, f.timestamps ? AD.fmtWhen(ev.ts) : ''));
    if (ev.meta?.source === 'catchup') el.classList.add('catchup');
    el.addEventListener('click', (e) => {
      if (e.target.closest('a,img') || window.getSelection()?.toString()) return;
      if (!body.querySelector('.more')) body.appendChild(h('pre.more', JSON.stringify({ ...ev, fragments: ev.fragments ? ev.fragments.length + ' fragment(s)' : undefined }, null, 1)));
      el.classList.toggle('open');
    });
    return el;
  }
  function insertNode(ev, el) {
    const f = S.get().feed; const atTop = f.newestTop;
    const wasAtEdge = atTop ? $feed.scrollTop <= 4 : ($feed.scrollHeight - $feed.scrollTop - $feed.clientHeight) <= 40;
    // history / catch-up items carry their real timestamp -> slot them in chronologically instead of on top
    const newest = history.length > 1 ? history[history.length - 2] : null; // history already contains ev (pushed by onEvent)
    if (ev.meta?.history && newest && ev.ts < newest.ts - 1000) {
      // find the first item that is older than ev
      let idx = history.length - 1; while (idx > 0 && history[idx - 1].ts > ev.ts) idx--;
      history.splice(history.length - 1, 1); history.splice(idx, 0, ev);
      const olderNeighbour = idx > 0 ? nodes.get(history[idx - 1].id) : null, newerNeighbour = idx + 1 < history.length ? nodes.get(history[idx + 1].id) : null;
      if (atTop) { if (newerNeighbour) newerNeighbour.after(el); else if (olderNeighbour) olderNeighbour.before(el); else $feed.prepend(el); }
      else { if (olderNeighbour) olderNeighbour.after(el); else if (newerNeighbour) newerNeighbour.before(el); else $feed.appendChild(el); }
      nodes.set(ev.id, el); if (!passes(ev)) el.classList.add('hidden');
      return;
    }
    if (atTop) $feed.prepend(el); else $feed.appendChild(el);
    nodes.set(ev.id, el);
    if (!passes(ev)) el.classList.add('hidden');
    else if (wasAtEdge) { if (!atTop) $feed.scrollTop = $feed.scrollHeight; }
    else { pendingNew++; showNewBadge(); }
  }
  function showNewBadge() { const atTop = S.get().feed.newestTop; $newBadge.textContent = (atTop ? '↑ ' : '↓ ') + pendingNew + ' new'; $newBadge.classList.toggle('top', atTop); $newBadge.classList.add('show'); }
  function jumpToNew() { const atTop = S.get().feed.newestTop; $feed.scrollTo({ top: atTop ? 0 : $feed.scrollHeight, behavior: 'smooth' }); pendingNew = 0; $newBadge.classList.remove('show'); }
  $feed.addEventListener('scroll', () => { const atTop = S.get().feed.newestTop; const edge = atTop ? $feed.scrollTop <= 4 : ($feed.scrollHeight - $feed.scrollTop - $feed.clientHeight) <= 40; if (edge) { pendingNew = 0; $newBadge.classList.remove('show'); } }, { passive: true });
  function trim() {
    const max = Math.max(50, Number(S.get().feed.maxItems) || 400);
    while (history.length > max) { const old = history.shift(); nodes.get(old.id)?.remove(); nodes.delete(old.id); }
  }
  function updateEmpty() {
    let empty = $feed.querySelector('.empty');
    const visible = history.some((ev) => !nodes.get(ev.id)?.classList.contains('hidden'));
    if (visible) { empty?.remove(); return; }
    if (!empty) {
      const s = S.get();
      const msg = !AD.twitch.hasAuth() && !s.youtube.enabled ? [h('b', 'Welcome!'), h('br'), 'Open ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openSettings('twitch'); } }, 'Settings'), ' to connect Twitch and/or YouTube.', h('br'), 'Use the ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openSettings('test'); } }, 'Test'), ' tab to fire sample events.'] : history.length ? ['Nothing matches the current filters.'] : ['Waiting for activity…'];
      empty = h('div.empty', msg); $feed.appendChild(empty);
    }
  }
  function rerenderAll() {
    $feed.replaceChildren(); nodes.clear();
    const f = S.get().feed;
    history.sort((a, b) => a.ts - b.ts);
    for (const ev of history) { const el = render(ev); if (f.newestTop) $feed.prepend(el); else $feed.appendChild(el); nodes.set(ev.id, el); if (!passes(ev)) el.classList.add('hidden'); }
    document.documentElement.style.setProperty('--font-scale', String(f.fontScale || 1));
    document.body.classList.toggle('no-anim', !!f.noAnim);
    updateEmpty(); updateCounts();
    if (!f.newestTop) $feed.scrollTop = $feed.scrollHeight;
  }
  let clearArmed = null;
  function clearFeed() {
    if (history.length && !clearArmed) { AD.toast('Click the bin again to clear the feed'); clearArmed = setTimeout(() => (clearArmed = null), 3000); return; }
    clearTimeout(clearArmed); clearArmed = null;
    history.length = 0; nodes.clear(); $feed.replaceChildren(); pendingNew = 0; $newBadge.classList.remove('show'); persistHistory(); updateCounts(); updateEmpty();
  }
  AD.bus.on('avatars', (found) => { if (!S.get().feed.avatars) return; for (const [uid, url] of Object.entries(found)) { const u = safeUrl(url); if (!u) continue; $feed.querySelectorAll('.av[data-uid="' + uid + '"]').forEach((av) => { if (!av.querySelector('img')) { av.firstChild && av.firstChild.nodeType === 3 && av.firstChild.remove(); av.prepend(h('img', { src: u, alt: '' })); } }); } });
  AD.bus.on('event:delete', (id) => { nodes.get(id)?.classList.add('deleted'); const ev = history.find((x) => x.id === id); if (ev) ev.meta.deleted = true; });

  /* =====================================================================
     Event intake
     ===================================================================== */
  const persistHistory = AD.throttle(() => { /* last 250 events, restored on reload */ const keep = history.slice(-250).map((ev) => ({ ...ev, fragments: ev.fragments ? ev.fragments.slice(0, 40) : null })); AD.store.set(HIST_KEY, keep); }, 2000);
  window.addEventListener('pagehide', () => { persistHistory.flush(); saveStats.flush(); });
  const queuedIds = new Set();
  function onEvent(ev) {
    if (nodes.has(ev.id) || queuedIds.has(ev.id)) return; // dedupe (e.g. same chat message from two subscriptions)
    const live = !ev.meta?.history;
    if (paused && !ev.test) { pausedQueue.push(ev); queuedIds.add(ev.id); if (live) { maybeSound(ev); maybeAlert(ev); } refreshHeader(); return; }
    history.push(ev); trim();
    insertNode(ev, render(ev));
    counts[E.groupOf(ev.type)] = (counts[E.groupOf(ev.type)] || 0) + 1; updateCounts(); updateEmpty();
    bump(ev); refreshStats(); persistHistory();
    if (live) { maybeSound(ev); maybeAlert(ev); }
  }
  AD.bus.on('event', onEvent);
  function togglePause() { paused = !paused; if (!paused) { const qd = pausedQueue.splice(0); queuedIds.clear(); qd.forEach((ev) => onEvent({ ...ev, meta: { ...ev.meta, history: true } })); } refreshHeader(); }

  function maybeSound(ev) {
    const s = S.get().sounds; if (!s.enabled) return;
    const def = E.typeDef(ev.type);
    if (E.isChat(ev)) { if (s.chatPing) AD.sounds.play('chat'); return; }
    if (!def.sound) return;
    if (!ev.test && !passesThreshold(ev)) return;
    AD.sounds.play(def.sound);
  }
  function passesThreshold(ev) {
    const a = S.get().alerts;
    if (ev.amount?.unit === 'bits' && ev.amount.value < (Number(a.minBits) || 0)) return false;
    if (ev.amount?.unit === 'currency' && ev.amount.value < (Number(a.minAmount) || 0)) return false;
    return true;
  }
  function maybeAlert(ev) {
    const a = S.get().alerts; if (!a.enabled) return;
    if (!a.groups[E.groupOf(ev.type)]) return;
    if (!passesThreshold(ev)) return;
    relay.send({ kind: 'alert', ev: { ...ev, fragments: ev.fragments ? ev.fragments.slice(0, 60) : null }, cfg: alertCfgFor(ev) });
  }

  /* =====================================================================
     Settings drawer
     ===================================================================== */
  const TABS = [['twitch', 'Twitch'], ['youtube', 'YouTube'], ['feed', 'Feed'], ['sounds', 'Sounds'], ['alerts', 'Overlay'], ['obs', 'OBS'], ['test', 'Test'], ['debug', 'About']];
  function openSettings(tab) { if (tab) activeTab = tab; $drawer.classList.add('open'); renderDrawer(); }
  function closeSettings() { $drawer.classList.remove('open'); }
  function renderDrawer() {
    $drawer.replaceChildren(
      h('div.dhead', h('h2', 'Settings'), h('span.hint', 'v' + VERSION), svgBtn('close', 'Close', closeSettings)),
      h('div.tabs', TABS.map(([id, label]) => h('button' + (activeTab === id ? '.on' : ''), { onclick: () => { activeTab = id; renderDrawer(); } }, label, tabWarn(id)))),
      h('div.panel#panel'));
    renderTab();
  }
  function tabWarn(id) {
    const s = S.get();
    if (id === 'twitch' && s.twitch.enabled && AD.twitch.state.status === 'error') return h('span.warn', '!');
    if (id === 'youtube' && s.youtube.enabled && AD.youtube.state.status === 'error') return h('span.warn', '!');
    if (id === 'obs' && s.obs.enabled && relay?.obs?.status === 'error') return h('span.warn', '!');
    return null;
  }
  function renderTab() {
    const panel = document.getElementById('panel'); if (!panel) return;
    const scroll = panel.scrollTop;
    panel.replaceChildren();
    AD.append(panel, [({ twitch: tabTwitch, youtube: tabYouTube, feed: tabFeed, sounds: tabSounds, alerts: tabAlerts, obs: tabObs, test: tabTest, debug: tabDebug })[activeTab]()]);
    panel.scrollTop = scroll;
  }
  /* --- small form helpers bound to settings paths --- */
  function field(label, path, opts = {}) {
    const val = path.split('.').reduce((o, k) => o?.[k], S.get());
    const input = opts.type === 'select'
      ? h('select', { onchange: (e) => S.set(path, e.target.value) }, opts.options.map(([v, l]) => h('option', { value: v, selected: String(val) === String(v) }, l)))
      : h('input', { type: opts.type || 'text', value: val ?? '', placeholder: opts.placeholder || '', autocomplete: 'off', spellcheck: false, min: opts.min, max: opts.max, step: opts.step, onchange: (e) => S.set(path, opts.type === 'number' ? Number(e.target.value) : e.target.value), oninput: opts.live ? (e) => S.set(path, e.target.value, true) : null });
    const wrap = h('div.field', h('label', label), opts.button ? h('div.row', input, opts.button) : input, opts.hint ? h('span.hint', opts.hint) : null);
    return wrap;
  }
  function check(label, path, hint, onchange) {
    const val = path.split('.').reduce((o, k) => o?.[k], S.get());
    return h('label.check', h('input', { type: 'checkbox', checked: !!val, onchange: (e) => { S.set(path, e.target.checked); onchange?.(e.target.checked); } }), h('span', label, hint ? [' ', h('small', hint)] : null));
  }
  function statusCard(st, extra) {
    return h('div.card' + (st.status === 'connected' ? '.ok' : st.status === 'error' ? '.err' : st.status === 'auth' || st.status === 'idle' ? '.warn' : ''), h('div.status-line', { 'data-status': st.status }, h('span.dot'), h('b', st.status), h('span.hint', st.detail || '')), extra || null);
  }
  function deviceCard(da, platform) {
    const link = da.verification_uri;
    return h('div.card.warn',
      h('p', h('b', 'Step 1: '), 'Open this page in your normal web browser (not inside OBS):'),
      h('div.urlbox', h('input', { type: 'text', readOnly: true, value: link, onclick: (e) => e.target.select() }), h('button.btn.sm', { onclick: async () => { (await AD.copyText(link)) ? AD.toast('Link copied') : AD.toast('Copy failed - select the text manually'); } }, 'Copy'), h('a.btn.sm', { href: link, target: '_blank', rel: 'noopener' }, 'Open')),
      h('p', h('b', 'Step 2: '), 'If asked for a code, enter:'),
      h('div.big', da.user_code),
      h('p.hint', 'Then approve the permissions. This dock will connect automatically. Code expires ' + new Date(da.expires_at).toLocaleTimeString() + '.'),
      h('button.btn.sm', { onclick: () => { (platform === 'twitch' ? AD.twitch : AD.youtube).cancelDeviceAuth(); (platform === 'twitch' ? AD.twitch : AD.youtube).state.status = 'disconnected'; renderTab(); } }, 'Cancel'));
  }

  /* ---------------- Twitch tab ---------------- */
  function tabTwitch() {
    const st = AD.twitch.state; const s = S.get().twitch; const out = [];
    out.push(check('Enable Twitch', 'twitch.enabled', null, (on) => { on ? AD.twitch.connect().catch(() => { }) : AD.twitch.disconnect(); refreshHeader(); }));
    if (!AD.twitch.hasAuth()) {
      out.push(h('h3', '1. Create a (free) Twitch application'),
        h('ol',
          h('li', 'Go to ', h('a', { href: 'https://dev.twitch.tv/console/apps/create', target: '_blank', rel: 'noopener' }, 'dev.twitch.tv/console/apps/create'), ' (log in with your Twitch account; two-factor auth must be enabled on the account).'),
          h('li', h('b', 'Name:'), ' anything, e.g. "My Activity Dock"'),
          h('li', h('b', 'OAuth Redirect URLs:'), ' ', h('code', 'http://localhost'), ' (required by the form, not used)'),
          h('li', h('b', 'Category:'), ' Broadcaster Suite'),
          h('li', h('b', 'Client Type:'), ' ', h('b', 'Public'), ' (important)'),
          h('li', 'Click Create, then Manage, and copy the ', h('b', 'Client ID'), ' below. No secret is needed.')),
        h('h3', '2. Connect'),
        field('Client ID', 'twitch.clientId', { placeholder: 'e.g. abcdefghijklmnopqrstuvwxyz0123' }));
      if (st.deviceAuth) out.push(deviceCard(st.deviceAuth, 'twitch'));
      else out.push(h('div.btnrow', h('button.btn.twitch', { onclick: async () => { try { await AD.twitch.startDeviceAuth(); renderTab(); } catch (e) { AD.toast(e.message, 5000); } } }, 'Connect with Twitch')), st.status === 'error' ? statusCard(st) : null);
      out.push(h('p.hint', 'Connecting asks for read-only permissions: followers, subs, bits, channel points, chat, hype train, ads, shoutouts, charity. Tokens are stored only in this browser (localStorage) and refreshed automatically.'));
    } else {
      const u = AD.twitch.authUser();
      out.push(statusCard(st, h('div.userchip', { style: { marginTop: '8px' } }, u?.avatar ? h('img', { src: u.avatar, alt: '' }) : null, h('div', h('b', u?.name || u?.login || '…'), h('div.hint', 'User ID ' + (u?.id || '?'))))));
      const missing = AD.twitch.missingScopes();
      if (missing.length) out.push(h('div.card.warn', h('b', 'Re-connect recommended: '), 'this login is missing permissions: ', h('code', missing.join(' ')), h('div.btnrow', h('button.btn.sm', { onclick: async () => { await AD.twitch.logout(); renderTab(); } }, 'Sign out and reconnect'))));
      out.push(h('div.btnrow',
        st.status === 'connected' || st.status === 'connecting' ? h('button.btn', { onclick: () => { AD.twitch.disconnect(); renderTab(); } }, 'Disconnect') : h('button.btn.primary', { onclick: () => { AD.twitch.connect().catch((e) => AD.toast(e.message)); } }, 'Connect'),
        h('button.btn', { onclick: () => { AD.twitch.disconnect(); AD.twitch.connect().catch((e) => AD.toast(e.message)); } }, 'Reconnect'),
        armed('Sign out', async () => { await AD.twitch.logout(); renderTab(); }, '.danger')));
      if (!navigator.userAgent.includes('OBS')) out.push(h('p.hint', 'Connected here in a normal browser? The OBS dock has its own storage - use ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openSettings('debug'); } }, 'About → Copy setup link for OBS'), ' to move this login into OBS.'));
      const subs = Object.entries(st.subs);
      if (subs.length) out.push(h('h3', 'EventSub subscriptions'), h('div.sublist', subs.map(([t, v]) => h('div.' + (v === 'enabled' ? 'ok' : 'bad'), { title: t + ': ' + v }, t.replace(/^channel\./, '').replace(/_/g, ' ') + (v === 'enabled' ? '' : ' - ' + v.replace(/^failed: /, ''))))),
        subs.some(([, v]) => /Affiliate/.test(v)) ? h('p.hint', 'Subs, bits, channel points and hype train events require Twitch Affiliate/Partner status - they will fail for non-affiliated channels, which is expected.') : null);
      out.push(h('h3', 'Activity while the dock is closed'),
        h('p.hint', 'Twitch only pushes events while the dock is open. On every connect the dock therefore asks Twitch what happened in the meantime (new follows, subs & gift subs, bits, pending channel-point redeems) and adds it to the feed with the real time. The same check repeats every 5 minutes as a safety net.'),
        check('Catch up on connect', 'twitch.catchUp'),
        check('Re-check every 5 minutes while connected', 'twitch.poll'),
        h('div.btnrow', h('button.btn.sm', { onclick: async (e) => { const b = e.currentTarget; b.disabled = true; b.textContent = 'Checking…'; try { const r = await AD.twitch.catchUp('manual'); AD.toast(r ? ('Found ' + r.follows + ' follows, ' + r.subs + ' subs, ' + AD.fmtNum(r.bits) + ' bits, ' + r.redeems + ' pending redeems') : 'Not connected'); } catch (err) { AD.toast(err.message); } b.disabled = false; b.textContent = 'Check now'; } }, 'Check now'),
          h('span.hint', st.lastCatchUp ? 'Last check ' + AD.fmtTime(st.lastCatchUp, true) + (st.subCount != null ? ' - ' + st.subCount + ' current subscribers' : '') : '')));
      out.push(h('h3', 'What to track'),
        check('Chat messages', 'twitch.chat', '(uncheck to save CPU on very busy chats)', restartTwitch),
        check('Chat notices', 'twitch.notices', '(announcements, watch streaks, shared chat events)', restartTwitch),
        check('Hype Train', 'twitch.hype', null, restartTwitch),
        check('Ad breaks', 'twitch.ads', null, restartTwitch),
        check('Stream online / offline', 'twitch.streamStatus', null, restartTwitch));
    }
    if (DEV) out.push(h('details.adv', h('summary', 'Developer'), field('EventSub WebSocket URL', 'twitch.wsUrl', { placeholder: 'wss://eventsub.wss.twitch.tv/ws (or ws://127.0.0.1:8080/ws for twitch-cli mock)' }), field('Helix base URL', 'twitch.helixUrl', { placeholder: 'https://api.twitch.tv/helix (or http://127.0.0.1:8080/eventsub for mock)' }), check('Skip token validation (mock server)', 'twitch.skipValidate')));
    return out;
  }
  const restartTwitch = AD.debounce(() => { if (AD.twitch.state.status === 'connected' || AD.twitch.state.status === 'connecting') { AD.twitch.disconnect(); AD.twitch.connect().catch(() => { }); } }, 800);

  /* ---------------- YouTube tab ---------------- */
  function tabYouTube() {
    const st = AD.youtube.state; const s = S.get().youtube; const out = [];
    out.push(check('Enable YouTube', 'youtube.enabled', null, (on) => { on ? AD.youtube.start().catch(() => { }) : AD.youtube.stop(); refreshHeader(); }));
    out.push(statusCard(st, h('div.kv', { style: { marginTop: '6px' } },
      h('span', 'Mode'), h('b', st.mode === 'helper' ? 'Helper (unofficial feed)' : st.mode === 'official' ? 'Official API (' + (st.method || '…') + ')' : '-'),
      h('span', 'Stream'), h('b', st.title || st.videoId || '-'),
      h('span', 'Helper'), h('b', st.helperOk ? 'running' + (st.helperVersion ? ' v' + st.helperVersion : '') : 'not detected'),
      h('span', 'API quota today'), h('b', (st.quota.units || 0) + ' / 10,000 units (estimate)'))));
    out.push(h('div.btnrow', h('button.btn.primary', { onclick: () => AD.youtube.start().catch((e) => AD.toast(e.message)) }, s.enabled ? 'Restart' : 'Start'), h('button.btn', { onclick: () => { AD.youtube.stop(); renderTab(); } }, 'Stop'), h('button.btn', { onclick: async () => { await AD.youtube.probeHelper(); renderTab(); } }, 'Re-check helper')));

    out.push(h('h3', 'Your stream'),
      field('Live stream URL or video ID', 'youtube.videoId', { placeholder: 'https://www.youtube.com/watch?v=XXXXXXXXXXX', hint: 'Cheapest & most reliable: paste the URL of the current live stream. Leave empty to auto-detect from your channel.', button: h('button.btn.sm', { onclick: () => { S.set('youtube.videoId', ''); renderTab(); } }, 'Clear') }),
      field('Channel (@handle, URL or channel ID)', 'youtube.channel', { placeholder: '@YourHandle', hint: 'Used to find the live stream automatically. With the helper this is free. With an API key only, auto-detect costs ~100 quota units per check.' }),
      field('Source', 'youtube.source', { type: 'select', options: [['auto', 'Auto (video URL if set, else channel / Google account)'], ['video', 'Always use the video URL'], ['channel', 'Always search the channel']] }));

    out.push(h('h3', 'Data source'),
      field('Mode', 'youtube.mode', { type: 'select', options: [['auto', 'Auto (official API if configured, else helper)'], ['official', 'Official YouTube Data API only'], ['unofficial', 'Helper only (no Google setup, no quota)']] }));

    out.push(h('h3', 'Option A - Helper (no Google account setup)'),
      h('p', 'Run ', h('code', 'start-dock.bat'), ' (Windows) or ', h('code', 'node server.js'), ' from the project folder. It reads the public live chat the same way a browser does and streams it to this dock - no Google account, no API key, no quota. Works with just your channel handle. Sees chat, Super Chats, Super Stickers, new members, milestones and gifted memberships (not new subscribers - YouTube does not show those in chat).'),
      field('Helper URL', 'youtube.helperUrl', { placeholder: 'http://127.0.0.1:8520' }),
      st.helperOk ? h('div.card.ok', 'Helper detected ✓') : h('div.card', 'Helper not detected. Start it with ', h('code', 'start-dock.bat'), ' / ', h('code', 'node server.js'), ' (needs ', h('a', { href: 'https://nodejs.org', target: '_blank', rel: 'noopener' }, 'Node.js'), ' installed). The dock re-checks every 30 seconds.'));

    out.push(h('h3', 'Option B - Official API'),
      h('p.hint', 'Requires a Google Cloud project with the YouTube Data API v3 enabled (free). Daily quota is 10,000 units - chat costs about 5 units per request, so roughly 6-8 hours of streaming per day. The dock auto-switches to the helper when the quota runs out (if the helper is running). See README for the step-by-step setup.'),
      field('API key (public data only)', 'youtube.apiKey', { type: 'password', placeholder: 'AIza…', hint: 'Google Cloud Console → Credentials → Create credentials → API key. With only a key you must paste the live stream URL above (or enable channel search).' }),
      h('p', h('b', 'or sign in with Google'), ' (finds your live stream automatically, also tracks new channel subscribers):'),
      field('OAuth Client ID', 'youtube.clientId', { placeholder: '….apps.googleusercontent.com', hint: 'Credentials → Create credentials → OAuth client ID → Application type: "TVs and Limited Input devices".' }),
      field('OAuth Client Secret', 'youtube.clientSecret', { type: 'password', placeholder: 'GOCSPX-…' }));
    if (AD.youtube.hasAuth()) out.push(h('div.card.ok', 'Signed in with Google ✓ ', st.user ? '(' + st.user.title + ')' : '', h('div.btnrow', h('button.btn.sm.danger', { onclick: async () => { await AD.youtube.logout(); renderTab(); } }, 'Sign out'))));
    else if (st.deviceAuth) out.push(deviceCard(st.deviceAuth, 'youtube'));
    else out.push(h('div.btnrow', h('button.btn.youtube', { onclick: async () => { try { await AD.youtube.startDeviceAuth(); renderTab(); } catch (e) { AD.toast(e.message, 6000); } } }, 'Sign in with Google')));
    out.push(h('p.hint', 'While your Google app is in "Testing" mode, add your own Google account as a test user (OAuth consent screen → Audience → Test users), and note that the sign-in expires after 7 days - just sign in again.'));

    out.push(h('h3', 'What to track'),
      check('Chat messages', 'youtube.chat', null, restartYouTube),
      check('New channel subscribers', 'youtube.subscribers', '(official API with Google sign-in only; only public subscriptions are visible; checked every 2 min - also while you are offline)', restartYouTube),
      check('Load recent history on connect', 'youtube.history', '(Google sign-in only: last 50 public subscribers and the Super Chats of the last 30 days)', restartYouTube),
      check('Use streaming connection when available', 'youtube.useStream', '(fewer requests; falls back to polling automatically)', restartYouTube),
      field('Minimum poll interval (seconds, polling mode)', 'youtube.pollMin', { type: 'number', min: 0, max: 120, step: 1, hint: '0 = follow YouTube\'s suggested interval. Increase (e.g. 15-30) to stretch the daily quota.' }));
    return out;
  }
  const restartYouTube = AD.debounce(() => { if (S.get().youtube.enabled) AD.youtube.start().catch(() => { }); }, 800);

  /* ---------------- Feed tab ---------------- */
  function tabFeed() {
    const re = () => { rerenderAll(); renderFilters(); };
    return [
      h('h3', 'Layout'),
      check('Newest at the top', 'feed.newestTop', null, re),
      check('Show chat messages in the feed', 'feed.showChat', '(the Chat filter chip also toggles this per session)', re),
      check('Show timestamps', 'feed.timestamps', null, re),
      check('Show avatars & badges', 'feed.avatars', null, re),
      check('Show session stats bar', 'feed.showStats', null, refreshStats),
      check('Disable animations', 'feed.noAnim', null, re),
      h('div.field', h('label', 'Font size'), h('div.range', h('input', { type: 'range', min: 0.8, max: 1.6, step: 0.05, value: S.get().feed.fontScale || 1, oninput: (e) => { S.set('feed.fontScale', Number(e.target.value), true); document.documentElement.style.setProperty('--font-scale', e.target.value); e.target.nextSibling.value = Math.round(e.target.value * 100) + '%'; } }), h('output', Math.round((S.get().feed.fontScale || 1) * 100) + '%'))),
      field('Maximum items kept in the feed', 'feed.maxItems', { type: 'number', min: 50, max: 5000, step: 50, hint: 'Older items are dropped. The last 250 are restored when the dock reloads.' }),
      h('h3', 'Tips'),
      h('ul', h('li', 'Click an item to see its raw data.'), h('li', 'Right-click a filter chip to show only that type; right-click again to show all.'), h('li', 'Use the search box to find a user or message.'), h('li', 'Pause (⏸) holds new items while you read; they are added when you resume.')),
    ];
  }

  /* ---------------- Sounds tab ---------------- */
  function tabSounds() {
    const s = S.get().sounds; const out = [];
    out.push(check('Enable sounds in the dock', 'sounds.enabled', '(the overlay has its own copy of the sounds)', refreshHeader),
      h('div.field', h('label', 'Volume'), h('div.range', h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: s.volume, oninput: (e) => { S.set('sounds.volume', Number(e.target.value)); e.target.nextSibling.value = Math.round(e.target.value * 100) + '%'; }, onchange: () => AD.sounds.play('follow', { force: true }) }), h('output', Math.round(s.volume * 100) + '%'))),
      check('Soft tick for every chat message', 'sounds.chatPing'),
      !AD.sounds.isUnlocked() ? h('p.hint', 'Browsers block audio until you click somewhere on the page once. In OBS docks audio plays automatically.') : null,
      h('h3', 'Per category'),
      h('p.hint', 'Built-in sounds are generated (no files needed). Upload your own MP3/OGG/WAV (max ~1 MB, stored in this browser) to replace any of them.'));
    const labels = { follow: 'Follows / new subscribers', sub: 'Subs, resubs, members', gift: 'Gift subs / memberships', cheer: 'Bits', raid: 'Raids & Hype Train', redeem: 'Channel point redeems', superchat: 'Super Chat / Super Sticker', chat: 'Chat tick' };
    for (const cat of AD.sounds.categories) {
      const file = h('input', { type: 'file', accept: 'audio/*', style: { display: 'none' }, onchange: (e) => { const f = e.target.files[0]; if (!f) return; if (f.size > 1.2 * 1024 * 1024) return AD.toast('File too big (max ~1 MB)'); const r = new FileReader(); r.onload = () => { AD.sounds.setCustom(cat, r.result); renderTab(); AD.sounds.play(cat, { force: true }); }; r.readAsDataURL(f); } });
      out.push(h('div.soundrow', h('span', labels[cat] || cat, s.custom?.[cat] ? h('div.cust', 'custom sound') : null),
        h('button.btn.sm', { onclick: () => AD.sounds.play(cat, { force: true }) }, '▶ Preview'),
        h('label.check', { style: { margin: 0 } }, h('input', { type: 'checkbox', checked: !s.muted?.[cat], onchange: (e) => S.set('sounds.muted', { ...(S.get().sounds.muted || {}), [cat]: !e.target.checked }) }), h('span', 'on')),
        s.custom?.[cat] ? h('button.btn.sm', { onclick: () => { AD.sounds.setCustom(cat, null); renderTab(); } }, 'Reset') : h('button.btn.sm', { onclick: () => file.click() }, 'Upload'), file));
    }
    return out;
  }

  /* ---------------- Overlay / alerts tab ---------------- */
  function overlayUrls() {
    const s = S.get(); const base = location.href.replace(/[#?].*$/, '').replace(/index\.html$/, '').replace(/\/$/, '') + '/overlay.html';
    const params = new URLSearchParams();
    if (s.obs.enabled && s.obs.url) { params.set('obs', s.obs.url); if (s.obs.password) params.set('pw', s.obs.password); }
    const urls = [];
    if (serverBase) urls.push({ label: 'Local server (recommended - no OBS WebSocket needed)', url: serverBase + '/overlay.html' });
    if (!serverBase || serverBase !== location.origin) urls.push({ label: serverBase ? 'Alternative: this copy of the overlay via OBS WebSocket' : 'Overlay URL (needs OBS WebSocket - see the OBS tab)', url: base + (params.toString() ? '?' + params : '') });
    return urls;
  }
  function tabAlerts() {
    const a = S.get().alerts; const out = [];
    out.push(h('p', 'The overlay is a separate page you add as a ', h('b', 'Browser Source'), ' in your scene. The dock sends alerts to it in real time.'),
      check('Send alerts to the overlay', 'alerts.enabled'),
      h('h3', 'Overlay URL'));
    for (const u of overlayUrls()) out.push(h('div.field', h('label', u.label), h('div.urlbox', h('input', { type: 'text', readOnly: true, value: u.url, onclick: (e) => e.target.select() }), h('button.btn.sm', { onclick: async () => { (await AD.copyText(u.url)) ? AD.toast('Copied') : AD.toast('Copy failed'); } }, 'Copy'))));
    out.push(h('p.hint', 'OBS → Sources → + → Browser → paste URL, width 1920, height 1080, tick "Control audio via OBS" if you want alert sounds on stream. ',
      serverBase ? 'The local-server URL works without OBS WebSocket.' : 'Inside OBS the dock and browser sources cannot talk to each other directly, so the overlay uses OBS WebSocket (see the OBS tab) - enable it first, then copy the URL again.'));
    out.push(h('div.card', h('b', 'Relay status: '), relayStatusText()));
    out.push(h('div.btnrow', h('button.btn.primary', { onclick: () => { const ev = E.sample(['tw_follow', 'tw_sub', 'tw_raid', 'yt_superchat', 'tw_cheer'][Math.floor(Math.random() * 5)]); relay.send({ kind: 'alert', ev, cfg: alertCfgFor(ev) }); AD.toast('Test alert sent'); } }, 'Send test alert to overlay')));
    out.push(h('h3', 'Which events alert'),
      h('div.grid2', E.GROUPS.map((g) => h('label.check', h('input', { type: 'checkbox', checked: !!a.groups[g.id], onchange: (e) => S.set('alerts.groups', { ...S.get().alerts.groups, [g.id]: e.target.checked }) }), h('span', g.label)))),
      h('div.grid2', field('Minimum bits', 'alerts.minBits', { type: 'number', min: 0, step: 1 }), field('Minimum Super Chat / donation amount', 'alerts.minAmount', { type: 'number', min: 0, step: 1 })),
      h('p.hint', 'These minimums also apply to dock sounds.'));
    out.push(h('h3', 'Appearance'),
      h('div.grid2',
        field('Position', 'alerts.position', { type: 'select', options: [['top-left', 'Top left'], ['top-center', 'Top centre'], ['top-right', 'Top right'], ['center', 'Centre'], ['bottom-left', 'Bottom left'], ['bottom-center', 'Bottom centre'], ['bottom-right', 'Bottom right']] }),
        field('Theme', 'alerts.theme', { type: 'select', options: [['glass', 'Glass (dark)'], ['neon', 'Neon'], ['light', 'Light card'], ['minimal', 'Minimal text']] }),
        field('Duration (ms)', 'alerts.duration', { type: 'number', min: 1500, max: 60000, step: 500 })),
      check('Show the message text', 'alerts.showMessage'),
      check('Read alerts aloud (text-to-speech in the overlay)', 'alerts.tts', '(uses the voices installed on your PC)'),
      h('h3', 'Overlay sound'),
      check('Play alert sounds in the overlay', 'alerts.sound', '(independent of the dock sounds; per-category mutes and custom sounds from the Sounds tab apply)'),
      h('div.field', h('label', 'Overlay volume'), h('div.range', h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: a.volume ?? 0.8, oninput: (e) => { S.set('alerts.volume', Number(e.target.value), true); e.target.nextSibling.value = Math.round(e.target.value * 100) + '%'; } }), h('output', Math.round((a.volume ?? 0.8) * 100) + '%'))));
    return out;
  }
  function alertCfgFor(ev) { const a = S.get().alerts, s = S.get().sounds, def = E.typeDef(ev.type); return { duration: a.duration, position: a.position, theme: a.theme, showMessage: a.showMessage, tts: a.tts, ttsVoice: a.ttsVoice, volume: a.volume ?? 0.8, sound: def.sound, customSound: s.custom?.[def.sound] || null, muted: a.sound === false || !!s.muted?.[def.sound] }; }
  function relayStatusText() {
    const parts = [];
    parts.push(relay.bc ? 'BroadcastChannel ✓ (same browser)' : 'BroadcastChannel ✗');
    if (serverBase) parts.push('Local server ✓');
    if (relay.obs) parts.push('OBS WebSocket: ' + relay.obs.status + (relay.obs.detail ? ' (' + relay.obs.detail + ')' : ''));
    return parts.join(' · ');
  }

  /* ---------------- OBS tab ---------------- */
  function tabObs() {
    const o = S.get().obs; const st = relay.obs;
    return [
      h('p', 'Connecting to ', h('b', 'OBS WebSocket'), ' lets the dock talk to the overlay browser source inside OBS. In OBS: ', h('b', 'Tools → WebSocket Server Settings'), ' → Enable WebSocket server → note the port (default 4455) and password (Show Connect Info).'),
      check('Connect to OBS WebSocket', 'obs.enabled', null, applyObs),
      field('Server URL', 'obs.url', { placeholder: 'ws://127.0.0.1:4455' }),
      field('Password', 'obs.password', { type: 'password' }),
      h('div.btnrow', h('button.btn.primary', { onclick: () => { S.set('obs.enabled', true); applyObs(); setTimeout(renderTab, 600); } }, 'Connect'), h('button.btn', { onclick: () => { S.set('obs.enabled', false); applyObs(); renderTab(); } }, 'Disconnect')),
      st ? statusCard({ status: st.status, detail: st.detail }) : h('div.card', 'Not connected'),
      h('p.hint', 'The password is stored in this browser only. When you copy the overlay URL from the Overlay tab it includes the password so the browser source can connect too (it never leaves your PC).'),
    ];
  }
  function applyObs() { const o = S.get().obs; relay.useObs(o.enabled ? o.url : null, o.password); }

  /* ---------------- Test tab ---------------- */
  function tabTest() {
    const fire = (type) => { AD.sounds.unlock(); AD.bus.emit('event', E.sample(type)); };
    const types = Object.keys(E.TYPES).filter((t) => t !== 'sys');
    return [
      h('p', 'Fire sample events to check the feed, sounds and overlay. Test events are marked and do not count in the session stats.'),
      h('div.btnrow', h('button.btn.primary', { onclick: () => fire(types[Math.floor(Math.random() * types.length)]) }, 'Random event'), h('button.btn', { onclick: () => { let i = 0; const t = setInterval(() => { fire(types[Math.floor(Math.random() * types.length)]); if (++i >= 15) clearInterval(t); }, 300); } }, 'Burst (15)'), h('button.btn', { onclick: () => { let i = 0; const t = setInterval(() => { fire(Math.random() < 0.7 ? 'tw_chat' : 'yt_chat'); if (++i >= 30) clearInterval(t); }, 150); } }, 'Chat flood')),
      h('h3', 'Twitch'), h('div.testgrid', types.filter((t) => t.startsWith('tw_')).map((t) => h('button.btn.sm', { onclick: () => fire(t), style: { '--c': E.TYPES[t].color } }, E.iconEl(t), E.TYPES[t].label))),
      h('h3', 'YouTube'), h('div.testgrid', types.filter((t) => t.startsWith('yt_')).map((t) => h('button.btn.sm', { onclick: () => fire(t), style: { '--c': E.TYPES[t].color } }, E.iconEl(t), E.TYPES[t].label))),
    ];
  }

  /* ---------------- Debug / About tab ---------------- */
  function tabDebug() {
    const logbox = h('div.logbox', AD.logs.slice(-150).map((l) => h('div.' + l.level, AD.fmtTime(l.t, true) + ' ' + l.msg)));
    setTimeout(() => (logbox.scrollTop = logbox.scrollHeight));
    const unsub = AD.bus.on('log', (l) => { if (!logbox.isConnected) return unsub(); logbox.appendChild(h('div.' + l.level, AD.fmtTime(l.t, true) + ' ' + l.msg)); logbox.scrollTop = logbox.scrollHeight; });
    const importInput = h('input', { type: 'file', accept: 'application/json', style: { display: 'none' }, onchange: (e) => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { try { S.replace(JSON.parse(r.result)); AD.toast('Settings imported - reloading'); setTimeout(() => location.reload(), 600); } catch (err) { AD.toast('Invalid file'); } }; r.readAsText(f); } });
    let used = 0; try { for (const k in localStorage) if (Object.prototype.hasOwnProperty.call(localStorage, k)) used += (localStorage[k] || '').length * 2; } catch (_) { }
    return [
      h('h3', 'About'),
      h('p', h('b', 'Activity Dock'), ' v' + VERSION + ' - a free, open-source Twitch + YouTube activity feed for OBS. Runs entirely in your browser; nothing is sent to third-party servers other than Twitch, YouTube/Google and (optionally) your own local helper.'),
      h('div.kv', h('span', 'Running from'), h('b', IS_HTTP ? location.origin : 'local file'), h('span', 'Local server'), h('b', serverBase || 'not detected'), h('span', 'Storage used'), h('b', (used / 1024).toFixed(1) + ' KB'), h('span', 'Browser'), h('b', navigator.userAgent.includes('OBS') ? 'OBS (' + (navigator.userAgent.match(/OBS\/[\d.]+/) || [''])[0] + ')' : 'regular browser')),
      h('h3', 'Move this setup into OBS (or another browser)'),
      h('p.hint', 'Logins live in the browser they were made in. If you connected Twitch/YouTube here but the OBS dock shows "not connected", copy this link and use it as the dock URL in OBS once - it carries your settings and logins (keep it private). After OBS has loaded it, keep using the dock in one place only: Twitch logins used in two places at the same time sign each other out.'),
      h('div.btnrow', h('button.btn.primary', { onclick: async () => { (await AD.copyText(setupLink())) ? AD.toast('Setup link copied - paste it as the dock URL in OBS') : AD.toast('Copy failed'); } }, 'Copy setup link for OBS')),
      h('h3', 'Settings backup'),
      h('div.btnrow',
        h('button.btn', { onclick: () => download('activity-dock-settings.json', JSON.stringify(S.export(false), null, 2)) }, 'Export (without secrets)'),
        h('button.btn', { onclick: () => download('activity-dock-settings-full.json', JSON.stringify(S.export(true), null, 2)) }, 'Export (with secrets)'),
        h('button.btn', { onclick: async () => { (await AD.copyText(JSON.stringify(S.export(true), null, 2))) && AD.toast('Settings JSON copied'); } }, 'Copy to clipboard'),
        h('button.btn', { onclick: () => importInput.click() }, 'Import'), importInput,
        armed('Reset everything', () => { AD.twitch.logout(); AD.youtube.logout(); S.reset(); AD.store.del(HIST_KEY); AD.store.del(STATS_KEY); setTimeout(() => location.reload(), 300); }, '.danger')),
      h('h3', 'Log'),
      h('div.btnrow', h('button.btn.sm', { onclick: async () => { (await AD.copyText(AD.logs.map((l) => AD.fmtTime(l.t, true) + ' [' + l.level + '] ' + l.msg).join('\n'))) && AD.toast('Log copied'); } }, 'Copy log'), h('button.btn.sm', { onclick: () => { AD.logs.length = 0; renderTab(); } }, 'Clear')),
      logbox,
      h('h3', 'Keyboard'),
      h('p.hint', 'Esc closes settings.'),
    ];
  }
  function download(name, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $drawer.classList.contains('open')) closeSettings(); });

  /* =====================================================================
     Settings change reactions
     ===================================================================== */
  const RERENDER_KEYS = ['feed.newestTop', 'feed.showChat', 'feed.timestamps', 'feed.avatars', 'feed.noAnim', 'feed.maxItems', 'feed.compactChat'];
  AD.bus.on('settings', (path) => {
    if (path === '*' || RERENDER_KEYS.includes(path)) { rerenderAll(); renderFilters(); refreshStats(); }
    else if (path === 'feed.groups' || path === 'feed.platform') applyFilters();
    if (path === '*' || path.startsWith('obs.')) applyObs();
    if (path === '*' || path === 'sounds.enabled') refreshHeader();
  });

  /* =====================================================================
     Boot
     ===================================================================== */
  async function probeServer(base) {
    try { const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 2500); const r = await fetch(base + '/api/health', { cache: 'no-store', signal: ctrl.signal }); clearTimeout(t); const d = await r.json(); if (d?.ok && d.app === 'activity-dock') return base; } catch (_) { }
    return null;
  }
  async function detectServer() {
    if (IS_HTTP) { const same = await probeServer(location.origin); if (same) return same; }
    // dock hosted elsewhere (GitHub Pages / file) but the local server is running -> use it for YouTube + overlay relay
    const helper = (S.get().youtube.helperUrl || 'http://127.0.0.1:8520').replace(/\/$/, '');
    return probeServer(helper);
  }
  /** #setup=<base64 json> in the URL: import settings + logins (used to move a finished setup from the browser into the OBS dock). */
  function importSetupFromHash() {
    if (!q.setup) return false;
    // OBS keeps the dock URL, so the same link is opened on every start: import each payload only once
    let sig = 0; for (let i = 0; i < q.setup.length; i++) sig = (sig * 31 + q.setup.charCodeAt(i)) | 0; sig = q.setup.length + ':' + sig;
    try { window.history.replaceState(null, '', location.pathname + location.search); } catch (_) { } // keep tokens out of the address bar
    if (AD.store.get('ad.setupImported', '') === sig) return false;
    try {
      const data = JSON.parse(decodeURIComponent(escape(atob(q.setup.replace(/-/g, '+').replace(/_/g, '/')))));
      if (data.settings) S.replace(data.settings);
      if (data.twitchAuth) AD.store.set('ad.twitch.auth.v1', data.twitchAuth); if (data.youtubeAuth) AD.store.set('ad.youtube.auth.v1', data.youtubeAuth);
      AD.store.del('ad.twitch.catchup.v1'); AD.store.set('ad.setupImported', sig);
      location.reload(); return true;
    } catch (e) { AD.toast('Setup link could not be read: ' + e.message, 6000); return false; }
  }
  function setupLink() {
    const data = { settings: S.export(true), twitchAuth: AD.store.get('ad.twitch.auth.v1', null), youtubeAuth: AD.store.get('ad.youtube.auth.v1', null) };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(data)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return location.href.replace(/[#].*$/, '') + '#setup=' + b64;
  }
  async function boot() {
    if (importSetupFromHash()) return;
    AD.log('Activity Dock v' + VERSION + ' starting');
    relay = new AD.Relay('dock');
    relay.on('status', () => { if ($drawer.classList.contains('open') && (activeTab === 'obs' || activeTab === 'alerts')) renderTab(); });
    relay.on('message', (m) => { if (m.kind === 'overlay-hello') AD.log('overlay connected via ' + (m.via || 'relay')); });
    // restore history
    for (const ev of AD.store.get(HIST_KEY, [])) { if (ev && ev.id) { ev.meta = ev.meta || {}; ev.meta.history = true; history.push(ev); } }
    renderFilters(); rerenderAll(); refreshStats(); refreshHeader(); updateEmpty(); refreshHealth();
    serverBase = await detectServer();
    if (serverBase) { relay.useServer(serverBase); if (serverBase === location.origin) S.set('youtube.helperUrl', serverBase, true); AD.log('local server detected at ' + serverBase); }
    else setInterval(async () => { if (serverBase) return; const b = await detectServer(); if (b) { serverBase = b; relay.useServer(b); AD.log('local server detected at ' + b); if ($drawer.classList.contains('open')) renderTab(); } }, 30_000);
    applyObs();
    AD.twitch.init(); AD.youtube.init();
    if (q.settings === '1' || (!AD.twitch.hasAuth() && !S.get().youtube.enabled && !history.length)) openSettings('twitch');
    if (q.test === '1') setTimeout(() => { for (const t of ['tw_follow', 'tw_sub', 'tw_cheer', 'yt_superchat', 'tw_chat', 'tw_redeem']) AD.bus.emit('event', E.sample(t)); }, 300);
  }
  boot();
  AD.app = { openSettings, version: VERSION, history, stats: () => stats, has: (id) => nodes.has(id) || queuedIds.has(id), refreshHealth };
})(window.AD);
