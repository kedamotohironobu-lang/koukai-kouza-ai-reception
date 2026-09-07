// STEP10-3.1 GitHub Pages + Cloudflare Workers deployment settings.
// このファイルに秘密情報（GEMINI_API_KEY等）を書かないでください。
window.DEPLOYMENT_CONFIG = Object.freeze({
  // Cloudflare Workerを公開した後、下記URLだけを実際のworkers.dev URLへ置き換えます。
  // 例: https://public-course-gemini-token.<your-subdomain>.workers.dev/api/gemini-live-token
  geminiTokenEndpoint: 'https://koukai-kouza-gemini-token.kedamoto-hironobu.workers.dev/api/gemini-live-token'
});
