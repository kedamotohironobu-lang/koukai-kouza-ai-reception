(function (global) {
  'use strict';

  const DEFAULT_WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

  class GeminiLiveBridge {
    constructor(options = {}) {
      this.model = options.model || 'gemini-3.1-flash-live-preview';
      this.tokenEndpoint = options.tokenEndpoint || '';
      this.wsBase = options.wsBase || DEFAULT_WS_BASE;
      this.voiceName = options.voiceName || 'Kore';
      this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
      this.onMessage = typeof options.onMessage === 'function' ? options.onMessage : () => {};
      this.socket = null;
      this.connectPromise = null;
      this.connected = false;
      this.setupComplete = false;
      this._connectTimeout = null;
    }

    async connect() {
      if (this.connected && this.socket?.readyState === WebSocket.OPEN) return this;
      if (this.connectPromise) return this.connectPromise;

      this.connectPromise = this._connectInternal();
      try {
        await this.connectPromise;
        return this;
      } finally {
        this.connectPromise = null;
      }
    }

    async _connectInternal() {
      this.onStatus({ phase: 'token', message: 'Gemini Live 認証準備中' });
      const token = await this._fetchEphemeralToken();
      this.onStatus({ phase: 'socket', message: 'Gemini Live 接続中' });

      await new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(this._connectTimeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        };
        const succeed = () => {
          if (settled) return;
          settled = true;
          clearTimeout(this._connectTimeout);
          resolve();
        };

        const wsUrl = `${this.wsBase}?access_token=${token}`;
        const socket = new WebSocket(wsUrl);
        this.socket = socket;
        socket.binaryType = 'arraybuffer';

        this._connectTimeout = setTimeout(() => {
          try { socket.close(1000, 'setup timeout'); } catch (_) { /* noop */ }
          fail(new Error('Gemini Live の接続確認がタイムアウトしました'));
        }, 10000);

        socket.onopen = () => {
          try {
            socket.send(JSON.stringify({
              setup: {
                model: `models/${this.model}`,
                generationConfig: {
                  responseModalities: ['AUDIO'],
                  speechConfig: {
                    voiceConfig: {
                      prebuiltVoiceConfig: { voiceName: this.voiceName }
                    }
                  }
                },
                inputAudioTranscription: {},
                outputAudioTranscription: {},
                systemInstruction: {
                  parts: [{
                    text: [
                      'あなたは兵庫県立総合教育センター公開講座AI音声受付の音声入力セッションです。',
                      'STEP10-3では利用者の日本語発話を正確に文字起こしすることを最優先にしてください。',
                      '公開講座の具体的内容、日程、講師、申込可否などを推測・生成してはいけません。',
                      '講座検索と受付判断はブラウザ側の正式マスターと既存受付ロジックだけが行います。',
                      'Google検索や外部検索は使用しません。',
                      'モデル側の返答は画面・音声に採用されないため、内容を補完したり言い換えたりしないでください。',
                      '所属、氏名、電話番号などをモデル自身から尋ねないでください。'
                    ].join('\n')
                  }]
                }
              }
            }));
          } catch (error) {
            fail(error);
          }
        };

        socket.onmessage = async (event) => {
          try {
            const message = await parseServerMessage(event.data);
            if (!message) return;
            if (message.setupComplete) {
              this.connected = true;
              this.setupComplete = true;
              this.onStatus({ phase: 'ready', message: 'Gemini Live 接続済み' });
              succeed();
            }
            this.onMessage(message);
          } catch (error) {
            console.warn('Gemini Live メッセージ解析エラー', error);
          }
        };

        socket.onerror = () => {
          fail(new Error('Gemini Live WebSocket 接続でエラーが発生しました'));
        };

        socket.onclose = (event) => {
          const wasReady = this.connected;
          this.connected = false;
          this.setupComplete = false;
          this.socket = null;
          clearTimeout(this._connectTimeout);
          if (!settled) {
            fail(new Error(`Gemini Live 接続が完了前に終了しました（code: ${event.code || 'unknown'}）`));
          } else if (wasReady) {
            this.onStatus({ phase: 'closed', message: 'Gemini Live 接続終了' });
          }
        };
      });
    }

    sendAudioPcmBase64(base64Data, sampleRate = 16000) {
      if (!this.isReady() || !base64Data) return false;
      this.socket.send(JSON.stringify({
        realtimeInput: {
          audio: {
            data: base64Data,
            mimeType: `audio/pcm;rate=${sampleRate}`
          }
        }
      }));
      return true;
    }

    endAudioStream() {
      if (!this.isReady()) return false;
      this.socket.send(JSON.stringify({
        realtimeInput: { audioStreamEnd: true }
      }));
      return true;
    }

    async _fetchEphemeralToken() {
      const endpoint = String(this.tokenEndpoint || '').trim();
      if (!endpoint || endpoint.includes('REPLACE-WITH-YOUR-WORKER')) {
        throw new Error('Cloudflare Worker URLが未設定です（assets/deployment-config.js を確認してください）');
      }
      let endpointUrl;
      try {
        endpointUrl = new URL(endpoint, global.location?.href || undefined);
      } catch (_) {
        throw new Error('Cloudflare Worker URLの形式が正しくありません');
      }
      if (endpointUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(endpointUrl.hostname)) {
        throw new Error('Gemini認証用WorkerはHTTPSで公開してください');
      }

      const response = await fetch(endpointUrl.href, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        credentials: 'omit',
        body: JSON.stringify({ purpose: 'public-course-live-step10' })
      });
      let data = null;
      try { data = await response.json(); } catch (_) { /* noop */ }
      if (!response.ok || !data?.ok || !data?.token) {
        const code = data?.code ? ` (${data.code})` : '';
        throw new Error(`Gemini Live の短命トークンを取得できませんでした${code}`);
      }
      if (!/^auth_tokens\/[A-Za-z0-9._~-]+$/.test(data.token)) {
        throw new Error('Gemini Live の短命トークン形式を確認できませんでした');
      }
      return data.token;
    }

    close() {
      clearTimeout(this._connectTimeout);
      this._connectTimeout = null;
      const socket = this.socket;
      this.socket = null;
      this.connected = false;
      this.setupComplete = false;
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        try { socket.close(1000, 'client close'); } catch (_) { /* noop */ }
      }
    }

    isReady() {
      return Boolean(this.connected && this.setupComplete && this.socket?.readyState === WebSocket.OPEN);
    }
  }

  async function parseServerMessage(data) {
    if (typeof data === 'string') return JSON.parse(data);
    if (data instanceof Blob) return JSON.parse(await data.text());
    if (data instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(data));
    return null;
  }

  global.GeminiLiveBridge = GeminiLiveBridge;
})(typeof window !== 'undefined' ? window : globalThis);
