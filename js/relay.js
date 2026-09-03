/* Activity Dock - relay between dock and overlay.
 * Transports (all optional, used in parallel):
 *   1. BroadcastChannel  - same browser profile (normal browsers; not across OBS docks/sources)
 *   2. obs-websocket      - BroadcastCustomEvent (works inside OBS between docks and browser sources)
 *   3. local server SSE   - when the dock is served by server.js (POST /api/relay -> GET /api/relay/stream)
 */
(function (AD) {
  'use strict';
  const CH = 'activity-dock-relay';
  const seen = new Set(); const seenQ = [];
  function dedupe(id) { if (!id) return false; if (seen.has(id)) return true; seen.add(id); seenQ.push(id); if (seenQ.length > 500) seen.delete(seenQ.shift()); return false; }

  class Relay extends AD.Emitter {
    constructor(role) {
      super(); this.role = role; this.obs = null; this.bc = null; this.sse = null; this.serverBase = null;
      try { this.bc = new BroadcastChannel(CH); this.bc.onmessage = (m) => this._recv(m.data, 'bc'); } catch (_) { }
    }
    useObs(url, password) {
      if (!url) { this.obs?.disconnect(); this.obs = null; this.emit('status'); return; }
      if (!this.obs) { this.obs = new AD.ObsClient(); this.obs.on('custom', (d) => { if (d && d.ad === CH) this._recv(d.msg, 'obs'); }); this.obs.on('status', () => this.emit('status')); }
      this.obs.disconnect(); this.obs.connect(url, password);
    }
    useServer(base) {
      this.serverBase = base ? base.replace(/\/$/, '') : null;
      try { this.sse?.close(); } catch (_) { } this.sse = null;
      if (!this.serverBase || this.role !== 'overlay') return;
      this.sse = new EventSource(this.serverBase + '/api/relay/stream');
      this.sse.onmessage = (m) => { try { this._recv(JSON.parse(m.data), 'sse'); } catch (_) { } };
    }
    _recv(msg, via) {
      if (!msg || msg.from === this.role) return;
      if (dedupe(msg.mid)) return;
      this.emit('message', msg, via);
    }
    send(msg) {
      msg = { ...msg, from: this.role, mid: AD.uid('m') };
      try { this.bc?.postMessage(msg); } catch (_) { }
      if (this.obs && this.obs.status === 'connected') this.obs.broadcast({ ad: CH, msg }).catch((e) => AD.log('warn', 'obs relay: ' + e.message));
      if (this.serverBase && this.role === 'dock') fetch(this.serverBase + '/api/relay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) }).catch(() => { });
    }
  }
  AD.Relay = Relay;
})(window.AD);
