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
  let state=null,editing=null,dirty=false,armed=false,stale=false,seenRevision=null;
  let view='month',visibleMonth='',focusDay='';
  const text=key=>getText()(key);
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
        +events.slice(0,2).map(e=>'<span class="calendarEventPreview"><time>'+e.time+'</time><span>'+esc(e.title)+'</span></span>').join('')
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
    blank();status('calendarSeparation');$('calendarTitle').focus?.();
  }
  function shiftMonth(offset){
    if(isBusy()||dirty)return;
    const date=new Date(visibleMonth+'-01T00:00:00Z');date.setUTCMonth(date.getUTCMonth()+offset);
    const next=date.toISOString().slice(0,7);
    if(next<'1900-01'||next>'2100-12')return;
    visibleMonth=next;focusDay=next+'-01';render();status('calendarMonthHint');
  }
  function blank(){editing=null;dirty=false;armed=false;
    $('calendarTitle').value='';$('calendarNotes').value='';$('calendarPeople').value='';$('calendarTime').value='09:00';$('calendarEnd').value='10:00';render();}
  function render(){
    const day=$('calendarDate').value;
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
    $('calendarList').innerHTML=entries.length?entries.map(e=>'<button type="button" data-calendar-event="'+esc(e.id)+'" '+(e.status==='cancelled'?'disabled':'')+' class="calendarEvent '+(editing===e.id?'selected':'')+'"><time>'+esc(e.time)+'–'+esc(e.end_time)+'</time><span>'+esc(e.title)+'</span><small>'+text(labelFor(e))+'</small></button>').join(''):'<p class="calendarEmpty">'+text('calendarNoEvents')+'</p>';
    const linked=getWorkspace()?.meetings?.filter(r=>r.calendar_event_id===editing&&!r.deleted&&r.status!=='cancelled')??[];
    $('calendarLinked').textContent=linked.length?text('calendarBookingWarning'):text('calendarSeparation');
    $('calendarCancel').hidden=!editing;$('calendarCancel').textContent=text(armed?'calendarCancelConfirm':'calendarCancel');
    $('calendarEditorTitle').textContent=text(editing?'calendarEdit':'calendarNew');
    $('calendarDate').disabled=dirty||isBusy();
    $('calendarList').querySelectorAll('button').forEach(b=>{b.disabled=isBusy()||dirty||entries.find(e=>e.id===b.dataset.calendarEvent)?.status==='cancelled';});
    for(const id of ['calendarNew','calendarExamples','calendarSave','calendarDiscard','calendarCancel','calendarTitle','calendarNotes','calendarPeople','calendarTime','calendarEnd'])$(id).disabled=isBusy();
    $('calendarBookingWindow').hidden=view!=='day'||canAnalyze();
    if(stale)status(view==='month'?'calendarMonthStale':'calendarStale');
    else if(dirty)status('calendarUnsaved');
  }
  async function load(){const latest=await api('calendar');if(dirty&&state&&latest.revision!==state.revision){stale=true;render();return;}state=latest;stale=false;render();}
  async function open(){if(!$('calendarDate').value)$('calendarDate').value=getWorkspace()?.today??'';
    if(!dirty){view='month';visibleMonth=$('calendarDate').value.slice(0,7);focusDay=$('calendarDate').value;}
    await load();if(!$('calendarDialog').open)$('calendarDialog').showModal();status(stale?'calendarStale':dirty?'calendarUnsaved':view==='month'?'calendarMonthHint':'calendarSeparation');}
  async function write(action,event){
    if(!state||stale)throw new Error('calendar_changed');
    try{state=await api('calendar',{body:{action,operation_id:globalThis.crypto.randomUUID(),expected_revision:state.revision,confirmed:true,
      ...(action==='examples'?{date:$('calendarDate').value,locale:document.documentElement.lang==='en'?'en':'ja'}:{}),
      ...(editing&&['update','cancel'].includes(action)?{event_id:editing}:{}),...(event?{event}:{})}});}catch(error){if(error.status===409){stale=true;}status(errorKey(error));throw error;}
    blank();await onChange();status('calendarSaved');
  }
  $('openCalendar').addEventListener('click',()=>perform(open));
  $('calendarPreviousMonth').addEventListener('click',()=>shiftMonth(-1));
  $('calendarNextMonth').addEventListener('click',()=>shiftMonth(1));
  $('calendarThisMonth').addEventListener('click',()=>{if(isBusy()||dirty)return;const today=getWorkspace()?.today;if(!today)return;visibleMonth=today.slice(0,7);focusDay=today;render();status('calendarMonthHint');});
  $('calendarMonthGrid').addEventListener('click',event=>{const button=event.target.closest('button');if(button?.dataset.calendarDay)selectDay(button.dataset.calendarDay);});
  $('calendarMonthGrid').addEventListener('keydown',event=>{
    const button=event.target.closest('button'),date=button?.dataset.calendarDay;
    if(!date||isBusy())return;
    const step={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}[event.key];
    if(step===undefined)return;event.preventDefault();
    const next=new Date(Date.parse(date)+step*86400000).toISOString().slice(0,10);if(!supportedDay(next))return;
    focusDay=next;visibleMonth=next.slice(0,7);renderMonth();
    [...$('calendarMonthGrid').querySelectorAll('button')].find(b=>b.dataset.calendarDay===next)?.focus?.();
  });
  $('calendarBackMonth').addEventListener('click',()=>{if(isBusy())return;if(dirty){status('calendarUnsaved');return;}view='month';visibleMonth=$('calendarDate').value.slice(0,7);focusDay=$('calendarDate').value;render();status('calendarMonthHint');});
  $('calendarDate').addEventListener('change',()=>{if(!supportedDay($('calendarDate').value)){status('calendar_invalid');return;}visibleMonth=$('calendarDate').value.slice(0,7);focusDay=$('calendarDate').value;blank();status('calendarSeparation');});
  $('calendarNew').addEventListener('click',()=>{if(dirty){status('calendarUnsaved');return;}blank();status('calendarSeparation');});
  $('calendarDiscard').addEventListener('click',()=>{blank();if(stale)perform(load);else status('calendarSeparation');});
  $('calendarExamples').addEventListener('click',()=>perform(async()=>{if(dirty){status('calendarUnsaved');return;}await write('examples');}));
  $('calendarList').addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||isBusy()||dirty)return;
    const entry=state?.events.find(e=>e.id===button.dataset.calendarEvent&&e.status==='active');if(!entry)return;
    editing=entry.id;armed=false;for(const [id,key] of Object.entries({calendarTitle:'title',calendarTime:'time',calendarEnd:'end_time',calendarPeople:'people',calendarNotes:'notes'}))$(id).value=entry[key]??'';
    render();status('calendarSeparation');$('calendarTitle').focus?.();
  });
  $('calendarEditForm').addEventListener('input',()=>{dirty=true;armed=false;render();});
  $('calendarEditForm').addEventListener('submit',event=>{event.preventDefault();perform(()=>write(editing?'update':'create',{
    title:$('calendarTitle').value,date:$('calendarDate').value,time:$('calendarTime').value,end_time:$('calendarEnd').value,
    people:$('calendarPeople').value===''?null:Number($('calendarPeople').value),notes:$('calendarNotes').value}));});
  $('calendarCancel').addEventListener('click',()=>{if(!armed){armed=true;render();status('calendarCancelHint');return;}perform(()=>write('cancel'));});
  $('calendarToHome').addEventListener('click',()=>{if(isBusy())return;if(dirty){status('calendarUnsaved');return;}$('calendarDialog').close();onReturn?.($('calendarDate').value);});
  return {open,render,changed(){const workspace=getWorkspace();if(workspace?.revision===seenRevision)return;seenRevision=workspace?.revision;if(state&&state.revision!==workspace?.calendar_revision){stale=true;}render();},clear(){state=null;stale=false;view='month';visibleMonth='';focusDay='';blank();}};
}
