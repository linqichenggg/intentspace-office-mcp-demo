import { ApiSession, ReviewComparison } from './session.js';
import { applyLanguage, translator, reservationStatusLabel } from './ui-i18n.js';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const apiSession = new ApiSession();
const comparison = new ReviewComparison();
const demoComparison = new ReviewComparison();
let locale = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'ja';
let t = translator(locale);
const admin = location.pathname === '/admin';
let workspace = null, plan = null, agendaTab = 'proposals', agendaIndex = 0, pane = 'plan';
let selectedBookingId=null;
let adminTab = 'live', adminPage = 0, adminData = null, adminTrace = null, historyGeneration = 0;
let working = false, disposed = false, generation = 0, operation = null, poll = null;
let detail = {title:'',text:'',page:0}, editing = null, demoStep = -1;
let attendanceEditing=null;
let liveFilters=null,liveData=null,liveGeneration=0,adminEditing=null,adminDeleting=null;
let notice = {key:'ready',error:false}, chatText = '', chatTrace = null;

async function http(path, {body, headers = {}, signal, method = body === undefined ? 'GET' : 'POST'} = {}) {
  const response = await fetch(path,{method,cache:'no-store',headers:{'Content-Type':'application/json',...headers},
    ...(body === undefined ? {} : {body:JSON.stringify(body)}),signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(70000)]) : AbortSignal.timeout(70000)});
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || 'genericError');error.status=response.status;throw error; }
  return result;
}
const api = (path, options) => http('/api/office/'+path,options);
function tell(key,error=false) { notice={key,error};$('notice').textContent=t(key);$('notice').classList.toggle('error',error); }
function showError(error) {
  const key = error.status === 401 || /Key|API 設定/.test(error.message) ? 'keyRequired'
    : /利用上限|残高/.test(error.message) ? 'api_limit'
    : /OpenAI に接続/.test(error.message) ? 'api_network'
    : /モデル名、アクセス権/.test(error.message) ? 'invalid_model' : error.message;
  tell(inKey() ? key : 'genericError',true);
  function inKey(){ return t(key)!==key; }
}
function lock(value) {
  working=value;
  document.querySelectorAll('#intentForm button,#intentForm select,#intentForm textarea,#agendaContent button,#agendaContent select,#adminAskForm button,#adminQuery input,#adminQuery button,#liveQuery input,#liveQuery select,#liveQuery button,#adminEditForm input,#adminEditForm select,#adminEditForm button,#editForm input,#editForm select,#editForm button,#adminDeleteConfirm,[data-admin],#adminRefresh,#reviewDemo,#keyForm button:not(#clearKey),#parserMode,#proposalsTab,#bookingsTab,[data-close]').forEach(el=>{el.disabled=value;});
  $('attendanceForm').querySelectorAll('input,select,button').forEach(el=>{el.disabled=value;});
  $('parseButton').textContent=t(value?'busy':'analyse');
  if(!value){if(adminEditing?.record?.source==='preset')$('adminAssigned').disabled=true;if($('editDialog').open)editorMode();renderAdmin();}
}
async function perform(action) {
  if(working)return;
  lock(true);
  try{await action();}catch(error){
    if(!disposed&&error.name!=='AbortError'){
      if(error.status===409||error.status===404){try{await sync();}catch{ /* Keep the original actionable error. */ }}
      showError(error);
    }
  }
  finally{if(!disposed){lock(false);renderAgenda();}}
}
function textPages(text, availableHeight = innerHeight - 190) {
  const columns=Math.max(20,Math.floor((Math.min(620,innerWidth-30)-48)/7));
  const maxLines=Math.max(4,Math.floor(availableHeight/24));
  const pages=[];let chunk='',line=1,column=0;
  for(const character of String(text)){
    const width=/[^\u0000-\u00ff]/.test(character)?2:1;
    const nextColumn=character==='\n'?0:column+width;
    const nextLine=line+(character==='\n'||nextColumn>columns?1:0);
    if(nextLine>maxLines&&chunk){pages.push(chunk);chunk='';line=1;column=0;}
    chunk+=character;
    if(character==='\n'){line++;column=0;}else if(column+width>columns){line++;column=width;}else column+=width;
  }
  if(chunk||!pages.length)pages.push(chunk);
  return pages;
}
function renderDetail() {
  const pages=textPages(detail.text);detail.page=Math.min(detail.page,pages.length-1);
  $('detailTitle').textContent=detail.title;$('detailText').textContent=pages[detail.page];
  $('detailPage').textContent=(detail.page+1)+' / '+pages.length;
  $('detailPrevious').disabled=detail.page===0;$('detailNext').disabled=detail.page===pages.length-1;
}
function showDetail(title, value) {
  detail={title,text:typeof value==='string'?value:JSON.stringify(value,null,2),page:0};
  renderDetail();if(!$('detailDialog').open)$('detailDialog').showModal();
}
function setupLanguage() {
  t=translator(locale);applyLanguage(locale);$('language').value=locale;
  document.title='IntentSpace / '+t(admin?'admin':'employee');
  $('employeeLink').href='/office.html?lang='+locale;$('adminLink').href='/admin?lang='+locale;
  document.querySelector('.brand').href='/office.html?lang='+locale;
  document.querySelector('.skip').href=admin?'#adminTitle':'#intent';
  $('adminTitle').tabIndex=-1;
  $('employeeLink').classList.toggle('active',!admin);$('adminLink').classList.toggle('active',admin);
  $('employeeView').hidden=admin;$('adminView').hidden=!admin;$('mobileTabs').hidden=admin;
  $('notice').textContent=t(notice.key);
  $('keyStatus').textContent=t(apiSession.configured?'keyReady':'noKey');
  $('keyBadge').textContent=t(apiSession.configured?'withKey':'noKey');
  $('keyBadge').classList.toggle('connected',apiSession.configured);
  if(workspace)$('today').textContent=workspace.today;
  renderAgenda();renderMap();renderAdmin();renderMobile();
  if($('detailDialog').open)renderDetail();
  if(adminEditing&&$('adminEditDialog').open){
    $('adminEditTitle').textContent=t(adminEditing.record?'editReservation':'newReservation');
    renderAdminFeatures([...$('adminFeatures').querySelectorAll('input:checked')].map(el=>el.value));
  }
  if(adminDeleting&&$('adminDeleteDialog').open)renderAdminDelete();
}
function renderMobile() {
  document.querySelectorAll('[data-mobile-pane]').forEach(el=>el.classList.toggle('mobileActive',el.dataset.mobilePane===pane));
  document.querySelectorAll('[data-pane]').forEach(el=>el.classList.toggle('active',el.dataset.pane===pane));
}
function localisedIssue(issue) { return t(issue) !== issue ? t(issue) : locale==='en' && /[ぁ-んァ-ン一-龯]/.test(issue) ? t('needsReview') : issue; }
function facts(item, request) {
  const date=request?.date ?? item.date;
  const time=request ? request.time+'–'+endOf(request) : item.time ? item.time+(item.duration?'–'+endOf(item):'') : (item.window_start??'?')+'–'+(item.window_end??'?');
  return '<div class="facts"><div><small>'+t('date')+'</small>'+escape(date)+'</div><div><small>'+t('time')+'</small>'+escape(time)+'</div><div><small>'+t('people')+'</small>'+escape(item.people??'?')+'</div><div><small>'+t('duration')+'</small>'+escape(item.duration??'?')+'</div></div>';
}
function endOf(r) {const value=Number(r.time.slice(0,2))*60+Number(r.time.slice(3))+r.duration;return String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0');}
function meetingState(record){return record.source==='attendance'&&record.status==='reserved'?'attending':record.status;}
function renderAgenda() {
  $('proposalsTab').classList.toggle('active',agendaTab==='proposals');$('bookingsTab').classList.toggle('active',agendaTab==='bookings');
  const items=agendaTab==='proposals' ? plan?.proposals??[] : workspace?.meetings??[];
  if(agendaTab==='bookings'&&selectedBookingId){const index=items.findIndex(m=>m.id===selectedBookingId);if(index>=0)agendaIndex=index;}
  agendaIndex=Math.max(0,Math.min(agendaIndex,items.length-1));
  $('agendaPage').textContent=items.length?(agendaIndex+1)+' / '+items.length:'0 / 0';
  $('agendaPrevious').disabled=!items.length||agendaIndex===0||working;$('agendaNext').disabled=agendaIndex>=items.length-1||working;
  const item=items[agendaIndex];
  if(agendaTab==='bookings')selectedBookingId=item?.id??null;
  if(!item){$('agendaContent').innerHTML='<div class="empty"><span class="emptyGlyph" aria-hidden="true">▦</span><p>'+t(agendaTab==='proposals'?'noPlan':'empty')+'</p></div>';return;}
  if(agendaTab==='bookings'){
    const actions=item.status==='reserved'?'<button class="primary" data-meeting-action="start">'+t('start')+'</button><button data-meeting-action="cancel">'+t(item.source==='attendance'?'withdrawAttendance':'cancel')+'</button>'
      :item.status==='in_progress'?'<button class="primary" data-meeting-action="finish">'+t('finish')+'</button>'
      :item.status==='cancelled'?item.source==='attendance'?'<button class="primary" data-attendance-record="'+escape(item.id)+'">'+t('registerAgain')+'</button>':'<button class="primary" data-rebook="'+escape(item.id)+'">'+t('rebook')+'</button>':'';
    $('agendaContent').innerHTML='<article class="agendaCard"><span class="statePill">'+t(meetingState(item))+'</span><h3 class="cardTitle">'+escape(item.title)+'</h3>'+facts({...item,duration:item.request.duration},item.request)+'<p class="equipment">'+escape(item.name)+' / '+item.request.features.map(f=>escape(t(f))).join(', ')+'</p>'+(item.source==='attendance'?'<p class="cardBody">'+t('attendanceSource')+'</p>':'')+'<div class="cardActions">'+actions+'<button data-details="booking">'+t('details')+'</button></div></article>';
  }else{
    const a=item.activity;
    const currentRecords=[...(workspace?.reservations??[]),...(workspace?.meetings??[])];
    const linked=currentRecords.findLast(m=>m.plan_id===plan.plan_id&&m.proposal_id===item.id)
      ??(item.existing&&currentRecords.find(m=>m.id===item.existing.id));
    const missing=Boolean(linked&&(linked.deleted||linked.assigned_to==='other')||item.existing&&!linked);
    const done=missing?null:linked;
    const state=missing?'record_changed':done?meetingState(done):item.status;
    let actions='<button data-edit>'+t('edit')+'</button>';
    let body=(item.issues??[]).map(localisedIssue).join(' ');
    if(missing){actions='<button class="primary" data-replan>'+t('retrySuggestions')+'</button>'+actions;body=t('record_changed');}
    else if(done?.status==='cancelled'){
      actions=(done.source==='attendance'?'<button class="primary" data-attendance-record="'+escape(done.id)+'">'+t('registerAgain')+'</button>':'<button class="primary" data-rebook="'+escape(done.id)+'">'+t('rebook')+'</button>')+'<button data-view-booking="'+escape(done.id)+'">'+t('bookings')+'</button>';
      body=t(done.source==='attendance'?'attendanceRemoved':'rebookHint');
    }else if(item.status==='proposed'&&!done){
      actions='<select class="roomChoice" id="roomChoice" aria-label="'+t('room')+'">'+item.candidates.map(r=>'<option value="'+escape(r.id)+'">'+escape(r.name)+' / '+r.capacity+'</option>').join('')+'</select><button class="primary" data-confirm>'+t('confirm')+'</button>'+actions;
    }else if(item.status==='existing'||item.status==='possible_duplicate'){
      body=done.name+' / '+done.time+'–'+done.end_time;
      actions='<button class="primary" data-reuse="'+escape(done.id)+'">'+t('reuse')+'</button>'+(item.status==='possible_duplicate'?'<button data-distinct>'+t('distinct')+'</button>':'');
    }else if(done){actions='<button class="primary" data-view-booking="'+done.id+'">'+t('bookings')+'</button>';}
    if(item.status==='note'){actions='';body=t(a.type);}
    if(item.status==='duplicate_in_plan'){actions='<button data-original>'+t('viewOriginal')+'</button>';body=t('duplicate_in_plan');}
    if(item.status==='no_slot'&&!done&&!missing){body=t('no_slot_help');actions='<button class="primary" data-replan>'+t('retrySuggestions')+'</button>'+actions;}
    if(a.type==='meeting'&&!done&&!missing&&item.status!=='duplicate_in_plan')actions+='<button data-attendance>'+t('notMyBooking')+'</button>';
    $('agendaContent').innerHTML='<article class="agendaCard"><span class="statePill '+(['no_slot','needs_input','possible_duplicate'].includes(state)?'warning':'')+'">'+t(state)+'</span><h3 class="cardTitle">'+escape(a.title)+'</h3>'+facts(a,item.request)+'<p class="equipment">'+a.features.map(f=>escape(t(f))).join(', ')+'</p><p class="cardBody">'+escape(body)+'</p><div class="cardActions">'+actions+'<button data-details="proposal">'+t('details')+'</button></div></article>';
  }
  if(agendaTab==='bookings')$('agendaContent').querySelectorAll('button').forEach(button=>{button.dataset.bookingId=item.id;});
  $('agendaContent').querySelectorAll('button,select').forEach(el=>{el.disabled=working;});
}
function renderMap() {
  if(!workspace)return;
  $('worldClock').textContent=workspace.clock.date+' '+workspace.clock.time;
  const active=workspace.meetings.find(m=>m.status==='in_progress');
  const person=$('personA'), room=active&&workspace.rooms.find(r=>r.id===active.space_id);
  const target=room?{x:room.x,y:room.y}:{x:10,y:85};
  if(person.style.getPropertyValue('--x')!==target.x+'%'||person.style.getPropertyValue('--y')!==target.y+'%'){
    const old=person.getBoundingClientRect();person.getAnimations().forEach(a=>a.cancel());
    person.style.setProperty('--x',target.x+'%');person.style.setProperty('--y',target.y+'%');
    const next=person.getBoundingClientRect();
    if(!matchMedia('(prefers-reduced-motion: reduce)').matches&&!admin)person.animate([{transform:'translate(calc(-50% + '+(old.left-next.left)+'px),calc(-50% + '+(old.top-next.top)+'px))'},{transform:'translate(-50%,-50%)'}],{duration:850,easing:'cubic-bezier(.22,.8,.3,1)'});
  }
  $('stateA').textContent=t(active?'working':'idle');
  $('route').setAttribute('d',room?'M 100 578 L '+(room.x*10)+' 578 L '+(room.x*10)+' '+(room.y*6.8):'');
  $('mapStatus').textContent=active?active.name+' / '+t('in_progress'):t('ready');
  const selected=agendaTab==='proposals'&&plan?.proposals[agendaIndex];
  for(const el of document.querySelectorAll('[data-room]')){
    const id=el.dataset.room, current=active?.space_id===id;
    const visibleCalendar=(workspace.reservations??workspace.meetings).filter(r=>!r.deleted&&r.status!=='cancelled');
    const reserved=visibleCalendar.some(m=>m.space_id===id&&m.status==='reserved'&&m.date===workspace.clock.date);
    const suggested=selected?.candidates?.some(r=>r.id===id)&&!workspace.meetings.some(m=>m.proposal_id===selected.id);
    const seedTimes={'office-c04':['14:00','15:00'],'office-m02':['11:00','12:00'],'office-f12':['10:00','11:00']}[id];
    const seed=workspace.reservations?visibleCalendar.some(r=>r.source==='preset'&&r.space_id===id&&r.date===workspace.clock.date&&r.time<=workspace.clock.time&&workspace.clock.time<r.end_time):seedTimes&&workspace.clock.time>=seedTimes[0]&&workspace.clock.time<seedTimes[1];
    el.classList.toggle('inProgress',current);el.classList.toggle('reserved',reserved);el.classList.toggle('suggested',Boolean(suggested));
    const badge=el.querySelector('.mapBadge');if(badge)badge.textContent=t(current?'in_progress':suggested?'candidate':seed?'seed':reserved?'reserved':'available');
    el.setAttribute('aria-label',(workspace.rooms.find(r=>r.id===id)?.name??id)+' / '+badge.textContent);
  }
}
async function sync() {
  const result=await api('workspace');if(disposed)return;
  if(workspace&&result.instance_id===workspace.instance_id&&result.revision<workspace.revision)return;
  const restarted=workspace&&result.instance_id!==workspace.instance_id;
  const changed=!workspace||restarted||workspace.revision!==result.revision;
  if(restarted||(result.reset_generation??0)>(workspace?.reset_generation??0)){
    plan=null;selectedBookingId=null;agendaIndex=0;agendaTab='proposals';
  }
  workspace=result;$('today').textContent=result.today;
  if(changed){renderAgenda();renderMap();if(admin&&adminTab==='live'){if(result.admin_crud)await loadReservations();else renderAdmin();}}
}
function showBooking(id){
  const index=workspace.meetings.findIndex(m=>m.id===id);
  if(index<0){tell('meeting_missing',true);return;}
  selectedBookingId=id;agendaTab='bookings';agendaIndex=index;pane='agenda';renderAgenda();renderMap();renderMobile();
}
function openEditor(proposal){
  editing=proposal;
  $('editStatus').textContent='';
  const a=proposal.activity;
  $('editTitle').value=a.title;$('editDate').value=a.date;$('editDate').min=workspace.today;
  $('editDate').max=new Date(Date.parse(workspace.today)+30*86400000).toISOString().slice(0,10);
  $('editPeople').value=a.people??'';$('editDuration').value=a.duration??'';$('editMode').value=a.time?'exact':'flexible';
  $('editTime').value=a.time??'';$('editEarliest').value=a.window_start??'';$('editLatest').value=a.window_end??'';
  const features=[...new Set(['monitor','whiteboard','quiet','video','projector','window',...a.features])];
  $('editFeatures').innerHTML='<legend>'+t('features')+'</legend>'+features.map(f=>'<label><input type="checkbox" value="'+escape(f)+'" '+(a.features.includes(f)?'checked':'')+'>'+escape(t(f))+'</label>').join('');
  editorMode();$('editDialog').showModal();
}
function openAttendance(proposal,record=null){
  const activity=record?record.attendance_activity:proposal.activity;
  attendanceEditing=record?{meeting_id:record.id}:{plan_id:plan.plan_id,proposal_id:proposal.id};
  $('attendanceStatus').textContent='';
  $('attendanceSummary').textContent=[activity.title,activity.date,activity.people??'?',t('people'),activity.duration??'?',t('duration')].join(' / ');
  $('attendanceRoom').innerHTML='<option value="">'+t('chooseRoom')+'</option>'+workspace.rooms.filter(r=>r.kind==='meeting').map(r=>'<option value="'+escape(r.id)+'">'+escape(r.name)+'</option>').join('');
  $('attendanceRoom').value=record?.space_id??'';
  $('attendanceTime').value=record?.time??activity.time??'';
  $('attendanceDialog').showModal();
}
$('attendanceForm').addEventListener('submit',event=>{
  event.preventDefault();if(working||!attendanceEditing)return;
  const input={...attendanceEditing,space_id:$('attendanceRoom').value,time:$('attendanceTime').value};
  $('attendanceStatus').textContent=t('busy');
  perform(async()=>{
    try{
      const result=await api('attendance',{body:input});
      await sync();if(disposed)return;
      $('attendanceDialog').close();tell(result.meeting.source==='attendance'?'attendanceRegistered':'reused');showBooking(result.meeting.id);
    }catch(error){inlineAdminError('attendanceStatus',error);throw error;}
  });
});
function editorMode(){
  const flexible=$('editMode').value==='flexible';
  $('editTimeLabel').hidden=flexible;$('editTime').required=!flexible;$('editTime').disabled=flexible;
  document.querySelectorAll('.windowEdit').forEach(el=>{el.hidden=!flexible;el.querySelector('input').required=flexible;el.querySelector('input').disabled=!flexible;});
}
async function replan(proposal, extra={}){
  const result=await api('replan',{body:{plan_id:plan.plan_id,proposal_id:proposal.id,locale,...extra}});
  if(disposed)return;
  plan=result;agendaIndex=Math.min(agendaIndex,plan.proposals.length-1);tell('analysisDone');renderAgenda();renderMap();
}
async function rebook(id){
  const result=await api('rebook',{body:{meeting_id:id,locale}});
  if(disposed)return;
  await sync();plan=result;agendaTab='proposals';agendaIndex=0;pane='agenda';
  tell('rebookReady');renderAgenda();renderMap();renderMobile();
}
$('intentForm').addEventListener('submit',event=>{
  event.preventDefault();
  perform(async()=>{
    generation++;const current=generation;operation?.abort();operation=new AbortController();tell('analysing');
    plan=null;agendaTab='proposals';agendaIndex=0;renderAgenda();renderMap();
    const mode=$('parserMode').value;
    let headers={},signal=operation.signal;
    if(mode==='gpt'){if(!apiSession.configured)throw new Error('keyRequired');const auth=apiSession.begin($('intent').value);headers=auth.headers;signal=AbortSignal.any([signal,auth.signal]);}
    const result=await api('day-plan',{body:{message:$('intent').value,mode,locale,...(mode==='gpt'?{model:apiSession.model}:{})},headers,signal});
    if(current!==generation||disposed)return;
    plan=result;agendaTab='proposals';agendaIndex=Math.max(0,result.proposals.findIndex(p=>p.activity.type==='meeting'));pane='agenda';
    tell('analysisDone');renderAgenda();renderMap();renderMobile();
    if(result.questions.length){
      // Model follow-up text is not a missing field. Booking confirmation already
      // lives on the suggestion card; only unresolved proposals need this modal.
      const unresolved=result.proposals.filter(p=>p.status==='needs_input');
      if(unresolved.length)showDetail(t('needs_input'),unresolved.map(p=>p.activity.title+'\n'+p.issues.map(localisedIssue).join('\n')).join('\n\n'));
      else if(!result.proposals.length)showDetail(t('needs_input'),result.questions.map(localisedIssue).join('\n\n'));
    }
  });
});
$('useExample').addEventListener('click',()=>{$('intent').value=t('planPlaceholder');$('intent').focus();});
$('proposalsTab').addEventListener('click',()=>{agendaTab='proposals';agendaIndex=0;renderAgenda();renderMap();});
$('bookingsTab').addEventListener('click',()=>{
  const records=workspace?.meetings??[];
  selectedBookingId=records.find(m=>m.status==='in_progress')?.id??records.findLast(m=>m.status==='reserved')?.id??selectedBookingId;
  agendaTab='bookings';agendaIndex=0;renderAgenda();renderMap();
});
$('agendaPrevious').addEventListener('click',()=>{selectedBookingId=null;agendaIndex--;renderAgenda();renderMap();});
$('agendaNext').addEventListener('click',()=>{selectedBookingId=null;agendaIndex++;renderAgenda();renderMap();});
$('agendaContent').addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button||working)return;
  const proposal=plan?.proposals[agendaIndex];
  const meeting=workspace?.meetings.find(m=>m.id===button.dataset.bookingId);
  if(button.hasAttribute('data-edit'))return openEditor(proposal);
  if(button.hasAttribute('data-attendance'))return openAttendance(proposal);
  if(button.dataset.attendanceRecord)return openAttendance(null,workspace.meetings.find(m=>m.id===button.dataset.attendanceRecord));
  if(button.dataset.details)return showDetail(t('details'),button.dataset.details==='booking'?meeting:{questions:plan.questions,...proposal});
  if(button.dataset.viewBooking)return showBooking(button.dataset.viewBooking);
  if(button.hasAttribute('data-original')){agendaIndex=plan.proposals.findIndex(p=>p.id===proposal.existing_proposal_id);renderAgenda();renderMap();return;}
  if(button.hasAttribute('data-reuse'))return perform(async()=>{await sync();tell('reused');showBooking(button.dataset.reuse);});
  if(button.dataset.rebook)return perform(()=>rebook(button.dataset.rebook));
  if(button.hasAttribute('data-replan'))return perform(()=>replan(proposal));
  if(button.hasAttribute('data-distinct'))return perform(()=>replan(proposal,{distinct:true}));
  if(button.hasAttribute('data-confirm'))return perform(async()=>{
    const result=await api('confirm',{body:{plan_id:plan.plan_id,proposal_id:proposal.id,space_id:$('roomChoice').value,confirmed:true}});
    await sync();if(disposed)return;tell(result.reused?'reused':'booked');showBooking(result.booking.id);
  });
  if(button.dataset.meetingAction)return perform(async()=>{
    const action=button.dataset.meetingAction;
    const result=await api('transition',{body:{meeting_id:meeting.id,action}});
    if(!workspace||result.instance_id!==workspace.instance_id||result.revision>=workspace.revision)workspace={...result,today:workspace.today};
    if(disposed)return;tell(action==='start'?'started':action==='finish'?'ended':meeting.source==='attendance'?'attendanceRemoved':'cancelDone');renderMap();renderAdmin();
  });
});
$('editMode').addEventListener('change',editorMode);
$('editForm').addEventListener('submit',event=>{
  event.preventDefault();if(working)return;
  const flexible=$('editMode').value==='flexible';
  const activity={...editing.activity,title:$('editTitle').value.trim(),date:$('editDate').value,
    people:Number($('editPeople').value),duration:Number($('editDuration').value),time:flexible?null:$('editTime').value,
    window_start:flexible?$('editEarliest').value:null,window_end:flexible?$('editLatest').value:null,
    features:[...$('editFeatures').querySelectorAll('input:checked')].map(el=>el.value),unclear:[],existing_id:null};
  $('editStatus').textContent=t('busy');
  perform(async()=>{
    try{await replan(editing,{activity});$('editDialog').close();}
    catch(error){$('editStatus').textContent=t(error.message)===error.message?t('genericError'):t(error.message);throw error;}
  });
});
for(const el of document.querySelectorAll('[data-room]'))el.addEventListener('click',()=>{
  const room=workspace?.rooms.find(r=>r.id===el.dataset.room);
  if(!room)return;
  const rows=workspace.reservations?.filter(r=>r.space_id===room.id&&r.date===workspace.clock.date&&!r.deleted&&r.status!=='cancelled')??[];
  showDetail(room.name,{[t('people')]:room.capacity,[t('features')]:room.features.map(t),[t('state')]:el.querySelector('.mapBadge').textContent,
    [t('reservations')]:rows.map(r=>({[t('title')]:r.title,[t('time')]:r.time+'–'+r.end_time,[t('bookedBy')]:r.source==='preset'&&r.booked_by==='System'?t('presetSource'):r.booked_by}))});
});
document.querySelectorAll('[data-pane]').forEach(el=>el.addEventListener('click',()=>{pane=el.dataset.pane;renderMobile();}));
$('language').addEventListener('change',()=>{
  locale=$('language').value;
  const url=new URL(location.href);url.searchParams.set('lang',locale);history.replaceState(null,'',url);
  setupLanguage();
});
$('openSettings').addEventListener('click',()=>$('settingsDialog').showModal());
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>$(button.dataset.close).close()));
$('detailPrevious').addEventListener('click',()=>{detail.page--;renderDetail();});
$('detailNext').addEventListener('click',()=>{detail.page++;renderDetail();});
for(const id of ['openHelp','limitsButton'])$(id).addEventListener('click',()=>showDetail(t('help'),t('boundary')+'\n\n'+t('helpText')+'\n\n'+t('privacy')));
$('showEvents').addEventListener('click',()=>showDetail(t('showEvents'),workspace.events.map(e=>t(e.type==='started'?'in_progress':e.type)+' / '+e.room+' / '+e.demo_date+' '+e.demo_time+' / '+e.at).join('\n')||t('noRows')));
$('keyForm').addEventListener('submit',event=>{
  event.preventDefault();if(working)return;
  try{apiSession.configure($('key').value.trim(),$('model').value.trim());$('key').value='';$('parserMode').value='gpt';$('keyStatus').textContent=t('keyReady');setupLanguage();$('settingsDialog').close();tell('keyReady');}
  catch(error){$('keyStatus').textContent=t(/model|モデル/.test(error.message)?'invalid_model':'keyRequired');}
});
$('clearKey').addEventListener('click',()=>{
  generation++;operation?.abort();apiSession.clear();$('key').value='';$('parserMode').value='rules';chatText='';chatTrace=null;
  setupLanguage();$('keyStatus').textContent=t('keyCleared');tell('keyCleared');
});

function rowsPerPage(){
  if(adminTab==='live'&&workspace?.admin_crud){
    const mobile=innerWidth<=600,available=$('adminResults').clientHeight;
    return Math.max(1,Math.min(mobile?3:8,Math.floor((available-(mobile?0:38))/(mobile?112:70))));
  }
  return innerHeight<650?2:innerWidth<600?3:innerHeight<820?4:6;
}
function tableMarkup(headers,rows,manage=false){
  if(!rows.length)return '<div class="empty">'+t('noRows')+'</div>';
  return '<div class="tableBox '+(manage?'liveTable':'')+'"><table><thead><tr>'+headers.map(h=>'<th>'+escape(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.map((r,i)=>'<tr>'+r.cells.map(c=>'<td><span class="cellValue" title="'+escape(c)+'">'+escape(c)+'</span></td>').join('')+'<td><div class="rowActions"><button data-row="'+i+'" data-label="view">'+t('view')+'</button>'+(manage&&r.detail.source!=='attendance'?(r.detail.deleted?'<button data-row="'+i+'" data-admin-action="restore" aria-label="'+t('restoreReservation')+'">'+t('restoreReservation')+'</button>':'<button data-row="'+i+'" data-admin-action="edit" '+(r.detail.status!=='reserved'?'disabled':'')+' aria-label="'+t('editReservation')+'">'+t('editReservation')+'</button><button data-row="'+i+'" data-admin-action="delete" '+(r.detail.status==='in_progress'?'disabled':'')+' aria-label="'+t('deleteReservation')+'">'+t('deleteReservation')+'</button>'):'')+'</div></td></tr>').join('')+'</tbody></table></div>';
}

function liveTable(){
  const rows=workspace?.admin_crud?(liveData?.items??[]):workspace?.meetings??[];
  return {headers:[t('title'),t('room'),t('time'),t('bookedBy'),t('state'),t('details')],rows:rows.map(m=>({cells:[m.title,m.name,m.date+' '+m.time+'–'+m.end_time,
    m.source==='attendance'?t('attendanceSource'):m.source==='preset'&&m.booked_by==='System'?t('presetSource'):m.booked_by??t('employeeA'),t(m.deleted?'deleted':meetingState(m))],detail:m}))};
}
async function loadReservations(){
  if(!admin||!workspace?.admin_crud)return;
  if(!liveFilters){liveFilters={start_date:workspace.today,end_date:workspace.today,state:'all',query:''};$('liveStart').value=workspace.today;$('liveEnd').value=workspace.today;}
  const current=++liveGeneration;
  const filters={...liveFilters,limit:200};
  const result=await api('admin/reservations?'+new URLSearchParams(filters));
  while(result.items.length<result.total){
    const next=await api('admin/reservations?'+new URLSearchParams({...filters,offset:result.items.length}));
    if(next.revision!==result.revision)throw new Error('state_changed');
    if(!next.items.length)throw new Error('genericError');
    result.items.push(...next.items);
  }
  if(disposed||current!==liveGeneration)return;
  liveData=result;renderAdmin();
}
function renderAdminFeatures(selected){
  const features=[...new Set(['monitor','whiteboard','quiet','video','projector','window',...selected])];
  $('adminFeatures').innerHTML='<legend>'+t('features')+'</legend>'+features.map(f=>'<label><input type="checkbox" value="'+escape(f)+'" '+(selected.includes(f)?'checked':'')+'>'+escape(t(f))+'</label>').join('');
}
function openAdminEditor(record=null){
  if(working||!workspace?.admin_crud)return;
  adminEditing={record:record?structuredClone(record):null,operationId:crypto.randomUUID(),payload:null};
  $('adminEditTitle').textContent=t(record?'editReservation':'newReservation');
  $('adminEditStatus').textContent='';
  $('adminMeetingTitle').value=record?.title??'';
  $('adminDate').min=workspace.today;
  $('adminDate').max=new Date(Date.parse(workspace.today)+30*86400000).toISOString().slice(0,10);
  $('adminDate').value=record?.date??workspace.today;
  $('adminTime').value=record?.time??'09:00';
  $('adminDuration').value=record?.request.duration??30;
  $('adminPeople').value=record?.people??2;
  $('adminRoom').innerHTML=workspace.rooms.map(r=>'<option value="'+escape(r.id)+'">'+escape(r.name)+' / '+r.capacity+'</option>').join('');
  $('adminRoom').value=record?.space_id??workspace.rooms[0].id;
  $('adminBookedBy').value=record?.booked_by??'';
  $('adminAssigned').value=record?.assigned_to??'other';
  $('adminAssigned').disabled=record?.source==='preset';
  renderAdminFeatures(record?.request.features??[]);
  $('adminEditDialog').showModal();
}
function renderAdminDelete(){
  const {record,action}=adminDeleting;
  const key=action==='restore'?'restoreReservation':'deleteReservation';
  $('adminDeleteTitle').textContent=t(key);$('adminDeleteConfirm').textContent=t(key);
  $('adminDeleteHint').textContent=t(action==='restore'?'restoreHint':'deleteHint');
  $('adminDeleteSummary').textContent=[record.title,record.name,record.date+' '+record.time+'–'+record.end_time,record.booked_by].join(' / ');
}
function openAdminDelete(record,action){
  adminDeleting={record:structuredClone(record),action,operationId:crypto.randomUUID()};
  $('adminDeleteStatus').textContent='';renderAdminDelete();$('adminDeleteDialog').showModal();
}
function focusReservation(record,deleted=false){
  liveFilters={start_date:record.date,end_date:record.date,state:deleted?'deleted':'all',query:''};
  $('liveStart').value=record.date;$('liveEnd').value=record.date;
  $('liveRoom').value='';$('liveState').value=liveFilters.state;$('liveSearch').value='';adminPage=0;
}
function inlineAdminError(id,error){
  const message=t(error.message);
  $(id).textContent=message===error.message?t('genericError'):message;
}
$('adminCreate').addEventListener('click',()=>openAdminEditor());
$('liveQuery').addEventListener('submit',event=>{
  event.preventDefault();if(working)return;
  perform(async()=>{
    if($('liveStart').value>$('liveEnd').value)throw new Error('invalid_window');
    liveFilters={start_date:$('liveStart').value,end_date:$('liveEnd').value,space_id:$('liveRoom').value,state:$('liveState').value,query:$('liveSearch').value.trim()};
    adminPage=0;await loadReservations();
  });
});
$('adminEditForm').addEventListener('submit',event=>{
  event.preventDefault();if(working||!adminEditing)return;
  const editor=adminEditing;
  const data={title:$('adminMeetingTitle').value.trim(),date:$('adminDate').value,time:$('adminTime').value,
    duration:Number($('adminDuration').value),people:Number($('adminPeople').value),space_id:$('adminRoom').value,
    booked_by:$('adminBookedBy').value.trim(),assigned_to:$('adminAssigned').value,
    features:[...$('adminFeatures').querySelectorAll('input:checked')].map(el=>el.value)};
  const payload=JSON.stringify(data);
  if(editor.payload!==null&&editor.payload!==payload)editor.operationId=crypto.randomUUID();
  editor.payload=payload;$('adminEditStatus').textContent=t('busy');
  perform(async()=>{
    let result;
    try{result=await api('admin/'+(editor.record?'update':'create'),{body:{operation_id:editor.operationId,confirmed:true,data,
      ...(editor.record?{meeting_id:editor.record.id,expected_version:editor.record.version}:{})}});}
    catch(error){inlineAdminError('adminEditStatus',error);throw error;}
    if(disposed)return;
    $('adminEditDialog').close();focusReservation(result.record);
    await sync();await loadReservations();tell(editor.record?'reservationUpdated':'reservationCreated');
  });
});
$('adminDeleteConfirm').addEventListener('click',()=>{
  if(working||!adminDeleting)return;
  const deletion=adminDeleting;$('adminDeleteStatus').textContent=t('busy');
  perform(async()=>{
    let result;
    try{result=await api('admin/'+deletion.action,{body:{operation_id:deletion.operationId,confirmed:true,meeting_id:deletion.record.id,expected_version:deletion.record.version}});}
    catch(error){inlineAdminError('adminDeleteStatus',error);throw error;}
    if(disposed)return;
    $('adminDeleteDialog').close();focusReservation(result.record,deletion.action==='delete');
    await sync();await loadReservations();tell(deletion.action==='delete'?'reservationDeleted':'reservationRestored');
  });
});
for(const id of ['adminEditDialog','adminDeleteDialog','editDialog','attendanceDialog']){
  $(id).addEventListener('cancel',event=>{if(working)event.preventDefault();});
  $(id).querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',event=>{if(working){event.stopImmediatePropagation();}} ,{capture:true}));
}
function historyTable(){
  const r=adminData?.result;if(!r)return {headers:[],rows:[]};
  if(adminTab==='summary')return {headers:[t('room'),t('total'),t('used'),t('unused'),t('details')],rows:r.items.map(x=>({cells:[x.name,x.total,x.used,x.unused_not_precancelled],detail:x}))};
  if(adminTab==='spaces')return {headers:[t('room'),t('people'),t('state'),t('details')],rows:r.items.map(x=>({cells:[x.space_name??x.name,x.capacity_reported??t('unknown'),x.type],detail:x}))};
  if(adminTab==='reservations')return {headers:[t('room'),t('date'),t('time'),t('state'),t('details')],rows:r.items.map(x=>({cells:[x.space_name??x.name,x.date,(x.start_raw??'').slice(11,16)+'–'+(x.end_raw??'').slice(11,16),reservationStatusLabel(x,locale)],detail:x}))};
  return {headers:[t('room'),t('eligible'),t('unused'),t('state'),t('details')],rows:r.items.map(x=>({cells:[x.name,x.eligible_reservations,x.unused_count,t(x.status==='review'?'reviewLabel':x.status)],detail:x}))};
}
function renderAdmin(){
  if(!admin)return;
  $('adminRefresh').hidden=adminTab==='ai';
  $('adminTitle').textContent=t(adminTab);
  $('adminDescription').textContent=t(adminTab==='live'?(workspace?.admin_crud?'adminLiveHint':'liveDesc'):adminTab==='ai'?'aiNote':'historyDesc');
  document.querySelectorAll('[data-admin]').forEach(el=>el.classList.toggle('active',el.dataset.admin===adminTab));
  const query=!['live','ai'].includes(adminTab);
  $('adminQuery').hidden=!query;$('adminAskForm').hidden=adminTab!=='ai';$('reviewTools').hidden=adminTab!=='review';
  $('liveQuery').hidden=adminTab!=='live'||!workspace?.admin_crud;
  if(!$('liveRoom').options.length&&workspace){$('liveRoom').innerHTML='<option value="">'+t('allStates')+'</option>'+workspace.rooms.map(r=>'<option value="'+escape(r.id)+'">'+escape(r.name)+'</option>').join('');}
  if($('liveRoom').options.length)$('liveRoom').options[0].textContent=t('allStates');
  $('startLabel').hidden=adminTab==='spaces';$('endLabel').hidden=adminTab==='spaces';$('searchLabel').hidden=adminTab!=='spaces';
  document.querySelectorAll('.reviewFilter').forEach(el=>{el.hidden=adminTab!=='review';});
  document.querySelectorAll('#adminQuery label').forEach(el=>{el.querySelector('input').disabled=el.hidden||!query||working;});
  const meetings=workspace?.admin_crud?(liveData?.items??[]):workspace?.meetings??[];
  const metrics=adminTab==='live'?[[t('total'),meetings.filter(m=>m.source!=='attendance').length],[t('active'),meetings.filter(m=>m.status==='in_progress').length],[t('endedCount'),meetings.filter(m=>m.status==='completed').length],[t('cancelledCount'),meetings.filter(m=>m.status==='cancelled').length]]
    :adminTab==='ai'?[]:adminData?[[t('total'),adminData.result.total_records??adminData.result.total??adminData.result.total_spaces??0],[t('reviewCount'),adminData.result.review_count??'—']]:[];
  $('adminMetrics').hidden=!metrics.length;$('adminMetrics').innerHTML=metrics.map(([label,value])=>'<div class="metric"><span>'+label+'</span><b>'+escape(value)+'</b></div>').join('');
  if(adminTab==='ai'){
    const pages=textPages(chatText||t('aiEmpty'),Math.max(100,innerHeight-450));adminPage=Math.max(0,Math.min(adminPage,pages.length-1));
    $('adminResults').innerHTML='<div class="answerBox">'+escape(pages[adminPage])+'</div>';setAdminPager(pages.length);return;
  }
  const data=adminTab==='live'?liveTable():historyTable();
  const size=rowsPerPage(),count=Math.max(1,Math.ceil(data.rows.length/size));adminPage=Math.max(0,Math.min(adminPage,count-1));
  $('adminResults').innerHTML=tableMarkup(data.headers,data.rows.slice(adminPage*size,(adminPage+1)*size),adminTab==='live'&&workspace?.admin_crud);
  if(adminTab==='review'&&adminData?.comparison){
    const cmp=adminData.comparison;
    $('comparisonStatus').textContent=t(cmp.state)+(cmp.state==='compared'?' / '+t('new')+': '+cmp.counts.new+' / '+t('ongoing')+': '+cmp.counts.ongoing:'');
  }else $('comparisonStatus').textContent='';
  setAdminPager(count);
}
function setAdminPager(count){$('adminPage').textContent=(adminPage+1)+' / '+count;$('adminPrevious').disabled=adminPage===0;$('adminNext').disabled=adminPage>=count-1;}
async function runHistory(){
  if(!admin||['live','ai'].includes(adminTab))return;
  const current=++historyGeneration,tab=adminTab;
  const name={summary:'summarize_reservations',spaces:'search_spaces',reservations:'query_reservations',review:'detect_unused_reservations'}[tab];
  const args=tab==='spaces'?{query:$('spaceSearch').value,limit:100}:{start_date:$('historyStart').value,end_date:$('historyEnd').value,limit:100};
  if(tab==='review')Object.assign(args,{min_reservations:Number($('minBookings').value),min_unused:Number($('minUnused').value),min_unused_percent:Number($('minPercent').value)});
  if(args.start_date>args.end_date)throw new Error('invalid_window');
  const payload=await http('/api/call',{body:{name,arguments:args}});
  if(disposed||current!==historyGeneration||tab!==adminTab)return;
  if(payload.result.isError)throw new Error('invalid_request');
  adminData={result:payload.result.structuredContent.result};adminTrace={name,arguments:args,response:payload.result};adminPage=0;
  if(tab==='review')adminData.comparison=comparison.check(adminData.result.comparison_snapshot);
  tell('analysisDone');renderAdmin();
}
$('adminQuery').addEventListener('submit',event=>{event.preventDefault();perform(runHistory);});
document.querySelectorAll('[data-admin]').forEach(button=>button.addEventListener('click',()=>{
  historyGeneration++;adminTab=button.dataset.admin;adminPage=0;adminData=null;adminTrace=null;renderAdmin();
  if(!['live','ai'].includes(adminTab))perform(runHistory);
  else if(adminTab==='live'&&workspace?.admin_crud)perform(loadReservations);
}));
$('adminRefresh').addEventListener('click',()=>perform(async()=>{if(adminTab==='live'){await sync();if(workspace?.admin_crud)await loadReservations();}else if(adminTab!=='ai')await runHistory();}));
$('adminPrevious').addEventListener('click',()=>{adminPage--;renderAdmin();});
$('adminNext').addEventListener('click',()=>{adminPage++;renderAdmin();});
$('adminResults').addEventListener('click',event=>{
  const button=event.target.closest('[data-row]');if(!button)return;
  const rows=adminTab==='live'?liveTable().rows:historyTable().rows;
  const item=rows[adminPage*rowsPerPage()+Number(button.dataset.row)];
  if(!item)return;
  if(button.dataset.adminAction){if(working)return;return button.dataset.adminAction==='edit'?openAdminEditor(item.detail):openAdminDelete(item.detail,button.dataset.adminAction);}
  if(adminTab==='reservations'&&item.detail.reservation_id)return perform(async()=>{
    const args={reservation_id:item.detail.reservation_id};
    const payload=await http('/api/call',{body:{name:'get_evidence',arguments:args}});
    if(disposed)return;
    if(payload.result.isError)throw new Error('genericError');
    adminTrace={name:'get_evidence',arguments:args,response:payload.result};
    showDetail(t('evidence'),payload.result.structuredContent.result);
  });
  showDetail(t('details'),item.detail);
});
$('adminTrace').addEventListener('click',()=>showDetail(t('raw'),t('traceNote')+'\n\n'+JSON.stringify(adminTab==='ai'?chatTrace:adminTab==='live'?workspace:adminTrace,null,2)));
$('reviewDemo').addEventListener('click',()=>perform(async()=>{
  demoStep=(demoStep+1)%4;if(demoStep===0)demoComparison.clear();
  const payload=await http('/api/review-demo?step='+demoStep);if(disposed)return;
  adminData={result:payload.result,comparison:demoComparison.check(payload.result.comparison_snapshot)};
  adminTrace=payload;adminPage=0;renderAdmin();showDetail(t('reviewDemo')+' '+(demoStep+1)+' / 4',t('demoDesc')+'\n\n'+t(adminData.comparison.state));
}));
$('adminAskForm').addEventListener('submit',event=>{
  event.preventDefault();perform(async()=>{
    if(!apiSession.configured)throw new Error('keyRequired');
    const question=$('adminQuestion').value.trim(),auth=apiSession.begin(question);
    const result=await http('/api/chat',{body:{message:question+'\n'+(locale==='en'?'Answer in English.':'日本語で回答してください。'),model:apiSession.model,history:[]},headers:auth.headers,signal:auth.signal});
    if(disposed)return;chatText=result.answer;chatTrace={trace:result.trace,usage:result.usage};adminPage=0;renderAdmin();
  });
});
window.addEventListener('resize',()=>{renderAdmin();if($('detailDialog').open)renderDetail();});
window.addEventListener('pagehide',()=>{
  disposed=true;generation++;historyGeneration++;operation?.abort();apiSession.clear();$('key').value='';clearInterval(poll);
});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
setupLanguage();
try{
  await sync();
  if(!disposed)poll=setInterval(()=>{if(!document.hidden&&!working)sync().catch(error=>{if(!disposed)showError(error);});},5000);
}catch(error){showError(error);}
