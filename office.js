import { layoutAreas, layoutPosition, renderOfficeLayout } from './office-layout.js';
import { ApiSession, ReviewComparison } from './session.js';
import { applyLanguage, translator, reservationStatusLabel, errorKey } from './ui-i18n.js';
import { createCalendarUI } from './calendar-ui.js';
import { createEquipmentFeedbackUI, renderSuggestionBoard, suggestionText } from './equipment-feedback-ui.js';

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
let improvementReport=null, improvementDraft=null, improvementRevision=null, improvementInstance=null, improvementLocale=null, improvementTrace=null;
let improvementRunning=false;
let working = false, disposed = false, generation = 0, operation = null, poll = null;
let detail = {title:'',text:'',page:0}, editing = null, demoStep = -1;
let attendanceEditing=null;
let liveFilters=null,liveData=null,liveGeneration=0,adminEditing=null,adminDeleting=null;
let bulkClear=null,bulkMode='clear';
let notice = {key:admin?'adminReady':'ready',error:false}, chatText = '', chatTrace = null;
let calendarUI=null;
let equipmentUI=null;
const improvementScope=()=>$('improvementScope').value||'allocation';
let planSource='manual',manualDraft='',calendarExport=null,calendarReviewReport=null,calendarRangeOpen=true;

async function http(path, {body, headers = {}, signal, timeoutMs=70000, method = body === undefined ? 'GET' : 'POST'} = {}) {
  let response;
  try{response=await fetch(path,{method,cache:'no-store',headers:{'Content-Type':'application/json',...headers},
    ...(body === undefined ? {} : {body:JSON.stringify(body)}),signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)});}
  catch(error){if(error.name==='AbortError'||error.name==='TimeoutError')throw error;throw new Error('demo_network');}
  let result;
  try{result=await response.json();}catch{const error=new Error('demo_response_invalid');error.status=response.status;throw error;}
  if (!response.ok) { const error = new Error(result.error || 'genericError');error.status=response.status;error.diagnostics=result.diagnostics;throw error; }
  return result;
}
const api = (path, options) => http('/api/office/'+path,options);
function calendarExportChanged(){
  if(!calendarExport||!workspace)return false;
  if($('calendarExportStart').value!==calendarExport.start_date||$('calendarExportEnd').value!==calendarExport.end_date)return true;
  if(calendarExport.instance_id!==workspace.instance_id||calendarExport.start_date<workspace.today)return true;
  const days=new Set([...Object.keys(calendarExport.calendar_days??{}),...Object.keys(workspace.calendar_day_versions??{})]);
  return [...days].some(day=>day>=calendarExport.start_date&&day<=calendarExport.end_date
    &&(calendarExport.calendar_days?.[day]??null)!==(workspace.calendar_day_versions?.[day]??null));
}
function renderCalendarInput(){
  const selected=planSource==='calendar';document.querySelector('.planPane').classList.toggle('calendarInputMode',selected);$('planSource').value=planSource;$('planSource').disabled=working;
  document.querySelector('.planPane').classList.toggle('calendarRangeCollapsed',selected&&Boolean(calendarExport)&&!calendarRangeOpen);
  document.querySelector('.planPane').classList.toggle('hasCalendarExport',selected&&Boolean(calendarExport));
  $('calendarRangeToggle').hidden=!calendarExport;$('calendarRangeToggle').disabled=working;
  $('calendarRangeToggle').textContent=t(calendarRangeOpen?'calendarRangeHide':'calendarRangeEdit')+(calendarExport?' · '+$('calendarExportStart').value+' → '+$('calendarExportEnd').value:'');
  $('calendarExportControls').hidden=!selected;$('calendarSupplementLabel').hidden=!selected;$('calendarImportStatus').hidden=!selected;
  $('intent').readOnly=selected;$('intent').required=!selected;$('useExample').hidden=selected;
  $('homePlanLabel').textContent=t(selected?'calendarPreview':'planLabel');
  for(const id of ['calendarExportStart','calendarExportEnd']){
    $(id).disabled=working||!selected;
    if(workspace){$(id).min=workspace.today;$(id).max=new Date(Date.parse(workspace.today)+30*86400000).toISOString().slice(0,10);if(!$(id).value)$(id).value=workspace.today;}
  }
  $('calendarSupplement').disabled=working||!selected;$('exportCalendar').disabled=working;
  const mismatch=calendarExport&&($('calendarExportStart').value!==calendarExport.start_date||$('calendarExportEnd').value!==calendarExport.end_date);
  const stale=calendarExportChanged()||mismatch;
  if(selected){
    $('intent').value=calendarExport?calendarExport.events.filter(e=>e.status==='active').map(e=>[e.date+' '+e.time+'–'+e.end_time+'  '+e.title,
      e.people===null?'':t('people')+': '+e.people,e.notes].filter(Boolean).join('\n')).join('\n\n'):'';
    $('intent').placeholder=t('calendarPreviewHint');
    $('calendarImportStatus').textContent=t(!calendarExport?'calendarExportFirst':stale?'calendarExportStale':!calendarExport.events.length?'calendarExportEmpty':'calendarExportReady')
      +(calendarExport&&!stale?' '+calendarExport.events.filter(e=>e.status==='active').length+' '+t('calendarExportItems'):'');
  }
  if(!selected)$('intent').placeholder=t('planPlaceholder');
  if(selected&&calendarReviewReport&&!stale)$('calendarImportStatus').textContent=t('calendarReviewCounts').replace('{new}',calendarReviewReport.newCount).replace('{reused}',calendarReviewReport.progress.total-calendarReviewReport.newCount);
  $('calendarTrace').hidden=!calendarReviewReport||!selected||stale;
  $('parseButton').disabled=working||(selected&&(!calendarExport||stale||!calendarExport.events.length));
}
function clearSuggestions(){plan=null;agendaTab='proposals';agendaIndex=0;renderAgenda();renderMap();}
async function exportCalendar(){
  await sync();
  const result=await api('calendar/export',{body:{start_date:$('calendarExportStart').value,end_date:$('calendarExportEnd').value,
    revision:workspace.revision,instance_id:workspace.instance_id,locale}});
  calendarExport=result;calendarRangeOpen=false;calendarReviewReport=null;clearSuggestions();renderCalendarInput();tell('calendarExportReady');
}
async function reviewExport(){
  if(!calendarExport||calendarExportChanged())throw new Error('calendar_export_changed');
  if(!apiSession.configured){$('settingsDialog').showModal();throw new Error('keyRequired');}
  const exported=calendarExport;generation++;const current=generation;
  operation?.abort();operation=new AbortController();
  const auth=apiSession.begin('Calendar export '+exported.export_id),trace=[];
  let remaining=Infinity,newCount=0,result;
  clearSuggestions();calendarReviewReport=null;
  try{
    for(let batch=0;batch<20;batch++){
      await sync();
      if(disposed||current!==generation)return;
      if(calendarExport!==exported||calendarExportChanged())throw new Error('calendar_export_changed');
      $('calendarImportStatus').textContent=t('calendarReviewProgress').replace('{count}',newCount);
      tell('calendarRunning');
      result=await api('calendar/review',{body:{export_id:exported.export_id,revision:workspace.revision,instance_id:workspace.instance_id,
        locale,model:apiSession.model,supplement:$('calendarSupplement').value.trim()},headers:auth.headers,
        signal:AbortSignal.any([auth.signal,operation.signal]),timeoutMs:115000});
      if(disposed||current!==generation)return;
      newCount+=result.progress.newly_analyzed;trace.push(...(result.trace??[]));
      if(!result.progress.remaining)break;
      if(result.progress.remaining>=remaining)throw new Error('calendar_incomplete');
      remaining=result.progress.remaining;
    }
  }catch(error){
    if(disposed||current!==generation)return;
    if(['calendar_export_expired','calendar_export_changed'].includes(error.message)){
      calendarExport=null;calendarReviewReport=null;clearSuggestions();renderCalendarInput();
    }
    throw error;
  }
  if(!result?.plan_id||result.progress.remaining)throw new Error('calendar_incomplete');
  plan=result;pane='agenda';calendarReviewReport={...result,trace,newCount};
  tell(newCount?'calendarDone':'calendarReviewReused');renderAgenda();renderMap();renderMobile();renderCalendarInput();
  $('calendarImportStatus').textContent=t('calendarReviewCounts').replace('{new}',newCount).replace('{reused}',result.progress.total-newCount);
  if(result.cancelled_events?.some(e=>e.booking_ids.length))showDetail(t('calendarCancelledReview'),result.cancelled_events.filter(e=>e.booking_ids.length).map(e=>e.date+' '+e.title).join('\n')+'\n\n'+t('calendarBookingWarning'));
}
function tell(key,error=false) { notice={key,error};$('notice').textContent=t(key);$('notice').classList.toggle('error',error);$('errorDetails').hidden=!error; }
function showError(error) {
  const reason=error.diagnostics?.agent?.validation?.reason,specific='agentValidation_'+reason;
  tell(reason&&t(specific)!==specific?specific:errorKey(error),true);
  notice.diagnostics=error.diagnostics;notice.status=error.status;
}
$('errorDetails').addEventListener('click',()=>{
  const info=notice.diagnostics??{},lines=[t(notice.key),t('errorSource')+': '+t('errorSource_'+(info.source??'local'))];
  for(const [key,value] of [['errorHttp',notice.status],['errorUpstream',info.upstream_status],['errorCode',info.code],['errorType',info.type],['errorParam',info.param],['errorRequestId',info.request_id]])
    if(value!==undefined)lines.push(t(key)+': '+value);
  if(info.agent)lines.push(agentProgressText(info.agent));
  lines.push(t('errorNoRaw'));
  showDetail(t('errorDetails'),lines.join('\n\n'));
});
function lock(value) {
  working=value;
  $('improvementForm').querySelectorAll('input,button').forEach(el=>{el.disabled=value;});
  document.querySelectorAll('#intentForm button,#intentForm select,#intentForm textarea,#agendaContent button,#agendaContent select,#adminAskForm button,#adminQuery input,#adminQuery button,#liveQuery input,#liveQuery select,#liveQuery button,#adminEditForm input,#adminEditForm select,#adminEditForm button,#editForm input,#editForm select,#editForm button,#adminDeleteConfirm,[data-admin],#adminRefresh,#reviewDemo,#keyForm button:not(#clearKey),#proposalsTab,#bookingsTab,[data-close]').forEach(el=>{el.disabled=value;});
  $('attendanceForm').querySelectorAll('input,select,button').forEach(el=>{el.disabled=value;});
  $('historyTab').disabled=value;
  $('adminPurgeAgree').disabled=value;
  $('adminClear').disabled=value;
  $('adminBulkPurge').disabled=value;
  $('bulkClearForm').querySelectorAll('input,select,button').forEach(el=>{el.disabled=value;});
  $('parseButton').textContent=t(value?'busy':'analyse');
  if(!value){if(adminEditing?.record){const r=adminEditing.record;$('adminAssigned').disabled=['preset','attendance'].includes(r.source);for(const id of ['adminDate','adminTime','adminDuration','adminRoom'])$(id).disabled=['completed','cancelled'].includes(r.status);}if($('editDialog').open)editorMode();renderAdmin();}
  if($('bulkClearDialog').open)renderBulkClear();
  if($('adminDeleteDialog').open)renderAdminDelete();
  calendarUI?.render();
  equipmentUI?.render();
  renderCalendarInput();
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
  if(detail.improvement){
    const content=improvementDetailContent(detail.improvement);
    if(!content){
      detail={title:'',text:'',page:0};$('detailTitle').textContent='';$('detailText').textContent='';$('detailDialog').close();return;
    }
    if(content.stale!==detail.stale||detail.locale!==locale)detail.page=0;
    Object.assign(detail,content,{locale});
    if(content.stale)detail.title=t('improvementPrevious')+' / '+content.title;
  }
  const pages=textPages(detail.text);detail.page=Math.min(detail.page,pages.length-1);
  $('detailTitle').textContent=detail.title;$('detailText').textContent=pages[detail.page];
  $('detailPage').textContent=(detail.page+1)+' / '+pages.length;
  $('detailPrevious').disabled=detail.page===0;$('detailNext').disabled=detail.page===pages.length-1;
}
function showDetail(title, value, improvement=null) {
  detail={title,text:typeof value==='string'?value:JSON.stringify(value,null,2),page:0,...(improvement?{improvement}:{})};
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
  equipmentUI?.languageChanged();
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
  $('errorDetails').hidden=!notice.error;
  $('keyStatus').textContent=t(apiSession.source==='local'?'localKeyReady':apiSession.configured?'keyReady':'noKey');
  $('keyBadge').textContent=t(apiSession.source==='local'?'localKeyBadge':apiSession.configured?'withKey':'noKey');
  $('keyBadge').classList.toggle('connected',apiSession.configured);
  if(workspace)$('today').textContent=workspace.today;
  calendarUI?.render();
  renderCalendarInput();
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
    if(plan.calendar_origin){
      actions=actions.replace(/<button[^>]*data-(?:edit|replan|distinct)[^>]*>[^<]*<\/button>/g,'');
      actions+='<button data-calendar>'+t('calendarOpen')+'</button>';
      if(item.issues?.includes('calendar_booking_changed')){body=t('calendar_booking_changed');actions='<button data-calendar>'+t('calendarOpen')+'</button><button data-view-booking="'+escape(item.existing.id)+'">'+t('bookings')+'</button>';}
    }
    if(a.type==='meeting'&&!done&&!missing&&item.status!=='duplicate_in_plan'&&!plan.calendar_origin)actions+='<button data-attendance>'+t('notMyBooking')+'</button>';
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
  const purgedChanged=workspace&&(result.purged_ids??[]).some(id=>!(workspace.purged_ids??[]).includes(id));
  if(purgedChanged){
    plan=null;selectedBookingId=null;agendaIndex=0;adminData=null;adminTrace=null;
    improvementReport=null;improvementDraft=null;improvementTrace=null;chatText='';chatTrace=null;
  }
  if(restarted||(result.reset_generation??0)>(workspace?.reset_generation??0)){
    plan=null;selectedBookingId=null;agendaIndex=0;agendaTab='proposals';
    calendarUI?.clear();calendarExport=null;calendarReviewReport=null;
  }
  if(plan?.calendar_origin){
    const origin=plan.calendar_origin;
    if(origin.days){
      const valid=plan.proposals.filter(p=>(result.calendar_day_versions?.[p.activity.date]??null)===(origin.days[p.activity.date]??null));
      if(valid.length!==plan.proposals.length){plan=valid.length?{...plan,proposals:valid}:null;tell('calendar_changed',true);}
    }else if(origin.revision!==result.calendar_revision){plan=null;agendaTab='proposals';agendaIndex=0;tell('calendar_changed',true);}
  }
  workspace=result;$('today').textContent=result.today;
  calendarUI?.changed();
  if(restarted){calendarExport=null;calendarReviewReport=null;}
  renderCalendarInput();
  if(deploymentChanged)setupLanguage();
  if(changed){renderAgenda();renderMap();if($('roomDialog').open)renderRoomDetails();if(admin&&adminTab==='live'){if(result.admin_crud)await loadReservations();else renderAdmin();}else if(admin&&adminTab==='improvements')renderAdmin();else if(admin&&adminTab!=='ai')await runHistory();}
  if($('detailDialog').open&&detail.improvement)renderDetail();
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
  if(employeeRecords().some(r=>r.id===id&&r.calendar_event_id))return calendarUI.open();
  const result=await api('rebook',{body:{meeting_id:id,locale}});
  if(disposed)return;
  await sync();plan=result;agendaTab='proposals';agendaIndex=0;pane='agenda';
  tell('rebookReady');renderAgenda();renderMap();renderMobile();
}
$('intentForm').addEventListener('submit',event=>{
  event.preventDefault();
  if(planSource==='calendar'){perform(reviewExport);return;}
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
$('planSource').addEventListener('change',()=>{
  if(working)return;
  if(planSource==='manual')manualDraft=$('intent').value;
  planSource=$('planSource').value==='calendar'?'calendar':'manual';
  if(planSource==='manual')$('intent').value=manualDraft;
  clearSuggestions();renderCalendarInput();
});
$('exportCalendar').addEventListener('click',()=>perform(exportCalendar));
$('calendarRangeToggle').addEventListener('click',()=>{if(working)return;calendarRangeOpen=!calendarRangeOpen;renderCalendarInput();});
for(const id of ['calendarExportStart','calendarExportEnd'])$(id).addEventListener('change',()=>{calendarRangeOpen=true;calendarReviewReport=null;clearSuggestions();renderCalendarInput();});
$('calendarSupplement').addEventListener('input',()=>{calendarReviewReport=null;clearSuggestions();renderCalendarInput();});
$('calendarTrace').addEventListener('click',()=>{
  const report=calendarReviewReport;if(!report)return;
  const steps=[...report.trace,...report.proposals.flatMap(p=>p.trace??[])];
  showDetail(t('calendarTrace'),t('calendarReviewCounts').replace('{new}',report.newCount).replace('{reused}',report.progress.total-report.newCount)
    +'\n\n'+(report.summary??'')+'\n\n'+steps.map((step,i)=>(i+1)+'. '+step.name+'\n'+JSON.stringify(step.arguments)).join('\n\n'));
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
  if(button.hasAttribute('data-calendar'))return perform(()=>calendarUI.open());
  if(button.hasAttribute('data-attendance'))return openAttendance(proposal);
  if(button.dataset.attendanceRecord)return openAttendance(null,workspace.meetings.find(m=>m.id===button.dataset.attendanceRecord));
  if(button.dataset.details)return showDetail(t('details'),button.dataset.details==='booking'?meeting:{questions:plan.questions,...proposal});
  if(button.dataset.viewBooking)return showBooking(button.dataset.viewBooking);
  if(button.hasAttribute('data-original')){agendaIndex=plan.proposals.findIndex(p=>p.id===proposal.existing_proposal_id);renderAgenda();renderMap();return;}
  if(button.hasAttribute('data-reuse'))return perform(async()=>{
    if(plan?.calendar_origin)await api('confirm',{body:{plan_id:plan.plan_id,proposal_id:proposal.id,space_id:proposal.existing.space_id,confirmed:true}});
    await sync();tell('reused');showBooking(button.dataset.reuse);
  });
  if(button.dataset.rebook)return perform(()=>meeting?.calendar_event_id?calendarUI.open():rebook(button.dataset.rebook));
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
async function loadLocalSettings(){
  let config;
  try{config=await api('config');}
  catch(error){apiSession.configureLocal({available:false});$('localKeyControls').hidden=false;setupLanguage();throw error;}
  apiSession.configureLocal({available:config.local_key_available===true,model:config.local_model??'gpt-6.1-sol'});
  $('localKeyControls').hidden=config.local_model===undefined;
  if(apiSession.source!=='page')$('model').value=apiSession.model;
  setupLanguage();
}
$('openSettings').addEventListener('click',()=>{$('settingsDialog').showModal();perform(loadLocalSettings);});
$('reloadLocalKey').addEventListener('click',()=>perform(async()=>{await loadLocalSettings();tell(apiSession.source==='local'?'localKeyReady':apiSession.source==='page'?'keyReady':'noKey');}));
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>$(button.dataset.close).close()));
$('detailPrevious').addEventListener('click',()=>{detail.page--;renderDetail();});
$('detailNext').addEventListener('click',()=>{detail.page++;renderDetail();});
for(const id of ['openHelp','limitsButton'])$(id).addEventListener('click',()=>showDetail(t('help'),t('boundary')+'\n\n'+t('helpText')+'\n\n'+t('privacy')));
$('showEvents').addEventListener('click',()=>showDetail(t('showEvents'),workspace.events.map(e=>[t(e.type==='started'?'in_progress':e.type),e.room,e.demo_date+' '+e.demo_time,e.at].filter(Boolean).join(' / ')).join('\n')||t('noRows')));
$('keyForm').addEventListener('submit',event=>{
  event.preventDefault();if(working)return;
  try{apiSession.configure($('key').value.trim(),$('model').value.trim());$('key').value='';$('keyStatus').textContent=t('keyReady');setupLanguage();$('settingsDialog').close();tell('keyReady');}
  catch(error){$('keyStatus').textContent=t(errorKey(error));}
});
$('clearKey').addEventListener('click',()=>{
  generation++;operation?.abort();apiSession.clear();calendarReviewReport=null;$('key').value='';chatText='';chatTrace=null;
  historyGeneration++;improvementReport=null;improvementDraft=null;improvementTrace=null;
  equipmentUI?.clear();
  if(detail.improvement)renderDetail();
  if(apiSession.source==='local')$('model').value=apiSession.model;
  setupLanguage();const cleared=apiSession.source==='local'?'localKeyRestored':'keyCleared';$('keyStatus').textContent=t(cleared);tell(cleared);
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
  return '<div class="tableBox '+(manage?'liveTable':'')+'"><table><thead><tr>'+headers.map(h=>'<th>'+escape(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.map((r,i)=>'<tr>'+r.cells.map(c=>'<td><span class="cellValue" title="'+escape(c)+'">'+escape(c)+'</span></td>').join('')+'<td><div class="rowActions"><button data-row="'+i+'" data-label="view">'+t('view')+'</button>'+(manage?(r.detail.deleted?'<button data-row="'+i+'" data-admin-action="restore">'+t('restoreReservation')+'</button><button class="danger" data-row="'+i+'" data-admin-action="purge">'+t('purgeReservation')+'</button>':(r.detail.status==='in_progress'?'<button data-row="'+i+'" data-admin-action="finish">'+t('adminFinish')+'</button>':'<button data-row="'+i+'" data-admin-action="edit">'+t('editReservation')+'</button>')+(r.detail.status==='reserved'?'<button data-row="'+i+'" data-admin-action="cancel">'+t('cancel')+'</button>':'')+'<button data-row="'+i+'" data-admin-action="delete">'+t('deleteReservation')+'</button>'):'')+'</div></td></tr>').join('')+'</tbody></table></div>';
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
  const key={restore:'restoreReservation',delete:'deleteReservation',finish:'adminFinish',cancel:'cancel',purge:'purgeReservation'}[action];
  $('adminDeleteTitle').textContent=t(key);$('adminDeleteConfirm').textContent=t(key);
  $('adminDeleteHint').textContent=t(action==='purge'?'purgeHint':action==='restore'?'restoreHint':action==='finish'?'adminFinishHint':action==='cancel'?'adminCancelHint':record.status==='in_progress'?'deleteActiveHint':'deleteHint');
  $('adminPurgeAgreement').hidden=action!=='purge';
  $('adminDeleteConfirm').classList.toggle('danger',action==='purge');$('adminDeleteConfirm').classList.toggle('primary',action!=='purge');
  $('adminDeleteConfirm').disabled=working||action==='purge'&&!$('adminPurgeAgree').checked;
  $('adminDeleteSummary').textContent=[record.title,record.name,record.date+' '+record.time+'–'+record.end_time,record.booked_by].join(' / ');
}
function openAdminDelete(record,action){
  adminDeleting={record:structuredClone(record),action,operationId:crypto.randomUUID()};
  $('adminPurgeAgree').checked=false;
  $('adminDeleteStatus').textContent='';renderAdminDelete();$('adminDeleteDialog').showModal();
}
function inlineAdminError(id,error){
  $(id).textContent=t(errorKey(error));
}
$('adminCreate').addEventListener('click',()=>openAdminEditor());
function renderBulkClear(){
  const preview=bulkClear?.preview,purge=bulkMode==='purge';
  $('bulkClearDialog').classList.toggle('bulkPurgeDialog',purge);
  $('bulkClearTitle').textContent=t(purge?'bulkPurge':'bulkClear');
  $('bulkClearBasis').textContent=t(purge?'bulkPurgeBasis':'clearBasis');
  $('bulkClearBoundary').textContent=t(purge?'bulkPurgeBoundary':'clearBoundary');
  $('bulkClearAgreement').textContent=t(purge?'bulkPurgeAgree':'clearAgree');
  $('bulkClearConfirm').textContent=t(purge?'bulkPurgeConfirm':'clearConfirm');
  $('bulkHour').hidden=purge;$('bulkHour').disabled=purge;
  const stamp=value=>value?.replace('T',' ').slice(0,19)??'—';
  $('bulkClearPeriod').textContent=preview?t('clearReference')+': '+stamp(preview.reference_at)+'\n'+t('clearRange')+': '+t({all:'clearAll',today:'clearToday',hour:'clearHour',week:'clearWeek',month:'clearMonth'}[preview.range])+
    (preview.start_at?'\n'+stamp(preview.start_at)+' → '+stamp(preview.end_at):''):'';
  const counts=!preview?[]:purge?[[t('bulkPurgeTargets'),preview.count],[t('clearAttendance'),preview.attendance_count],[t('bulkPurgeExcluded'),preview.skipped_not_deleted]]:
    [[t('clearTargets'),preview.count],[t('clearActive'),preview.active_count],[t('clearPresets'),preview.preset_count],[t('clearAttendance'),preview.attendance_count],[t('clearHistory'),preview.history_count??0],[t('clearSkipped'),preview.skipped_deleted]];
  $('bulkClearCounts').innerHTML=counts.map(([label,count])=>'<div><span>'+escape(label)+'</span><b>'+count+'</b></div>').join('');
  $('bulkClearAgree').disabled=working||!preview?.count;
  $('bulkClearConfirm').disabled=working||!preview?.count||!$('bulkClearAgree').checked;
}
async function refreshBulkClear(){
  bulkClear={operationId:crypto.randomUUID(),preview:null};$('bulkClearAgree').checked=false;$('bulkClearStatus').textContent=t('busy');renderBulkClear();
  try{bulkClear.preview=await api('admin/'+(bulkMode==='purge'?'purge-preview':'clear-preview'),{body:{range:$('bulkRange').value}});$('bulkClearStatus').textContent='';}
  catch(error){inlineAdminError('bulkClearStatus',error);throw error;}
  finally{renderBulkClear();}
}
function openBulkClear(mode){
  if(working||!workspace?.admin_crud)return;
  bulkMode=mode;
  $('bulkRange').value='today';$('bulkClearDialog').showModal();perform(refreshBulkClear);
}
$('adminClear').addEventListener('click',()=>openBulkClear('clear'));
$('adminBulkPurge').addEventListener('click',()=>openBulkClear('purge'));
$('bulkRange').addEventListener('change',()=>perform(refreshBulkClear));
$('bulkClearPreview').addEventListener('click',()=>perform(refreshBulkClear));
$('bulkClearAgree').addEventListener('change',renderBulkClear);
$('bulkClearForm').addEventListener('submit',event=>{
  event.preventDefault();if(working||!bulkClear?.preview?.count||!$('bulkClearAgree').checked)return;
  const selection=bulkClear,purge=bulkMode==='purge';
  perform(async()=>{
    let result;
    try{result=await api('admin/'+(purge?'purge-deleted':'clear'),{body:{preview_id:selection.preview.preview_id,operation_id:selection.operationId,confirmed:true,...(purge?{purge_confirmation:'PERMANENT_DELETE'}:{})}});}
    catch(error){bulkClear.preview=null;$('bulkClearAgree').checked=false;inlineAdminError('bulkClearStatus',error);renderBulkClear();throw error;}
    if(disposed)return;
    $('bulkClearDialog').close();bulkClear=null;
    liveFilters={...(liveFilters??{}),state:purge?'deleted':'not_deleted'};$('liveState').value=liveFilters.state;
    await sync();await loadReservations();
    const key=purge?'bulkPurgeComplete':'clearComplete',count=purge?result.purged_count:result.deleted_count;
    tell(key);notice.count=count;$('notice').textContent=count+' '+t(key);
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
  if(adminDeleting.action==='purge'&&!$('adminPurgeAgree').checked)return;
  const deletion=adminDeleting;$('adminDeleteStatus').textContent=t('busy');
  perform(async()=>{
    let result;
    try{result=await api('admin/'+deletion.action,{body:{operation_id:deletion.operationId,confirmed:true,meeting_id:deletion.record.id,expected_version:deletion.record.version,...(deletion.action==='purge'?{purge_confirmation:'PERMANENT_DELETE'}:{})}});}
    catch(error){inlineAdminError('adminDeleteStatus',error);throw error;}
    if(disposed)return;
    $('adminDeleteDialog').close();
    await sync();await loadReservations();tell({delete:'reservationDeleted',restore:'reservationRestored',finish:'ended',cancel:'cancelDone',purge:'reservationPurged'}[deletion.action]);
  });
});
$('adminPurgeAgree').addEventListener('change',renderAdminDelete);
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
function improvementStale(period=improvementReport?.period,revision=improvementRevision,instance=improvementInstance){
  return !period || revision!==workspace?.revision || instance!==workspace?.instance_id
    || period.start_date!==$('improvementStart').value || period.end_date!==$('improvementEnd').value;
}
function renderImprovements(){
  if($('detailDialog').open&&detail.improvement)renderDetail();
  const report=improvementReport,stale=improvementStale();
  $('improvementAnalyze').disabled=working;
  $('improvementAnalyze').textContent=t(improvementRunning?'improvementRunning':'improvementAnalyze');
  $('improvementRunStatus').textContent=t(improvementRunning?'improvementWorking':apiSession.configured?'improvementReady':'improvementKeyNeeded');
  $('adminTrace').textContent=t('agentTrace');$('adminTrace').disabled=!improvementTrace;
  const policy='<button data-improvement-policy="true" class="subtle">'+t('improvementPolicy')+'</button>';
  if(!report){$('adminResults').innerHTML='<div class="empty"><h3>'+t(improvementTrace?.failed?'improvementFailed':'improvementEmpty')+'</h3><p>'+t(improvementTrace?.failed?'improvementFailureHint':'improvementMinimum')+'</p>'+policy+'</div>';setAdminPager(1);return;}
  const cards=report.items, draft=improvementLocale===locale?improvementDraft:null;
  const ordered=draft?.items.map(item=>cards.find(card=>card.finding_id===item.finding_id))??cards;
  adminPage=Math.max(0,Math.min(adminPage,Math.max(1,ordered.length)-1));
  const card=ordered[adminPage];
  const top='<p class="improvementScope">'+escape(report.period.start_date+' → '+report.period.end_date)+' / '+t('improvementSimulation')+'</p>';
  const warning=stale?'<p class="improvementWarning" role="status">'+t('improvementStale')+'</p>':'';
  if(!card){$('adminResults').innerHTML=top+warning+'<div class="empty"><h3>'+t(report.status==='insufficient_data'?'improvementInsufficient':'improvementNoIssue')+'</h3><p>'+escape(draft?.summary?.slice(0,180)??t(improvementDraft?'improvementAiLanguage':'improvementMinimum'))+'</p>'+policy+'<p>'+t('improvementBoundary')+'</p></div>';setAdminPager(1);return;}
  const suggestions=ordered.map(finding=>({...draft?.items.find(item=>item.finding_id===finding.finding_id),kind:'allocation',finding,
    recommendation:improvementDraft?.recommendations?.[finding.finding_id]}));
  $('adminResults').innerHTML=top+warning+(improvementLocale!==locale?'<p class="staleNotice">'+t('improvementAiLanguage')+'</p>':'')+'<div class="suggestionCount" role="status">'+t('suggestionShowing')+' '+suggestions.length+' / '+suggestions.length+'</div>'
    +renderSuggestionBoard(suggestions,adminPage,t,{evidenceAttribute:'data-improvement-evidence',detailAttribute:'data-improvement-action',identity:index=>ordered[index].finding_id});
  setAdminPager(Math.max(1,ordered.length));
}
async function analyzeImprovements(){
  if(!apiSession.configured){$('settingsDialog').showModal();throw new Error('keyRequired');}
  const start=$('improvementStart').value,end=$('improvementEnd').value;
  if(!start||!end||start>end)throw new Error('improvementPeriod');
  const current=++historyGeneration,language=locale,auth=apiSession.begin('Office improvement investigation'),revision=workspace.revision,instance=workspace.instance_id;
  improvementReport=null;improvementDraft=null;improvementTrace=null;improvementRunning=true;renderAdmin();
  try{
    const response=await api('improvements',{body:{start_date:start,end_date:end,revision,instance_id:instance,locale:language,model:apiSession.model},headers:auth.headers,signal:auth.signal,timeoutMs:120000});
    if(disposed||current!==historyGeneration||adminTab!=='improvements')return;
    if(response.revision!==workspace.revision||response.instance_id!==workspace.instance_id)throw new Error('state_changed');
    improvementReport=response.analysis;improvementDraft=response.draft;improvementLocale=language;
    improvementRevision=response.revision;improvementInstance=response.instance_id;improvementTrace=response;
    adminPage=0;tell('improvementDone');
  }catch(error){
    if(disposed||current!==historyGeneration||adminTab!=='improvements')return;
    if(apiSession.configured&&error.diagnostics?.agent)
      improvementTrace={...error.diagnostics.agent,failed:true,error_key:errorKey(error),revision,instance_id:instance,
        period:{start_date:start,end_date:end},locale:language};
    throw error;
  }finally{improvementRunning=false;if(!disposed)renderAdmin();}
}
function agentProgressText(report){
  const lines=[t('agentPhase')+': '+t('agentPhase_'+report.phase)];
  if(report.validation){
    lines.push(t('agentValidation_'+report.validation.reason));
    if(report.validation.field)lines.push(t('agentValidationField')+': '+report.validation.field);
    if(report.validation.expected_count!==undefined)lines.push(t('agentExpectedCount')+': '+report.validation.expected_count+' / '+t('agentActualCount')+': '+report.validation.actual_count);
  }
  for(const [key,value] of [['agentRounds',report.rounds],['agentRequests',report.tool_calls],['agentExecutions',report.mcp_calls],['agentCacheHits',report.cache_hits],['agentContext',report.context_characters],['agentPending',report.pending_rooms]])
    if(value!==undefined)lines.push(t(key)+': '+value);
  if(report.limit_kind)lines.push(t('agentLimit')+': '+t('agentLimit_'+report.limit_kind)+' / '+report.limit);
  return lines.join('\n');
}
function improvementDetailContent({kind,id}){
  if(kind==='trace'){
    const report=improvementTrace;if(!report)return null;
    const period=report.analysis?.period??report.period,stale=improvementStale(period,report.revision,report.instance_id);
    const steps=report.trace.map((step,index)=>[String(index+1)+'. '+step.name,JSON.stringify(step.arguments),t((step.result?.isError??step.is_error)?'agentToolFailed':'agentToolSucceeded'),
      ...(step.cached?[t('agentCached')]:[]),...(step.error_code?[t('agentReason_'+step.error_code)]:[])].join('\n')).join('\n\n');
    const citations=report.draft?report.draft.items.map(item=>item.finding_id+' / '+t('agentVerified')+': '+item.evidence_ids.join(', ')).join('\n')
      :t('agentVerified')+': '+report.verified_ids.join(', ');
    const languageNote=report.draft&&improvementLocale!==locale?t('improvementAiLanguage')+'\n':'';
    return {title:t('agentTrace'),stale,text:(stale?t('improvementStale')+'\n\n':'')+period.start_date+' → '+period.end_date+'\n'+languageNote
      +(report.failed?t(report.error_key)+'\n'+agentProgressText(report):report.draft.summary)+'\n\n'
      +t('agentModel')+': '+report.model+' / '+report.trace.length+' '+t('agentRequests')+'\n'+t('agentTokens')+': '
      +(report.usage.input_tokens??0)+' / '+(report.usage.output_tokens??0)+'\n\n'+steps+'\n\n'+citations};
  }
  const card=improvementReport?.items.find(item=>item.finding_id===id);if(!card)return null;
  const stale=improvementStale(),prefix=(stale?t('improvementStale')+'\n\n':'')+improvementReport.period.start_date+' → '+improvementReport.period.end_date+'\n';
  if(kind==='evidence'){
    const clock=minutes=>String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');
    const facts=card.evidence.map(record=>[record.date+' '+clock(record.start)+'–'+clock(record.end),record.reservation_id,
      t('people')+': '+record.people+' / '+t('features')+': '+(record.features.map(f=>t(f)).join(', ')||'—'),
      t('improvementAlternative')+': '+(record.alternatives.map(room=>room.name+' ('+room.capacity+')').join(', ')||t('improvement_'+record.alternative_status))].join('\n')).join('\n\n');
    return {title:t('improvementEvidence')+' / '+card.name,stale,text:prefix+t('improvementEvidenceLimit')+'\n\n'+facts+'\n\n'+t('improvementExcluded')+'\n'+Object.entries(improvementReport.excluded).map(([key,value])=>t('improvementExclude_'+key)+': '+value).join('\n')};
  }
  const ai=improvementLocale===locale?improvementDraft?.items.find(item=>item.finding_id===id):null;
  return {title:t('suggestionDetails')+' / '+card.name,stale,text:prefix
    +suggestionText({kind:'allocation',finding:card,recommendation:improvementDraft?.recommendations?.[card.finding_id]},t)+'\n\n'
    +(ai?t('improvementAiLabel')+' / '+improvementDraft.model+'\n'+ai.note+'\n'+t('agentVerified')+': '+ai.evidence_ids.join(', '):t(improvementLocale!==locale?'improvementAiLanguage':'improvementAiHint'))+'\n\n'+t('improvementRule')+'\n\n'+t('improvementLimits')};
}
function showImprovementEvidence(id){if(improvementReport?.items.some(item=>item.finding_id===id))showDetail('','',{kind:'evidence',id});}
function showImprovementAction(id){if(improvementReport?.items.some(item=>item.finding_id===id))showDetail('','',{kind:'action',id});}
function renderAdmin(){
  if(!admin)return;
  $('adminView').classList.toggle('improvementView',adminTab==='improvements');
  $('adminView').classList.toggle('equipmentView',adminTab==='improvements'&&improvementScope()!=='allocation');
  $('adminView').classList.toggle('combinedView',adminTab==='improvements'&&improvementScope()==='combined');
  $('improvementScopeControls').hidden=adminTab!=='improvements';
  $('improvementScope').disabled=working;
  $('adminClear').hidden=adminTab!=='live'||!workspace?.admin_crud;
  $('adminBulkPurge').hidden=adminTab!=='live'||!workspace?.admin_crud;
  $('adminRefresh').hidden=adminTab==='ai'||(adminTab==='improvements'&&improvementScope()==='allocation');
  $('adminTitle').textContent=t(adminTab);
  $('adminDescription').textContent=t(adminTab==='comfort'?'comfortDescription':adminTab==='live'?(workspace?.admin_crud?'adminLiveHint':'liveDesc'):adminTab==='ai'?'currentAiNote':'currentDataNote');
  if(adminTab==='improvements')$('adminDescription').textContent=t('improvementDescription');
  if(adminTab==='comfort'&&adminData?.result.excluded)$('adminDescription').textContent+=' '+t('comfortExcluded')+': '+Object.values(adminData.result.excluded).reduce((sum,n)=>sum+n,0);
  document.querySelectorAll('[data-admin]').forEach(el=>el.classList.toggle('active',el.dataset.admin===adminTab));
  const query=!['live','ai','comfort','improvements','equipment'].includes(adminTab);
  $('equipmentForm').hidden=adminTab!=='improvements'||improvementScope()==='allocation';
  $('improvementForm').hidden=adminTab!=='improvements'||improvementScope()==='equipment';
  $('improvementAnalyze').hidden=improvementScope()!=='allocation';
  $('improvementRunStatus').hidden=improvementScope()!=='allocation';
  if(adminTab==='improvements'&&workspace){
    for(const [id,key] of [['improvementStart','start_date'],['improvementEnd','end_date']])if(!$(id).value)$(id).value=workspace.demo_history?.[key]??workspace.today;
    if(workspace.demo_history)$('adminDescription').textContent+=' '+t('historicalDemoNote')+' '+workspace.demo_history.start_date+' → '+workspace.demo_history.end_date+' / '+workspace.demo_history.count;
  }
  $('comfortControls').hidden=adminTab!=='comfort';
  $('comfortPeriod').hidden=adminTab!=='comfort';
  $('comfortPeriod').textContent=t('comfortPeriod')+': '+periodLabel(comfortMode==='thermal'?adminData?.result.thermal_period:adminData?.result.satisfaction_period);
  $('adminMetrics').classList.toggle('feedbackMetrics',adminTab==='comfort');
  if(adminTab==='improvements'&&improvementScope()!=='allocation')document.querySelector('.adminNav [data-i18n="boundary"]').textContent=t('equipmentBoundary');
  else if(adminTab==='comfort')document.querySelector('.adminNav [data-i18n="boundary"]').textContent=t('comfortSource');
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
  $('adminTrace').disabled=false;
  $('adminMetrics').hidden=!metrics.length;$('adminMetrics').innerHTML=metrics.map(([label,value])=>'<div class="metric"><span>'+label+'</span><b>'+escape(value)+'</b></div>').join('');
  if(equipmentUI?.isActive()){equipmentUI.render();return;}
  if(adminTab==='improvements'){
    const report=improvementReport;
    const facts=report?[[t('improvementEligible'),report.eligible_count],[t('improvementExcluded'),Object.values(report.excluded).reduce((n,x)=>n+x,0)],[t('improvementReviewRooms'),report.review_count]]:[];
    $('adminMetrics').hidden=!facts.length;$('adminMetrics').innerHTML=facts.map(([label,value])=>'<div class="metric"><span>'+label+'</span><b>'+value+'</b></div>').join('');
    renderImprovements();return;
  }
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
  if(!admin||['live','ai','improvements'].includes(adminTab))return;
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
  equipmentUI?.leave();
  historyGeneration++;adminTab=button.dataset.admin;adminPage=0;adminData=null;adminTrace=null;renderAdmin();
  if(adminTab==='improvements'&&improvementScope()!=='allocation')perform(()=>equipmentUI.load());
  else if(!['live','ai','improvements'].includes(adminTab))perform(runHistory);
  else if(adminTab==='live'&&workspace?.admin_crud)perform(loadReservations);
}));
$('adminRefresh').addEventListener('click',()=>perform(async()=>{if(equipmentUI?.isActive()){await equipmentUI.load();return;}if(adminTab==='live'){await sync();if(workspace?.admin_crud)await loadReservations();}else if(adminTab!=='ai')await runHistory();}));
$('adminPrevious').addEventListener('click',()=>{if(equipmentUI?.isActive()){equipmentUI.next(-1);return;}adminPage--;renderAdmin();});
$('adminNext').addEventListener('click',()=>{if(equipmentUI?.isActive()){equipmentUI.next(1);return;}adminPage++;renderAdmin();});
$('improvementScope').addEventListener('change',()=>{
  historyGeneration++;improvementReport=null;improvementDraft=null;improvementTrace=null;
  if(detail.improvement){detail={title:'',text:'',page:0};$('detailDialog').close();}
  equipmentUI.clear();adminPage=0;renderAdmin();
  if(equipmentUI.isActive())perform(()=>equipmentUI.load());
});
$('improvementForm').addEventListener('submit',event=>{event.preventDefault();if(improvementScope()==='allocation')perform(analyzeImprovements);});
for(const id of ['improvementStart','improvementEnd'])$(id).addEventListener('change',()=>{historyGeneration++;improvementDraft=null;if(equipmentUI?.isActive())equipmentUI.clear();renderAdmin();});
$('adminResults').addEventListener('click',event=>{
  if(equipmentUI?.isActive())return;
  const selection=event.target.closest('[data-suggestion-select]');
  if(selection?.dataset.suggestionSelect!==undefined){const next=Number(selection.dataset.suggestionSelect);if(Number.isInteger(next)&&improvementReport?.items[next]){adminPage=next;renderAdmin();}return;}
  if(event.target.closest('[data-improvement-policy]')?.dataset.improvementPolicy){showDetail(t('improvementPolicy'),t('improvementRule')+'\n\n'+t('improvementLimits'));return;}
  const action=event.target.closest('[data-improvement-action]');
  if(action?.dataset.improvementAction){showImprovementAction(action.dataset.improvementAction);return;}
  const evidence=event.target.closest('[data-improvement-evidence]');
  if(evidence?.dataset.improvementEvidence){showImprovementEvidence(evidence.dataset.improvementEvidence);return;}
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
$('adminTrace').addEventListener('click',()=>{
  if(equipmentUI?.isActive()){equipmentUI.trace();return;}
  if(adminTab==='improvements'){
    if(!improvementTrace)return;
    showDetail('','',{kind:'trace'});return;
  }
  showDetail(t(adminTab==='live'?'workspaceDetails':'raw'),t(adminTab==='live'?'snapshotNote':'traceNote')+'\n\n'+JSON.stringify(adminTab==='ai'?chatTrace:adminTab==='live'?workspace:adminTrace,null,2));
});
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
window.addEventListener('resize',()=>{equipmentUI?.resize();renderMap();renderAdmin();if($('detailDialog').open)renderDetail();if($('roomDialog').open)renderRoomDetails();});
window.addEventListener('pagehide',()=>{
  equipmentUI?.clear();
  disposed=true;generation++;historyGeneration++;operation?.abort();apiSession.clear();$('key').value='';clearInterval(poll);clearTimeout(filterTimer);clearTimeout(historyFilterTimer);
});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
calendarUI=createCalendarUI({document,api,perform,getWorkspace:()=>workspace,getText:()=>t,isBusy:()=>working,
  onChange:sync,onReturn:date=>{
    if(planSource==='manual')manualDraft=$('intent').value;
    planSource='calendar';
    const last=new Date(Date.parse(workspace.today)+30*86400000).toISOString().slice(0,10);
    const selected=date>=workspace.today&&date<=last?date:workspace.today;
    $('calendarExportStart').value=selected;$('calendarExportEnd').value=selected;calendarRangeOpen=true;
    pane='plan';renderCalendarInput();renderMobile();$('exportCalendar').focus?.();
  }});
equipmentUI=createEquipmentFeedbackUI({document,api,perform,getText:()=>t,getLocale:()=>locale,isActive:()=>admin&&adminTab==='improvements'&&improvementScope()!=='allocation',getWorkspace:()=>workspace,isCompact:()=>innerHeight<=500,isBusy:()=>working,session:apiSession,tell,
  showEvidence:(title,text)=>{showDetail(title,text);detail.equipment=true;},
  clearEvidence:()=>{if(detail.equipment){detail={title:'',text:'',page:0};$('detailTitle').textContent='';$('detailText').textContent='';$('detailDialog').close();}}});
if(!$('improvementScope').value)$('improvementScope').value='allocation';
setupLanguage();
try{await loadLocalSettings();}catch(error){showError(error);}
try{
  await sync();
  if(!disposed)poll=setInterval(()=>{if(!document.hidden&&!working)sync().catch(error=>{if(!disposed)showError(error);});},5000);
}catch(error){showError(error);}
