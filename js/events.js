/* Activity Dock - normalized event model, type registry, filter groups */
(function (AD) {
  'use strict';

  // Each type: label, group (filter chip), platform, default sound category, accent colour, icon (emoji keeps it dependency-free)
  const TYPES = {
    // ---- Twitch ----
    tw_follow:   { label: 'Follow',         group: 'follows', platform: 'twitch',  sound: 'follow',    color: '#4cc9f0', icon: '💜' },
    tw_sub:      { label: 'New sub',        group: 'subs',    platform: 'twitch',  sound: 'sub',       color: '#b388ff', icon: '⭐' },
    tw_resub:    { label: 'Resub',          group: 'subs',    platform: 'twitch',  sound: 'sub',       color: '#b388ff', icon: '🔁' },
    tw_gift:     { label: 'Gift subs',      group: 'gifts',   platform: 'twitch',  sound: 'gift',      color: '#f72585', icon: '🎁' },
    tw_giftrecv: { label: 'Gift received',  group: 'gifts',   platform: 'twitch',  sound: null,        color: '#f72585', icon: '🎀' },
    tw_cheer:    { label: 'Bits',           group: 'bits',    platform: 'twitch',  sound: 'cheer',     color: '#ffb703', icon: '💎' },
    tw_raid:     { label: 'Raid',           group: 'raids',   platform: 'twitch',  sound: 'raid',      color: '#fb5607', icon: '⚔️' },
    tw_shoutout: { label: 'Shoutout',       group: 'raids',   platform: 'twitch',  sound: null,        color: '#fb5607', icon: '📣' },
    tw_redeem:   { label: 'Redeem',         group: 'redeems', platform: 'twitch',  sound: 'redeem',    color: '#80ed99', icon: '🎯' },
    tw_chat:     { label: 'Chat',           group: 'chat',    platform: 'twitch',  sound: null,        color: '#9147ff', icon: '💬' },
    tw_notice:   { label: 'Notice',         group: 'other',   platform: 'twitch',  sound: null,        color: '#adb5bd', icon: '📌' },
    tw_hype:     { label: 'Hype Train',     group: 'other',   platform: 'twitch',  sound: 'raid',      color: '#ff006e', icon: '🚂' },
    tw_ad:       { label: 'Ad break',       group: 'other',   platform: 'twitch',  sound: null,        color: '#adb5bd', icon: '📺' },
    tw_stream:   { label: 'Stream',         group: 'other',   platform: 'twitch',  sound: null,        color: '#adb5bd', icon: '🔴' },
    // ---- YouTube ----
    yt_chat:       { label: 'Chat',          group: 'chat',    platform: 'youtube', sound: null,        color: '#ff0000', icon: '💬' },
    yt_superchat:  { label: 'Super Chat',    group: 'bits',    platform: 'youtube', sound: 'superchat', color: '#ffb703', icon: '💵' },
    yt_sticker:    { label: 'Super Sticker', group: 'bits',    platform: 'youtube', sound: 'superchat', color: '#ffb703', icon: '🩷' },
    yt_member:     { label: 'New member',    group: 'subs',    platform: 'youtube', sound: 'sub',       color: '#2ba640', icon: '⭐' },
    yt_milestone:  { label: 'Milestone',     group: 'subs',    platform: 'youtube', sound: 'sub',       color: '#2ba640', icon: '🔁' },
    yt_giftmember: { label: 'Gift members',  group: 'gifts',   platform: 'youtube', sound: 'gift',      color: '#f72585', icon: '🎁' },
    yt_giftrecv:   { label: 'Gift received', group: 'gifts',   platform: 'youtube', sound: null,        color: '#f72585', icon: '🎀' },
    yt_subscriber: { label: 'Subscriber',    group: 'follows', platform: 'youtube', sound: 'follow',    color: '#4cc9f0', icon: '🔔' },
    yt_system:     { label: 'YouTube',       group: 'other',   platform: 'youtube', sound: null,        color: '#adb5bd', icon: '▶️' },
    // ---- System ----
    sys:           { label: 'System',        group: 'other',   platform: 'system',  sound: null,        color: '#6c757d', icon: 'ℹ️' },
  };

  const GROUPS = [
    { id: 'follows', label: 'Follows' },
    { id: 'subs',    label: 'Subs' },
    { id: 'gifts',   label: 'Gifts' },
    { id: 'bits',    label: 'Bits / $' },
    { id: 'raids',   label: 'Raids' },
    { id: 'redeems', label: 'Redeems' },
    { id: 'chat',    label: 'Chat' },
    { id: 'other',   label: 'Other' },
  ];

  const SOUND_CATEGORIES = ['follow', 'sub', 'gift', 'cheer', 'raid', 'redeem', 'superchat'];

  // Inline SVG icons (24x24, stroke = currentColor) - no emoji font needed, render identically in OBS and the overlay.
  const SVG = {
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>',
    star: '<polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10"/>',
    gift: '<polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
    ribbon: '<circle cx="12" cy="8" r="6"/><path d="M15.5 13 17 22l-5-3-5 3 1.5-9"/>',
    diamond: '<path d="M6 3h12l4 6-10 12L2 9z"/><path d="M2 9h20"/><path d="M10 3l2 6 2-6"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
    megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6l-5 4H4a1 1 0 0 0-1 1z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    tv: '<rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/>',
    live: '<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.5M7.8 16.2a6 6 0 0 1 0-8.5M19.1 4.9a10 10 0 0 1 0 14.1M4.9 19.1a10 10 0 0 1 0-14.1"/>',
    dollar: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  };
  const ICON_OF = { tw_follow: 'heart', tw_sub: 'star', tw_resub: 'refresh', tw_gift: 'gift', tw_giftrecv: 'ribbon', tw_cheer: 'diamond', tw_raid: 'users', tw_shoutout: 'megaphone', tw_redeem: 'target', tw_chat: 'chat', tw_notice: 'info', tw_hype: 'zap', tw_ad: 'tv', tw_stream: 'live', yt_chat: 'chat', yt_superchat: 'dollar', yt_sticker: 'smile', yt_member: 'star', yt_milestone: 'refresh', yt_giftmember: 'gift', yt_giftrecv: 'ribbon', yt_subscriber: 'bell', yt_system: 'play', sys: 'info' };
  function iconSvg(type) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (SVG[ICON_OF[type]] || SVG.info) + '</svg>'; }
  function iconEl(type, cls) { const span = document.createElement('span'); span.className = 'ico' + (cls ? ' ' + cls : ''); span.innerHTML = iconSvg(type); return span; }

  /**
   * Build a normalized event. Every producer (Twitch, YouTube, tests) calls this so the
   * feed, overlay and history all share one shape.
   */
  function make(type, data) {
    const def = TYPES[type] || TYPES.sys;
    return Object.assign({
      id: AD.uid('ev'),
      ts: Date.now(),
      type,
      platform: def.platform,
      user: null,          // {name, login, id, color, avatar, badges:[{title,url}]}
      title: def.label,    // short headline
      text: '',            // secondary line (message etc.)
      fragments: null,     // [{type:'text'|'emote'|'cheermote'|'mention', text, url}]
      amount: null,        // {value, unit, display}
      meta: {},
      test: false,
    }, data || {});
  }

  function typeDef(type) { return TYPES[type] || TYPES.sys; }
  function groupOf(type) { return typeDef(type).group; }
  function isChat(ev) { return ev.type === 'tw_chat' || ev.type === 'yt_chat'; }

  /* ---------- sample/test events (also used for the overlay preview) ---------- */
  const NAMES = ['PixelPenguin', 'NightOwl_42', 'Sarah_Streams', 'KoalaKing', 'GlitchGoblin', 'MintyFresh', 'TurboTom', 'Luna_Lux', 'ByteMe', 'Crikey_Chris'];
  const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const rint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

  function sample(type) {
    const name = rnd(NAMES);
    const user = { name, login: name.toLowerCase(), color: rnd(['#ff7f50', '#9acd32', '#1e90ff', '#ff69b4', '#00ced1', '#daa520']) };
    switch (type) {
      case 'tw_follow': return make(type, { user, title: 'New follower', test: true });
      case 'tw_sub': { const tier = rnd(['1000', '1000', '2000', 'Prime']); return make(type, { user, title: 'Subscribed (' + AD.tierName(tier) + ')', meta: { tier }, test: true }); }
      case 'tw_resub': { const m = rint(2, 36); return make(type, { user, title: 'Resubscribed - ' + m + ' months', text: rnd(['Love the streams!', 'Another month, another sub 💜', 'Keep it up!']), amount: { value: m, unit: 'months', display: m + ' mo' }, meta: { tier: '1000', cumulative_months: m }, test: true }); }
      case 'tw_gift': { const n = rnd([1, 5, 10, 20, 50]); return make(type, { user, title: 'Gifted ' + n + ' sub' + (n > 1 ? 's' : '') + ' to the community', amount: { value: n, unit: 'subs', display: n + ' × Tier 1' }, meta: { tier: '1000', total: n }, test: true }); }
      case 'tw_giftrecv': return make(type, { user, title: 'Received a gift sub from ' + rnd(NAMES), meta: { tier: '1000' }, test: true });
      case 'tw_cheer': { const b = rnd([100, 250, 500, 1000, 5000]); return make(type, { user, title: 'Cheered ' + AD.fmtNum(b) + ' bits', text: 'Cheer' + b + ' great play!', amount: { value: b, unit: 'bits', display: AD.fmtNum(b) + ' bits' }, test: true }); }
      case 'tw_raid': { const v = rint(3, 400); return make(type, { user, title: 'Raiding with ' + v + ' viewers', amount: { value: v, unit: 'viewers', display: v + ' viewers' }, test: true }); }
      case 'tw_shoutout': return make(type, { user, title: 'Gave you a shoutout', amount: { value: rint(5, 200), unit: 'viewers' }, test: true });
      case 'tw_redeem': { const r = rnd(['Hydrate!', 'Pick my game', 'Emote only 1 min', 'Highlight my message', 'Song request']); return make(type, { user, title: 'Redeemed ' + r, text: rnd(['', 'play some jazz please', 'gg', 'https://youtu.be/dQw4w9WgXcQ']), amount: { value: rint(1, 50) * 100, unit: 'points', display: rint(1, 50) * 100 + ' pts' }, meta: { reward: r }, test: true }); }
      case 'tw_chat': return make(type, { user, title: '', text: rnd(['hello chat!', 'what game is this?', 'LUL', 'gg wp', 'first time here, loving it', 'W streamer']), test: true });
      case 'tw_notice': return make(type, { user, title: 'Announcement', text: 'Remember to follow for more streams!', test: true });
      case 'tw_hype': { const lvl = rint(1, 5); return make(type, { user: null, title: 'Hype Train started - level ' + lvl, amount: { value: lvl, unit: 'level', display: 'Lvl ' + lvl }, test: true }); }
      case 'tw_ad': return make(type, { user: null, title: 'Ad break started (90s)', test: true });
      case 'tw_stream': return make(type, { user: null, title: 'Stream went live', test: true });
      case 'yt_chat': return make(type, { user: { name }, title: '', text: rnd(['hi from youtube!', 'nice stream', 'lol', 'what are you playing?']), test: true });
      case 'yt_superchat': { const a = rnd([2, 5, 10, 20, 50, 100]); return make(type, { user: { name }, title: 'Super Chat ' + '$' + a.toFixed(2), text: rnd(['Take my money', 'Shoutout to my mum', 'Love from Sydney!']), amount: { value: a, unit: 'currency', display: 'A$' + a.toFixed(2), currency: 'AUD' }, meta: { tier: a >= 50 ? 5 : a >= 10 ? 3 : 1 }, test: true }); }
      case 'yt_sticker': return make(type, { user: { name }, title: 'Super Sticker A$5.00', amount: { value: 5, unit: 'currency', display: 'A$5.00' }, test: true });
      case 'yt_member': return make(type, { user: { name }, title: 'New member (Supporter)', meta: { level: 'Supporter' }, test: true });
      case 'yt_milestone': { const m = rint(2, 24); return make(type, { user: { name }, title: 'Member for ' + m + ' months', text: 'best community on the internet', amount: { value: m, unit: 'months', display: m + ' mo' }, test: true }); }
      case 'yt_giftmember': { const n = rnd([5, 10, 20]); return make(type, { user: { name }, title: 'Gifted ' + n + ' memberships', amount: { value: n, unit: 'subs', display: n + ' members' }, test: true }); }
      case 'yt_giftrecv': return make(type, { user: { name }, title: 'Received a gift membership', test: true });
      case 'yt_subscriber': return make(type, { user: { name }, title: 'New subscriber', test: true });
      case 'yt_system': return make(type, { user: null, title: 'Connected to YouTube chat', test: true });
      default: return make('sys', { title: 'Test event', test: true });
    }
  }

  AD.events = { TYPES, GROUPS, SOUND_CATEGORIES, make, typeDef, groupOf, isChat, sample, iconSvg, iconEl };
})(window.AD);
