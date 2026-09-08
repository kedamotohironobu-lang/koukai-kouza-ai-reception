(() => {
  'use strict';

  const CONFIG = window.APP_CONFIG || {};
  const CORE = window.ReceptionCore;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const els = {
    landing: $('#landingScreen'),
    reception: $('#receptionScreen'),
    startVoice: $('#startVoiceBtn'),
    startChat: $('#startChatBtn'),
    reset: $('#resetBtn'),
    progress: $('#progress'),
    statusBar: $('#statusBar'),
    statusText: $('#statusText'),
    messages: $('#messages'),
    suggestions: $('#suggestions'),
    voiceTab: $('#voiceTab'),
    chatTab: $('#chatTab'),
    voicePanel: $('#voicePanel'),
    chatPanel: $('#chatPanel'),
    chatInput: $('#chatInput'),
    mic: $('#micBtn'),
    voicePrompt: $('#voicePrompt'),
    liveTranscript: $('#liveTranscript'),
    toChat: $('#toChatBtn'),
    toVoice: $('#toVoiceBtn'),
    speaker: $('#speakerBtn'),
    agentCaption: $('#agentCaption'),
    help: $('#helpBtn'),
    helpDialog: $('#helpDialog'),
    closeHelp: $('#closeHelpBtn'),
    toast: $('#toast')
  };

  let natural = null;
  let submissionPromise = null;
  let submissionIdentity = null;
  let submissionResult = null;
  const naturalMode = () => CONFIG.geminiLive?.naturalConversation === true && state.inputMode === 'voice';

  const state = {
    stage: 'landing',
    inputMode: 'voice',
    speakerOn: true,
    courses: [],
    selectedCourse: null,
    method: '',
    affiliation: '',
    name: '',
    phone: '',
    receiptNumber: '',
    recognition: null,
    recognizing: false,
    lastSpeechFinal: '',
    recognitionErrors: 0,
    geminiLive: null,
    geminiLiveReady: false,
    geminiLiveConnecting: false,
    geminiLiveError: '',
    geminiMicStreaming: false,
    geminiMediaStream: null,
    geminiInputContext: null,
    geminiInputSource: null,
    geminiInputProcessor: null,
    geminiInputSink: null,
    geminiOutputContext: null,
    geminiOutputNextTime: 0,
    geminiOutputSources: new Set(),
    geminiUserTranscript: '',
    geminiModelTranscript: '',
    geminiTranscriptCommitTimer: null,
    geminiTranscriptCommitted: false,
    autoVoiceEnabled: false,
    autoVoiceTimer: null,
    autoVoicePromptToken: 0,
    autoVoiceRetryCount: 0,
    geminiCaptureStartedAt: 0,
    geminiLastVoiceAt: 0,
    geminiVoiceDetected: false,
    geminiAutoStopPending: false,
    geminiNoSpeechTimer: null
  };

  const STAGE_GROUP = {
    landing: 'search',
    search: 'search',
    course: 'search',
    method: 'method',
    affiliation: 'person',
    name: 'person',
    phone: 'person',
    confirm: 'confirm',
    correction: 'confirm',
    complete: 'complete'
  };
  const GROUPS = ['search', 'method', 'person', 'confirm', 'complete'];
  const MOBILE_BREAKPOINT = 760;
  const AUTO_VOICE_STAGES = new Set(['search', 'course', 'method', 'affiliation', 'name', 'phone', 'confirm', 'correction']);
  const AUTO_VOICE_START_DELAY_MS = 320;
  const DEFAULT_VAD_THRESHOLD = 0.012;
  const DEFAULT_SILENCE_MS = 1100;
  const DEFAULT_NO_SPEECH_MS = 8000;
  const DEFAULT_MAX_UTTERANCE_MS = 20000;

  function isMobileView() {
    return window.innerWidth <= MOBILE_BREAKPOINT;
  }

  function applyMobileModeClass(mode = state.inputMode) {
    document.body.classList.remove('mobile-voice-mode', 'mobile-chat-mode');
    if (!isMobileView()) return;
    document.body.classList.add(mode === 'voice' ? 'mobile-voice-mode' : 'mobile-chat-mode');
  }

  async function boot() {
    bindEvents();
    try {
      if (Array.isArray(window.COURSE_DATA) && window.COURSE_DATA.length) {
        state.courses = Array.from(window.COURSE_DATA);
      } else {
        const response = await fetch('assets/courses.json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state.courses = await response.json();
      }
      setStatus(`${state.courses.length}件の公開講座マスターを読み込みました`);
    } catch (err) {
      console.error(err);
      setStatus('講座データを読み込めませんでした', 'error');
      showToast('講座データの読み込みに失敗しました。');
    }
    initSpeechRecognition();
    if (!CONFIG.geminiLive?.naturalConversation) initGeminiLiveBridge();
    window.addEventListener('beforeunload',()=>natural?.stop());
    applyMobileModeClass();
    window.addEventListener('resize', () => applyMobileModeClass());
  }

  function bindEvents() {
    els.startVoice.addEventListener('click', () => startReception('voice'));
    els.startChat.addEventListener('click', () => startReception('chat'));
    els.reset.addEventListener('click', resetReception);
    els.voiceTab.addEventListener('click', () => switchMode('voice'));
    els.chatTab.addEventListener('click', () => switchMode('chat'));
    els.toChat.addEventListener('click', () => switchMode('chat'));
    els.toVoice.addEventListener('click', () => switchMode('voice'));
    els.mic.addEventListener('click', () => { void toggleVoiceInput(); });
    els.chatPanel.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = els.chatInput.value.trim();
      if (!text) return;
      els.chatInput.value = '';
      receiveInput(text);
    });
    els.speaker.addEventListener('click', () => {
      state.speakerOn = !state.speakerOn;
      els.speaker.classList.toggle('active', state.speakerOn);
      els.speaker.setAttribute('aria-pressed', String(state.speakerOn));
      els.speaker.textContent = state.speakerOn ? '🔊 読み上げ ON' : '🔇 読み上げ OFF';
      if (!state.speakerOn && 'speechSynthesis' in window) speechSynthesis.cancel();
      if (!state.speakerOn) {stopGeminiOutputAudio(); natural?.stopOutput();}
    });
    els.help.addEventListener('click', () => els.helpDialog.showModal());
    els.closeHelp.addEventListener('click', () => els.helpDialog.close());
  }

  function startReception(mode) {
    if (!state.courses.length) {
      showToast('講座データを読み込んでいます。少し待ってからもう一度お試しください。');
      return;
    }
    els.landing.classList.add('hidden');
    els.reception.classList.remove('hidden');
    state.autoVoiceEnabled = mode === 'voice' && (CONFIG.geminiLive || {}).handsFreeVoice !== false;
    state.autoVoiceRetryCount = 0;
    switchMode(mode, { silent: true });
    applyMobileModeClass(mode);
    state.stage = 'search';
    updateProgress();
    els.messages.innerHTML = '';
    els.suggestions.innerHTML = '';
    if (naturalMode()) {showSearchExamples();void startNatural();return;}
    botSay('こんにちは。兵庫県立総合教育センターの公開講座をご案内します。\n第何回の講座か、または「生成AI」「不登校」のように学びたい内容をお話しください。');
    showSearchExamples();
    setStatus('希望する講座をお話しください');
    if (mode === 'voice') {
      void ensureGeminiLiveConnection();
      setTimeout(() => {
        if (!geminiLiveConfigured() && !speechRecognitionAvailable()) {
          botSay('このブラウザでは音声入力を利用できないため、チャット入力に切り替えました。');
          switchMode('chat', { silent: true });
        }
      }, 500);
    }
  }

  function resetReception() {
    if (submissionPromise || (submissionIdentity && !submissionResult)) {showToast('登録結果が未確認です。同じ内容で再試行してからやり直してください。');return;}
    natural?.stop(); natural=null; submissionIdentity=null; submissionResult=null;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    stopRecognition();
    void stopGeminiAudioCapture({ sendEnd: false });
    closeGeminiLiveConnection();
    clearGeminiTranscriptCommitTimer();
    cancelAutoVoiceTurn();
    clearGeminiNoSpeechTimer();
    const keepHandsFree = state.inputMode === 'voice';
    Object.assign(state, {
      stage: 'search', selectedCourse: null, method: '', affiliation: '', name: '', phone: '', receiptNumber: '', lastSpeechFinal: '', recognitionErrors: 0, geminiLiveReady: false, geminiLiveConnecting: false, geminiLiveError: '', geminiMicStreaming: false, geminiUserTranscript: '', geminiModelTranscript: '', geminiTranscriptCommitted: false,
      autoVoiceEnabled: keepHandsFree, autoVoiceRetryCount: 0, geminiCaptureStartedAt: 0, geminiLastVoiceAt: 0, geminiVoiceDetected: false, geminiAutoStopPending: false
    });
    els.messages.innerHTML = '';
    els.suggestions.innerHTML = '';
    if(naturalMode()){showSearchExamples();updateProgress();void startNatural();return;}
    botSay('最初からやり直します。\n第何回の講座か、学びたい内容をお話しください。');
    showSearchExamples();
    updateProgress();
    setStatus('希望する講座をお話しください');
  }

  function switchMode(mode, options = {}) {
    state.inputMode = mode;
    const voice = mode === 'voice';
    state.autoVoiceEnabled = voice && (CONFIG.geminiLive || {}).handsFreeVoice !== false;
    cancelAutoVoiceTurn();
    clearGeminiNoSpeechTimer();
    els.voiceTab.classList.toggle('active', voice);
    els.chatTab.classList.toggle('active', !voice);
    els.voiceTab.setAttribute('aria-selected', String(voice));
    els.chatTab.setAttribute('aria-selected', String(!voice));
    els.voicePanel.classList.toggle('hidden', !voice);
    els.chatPanel.classList.toggle('hidden', voice);
    if (!voice) {
      natural?.stop();
      stopRecognition();
      void stopGeminiAudioCapture({ sendEnd: false });
      closeGeminiLiveConnection();
      setTimeout(() => els.chatInput.focus(), 30);
    } else if (state.stage !== 'landing') {
      if(naturalMode()) {void startNatural();applyMobileModeClass(mode);return;}
      void ensureGeminiLiveConnection();
      if (!options.silent) scheduleAutoVoiceTurn();
    }
    applyMobileModeClass(mode);
    if (!options.silent) {
      showToast(voice ? '音声入力に切り替えました' : 'チャット入力に切り替えました');
    }
  }

  function receiveInput(rawText) {
    if(!naturalMode() && submissionIdentity && !submissionResult){if(/^(はい|再試行|お願いします)[。!！\s]*$/.test(String(rawText).trim())){state.stage='confirm';void completeReception();}else showToast('登録結果が未確認です。同じ内容で再試行してください。');return;}
    const text = normalizeSpace(rawText);
    if (!text) return;
    if(naturalMode()){natural?.send(text);return;}
    cancelAutoVoiceTurn();
    clearGeminiNoSpeechTimer();
    state.autoVoiceRetryCount = 0;
    userSay(text);
    setStatus('内容を確認しています…');
    window.setTimeout(() => routeInput(text), 180);
  }

  function routeInput(text) {
    switch (state.stage) {
      case 'search': return handleSearch(text);
      case 'course': return handleCourseVoiceChoice(text);
      case 'method': return handleMethod(text);
      case 'affiliation': return handleAffiliation(text);
      case 'name': return handleName(text);
      case 'phone': return handlePhone(text);
      case 'confirm': return handleConfirm(text);
      case 'correction': return handleCorrectionChoice(text);
      case 'complete': return botSay('この受付は完了しています。「やり直す」を押すと最初から開始できます。', { autoListen: false });
      default: return handleSearch(text);
    }
  }

  function handleSearch(text) {
    const matches = searchCourses(text);
    if (!matches.length) {
      botSay('該当する講座を確認できませんでした。講座番号、演題の一部、または「生成AI」「不登校」のようなキーワードでもう一度お知らせください。');
      showSearchExamples();
      setStatus('別の言葉で講座を探してください');
      return;
    }

    const exact = exactCourseFromText(text);
    if (exact) {
      selectCourse(exact.key);
      return;
    }

    botSay(`${matches.length}件の候補が見つかりました。希望する講座を選んでください。`);
    renderCourseCards(matches.slice(0, 5));
    state.stage = 'course';
    updateProgress();
    setStatus('候補から講座を選んでください');
  }

  function handleCourseVoiceChoice(text) {
    const exact = exactCourseFromText(text);
    if (exact) return selectCourse(exact.key);

    const matches = searchCourses(text);
    if (matches.length === 1) return selectCourse(matches[0].key);

    botSay('講座を特定できませんでした。画面の候補を選ぶか、「第50回」のように講座番号をお話しください。');
  }

  function selectCourse(key) {
    if(naturalMode()){natural?.send('画面で講座 '+key+' を選びました。正式マスターで確認し下書きに反映してください。');return;}
    const course = state.courses.find((item) => item.key === key);
    if (!course) return;
    state.selectedCourse = course;
    state.stage = 'method';
    updateProgress();
    els.suggestions.innerHTML = '';

    const deadlineText = formatDate(course.deadline) || '資料記載なし';
    const methods = [];
    if (course.onsiteAvailable) methods.push('集合研修');
    if (course.vodAvailable) methods.push('VOD');

    botSay(`${course.display}「${course.title}」ですね。正式資料の内容を表示します。`);
    renderCourseDetail(course);

    if (isDeadlinePast(course.deadline)) {
      botSay(`申込締切日は ${deadlineText} です。現在は締切日を過ぎているため、この試作画面では受付を進めません。職員確認が必要です。`, { autoListen: false });
      setStatus('申込締切日を過ぎています', 'warning');
      return;
    }

    if (!methods.length) {
      botSay('この講座は現在選択できる受講方法がありません。別の講座をお選びください。', { autoListen: false });
      setStatus('受講方法を選択できません', 'warning');
      return;
    }

    botSay(`受講方法は ${methods.join(' または ')} が選べます。どちらを希望しますか？`);
    renderMethodChoices(course);
    setStatus('受講方法を選んでください');
  }

  function handleMethod(text) {
    if (!state.selectedCourse) {
      state.stage = 'search';
      return handleSearch(text);
    }
    const normalized = normalizeForSearch(text);
    let method = '';
    if (normalized.includes('vod') || normalized.includes('動画') || normalized.includes('オンデマンド')) method = 'VOD';
    if (normalized.includes('集合') || normalized.includes('会場') || normalized.includes('対面')) method = '集合研修';

    if (!method) {
      botSay('「集合研修」または「VOD」のどちらかをお知らせください。');
      return;
    }
    chooseMethod(method);
  }

  function chooseMethod(method) {
    if(naturalMode()){natural?.send('受講方法は '+method+' を希望します。');return;}
    const c = state.selectedCourse;
    if (!c) return;
    if (method === '集合研修' && !c.onsiteAvailable) {
      botSay('正式資料では、この講座は集合研修での受付ができません。VODを選択してください。');
      return;
    }
    if (method === 'VOD' && !c.vodAvailable) {
      botSay('正式資料では、この講座はVODでの受付ができません。集合研修を選択してください。');
      return;
    }
    state.method = method;
    state.stage = 'affiliation';
    updateProgress();
    els.suggestions.innerHTML = '';
    botSay(`${method}ですね。続いて申込者情報を1項目ずつ確認します。\nまず、所属をお知らせください。`);
    setStatus('所属をお話しください');
  }

  function handleAffiliation(text) {
    const value = cleanSpokenField(text, ['所属', '学校名', '勤務先']);
    if (value.length < 2) {
      botSay('所属名をもう一度お知らせください。');
      return;
    }
    state.affiliation = value;
    state.stage = 'name';
    botSay(`所属は「${value}」ですね。次に、お名前をお知らせください。`);
    setStatus('氏名をお話しください');
  }

  function handleName(text) {
    const value = cleanSpokenField(text, ['名前', '氏名', 'お名前']);
    if (value.length < 2) {
      botSay('お名前をもう一度お知らせください。');
      return;
    }
    state.name = value;
    state.stage = 'phone';
    botSay(`お名前は「${value}」ですね。最後に、所属の電話番号を、ゆっくり数字でお知らせください。`);
    setStatus('所属電話番号をお話しください');
  }

  function handlePhone(text) {
    const phone = normalizeSpokenPhone(text);
    if (phone.length < 8 || phone.length > 15) {
      botSay('電話番号を確認できませんでした。「ゼロ・ナナ・キュウ…」のように、所属の電話番号をゆっくりもう一度お知らせください。');
      return;
    }
    state.phone = formatPhoneDisplay(phone);
    state.stage = 'confirm';
    updateProgress();
    botSay('ありがとうございます。申込内容を確認します。');
    renderConfirmation();
    botSay('この内容でよろしければ「はい」、修正する場合は「修正」とお知らせください。');
    setStatus('申込内容をご確認ください');
  }

  function handleConfirm(text) {
    const normalized = normalizeForSearch(text);
    if (/^(はい|ok|オーケー|お願いします|これで|正しい|大丈夫|よい|いい)/.test(normalized)) {
      return completeReception();
    }
    if (normalized.includes('修正') || normalized.includes('変更') || normalized.includes('違')) {
      state.stage = 'correction';
      updateProgress();
      renderCorrectionChoices();
      botSay('修正する項目を、「講座」「受講方法」「所属」「氏名」「電話番号」のいずれかでお知らせください。');
      return;
    }
    botSay('内容が正しければ「はい」、変更する場合は「修正」とお知らせください。');
  }

  function handleCorrectionChoice(text) {
    const normalized = normalizeForSearch(text);
    if (normalized.includes('講座')) return beginCorrection('course');
    if (normalized.includes('受講') || normalized.includes('方法') || normalized.includes('集合') || normalized.includes('vod')) return beginCorrection('method');
    if (normalized.includes('所属') || normalized.includes('学校')) return beginCorrection('affiliation');
    if (normalized.includes('氏名') || normalized.includes('名前')) return beginCorrection('name');
    if (normalized.includes('電話') || normalized.includes('連絡先')) return beginCorrection('phone');
    botSay('修正する項目を、「講座」「受講方法」「所属」「氏名」「電話番号」のいずれかでお知らせください。');
  }

  function beginCorrection(target) {
    if(naturalMode()){natural?.send(target+' を修正したいです。');return;}
    els.suggestions.innerHTML = '';
    if (target === 'course') {
      state.stage = 'search';
      state.selectedCourse = null;
      state.method = '';
      botSay('講座を選び直します。希望する講座をお知らせください。');
      showSearchExamples();
    } else if (target === 'method') {
      state.stage = 'method';
      botSay('受講方法を選び直します。「集合研修」または「VOD」とお知らせください。');
      renderMethodChoices(state.selectedCourse);
    } else if (target === 'affiliation') {
      state.stage = 'affiliation';
      botSay('所属をもう一度お知らせください。');
    } else if (target === 'name') {
      state.stage = 'name';
      botSay('お名前をもう一度お知らせください。');
    } else if (target === 'phone') {
      state.stage = 'phone';
      botSay('所属の電話番号をもう一度お知らせください。');
    }
    updateProgress();
  }

  async function completeReception() {
    if(naturalMode()) {
      if(!natural) return;
      const result=await natural.submit();
      if(!result.ok) {setStatus(result.error,'error');addMessage('bot',result.error);}
      else natural.send('システム通知：仮受付登録結果 '+JSON.stringify(result)+' 。この結果に基づいて短く案内してください。');
      return;
    }
    if(state.stage!=='confirm' && !submissionResult) return;
    try {await registerCurrentReception();}
    catch (_) {botSay('登録結果を確認できませんでした。登録済みの可能性があります。同じ内容で再試行してください。');setStatus('登録結果未確認','error');}
  }

  async function registerCurrentReception() {
    if(submissionResult) return submissionResult;
    if(submissionPromise) return submissionPromise;
    setStatus('仮受付を登録しています…');
    submissionPromise=(async()=>{
      const result=await submitReception();
      submissionResult=result;
      state.receiptNumber=result.receiptNumber;state.stage='complete';updateProgress();renderCompletion(result);
      setStatus('仮受付を登録しました（メール送信・受講確定は別途）');
      if(!naturalMode())botSay('仮受付を登録しました。受付番号をご確認ください。',{autoListen:false});
      return result;
    })();
    try{return await submissionPromise;}finally{submissionPromise=null;}
  }

  async function startNatural() {
    if(natural?.active || submissionPromise || state.stage==='complete')return;
    // A disconnected session reuses the draft, including an uncertain submission lock.
    const previous=natural?.draft?.locked ? natural.draft : null;
    natural?.stop();
    natural=new window.NaturalReception({
      courses:state.courses,core:CORE,config:CONFIG.geminiLive,
      results:rows=>renderCourseCards(rows),
      status:t=>setStatus(t),speaker:()=>state.speakerOn,
      caption:t=>{els.liveTranscript.textContent=t;els.agentCaption.textContent=t.slice(-120);},
      message:(role,t)=>addMessage(role==='user'?'user':'bot',t),
      draft:(d,confirm)=>{
        state.selectedCourse=d.course;state.method=d.method;state.affiliation=d.affiliation;state.name=d.name;state.phone=d.phone;
        state.stage=confirm?'confirm':(d.missing[0]==='courseKey'?'search':d.missing[0]||'confirm');
        updateProgress();
        if(confirm)renderConfirmation();
        else {els.suggestions.innerHTML='';if(d.course){renderCourseDetail(d.course);if(!d.method)renderMethodChoices(d.course);}}
      },
      submit:async d=>{state.selectedCourse=d.course;state.method=d.method;state.affiliation=d.affiliation;state.name=d.name;state.phone=d.phone;return registerCurrentReception();}
    });
    if(previous)natural.draft=previous;
    els.mic.classList.add('listening');els.voicePrompt.textContent='会話中です（マイクを押すと一時停止）';
    await natural.start(previous?null:{courseKey:state.selectedCourse?.key||'',method:state.method,affiliation:state.affiliation,name:state.name,phone:state.phone});
    if(!natural.active)els.mic.classList.remove('listening');
  }

  async function submitReception() {
    const course = state.selectedCourse;
    if (!course) throw new Error('講座が選択されていません');

    const fingerprint=JSON.stringify([course.key,state.method,state.affiliation,state.name,state.phone]);
    if(submissionIdentity && submissionIdentity.fingerprint!==fingerprint)throw new Error('前回の登録結果が未確認です。元の内容で確認してください。');
    if(!submissionIdentity)submissionIdentity={fingerprint,requestId:createReceptionRequestId()};
    const requestId = submissionIdentity.requestId;
    const payload = {
      purpose: 'public-course-reception-step10-5',
      requestId,
      channel: state.inputMode === 'voice' ? 'Web音声' : 'Webチャット',
      affiliation: state.affiliation,
      name: state.name,
      phone: state.phone,
      courseKey: course.key,
      displayCourse: course.display,
      courseNumber: course.number,
      courseBranch: course.branch ?? '',
      title: course.title,
      method: state.method
    };

    if (CONFIG.integrationMode !== 'secure-bridge') {
      await delay(450);
      return {
        ok: true,
        mock: true,
        receiptNumber: `${CONFIG.year || 'R8'}-DEMO-${String(Math.floor(Math.random() * 9000) + 1000)}`,
        payload
      };
    }

    if (!CONFIG.bridgeEndpoint) throw new Error('安全な中継APIが未設定です');
    const response = await fetch(CONFIG.bridgeEndpoint, {
      signal: AbortSignal.timeout(45000),
      method: 'POST',
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    let data = null;
    try { data = await response.json(); } catch (_) { /* noop */ }
    if (!response.ok || !data?.ok || !data?.receiptNumber) {
      const code = data?.code || `HTTP_${response.status}`;
      throw new Error(receptionErrorMessage(code));
    }
    return data;
  }

  function createReceptionRequestId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function receptionErrorMessage(code) {
    const messages = {
      ORIGIN_NOT_ALLOWED: '受付サイトからの通信として確認できませんでした',
      INVALID_PURPOSE: '受付APIの要求形式を確認できませんでした',
      INVALID_RECEPTION_DATA: '受付内容に不足または不正な値があります',
      COURSE_NOT_FOUND: '正式マスターで講座を確認できませんでした',
      METHOD_NOT_AVAILABLE: '正式マスターでは、その受講方法を選択できません',
      DEADLINE_PASSED: '申込締切日を過ぎているため仮受付できません',
      APPS_SCRIPT_NOT_CONFIGURED: 'Apps Script接続設定が完了していません',
      APPS_SCRIPT_AUTH_FAILED: 'Apps Scriptとの安全な接続を確認できませんでした',
      APPS_SCRIPT_REJECTED: 'Apps Scriptで仮受付を完了できませんでした',
      APPS_SCRIPT_NETWORK_ERROR: 'Apps Scriptとの通信でエラーが発生しました'
    };
    return messages[code] || `受付APIでエラーが発生しました（${code}）`;
  }

  function searchCourses(query) {
    return CORE.searchCourses(state.courses, query);
  }

  function exactCourseFromText(text) {
    return CORE.exactCourseFromText(state.courses, text);
  }

  function extractCourseNumber(text) {
    return CORE.extractCourseNumber(text);
  }

  function extractBranch(text) {
    return CORE.extractBranch(text);
  }

  function renderCourseCards(courses) {
    els.suggestions.innerHTML = `<div class="course-list">${courses.map((course) => `
      <button class="course-card" type="button" data-course-key="${escapeHtml(course.key)}">
        <div class="course-top"><span class="course-no">${escapeHtml(course.display)}</span><span>選択 ›</span></div>
        <div class="course-title">${escapeHtml(course.title)}</div>
        <div class="course-meta">
          <span class="tag ${course.onsiteAvailable ? '' : 'off'}">集合 ${course.onsiteAvailable ? '○' : '－'}</span>
          <span class="tag ${course.vodAvailable ? '' : 'off'}">VOD ${course.vodAvailable ? '○' : '－'}</span>
          ${course.deadline ? `<span>締切 ${formatDate(course.deadline)}</span>` : ''}
        </div>
      </button>`).join('')}</div>`;
    $$('[data-course-key]').forEach((button) => button.addEventListener('click', () => selectCourse(button.dataset.courseKey)));
  }

  function renderCourseDetail(course) {
    const onsite = course.onsiteAvailable
      ? `${formatDate(course.onsiteDate) || '日付記載なし'}${course.onsiteStart ? ` ${course.onsiteStart}～${course.onsiteEnd || ''}` : ''}`
      : '受付不可';
    const vod = course.vodAvailable
      ? `${formatDate(course.vodStart) || '開始日記載なし'} ～ ${formatDate(course.vodEnd) || '終了日記載なし'}`
      : '受付不可';

    els.suggestions.innerHTML = `
      <div class="detail-card">
        <div class="course-no">${escapeHtml(course.display)}</div>
        <h3>${escapeHtml(course.title)}</h3>
        <dl class="detail-grid">
          <dt>講師</dt><dd>${escapeHtml(course.lecturer || '資料記載なし')}</dd>
          <dt>申込締切</dt><dd>${escapeHtml(formatDate(course.deadline) || '資料記載なし')}</dd>
          <dt>集合研修</dt><dd>${escapeHtml(onsite)}</dd>
          <dt>VOD</dt><dd>${escapeHtml(vod)}</dd>
        </dl>
        ${course.overview ? `<p class="detail-overview">${escapeHtml(course.overview)}</p>` : ''}
        <div class="detail-actions">
          <button class="action-btn secondary" type="button" id="backSearchBtn">別の講座を探す</button>
        </div>
      </div>`;
    $('#backSearchBtn')?.addEventListener('click', () => {
      if(naturalMode()){natural.armed=false;natural.draft.prepared=null;natural.send('別の講座を探したいです。');return;}
      state.selectedCourse = null;
      state.stage = 'search';
      updateProgress();
      els.suggestions.innerHTML = '';
      botSay('別の講座を探します。希望する講座番号や内容をお知らせください。');
      showSearchExamples();
      setStatus('希望する講座をお話しください');
    });
  }

  function renderMethodChoices(course) {
    const holder = document.createElement('div');
    holder.className = 'chip-row';
    if (course.onsiteAvailable) holder.append(makeChip(`👥 集合研修 ${formatDate(course.onsiteDate) || ''}`, () => chooseMethod('集合研修')));
    if (course.vodAvailable) holder.append(makeChip(`💻 VOD ${formatDate(course.vodStart) || ''}～`, () => chooseMethod('VOD')));
    els.suggestions.append(holder);
  }

  function renderConfirmation() {
    const c = state.selectedCourse;
    els.suggestions.innerHTML = `
      <div class="confirm-card">
        <div class="confirm-title">申込内容をご確認ください</div>
        <dl class="confirm-list">
          <dt>所属</dt><dd>${escapeHtml(state.affiliation)}</dd>
          <dt>氏名</dt><dd>${escapeHtml(state.name)}</dd>
          <dt>電話番号</dt><dd>${escapeHtml(state.phone)}</dd>
          <dt>講座</dt><dd>${escapeHtml(c.display)} ${escapeHtml(c.title)}</dd>
          <dt>受講方法</dt><dd>${escapeHtml(state.method)}</dd>
        </dl>
        <div class="detail-actions" style="padding:12px 13px">
          <button id="confirmYesBtn" class="action-btn primary" type="button">この内容で仮受付</button>
          <button id="confirmEditBtn" class="action-btn secondary" type="button">修正する</button>
        </div>
      </div>`;
    $('#confirmYesBtn')?.addEventListener('click', completeReception);
    $('#confirmEditBtn')?.addEventListener('click', () => {if(naturalMode()){natural.armed=false;natural.draft.prepared=null;natural.send('内容を修正したいです。どの項目か聞いてください。');}else renderCorrectionChoices();});
  }

  function renderCorrectionChoices() {
    if(naturalMode()){natural.armed=false;natural.draft.prepared=null;natural.send('申込内容を修正したいです。');return;}
    state.stage = 'correction';
    updateProgress();
    els.suggestions.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'chip-row';
    const choices = [
      ['講座', 'course'],
      ['受講方法', 'method'],
      ['所属', 'affiliation'],
      ['氏名', 'name'],
      ['電話番号', 'phone']
    ];
    choices.forEach(([label, target]) => row.append(makeChip(label, () => beginCorrection(target))));
    els.suggestions.append(row);
  }

  function renderCompletion(result) {
    const c = state.selectedCourse;
    const draft = buildEmailDraft(result.receiptNumber);
    const emailEnabled = CONFIG.confirmationEmailEnabled === true && CONFIG.integrationMode === 'secure-bridge' && !result.mock;

    els.suggestions.innerHTML = `
      <div class="complete-card">
        <div class="complete-icon">✅</div>
        <h3>${result.mock ? 'STEP9 画面テスト完了' : '仮受付が完了しました'}</h3>
        <div>受付番号</div>
        <div class="receipt-number">${escapeHtml(result.receiptNumber)}</div>
        ${result.mock ? '<div class="demo-warning">この番号は画面確認用のDEMO番号です。Googleスプレッドシートには登録されていません。</div>' : '<p>この番号は大切に保管してください。</p>'}
        <div class="email-draft">${escapeHtml(draft)}</div>
        <div class="detail-actions" style="justify-content:center">
          <button id="copyDraftBtn" class="action-btn secondary" type="button">確認メール文面をコピー</button>
          <button id="openMailBtn" class="action-btn primary" type="button" ${emailEnabled ? '' : 'disabled'}>${emailEnabled ? 'メールアプリを開く' : 'STEP10-6で確認メール連携'}</button>
        </div>
      </div>`;

    $('#copyDraftBtn')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(draft);
        showToast('確認メール文面をコピーしました');
      } catch {
        showToast('コピーできませんでした。文面を選択してコピーしてください。');
      }
    });

    if (emailEnabled) {
      $('#openMailBtn')?.addEventListener('click', () => {
        const subject = `【公開講座受付確認】${result.receiptNumber}`;
        location.href = `mailto:${encodeURIComponent(CONFIG.receptionEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(draft)}`;
      });
    }
  }

  function buildEmailDraft(receipt) {
    return [
      `送信先：${CONFIG.receptionEmail}`,
      `件名：【公開講座受付確認】${receipt}`,
      '',
      `受付番号：${receipt}`,
      `所属：${state.affiliation}`,
      `氏名：${state.name}`,
      `所属電話番号：${state.phone}`,
      `希望講座：${state.selectedCourse.display} ${state.selectedCourse.title}`,
      `受講方法：${state.method}`
    ].join('\n');
  }

  function showSearchExamples() {
    els.suggestions.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'chip-row';
    [
      ['第50回を探す', '第50回'],
      ['生成AI', '生成AI'],
      ['不登校', '不登校'],
      ['コミュニケーション', 'コミュニケーション']
    ].forEach(([label, text]) => row.append(makeChip(label, () => receiveInput(text))));
    els.suggestions.append(row);
  }

  function makeChip(label, onClick) {
    const button = document.createElement('button');
    button.className = 'chip';
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  function botSay(text, options = {}) {
    if(naturalMode()){addMessage('bot',text);return;}
    addMessage('bot', text);
    const firstLine = text.split('\n')[0];
    els.agentCaption.textContent = firstLine.length > 84 ? `${firstLine.slice(0, 84)}…` : firstLine;

    const promptToken = ++state.autoVoicePromptToken;
    const shouldListen = !options.silent && options.autoListen !== false && shouldAutoVoiceListen();
    if (state.speakerOn && !options.silent) {
      const spoken = speak(text, {
        onEnd: () => {
          if (shouldListen) scheduleAutoVoiceTurn(promptToken);
        }
      });
      if (!spoken && shouldListen) scheduleAutoVoiceTurn(promptToken);
    } else if (shouldListen) {
      scheduleAutoVoiceTurn(promptToken);
    }
  }

  function userSay(text) { addMessage('user', text); }

  function addMessage(role, text) {
    const wrapper = document.createElement('div');
    wrapper.className = `message ${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    wrapper.append(bubble);
    els.messages.append(wrapper);
    requestAnimationFrame(() => { els.messages.scrollTop = els.messages.scrollHeight; });
  }

  function speak(text, options = {}) {
    if (!('speechSynthesis' in window) || !state.speakerOn) return false;
    try {
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text.replace(/\n/g, ' '));
      utterance.lang = 'ja-JP';
      utterance.rate = 1.03;
      utterance.pitch = 1.0;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (typeof options.onEnd === 'function') options.onEnd();
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      speechSynthesis.speak(utterance);
      return true;
    } catch (err) {
      console.warn('音声読み上げを利用できません。画面表示は継続します。', err);
      return false;
    }
  }

  function shouldAutoVoiceListen() {
    return Boolean(
      state.autoVoiceEnabled &&
      state.inputMode === 'voice' &&
      state.stage !== 'landing' &&
      state.stage !== 'complete' &&
      AUTO_VOICE_STAGES.has(state.stage)
    );
  }

  function cancelAutoVoiceTurn() {
    if (state.autoVoiceTimer) {
      window.clearTimeout(state.autoVoiceTimer);
      state.autoVoiceTimer = null;
    }
  }

  function scheduleAutoVoiceTurn(promptToken = state.autoVoicePromptToken, delayMs = AUTO_VOICE_START_DELAY_MS) {
    if (promptToken !== state.autoVoicePromptToken) return;
    cancelAutoVoiceTurn();
    if (!shouldAutoVoiceListen()) return;
    state.autoVoiceTimer = window.setTimeout(() => {
      state.autoVoiceTimer = null;
      void beginAutoVoiceTurn(promptToken);
    }, delayMs);
  }

  async function beginAutoVoiceTurn(promptToken) {
    if (promptToken !== state.autoVoicePromptToken || !shouldAutoVoiceListen()) return;
    if (state.geminiMicStreaming || state.recognizing) return;
    if ('speechSynthesis' in window && (speechSynthesis.speaking || speechSynthesis.pending)) {
      scheduleAutoVoiceTurn(promptToken, 180);
      return;
    }

    const liveConfig = CONFIG.geminiLive || {};
    if (liveConfig.enabled && state.geminiLive) {
      await ensureGeminiLiveConnection();
      if (promptToken !== state.autoVoicePromptToken || !shouldAutoVoiceListen()) return;
      if (state.geminiLiveReady && state.geminiLive?.isReady()) {
        try {
          await startGeminiAudioCapture();
          return;
        } catch (error) {
          console.warn('[Gemini Live] ハンズフリー音声入力開始失敗', error);
        }
      }
    }

    if (speechRecognitionAvailable()) {
      try { state.recognition.start(); } catch (error) { console.warn(error); }
    }
  }


  function geminiLiveConfigured() {
    return Boolean((CONFIG.geminiLive || {}).enabled && state.geminiLive);
  }

  function initGeminiLiveBridge() {
    const liveConfig = CONFIG.geminiLive || {};
    if (!liveConfig.enabled || typeof window.GeminiLiveBridge !== 'function') return;
    state.geminiLive = new window.GeminiLiveBridge({
      model: liveConfig.model,
      tokenEndpoint: liveConfig.tokenEndpoint,
      voiceName: liveConfig.voiceName,
      onStatus: (status) => {
        if (status.phase === 'ready') {
          state.geminiLiveReady = true;
          state.geminiLiveError = '';
        } else if (status.phase === 'closed') {
          state.geminiLiveReady = false;
          void stopGeminiAudioCapture({ sendEnd: false });
        }
        console.info(`[Gemini Live] ${status.message}`);
      },
      onMessage: handleGeminiLiveMessage
    });
    window.addEventListener('beforeunload', () => {
      void stopGeminiAudioCapture({ sendEnd: false });
      closeGeminiLiveConnection();
    }, { once: true });
  }

  function handleGeminiLiveMessage(message) {
    if (message?.goAway) {
      console.warn('[Gemini Live] goAway', message.goAway);
      showToast('Gemini Live接続更新の準備が必要です');
    }

    const content = message?.serverContent;
    if (!content) return;
    const liveConfig = CONFIG.geminiLive || {};
    const routeOfficialMaster = liveConfig.routeInputToReception === true;
    const suppressModelOutput = liveConfig.suppressModelOutput === true;

    if (content.interrupted) {
      stopGeminiOutputAudio();
    }

    const interimText = normalizeSpace(content.interimInputTranscription?.text || '');
    if (interimText) {
      els.liveTranscript.textContent = interimText;
    }

    // inputTranscription は Gemini Live が確定した利用者発話。
    // STEP10-3では、この確定文字列だけを既存受付ロジックへ渡す。
    const inputText = normalizeSpace(content.inputTranscription?.text || '');
    if (inputText) {
      state.geminiUserTranscript = appendTranscript(state.geminiUserTranscript, inputText);
      els.liveTranscript.textContent = state.geminiUserTranscript;
      if (routeOfficialMaster) scheduleGeminiTranscriptCommit();
    }

    const outputText = normalizeSpace(content.outputTranscription?.text || '');
    if (outputText) {
      state.geminiModelTranscript = appendTranscript(state.geminiModelTranscript, outputText);
      if (!suppressModelOutput) {
        const caption = state.geminiModelTranscript || outputText;
        els.agentCaption.textContent = caption.length > 100 ? `${caption.slice(0, 100)}…` : caption;
      }
    }

    if (!suppressModelOutput && content.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        const inlineData = part?.inlineData;
        if (!inlineData?.data) continue;
        const mimeType = String(inlineData.mimeType || 'audio/pcm;rate=24000');
        if (mimeType.startsWith('audio/')) {
          enqueueGeminiOutputAudio(inlineData.data, parsePcmRate(mimeType) || Number(liveConfig.outputSampleRate) || 24000);
        }
      }
    }

    if (content.turnComplete) {
      if (routeOfficialMaster) {
        // プッシュ・トゥ・トーク中の自然な間では確定させない。
        // マイク停止後だけ受付ロジックへ渡す。
        if (!state.geminiMicStreaming) scheduleGeminiTranscriptCommit();
        state.geminiModelTranscript = '';
        els.voicePrompt.textContent = 'マイクを押してお話しください';
        return;
      }

      const userText = normalizeSpace(state.geminiUserTranscript);
      const modelText = normalizeSpace(state.geminiModelTranscript);
      if (userText) addMessage('user', userText);
      if (modelText) addMessage('bot', modelText);
      state.geminiUserTranscript = '';
      state.geminiModelTranscript = '';
      els.voicePrompt.textContent = 'マイクを押してお話しください';
      if (!state.geminiMicStreaming) {
        els.liveTranscript.textContent = '続けて話す場合は、もう一度マイクを押してください';
        setStatus('Gemini Live 日本語音声テスト完了');
      }
    }
  }

  function scheduleGeminiTranscriptCommit() {
    if (state.geminiTranscriptCommitted || state.geminiMicStreaming) return;
    clearGeminiTranscriptCommitTimer();
    state.geminiTranscriptCommitTimer = window.setTimeout(() => {
      state.geminiTranscriptCommitTimer = null;
      commitGeminiTranscriptToReception();
    }, 420);
  }

  function commitGeminiTranscriptToReception() {
    if (state.geminiTranscriptCommitted) return;
    const finalText = normalizeSpace(state.geminiUserTranscript);
    if (!finalText) return;

    state.geminiTranscriptCommitted = true;
    clearGeminiTranscriptCommitTimer();
    clearGeminiNoSpeechTimer();
    state.autoVoiceRetryCount = 0;
    stopGeminiOutputAudio();
    state.geminiUserTranscript = '';
    state.geminiModelTranscript = '';
    els.liveTranscript.textContent = finalText;
    setStatus('正式マスターで確認しています…');

    // ここから先はSTEP9から維持している決定的な受付ルート。
    // Geminiに講座検索結果を生成させず、正式マスターのみを検索する。
    receiveInput(finalText);
  }

  function clearGeminiTranscriptCommitTimer() {
    if (state.geminiTranscriptCommitTimer) {
      window.clearTimeout(state.geminiTranscriptCommitTimer);
      state.geminiTranscriptCommitTimer = null;
    }
  }

  function appendTranscript(current, next) {
    const a = normalizeSpace(current || '');
    const b = normalizeSpace(next || '');
    if (!a) return b;
    if (!b || a === b || a.endsWith(b)) return a;
    if (b.startsWith(a)) return b;
    return `${a} ${b}`;
  }

  async function ensureGeminiLiveConnection() {
    const liveConfig = CONFIG.geminiLive || {};
    if (!liveConfig.enabled || !state.geminiLive || state.geminiLiveReady || state.geminiLiveConnecting) return;
    state.geminiLiveConnecting = true;
    try {
      await state.geminiLive.connect();
      state.geminiLiveReady = true;
      state.geminiLiveError = '';
      showToast('Gemini Live 接続済み');
    } catch (error) {
      state.geminiLiveReady = false;
      state.geminiLiveError = error?.message || 'Gemini Live接続エラー';
      console.warn('[Gemini Live] STEP10-3 接続に失敗。STEP9音声入力へフォールバックします。', error);
      if (liveConfig.fallbackToStep9Voice !== false) {
        showToast('Gemini Live未接続：STEP9音声入力で継続します');
      }
    } finally {
      state.geminiLiveConnecting = false;
    }
  }

  async function toggleVoiceInput() {
    if(naturalMode()){if(!natural?.active){void startNatural();return;}const on=natural.toggleMic();els.mic.classList.toggle('listening',on);return;}
    cancelAutoVoiceTurn();
    if (!window.isSecureContext) {
      botSay('マイクを使うため、HTTPSまたは localhost から開いてください。チャット入力はそのまま利用できます。', { silent: true });
      switchMode('chat', { silent: true });
      return;
    }

    const liveConfig = CONFIG.geminiLive || {};
    if (liveConfig.enabled && state.geminiLive) {
      if (state.geminiMicStreaming) {
        await stopGeminiAudioCapture({ sendEnd: true });
        return;
      }
      await ensureGeminiLiveConnection();
      if (state.geminiLiveReady && state.geminiLive?.isReady()) {
        try {
          await startGeminiAudioCapture();
          return;
        } catch (error) {
          console.warn('[Gemini Live] マイクストリーミング開始失敗', error);
          showToast('Gemini音声入力を開始できませんでした');
          if (liveConfig.fallbackToStep9Voice === false) return;
        }
      }
    }

    toggleRecognition();
  }

  async function startGeminiAudioCapture() {
    if (state.geminiMicStreaming) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable');
    if (!state.geminiLive?.isReady()) throw new Error('Gemini Live is not ready');

    if ('speechSynthesis' in window) speechSynthesis.cancel();
    stopRecognition();
    stopGeminiOutputAudio();

    const mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      mediaStream.getTracks().forEach((track) => track.stop());
      throw new Error('AudioContext unavailable');
    }

    const audioContext = new AudioContextClass();
    await audioContext.resume();
    const source = audioContext.createMediaStreamSource(mediaStream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const sink = audioContext.createGain();
    sink.gain.value = 0;

    source.connect(processor);
    processor.connect(sink);
    sink.connect(audioContext.destination);

    const liveConfig = CONFIG.geminiLive || {};
    const targetRate = Number(liveConfig.inputSampleRate) || 16000;
    const vadThreshold = Number(liveConfig.vadThreshold) || DEFAULT_VAD_THRESHOLD;
    const silenceMs = Number(liveConfig.silenceMs) || DEFAULT_SILENCE_MS;
    const noSpeechMs = Number(liveConfig.noSpeechMs) || DEFAULT_NO_SPEECH_MS;
    const maxUtteranceMs = Number(liveConfig.maxUtteranceMs) || DEFAULT_MAX_UTTERANCE_MS;

    processor.onaudioprocess = (event) => {
      if (!state.geminiMicStreaming || !state.geminiLive?.isReady()) return;
      const input = event.inputBuffer.getChannelData(0);
      const now = performance.now();
      let sumSquares = 0;
      for (let i = 0; i < input.length; i += 1) sumSquares += input[i] * input[i];
      const rms = Math.sqrt(sumSquares / Math.max(1, input.length));
      if (rms >= vadThreshold) {
        state.geminiVoiceDetected = true;
        state.geminiLastVoiceAt = now;
      }

      const resampled = resampleFloat32(input, audioContext.sampleRate, targetRate);
      if (resampled.length) {
        const pcm16 = float32ToPcm16(resampled);
        state.geminiLive.sendAudioPcmBase64(arrayBufferToBase64(pcm16.buffer), targetRate);
      }

      if (!state.autoVoiceEnabled || state.geminiAutoStopPending) return;
      const elapsed = now - state.geminiCaptureStartedAt;
      if (state.geminiVoiceDetected && state.geminiLastVoiceAt && (now - state.geminiLastVoiceAt) >= silenceMs && elapsed >= 900) {
        requestGeminiAutoStop('silence');
      } else if (!state.geminiVoiceDetected && elapsed >= noSpeechMs) {
        requestGeminiAutoStop('no-speech');
      } else if (elapsed >= maxUtteranceMs) {
        requestGeminiAutoStop('max-duration');
      }
    };

    state.geminiMediaStream = mediaStream;
    state.geminiInputContext = audioContext;
    state.geminiInputSource = source;
    state.geminiInputProcessor = processor;
    state.geminiInputSink = sink;
    state.geminiMicStreaming = true;
    clearGeminiTranscriptCommitTimer();
    clearGeminiNoSpeechTimer();
    state.geminiUserTranscript = '';
    state.geminiModelTranscript = '';
    state.geminiTranscriptCommitted = false;
    state.geminiCaptureStartedAt = performance.now();
    state.geminiLastVoiceAt = 0;
    state.geminiVoiceDetected = false;
    state.geminiAutoStopPending = false;

    els.mic.classList.add('listening');
    els.statusBar.classList.add('listening');
    els.voicePrompt.textContent = state.autoVoiceEnabled ? 'お話しください（話し終えると自動で確定します）' : 'お話しください（もう一度押すと終了）';
    els.liveTranscript.textContent = '日本語音声をGemini Liveへ送信しています';
    setStatus('Gemini Liveで音声を聞き取っています');
  }

  function requestGeminiAutoStop(reason) {
    if (!state.geminiMicStreaming || state.geminiAutoStopPending) return;
    state.geminiAutoStopPending = true;
    window.setTimeout(() => {
      if (!state.geminiMicStreaming) {
        state.geminiAutoStopPending = false;
        return;
      }
      void stopGeminiAudioCapture({ sendEnd: true, reason });
    }, 0);
  }

  function clearGeminiNoSpeechTimer() {
    if (state.geminiNoSpeechTimer) {
      window.clearTimeout(state.geminiNoSpeechTimer);
      state.geminiNoSpeechTimer = null;
    }
  }

  function scheduleNoSpeechRecovery() {
    clearGeminiNoSpeechTimer();
    state.geminiNoSpeechTimer = window.setTimeout(() => {
      state.geminiNoSpeechTimer = null;
      if (state.geminiTranscriptCommitted || normalizeSpace(state.geminiUserTranscript)) return;
      state.autoVoiceRetryCount += 1;
      if (state.autoVoiceRetryCount <= 2 && shouldAutoVoiceListen()) {
        botSay('音声を確認できませんでした。もう一度、少しゆっくりお話しください。');
      } else {
        botSay('音声を確認できませんでした。マイクボタンを押して再度お話しいただくか、チャット入力へ切り替えてください。', { autoListen: false });
        setStatus('音声を確認できませんでした', 'warning');
      }
    }, 1800);
  }

  async function stopGeminiAudioCapture(options = {}) {
    const wasStreaming = state.geminiMicStreaming;
    state.geminiMicStreaming = false;

    if (state.geminiInputProcessor) {
      state.geminiInputProcessor.onaudioprocess = null;
      try { state.geminiInputProcessor.disconnect(); } catch (_) { /* noop */ }
    }
    if (state.geminiInputSource) {
      try { state.geminiInputSource.disconnect(); } catch (_) { /* noop */ }
    }
    if (state.geminiInputSink) {
      try { state.geminiInputSink.disconnect(); } catch (_) { /* noop */ }
    }
    if (state.geminiMediaStream) {
      state.geminiMediaStream.getTracks().forEach((track) => track.stop());
    }
    if (state.geminiInputContext && state.geminiInputContext.state !== 'closed') {
      try { await state.geminiInputContext.close(); } catch (_) { /* noop */ }
    }

    state.geminiMediaStream = null;
    state.geminiInputContext = null;
    state.geminiInputSource = null;
    state.geminiInputProcessor = null;
    state.geminiInputSink = null;
    state.geminiAutoStopPending = false;

    els.mic.classList.remove('listening');
    els.statusBar.classList.remove('listening');
    els.voicePrompt.textContent = 'マイクを押してお話しください';

    if (wasStreaming && options.sendEnd !== false && state.geminiLive?.isReady()) {
      state.geminiLive.endAudioStream();
      if ((CONFIG.geminiLive || {}).routeInputToReception === true) {
        els.liveTranscript.textContent = state.geminiUserTranscript || '音声を文字にしています…';
        setStatus('音声を確定しています…');
        if (state.geminiUserTranscript) scheduleGeminiTranscriptCommit();
        if (options.reason === 'no-speech') scheduleNoSpeechRecovery();
      } else {
        els.liveTranscript.textContent = 'Geminiの返答を待っています…';
        setStatus('Geminiが返答しています…');
      }
    }
  }

  function resampleFloat32(input, sourceRate, targetRate) {
    if (!input?.length || !sourceRate || !targetRate) return new Float32Array(0);
    if (sourceRate === targetRate) return new Float32Array(input);
    const ratio = sourceRate / targetRate;
    const outputLength = Math.max(1, Math.floor(input.length / ratio));
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i += 1) {
      const pos = i * ratio;
      const index = Math.floor(pos);
      const frac = pos - index;
      const a = input[Math.min(index, input.length - 1)] || 0;
      const b = input[Math.min(index + 1, input.length - 1)] || a;
      output[i] = a + ((b - a) * frac);
    }
    return output;
  }

  function float32ToPcm16(input) {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, input[i]));
      output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return output;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const stride = 0x8000;
    for (let i = 0; i < bytes.length; i += stride) {
      binary += String.fromCharCode(...bytes.subarray(i, i + stride));
    }
    return btoa(binary);
  }

  function base64ToInt16(base64) {
    const binary = atob(base64);
    const byteLength = binary.length;
    const buffer = new ArrayBuffer(byteLength);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < byteLength; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Int16Array(buffer);
  }

  function parsePcmRate(mimeType) {
    const match = String(mimeType || '').match(/rate=(\d+)/i);
    return match ? Number(match[1]) : 0;
  }

  async function ensureGeminiOutputContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!state.geminiOutputContext || state.geminiOutputContext.state === 'closed') {
      state.geminiOutputContext = new AudioContextClass();
      state.geminiOutputNextTime = 0;
    }
    if (state.geminiOutputContext.state === 'suspended') {
      try { await state.geminiOutputContext.resume(); } catch (_) { /* noop */ }
    }
    return state.geminiOutputContext;
  }

  async function enqueueGeminiOutputAudio(base64, sampleRate = 24000) {
    if (!state.speakerOn || !base64) return;
    const context = await ensureGeminiOutputContext();
    if (!context) return;

    const pcm = base64ToInt16(base64);
    if (!pcm.length) return;
    const buffer = context.createBuffer(1, pcm.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 32768;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.025, state.geminiOutputNextTime || 0);
    source.start(startAt);
    state.geminiOutputNextTime = startAt + buffer.duration;
    state.geminiOutputSources.add(source);
    source.onended = () => state.geminiOutputSources.delete(source);
  }

  function stopGeminiOutputAudio() {
    state.geminiOutputSources.forEach((source) => {
      try { source.stop(); } catch (_) { /* noop */ }
    });
    state.geminiOutputSources.clear();
    if (state.geminiOutputContext) state.geminiOutputNextTime = state.geminiOutputContext.currentTime;
  }

  function closeGeminiLiveConnection() {
    clearGeminiTranscriptCommitTimer();
    clearGeminiNoSpeechTimer();
    cancelAutoVoiceTurn();
    stopGeminiOutputAudio();
    if (state.geminiLive) state.geminiLive.close();
    state.geminiLiveReady = false;
    state.geminiLiveConnecting = false;
  }

  function initSpeechRecognition() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return;
    const recognition = new Recognition();
    recognition.lang = 'ja-JP';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      state.recognizing = true;
      state.lastSpeechFinal = '';
      els.mic.classList.add('listening');
      els.statusBar.classList.add('listening');
      els.voicePrompt.textContent = 'お話しください…';
      els.liveTranscript.textContent = '音声を聞き取っています';
      setStatus('音声を聞き取っています');
    };

    recognition.onresult = (event) => {
      let interim = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += transcript;
        else interim += transcript;
      }
      if (interim) els.liveTranscript.textContent = interim;
      if (finalText) {
        state.lastSpeechFinal = finalText.trim();
        els.liveTranscript.textContent = state.lastSpeechFinal;
      }
    };

    recognition.onerror = (event) => {
      state.recognitionErrors += 1;
      const recoverable = ['no-speech', 'audio-capture', 'not-allowed', 'service-not-allowed', 'network'].includes(event.error);
      setStatus('音声入力を確認できませんでした', 'warning');
      if (recoverable) {
        botSay('音声をうまく聞き取れませんでした。チャット入力へ切り替えて続けることもできます。', { silent: true });
        if (state.recognitionErrors >= 2 || ['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error)) {
          switchMode('chat', { silent: true });
          showToast('音声入力が難しいため、チャット入力へ切り替えました');
        }
      }
    };

    recognition.onend = () => {
      state.recognizing = false;
      els.mic.classList.remove('listening');
      els.statusBar.classList.remove('listening');
      els.voicePrompt.textContent = 'マイクを押してお話しください';
      if (state.lastSpeechFinal) {
        const finalText = state.lastSpeechFinal;
        state.lastSpeechFinal = '';
        receiveInput(finalText);
      } else if (state.inputMode === 'voice') {
        els.liveTranscript.textContent = 'もう一度マイクを押すか、チャット入力へ切り替えてください';
      }
    };

    state.recognition = recognition;
  }

  function toggleRecognition() {
    if (!speechRecognitionAvailable()) {
      botSay('この環境では音声入力を利用できません。チャット入力に切り替えます。', { silent: true });
      switchMode('chat', { silent: true });
      return;
    }
    if (!window.isSecureContext) {
      botSay('マイクを使うため、HTTPSまたは localhost から開いてください。チャット入力はそのまま利用できます。', { silent: true });
      switchMode('chat', { silent: true });
      return;
    }
    if (state.recognizing) stopRecognition();
    else {
      try { state.recognition.start(); }
      catch (err) { console.warn(err); }
    }
  }

  function stopRecognition() {
    if (state.recognition && state.recognizing) {
      try { state.recognition.stop(); } catch (_) { /* noop */ }
    }
  }

  function speechRecognitionAvailable() { return Boolean(state.recognition); }

  function updateProgress() {
    const group = STAGE_GROUP[state.stage] || 'search';
    const index = GROUPS.indexOf(group);
    $$('#progress li').forEach((li) => {
      const i = GROUPS.indexOf(li.dataset.step);
      li.classList.toggle('active', i === index);
      li.classList.toggle('done', i < index);
    });
  }

  function setStatus(text, type = '') {
    els.statusText.textContent = text;
    els.statusBar.dataset.type = type;
  }

  function showToast(text) {
    els.toast.textContent = text;
    els.toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 2600);
  }

  function cleanSpokenField(value, labels = []) {
    let text = normalizeSpace(value);
    for (const label of labels) {
      text = text.replace(new RegExp(`^(?:私の)?${label}(?:は|が)?\s*`, 'i'), '');
    }
    return text
      .replace(/(?:です|でございます|になります)[。．.!！]?$/u, '')
      .replace(/[。．.!！]+$/u, '')
      .trim();
  }

  function normalizeSpokenPhone(value) {
    let text = String(value || '').normalize('NFKC').toLowerCase();
    text = text
      .replace(/(?:所属の)?電話番号(?:は|が)?/g, '')
      .replace(/連絡先(?:は|が)?/g, '')
      .replace(/番号(?:は|が)?/g, '')
      .replace(/(?:です|になります|です。|お願いします)/g, '')
      .replace(/ハイフン|マイナス|の/g, ' ');

    const digitWords = [
      ['ゼロ', '0'], ['れい', '0'], ['レイ', '0'], ['まる', '0'], ['マル', '0'],
      ['いち', '1'], ['イチ', '1'],
      ['に', '2'], ['ニ', '2'],
      ['さん', '3'], ['サン', '3'],
      ['よん', '4'], ['ヨン', '4'],
      ['ご', '5'], ['ゴ', '5'],
      ['ろく', '6'], ['ロク', '6'],
      ['なな', '7'], ['ナナ', '7'], ['しち', '7'], ['シチ', '7'],
      ['はち', '8'], ['ハチ', '8'],
      ['きゅう', '9'], ['キュウ', '9'], ['きゅー', '9'], ['キュー', '9']
    ];
    for (const [word, digit] of digitWords) text = text.split(word).join(digit);
    return normalizePhone(text);
  }

  function normalizeForSearch(value) { return CORE.normalizeForSearch(value); }
  function normalizeSpace(value) { return CORE.normalizeSpace(value); }
  function normalizePhone(value) { return CORE.normalizePhone(value); }
  function formatPhoneDisplay(digits) { return digits; }
  function formatDate(iso) { return CORE.formatDate(iso); }
  function isDeadlinePast(iso) { return CORE.isDeadlinePast(iso); }
  function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  boot();
})();
