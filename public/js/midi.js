/**
 * GlobalJam Studio — Gestor MIDI
 *
 * Accede a todos los dispositivos MIDI conectados al computador
 * (teclados MIDI, controladores, cajas de ritmo, sintetizadores, etc.)
 * a través de la Web MIDI API.
 *
 * Funcionalidades:
 *  - Enumerar entradas/salidas MIDI
 *  - Seleccionar qué dispositivo enviar a la sala
 *  - Parsear mensajes MIDI en formato legible
 *  - Callback onMessage para integrar con la app
 */

class MidiManager {
  constructor() {
    this.access         = null;
    this.selectedInputId  = null;
    this.selectedOutputId = null;
    this._handlers      = new Map(); // inputId → handler fn

    // Callbacks externos
    this.onMessage      = null; // ({ data, parsed, deviceName }) → void
    this.onDeviceChange = null; // () → void
  }

  /** Solicitar acceso MIDI al navegador */
  async init() {
    if (!navigator.requestMIDIAccess) {
      throw new Error('Web MIDI API no soportada en este navegador. Usa Chrome o Edge.');
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.access.onstatechange = () => {
        if (this.onDeviceChange) this.onDeviceChange();
      };
      return true;
    } catch(e) {
      throw new Error(`Permiso MIDI denegado: ${e.message}`);
    }
  }

  /** Lista de entradas MIDI disponibles */
  getInputs() {
    if (!this.access) return [];
    return [...this.access.inputs.values()].map(i => ({
      id:           i.id,
      name:         i.name,
      manufacturer: i.manufacturer,
      state:        i.state,
      connection:   i.connection,
    }));
  }

  /** Lista de salidas MIDI disponibles */
  getOutputs() {
    if (!this.access) return [];
    return [...this.access.outputs.values()].map(o => ({
      id:           o.id,
      name:         o.name,
      manufacturer: o.manufacturer,
    }));
  }

  /** Seleccionar entrada MIDI a escuchar */
  selectInput(inputId) {
    // Desconectar anterior
    if (this.selectedInputId) {
      const prev = this.access?.inputs.get(this.selectedInputId);
      if (prev) prev.onmidimessage = null;
    }

    this.selectedInputId = inputId;
    if (!inputId) return;

    const input = this.access?.inputs.get(inputId);
    if (!input) { console.warn(`MIDI input ${inputId} no encontrado`); return; }

    input.onmidimessage = (event) => {
      const data   = Array.from(event.data);
      const parsed = this.parse(data);
      if (this.onMessage) this.onMessage({ data, parsed, deviceName: input.name, inputId });
    };

    console.log(`[MIDI] Escuchando: ${input.name}`);
  }

  /** Seleccionar salida MIDI */
  selectOutput(outputId) {
    this.selectedOutputId = outputId;
  }

  /** Enviar mensaje MIDI por la salida seleccionada */
  send(data) {
    if (!this.selectedOutputId || !this.access) return;
    const output = this.access.outputs.get(this.selectedOutputId);
    if (output) output.send(data);
  }

  /** Enviar nota a la salida seleccionada */
  sendNote(note, velocity = 100, channel = 0, duration = 0) {
    const ch = channel & 0x0F;
    this.send([0x90 | ch, note & 0x7F, velocity & 0x7F]);
    if (duration > 0) {
      setTimeout(() => this.send([0x80 | ch, note & 0x7F, 0]), duration);
    }
  }

  // ── Parser de mensajes MIDI ────────────────────────────────────────────────
  parse(data) {
    if (!data || data.length === 0) return { type: 'empty' };

    const status  = data[0];
    const type    = status & 0xF0;
    const channel = (status & 0x0F) + 1; // 1-indexed

    // Mensajes de sistema (sin canal)
    if (status >= 0xF0) {
      switch(status) {
        case 0xF8: return { type: 'clock',     label: '⏱ Clock' };
        case 0xFA: return { type: 'start',     label: '▶ Start' };
        case 0xFB: return { type: 'continue',  label: '▶▶ Continue' };
        case 0xFC: return { type: 'stop',      label: '⏹ Stop' };
        case 0xFE: return { type: 'activeSense',label: 'Active Sense' };
        case 0xFF: return { type: 'reset',     label: '🔄 Reset' };
        default:   return { type: 'sysex',     label: 'SysEx', data };
      }
    }

    switch(type) {
      case 0x90:
        if (data[2] === 0) return { type:'noteOff', channel, note: data[1], velocity: 0, label: `🎵 Note Off  ${this.noteName(data[1])} ch${channel}` };
        return { type:'noteOn',  channel, note: data[1], velocity: data[2], noteName: this.noteName(data[1]),
                 label: `🎵 Note On   ${this.noteName(data[1])} vel:${data[2]} ch${channel}` };
      case 0x80:
        return { type:'noteOff', channel, note: data[1], velocity: data[2],
                 label: `🎵 Note Off  ${this.noteName(data[1])} ch${channel}` };
      case 0xB0:
        return { type:'cc', channel, controller: data[1], value: data[2],
                 ccName: CC_NAMES[data[1]] || `CC${data[1]}`,
                 label: `🎛 CC${data[1]} (${CC_NAMES[data[1]]||''}) → ${data[2]} ch${channel}` };
      case 0xE0: {
        const bend = ((data[2] << 7) | data[1]) - 8192;
        return { type:'pitchBend', channel, value: bend,
                 label: `🎚 PitchBend ${bend >= 0 ? '+' : ''}${bend} ch${channel}` };
      }
      case 0xC0:
        return { type:'programChange', channel, program: data[1],
                 label: `🎹 Program ${data[1]} ch${channel}` };
      case 0xD0:
        return { type:'channelPressure', channel, pressure: data[1],
                 label: `👆 Aftertouch ${data[1]} ch${channel}` };
      case 0xA0:
        return { type:'polyPressure', channel, note: data[1], pressure: data[2],
                 label: `👆 Poly AT ${this.noteName(data[1])} ${data[2]} ch${channel}` };
      default:
        return { type:'unknown', data, label: `? ${data.map(b => b.toString(16).padStart(2,'0')).join(' ')}` };
    }
  }

  noteName(note) {
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const oct = Math.floor(note / 12) - 1;
    return `${names[note % 12]}${oct}`;
  }

  /** Número MIDI de una nota (ej: "C4" → 60) */
  noteNumber(name) {
    const match = name.match(/^([A-G]#?)(-?\d+)$/i);
    if (!match) return null;
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const idx = names.indexOf(match[1].toUpperCase());
    return (parseInt(match[2]) + 1) * 12 + idx;
  }

  destroy() {
    if (this.selectedInputId && this.access) {
      const input = this.access.inputs.get(this.selectedInputId);
      if (input) input.onmidimessage = null;
    }
  }
}

const CC_NAMES = {
  0:'Bank Select', 1:'Mod Wheel', 2:'Breath', 4:'Foot',
  5:'Portamento Time', 7:'Volume', 8:'Balance', 10:'Pan',
  11:'Expression', 64:'Sustain Pedal', 65:'Portamento On/Off',
  66:'Sostenuto', 67:'Soft Pedal', 71:'Resonance', 72:'Release',
  73:'Attack', 74:'Brightness', 91:'Reverb', 93:'Chorus',
  120:'All Sound Off', 121:'Reset All', 123:'All Notes Off',
};

window.MidiManager = MidiManager;
window.CC_NAMES    = CC_NAMES;
