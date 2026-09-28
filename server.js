/**
 * GlobalJam Studio — Servidor de Desarrollo Local
 * 
 * Este archivo ha sido simplificado. Como ahora usamos Supabase Realtime
 * para la señalización, ya no necesitamos un servidor Socket.io local.
 * 
 * Este script simplemente sirve los archivos estáticos de la carpeta /public
 * para que puedas probar la aplicación localmente sin problemas de CORS
 * o restricciones de navegador para getUserMedia().
 */

const express = require('express');
const path = require('path');
const app = express();

app.use(express.static(path.join(__dirname, 'public')));

// Fallback para SPA (Single Page Application)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🎚  GlobalJam Studio — Servidor Estático Local`);
  console.log(`   Abre en tu navegador: http://localhost:${PORT}\n`);
  console.log(`   NOTA: Asegúrate de haber configurado 'public/js/config.js'`);
  console.log(`         con tus credenciales de Supabase.\n`);
});
