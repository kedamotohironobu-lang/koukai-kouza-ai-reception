// STEP10-4 GitHub Pages + Cloudflare Workers deployment settings.
// このファイルに秘密情報（GEMINI_API_KEY等）を書かないでください。
window.DEPLOYMENT_CONFIG = Object.freeze({
  geminiTokenEndpoint:
    'https://koukai-kouza-gemini-token.kedamoto-hironobu.workers.dev/api/gemini-live-token',

  receptionSubmitEndpoint:
    'https://koukai-kouza-gemini-token.kedamoto-hironobu.workers.dev/api/reception-submit'
});
