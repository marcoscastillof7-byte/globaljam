# GlobalJam 🎸

**Plataforma global de colaboración musical en tiempo real**

---

## ¿Qué es?

GlobalJam es una aplicación web que permite a músicos de todo el mundo conectarse en salas de jamming en tiempo real, compartir un secuenciador de beats colaborativo y tocar instrumentos virtuales sincronizados — todo desde el navegador, sin instalar nada.

---

## Instalación rápida

### Requisitos
- [Node.js](https://nodejs.org/) v18 o superior

### Pasos

```bash
# 1. Entra a la carpeta
cd globaljam

# 2. Instala dependencias
npm install

# 3. Inicia el servidor
npm start
```

El servidor estará disponible en: **http://localhost:3000**

Para desarrollo con recarga automática:
```bash
npm run dev
```

---

## Características

| Característica | Descripción |
|---|---|
| 🥁 **8 instrumentos** | Bombo, Caja, Hi-Hat, Clap, Ride, Tom, Bajo, Synth |
| ⚡ **Baja latencia** | Corrección de drift entre servidor y cliente |
| 🎵 **Secuenciador 16 pasos** | Colaborativo y sincronizado en tiempo real |
| 🥊 **Pads en vivo** | Toca en tiempo real, todos lo escuchan |
| 👥 **Multi-sala** | Múltiples salas de jam simultáneas |
| 💬 **Chat integrado** | Comunícate con tus co-músicos |
| 📡 **Medidor de latencia** | Muestra tu ping actualizado cada 3 seg |
| 🎛️ **Sin samples** | Síntesis 100% en Web Audio API |
| 🔗 **Compartible** | Comparte link o código de sala |
| ⌨️ **Atajos de teclado** | Espacio=Play/Stop, ↑↓=BPM, 1-8=Pads |

---

## Cómo funciona el anti-lag

1. **Reloj maestro en el servidor**: El servidor emite un `beat_tick` por cada 16vo de nota
2. **Timestamp absoluto**: Cada tick lleva el timestamp Unix del servidor
3. **Corrección de latencia**: El cliente mide el RTT (ping) y descuenta el delay de red al programar el audio
4. **Web Audio API scheduling**: Los sonidos se programan con `audioContext.currentTime` para máxima precisión, no con `setTimeout`
5. **Compresión dinámica**: Compresor maestro evita clipping cuando muchos instrumentos suenan a la vez

---

## Atajos de teclado

| Tecla | Acción |
|---|---|
| `Espacio` | Play / Stop |
| `↑` / `↓` | Subir / Bajar BPM (+5) |
| `1` – `8` | Tocar instrumento en vivo |
| `?` | Mostrar ayuda de atajos |

---

## Despliegue en la nube (gratis)

### Railway
```bash
railway login
railway init
railway up
```

### Render.com
- Conecta el repositorio
- Start command: `npm start`
- Puerto: `3000`

### Fly.io
```bash
fly launch
fly deploy
```

---

## Estructura del proyecto

```
globaljam/
├── server.js          # Servidor Node.js + Socket.io
├── package.json
└── public/
    ├── index.html     # Interfaz completa
    ├── css/
    │   └── style.css  # Estilos dark-mode
    └── js/
        ├── audio.js   # Motor de síntesis (Web Audio API)
        └── app.js     # Lógica del cliente + sockets
```

---

## Roadmap futuro

- [ ] Grabación y exportación a WAV/MP3
- [ ] Más instrumentos (guitarras, brass)
- [ ] Efectos por instrumento (reverb, delay, distortion)
- [ ] Sistema de cuentas y salas privadas con contraseña
- [ ] Historial de sessions guardadas
- [ ] Integración con MIDI real
- [ ] Modos de escala musical (mayor, menor, pentatónica)
