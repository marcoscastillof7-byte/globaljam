/**
 * scripts/inject-config.js
 *
 * Script de build: reemplaza los placeholders de config.js
 * con las variables de entorno de Netlify.
 *
 * Uso: node scripts/inject-config.js
 */

const fs   = require('fs');
const path = require('path');

const url = process.env.SUPABASE_URL      || '';
const key = process.env.SUPABASE_ANON_KEY || '';

if (!url || !key) {
  console.warn('⚠️  SUPABASE_URL o SUPABASE_ANON_KEY no están definidas.');
  console.warn('    Configura las variables en Netlify → Site settings → Environment variables');
}

const config = `/* Auto-generado en el build — no editar manualmente */
window.GLOBALJAM_CONFIG = {
  supabaseUrl:  '${url}',
  supabaseKey:  '${key}',
  appVersion:   '2.0.0',
};
`;

const outPath = path.join(__dirname, '..', 'public', 'js', 'config.js');
fs.writeFileSync(outPath, config, 'utf8');
console.log(`✅  config.js generado → ${outPath}`);
console.log(`    supabaseUrl: ${url ? '✓ configurado' : '✗ FALTA'}`);
console.log(`    supabaseKey: ${key ? '✓ configurado' : '✗ FALTA'}`);
