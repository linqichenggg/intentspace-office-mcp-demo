import { layoutAreas, layoutPosition, renderOfficeLayout } from './office-layout.js';
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
let inspectedRoomId=null,roomBookingPage=0;
let activeArea='meeting', lastActiveRoom=null;
let adminTab = 'live', adminPage = 0, adminData = null, adminTrace = null, historyGeneration = 0;
let comfortMode='thermal',lastSuggestedId=null;
let working = false, disposed = false, generation = 0, operation = null, poll = null;
let detail = {title:'',text:'',page:0}, editing = null, demoStep = -1;
let attendanceEditing=null;
let liveFilters=null,liveData=null,liveGeneration=0,adminEditing=null,adminDeleting=null;
let bulkClear=null;
let notice = {key:admin?'adminReady':'ready',error:false}, chatText = '', chatTrace = null;

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
  document.querySelectorAll('#intentForm button,#intentForm select,#intentForm textarea,#agendaContent button,#agendaContent select,#adminAskForm button,#adminQuery input,#adminQuery button,#liveQuery input,#liveQuery select,#liveQuery button,#adminEditForm input,#adminEditForm select,#adminEditForm button,#editForm input,#editForm select,#editForm button,#adminDeleteConfirm,[data-admin],#adminRefresh,#reviewDemo,#keyForm button:not(#clearKey),#proposalsTab,#bookingsTab,[data-close]').forEach(el=>{el.disabled=value;});
  $('attendanceForm').querySelectorAll('input,select,button').forEach(el=>{el.disabled=value;});
  $('historyTab').disabled=value;
  $('adminClear').disabled=value;
  $('bulkClearForm').querySelectorAll('input,select,button').forEach(el=>{el.disabled=value;});
  $('parseButton').textContent=t(value?'busy':'analyse');
  if(!value){if(adminEditing?.record){const r=adminEditing.record;$('adminAssigned').disabled=['preset','attendance'].includes(r.source);for(const id of ['adminDate','adminTime','adminDuration','adminRoom'])$(id).disabled=['completed','cancelled'].includes(r.status);}if($('editDialog').open)editorMode();renderAdmin();}
  if($('bulkClearDialog').open)renderBulkClear();
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
const facilityPaths={
  monitor:'<rect x="4" y="5" width="32" height="23" rx="1"/><path d="M14 35h12M20 28v7"/>',
  whiteboard:'<path d="M5 6h30v23H5zM12 29l-3 7M28 29l3 7M11 13h18M11 20h11"/>',
  quiet:'<path d="M6 16h7l9-8v24l-9-8H6zM28 15l8 10M36 15l-8 10"/>',
  video:'<rect x="4" y="10" width="23" height="22" rx="2"/><path d="M27 17l9-6v20l-9-6M10 5h12"/>',
  projector:'<rect x="3" y="13" width="34" height="20" rx="2"/><circle cx="27" cy="23" r="6"/><path d="M8 20h6M8 25h6M12 8h16"/>',
  window:'<path d="M6 4h28v32H6zM20 4v32M6 20h28M11 10l3-3M25 16l4-4"/>',
  low_airflow:'<path d="M4 12h22c10 0 10-9 3-9M4 21h29M4 30h20c9 0 9 8 3 8"/>'
};
function comfortText(room){
  const data=room?.comfort;
  if(!data)return t('comfortUnknown');
  return t('seatComfort')+' · '+t('comfortResponses')+': '+data.responses+' · '+t('coldReports')+': '+data.cold+' · '+t('hotReports')+': '+data.hot+' · '+t('comfortScore')+': '+data.mean_score+
    (data.responses<3?' · '+t('comfortInsufficient'):'');
}
function renderRoomDetails(){
  if(!workspace||!inspectedRoomId)return;
  const room=workspace.rooms.find(r=>r.id===inspectedRoomId);
  const currentDate=workspace.clock.date,currentTime=workspace.clock.time;
  $('roomDetailTitle').textContent=(room?.kind==='desk'?t('roomSeatName'):t('roomDisplayName'))+' '+(room?.name??'H');
  $('roomCapacity').textContent=room?room.kind==='desk'?t('singleSeatCapacity'):String(room.capacity)+' '+t('roomCapacityUnit'):t('roomUnknownCapacity');
  const rows=(workspace.reservations??workspace.meetings).filter(r=>r.space_id===inspectedRoomId&&r.date===currentDate&&!r.deleted)
    .sort((a,b)=>a.time.localeCompare(b.time)||a.id.localeCompare(b.id));
  const active=[...rows,...workspace.meetings].some(r=>r.space_id===inspectedRoomId&&r.date===currentDate&&!r.deleted&&r.status==='in_progress');
  const booked=rows.some(r=>r.status==='reserved'&&r.end_time>currentTime);
  const status=!room?'roomUnknownStatus':active?'in_progress':booked?'roomBookedToday':'roomFreeNow';
  $('roomAvailability').textContent=t(status);$('roomAvailability').classList.toggle('occupied',active);
  $('roomDemoNote').textContent=t(!room?'unboundRoomDetails':room.kind==='desk'?room.area?'seatMappingNote':'roomUnplacedNote':'roomEquipmentNote');
  const facilities=room?.features.filter(feature=>!feature.startsWith('area_'))??[];
  $('roomComfort').hidden=room?.kind!=='desk';$('roomComfort').textContent=comfortText(room);
  $('roomFacilityList').innerHTML=facilities.length?facilities.map(feature=>
    '<li class="roomFacility"><span class="facilityIcon" aria-hidden="true"><svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">'+(facilityPaths[feature]??facilityPaths.monitor)+'</svg></span><div><h3>'+escape(t(feature))+'</h3><p>'+escape(t(feature+'Facility'))+'</p></div></li>').join(''):
    '<li class="roomEquipmentUnknown">'+escape(t('roomNoEquipment'))+'</li>';
  $('roomScheduleDate').textContent=currentDate;
  const size=innerHeight<700?1:2,pages=Math.max(1,Math.ceil(rows.length/size));
  roomBookingPage=Math.max(0,Math.min(roomBookingPage,pages-1));
  $('roomBookingList').innerHTML=rows.length?rows.slice(roomBookingPage*size,(roomBookingPage+1)*size).map(record=>
    '<article class="roomBooking"><div><time>'+escape(record.time+'–'+record.end_time)+'</time><span>'+escape(t(record.status))+'</span></div><p>'+escape(record.source==='preset'?t('presetSource'):record.title)+'</p></article>').join(''):
    '<p class="roomScheduleEmpty">'+escape(t(room?'roomNoBookings':'roomNotBookable'))+'</p>';
  $('roomBookingPager').hidden=pages<=1;$('roomBookingPage').textContent=(roomBookingPage+1)+' / '+pages;
  $('roomBookingPrevious').disabled=roomBookingPage===0;$('roomBookingNext').disabled=roomBookingPage===pages-1;
}
function openRoomDetails(id){
  inspectedRoomId=id;roomBookingPage=0;renderRoomDetails();
  if(!$('roomDialog').open)$('roomDialog').showModal();
}
function setupLanguage() {
  const translate=translator(locale);
  t=key=>translate(workspace?.deployment==='cloud'?({simulation:'cloudSimulation',boundary:'cloudBoundary',adminWriteBoundary:'cloudAdminBoundary'}[key]??key):key);
  applyLanguage(locale);$('language').value=locale;
  for(const key of ['simulation','boundary','adminWriteBoundary'])document.querySelectorAll('[data-i18n="'+key+'"]').forEach(el=>{el.textContent=t(key);});
  document.title='IntentSpace / '+t(admin?'admin':'employee');
  $('employeeLink').href='/office.html?lang='+locale;$('adminLink').href='/admin?lang='+locale;
  document.querySelector('.brand').href='/office.html?lang='+locale;
  document.querySelector('.skip').href=admin?'#adminTitle':'#intent';
  $('adminTitle').tabIndex=-1;
  $('employeeLink').classList.toggle('active',!admin);$('adminLink').classList.toggle('active',admin);
  $('employeeView').hidden=admin;$('adminView').hidden=!admin;$('mobileTabs').hidden=admin;
  $('notice').textContent=(notice.count===undefined?'':notice.count+' ')+t(notice.key);
  $('keyStatus').textContent=t(apiSession.configured?'keyReady':'noKey');
  $('keyBadge').textContent=t(apiSession.configured?'withKey':'noKey');
  $('keyBadge').classList.toggle('connected',apiSession.configured);
  if(workspace)$('today').textContent=workspace.today;
  renderAgenda();renderMap();renderAdmin();renderMobile();
  if($('detailDialog').open)renderDetail();
  if($('roomDialog').open)renderRoomDetails();
  if(adminEditing&&$('adminEditDialog').open){
    $('adminEditTitle').textContent=t(adminEditing.record?'editReservation':'newReservation');
    renderAdminFeatures([...$('adminFeatures').querySelectorAll('input:checked')].map(el=>el.value));
  }
  if(adminDeleting&&$('adminDeleteDialog').open)renderAdminDelete();
  if($('bulkClearDialog').open)renderBulkClear();
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
function employeeRecords(){
  return [...new Map([...(workspace?.meetings??[]),...(workspace?.meeting_history??[]),...(workspace?.current_meetings??[])].map(r=>[r.id,r])).values()];
}
function agendaRecords(tab=agendaTab){
  if(tab==='proposals')return plan?.proposals??[];
  const current=workspace?.current_meetings??(workspace?.meetings??[]).filter(r=>!r.deleted&&['reserved','in_progress'].includes(r.status));
  return tab==='bookings'?current:workspace?.meeting_history??employeeRecords().filter(r=>!current.some(c=>c.id===r.id));
}
function latestRecord(record){
  const records=employeeRecords(),seen=new Set();
  while(record&&(record.replacement_id||record.replaced_by)&&!seen.has(record.id)){
    seen.add(record.id);
    const next=records.find(r=>r.id===(record.replacement_id??record.replaced_by));
    if(!next)break;
    record=next;
  }
  return record;
}
function renderAgenda() {
  $('proposalsTab').classList.toggle('active',agendaTab==='proposals');$('bookingsTab').classList.toggle('active',agendaTab==='bookings');$('historyTab').classList.toggle('active',agendaTab==='history');
  const items=agendaRecords();
  if(agendaTab!=='proposals'&&selectedBookingId){const index=items.findIndex(m=>m.id===selectedBookingId);if(index>=0)agendaIndex=index;else selectedBookingId=null;}
  agendaIndex=Math.max(0,Math.min(agendaIndex,items.length-1));
  $('agendaPage').textContent=items.length?(agendaIndex+1)+' / '+items.length:'0 / 0';
  $('agendaPrevious').disabled=!items.length||agendaIndex===0||working;$('agendaNext').disabled=agendaIndex>=items.length-1||working;
  const item=items[agendaIndex];
  if(agendaTab!=='proposals')selectedBookingId=item?.id??null;
  if(!item){$('agendaContent').innerHTML='<div class="empty"><span class="emptyGlyph" aria-hidden="true">▦</span><p>'+t(agendaTab==='proposals'?'noPlan':agendaTab==='history'?'emptyHistory':'emptyCurrent')+'</p></div>';return;}
  if(agendaTab!=='proposals'){
    const next=latestRecord(item),replaced=next?.id!==item.id||Boolean(item.replacement_id||item.replaced_by);
    const active=agendaTab==='bookings';
    const actions=item.deleted?'':replaced?next?.id!==item.id?'<button class="primary" data-view-booking="'+escape(next.id)+'">'+t('showReplacement')+'</button>':''
      :active&&item.status==='reserved'?'<button class="primary" data-meeting-action="start">'+t(item.request.kind==='desk'?'seatStart':'start')+'</button><button data-meeting-action="cancel">'+t(item.source==='attendance'?'withdrawAttendance':'cancel')+'</button>'
      :item.status==='in_progress'?'<button class="primary" data-meeting-action="finish">'+t(item.request.kind==='desk'?'seatFinish':'finish')+'</button>'
      :item.status==='cancelled'&&item.date>=workspace.today?item.source==='attendance'?'<button class="primary" data-attendance-record="'+escape(item.id)+'">'+t('registerAgain')+'</button>':'<button class="primary" data-rebook="'+escape(item.id)+'">'+t('rebook')+'</button>':'';
    const status=item.deleted?'deleted':replaced?'rebooked':!active&&item.status==='reserved'?'unstartedHistory':meetingState(item);
    $('agendaContent').innerHTML='<article class="agendaCard"><span class="statePill">'+t(status)+'</span><h3 class="cardTitle">'+escape(item.title)+'</h3>'+facts({...item,duration:item.request.duration},item.request)+'<p class="equipment">'+escape(item.name)+' / '+item.request.features.map(f=>escape(t(f))).join(', ')+'</p>'+(item.source==='attendance'?'<p class="cardBody">'+t('attendanceSource')+'</p>':'')+'<div class="cardActions">'+actions+'<button data-details="booking">'+t('details')+'</button></div></article>';
  }else{
    const a=item.activity;
    const currentRecords=[...(workspace?.reservations??[]),...employeeRecords()];
    const linked=currentRecords.findLast(m=>m.plan_id===plan.plan_id&&m.proposal_id===item.id)
      ??(item.existing&&currentRecords.find(m=>m.id===item.existing.id));
    const missing=Boolean(linked&&(linked.deleted||linked.assigned_to==='other')||item.existing&&!linked);
    const successor=latestRecord(linked);
    const done=successor&&successor.id!==linked?.id?successor:missing?null:linked;
    const state=done?.deleted?'deleted':done&&successor?.id!==linked?.id?'rebooked':missing?'record_changed':done?meetingState(done):item.status;
    let actions='<button data-edit>'+t('edit')+'</button>';
    let body=(item.issues??[]).map(localisedIssue).join(' ');
    if(done&&successor?.id!==linked?.id){actions='<button class="primary" data-view-booking="'+escape(done.id)+'">'+t('showReplacement')+'</button>';body=t('rebooked');}
    else if(missing){actions='<button class="primary" data-replan>'+t('retrySuggestions')+'</button>'+actions;body=t('record_changed');}
    else if(done?.status==='cancelled'){
      actions=(done.source==='attendance'?'<button class="primary" data-attendance-record="'+escape(done.id)+'">'+t('registerAgain')+'</button>':'<button class="primary" data-rebook="'+escape(done.id)+'">'+t('rebook')+'</button>')+'<button data-view-booking="'+escape(done.id)+'">'+t('bookings')+'</button>';
      body=t(done.source==='attendance'?'attendanceRemoved':'rebookHint');
    }else if(done?.status==='completed'){
      actions='<button data-view-booking="'+escape(done.id)+'">'+t('completedHistory')+'</button><button data-edit>'+t('newTime')+'</button>';body=t('completedHint');
    }else if(item.status==='proposed'&&!done){
      actions='<select class="roomChoice" id="roomChoice" aria-label="'+t('room')+'">'+item.candidates.map(r=>'<option value="'+escape(r.id)+'">'+escape(r.name)+' / '+(r.kind==='desk'?t('area_'+r.area):r.capacity)+'</option>').join('')+'</select><p id="candidateInfo" class="small"></p><button class="primary" data-confirm>'+t('confirm')+'</button>'+actions;
      if(a.type==='desk')body='';
    }else if(item.status==='existing'||item.status==='possible_duplicate'){
      body=done.name+' / '+done.time+'–'+done.end_time;
      actions='<button class="primary" data-reuse="'+escape(done.id)+'">'+t('reuse')+'</button>'+(item.status==='possible_duplicate'?'<button data-distinct>'+t('distinct')+'</button>':'');
    }else if(done){actions='<button class="primary" data-view-booking="'+done.id+'">'+t('bookings')+'</button>';}
    if(item.status==='note'){actions='';body=t(a.type);}
    if(item.status==='duplicate_in_plan'){actions='<button data-original>'+t('viewOriginal')+'</button>';body=t('duplicate_in_plan');}
    if(item.status==='no_slot'&&!done&&!missing){body=t('no_slot_help');actions='<button class="primary" data-replan>'+t('retrySuggestions')+'</button>'+actions;}
    if(a.type==='meeting'&&!done&&!missing&&item.status!=='duplicate_in_plan')actions+='<button data-attendance>'+t('notMyBooking')+'</button>';
    $('agendaContent').innerHTML='<article class="agendaCard '+(a.type==='desk'?'seatCard':'')+'"><span class="statePill '+(['no_slot','needs_input','possible_duplicate'].includes(state)?'warning':'')+'">'+t(state)+'</span><h3 class="cardTitle">'+escape(a.title)+'</h3>'+facts(a,item.request)+'<p class="equipment">'+a.features.map(f=>escape(t(f))).join(', ')+'</p><p class="cardBody">'+escape(body)+'</p><div class="cardActions">'+actions+'<button data-details="proposal">'+t('details')+'</button></div></article>';
  }
  if(agendaTab!=='proposals')$('agendaContent').querySelectorAll('button').forEach(button=>{button.dataset.bookingId=item.id;});
  $('agendaContent').querySelectorAll('button,select').forEach(el=>{el.disabled=working;});
  renderCandidateInfo();
}
function renderCandidateInfo(){
  const item=agendaTab==='proposals'&&plan?.proposals[agendaIndex];
  const selected=item?.candidates?.find(r=>r.id===$('roomChoice')?.value)??item?.candidates?.[0];
  if($('candidateInfo'))$('candidateInfo').textContent=selected?.kind==='desk'?comfortText(selected):'';
  if($('candidateInfo'))$('candidateInfo').title=t('comfortBasis');
}
function renderMap() {
  if(!workspace)return;
  $('worldClock').textContent=workspace.clock.date+' '+workspace.clock.time;
  const active=workspace.meetings.find(m=>m.status==='in_progress');
  const room=active&&workspace.rooms.find(r=>r.id===active.space_id);
  if(room?.area&&room.id!==lastActiveRoom)activeArea=room.area;
  lastActiveRoom=room?.id??null;
  const selected=agendaTab==='proposals'&&plan?.proposals[agendaIndex];
  const suggested=selected?.status==='proposed'&&selected.candidates?.find(r=>r.id===$('roomChoice')?.value) || selected?.candidates?.[0];
  const suggestionId=suggested&&selected.id+':'+suggested.id;
  if(suggestionId&&suggestionId!==lastSuggestedId&&!active&&suggested.area)activeArea=suggested.area;
  lastSuggestedId=suggestionId??null;
  const calendar=(workspace.reservations??workspace.meetings).filter(r=>!r.deleted&&r.status!=='cancelled');
  const states={};
  for(const candidate of workspace.rooms){
    const inUse=active?.space_id===candidate.id||calendar.some(m=>m.space_id===candidate.id&&m.date===workspace.clock.date&&m.status==='in_progress'&&
      (m.actual_start??m.time)<=workspace.clock.time&&workspace.clock.time<m.end_time);
    const suggested=selected?.status==='proposed'&&(selected?.candidates?.slice(0,8).some(r=>r.id===candidate.id)||candidate.id===$('roomChoice')?.value)&&!workspace.meetings.some(m=>m.proposal_id===selected.id);
    const reserved=calendar.some(m=>m.space_id===candidate.id&&m.status==='reserved'&&m.date===workspace.clock.date&&m.end_time>workspace.clock.time);
    states[candidate.id]=inUse?'in_progress':suggested?'suggested':reserved?'reserved':'available';
  }
  const rendered=renderOfficeLayout(activeArea,locale,states);
  $('layoutSvg').setAttribute('viewBox',rendered.box.join(' '));
  $('layoutSvg').innerHTML=rendered.svg;
  $('layoutRoute').setAttribute('viewBox',rendered.box.join(' '));
  document.querySelectorAll('[data-area]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.area===activeArea)));
  const area=layoutAreas[activeArea],position=layoutPosition(activeArea,room?.id);
  const person=$('personA');
  $('layoutCaption').textContent=t(activeArea==='meeting'?'layoutCaption':'seatCaption');
  $('legacySeat').textContent=t('unplacedSeat')+(active?.space_id==='office-f12'?' / '+t('in_progress'):'');
  // Preserve the SVG aspect ratio, including after a resize or mobile pane switch.
  const bounds=$('officeMap').getBoundingClientRect();
  const availableWidth=Math.max(0,(bounds.width??1000)-16),availableHeight=Math.max(0,(bounds.height??680)-16);
  const scale=Math.min(availableWidth/area.box[2],availableHeight/area.box[3]);
  $('layoutStage').style.width=area.box[2]*scale+'px';$('layoutStage').style.height=area.box[3]*scale+'px';
  person.hidden=active?room?.area!==activeArea:activeArea!=='meeting';
  const target=position;
  if(person.style.getPropertyValue('--x')!==target.x+'%'||person.style.getPropertyValue('--y')!==target.y+'%'){
    const old=person.getBoundingClientRect();person.getAnimations().forEach(a=>a.cancel());
    person.style.setProperty('--x',target.x+'%');person.style.setProperty('--y',target.y+'%');
    const next=person.getBoundingClientRect();
    if(!matchMedia('(prefers-reduced-motion: reduce)').matches&&!admin&&!person.hidden)person.animate([{transform:'translate(calc(-50% + '+(old.left-next.left)+'px),calc(-50% + '+(old.top-next.top)+'px))'},{transform:'translate(-50%,-50%)'}],{duration:850,easing:'cubic-bezier(.22,.8,.3,1)'});
  }
  $('stateA').textContent=t(active?'working':'idle');
  // This line illustrates the state transition, not a measured navigation route.
  $('route').setAttribute('d',active&&position.placed?'M '+area.entry.join(' ')+' L '+position.point.join(' '):'');
  $('mapStatus').textContent=active?active.name+' / '+t('in_progress')+(room?.area?'':' / '+t('unplacedActive')):t('ready');
}

async function sync() {
  const result=await api('workspace');if(disposed)return;
  if(workspace&&result.instance_id===workspace.instance_id&&result.revision<workspace.revision)return;
  const restarted=workspace&&result.instance_id!==workspace.instance_id;
  const changed=!workspace||restarted||workspace.revision!==result.revision||workspace.today!==result.today;
  const deploymentChanged=workspace?.deployment!==result.deployment;
  if(restarted||(result.reset_generation??0)>(workspace?.reset_generation??0)){
    plan=null;selectedBookingId=null;agendaIndex=0;agendaTab='proposals';
  }
  workspace=result;$('today').textContent=result.today;
  if(deploymentChanged)setupLanguage();
  if(changed){renderAgenda();renderMap();if($('roomDialog').open)renderRoomDetails();if(admin&&adminTab==='live'){if(result.admin_crud)await loadReservations();else renderAdmin();}else if(admin&&adminTab!=='ai')await runHistory();}
}
function showBooking(id){
  const current=agendaRecords('bookings'),historical=agendaRecords('history');
  const record=current.find(m=>m.id===id)??historical.find(m=>m.id===id);
  if(!record){tell('meeting_missing',true);return;}
  selectedBookingId=id;agendaTab=current.some(m=>m.id===id)?'bookings':'history';agendaIndex=0;pane='agenda';renderAgenda();renderMap();renderMobile();
}
function openEditor(proposal){
  editing=proposal;
  $('editStatus').textContent='';
  const a=proposal.activity;
  $('editTitle').value=a.title;$('editDate').value=a.date;$('editDate').min=workspace.today;
  $('editDate').max=new Date(Date.parse(workspace.today)+30*86400000).toISOString().slice(0,10);
  $('editPeople').value=a.people??'';$('editDuration').value=a.duration??'';$('editMode').value=a.time?'exact':'flexible';
  $('editTime').value=a.time??'';$('editEarliest').value=a.window_start??'';$('editLatest').value=a.window_end??'';
  const features=[...new Set(['monitor','whiteboard','quiet','video','projector','window',...(a.type==='desk'?['low_airflow','avoid_cold','avoid_hot','area_east','area_west','area_connect']:[]),...a.features])];
  $('editPeople').max=a.type==='desk'?'1':'100';
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
    if(!apiSession.configured){$('settingsDialog').showModal();throw new Error('keyRequired');}
    const auth=apiSession.begin($('intent').value);
    const result=await api('day-plan',{body:{message:$('intent').value,mode:'gpt',locale,model:apiSession.model},headers:auth.headers,signal:AbortSignal.any([operation.signal,auth.signal])});
    if(current!==generation||disposed)return;
    plan=result;agendaTab='proposals';agendaIndex=Math.max(0,result.proposals.findIndex(p=>['meeting','desk'].includes(p.activity.type)));pane='agenda';
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
  const records=agendaRecords('bookings');
  selectedBookingId=records.find(m=>m.status==='in_progress')?.id??records.findLast(m=>m.status==='reserved')?.id??selectedBookingId;
  agendaTab='bookings';agendaIndex=0;renderAgenda();renderMap();
});
$('historyTab').addEventListener('click',()=>{agendaTab='history';agendaIndex=0;selectedBookingId=null;renderAgenda();renderMap();});
$('agendaPrevious').addEventListener('click',()=>{selectedBookingId=null;agendaIndex--;renderAgenda();renderMap();});
$('agendaNext').addEventListener('click',()=>{selectedBookingId=null;agendaIndex++;renderAgenda();renderMap();});
$('agendaContent').addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button||working)return;
  const proposal=plan?.proposals[agendaIndex];
  const meeting=employeeRecords().find(m=>m.id===button.dataset.bookingId);
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
    if(!workspace||result.instance_id!==workspace.instance_id||result.revision>=workspace.revision)workspace={...result,today:[workspace.today,result.clock.date].sort().at(-1)};
    if(disposed)return;tell(action==='start'?'started':action==='finish'?'ended':meeting.source==='attendance'?'attendanceRemoved':'cancelDone');showBooking(meeting.id);renderAdmin();
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
function showMapItem(event){
  if(event.type==='keydown'&&!['Enter',' ','ArrowRight','ArrowDown','ArrowLeft','ArrowUp'].includes(event.key))return;
  if(event.type==='keydown'&&['ArrowRight','ArrowDown','ArrowLeft','ArrowUp'].includes(event.key)&&event.target.dataset.seatId){
    const seats=[...$('layoutSvg').querySelectorAll('[data-seat-id]')],index=seats.indexOf(event.target);
    if(index>=0){event.preventDefault();const direction=['ArrowRight','ArrowDown'].includes(event.key)?1:-1;
      const next=seats[(index+direction+seats.length)%seats.length];event.target.tabIndex=-1;next.tabIndex=0;next.focus();}
    return;
  }
  if(event.type==='keydown'&&!['Enter',' '].includes(event.key))return;
  const target=event.target.closest('[data-room]')??event.target.closest('[data-seat-id]');
  if(!target)return;
  event.preventDefault();
  if(target.dataset.seatId&&!target.dataset.room){showDetail(target.dataset.seatId,t('unboundSeatDetails'));return;}
  openRoomDetails(target.dataset.room);
}
$('officeMap').addEventListener('click',showMapItem);
$('officeMap').addEventListener('keydown',showMapItem);
document.querySelectorAll('[data-area]').forEach(button=>button.addEventListener('click',()=>{
  activeArea=button.dataset.area;renderMap();
}));
$('layoutInfo').addEventListener('click',()=>showDetail(t('layoutSource'),t('layoutDetails')));
$('legacySeat').addEventListener('click',()=>openRoomDetails('office-f12'));
$('roomBookingPrevious').addEventListener('click',()=>{roomBookingPage--;renderRoomDetails();});
$('roomBookingNext').addEventListener('click',()=>{roomBookingPage++;renderRoomDetails();});
$('agendaContent').addEventListener('change',event=>{
  if(event.target.id==='roomChoice'){
    renderCandidateInfo();
    const room=workspace?.rooms.find(r=>r.id===event.target.value);
    if(room?.area){activeArea=room.area;renderMap();}
  }
});
document.querySelectorAll('[data-pane]').forEach(el=>el.addEventListener('click',()=>{pane=el.dataset.pane;renderMobile();renderMap();}));
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
  try{apiSession.configure($('key').value.trim(),$('model').value.trim());$('key').value='';$('keyStatus').textContent=t('keyReady');setupLanguage();$('settingsDialog').close();tell('keyReady');}
  catch(error){$('keyStatus').textContent=t(/model|モデル/.test(error.message)?'invalid_model':'keyRequired');}
});
$('clearKey').addEventListener('click',()=>{
  generation++;operation?.abort();apiSession.clear();$('key').value='';chatText='';chatTrace=null;
  setupLanguage();$('keyStatus').textContent=t('keyCleared');tell('keyCleared');
});

function rowsPerPage(){
  if(adminTab==='comfort')return Math.max(1,Math.min(6,Math.floor(($('adminResults').clientHeight-38)/50)));
  if(adminTab==='live'&&workspace?.admin_crud){
    const mobile=innerWidth<=600,available=$('adminResults').clientHeight;
    return Math.max(1,Math.min(mobile?3:8,Math.floor((available-(mobile?0:38))/(mobile?135:92))));
  }
  return innerHeight<650?2:innerWidth<600?3:innerHeight<820?4:6;
}
function tableMarkup(headers,rows,manage=false){
  if(!rows.length)return '<div class="empty">'+t('noRows')+'</div>';
  return '<div class="tableBox '+(manage?'liveTable':'')+'"><table><thead><tr>'+headers.map(h=>'<th>'+escape(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.map((r,i)=>'<tr>'+r.cells.map(c=>'<td><span class="cellValue" title="'+escape(c)+'">'+escape(c)+'</span></td>').join('')+'<td><div class="rowActions"><button data-row="'+i+'" data-label="view">'+t('view')+'</button>'+(manage?(r.detail.deleted?'<button data-row="'+i+'" data-admin-action="restore">'+t('restoreReservation')+'</button>':(r.detail.status==='in_progress'?'<button data-row="'+i+'" data-admin-action="finish">'+t('adminFinish')+'</button>':'<button data-row="'+i+'" data-admin-action="edit">'+t('editReservation')+'</button>')+(r.detail.status==='reserved'?'<button data-row="'+i+'" data-admin-action="cancel">'+t('cancel')+'</button>':'')+'<button data-row="'+i+'" data-admin-action="delete">'+t('deleteReservation')+'</button>'):'')+'</div></td></tr>').join('')+'</tbody></table></div>';
}

function liveTable(){
  const rows=workspace?.admin_crud?(liveData?.items??[]):workspace?.meetings??[];
  return {headers:[t('title'),t('room'),t('time'),t('bookedBy'),t('state'),t('details')],rows:rows.map(m=>({cells:[m.title,m.name,m.date+' '+m.time+'–'+m.end_time,
    m.source==='attendance'?t('attendanceSource'):m.source==='preset'&&m.booked_by==='System'?t('presetSource'):m.booked_by??t('employeeA'),t(m.deleted?'deleted':meetingState(m))],detail:m}))};
}
async function loadReservations(){
  if(!admin||!workspace?.admin_crud)return;
  if(!liveFilters){liveFilters={state:'all',query:''};$('liveStart').value='';$('liveEnd').value='';}
  const current=++liveGeneration;
  const filters={...Object.fromEntries(Object.entries(liveFilters).filter(([,v])=>v!=='')),limit:200};
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
  $('adminEditStatus').textContent=record&&['completed','cancelled'].includes(record.status)?t('history_schedule'):'';
  $('adminMeetingTitle').value=record?.title??'';
  $('adminDate').min=record&&['completed','cancelled'].includes(record.status)?'':workspace.today;
  $('adminDate').max=new Date(Date.parse(workspace.today)+30*86400000).toISOString().slice(0,10);
  $('adminDate').value=record?.date??workspace.today;
  $('adminTime').value=record?.time??workspace.clock.time;
  $('adminDuration').value=record?.request.duration??30;
  $('adminPeople').value=record?.people??2;
  $('adminRoom').innerHTML=workspace.rooms.map(r=>'<option value="'+escape(r.id)+'">'+escape(r.name)+' / '+r.capacity+'</option>').join('');
  $('adminRoom').value=record?.space_id??workspace.rooms[0].id;
  $('adminBookedBy').value=record?.booked_by??'';
  $('adminAssigned').value=record?.assigned_to??'other';
  $('adminAssigned').disabled=record?.source==='preset'||record?.source==='attendance';
  for(const id of ['adminDate','adminTime','adminDuration','adminRoom'])$(id).disabled=Boolean(record&&['completed','cancelled'].includes(record.status));
  renderAdminFeatures(record?.request.features??[]);
  $('adminEditDialog').showModal();
}
function renderAdminDelete(){
  const {record,action}=adminDeleting;
  const key={restore:'restoreReservation',delete:'deleteReservation',finish:'adminFinish',cancel:'cancel'}[action];
  $('adminDeleteTitle').textContent=t(key);$('adminDeleteConfirm').textContent=t(key);
  $('adminDeleteHint').textContent=t(action==='restore'?'restoreHint':action==='finish'?'adminFinishHint':action==='cancel'?'adminCancelHint':record.status==='in_progress'?'deleteActiveHint':'deleteHint');
  $('adminDeleteSummary').textContent=[record.title,record.name,record.date+' '+record.time+'–'+record.end_time,record.booked_by].join(' / ');
}
function openAdminDelete(record,action){
  adminDeleting={record:structuredClone(record),action,operationId:crypto.randomUUID()};
  $('adminDeleteStatus').textContent='';renderAdminDelete();$('adminDeleteDialog').showModal();
}
function inlineAdminError(id,error){
  const message=t(error.message);
  $(id).textContent=message===error.message?t('genericError'):message;
}
$('adminCreate').addEventListener('click',()=>openAdminEditor());
function renderBulkClear(){
  const preview=bulkClear?.preview;
  const stamp=value=>value?.replace('T',' ').slice(0,19)??'—';
  $('bulkClearPeriod').textContent=preview?t('clearReference')+': '+stamp(preview.reference_at)+'\n'+t('clearRange')+': '+t({all:'clearAll',today:'clearToday',hour:'clearHour',week:'clearWeek',month:'clearMonth'}[preview.range])+
    (preview.start_at?'\n'+stamp(preview.start_at)+' → '+stamp(preview.end_at):''):'';
  const counts=preview?[[t('clearTargets'),preview.count],[t('clearActive'),preview.active_count],[t('clearPresets'),preview.preset_count],[t('clearAttendance'),preview.attendance_count],[t('clearHistory'),preview.history_count??0],[t('clearSkipped'),preview.skipped_deleted]]:[];
  $('bulkClearCounts').innerHTML=counts.map(([label,count])=>'<div><span>'+escape(label)+'</span><b>'+count+'</b></div>').join('');
  $('bulkClearAgree').disabled=working||!preview?.count;
  $('bulkClearConfirm').disabled=working||!preview?.count||!$('bulkClearAgree').checked;
}
async function refreshBulkClear(){
  bulkClear={operationId:crypto.randomUUID(),preview:null};$('bulkClearAgree').checked=false;$('bulkClearStatus').textContent=t('busy');renderBulkClear();
  try{bulkClear.preview=await api('admin/clear-preview',{body:{range:$('bulkRange').value}});$('bulkClearStatus').textContent='';}
  catch(error){inlineAdminError('bulkClearStatus',error);throw error;}
  finally{renderBulkClear();}
}
$('adminClear').addEventListener('click',()=>{
  if(working||!workspace?.admin_crud)return;
  $('bulkRange').value='today';$('bulkClearDialog').showModal();perform(refreshBulkClear);
});
$('bulkRange').addEventListener('change',()=>perform(refreshBulkClear));
$('bulkClearPreview').addEventListener('click',()=>perform(refreshBulkClear));
$('bulkClearAgree').addEventListener('change',renderBulkClear);
$('bulkClearForm').addEventListener('submit',event=>{
  event.preventDefault();if(working||!bulkClear?.preview?.count||!$('bulkClearAgree').checked)return;
  const selection=bulkClear;
  perform(async()=>{
    let result;
    try{result=await api('admin/clear',{body:{preview_id:selection.preview.preview_id,operation_id:selection.operationId,confirmed:true}});}
    catch(error){bulkClear.preview=null;$('bulkClearAgree').checked=false;inlineAdminError('bulkClearStatus',error);renderBulkClear();throw error;}
    if(disposed)return;
    $('bulkClearDialog').close();bulkClear=null;
    liveFilters={...(liveFilters??{}),state:'not_deleted'};$('liveState').value='not_deleted';
    await sync();await loadReservations();
    tell('clearComplete');notice.count=result.deleted_count;$('notice').textContent=result.deleted_count+' '+t('clearComplete');
  });
});
let filterTimer,historyFilterTimer,filterGeneration=0;
async function applyLiveFilters(){
  if(working)return;
  const current=++filterGeneration;
  const start=$('liveStart').value,end=$('liveEnd').value;
  liveGeneration++;liveData=null;adminPage=0;renderAdmin();
  if(start&&end&&start>end){showError(new Error('invalid_window'));return;}
  liveFilters={start_date:start,end_date:end,space_id:$('liveRoom').value,state:$('liveState').value,query:$('liveSearch').value.trim()};
  try{await loadReservations();}catch(error){if(current!==filterGeneration)return;liveData=null;renderAdmin();showError(error);}
}
$('liveQuery').addEventListener('submit',event=>{event.preventDefault();clearTimeout(filterTimer);applyLiveFilters();});
for(const id of ['liveStart','liveEnd','liveRoom','liveState'])$(id).addEventListener('change',()=>{clearTimeout(filterTimer);return applyLiveFilters();});
$('liveSearch').addEventListener('input',()=>{clearTimeout(filterTimer);filterTimer=setTimeout(applyLiveFilters,250);});
$('clearFilters').addEventListener('click',()=>{for(const id of ['liveStart','liveEnd','liveRoom','liveSearch'])$(id).value='';$('liveState').value='all';applyLiveFilters();});
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
    try{await api('admin/'+(editor.record?'update':'create'),{body:{operation_id:editor.operationId,confirmed:true,data,
      ...(editor.record?{meeting_id:editor.record.id,expected_version:editor.record.version}:{})}});}
    catch(error){inlineAdminError('adminEditStatus',error);throw error;}
    if(disposed)return;
    $('adminEditDialog').close();
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
    $('adminDeleteDialog').close();
    await sync();await loadReservations();tell({delete:'reservationDeleted',restore:'reservationRestored',finish:'ended',cancel:'cancelDone'}[deletion.action]);
  });
});
for(const id of ['adminEditDialog','adminDeleteDialog','editDialog','attendanceDialog','bulkClearDialog']){
  $(id).addEventListener('cancel',event=>{if(working)event.preventDefault();});
  $(id).querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',event=>{if(working){event.stopImmediatePropagation();}} ,{capture:true}));
}
function historyTable(){
  const r=adminData?.result;if(!r)return {headers:[],rows:[]};
  if(adminTab==='comfort'){
    if(comfortMode==='thermal')return {headers:[t('room'),t('hotReports'),t('coldReports'),t('comfortPeriod'),t('details')],rows:r.items.filter(x=>x.hot_reports+x.cold_reports).map(x=>({cells:[x.location,x.hot_reports,x.cold_reports,periodLabel(x.thermal_period)],detail:t('comfortSource')+'\n'+x.location+'\n'+periodLabel(x.thermal_period)+'\n'+t('comfortDetails')}))};
    return {headers:[t('room'),t('questionGroup'),t('comfortResponses'),t('comfortScore'),t('details')],rows:r.items.flatMap(x=>x.surveys.map(s=>({cells:[x.location,s.question_group,s.responses,s.mean_score],detail:t('comfortSource')+'\n'+x.location+' / '+s.question_group+'\n'+periodLabel(s.period)+'\n'+t('comfortDetails')+(s.responses<3?'\n'+t('comfortInsufficient'):'')})))};
  }
  if(adminTab==='summary')return {headers:[t('room'),t('total'),t('used'),t('pendingCount'),t('details')],rows:r.items.map(x=>({cells:[x.name,x.total,x.used,x.total-x.used],detail:x}))};
  if(adminTab==='spaces')return {headers:[t('room'),t('people'),t('state'),t('details')],rows:r.items.map(x=>({cells:[x.space_name??x.name,x.capacity_reported??t('unknown'),x.type],detail:x}))};
  if(adminTab==='reservations')return {headers:[t('room'),t('date'),t('time'),t('state'),t('details')],rows:r.items.map(x=>({cells:[x.space_name??x.name,x.date,(x.start_raw??'').slice(11,16)+'–'+(x.end_raw??'').slice(11,16),reservationStatusLabel(x,locale)],detail:x}))};
  return {headers:[t('room'),t('eligible'),t('unused'),t('state'),t('details')],rows:r.items.map(x=>({cells:[x.name,x.eligible_reservations,x.unused_count,t(x.status==='review'?'reviewLabel':x.status)],detail:x}))};
}
function periodLabel(period){return [period?.start??'—',period?.end??'—'].join(' → ');}
function renderAdmin(){
  if(!admin)return;
  $('adminClear').hidden=adminTab!=='live'||!workspace?.admin_crud;
  $('adminRefresh').hidden=adminTab==='ai';
  $('adminTitle').textContent=t(adminTab);
  $('adminDescription').textContent=t(adminTab==='comfort'?'comfortDescription':adminTab==='live'?(workspace?.admin_crud?'adminLiveHint':'liveDesc'):adminTab==='ai'?'currentAiNote':'currentDataNote');
  if(adminTab==='comfort'&&adminData?.result.excluded)$('adminDescription').textContent+=' '+t('comfortExcluded')+': '+Object.values(adminData.result.excluded).reduce((sum,n)=>sum+n,0);
  document.querySelectorAll('[data-admin]').forEach(el=>el.classList.toggle('active',el.dataset.admin===adminTab));
  const query=!['live','ai','comfort'].includes(adminTab);
  $('comfortControls').hidden=adminTab!=='comfort';
  $('comfortPeriod').hidden=adminTab!=='comfort';
  $('comfortPeriod').textContent=t('comfortPeriod')+': '+periodLabel(comfortMode==='thermal'?adminData?.result.thermal_period:adminData?.result.satisfaction_period);
  $('adminMetrics').classList.toggle('feedbackMetrics',adminTab==='comfort');
  if(adminTab==='comfort')document.querySelector('.adminNav [data-i18n="boundary"]').textContent=t('comfortSource');
  else document.querySelector('.adminNav [data-i18n="boundary"]').textContent=t('boundary');
  $('comfortThermal').classList.toggle('active',comfortMode==='thermal');$('comfortSurvey').classList.toggle('active',comfortMode==='survey');
  $('adminTrace').hidden=adminTab==='comfort';
  $('adminQuery').hidden=!query;$('adminAskForm').hidden=adminTab!=='ai';$('reviewTools').hidden=true;
  $('liveQuery').hidden=adminTab!=='live'||!workspace?.admin_crud;
  if(!$('liveRoom').options.length&&workspace){$('liveRoom').innerHTML='<option value="">'+t('allStates')+'</option>'+workspace.rooms.map(r=>'<option value="'+escape(r.id)+'">'+escape(r.name)+'</option>').join('');}
  if($('liveRoom').options.length)$('liveRoom').options[0].textContent=t('allStates');
  $('startLabel').hidden=adminTab==='spaces';$('endLabel').hidden=adminTab==='spaces';$('searchLabel').hidden=adminTab!=='spaces';
  document.querySelectorAll('.reviewFilter').forEach(el=>{el.hidden=adminTab!=='review';});
  document.querySelectorAll('#adminQuery label').forEach(el=>{el.querySelector('input').disabled=el.hidden||!query||working;});
  const counts=liveData?.counts??{};
  const metrics=adminTab==='live'?[[t('filteredRecords'),counts.total??0],[t('active'),counts.in_progress??0],[t('endedCount'),counts.completed??0],[t('attendanceCount'),counts.attendance??0],[t('deleted'),counts.deleted??0]]
    :adminTab==='ai'?[]:adminTab==='comfort'?adminData?.result.source_rows?[[t('comfortThermal'),adminData.result.source_rows.aircon],[t('comfortSurvey'),adminData.result.source_rows.satisfaction]]:[]:adminData?[[t(adminTab==='spaces'?'spaces':'total'),adminData.result.total_records??adminData.result.total??adminData.result.total_spaces??0],[t('reviewCount'),adminData.result.review_count??'—']]:[];
  $('adminTrace').textContent=t(adminTab==='live'?'workspaceDetails':'raw');
  $('adminMetrics').hidden=!metrics.length;$('adminMetrics').innerHTML=metrics.map(([label,value])=>'<div class="metric"><span>'+label+'</span><b>'+escape(value)+'</b></div>').join('');
  if(adminTab==='ai'){
    const pages=textPages(chatText||t('aiEmpty'),Math.max(100,innerHeight-450));adminPage=Math.max(0,Math.min(adminPage,pages.length-1));
    $('adminResults').innerHTML='<div class="answerBox">'+escape(pages[adminPage])+'</div>';setAdminPager(pages.length);return;
  }
  const data=adminTab==='live'?liveTable():historyTable();
  const size=rowsPerPage(),count=Math.max(1,Math.ceil(data.rows.length/size));adminPage=Math.max(0,Math.min(adminPage,count-1));
  $('adminResults').innerHTML=tableMarkup(data.headers,data.rows.slice(adminPage*size,(adminPage+1)*size),adminTab==='live'&&workspace?.admin_crud);
  if(adminTab==='comfort'&&adminData?.result.source!=='enterprise_sample')$('adminResults').innerHTML='<p class="small">'+escape(t('comfortUnavailable'))+'</p>';
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
  adminData=null;adminTrace=null;renderAdmin();
  if(tab==='comfort'){
    const result=await api('comfort');
    if(disposed||current!==historyGeneration||tab!==adminTab)return;
    adminData={result};adminPage=0;tell(result.source==='enterprise_sample'?'comfortSource':'comfortUnavailable');renderAdmin();return;
  }
  const name={summary:'summarize_reservations',spaces:'search_spaces',reservations:'query_reservations',review:'detect_unused_reservations'}[tab];
  const status=await api('data/call',{body:{name:'get_data_status',arguments:{}}});
  const coverage=status.result.structuredContent.meta.coverage;
  const args=tab==='spaces'?{query:$('spaceSearch').value,limit:100}:{start_date:$('historyStart').value||coverage.start,end_date:$('historyEnd').value||coverage.end,limit:100};
  if(tab==='review')Object.assign(args,{min_reservations:Number($('minBookings').value),min_unused:Number($('minUnused').value),min_unused_percent:Number($('minPercent').value)});
  if(args.start_date>args.end_date)throw new Error('invalid_window');
  const payload=await api('data/call',{body:{name,arguments:args}});
  if(disposed||current!==historyGeneration||tab!==adminTab)return;
  if(payload.result.isError)throw new Error('invalid_request');
  const trace=[{name,arguments:{...args},response:structuredClone(payload.result)}];
  const result=payload.result.structuredContent.result;
  if(['reservations','spaces','review'].includes(tab))while(result.items.length<result.total){
    const next=await api('data/call',{body:{name,arguments:{...args,offset:result.items.length}}});
    if(next.revision!==payload.revision)throw new Error('state_changed');
    if(next.result.isError||!next.result.structuredContent.result.items.length)throw new Error('genericError');
    trace.push({name,arguments:{...args,offset:result.items.length},response:structuredClone(next.result)});
    result.items.push(...next.result.structuredContent.result.items);
  }
  if(disposed||current!==historyGeneration||tab!==adminTab)return;
  adminData={result};adminTrace={scope:'current_workspace',revision:payload.revision,calls:trace};adminPage=0;
  if(tab==='review')adminData.comparison=comparison.check(adminData.result.comparison_snapshot);
  tell('dataLoaded');renderAdmin();
}
$('adminQuery').addEventListener('submit',event=>{event.preventDefault();clearTimeout(historyFilterTimer);perform(runHistory);});
for(const [id,mode] of [['comfortThermal','thermal'],['comfortSurvey','survey']])$(id).addEventListener('click',()=>{comfortMode=mode;adminPage=0;renderAdmin();});
for(const id of ['historyStart','historyEnd','minBookings','minUnused','minPercent'])$(id).addEventListener('change',()=>{clearTimeout(historyFilterTimer);perform(runHistory);});
$('spaceSearch').addEventListener('input',()=>{clearTimeout(historyFilterTimer);historyFilterTimer=setTimeout(()=>perform(runHistory),250);});
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
$('adminTrace').addEventListener('click',()=>showDetail(t(adminTab==='live'?'workspaceDetails':'raw'),t(adminTab==='live'?'snapshotNote':'traceNote')+'\n\n'+JSON.stringify(adminTab==='ai'?chatTrace:adminTab==='live'?workspace:adminTrace,null,2)));
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
    const result=await api('data/chat',{body:{message:question+'\n'+(locale==='en'?'Answer in English.':'日本語で回答してください。'),model:apiSession.model,history:[]},headers:auth.headers,signal:auth.signal});
    if(disposed)return;chatText=result.answer;chatTrace={trace:result.trace,usage:result.usage};adminPage=0;renderAdmin();
  });
});
window.addEventListener('resize',()=>{renderMap();renderAdmin();if($('detailDialog').open)renderDetail();if($('roomDialog').open)renderRoomDetails();});
window.addEventListener('pagehide',()=>{
  disposed=true;generation++;historyGeneration++;operation?.abort();apiSession.clear();$('key').value='';clearInterval(poll);clearTimeout(filterTimer);clearTimeout(historyFilterTimer);
});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
setupLanguage();
try{
  await sync();
  if(!disposed)poll=setInterval(()=>{if(!document.hidden&&!working)sync().catch(error=>{if(!disposed)showError(error);});},5000);
}catch(error){showError(error);}
