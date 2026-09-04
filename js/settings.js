/* Activity Dock - settings (persisted in localStorage) */
(function (AD) {
  'use strict';
  const KEY = 'ad.settings.v1';

  const DEFAULTS = {
    twitch: {
      enabled: true,
      clientId: '',
      chat: true,            // subscribe to chat messages
      notices: true,         // announcements, watch streaks, upgrades ...
      hype: true,
      ads: true,
      streamStatus: true,
      catchUp: true,         // on connect: fetch follows / subs / bits that happened since the last session
      poll: true,            // every 5 min: safety-net check via Helix (covers missed EventSub events)
      // dev / advanced (hidden unless ?dev=1)
      wsUrl: '',
      helixUrl: '',
      skipValidate: false,
    },
    youtube: {
      enabled: false,
      mode: 'auto',          // auto | official | unofficial
      clientId: '',
      clientSecret: '',
      apiKey: '',
      source: 'auto',        // auto | video | channel
      videoId: '',
      channel: '',           // @handle or UC... id
      helperUrl: 'http://127.0.0.1:8520',
      pollMin: 0,            // seconds; 0 = follow server-provided interval
      useStream: true,       // try streamList before falling back to list polling
      subscribers: true,     // poll recent subscribers (official OAuth only)
      history: true,         // on connect: recent subscribers + super chats of the last 30 days (official OAuth only)
      chat: true,
    },
    feed: {
      showChat: true,
      newestTop: true,
      maxItems: 400,
      compactChat: true,
      timestamps: true,
      avatars: true,
      groups: { follows: true, subs: true, gifts: true, bits: true, raids: true, redeems: true, chat: true, other: true },
      platform: 'all',       // all | twitch | youtube
      fontScale: 1,
      showStats: true,
      noAnim: false,
    },
    sounds: {
      enabled: true,
      volume: 0.6,
      custom: {},            // category -> url/dataURL
      muted: { },            // category -> true
      chatPing: false,
    },
    alerts: {
      enabled: true,
      groups: { follows: true, subs: true, gifts: true, bits: true, raids: true, redeems: true, chat: false, other: false },
      minBits: 0,
      minAmount: 0,
      duration: 7000,
      position: 'top-right', // top-left | top-right | bottom-left | bottom-right | center
      showMessage: true,
      tts: false,
      theme: 'glass',
      ttsVoice: '',
      sound: true,           // play alert sounds in the overlay (independent of dock sounds)
      volume: 0.8,
    },
    obs: {
      enabled: false,
      url: 'ws://127.0.0.1:4455',
      password: '',
    },
    ui: { settingsOpen: false, paused: false },
  };

  function deepMerge(base, over) {
    if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
    const out = { ...base };
    if (over && typeof over === 'object') for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
    return out;
  }
  const clone = (o) => JSON.parse(JSON.stringify(o));

  let state = deepMerge(clone(DEFAULTS), AD.store.get(KEY, {}));
  const save = AD.debounce(() => AD.store.set(KEY, state), 150);

  const settings = {
    DEFAULTS,
    get() { return state; },
    /** set('feed.maxItems', 300) */
    set(path, value, silent) {
      const parts = path.split('.');
      let o = state;
      for (let i = 0; i < parts.length - 1; i++) { if (typeof o[parts[i]] !== 'object' || o[parts[i]] == null) o[parts[i]] = {}; o = o[parts[i]]; }
      const old = o[parts[parts.length - 1]];
      if (old === value) return;
      o[parts[parts.length - 1]] = value;
      save();
      if (!silent) AD.bus.emit('settings', path, value, old);
    },
    patch(obj) { state = deepMerge(state, obj); save(); AD.bus.emit('settings', '*'); },
    replace(obj) { state = deepMerge(clone(DEFAULTS), obj || {}); AD.store.set(KEY, state); AD.bus.emit('settings', '*'); },
    reset() { state = clone(DEFAULTS); AD.store.set(KEY, state); AD.bus.emit('settings', '*'); },
    export(includeSecrets) {
      const s = clone(state);
      delete s.ui;
      if (!includeSecrets) { s.youtube.clientSecret = ''; s.youtube.apiKey = ''; s.obs.password = ''; }
      return s;
    },
    flush() { AD.store.set(KEY, state); },
  };
  window.addEventListener('beforeunload', () => settings.flush());
  AD.settings = settings;
})(window.AD);
