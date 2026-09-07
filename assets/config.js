window.APP_CONFIG = Object.freeze({
  centerName: '兵庫県立総合教育センター',
  systemName: '公開講座 AI音声受付',
  officialSite: 'https://www.hyogo-c.ed.jp/~edu-center/',
  receptionEmail: 'niconico.aishuki@gmail.com',
  productionEmail: 'k-open@hyogo-c.ed.jp',
  year: 'R8',

  // STEP10-3でも受付登録は mock のまま維持します。
  // Apps Script / Google Sheets 接続は後段STEPで切り替えます。
  integrationMode: 'mock', // 'mock' | 'secure-bridge'
  bridgeEndpoint: '',

  // Gemini Live 日本語音声 → 正式マスター検索接続。
  // APIキーはブラウザへ置かず、Cloudflare Workerから短命トークンを取得します。
  geminiLive: Object.freeze({
    enabled: true,
    model: 'gemini-3.1-flash-live-preview',
    tokenEndpoint: window.DEPLOYMENT_CONFIG?.geminiTokenEndpoint || '',
    apiVersion: 'v1beta',
    connectionOnly: false,
    audioTestMode: false,
    routeInputToReception: true,
    suppressModelOutput: true,
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    voiceName: 'Kore',
    fallbackToStep9Voice: true
  }),

  environmentLabel: '開発・検証版'
});
