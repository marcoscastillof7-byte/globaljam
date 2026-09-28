/**
 * GlobalJam Studio — Aplicación principal
 * Une Audio Engine + WebRTC + MIDI + Socket.io + UI del mixer
 */

// ─── Managers globales ────────────────────────────────────────────────────────
const audioEngine = new AudioEngine();
const realtime    = new RealtimeManager();
const rtcManager  = new RTCManager(realtime);
const midiManager = new MidiManager();

// ─── Estado de la app ─────────────────────────────────────────────────────────
const S = {
  roomId:      null,
  userId:      null,
  userName:    '',
  instrument:  '',
  color:       '',
  hasAudio:    false,
  hasMidi:     false,
  audioMode:   'instrument',  // 'instrument' | 'microphone'
  // Peers: Map<userId, { user, channel:AudioChannel, rtcState }>
  peers:       new Map(),
  // Metrónomo
  metroBpm:    120,
  metroPlaying:false,
  metroBeat:   0,
  // Latencia
  myLatency:   0,
};

// ─── DOM ──────────────────────────────────────────────────────────────────────
const $ = (s, c = document) => c.querySelector(s);
const $$ = (s, c = document) => [...c.querySelectorAll(s)];
const el = (tag, cls, inner = '') => {
  const e = document.createElement(tag);
  if (cls)   e.className = cls;
  if (inner) e.innerHTML = inner;
  return e;
};

// ─── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Inicializar Supabase Realtime con las credenciales de config.js
  const cfg = window.GLOBALJAM_CONFIG || {};
  await realtime.init(cfg.supabaseUrl, cfg.supabaseKey);

  await initSetupScreen();
  initRealtimeEvents();   // ← antes initSocketEvents
  initRTCCallbacks();
  initLatencyPing();
  initVULoop();

  // Autoentrar si hay parámetro ?room=
  const params = new URLSearchParams(location.search);
  if (params.get('room')) {
    $('#room-code-join').value = params.get('room').toUpperCase();
    toast('Pega tu nombre y haz clic en ENTRAR A SALA', '🎸');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  SETUP SCREEN
// ══════════════════════════════════════════════════════════════════════════════

async function initSetupScreen() {
  // Cargar dispositivos de audio
  await loadAudioDevices();
  // Intentar cargar MIDI (puede fallar si el navegador no lo soporta)
  await loadMidiDevices();

  // Test de audio: muestra nivel del micrófono
  $('#audio-device-select').addEventListener('change', async (e) => {
    await testAudioDevice(e.target.value);
  });

  // Botón "Probar audio"
  $('#btn-test-audio').addEventListener('click', async () => {
    await testAudioDevice($('#audio-device-select').value);
  });

  // Botón crear sala
  $('#btn-create-room').addEventListener('click', () => {
    const name = $('#room-name-input').value.trim() || 'Mi Jam Session';
    realtime.send('create_room', { name });
  });

  // Botón entrar a sala
  $('#btn-join-room').addEventListener('click', () => joinFromSetup());
  $('#room-code-join').addEventListener('keydown', e => { if (e.key === 'Enter') joinFromSetup(); });
}

async function loadAudioDevices() {
  const sel = $('#audio-device-select');
  sel.innerHTML = '<option value="">Sin audio (solo escuchar)</option>';
  try {
    const devices = await audioEngine.getAudioInputDevices();
    devices.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id; opt.textContent = d.label;
      sel.appendChild(opt);
    });
    if (devices.length > 0) {
      setDeviceStatus('audio', 'ok');
      toast(`${devices.length} dispositivo(s) de audio encontrado(s)`, '🎙');
    }
  } catch(e) {
    setDeviceStatus('audio', 'err');
    toast('No se pudo acceder al audio: ' + e.message, '⚠️');
  }
}

async function loadMidiDevices() {
  const list = $('#midi-device-list');
  try {
    await midiManager.init();
    const inputs = midiManager.getInputs();
    renderMidiDeviceList(inputs);

    midiManager.onDeviceChange = () => {
      renderMidiDeviceList(midiManager.getInputs());
    };

    if (inputs.length > 0) toast(`${inputs.length} dispositivo(s) MIDI encontrado(s)`, '🎹');
    else list.innerHTML = '<div class="no-midi">No hay dispositivos MIDI conectados</div>';
  } catch(e) {
    list.innerHTML = `<div class="no-midi">⚠️ ${e.message}</div>`;
  }
}

function renderMidiDeviceList(inputs) {
  const list = $('#midi-device-list');
  if (!inputs.length) {
    list.innerHTML = '<div class="no-midi">Sin dispositivos MIDI</div>';
    return;
  }
  list.innerHTML = '';
  inputs.forEach(input => {
    const item = el('div', `midi-device-item${midiManager.selectedInputId === input.id ? ' selected' : ''}`);
    item.innerHTML = `
      <div>
        <div class="midi-device-name">${esc(input.name)}</div>
        <div class="midi-device-type">${esc(input.manufacturer || 'MIDI Input')}</div>
      </div>
      <div class="midi-state-dot ${input.state === 'connected' ? 'connected' : ''}"></div>
    `;
    item.addEventListener('click', () => {
      $$('.midi-device-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      midiManager.selectInput(input.id);
      S.hasMidi = true;
      toast(`MIDI: ${input.name}`, '🎹');
    });
    list.appendChild(item);
  });
}

let testStream = null;
let testVuInterval = null;

async function testAudioDevice(deviceId) {
  // Detener test anterior
  if (testStream) { testStream.getTracks().forEach(t => t.stop()); testStream = null; }
  if (testVuInterval) { clearInterval(testVuInterval); testVuInterval = null; }

  const fill = $('#vu-test-fill');
  const statusDot = $('#audio-status-dot');

  if (!deviceId) {
    fill.style.width = '0%';
    setDeviceStatus('audio', 'off');
    return;
  }

  try {
    await audioEngine.init();
    const isMic = S.audioMode === 'microphone';
    const constraints = {
      audio: {
        deviceId:          { exact: deviceId },
        echoCancellation:  isMic,
        noiseSuppression:  isMic,
        autoGainControl:   isMic,
      }
    };
    try {
      testStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch(err) {
      constraints.audio.deviceId = undefined; // Fallback
      testStream = await navigator.mediaDevices.getUserMedia(constraints);
    }

    // Monitorear nivel
    const tmpCtx  = new AudioContext();
    const src      = tmpCtx.createMediaStreamSource(testStream);
    const analyser = tmpCtx.createAnalyser();
    analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.8;
    src.connect(analyser);

    setDeviceStatus('audio', 'ok');
    const hint = isMic ? 'Habla para ver el nivel' : 'Toca tu instrumento para ver el nivel';
    toast(`Dispositivo activo — ${hint}`, '🎙');
    const vuHint = $('#vu-hint');
    if (vuHint) vuHint.textContent = hint + ' ↑';

    testVuInterval = setInterval(() => {
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(data);
      let rms = 0;
      for (const v of data) { const n = (v - 128)/128; rms += n*n; }
      rms = Math.sqrt(rms / data.length);
      fill.style.width = Math.min(100, rms * 400) + '%';
    }, 50);
  } catch(e) {
    setDeviceStatus('audio', 'err');
    toast('Error al acceder al dispositivo: ' + e.message, '❌');
  }
}

function setDeviceStatus(type, status) {
  const dot = $(`#${type}-status-dot`);
  if (!dot) return;
  dot.className = `device-status ${status === 'ok' ? 'ok' : status === 'err' ? 'err' : ''}`;
}

async function joinFromSetup() {
  const code = $('#room-code-join').value.trim().toUpperCase();
  if (!code) { toast('Ingresa un código de sala', '⚠️'); return; }

  S.userName   = $('#user-name').value.trim() || `Músico-${Math.floor(Math.random()*1000)}`;
  S.instrument = $('#user-instrument').value;
  S.color      = $('#user-color').value;
  S.hasMidi    = !!midiManager.selectedInputId;

  // Capturar audio si se eligió dispositivo
  const deviceId = $('#audio-device-select').value;
  if (deviceId) {
    try {
      // Pasar el modo seleccionado: 'microphone' o 'instrument'
      await audioEngine.captureLocalAudio(deviceId, S.audioMode || 'instrument');
      rtcManager.setLocalStream(audioEngine.localStream);
      S.hasAudio = true;
      const modeLabel = S.audioMode === 'microphone' ? 'micrófono' : 'instrumento';
      toast(`Audio (${modeLabel}) capturado. Conectando…`, '🎙');
    } catch(e) {
      toast('No se pudo capturar audio: ' + e.message, '⚠️');
      S.hasAudio = false;
    }
  } else {
    S.hasAudio = false;
  }

  // Detener test stream
  if (testStream) { testStream.getTracks().forEach(t => t.stop()); testStream = null; }
  if (testVuInterval) { clearInterval(testVuInterval); testVuInterval = null; }

  realtime.send('join_room', {
    roomId: code,
    userName:   S.userName,
    instrument: S.instrument,
    color:      S.color,
    hasAudio:   S.hasAudio,
    hasMidi:    S.hasMidi,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  REALTIME EVENTS (Supabase Realtime — reemplaza Socket.io)
// ══════════════════════════════════════════════════════════════════════════════

function initRealtimeEvents() {
  realtime.on('connect', () => {
    S.userId = realtime.userId;
    setConnDot(true);
  });

  realtime.on('room_list', rooms => renderRoomList(rooms));

  realtime.on('room_created', ({ roomId }) => {
    $('#room-code-join').value = roomId;
    toast(`Sala creada: ${roomId} — ahora haz clic en ENTRAR`, '🎉');
  });

  realtime.on('error', ({ msg }) => toast(msg, '❌'));

  realtime.on('joined_room', ({ room, user, peers, chatHistory }) => {
    S.roomId = room.id;
    S.userId = realtime.userId;

    // Inicializar MIDI callback ahora que estamos en sala
    midiManager.onMessage = ({ data, parsed, deviceName }) => {
      appendMidiLog(parsed.label, true);
      realtime.send('midi_event', { data, deviceName });
      flashMidiDot();
    };

    showStudio(room, user);
    renderOwnChannel(user);

    // Por cada peer existente: iniciamos oferta WebRTC (nosotros somos el que llega)
    peers.forEach(peer => {
      addPeerToMixer(peer);
      rtcManager.initiateOffer(peer.id);
    });

    renderLeftPanelMusicians([user, ...peers]);
    updateDeviceInfoPanel();
    toast(`¡Entraste a ${room.name}!`, '🎸');

    // Cargar historial de chat desde la BD de Supabase
    if (chatHistory && chatHistory.length > 0) {
      chatHistory.forEach(msg => {
        appendChat({ from: msg.user_name, color: msg.user_color, text: msg.text, self: false });
      });
      appendChatSystem('— historial cargado —');
    }
  });

  realtime.on('peer_joined', ({ user }) => {
    addPeerToMixer(user);
    renderLeftPanelMusicians(getAllUsers());
    toast(`${user.name} se conectó con ${user.instrument}`, '🎸');
    appendChatSystem(`${user.name} entró a la sala`);
  });

  realtime.on('peer_left', ({ userId }) => {
    const peer = S.peers.get(userId);
    if (peer) toast(`${peer.user.name} salió`, '👋');
    rtcManager.removePeer(userId);
    audioEngine.removeChannel(userId);
    S.peers.delete(userId);
    removePeerChannel(userId);
    renderLeftPanelMusicians(getAllUsers());
  });

  realtime.on('user_updated', user => {
    if (S.peers.has(user.id)) {
      S.peers.get(user.id).user = user;
      updateChannelHeader(user.id, user);
    }
    renderLeftPanelMusicians(getAllUsers());
  });

  realtime.on('user_latency', ({ userId, latency }) => {
    const peer = S.peers.get(userId);
    if (peer) peer.user.latency = latency;
    const latEl = $(`.musician-item[data-uid="${userId}"] .musician-lat`);
    if (latEl) latEl.textContent = `${latency}ms`;
  });

  // ── MIDI remoto ───────────────────────────────────────────────────────────────
  realtime.on('midi_event', ({ from, userName, color, data, deviceName }) => {
    if (from === realtime.userId) return; // Ignorar el nuestro (self=false en Supabase)
    const parsed = midiManager.parse(data);
    const label = `${userName}: ${parsed.label}`;
    appendMidiLog(label, false);
    flashMidiDot();
  });

  // ── Metrónomo ─────────────────────────────────────────────────────────────────
  realtime.on('metronome_update', ({ bpm, isPlaying }) => {
    S.metroBpm     = bpm;
    S.metroPlaying = isPlaying;
    updateBpmDisplay(bpm);
    if (isPlaying) startMetronomeLocal(bpm);
    else           stopMetronomeLocal();
  });

  // ── Chat ──────────────────────────────────────────────────────────────────────
  realtime.on('chat_message', ({ from, color, text }) => {
    appendChat({ from, color, text, self: false });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  WebRTC CALLBACKS
// ══════════════════════════════════════════════════════════════════════════════

function initRTCCallbacks() {
  rtcManager.onRemoteStream = (peerId, stream) => {
    // Crear canal en el motor de audio
    const ch = audioEngine.addRemoteChannel(peerId, stream);
    if (S.peers.has(peerId)) S.peers.get(peerId).channel = ch;
    toast(`Audio de ${S.peers.get(peerId)?.user.name || peerId} recibido`, '🔊');
  };

  rtcManager.onStateChange = (peerId, state) => {
    updateChannelRTCState(peerId, state);
  };

  rtcManager.onPeerConnected = (peerId) => {
    const peer = S.peers.get(peerId);
    toast(`Conexión directa con ${peer?.user.name || peerId} ✓`, '⚡');
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  STUDIO SCREEN
// ══════════════════════════════════════════════════════════════════════════════

function showStudio(room, user) {
  $('#setup-screen').classList.add('hidden');
  $('#studio-screen').classList.remove('hidden');
  $('#header-room-name').textContent = room.name;
  $('#header-room-code').textContent = room.id;
  $('#share-link-hidden').textContent = `${location.origin}?room=${room.id}`;
  updateBpmDisplay(room.metronome?.bpm || 120);
}

// ── Canal del propio usuario ──────────────────────────────────────────────────
function renderOwnChannel(user) {
  const wrap = $('#channels-container');
  wrap.innerHTML = '';  // limpiar

  const strip = buildChannelStrip({
    id:      'local',
    user,
    isLocal: true,
  });
  wrap.appendChild(strip);

  // Separador master
  const sep = el('div', 'master-separator');
  wrap.appendChild(sep);

  // Canal master
  const master = buildMasterStrip();
  wrap.appendChild(master);
}

// ── Agregar canal de un peer ──────────────────────────────────────────────────
function addPeerToMixer(user) {
  S.peers.set(user.id, { user, channel: null, rtcState: 'new' });

  // Insertar antes del separador master
  const sep = $('.master-separator', $('#channels-container'));
  const strip = buildChannelStrip({ id: user.id, user, isLocal: false });
  $('#channels-container').insertBefore(strip, sep);
}

function removePeerChannel(userId) {
  const el = $(`[data-peer="${userId}"]`);
  if (el) el.remove();
}

// ── Construir channel strip ────────────────────────────────────────────────────
function buildChannelStrip({ id, user, isLocal }) {
  const strip = el('div', `channel-strip ${isLocal ? 'is-local' : ''}`);
  strip.dataset.peer = id;

  const connState = isLocal ? '' : 'connecting';

  strip.innerHTML = `
    <!-- Header -->
    <div class="ch-header">
      <div class="ch-color-dot" style="background:${user.color}"></div>
      <div style="flex:1;min-width:0;">
        <div class="ch-name">${esc(user.name)}${isLocal ? ' ★' : ''}</div>
        <div class="ch-inst">${esc(user.instrument)}</div>
      </div>
      ${!isLocal ? `<div class="ch-connection connecting" data-conn="${id}">…</div>` : ''}
    </div>

    <!-- VU Meter (L + R) -->
    <div class="ch-vu" data-vu="${id}">
      <div class="vu-bar-wrap" data-vu-bar="L">
        ${buildVuSegments()}
      </div>
      <div class="vu-bar-wrap" data-vu-bar="R">
        ${buildVuSegments()}
      </div>
    </div>

    <!-- Input Gain -->
    <div class="ch-gain">
      <span class="gain-label">GAIN</span>
      <input type="range" class="gain-slider" min="0" max="3" step="0.01" value="1"
             title="Ganancia de entrada"
             oninput="onGainChange('${id}', this.value)">
    </div>

    <!-- EQ 3 bandas -->
    <div class="ch-eq">
      <div class="eq-row">
        <span class="eq-label">HI</span>
        <div class="eq-knob"><input type="range" min="-12" max="12" step=".5" value="0"
          oninput="onEQChange('${id}','high',this.value);this.closest('.eq-row').querySelector('.eq-value').textContent=numSign(this.value)+'dB'">
        </div>
        <span class="eq-value">0dB</span>
      </div>
      <div class="eq-row">
        <span class="eq-label">MID</span>
        <div class="eq-knob"><input type="range" min="-12" max="12" step=".5" value="0"
          oninput="onEQChange('${id}','mid',this.value);this.closest('.eq-row').querySelector('.eq-value').textContent=numSign(this.value)+'dB'">
        </div>
        <span class="eq-value">0dB</span>
      </div>
      <div class="eq-row">
        <span class="eq-label">LO</span>
        <div class="eq-knob"><input type="range" min="-12" max="12" step=".5" value="0"
          oninput="onEQChange('${id}','low',this.value);this.closest('.eq-row').querySelector('.eq-value').textContent=numSign(this.value)+'dB'">
        </div>
        <span class="eq-value">0dB</span>
      </div>
    </div>

    <!-- Pan -->
    <div class="ch-pan">
      <span class="pan-label">PAN</span>
      <input type="range" class="pan-slider" min="-1" max="1" step=".01" value="0"
             oninput="onPanChange('${id}', this.value)">
      <span class="pan-value">C</span>
    </div>

    <!-- Compresor GR -->
    <div class="ch-comp-led">
      <span class="comp-label">COMP</span>
      <div class="comp-meter"><div class="comp-meter-fill" data-comp="${id}"></div></div>
    </div>

    <!-- Fader -->
    <div class="ch-fader">
      <div class="fader-marks">
        <span class="fader-mark">+6</span>
        <span class="fader-mark">0</span>
        <span class="fader-mark">-6</span>
        <span class="fader-mark">-∞</span>
      </div>
      <div class="fader-track">
        <input type="range" class="fader-input" min="0" max="1.5" step="0.01" value="1"
               oninput="onFaderChange('${id}', this.value)">
      </div>
      <div class="fader-value" data-fader-val="${id}">0 dB</div>
    </div>

    <!-- Mute / Solo -->
    <div class="ch-buttons">
      <button class="btn-mute" data-mute="${id}" onclick="onMute('${id}', this)">M</button>
      <button class="btn-solo" data-solo="${id}" onclick="onSolo('${id}', this)">S</button>
    </div>

    ${isLocal ? `
    <!-- Monitor (solo canal local) -->
    <div class="ch-monitor">
      <span class="monitor-label">MONITOR</span>
      <label class="toggle-switch">
        <input type="checkbox" id="monitor-toggle" onchange="onMonitorChange(this.checked)">
        <span class="toggle-slider"></span>
      </label>
    </div>` : ''}
  `;

  return strip;
}

function buildVuSegments() {
  // 12 segmentos: 7 green, 3 yellow, 1 orange, 1 red (de abajo hacia arriba)
  const segs = [
    ...Array(7).fill('green'),
    ...Array(3).fill('yellow'),
    'orange',
    'red',
  ].reverse(); // top → bottom en HTML, pero scaleY desde abajo

  return segs.map(c => `<div class="vu-segment ${c}"></div>`).join('');
}

function buildMasterStrip() {
  const strip = el('div', 'channel-strip is-master');
  strip.dataset.peer = 'master';
  strip.innerHTML = `
    <div class="ch-header">
      <div style="flex:1;text-align:center;">
        <div class="ch-name" style="text-align:center;">MASTER</div>
        <div class="ch-inst">Salida principal</div>
      </div>
    </div>
    <div class="ch-vu" data-vu="master">
      <div class="vu-bar-wrap" data-vu-bar="L">${buildVuSegments()}</div>
      <div class="vu-bar-wrap" data-vu-bar="R">${buildVuSegments()}</div>
    </div>
    <div class="ch-fader">
      <div class="fader-marks">
        <span class="fader-mark">+6</span>
        <span class="fader-mark">0</span>
        <span class="fader-mark">-∞</span>
      </div>
      <div class="fader-track">
        <input type="range" class="fader-input" min="0" max="1.5" step="0.01" value="0.9"
               oninput="audioEngine.setMasterGain(parseFloat(this.value))">
      </div>
    </div>
  `;
  return strip;
}

// ─── Callbacks de controles de canal ──────────────────────────────────────────
function getChannel(id) {
  if (id === 'local') return audioEngine.getLocalChannel();
  return audioEngine.getChannel(id);
}

function onGainChange(id, value) {
  const ch = getChannel(id);
  if (ch) ch.setInputGain(parseFloat(value));
  realtime.send('channel_update', { type: 'gain', value });
}

function onEQChange(id, band, value) {
  const ch = getChannel(id); if (!ch) return;
  const v = parseFloat(value);
  if (band === 'high') ch.setHigh(v);
  if (band === 'mid')  ch.setMid(v);
  if (band === 'low')  ch.setLow(v);
}

function onPanChange(id, value) {
  const ch = getChannel(id); if (!ch) return;
  const v = parseFloat(value);
  ch.setPan(v);
  const el = $(`.ch-pan .pan-value`, $(`[data-peer="${id}"]`));
  if (el) el.textContent = v === 0 ? 'C' : v > 0 ? `R${Math.round(v*100)}` : `L${Math.round(-v*100)}`;
}

function onFaderChange(id, value) {
  const ch = getChannel(id); if (!ch) return;
  const v = parseFloat(value);
  ch.setFader(v);
  const db = v === 0 ? '-∞' : (20 * Math.log10(v)).toFixed(1) + ' dB';
  const valEl = $(`[data-fader-val="${id}"]`);
  if (valEl) valEl.textContent = db;
}

function onMute(id, btn) {
  const ch = getChannel(id); if (!ch) return;
  const muted = ch.toggleMute();
  btn.classList.toggle('active', muted);
}

function onSolo(id, btn) {
  const isActive = btn.classList.toggle('active');
  // Solo: silenciar todo excepto este canal
  const allIds = ['local', ...S.peers.keys()];
  allIds.forEach(uid => {
    const ch = getChannel(uid);
    if (!ch) return;
    if (isActive) {
      ch.setMute(uid !== id);
    } else {
      ch.setMute(false);
    }
  });
  // Si des-solo, resetear mutes de todos
  if (!isActive) $$('.btn-mute.active').forEach(b => b.classList.remove('active'));
}

function onMonitorChange(enabled) {
  const ch = audioEngine.getLocalChannel();
  if (ch) ch.setMonitor(enabled ? 0.7 : 0);
}

// ─── VU Meter loop ────────────────────────────────────────────────────────────
function initVULoop() {
  const SEGMENTS = 12;

  function updateVU(peerId, level) {
    const vuEl = $(`[data-vu="${peerId}"]`);
    if (!vuEl) return;
    const lit = Math.round(level * SEGMENTS * 3);  // 3x para sensibilidad
    vuEl.querySelectorAll('.vu-bar-wrap').forEach(bar => {
      const segs = [...bar.querySelectorAll('.vu-segment')].reverse(); // bottom→top
      segs.forEach((seg, i) => seg.classList.toggle('lit', i < lit));
    });
  }

  function loop() {
    requestAnimationFrame(loop);

    // Local
    const localCh = audioEngine.getLocalChannel();
    if (localCh) updateVU('local', localCh.getLevel());

    // Peers
    S.peers.forEach((peer, uid) => {
      const ch = audioEngine.getChannel(uid);
      if (ch) {
        const lv = ch.getLevel();
        updateVU(uid, lv);
        // Speaking indicator
        const strip = $(`[data-peer="${uid}"]`);
        if (strip) strip.classList.toggle('is-speaking', lv > 0.02);
      }
    });
  }
  loop();
}

// ─── Actualizar estado WebRTC en UI ───────────────────────────────────────────
function updateChannelRTCState(peerId, state) {
  const connEl = $(`[data-conn="${peerId}"]`);
  if (!connEl) return;
  const labels = {
    new:          ['…',    'connecting'],
    connecting:   ['⏳',   'connecting'],
    connected:    ['🔗',   ''],
    disconnected: ['⚠',   'failed'],
    failed:       ['✗',   'failed'],
    closed:       ['✗',   'failed'],
  };
  const [text, cls] = labels[state] || ['?', ''];
  connEl.textContent  = text;
  connEl.className    = `ch-connection ${cls}`;
}

function updateChannelHeader(peerId, user) {
  const strip = $(`[data-peer="${peerId}"]`);
  if (!strip) return;
  const nameEl = strip.querySelector('.ch-name');
  const instEl = strip.querySelector('.ch-inst');
  const dot    = strip.querySelector('.ch-color-dot');
  if (nameEl) nameEl.textContent = user.name;
  if (instEl) instEl.textContent = user.instrument;
  if (dot)    dot.style.background = user.color;
}

// ─── Panel izquierdo: músicos ──────────────────────────────────────────────────
function renderLeftPanelMusicians(users) {
  const list = $('#musicians-list');
  if (!list) return;
  list.innerHTML = '';
  users.forEach(user => {
    const item = el('div', `musician-item${user.id === S.userId ? ' me' : ''}`);
    item.dataset.uid = user.id;
    item.innerHTML = `
      <div class="musician-avatar" style="background:${user.color}">${esc(user.name.slice(0,2).toUpperCase())}</div>
      <div class="musician-meta">
        <div class="musician-name">${esc(user.name)}${user.id === S.userId ? ' ★' : ''}</div>
        <div class="musician-inst">${esc(user.instrument)}</div>
        <div class="musician-lat">${user.latency || 0}ms</div>
      </div>
    `;
    list.appendChild(item);
  });
}

function updateDeviceInfoPanel() {
  const panel = $('#device-info-panel');
  if (!panel) return;
  const audioDev = $('#audio-device-select');
  const audioLabel = audioDev ? audioDev.options[audioDev.selectedIndex]?.text : '—';
  const midiLabel = midiManager.selectedInputId
    ? midiManager.getInputs().find(i => i.id === midiManager.selectedInputId)?.name || '—'
    : '—';

  panel.innerHTML = `
    <div class="device-info-item">
      <div class="device-label">🎙 Entrada de audio</div>
      <div class="device-name">${S.hasAudio ? esc(audioLabel) : 'Sin audio'}</div>
    </div>
    <div class="device-info-item">
      <div class="device-label">🎹 Dispositivo MIDI</div>
      <div class="device-name">${S.hasMidi ? esc(midiLabel) : 'Sin MIDI'}</div>
    </div>
  `;
}

// ─── Metrónomo ────────────────────────────────────────────────────────────────
function startMetronomeLocal(bpm) {
  S.metroPlaying = true;
  S.metroBeat    = 0;
  audioEngine.startMetronome(bpm, (beat) => {
    S.metroBeat = beat;
    updateBeatDots(beat % 4);
  });
}

function stopMetronomeLocal() {
  S.metroPlaying = false;
  audioEngine.stopMetronome();
  $$('.beat-dot').forEach(d => { d.classList.remove('down','up'); });
}

function updateBeatDots(beat) {
  $$('.beat-dot').forEach((d, i) => {
    d.classList.toggle('down', i === beat);
    d.classList.toggle('up',   i !== beat);
  });
}

window.transportMetro = {
  toggle() {
    audioEngine.init();
    const newState = !S.metroPlaying;
    realtime.send('set_metronome', { bpm: S.metroBpm, isPlaying: newState });
  },
  bpmUp()   { changeBpm(S.metroBpm + 1); },
  bpmDown() { changeBpm(S.metroBpm - 1); },
  bpmSet(v) { changeBpm(parseInt(v)); },
};

function changeBpm(bpm) {
  bpm = Math.max(20, Math.min(300, bpm));
  realtime.send('set_metronome', { bpm, isPlaying: S.metroPlaying });
}

function updateBpmDisplay(bpm) {
  S.metroBpm = bpm;
  const el = $('#bpm-val');
  if (el) el.textContent = bpm;
  const slider = $('#bpm-slider');
  if (slider) slider.value = bpm;
}

// ─── Latencia ─────────────────────────────────────────────────────────────────
function initLatencyPing() {
  setInterval(() => {
    if (realtime.connected) {
      const t = Date.now();
      realtime.send('ping', { t });
      realtime.once('pong', ({ t: sent }) => {
        const rtt = Date.now() - sent;
        S.myLatency = Math.round(rtt / 2);
        updateLatencyBadge(S.myLatency);
        realtime.send('report_latency', { latency: S.myLatency });
      });
    }
  }, 3000);
}

function updateLatencyBadge(ms) {
  const badge = $('#latency-badge');
  if (!badge) return;
  badge.textContent = `${ms}ms`;
  badge.style.color = ms < 60 ? 'var(--green)' : ms < 150 ? 'var(--yellow)' : 'var(--red)';
  badge.style.borderColor = badge.style.color;
  badge.style.background  = ms < 60 ? 'rgba(34,197,94,.1)' : ms < 150 ? 'rgba(251,191,36,.1)' : 'rgba(239,68,68,.1)';
}

// ─── MIDI log ─────────────────────────────────────────────────────────────────
function appendMidiLog(text, isLocal) {
  const list = $('#midi-log-list');
  if (!list) return;
  const item = el('div', `midi-log-item ${isLocal ? 'local' : 'remote'}`);
  item.textContent = text;
  list.appendChild(item);
  // Mantener máx 60 líneas
  while (list.children.length > 60) list.removeChild(list.firstChild);
  list.scrollTop = list.scrollHeight;
}

function flashMidiDot() {
  const dot = $('#midi-active-dot');
  if (!dot) return;
  dot.classList.add('flash');
  setTimeout(() => dot.classList.remove('flash'), 200);
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
function initChatInput() {
  const inp = $('#chat-input'), btn = $('#chat-send');
  if (!inp) return;
  const send = () => {
    const t = inp.value.trim(); if (!t) return;
    appendChat({ from: S.userName, color: S.color, text: t, self: true });
    realtime.send('chat_message', { text: t });
    inp.value = '';
  };
  btn?.addEventListener('click', send);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
}

function appendChat({ from, color, text, self }) {
  const msgs = $('#chat-messages');
  if (!msgs) return;
  const msg = el('div', `chat-msg${self ? ' self' : ''}`);
  msg.innerHTML = `<div class="chat-msg-name" style="color:${color||'var(--accent2)'}">${esc(from)}</div>
                   <div class="chat-msg-text">${esc(text)}</div>`;
  msgs.appendChild(msg);
  msgs.scrollTop = msgs.scrollHeight;
}

function appendChatSystem(text) {
  const msgs = $('#chat-messages');
  if (!msgs) return;
  const msg = el('div', 'chat-msg');
  msg.innerHTML = `<div class="chat-msg-text" style="background:transparent;color:var(--text-muted);font-size:.72rem;font-style:italic;">★ ${esc(text)}</div>`;
  msgs.appendChild(msg);
  msgs.scrollTop = msgs.scrollHeight;
}

// ─── Utilidades ───────────────────────────────────────────────────────────────
function toast(msg, icon = '') {
  const c = $('#toasts'); if (!c) return;
  const t = el('div', 'toast');
  t.textContent = `${icon} ${msg}`;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function setConnDot(ok) {
  const d = $('#conn-dot'); if (d) d.className = `conn-dot ${ok ? 'ok' : ''}`;
}

window.copyCode = () => {
  const code = $('#header-room-code')?.textContent;
  if (code) navigator.clipboard.writeText(code).then(() => toast('Código copiado', '📋'));
};

window.copyLink = () => {
  const link = $('#share-link-hidden')?.textContent;
  if (link) navigator.clipboard.writeText(link).then(() => toast('Link copiado', '🔗'));
};

window.leaveRoom = () => {
  if (!confirm('¿Salir de la sala?')) return;
  rtcManager.removeAllPeers();
  audioEngine.localStream?.getTracks().forEach(t => t.stop());
  S.peers.clear();
  S.roomId = null;
  $('#studio-screen').classList.add('hidden');
  $('#setup-screen').classList.remove('hidden');
  realtime.leaveRoom();
  
  
};

function getAllUsers() {
  const me = { id: S.userId, name: S.userName, instrument: S.instrument, color: S.color, latency: S.myLatency };
  return [me, ...[...S.peers.values()].map(p => p.user)];
}

function renderRoomList(rooms) {
  const c = $('#rooms-list');
  if (!c) return;
  if (!rooms.length) { c.innerHTML = '<div class="no-midi">No hay salas activas</div>'; return; }
  c.innerHTML = '';
  rooms.forEach(r => {
    const item = el('div', 'room-item');
    item.innerHTML = `
      <div>
        <div class="room-item-name">${esc(r.name)}</div>
        <div class="room-item-meta">🎙 ${r.userCount} músico(s) conectado(s)</div>
      </div>
      <div class="room-badge">${r.id}</div>
    `;
    item.addEventListener('click', () => {
      $('#room-code-join').value = r.id;
    });
    c.appendChild(item);
  });
}

function numSign(v) { return parseFloat(v) >= 0 ? '+' + parseFloat(v).toFixed(1) : parseFloat(v).toFixed(1); }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ─── Selector de modo de audio ────────────────────────────────────────────────
/**
 * Cambia entre modo micrófono (con EC/NS) e instrumento (sin filtros).
 * Llamado desde los botones del HTML.
 */
window.setAudioMode = function(mode) {
  S.audioMode = mode;
  const isMic  = mode === 'microphone';

  // Actualizar botones
  const micBtn  = document.getElementById('mode-mic-btn');
  const instBtn = document.getElementById('mode-inst-btn');
  const hint    = document.getElementById('mode-hint');

  if (micBtn && instBtn) {
    // Micrófono activo
    micBtn.style.border     = isMic ? '2px solid var(--accent)' : '2px solid var(--border)';
    micBtn.style.background = isMic ? 'rgba(99,102,241,.15)' : 'var(--strip)';
    micBtn.style.color      = isMic ? 'var(--accent2)' : 'var(--text-dim)';

    // Instrumento activo
    instBtn.style.border     = !isMic ? '2px solid var(--accent)' : '2px solid var(--border)';
    instBtn.style.background = !isMic ? 'rgba(99,102,241,.15)' : 'var(--strip)';
    instBtn.style.color      = !isMic ? 'var(--accent2)' : 'var(--text-dim)';
  }

  if (hint) {
    hint.innerHTML = isMic
      ? '🎤 <strong>Modo micrófono:</strong> Con cancelación de eco y reducción de ruido — ideal para voz, rap, canto.'
      : '🎸 <strong>Modo instrumento:</strong> Sin cancelación de eco ni reducción de ruido — audio fiel de guitarra, bajo, teclado, etc.';
  }

  // Si ya hay un stream de prueba activo, reiniciarlo con el nuevo modo
  const deviceId = document.getElementById('audio-device-select')?.value;
  if (deviceId && testStream) {
    testAudioDevice(deviceId);
  }
};

// ─── Atajos de teclado ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (!S.roomId) return;
  if (e.key === ' ') { e.preventDefault(); transportMetro.toggle(); }
  if (e.key === 'ArrowUp')   transportMetro.bpmUp();
  if (e.key === 'ArrowDown') transportMetro.bpmDown();
});

// ─── Inicializar chat una vez cargado ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(initChatInput, 100);
});
