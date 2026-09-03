/* Activity Dock - obs-websocket v5 client (tiny). Used to relay events dock -> overlay via BroadcastCustomEvent. */
(function (AD) {
  'use strict';
  class ObsClient extends AD.Emitter {
    constructor() { super(); this.ws = null; this.status = 'disconnected'; this.detail = ''; this.url = ''; this.password = ''; this._reqs = new Map(); this._backoff = 1000; this._manual = false; this._timer = null; this.version = null; }
    _set(status, detail) { this.status = status; this.detail = detail || ''; this.emit('status', this); }
    connect(url, password) {
      this.url = url || this.url; this.password = password ?? this.password; this._manual = false; clearTimeout(this._timer);
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
      let sock;
      try { sock = new WebSocket(this.url, 'obswebsocket.json'); } catch (e) { this._set('error', e.message); return; }
      this.ws = sock; this._set('connecting', 'Connecting…');
      sock.onmessage = (m) => { let msg; try { msg = JSON.parse(m.data); } catch (_) { return; } this._onMsg(msg); };
      sock.onclose = (e) => {
        if (sock !== this.ws) return; this.ws = null;
        for (const [, r] of this._reqs) r.reject(new Error('socket closed')); this._reqs.clear();
        const reasons = { 4009: 'Authentication failed - check the password', 4008: 'Authentication required', 4011: 'Kicked by OBS', 4010: 'Unsupported rpc version' };
        this._set(this._manual ? 'disconnected' : 'error', reasons[e.code] || (e.code === 1006 ? 'Cannot reach OBS WebSocket (is it enabled in Tools > WebSocket Server Settings?)' : ('closed ' + e.code)));
        if (!this._manual && e.code !== 4009) { this._timer = setTimeout(() => this.connect(), this._backoff); this._backoff = Math.min(this._backoff * 2, 30_000); }
      };
      sock.onerror = () => { };
    }
    disconnect() { this._manual = true; clearTimeout(this._timer); try { this.ws?.close(); } catch (_) { } this.ws = null; this._set('disconnected'); }
    async _onMsg(msg) {
      switch (msg.op) {
        case 0: { // Hello
          const d = msg.d; this.version = d.obsWebSocketVersion; const identify = { rpcVersion: 1, eventSubscriptions: 1 };
          if (d.authentication) {
            if (!this.password) { this._manual = true; this.ws.close(); this._set('error', 'OBS WebSocket requires a password'); return; }
            const secret = await AD.sha256b64(this.password + d.authentication.salt);
            identify.authentication = await AD.sha256b64(secret + d.authentication.challenge);
          }
          this.ws.send(JSON.stringify({ op: 1, d: identify })); return;
        }
        case 2: this._backoff = 1000; this._set('connected', 'obs-websocket ' + (this.version || '')); return; // Identified
        case 5: this.emit('event', msg.d.eventType, msg.d.eventData); if (msg.d.eventType === 'CustomEvent') this.emit('custom', msg.d.eventData); return;
        case 7: { const r = this._reqs.get(msg.d.requestId); if (!r) return; this._reqs.delete(msg.d.requestId); msg.d.requestStatus?.result ? r.resolve(msg.d.responseData || {}) : r.reject(new Error(msg.d.requestStatus?.comment || 'request failed')); return; }
      }
    }
    request(type, data) {
      return new Promise((resolve, reject) => {
        if (!this.ws || this.ws.readyState !== 1 || this.status !== 'connected') return reject(new Error('OBS not connected'));
        const id = AD.uid('req'); this._reqs.set(id, { resolve, reject });
        this.ws.send(JSON.stringify({ op: 6, d: { requestType: type, requestId: id, requestData: data || {} } }));
        setTimeout(() => { if (this._reqs.has(id)) { this._reqs.delete(id); reject(new Error('timeout')); } }, 10_000);
      });
    }
    broadcast(eventData) { return this.request('BroadcastCustomEvent', { eventData }); }
  }
  AD.ObsClient = ObsClient;
})(window.AD);
