import { errorKey } from './ui-i18n.js';

// Monday-first, six-week grid; UTC arithmetic avoids browser timezone offsets.
export function calendarMonthDates(month) {
  if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)||month<'1900-01'||month>'2100-12')return [];
  const first=new Date(month+'-01T00:00:00Z');
  const offset=(first.getUTCDay()+6)%7;
  return Array.from({length:42},(_,i)=>new Date(first.getTime()+(i-offset)*86400000).toISOString().slice(0,10));
}

// UI state stays in this page. API credentials are owned by the existing session.
export function createCalendarUI({document,api,perform,getWorkspace,getText,onChange,onReturn,isBusy}) {
  const $=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let state=null,editing=null,dirty=false,armed=false,stale=false,seenWorkspace=null;
  let view='month',visibleMonth='',focusDay='';
  const text=key=>getText()(key);
  const usesGoogle=()=>getWorkspace()?.google_calendar_connected===true;
  const googleSource=()=>state?.source==='google'||usesGoogle();
  const readOnlyDay=()=>getWorkspace()?.employee_today_only===true && $('calendarDate').value!==getWorkspace().today;
  const hint=()=>readOnlyDay()?'':googleSource()?'calendarGoogleLocal':'calendarSeparation';
  const editable=entry=>!readOnlyDay()&&entry?.status==='active'&&(!googleSource()||entry.timed&&entry.end_time!=='24:00');
  const revision=workspace=>googleSource()?workspace?.google_calendar_revision:workspace?.calendar_revision;
  const locale=()=>document.documentElement.lang==='en'?'en':'ja';
  const dateText=(date,options)=>new Intl.DateTimeFormat(locale(),{...options,timeZone:'UTC'}).format(new Date(date+'T00:00:00Z'));
  const supportedDay=date=>/^\d{4}-\d{2}-\d{2}$/.test(date)&&date>='1900-01-01'&&date<='2100-12-31'&&Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date;
  function canAnalyze(){const today=getWorkspace()?.today;if(!today)return false;const last=new Date(Date.parse(today)+30*86400000).toISOString().slice(0,10);return $('calendarDate').value>=today&&$('calendarDate').value<=last;}
  function status(key){$('calendarStatus').textContent=text(key);}
  function renderMonth(){
    if(!visibleMonth)return;
    $('calendarMonthTitle').textContent=dateText(visibleMonth+'-01',{year:'numeric',month:'long'});
    $('calendarWeekdays').innerHTML=Array.from({length:7},(_,i)=>'<span>'+esc(dateText('2024-01-0'+(i+1),{weekday:'short'}))+'</span>').join('');
    const dates=calendarMonthDates(visibleMonth),today=getWorkspace()?.today;
    const tabDay=dates.includes(focusDay)?focusDay:visibleMonth+'-01';
    $('calendarMonthGrid').innerHTML=dates.map((date,index)=>{
      const events=(state?.events??[]).filter(e=>e.date===date&&e.status==='active').sort((a,b)=>a.time.localeCompare(b.time));
      const currentMonth=date.startsWith(visibleMonth),isToday=date===today;
      const label=dateText(date,{year:'numeric',month:'long',day:'numeric',weekday:'long'})+' · '+text('calendarEventCount').replace('{count}',events.length);
      return '<button type="button" class="calendarDayCell '+(!currentMonth?'otherMonth ':'')+(index%7>=5?'weekend ':'')+(isToday?'isToday ':'')+(date===$('calendarDate').value?'selectedDay':'')+'" data-calendar-day="'+date+'" tabindex="'+(date===tabDay?'0':'-1')+'" aria-label="'+esc(label)+'" '+(isToday?'aria-current="date" ':'')+(isBusy()||stale||!supportedDay(date)?'disabled':'')+'><span class="calendarDayNumber">'+Number(date.slice(8))+'</span><span class="calendarDayEvents">'
        +events.slice(0,2).map(e=>'<span class="calendarEventPreview"><time>'+esc(e.time)+'</time><span>'+esc(e.title)+'</span></span>').join('')
        +'</span>'+(events.length?'<span class="calendarDayCount" title="'+esc(text('calendarEventCount').replace('{count}',events.length))+'" aria-hidden="true">'+events.length+'</span>':'')+'</button>';
    }).join('');
    $('calendarPreviousMonth').disabled=isBusy()||visibleMonth==='1900-01';
    $('calendarNextMonth').disabled=isBusy()||visibleMonth==='2100-12';
    $('calendarThisMonth').disabled=isBusy();
  }
  function selectDay(date){
    if(isBusy()||!supportedDay(date))return;
    if(dirty){status('calendarUnsaved');return;}
    if(stale){status('calendarMonthStale');return;}
    $('calendarDate').value=date;visibleMonth=date.slice(0,7);focusDay=date;view='day';
    blank();status(hint());
    if(googleSource())perform(load);else if(!readOnlyDay())$('calendarTitle').focus?.();
  }
  function shiftMonth(offset){
    if(isBusy()||dirty)return;
    const date=new Date(visibleMonth+'-01T00:00:00Z');date.setUTCMonth(date.getUTCMonth()+offset);
    const next=date.toISOString().slice(0,7);
    if(next<'1900-01'||next>'2100-12')return;
    visibleMonth=next;focusDay=next+'-01';loadMonth();
  }
  function blank(){editing=null;dirty=false;armed=false;
    $('calendarFormat').value='unspecified';$('calendarTitle').value='';$('calendarNotes').value='';$('calendarPeople').value='';$('calendarTime').value='09:00';$('calendarEnd').value='10:00';render();}
  function render(){
    const day=$('calendarDate').value,google=googleSource(),readOnly=readOnlyDay();
    $('calendarSourceLabel').textContent=text(google?'calendarGoogle':'calendarSimulated');
    $('calendarToHome').textContent=text(google?'calendarGoogleReturn':'calendarToHome');
    $('calendarToHome').hidden=!google&&view==='day'&&readOnly;
    $('calendarMonthView').hidden=view!=='month';$('calendarDayView').hidden=view!=='day';
    $('calendarDialog').classList.toggle('calendarMonthMode',view==='month');
    $('calendarBackMonth').disabled=isBusy()||dirty;$('calendarToHome').disabled=isBusy()||dirty;
    if(supportedDay(day))$('calendarSelectedDay').textContent=dateText(day,{year:'numeric',month:'long',day:'numeric',weekday:'short'});
    if(view==='month')renderMonth();
    const entries=(state?.events??[]).filter(e=>e.date===day).sort((a,b)=>a.time.localeCompare(b.time));
    const labelFor=e=>{
      const booking=getWorkspace()?.meetings?.find(r=>r.calendar_event_id===e.id&&!r.deleted&&['reserved','in_progress','completed'].includes(r.status));
      if(!booking)return e.status==='cancelled'?'cancelled':'calendarScheduled';
      const changed=booking.calendar_event_version!==e.version||e.status==='cancelled'
        ||booking.date!==e.date||booking.time!==e.time||booking.end_time!==e.end_time||booking.title!==e.title
        ||e.people!==null&&booking.people!==e.people;
      return changed?'calendarReview':booking.status;
    };
    $('calendarList').innerHTML=entries.length?entries.map(e=>'<button type="button" data-calendar-event="'+esc(e.id)+'" '+(!editable(e)?'disabled':'')+' class="calendarEvent '+(editing===e.id?'selected':'')+'"><time>'+esc(e.time)+'–'+esc(e.end_time)+'</time><span>'+esc(e.title)+'</span><small>'+text(labelFor(e))+'</small></button>').join(''):'<p class="calendarEmpty">'+text('calendarNoEvents')+'</p>';
    const linked=getWorkspace()?.meetings?.filter(r=>r.calendar_event_id===editing&&!r.deleted&&r.status!=='cancelled')??[];
    $('calendarLinked').textContent=linked.length?text('calendarBookingWarning'):text(hint());
    $('calendarCancel').hidden=google||!editing;$('calendarCancel').textContent=text(armed?'calendarCancelConfirm':'calendarCancel');
    $('calendarEditorTitle').textContent=text(editing?'calendarEdit':'calendarNew');
    $('calendarDate').disabled=dirty||isBusy();
    $('calendarSelectionHint').hidden=!google||Boolean(editing)||!entries.some(editable);
    $('calendarEditForm').hidden=readOnly||google&&!editing;
    $('calendarNew').hidden=google||readOnly;
    $('calendarExamples').hidden=google||readOnly;
    $('calendarFormatLabel').hidden=!google;
    $('calendarTime').max=google?'23:59':'23:44';
    $('calendarEnd').min=google?'00:01':'00:15';
    $('calendarList').querySelectorAll('button').forEach(b=>{b.disabled=isBusy()||dirty||!editable(entries.find(e=>e.id===b.dataset.calendarEvent));});
    for(const id of ['calendarNew','calendarExamples','calendarSave','calendarDiscard','calendarCancel','calendarTitle','calendarNotes','calendarPeople','calendarTime','calendarEnd','calendarFormat'])$(id).disabled=isBusy();
    $('calendarBookingWindow').hidden=view!=='day'||!readOnly&&(google||canAnalyze());
    $('calendarBookingWindow').textContent=text(readOnly?'calendarTodayOnly':'calendarRecordOnly');
    if(stale)status(view==='month'?'calendarMonthStale':'calendarStale');
    else if(dirty)status('calendarUnsaved');
  }
  function loadMonth(){
    render();
    status('calendarMonthHint');
    return usesGoogle()?perform(load):undefined;
  }
  async function load(){
    try{
      const dates=view==='month'?calendarMonthDates(visibleMonth).filter(supportedDay):[$('calendarDate').value];
      const latest=usesGoogle()
        ? await api('proactive/calendar?'+new URLSearchParams({start:dates[0],end:dates.at(-1)}))
        : await api('calendar');
      if(dirty&&state&&(latest.source!==state.source||latest.revision!==state.revision)){
        stale=true;render();return;
      }
      state=latest;stale=false;render();
    }catch(error){
      if(googleSource()&&!dirty){state=null;render();}
      status(errorKey(error));throw error;
    }
  }
  function editEntry(entry){
    if(!editable(entry))return;
    editing=entry.id;armed=false;
    for(const [id,key] of Object.entries({calendarTitle:'title',calendarTime:'time',calendarEnd:'end_time',calendarPeople:'people',calendarNotes:'notes'}))$(id).value=entry[key]??'';
    $('calendarFormat').value=entry.format??'unspecified';
    render();status(googleSource()?'':hint());$('calendarTitle').focus?.();
  }
  async function open({date,event}={}){
    if(!$('calendarDate').value)$('calendarDate').value=getWorkspace()?.today??'';
    if(!dirty){
      const direct=usesGoogle()&&supportedDay(date??'');
      if(direct)$('calendarDate').value=date;
      view=direct?'day':'month';visibleMonth=$('calendarDate').value.slice(0,7);focusDay=$('calendarDate').value;
      if(usesGoogle())blank();
    }
    if(!$('calendarDialog').open)$('calendarDialog').showModal();
    await load();
    status(stale?'calendarStale':dirty?'calendarUnsaved':view==='month'?'calendarMonthHint':hint());
    if(!dirty&&event)editEntry(state.events.find(entry=>entry.date===date&&entry.id===event));
  }
  async function write(action,event){
    if(readOnlyDay())throw new Error('today_only');
    if(!state||stale)throw new Error('calendar_changed');
    if(googleSource()){
      const original=state.events.find(entry=>entry.id===editing&&entry.date===event?.date);
      if(!editable(original))throw new Error('calendar_invalid');
      try{
        const updated=await api('proactive/calendar',{body:{...event,id:original.id,
          revision:state.revision,source_version:original.source_version,format:$('calendarFormat').value}});
        state={...state,revision:updated.revision,events:state.events.map(entry=>entry===original?updated.entry:entry)};
      }catch(error){if(error.status===409)stale=true;status(errorKey(error));throw error;}
      dirty=false;
      await onChange();
      status('calendarGoogleSaved');return;
    }
    try{state=await api('calendar',{body:{action,operation_id:globalThis.crypto.randomUUID(),expected_revision:state.revision,confirmed:true,
      ...(action==='examples'?{date:$('calendarDate').value,locale:document.documentElement.lang==='en'?'en':'ja'}:{}),
      ...(editing&&['update','cancel'].includes(action)?{event_id:editing}:{}),...(event?{event}:{})}});}catch(error){if(error.status===409){stale=true;}status(errorKey(error));throw error;}
    blank();await onChange();status('calendarSaved');
  }
  $('openCalendar').addEventListener('click',()=>perform(open));
  $('calendarPreviousMonth').addEventListener('click',()=>shiftMonth(-1));
  $('calendarNextMonth').addEventListener('click',()=>shiftMonth(1));
  $('calendarThisMonth').addEventListener('click',()=>{if(isBusy()||dirty)return;const today=getWorkspace()?.today;if(!today)return;visibleMonth=today.slice(0,7);focusDay=today;return loadMonth();});
  $('calendarMonthGrid').addEventListener('click',event=>{const button=event.target.closest('button');if(button?.dataset.calendarDay)selectDay(button.dataset.calendarDay);});
  $('calendarMonthGrid').addEventListener('keydown',event=>{
    const button=event.target.closest('button'),date=button?.dataset.calendarDay;
    if(!date||isBusy())return;
    const step={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}[event.key];
    if(step===undefined)return;event.preventDefault();
    const next=new Date(Date.parse(date)+step*86400000).toISOString().slice(0,10);if(!supportedDay(next))return;
    const monthChanged=visibleMonth!==next.slice(0,7);
    focusDay=next;visibleMonth=next.slice(0,7);renderMonth();
    const focus=()=>[...$('calendarMonthGrid').querySelectorAll('button')].find(b=>b.dataset.calendarDay===next)?.focus?.();
    if(monthChanged&&usesGoogle())return loadMonth().then(focus);
    focus();
  });
  $('calendarBackMonth').addEventListener('click',()=>{if(isBusy())return;if(dirty){status('calendarUnsaved');return;}view='month';visibleMonth=$('calendarDate').value.slice(0,7);focusDay=$('calendarDate').value;return loadMonth();});
  $('calendarDate').addEventListener('change',()=>{if(!supportedDay($('calendarDate').value)){status('calendar_invalid');return;}visibleMonth=$('calendarDate').value.slice(0,7);focusDay=$('calendarDate').value;blank();status(hint());if(usesGoogle())return perform(load);});
  $('calendarNew').addEventListener('click',()=>{if(dirty){status('calendarUnsaved');return;}blank();status(hint());});
  $('calendarDiscard').addEventListener('click',()=>{blank();if(stale)perform(load);else status(hint());});
  $('calendarExamples').addEventListener('click',()=>perform(async()=>{if(dirty){status('calendarUnsaved');return;}await write('examples');}));
  $('calendarList').addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||isBusy()||dirty)return;
    editEntry(state?.events.find(entry=>entry.id===button.dataset.calendarEvent&&entry.date===$('calendarDate').value));
  });
  $('calendarEditForm').addEventListener('input',()=>{dirty=true;armed=false;render();});
  $('calendarEditForm').addEventListener('submit',event=>{event.preventDefault();perform(()=>write(editing?'update':'create',{
    title:$('calendarTitle').value,date:$('calendarDate').value,time:$('calendarTime').value,end_time:$('calendarEnd').value,
    people:$('calendarPeople').value===''?null:Number($('calendarPeople').value),notes:$('calendarNotes').value}));});
  $('calendarCancel').addEventListener('click',()=>{if(!armed){armed=true;render();status('calendarCancelHint');return;}perform(()=>write('cancel'));});
  $('calendarToHome').addEventListener('click',()=>{if(isBusy())return;if(dirty){status('calendarUnsaved');return;}$('calendarDialog').close();onReturn?.($('calendarDate').value,googleSource());});
  return {open,render,changed(){
    const workspace=getWorkspace(),version=[workspace?.revision,workspace?.today,usesGoogle()].join(':');
    if(version===seenWorkspace)return;
    seenWorkspace=version;
    if(state&&(state.revision!==revision(workspace)||(state.source==='google')!==usesGoogle()))stale=true;
    if(readOnlyDay()&&(dirty||editing)){blank();status('');return;}
    render();
  },clear(){state=null;stale=false;view='month';visibleMonth='';focusDay='';blank();}};
}
