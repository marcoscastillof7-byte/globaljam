/**
 * GlobalJam Studio — Gestor WebRTC (mesh P2P)
 *
 * Cada par de músicos tiene su propia RTCPeerConnection directa.
 * El audio va de navegador a navegador SIN pasar por el servidor.
 *
 * Acepta cualquier "signaling" con interfaz:
 *   signaling.on(event, handler)   — suscribirse a eventos
 *   signaling.send(event, data)    — enviar evento (Socket.io o Supabase Realtime)
 *   signaling.userId               — ID del usuario local
 */

class RTCManager {
  constructor(signaling) {
    this.signaling = signaling;   // RealtimeManager (o Socket.io compatible)
    this.peers     = new Map();   // peerId → RTCPeerConnection

    // STUN libre de Google — para NAT traversal básico
    this.ICE_CONFIG = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302'  },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
      ],
      iceCandidatePoolSize: 10,
    };

    // Callbacks externos
    this.onRemoteStream    = null;  // (peerId, stream) → void
    this.onPeerDisconnect  = null;  // (peerId) → void
    this.onPeerConnected   = null;  // (peerId) → void
    this.onStateChange     = null;  // (peerId, state) → void

    this._localStream = null;
    this._setupSocketHandlers();
  }

  // ── Señalización Socket.io ─────────────────────────────────────────────────
  _setupSocketHandlers() {
    this.signaling.on('rtc_offer', async ({ from, offer }) => {
      console.log(`[RTC] Offer de ${from}`);
      await this._handleOffer(from, offer);
    });

    this.signaling.on('rtc_answer', async ({ from, answer }) => {
      const pc = this.peers.get(from);
      if (!pc) return;
      try { await pc.setRemoteDescription(new RTCSessionDescription(answer)); }
      catch(e) { console.error('[RTC] Error al setRemoteDescription answer:', e); }
    });

    this.signaling.on('rtc_ice', async ({ from, candidate }) => {
      const pc = this.peers.get(from);
      if (!pc || !candidate) return;
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch(e) { /* ignorar candidatos tardíos */ }
    });
  }

  /** Establecer el stream local del instrumento */
  setLocalStream(stream) {
    this._localStream = stream;

    // Si ya hay conexiones activas, reemplazar tracks
    this.peers.forEach((pc, peerId) => {
      if (!stream) return;
      const senders = pc.getSenders();
      stream.getTracks().forEach(track => {
        const sender = senders.find(s => s.track?.kind === track.kind);
        if (sender) {
          sender.replaceTrack(track).catch(e => console.warn(`replaceTrack error:`, e));
        } else {
          pc.addTrack(track, stream);
        }
      });
    });
  }

  /** Iniciar oferta WebRTC hacia un peer (llamado por el que se une) */
  async initiateOffer(peerId) {
    console.log(`[RTC] Iniciando offer → ${peerId}`);
    const pc = this._createPeerConnection(peerId);

    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(offer);
      this.signaling.send('rtc_offer', { targetId: peerId, offer });
    } catch(e) {
      console.error(`[RTC] Error creando offer para ${peerId}:`, e);
    }
    return pc;
  }

  async _handleOffer(peerId, offer) {
    const pc = this._createPeerConnection(peerId);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signaling.send('rtc_answer', { targetId: peerId, answer });
    } catch(e) {
      console.error(`[RTC] Error manejando offer de ${peerId}:`, e);
    }
  }

  _createPeerConnection(peerId) {
    // Cerrar conexión existente si la hay
    if (this.peers.has(peerId)) {
      try { this.peers.get(peerId).close(); } catch(_){}
    }

    const pc = new RTCPeerConnection(this.ICE_CONFIG);
    this.peers.set(peerId, pc);

    // Agregar tracks del instrumento local
    if (this._localStream) {
      this._localStream.getTracks().forEach(track => {
        pc.addTrack(track, this._localStream);
      });
    }

    // Recibir stream remoto del instrumento del otro músico
    pc.ontrack = event => {
      console.log(`[RTC] Track recibido de ${peerId}`);
      const stream = event.streams[0] || new MediaStream([event.track]);
      if (this.onRemoteStream) this.onRemoteStream(peerId, stream);
    };

    // Enviar candidatos ICE al peer vía señalización
    pc.onicecandidate = event => {
      if (event.candidate) {
        this.signaling.send('rtc_ice', { targetId: peerId, candidate: event.candidate });
      }
    };

    // Monitor de estado de conexión
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log(`[RTC] ${peerId}: ${state}`);
      if (this.onStateChange) this.onStateChange(peerId, state);

      if (state === 'connected') {
        if (this.onPeerConnected) this.onPeerConnected(peerId);
      } else if (state === 'failed' || state === 'disconnected') {
        if (this.onPeerDisconnect) this.onPeerDisconnect(peerId);
        // Intento de reconexión
        setTimeout(() => {
          if (pc.connectionState === 'failed') {
            console.warn(`[RTC] Intentando reconectar con ${peerId}`);
            this.initiateOffer(peerId);
          }
        }, 2000);
      }
    };

    pc.onicegatheringstatechange = () => {
      console.log(`[RTC] ICE gathering (${peerId}): ${pc.iceGatheringState}`);
    };

    return pc;
  }

  /** Obtener estadísticas de la conexión (latencia, jitter, pérdida) */
  async getStats(peerId) {
    const pc = this.peers.get(peerId);
    if (!pc) return null;

    const stats = await pc.getStats();
    const result = { rtt: null, jitter: null, packetsLost: null, state: pc.connectionState };

    stats.forEach(report => {
      if (report.type === 'remote-inbound-rtp' && report.kind === 'audio') {
        result.rtt         = report.roundTripTime != null ? Math.round(report.roundTripTime * 1000) : null;
        result.jitter      = report.jitter != null ? Math.round(report.jitter * 1000) : null;
        result.packetsLost = report.packetsLost;
      }
    });

    return result;
  }

  getPeerState(peerId) {
    return this.peers.get(peerId)?.connectionState || 'none';
  }

  removePeer(peerId) {
    const pc = this.peers.get(peerId);
    if (pc) { try { pc.close(); } catch(_){} this.peers.delete(peerId); }
  }

  removeAllPeers() {
    this.peers.forEach((pc) => { try { pc.close(); } catch(_){} });
    this.peers.clear();
  }
}

window.RTCManager = RTCManager;
