/* Activity Dock - procedural alert sounds (WebAudio) + optional custom sounds per category */
(function (AD) {
  'use strict';
  let ctx = null;
  let master = null;
  let unlocked = false;
  const customCache = new Map(); // category -> AudioBuffer

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.connect(ctx.destination);
    }
    return ctx;
  }
  async function unlock() {
    const c = ensureCtx();
    if (!c) return false;
    if (c.state === 'suspended') { try { await c.resume(); } catch (_) { } }
    unlocked = c.state === 'running';
    AD.bus.emit('sounds:state', unlocked);
    return unlocked;
  }
  // Try to unlock on first user gesture (needed in normal browsers; OBS allows autoplay)
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => window.addEventListener(ev, () => unlock(), { once: false, passive: true }));

  function vol() { const s = AD.settings.get().sounds; return AD.clamp(Number(s.volume ?? 0.6), 0, 1); }

  /* --- synth helpers --- */
  function tone(c, dest, { freq = 440, type = 'sine', t0 = 0, dur = 0.25, gain = 0.5, attack = 0.005, decay = null, slide = null }) {
    const o = c.createOscillator(); const g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, c.currentTime + t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, c.currentTime + t0 + dur);
    g.gain.setValueAtTime(0.0001, c.currentTime + t0);
    g.gain.exponentialRampToValueAtTime(gain, c.currentTime + t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + t0 + (decay || dur));
    o.connect(g); g.connect(dest);
    o.start(c.currentTime + t0); o.stop(c.currentTime + t0 + (decay || dur) + 0.05);
  }
  function noise(c, dest, { t0 = 0, dur = 0.2, gain = 0.2, hp = 2000 }) {
    const len = Math.floor(c.sampleRate * dur); const buf = c.createBuffer(1, len, c.sampleRate); const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp;
    const g = c.createGain(); g.gain.value = gain;
    src.connect(f); f.connect(g); g.connect(dest); src.start(c.currentTime + t0);
  }

  const SYNTH = {
    follow(c, d) { tone(c, d, { freq: 880, t0: 0, dur: 0.18, gain: 0.35 }); tone(c, d, { freq: 1318.5, t0: 0.12, dur: 0.3, gain: 0.35 }); },
    sub(c, d) { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(c, d, { freq: f, t0: i * 0.09, dur: 0.35, gain: 0.3, type: 'triangle' })); },
    gift(c, d) { for (let i = 0; i < 6; i++) tone(c, d, { freq: 1200 + i * 220 + Math.random() * 60, t0: i * 0.06, dur: 0.22, gain: 0.22, type: 'sine' }); noise(c, d, { t0: 0, dur: 0.35, gain: 0.05, hp: 5000 }); },
    cheer(c, d) { tone(c, d, { freq: 987.77, t0: 0, dur: 0.08, gain: 0.35, type: 'square' }); tone(c, d, { freq: 1318.5, t0: 0.08, dur: 0.4, gain: 0.35, type: 'square' }); },
    raid(c, d) { tone(c, d, { freq: 196, t0: 0, dur: 0.6, gain: 0.4, type: 'sawtooth', slide: 392 }); tone(c, d, { freq: 392, t0: 0.35, dur: 0.6, gain: 0.35, type: 'sawtooth', slide: 587 }); noise(c, d, { t0: 0.6, dur: 0.5, gain: 0.08, hp: 1000 }); },
    redeem(c, d) { tone(c, d, { freq: 600, t0: 0, dur: 0.12, gain: 0.35, type: 'sine', slide: 1200 }); tone(c, d, { freq: 1500, t0: 0.1, dur: 0.15, gain: 0.2 }); },
    superchat(c, d) { tone(c, d, { freq: 1567.98, t0: 0, dur: 0.1, gain: 0.3, type: 'square' }); tone(c, d, { freq: 2093, t0: 0.1, dur: 0.1, gain: 0.3, type: 'square' }); tone(c, d, { freq: 2637, t0: 0.2, dur: 0.5, gain: 0.3, type: 'square' }); noise(c, d, { t0: 0.0, dur: 0.12, gain: 0.08, hp: 4000 }); },
    chat(c, d) { tone(c, d, { freq: 1400, t0: 0, dur: 0.05, gain: 0.12 }); },
  };

  async function loadCustom(category, src) {
    if (customCache.has(category)) return customCache.get(category);
    const c = ensureCtx(); if (!c) return null;
    try {
      const res = await fetch(src); const arr = await res.arrayBuffer();
      const buf = await new Promise((resolve, reject) => c.decodeAudioData(arr, resolve, reject));
      customCache.set(category, buf); return buf;
    } catch (e) { AD.log('warn', 'custom sound failed (' + category + '): ' + e.message); return null; }
  }

  /** play(category, {force}) - respects enabled/mute settings unless force */
  async function play(category, opts) {
    const s = AD.settings.get().sounds;
    if (!opts?.force && (!s.enabled || s.muted?.[category])) return;
    const c = ensureCtx(); if (!c) return;
    if (c.state === 'suspended') { await unlock(); if (c.state !== 'running') return; }
    master.gain.value = opts?.volume ?? vol();
    const custom = s.custom?.[category];
    if (custom) {
      const buf = await loadCustom(category, custom);
      if (buf) { const src = c.createBufferSource(); src.buffer = buf; src.connect(master); src.start(); return; }
    }
    (SYNTH[category] || SYNTH.follow)(c, master);
  }

  function setCustom(category, dataUrlOrUrl) {
    customCache.delete(category);
    const custom = { ...(AD.settings.get().sounds.custom || {}) };
    if (dataUrlOrUrl) custom[category] = dataUrlOrUrl; else delete custom[category];
    AD.settings.set('sounds.custom', custom);
  }

  AD.sounds = { play, unlock, setCustom, isUnlocked: () => unlocked, categories: Object.keys(SYNTH) };
})(window.AD);
