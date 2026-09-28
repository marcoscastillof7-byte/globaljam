/**
 * Netlify Function: /api/health
 * Health check endpoint — verifica que el sitio está vivo
 */
exports.handler = async (event, context) => {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok:        true,
      service:   'GlobalJam Studio',
      version:   '2.0.0',
      timestamp: new Date().toISOString(),
      env:       process.env.NODE_ENV || 'unknown',
      supabase:  !!process.env.SUPABASE_URL,
    }),
  };
};
