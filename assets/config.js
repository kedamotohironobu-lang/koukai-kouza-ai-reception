window.APP_CONFIG = Object.freeze({
  centerName: '兵庫県立総合教育センター',
  systemName: '公開講座 AI音声受付',
  officialSite: 'https://www.hyogo-c.ed.jp/~edu-center/',
  receptionEmail: 'niconico.aishuki@gmail.com',
  productionEmail: 'k-open@hyogo-c.ed.jp',
  year: 'R8',

  // STEP10-5: Cloudflare Worker経由でApps Script / Google Sheetsへ仮受付を実登録します。
  // Apps Script WebアプリURLや共有シークレットはGitHubへ置かず、Cloudflare Secretで保持します。
  integrationMode: 'secure-bridge', // 'mock' | 'secure-bridge'
  bridgeEndpoint: window.DEPLOYMENT_CONFIG?.receptionSubmitEndpoint || '',
  confirmationEmailEnabled: true,

  // naturalConversation:true は自然会話モジュールを使用します。
  // routeInputToReception/suppressModelOutput/silenceMs 以下は従来方式へ戻した場合の設定です。
  // APIキーはブラウザへ置かず、Cloudflare Workerから短命トークンを取得します。
  geminiLive: Object.freeze({
    enabled: true,
    naturalConversation: true,
    model: 'gemini-3.1-flash-live-preview',
    tokenEndpoint: window.DEPLOYMENT_CONFIG?.geminiTokenEndpoint || '',
    apiVersion: 'v1beta',
    connectionOnly: false,
    audioTestMode: false,
    routeInputToReception: true,
    suppressModelOutput: true,
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    voiceName: 'Sulafat',
    fallbackToStep9Voice: true,
    handsFreeVoice: true,
    vadThreshold: 0.012,
    silenceMs: 1100,
    noSpeechMs: 8000,
    maxUtteranceMs: 20000
  }),

  environmentLabel: 'STEP10-6 自然会話・確認メール連携版'
});
