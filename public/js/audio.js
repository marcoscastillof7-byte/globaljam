/**
 * GlobalJam Studio — Motor de audio real
 *
 * Gestiona:
 *  - Captura de audio desde interfaz de audio / micrófono (getUserMedia)
 *  - Procesamiento por canal: Gain → EQ (3 bandas) → Compresor → Pan → Analizador → Master
 *  - Metrónomo local con Web Audio API (máxima precisión)
 *  - VU meters con datos del AnalyserNode
 */

class AudioEngine {
  constructor() {
    this.ctx         = null;
    this.masterGain  = null;
    this.masterComp  = null;
    this.masterAnalyser = null;
    this.channels    = new Map();  // peerId → AudioChannel
    this.localChannel = null;
    this.localStream  = null;

    // Metrónomo
    this._metroTimer     = null;
    this._metroNextTime  = 0;
    this._metroBeat      = 0;
    this._metroCallback  = null;

    this._initialized = false;
  }

  /** Inicializar AudioContext (requiere gesto del usuario) */
  async init() {
    if (this._initialized) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive',
      sampleRate: 48000,
    });
    await this.ctx.resume();

    // Cadena maestra
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.9;

    this.masterComp = this.ctx.createDynamicsCompressor();
    this.masterComp.threshold.value = -10;
    this.masterComp.knee.value      = 6;
    this.masterComp.ratio.value     = 3;
    this.masterComp.attack.value    = 0.005;
    this.masterComp.release.value   = 0.15;

    this.masterAnalyser = this.ctx.createAnalyser();
    this.masterAnalyser.fftSize = 512;
    this.masterAnalyser.smoothingTimeConstant = 0.7;

    this.masterGain.connect(this.masterComp);
    this.masterComp.connect(this.masterAnalyser);
    this.masterAnalyser.connect(this.ctx.destination);

    this._initialized = true;
  }

  /**
   * Capturar audio del usuario.
   * @param {string|null} deviceId  - ID del dispositivo de entrada (null = default)
   * @param {string}      mode      - 'instrument' | 'microphone'
   *   instrument → sin cancelación de eco/ruido (ideal para guitarra, bajo, teclado)
   *   microphone → con cancelación de eco y reducción de ruido (ideal para voz/micro)
   */
  async captureLocalAudio(deviceId = null, mode = 'instrument') {
    await this.init();

    const isMicMode = mode === 'microphone';

    const constraints = {
      audio: {
        deviceId:          deviceId ? { exact: deviceId } : undefined,
        echoCancellation:  isMicMode,   // ON para micrófono de voz
        noiseSuppression:  isMicMode,   // ON para micrófono de voz
        autoGainControl:   isMicMode,   // ON para micrófono (normaliza el nivel)
        latency:           isMicMode ? 0.05 : 0,
        sampleRate:        48000,
        channelCount:      { ideal: isMicMode ? 1 : 2 },
        sampleSize:        24,
      }
    };

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch(e) {
      // Fallback: intentar sin deviceId específico
      if (deviceId) {
        constraints.audio.deviceId = undefined;
        this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      } else throw e;
    }

    // Canal local (para monitoreo)
    if (this.localChannel) this.localChannel.destroy();
    this.localChannel = new AudioChannel(this.ctx, this.masterGain, 'local');
    this.localChannel.connectStream(this.localStream);

    // Monitor en 0 por defecto (evitar feedback)
    this.localChannel.setMonitor(0);

    return this.localStream;
  }

  /** Lista de dispositivos de audio de entrada */
  async getAudioInputDevices() {
    try {
      // Necesitamos pedir permiso para obtener etiquetas reales
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach(t => t.stop());
    } catch(_) {}
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'audioinput').map(d => ({
      id:    d.deviceId,
      label: d.label || `Micrófono ${d.deviceId.slice(0,6)}`,
      group: d.groupId,
    }));
  }

  /** Crear canal para audio remoto recibido por WebRTC */
  addRemoteChannel(peerId, remoteStream) {
    if (this.channels.has(peerId)) this.channels.get(peerId).destroy();
    const ch = new AudioChannel(this.ctx, this.masterGain, peerId);
    ch.connectStream(remoteStream);
    ch.setMonitor(1); // escuchar por defecto
    this.channels.set(peerId, ch);
    return ch;
  }

  getChannel(peerId) { return this.channels.get(peerId); }
  getLocalChannel()  { return this.localChannel; }

  removeChannel(peerId) {
    const ch = this.channels.get(peerId);
    if (ch) { ch.destroy(); this.channels.delete(peerId); }
  }

  /** Nivel del master bus (0–1) */
  getMasterLevel() {
    if (!this.masterAnalyser) return 0;
    const buf = new Float32Array(this.masterAnalyser.frequencyBinCount);
    this.masterAnalyser.getByteTimeDomainData(new Uint8Array(buf.buffer));
    return 0; // simplificado; se usa getChannelLevel de cada canal
  }

  setMasterGain(value) {
    if (this.masterGain) this.masterGain.gain.value = Math.max(0, Math.min(2, value));
  }

  // ─── Metrónomo ─────────────────────────────────────────────────────────────
  /** callback(beat, totalBeat) — se llama en cada pulso */
  startMetronome(bpm, callback) {
    this.stopMetronome();
    this._metroCallback  = callback;
    this._metroBeat      = 0;
    this._metroNextTime  = this.ctx.currentTime + 0.05;
    const scheduleAhead  = 0.12; // segundos de anticipación
    const interval       = 25;   // ms del scheduler loop

    const tick = () => {
      const secPerBeat = 60 / bpm;
      while (this._metroNextTime < this.ctx.currentTime + scheduleAhead) {
        // Click visual (no audio si no quieren)
        const beat = this._metroBeat;
        const schedTime = this._metroNextTime;

        // Programar beep de metrónomo
        this._scheduleClick(schedTime, beat % 4 === 0);

        // Callback visual
        const delay = (schedTime - this.ctx.currentTime) * 1000;
        setTimeout(() => { if (this._metroCallback) this._metroCallback(beat); }, Math.max(0, delay));

        this._metroBeat++;
        this._metroNextTime += secPerBeat;
      }
    };

    tick();
    this._metroTimer = setInterval(tick, interval);
  }

  stopMetronome() {
    if (this._metroTimer) clearInterval(this._metroTimer);
    this._metroTimer = null;
    this._metroCallback = null;
  }

  _scheduleClick(time, isDownbeat) {
    if (!this.ctx) return;
    const osc  = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.connect(gain);
    gain.connect(this.ctx.destination); // directo, no por el master mix

    osc.frequency.value = isDownbeat ? 1800 : 1200;
    gain.gain.setValueAtTime(0.15, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
    osc.start(time);
    osc.stop(time + 0.05);
  }
}

// ─── Canal de audio individual ────────────────────────────────────────────────
class AudioChannel {
  constructor(ctx, masterGain, id) {
    this.ctx    = ctx;
    this.id     = id;
    this.source = null;
    this._faderValue = 1;
    this._muted = false;
    this._soloed = false;

    // Cadena de nodos: source → inputGain → low → mid → high → comp → pan → fader → analyser → master
    this.inputGain  = ctx.createGain();
    this.lowEQ      = ctx.createBiquadFilter();
    this.midEQ      = ctx.createBiquadFilter();
    this.highEQ     = ctx.createBiquadFilter();
    this.compressor = ctx.createDynamicsCompressor();
    this.panner     = ctx.createStereoPanner();
    this.faderGain  = ctx.createGain();
    this.monitorGain = ctx.createGain(); // 0 para local, 1 para remoto
    this.analyser   = ctx.createAnalyser();

    // Configurar EQ
    this.lowEQ.type  = 'lowshelf';  this.lowEQ.frequency.value  = 100;   this.lowEQ.gain.value  = 0;
    this.midEQ.type  = 'peaking';   this.midEQ.frequency.value  = 1000;  this.midEQ.gain.value  = 0; this.midEQ.Q.value = 1.2;
    this.highEQ.type = 'highshelf'; this.highEQ.frequency.value = 10000; this.highEQ.gain.value = 0;

    // Compresor de canal suave
    this.compressor.threshold.value = -18;
    this.compressor.knee.value      = 10;
    this.compressor.ratio.value     = 3;
    this.compressor.attack.value    = 0.003;
    this.compressor.release.value   = 0.25;

    // Analizador
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.8;

    // Conectar cadena
    this.inputGain
      .connect(this.lowEQ)
      .connect(this.midEQ)
      .connect(this.highEQ)
      .connect(this.compressor)
      .connect(this.panner)
      .connect(this.faderGain)
      .connect(this.analyser)
      .connect(this.monitorGain)
      .connect(masterGain);
  }

  connectStream(mediaStream) {
    if (this.source) { try { this.source.disconnect(); } catch(_){} }
    this.source = this.ctx.createMediaStreamSource(mediaStream);
    this.source.connect(this.inputGain);
  }

  /** Nivel RMS del canal (0–1), útil para VU meter */
  getLevel() {
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(data);
    let sumSq = 0;
    for (let i = 0; i < data.length; i++) {
      const norm = (data[i] - 128) / 128;
      sumSq += norm * norm;
    }
    return Math.sqrt(sumSq / data.length);
  }

  /** Nivel por frecuencias (para visualizador espectral) */
  getFrequencyData() {
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    return data;
  }

  // ── Controles ──────────────────────────────────────────────────────────────
  setInputGain(v)   { this.inputGain.gain.value  = Math.max(0, Math.min(4, v)); }
  setFader(v)       { this._faderValue = v; if (!this._muted) this.faderGain.gain.value = Math.max(0, Math.min(2, v)); }
  setMonitor(v)     { this.monitorGain.gain.value = Math.max(0, Math.min(1, v)); }
  setLow(db)        { this.lowEQ.gain.value  = Math.max(-15, Math.min(15, db)); }
  setMid(db)        { this.midEQ.gain.value  = Math.max(-15, Math.min(15, db)); }
  setHigh(db)       { this.highEQ.gain.value = Math.max(-15, Math.min(15, db)); }
  setMidFreq(hz)    { this.midEQ.frequency.value = hz; }
  setPan(v)         { this.panner.pan.value  = Math.max(-1, Math.min(1, v)); }

  setMute(muted) {
    this._muted = muted;
    this.faderGain.gain.value = muted ? 0 : this._faderValue;
  }

  toggleMute() { this.setMute(!this._muted); return this._muted; }

  /** Activar/desactivar compresor de canal */
  setCompressor(enabled, threshold = -18, ratio = 3) {
    this.compressor.threshold.value = enabled ? threshold : 0;
    this.compressor.ratio.value     = enabled ? ratio     : 1;
  }

  destroy() {
    try { if (this.source) this.source.disconnect(); } catch(_){}
    try { this.inputGain.disconnect(); } catch(_){}
  }
}

window.AudioEngine  = AudioEngine;
window.AudioChannel = AudioChannel;
