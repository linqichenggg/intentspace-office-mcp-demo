const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const locale = query.get('lang') === 'en' ? 'en' : 'ja';
const en = locale === 'en';
const replayMode = location.pathname === '/arrival-replay';
const strings = en ? {
  admin:'Admin',consentContinue:'Continue to Google',consentCancel:'Back',
  modes:'Display mode',officeNavigation:'Office pages',
  consentCloud:'IntentSpace reads event titles, times and meeting details from your primary Google calendar to display schedules and suggest spaces. Calendar content is processed in your browser’s workspace. You can disconnect from this page. Google Calendar remains read-only.',
  consentLocal:'IntentSpace reads your primary calendar to display schedules and suggest spaces. When you request recommendations, event information needed for analysis is sent to the configured OpenAI account. You can disconnect from this page. Google Calendar remains read-only.',
  schedule:'Next day’s schedule',scheduleLoading:'Loading schedule…',scheduleEmpty:'No events scheduled.',
  scheduleError:'The schedule could not be loaded.',allDay:'All day',
  heading:'Today’s suggestions',manual:'Plan manually',calendar:'Calendar',connect:'Connect Google Calendar',disconnect:'Disconnect',
  simulation:'Arrival simulation',clock:'Simulated time ',enter:'Simulate employee A arriving',demo:'Sample calendar',
  linked:'Google Calendar connected',reconnect:'Reconnect Google Calendar',waiting:'Waiting for arrival',
  waitingHint:'After you arrive, your schedule will guide seat and room suggestions.',
  stale:'Meeting details updated',staleHint:'Update suggestions to use your saved changes.',update:'Update suggestions',
  supplement:'Add meeting details',linkedReview:'Review your existing booking in manual planning.',
  analyzing:'Reading today’s calendar',analyzingHint:'Checking your schedule and available spaces.',
  ready:'Suggestions are ready',empty:'No suggested bookings for today',arrived:'Arrival at ',
  sampleSuffix:' · Sample calendar',googleSuffix:' · Google Calendar',expired:'Suggestions expired',
  expiredHint:'Simulate another arrival to check availability again.',error:'Suggestions could not be generated',
  errorHint:'Check the calendar connection or simulate another arrival.',seat:'Seat',room:'Meeting room',
  confirmed:'Booked',confirm:'Confirm booking',choice:'Space',next:'Before the next event',free:'Available in the simulation',
  noSlot:'No space is available for this time.',needsInput:'Check the attendee count and whether the meeting needs a room.',
  existing:'An existing booking matches this event.',connectFailed:'Google Calendar could not be connected.',
  google_auth:'Google Calendar access has expired. Reconnect it and try again.',
  google_config:'Google Calendar connection is unavailable at this address.',
  arrival_changed:'The calendar or workspace changed. Simulate arrival again to refresh the suggestions.',
  arrival_agent_unconfigured:'Set the server’s OpenAI Key to analyze the connected Google Calendar.',
  conflict:'This space or time changed. Simulate arrival again to refresh availability.',
  more:'Check Google Calendar for the remaining events.',google_unavailable:'Google Calendar could not be reached. Try again.',
  failed:'The request failed. Try again.',
  replayTitle:'Entry log replay',replayEvents:'Door events',replayPlay:'Play',replayPause:'Pause',
  replayResume:'Continue to the next entry',replayDone:'Replay complete',replayReset:'Reset replay',
  replayWaiting:'Play the log to trigger a seat suggestion automatically when employee A arrives.',
  replayFirst:'Employee A arrived. Seat suggestion triggered.',
  replayAgain:'Employee A returned. The first suggestion was kept.',
  replaySuffix:' · Historical door log · Sample calendar',
  replaySampleSuffix:' · Simulated door log · Sample calendar',
  replayPast:'This suggested slot has passed in the replay.',
  replay_unavailable:'The selected entry logs could not be loaded on this computer.',
  replay_arrival_failed:'The arrival could not be processed. Reset the replay and try again.',
  replay_confirmation_closed:'Confirm the booking at the first arrival pause.'
} : {
  admin:'管理者',consentContinue:'Google で続ける',consentCancel:'戻る',
  modes:'表示モード',officeNavigation:'オフィス画面',
  consentCloud:'主カレンダーの件名・時刻・会議情報を、予定表示と場所の提案に使います。予定の情報はこのブラウザーのワークスペース内で処理します。この画面で接続を解除できます。Google Calendar は読み取り専用です。',
  consentLocal:'主カレンダーの予定を、予定表示と場所の提案に使います。提案を依頼すると、分析に必要な予定情報を設定済みの OpenAI アカウントに送信します。この画面で接続を解除できます。Google Calendar は読み取り専用です。',
  schedule:'次の予定',scheduleLoading:'カレンダーを確認しています。',scheduleEmpty:'予定はありません。',
  scheduleError:'カレンダーの予定を読み込めませんでした。',allDay:'終日',
  heading:'今日の提案',manual:'手動で予定を組む',calendar:'カレンダー',connect:'Google Calendar を接続',disconnect:'接続を解除',
  simulation:'入室シミュレーション',clock:'模擬時刻 ',enter:'社員 A を入室させる',demo:'サンプル日程',
  linked:'Google Calendar 接続済み',reconnect:'Google Calendar を再接続',waiting:'入室を待っています',
  waitingHint:'入室後、日程に合わせて席と会議室を提案します。',
  stale:'予定の条件が更新されました',staleHint:'保存した条件で提案を更新してください。',update:'提案を更新する',
  supplement:'予定の条件を補う',linkedReview:'手動画面で現在の予約内容を確認してください。',
  analyzing:'今日の予定を確認しています',analyzingHint:'日程とスペースの空きを調べています。',
  ready:'提案が届きました',empty:'今日の予約提案はありません',arrived:'入室 ',
  sampleSuffix:' ・ サンプル日程',googleSuffix:' ・ Google Calendar',expired:'提案の有効期限が切れました',
  expiredHint:'もう一度入室をシミュレーションして、空きを確認してください。',error:'提案を作成できませんでした',
  errorHint:'カレンダーの接続を確認するか、もう一度入室をシミュレーションしてください。',seat:'個人席',room:'会議室',
  confirmed:'予約済み',confirm:'確認して予約',choice:'スペース',next:'次の予定まで',free:'この時間帯に空きがあります（模擬）',
  noSlot:'この時間帯に空きがありません。',needsInput:'参加人数や開催方法など、会議室の提案に必要な条件を確認してください。',
  existing:'この予定に合う予約がすでにあります。',connectFailed:'Google Calendar に接続できませんでした。',
  google_auth:'Google Calendar の認証が切れました。再接続してください。',
  google_config:'Google Calendar の接続設定を確認してください。',
  arrival_changed:'予定または予約状況が変わりました。もう一度入室して提案を更新してください。',
  arrival_agent_unconfigured:'接続した日程を分析するには、本機の OpenAI Key を設定してください。',
  conflict:'空き状況が変わりました。もう一度入室して提案を更新してください。',
  more:'残りの予定は Google Calendar で確認してください。',google_unavailable:'Google Calendar にアクセスできませんでした。もう一度お試しください。',
  failed:'処理に失敗しました。もう一度お試しください。',
  replayTitle:'入室ログ再生',replayEvents:'入室記録',replayPlay:'再生する',replayPause:'一時停止',
  replayResume:'次の入室まで再生',replayDone:'再生完了',replayReset:'再生をリセット',
  replayWaiting:'再生すると、社員 A の入室時に自動で座席が提案されます。',
  replayFirst:'社員 A が入室。座席を提案しました。',
  replayAgain:'社員 A が再入室。最初の提案を維持しました。',
  replaySuffix:' ・ 実データの入室ログ ・ サンプル日程',
  replaySampleSuffix:' ・ 模擬入室ログ ・ サンプル日程',
  replayPast:'再生時刻がこの提案の時間帯を過ぎました。',
  replay_unavailable:'このパソコンで対象の入室ログを読み込めませんでした。',
  replay_arrival_failed:'入室を処理できませんでした。再生をリセットしてください。',
  replay_confirmation_closed:'最初の入室で一時停止したときに予約を確認してください。'
};
const api = replayMode ? '/api/office/arrival-replay' : '/api/office/proactive';
let state;
let busy = false, requestingSuggestions = false;
let stateRead;
let renderedCards = '';
let renderedReplayEvents = '';
let scheduleKey = '', scheduleRequest = 0;
const selected = new Map();
const errorMessage = code => {
  if (code === 'google_authorization') return strings.google_auth;
  if (['room_conflict','personal_conflict','state_changed','past_time','plan_expired'].includes(code)) return strings.conflict;
  return strings[code] ?? strings.failed;
};

document.documentElement.lang = locale;
document.title = (replayMode?strings.replayTitle:strings.heading) + ' | IntentSpace';
for (const [id,key] of Object.entries({arrivalHeading:'heading',manualLink:'manual',sourceHeading:'calendar',
  connectGoogle:'connect',disconnectGoogle:'disconnect',simulationHeading:'simulation',simulateArrival:'enter',
  nextScheduleHeading:'schedule',nextScheduleStatus:'scheduleLoading',homeAdminLink:'admin',
  calendarConsentTitle:'connect',consentContinue:'consentContinue',consentCancel:'consentCancel'})) {
  $(id).textContent = strings[key];
}
$('clockLabel').firstChild.textContent = strings.clock;
function manualUrl(date,eventId) {
  const params = new URLSearchParams({lang:locale});
  if(date)params.set('calendar',date);
  if(eventId)params.set('event',eventId);
  return '/office.html?'+params;
}
$('manualLink').href = manualUrl();
$('homeAdminLink').href = '/admin?lang='+locale;
$('arrivalModes').setAttribute('aria-label',strings.modes);
$('arrivalActions').setAttribute('aria-label',strings.officeNavigation);
$('arrivalBrand').href = '/?lang='+locale;
$('arrivalTodayLink').href = $('arrivalBrand').href;
$('arrivalTodayLink').textContent = strings.heading;
$('arrivalReplayLink').href = '/arrival-replay?lang='+locale;
$('arrivalReplayLink').textContent = strings.replayTitle;
$(replayMode?'arrivalReplayLink':'arrivalTodayLink').setAttribute('aria-current','page');
$('arrivalModes').hidden = false;
if (replayMode) {
  document.body.classList.add('arrivalReplay');
  $('arrivalHeading').textContent = strings.replayTitle;
  $('simulationHeading').textContent = strings.simulation;
  $('arrivalHint').textContent = strings.replayWaiting;
  $('simulateArrival').textContent = strings.replayPlay;
  $('replayTimelineHeading').textContent = strings.replayEvents;
  $('resetArrivalReplay').textContent = strings.replayReset;
  for (const id of ['calendarControls','nextSchedule']) $(id).hidden = true;
  for (const id of ['replayTimeline','replayGate','resetArrivalReplay']) $(id).hidden = false;
}

function notify(message = '') {
  $('arrivalError').textContent = message;
  $('arrivalError').hidden = !message;
}

async function call(path = '', body) {
  const response = await fetch(api+path,body === undefined ? {cache:'no-store'} : {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content) element.textContent = content;
  return element;
}

function renderSchedule(schedule, status) {
  const date = $('nextScheduleDate');
  date.hidden = !schedule;
  if (schedule) {
    date.dateTime = schedule.date;
    date.textContent = new Intl.DateTimeFormat(en?'en':'ja',{
      month:'short',day:'numeric',weekday:'short',timeZone:'UTC'
    }).format(new Date(schedule.date+'T00:00:00Z'));
  }
  $('nextScheduleStatus').hidden = !status;
  $('nextScheduleStatus').textContent = status ?? '';
  const list = $('nextScheduleEvents');
  const events = schedule?.events ?? [];
  list.hidden = events.length === 0;
  list.replaceChildren(...events.map(event=>{
    const row = node('li');
    const time = node('span','nextScheduleTime',event.all_day?strings.allDay:event.time+'–'+event.end_time);
    row.append(time,node('span','',event.title));
    return row;
  }));
}

async function refreshSchedule(force = false) {
  const key = [state.clock.date,state.google.connected,state.google.reauthorize].join(':');
  if (!force && key === scheduleKey) return;
  if (key !== scheduleKey) renderSchedule(null,strings.scheduleLoading);
  scheduleKey = key;
  const request = ++scheduleRequest;
  try {
    const schedule = await call('/next-calendar');
    if (request === scheduleRequest && schedule.today === state.clock.date)
      renderSchedule(schedule,schedule.events.length?null:strings.scheduleEmpty);
  } catch {
    if (request === scheduleRequest) renderSchedule(null,strings.scheduleError);
  }
}

function renderCards() {
  const cards = state.cards ?? [];
  const key = JSON.stringify([state.plan_id,cards,state.replay?.finished]);
  if (renderedCards === key) return;
  renderedCards = key;
  $('arrivalCards').replaceChildren(...cards.map(card => {
    const article = node('article','arrivalCard');
    article.dataset.kind = card.kind;
    const head = node('header','arrivalCardHeader');
    const times = node('span','arrivalTimes',card.time+'–'+card.end_time);
    const kind = node('span','arrivalKind',card.kind === 'desk' ? strings.seat : strings.room);
    head.append(times,kind);
    const title = node('h3','',card.title);
    article.append(head,title);
    if (card.status === 'confirmed') {
      article.append(node('p','arrivalBooked',strings.confirmed+' · '+card.booking.name));
      return article;
    }
    if (state.replay?.finished && card.status === 'proposed') {
      article.append(node('p','arrivalBasis',strings.replayPast));
      return article;
    }
    if (card.status !== 'proposed') {
      const linkedReview=card.issues.includes('calendar_booking_changed');
      const messages = {needs_input:linkedReview?strings.linkedReview:strings.needsInput,existing:strings.existing};
      article.append(node('p','arrivalBasis',messages[card.status] ?? strings.noSlot));
      if(card.status==='needs_input'&&card.event_id&&!linkedReview){
        const link=node('a','arrivalLink',strings.supplement);
        link.href=manualUrl(state.arrival.date,card.event_id);
        article.append(link);
      }
      return article;
    }
    const reason = card.next_event
      ? strings.next+' · '+card.next_event.time+' '+card.next_event.title
      : strings.free;
    article.append(node('p','arrivalBasis',reason));
    const actions = node('div','arrivalCardActions');
    const label = node('label','',strings.choice);
    const list = node('select');
    for (const candidate of card.candidates) {
      const option = node('option','',candidate.name+(card.kind === 'meeting' ? ' · '+candidate.capacity+(en?' people':'人') : ''));
      option.value = candidate.id;
      list.append(option);
    }
    if (card.candidates.some(candidate => candidate.id === selected.get(card.id))) list.value = selected.get(card.id);
    list.addEventListener('change',()=>selected.set(card.id,list.value));
    label.append(list);
    const button = node('button','primary',strings.confirm);
    button.dataset.confirmArrival = '';
    button.addEventListener('click',()=>perform(async()=>{
      await call('/confirm',{plan_id:state.plan_id,proposal_id:card.id,space_id:list.value,confirmed:true});
      await refresh();
    }));
    actions.append(label,button);
    article.append(actions);
    return article;
  }));
}

function render() {
  if (!state) return;
  const arrival = state.arrival;
  const phase = requestingSuggestions?'analyzing':state.status;
  $('officeDate').textContent = state.clock.date;
  $('officeClock').textContent = state.clock.time;
  $('arrivalStatusPanel').dataset.phase = phase;
  const heading = phase === 'ready' && !state.cards?.length ? strings.empty : strings[phase];
  if ($('arrivalStatus').textContent !== heading) $('arrivalStatus').textContent = heading;
  const source = replayMode
    ? (state.replay.source === 'synthetic' ? strings.replaySampleSuffix : strings.replaySuffix)
    : (arrival?.source === 'google' ? strings.googleSuffix : strings.sampleSuffix);
  const hint = phase === 'ready'
    ? strings.arrived+arrival.time+source+(state.more_events ? ' '+strings.more : '')
    : phase === 'error' ? (state.error ? errorMessage(state.error) : strings.errorHint)
    : replayMode && phase === 'waiting' ? strings.replayWaiting : strings[phase+'Hint'];
  if ($('arrivalHint').textContent !== hint) $('arrivalHint').textContent = hint;
  if (replayMode) {
    renderReplay();
    renderCards();
    for (const button of document.querySelectorAll('[data-confirm-arrival]'))
      button.disabled = busy || !state.replay.can_confirm;
    return;
  }
  const {google} = state;
  $('manualLink').href = manualUrl(google.connected?state.clock.date:null);
  $('simulateArrival').textContent = state.status==='stale'?strings.update:strings.enter;
  $('calendarSource').textContent = google.connected ? strings.linked : google.reauthorize ? strings.reconnect : strings.demo;
  $('connectGoogle').hidden = !google.configured || google.connected;
  $('disconnectGoogle').hidden = !google.connected && !google.reauthorize;
  $('simulateArrival').disabled = busy || phase === 'analyzing';
  $('connectGoogle').disabled = busy || phase === 'analyzing';
  $('disconnectGoogle').disabled = busy || phase === 'analyzing';
  renderCards();
  void refreshSchedule();
  for (const button of document.querySelectorAll('[data-confirm-arrival]')) button.disabled = busy;
}

function renderReplay() {
  const {replay} = state;
  $('replayGate').textContent = replay.source === 'synthetic'
    ? replay.gate + (en?' · Simulated door log':' ・ 模擬入室ログ') : replay.gate;
  $('simulateArrival').textContent = replay.finished ? strings.replayDone
    : replay.playing ? strings.replayPause : replay.entries.length ? strings.replayResume : strings.replayPlay;
  $('simulateArrival').disabled = busy || replay.finished || state.status === 'analyzing' || state.status === 'error';
  $('resetArrivalReplay').disabled = busy;
  const eventsKey = JSON.stringify(replay.entries);
  if (eventsKey === renderedReplayEvents) return;
  renderedReplayEvents = eventsKey;
  $('replayEvents').replaceChildren(...replay.entries.map(event=>{
    const row = node('li');
    row.append(node('time','nextScheduleTime',event.time.slice(0,8)),
      node('span','',event.suggestion_triggered?strings.replayFirst:strings.replayAgain));
    return row;
  }));
}

function refresh() {
  if (!stateRead) {
    stateRead = call().then(data=>{state = data;render();}).finally(()=>{stateRead = undefined;});
  }
  return stateRead;
}

async function perform(action) {
  if (busy) return;
  busy = true;
  notify();
  render();
  try {
    if (stateRead) await stateRead.catch(()=>{});
    await action();
  } catch (error) {
    notify(errorMessage(error.message));
  } finally {
    busy = false;
    render();
  }
}

$('simulateArrival').addEventListener('click',()=>perform(async()=>{
  if (replayMode) {
    state = await call(state.replay.playing?'/pause':'/play',{locale});
    return;
  }
  selected.clear();
  requestingSuggestions=true;render();
  try{
    state = state?.status==='stale'
      ? await call('/refresh',{locale})
      : await call('/arrival',{event_id:crypto.randomUUID(),employee_id:'A',direction:'enter',locale});
  }finally{requestingSuggestions=false;}
}));
$('resetArrivalReplay').addEventListener('click',()=>perform(async()=>{
  selected.clear();
  state = await call('/reset',{});
}));
$('connectGoogle').addEventListener('click',()=>{
  $('calendarConsentText').textContent=state.deployment==='cloud'?strings.consentCloud:strings.consentLocal;
  $('calendarConsent').showModal();
});
$('consentCancel').addEventListener('click',()=>$('calendarConsent').close());
$('consentContinue').addEventListener('click',()=>perform(async()=>{
  $('calendarConsent').close();
  const result = await call('/google/connect',{locale});
  location.assign(result.url);
}));
$('disconnectGoogle').addEventListener('click',()=>perform(async()=>{
  state = await call('/google/disconnect',{});
}));
if (query.get('google') === 'error') notify(strings.connectFailed);
if (query.has('google')) history.replaceState(null,'',en?'/?lang=en':'/');
refresh().catch(error=>{notify(errorMessage(error.message));if(!replayMode)renderSchedule(null,strings.scheduleError);});
document.addEventListener('visibilitychange',()=>{
  if (document.hidden) return;
  const previous = scheduleKey;
  refresh().then(()=>{if (!replayMode && scheduleKey === previous) void refreshSchedule(true);})
    .catch(error=>notify(errorMessage(error.message)));
});
setInterval(()=>{
  if (!document.hidden && !busy && (!replayMode || state?.replay.playing))
    refresh().catch(error=>notify(errorMessage(error.message)));
},replayMode?300:2000);
