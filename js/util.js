/* Activity Dock - shared utilities (classic script, no modules so file:// works too) */
window.AD = window.AD || {};
(function (AD) {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Tiny hyperscript: h('div.cls#id', {attr: v, onclick: fn}, child, ...) */
  function h(tag, attrs, ...children) {
    const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
    const el = document.createElement(m[1] || 'div');
    (m[2] || '').split(/(?=[.#])/).forEach((t) => {
      if (t[0] === '.') el.classList.add(t.slice(1));
      else if (t[0] === '#') el.id = t.slice(1);
    });
    if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sv == null || sv === false) continue; if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'html') el.innerHTML = v;
        else if (k in el && k !== 'list' && k !== 'form') { try { el[k] = v; } catch (_) { el.setAttribute(k, v); } }
        else el.setAttribute(k, v === true ? '' : v);
      }
    } else if (attrs != null) {
      children.unshift(attrs);
    }
    append(el, children);
    return el;
  }
  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  function fmtTime(ts, withSeconds) {
    const d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + (withSeconds ? ':' + pad2(d.getSeconds()) : '');
  }
  function relTime(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }
  /** Time label for the feed: today -> 14:05, this week -> Tue 14:05, older -> 3 Sep */
  function fmtWhen(ts) {
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return fmtTime(ts);
    const days = (now - d) / 86400000;
    if (days < 6) return d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + fmtTime(ts);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  function fmtNum(n) { return Number(n || 0).toLocaleString(); }
  function fmtMoney(micros, currency) {
    const v = Number(micros || 0) / 1e6;
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(v); }
    catch (_) { return (currency || '') + ' ' + v.toFixed(2); }
  }
  function tierName(t) {
    return ({ '1000': 'Tier 1', '2000': 'Tier 2', '3000': 'Tier 3', Prime: 'Prime', prime: 'Prime' })[String(t)] || (t ? String(t) : '');
  }

  let _uid = 0;
  const uid = (p) => (p || 'id') + '-' + Date.now().toString(36) + '-' + (++_uid).toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  /** throttle: runs at most once per `ms`, always with a trailing call (unlike debounce it cannot be starved). .flush() runs a pending call now. */
  function throttle(fn, ms) {
    let last = 0, t = null, args = null;
    const run = () => { last = Date.now(); t = null; const a = args; args = null; fn(...a); };
    const wrapped = (...a) => { args = a; if (t) return; const wait = Math.max(0, ms - (Date.now() - last)); t = setTimeout(run, wait); };
    wrapped.flush = () => { if (t) { clearTimeout(t); run(); } };
    return wrapped;
  }

  /* localStorage that never throws */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { AD.log('warn', 'storage write failed: ' + e.message); return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (_) { } },
  };

  class Emitter {
    constructor() { this._l = new Map(); }
    on(ev, fn) { if (!this._l.has(ev)) this._l.set(ev, new Set()); this._l.get(ev).add(fn); return () => this.off(ev, fn); }
    off(ev, fn) { this._l.get(ev)?.delete(fn); }
    emit(ev, ...args) { for (const fn of [...(this._l.get(ev) || [])]) { try { fn(...args); } catch (e) { AD.log('error', 'listener error (' + ev + '): ' + (e.stack || e)); } } }
  }

  /* --- SHA-256 (fallback when crypto.subtle is unavailable, e.g. plain http on a LAN ip) --- */
  function sha256bytes(msgBytes) {
    const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const l = msgBytes.length, bitLen = l * 8, padLen = ((l + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(padLen); buf.set(msgBytes); buf[l] = 0x80;
    const dv = new DataView(buf.buffer); dv.setUint32(padLen - 4, bitLen >>> 0); dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000));
    const W = new Uint32Array(64), rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < padLen; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) { const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3), s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10); W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0; }
      let [a, b, c, d, e, f, g, hh] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f) ^ (~e & g), t1 = (hh + S1 + ch + K[i] + W[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), maj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += hh;
    }
    const out = new Uint8Array(32); const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
  }
  async function sha256b64(str) {
    const bytes = new TextEncoder().encode(str);
    let digest;
    if (window.crypto && crypto.subtle) { try { digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); } catch (_) { } }
    if (!digest) digest = sha256bytes(bytes);
    let bin = ''; digest.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin);
  }

  function parseHashParams() {
    const out = {};
    const src = (location.hash || '').replace(/^#/, '') + '&' + (location.search || '').replace(/^\?/, '');
    for (const part of src.split('&')) {
      if (!part) continue;
      const i = part.indexOf('=');
      const k = decodeURIComponent(i < 0 ? part : part.slice(0, i));
      const v = i < 0 ? '1' : decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '));
      out[k] = v;
    }
    return out;
  }

  /* --- log ring buffer (shown in settings > Debug) --- */
  const LOG_MAX = 300;
  AD.logs = [];
  AD.log = function (level, msg) {
    if (msg === undefined) { msg = level; level = 'info'; }
    const line = { t: Date.now(), level, msg: String(msg) };
    AD.logs.push(line); if (AD.logs.length > LOG_MAX) AD.logs.splice(0, AD.logs.length - LOG_MAX);
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn('[AD ' + fmtTime(line.t, true) + '] ' + line.msg);
    AD.bus?.emit('log', line);
  };

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) { }
    try {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (_) { return false; }
  }

  function toast(msg, ms) {
    let box = document.getElementById('toast');
    if (!box) { box = h('div#toast'); document.body.appendChild(box); }
    const el = h('div.toast-item', msg);
    box.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, ms || 3000);
  }

  /* Convert 0xAARRGGBB (as YouTube sends) into css rgba() */
  function argbToCss(n) {
    if (n == null) return null;
    n = Number(n) >>> 0;
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + (((n >>> 24) & 255) / 255).toFixed(2) + ')';
  }
  /* '#rrggbb' -> 'rgba(r,g,b,a)' (avoids color-mix() so older OBS/CEF builds render it too) */
  function rgba(hex, a) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return hex || null;
    return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + (a == null ? 1 : a) + ')';
  }

  Object.assign(AD, { esc, h, append, fmtTime, fmtWhen, relTime, fmtNum, fmtMoney, tierName, uid, sleep, clamp, debounce, throttle, store, Emitter, sha256b64, parseHashParams, copyText, toast, argbToCss, rgba });
  AD.bus = new Emitter();
})(window.AD);
