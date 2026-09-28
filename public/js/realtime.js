/**
 * GlobalJam Studio — RealtimeManager
 *
 * Reemplaza Socket.io con Supabase Realtime.
 * Usa la MISMA interfaz de eventos para que el resto del código no cambie:
 *
 *   realtime.on('event', handler)   ← equivalente a socket.on()
 *   realtime.send('event', data)    ← equivalente a socket.emit()
 *   realtime.userId                 ← equivalente a socket.id
 *
 * El audio P2P (WebRTC) nunca pasa por aquí — solo la señalización.
 *
 * Supabase Realtime provee:
 *   • Broadcast   → mensajes en tiempo real (WebRTC signaling, MIDI, metrónomo)
 *   • Presence    → quién está en cada sala (lista de músicos)
 *   • DB changes  → actualizaciones de la tabla rooms
 */

class RealtimeManager {
  constructor() {
    this.supabase    = null;
    this.channel     = null;
    this.userId      = 'user_' + crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
    this.roomId      = null;
    this._handlers   = {};
    this._connected  = false;
    this._myInfo     = {};
    this._peers      = new Map();      // userId → presenceInfo
    this._roomInterval = null;
  }

  // ── Event Bus (compatible con Socket.io) ──────────────────────────
  on(event, fn) {
    (this._handlers[event] ??= []).push(fn);
    return this;
  }
  once(event, fn) {
    const w = (d) => { fn(d); this.off(event, w); };
    return this.on(event, w);
  }
  off(event, fn) {
    this._handlers[event] = (this._handlers[event] || []).filter(h => h !== fn);
  }
  _fire(event, data) {
    (this._handlers[event] || []).forEach(fn => {
      try { fn(data); } catch(e) { console.error(`[RT] handler error (${event}):`, e); }
    });
  }

  get connected() { return this._connected; }

  // ── Inicializar cliente Supabase ───────────────────────────────────
  async init(supabaseUrl, supabaseKey) {
    if (!supabaseUrl || supabaseUrl.includes('__')) {
      this._showConfigError();
      return;
    }

    this.supabase = window.supabase.createClient(supabaseUrl, supabaseKey, {
      realtime: { params: { eventsPerSecond: 40 } },
    });

    this._connected = true;
    this._fire('connect', {});

    await this._fetchRoomList();
    // Actualizar lista de salas cada 5s
    this._roomInterval = setInterval(() => this._fetchRoomList(), 5000);
  }

  _showConfigError() {
    const msg = document.createElement('div');
    msg.style.cssText = `
      position:fixed;inset:0;background:#0d0d0f;color:#e2e8f0;
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      font-family:Inter,sans-serif;z-index:99999;padding:2rem;text-align:center;
    `;
    msg.innerHTML = `
      <div style="font-size:2rem;margin-bottom:1rem">⚙️</div>
      <h2 style="font-size:1.3rem;margin-bottom:.75rem;color:#818cf8">Configura Supabase</h2>
      <p style="color:#94a3b8;max-width:420px;line-height:1.6;margin-bottom:1.5rem">
        Para usar GlobalJam necesitas conectar tu proyecto de Supabase.
        Edita el archivo <code style="background:#1e1e32;padding:.2rem .4rem;border-radius:4px">public/js/config.js</code>
        con tu URL y clave anónima de Supabase.
      </p>
      <div style="background:#1e1e32;border:1px solid #2a2a4a;border-radius:8px;padding:1rem;font-family:monospace;font-size:.85rem;text-align:left;max-width:500px;">
        window.GLOBALJAM_CONFIG = {<br>
        &nbsp;&nbsp;supabaseUrl: '<strong>https://tu-proyecto.supabase.co</strong>',<br>
        &nbsp;&nbsp;supabaseKey: '<strong>tu-clave-anonima-publica</strong>',<br>
        };
      </div>
      <p style="color:#475569;font-size:.8rem;margin-top:1rem">
        Obtén estas credenciales en supabase.com → tu proyecto → Settings → API
      </p>
    `;
    document.body.appendChild(msg);
  }

  // ── Lista de salas (desde la BD) ───────────────────────────────────
  async _fetchRoomList() {
    const { data } = await this.supabase
      .from('rooms')
      .select('id, name, user_count, last_active')
      .order('last_active', { ascending: false })
      .limit(20);

    this._fire('room_list', (data || []).map(r => ({
      id:        r.id,
      name:      r.name,
      userCount: r.user_count || 0,
      users:     [],
    })));
  }

  // ── send() — interfaz pública (reemplaza socket.emit) ─────────────
  send(event, data = {}) {
    switch(event) {
      case 'create_room':     return this._createRoom(data);
      case 'join_room':       return this._joinRoom(data);
      case 'rtc_offer':       return this._bcast('rtc_offer',  { ...data, from: this.userId });
      case 'rtc_answer':      return this._bcast('rtc_answer', { ...data, from: this.userId });
      case 'rtc_ice':         return this._bcast('rtc_ice',    { ...data, from: this.userId });
      case 'midi_event':      return this._sendMidi(data);
      case 'chat_message':    return this._sendChat(data);
      case 'set_metronome': {
        const payload = { ...data, serverTime: Date.now(), from: this.userId };
        this._bcast('metronome_update', payload);
        this._fire('metronome_update', payload); // Ejecutar localmente también
        return;
      }
      case 'channel_update':  return this._bcast('channel_update', { ...data, userId: this.userId });
      case 'report_latency':  return this._bcast('user_latency',   { ...data, userId: this.userId });
      case 'update_user':     return this._updatePresence(data);
      case 'ping':            // local — sin red
        setTimeout(() => this._fire('pong', { t: data.t, s: Date.now() }), 0);
        return;
      default:
        console.warn('[RT] send() evento desconocido:', event);
    }
  }

  // ── Crear sala (escribe en BD) ─────────────────────────────────────
  async _createRoom({ name }) {
    const id = Math.random().toString(36).slice(2, 8).toUpperCase();
    const { error } = await this.supabase.from('rooms').insert({
      id,
      name:        name || `Jam ${id}`,
      last_active: new Date().toISOString(),
      user_count:  0,
    });
    if (error) { this._fire('error', { msg: 'Error al crear sala: ' + error.message }); return; }
    this._fire('room_created', { roomId: id });
    await this._fetchRoomList();
  }

  // ── Unirse a sala ──────────────────────────────────────────────────
  async _joinRoom({ roomId, userName, instrument, color, hasAudio, hasMidi }) {
    roomId = roomId.toUpperCase().trim();

    // Verificar que la sala existe
    const { data: room } = await this.supabase
      .from('rooms')
      .select('*')
      .eq('id', roomId)
      .maybeSingle();

    if (!room) {
      this._fire('error', { msg: `Sala "${roomId}" no encontrada. Verifica el código.` });
      return;
    }

    this.roomId  = roomId;
    this._myInfo = { userId: this.userId, name: userName, instrument, color, hasAudio: !!hasAudio, hasMidi: !!hasMidi };

    // Limpiar canal anterior
    if (this.channel) {
      await this.supabase.removeChannel(this.channel);
      this.channel = null;
    }

    // Crear canal de Supabase Realtime para la sala
    this.channel = this.supabase.channel(`room:${roomId}`, {
      config: {
        broadcast: { self: false, ack: false },
        presence:  { key: this.userId },
      },
    });

    // ── Presence: lista de músicos ─────────────────────────────────
    this.channel.on('presence', { event: 'sync' }, () => {
      const state = this.channel.presenceState();
      this._peers.clear();
      Object.values(state).flat().forEach(u => {
        if (u.userId !== this.userId) this._peers.set(u.userId, u);
      });
    });

    this.channel.on('presence', { event: 'join' }, ({ newPresences }) => {
      newPresences.forEach(p => {
        if (p.userId === this.userId) return;
        this._peers.set(p.userId, p);
        this._fire('peer_joined', { user: { ...p, id: p.userId } });
      });
      this._syncRoomCount();
    });

    this.channel.on('presence', { event: 'leave' }, ({ leftPresences }) => {
      leftPresences.forEach(p => {
        this._peers.delete(p.userId);
        this._fire('peer_left', { userId: p.userId });
      });
      this._syncRoomCount();
    });

    // ── Broadcasts: señalización WebRTC + eventos ──────────────────
    [
      'rtc_offer', 'rtc_answer', 'rtc_ice',
      'metronome_update', 'user_latency',
      'channel_update', 'user_updated',
      'chat_message', 'midi_event',
    ].forEach(event => {
      this.channel.on('broadcast', { event }, ({ payload }) => {
        // Filtrar mensajes dirigidos a otro usuario
        if (payload.targetId && payload.targetId !== this.userId) return;
        this._fire(event, payload);
      });
    });

    // ── Suscribirse y entrar ───────────────────────────────────────
    await new Promise(resolve => {
      this.channel.subscribe(async status => {
        if (status !== 'SUBSCRIBED') return;

        // Registrar nuestra presencia
        await this.channel.track(this._myInfo);

        // Leer presencia actual (peers ya en la sala)
        const state = this.channel.presenceState();
        const peers = Object.values(state).flat()
          .filter(p => p.userId !== this.userId)
          .map(p => ({ ...p, id: p.userId }));

        // Cargar historial de chat reciente de la BD
        const { data: chatHistory } = await this.supabase
          .from('chat_messages')
          .select('user_name, user_color, text, created_at')
          .eq('room_id', roomId)
          .order('created_at', { ascending: false })
          .limit(30);

        // Actualizar contador en la BD
        await this.supabase.from('rooms').update({
          user_count:  peers.length + 1,
          last_active: new Date().toISOString(),
        }).eq('id', roomId);

        this._fire('joined_room', {
          room: {
            id:        room.id,
            name:      room.name,
            metronome: { bpm: 120, isPlaying: false },
          },
          user:        { ...this._myInfo, id: this.userId },
          peers,
          chatHistory: (chatHistory || []).reverse(),
        });

        resolve();
      });
    });
  }

  // ── Broadcast genérico ─────────────────────────────────────────────
  async _bcast(event, payload) {
    if (!this.channel) return;
    return this.channel.send({ type: 'broadcast', event, payload });
  }

  // ── MIDI: broadcast + guardar en BD ───────────────────────────────
  async _sendMidi({ data, deviceName }) {
    const payload = {
      from:       this.userId,
      userName:   this._myInfo.name,
      color:      this._myInfo.color,
      data,
      deviceName,
      serverTime: Date.now(),
    };
    await this._bcast('midi_event', payload);

    // Persistir en BD (asíncrono, sin bloquear)
    this.supabase.from('midi_events').insert({
      room_id:    this.roomId,
      user_name:  this._myInfo.name,
      event_data: { data, deviceName },
    }).then(() => {});
  }

  // ── Chat: broadcast + guardar en BD ───────────────────────────────
  async _sendChat({ text }) {
    const payload = {
      from:  this._myInfo.name,
      color: this._myInfo.color,
      text,
      time:  Date.now(),
    };
    await this._bcast('chat_message', payload);

    this.supabase.from('chat_messages').insert({
      room_id:    this.roomId,
      user_name:  this._myInfo.name,
      user_color: this._myInfo.color,
      text,
    }).then(() => {});
  }

  // ── Actualizar presencia (info del usuario) ────────────────────────
  async _updatePresence(info) {
    Object.assign(this._myInfo, info);
    if (this.channel) {
      await this.channel.track(this._myInfo);
      const payload = { ...this._myInfo, id: this.userId };
      await this._bcast('user_updated', payload);
      this._fire('user_updated', payload);
    }
  }

  async _syncRoomCount() {
    if (!this.roomId) return;
    await this.supabase.from('rooms').update({
      user_count:  this._peers.size + 1,
      last_active: new Date().toISOString(),
    }).eq('id', this.roomId);
    await this._fetchRoomList();
  }

  // ── Salir de la sala ───────────────────────────────────────────────
  async leaveRoom() {
    if (this.channel) {
      try { await this.supabase.removeChannel(this.channel); } catch(_) {}
      this.channel = null;
    }
    if (this.roomId) {
      try {
        await this.supabase.rpc('decrement_room_users', { room_id: this.roomId });
      } catch(_) {}
    }
    this.roomId = null;
    this._peers.clear();
  }

  destroy() {
    if (this._roomInterval) clearInterval(this._roomInterval);
    this.leaveRoom();
    this._connected = false;
  }
}

window.RealtimeManager = RealtimeManager;
