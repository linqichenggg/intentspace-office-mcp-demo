import { createHash } from 'node:crypto';
import { z } from 'zod';
import { HttpError, json, readJson } from './http-utils.js';
import { allocateDayPlan, assertToday, clock, minutes, validateDayPlan } from './day-plan.js';
import { calendarProposal } from './calendar-service.js';
import { withMcpClient } from './mcp-client.js';

const prefix = '/api/office/proactive';
const arrivalInput = z.object({
  event_id:z.string().uuid(), employee_id:z.literal('A'), direction:z.literal('enter'),
  locale:z.enum(['ja','en']).default('ja')
}).strict();
const confirmInput = z.object({
  plan_id:z.string().uuid(), proposal_id:z.string().uuid(), space_id:z.string().min(1).max(100), confirmed:z.literal(true)
}).strict();
const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>value>='1900-01-01'&&value<='2100-12-31'&&
  Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value);
const timeField = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const googleCalendarEdit = z.object({
  id:z.string().uuid(),source_version:z.string().max(200),revision:z.number().int().nonnegative(),date:dateField,
  title:z.string().trim().min(1).max(160),time:timeField,end_time:timeField,
  people:z.number().int().min(1).max(100).nullable(),notes:z.string().trim().max(1200),
  format:z.enum(['unspecified','in_person','online','hybrid'])
}).strict().refine(event=>event.time<event.end_time);
const fit = (item, date) => item.date === date && !item.deleted && ['reserved','in_progress'].includes(item.status);
const calendarFingerprint = events => createHash('sha256').update(JSON.stringify(events)).digest('hex');

function demoCalendar(workspace, date) {
  const entries = workspace.employeeCalendar().events.filter(event => event.date === date);
  const active = entries.filter(event => event.status === 'active').map(event => ({
    ...event, blocking:true, timed:true, kind:'default',
    room:false, video:false
  }));
  if (entries.length) return active.sort((a,b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
  return [{
    id:'de40b8eb-f7a1-4be9-aefb-f25b90abfc11', version:1, date, status:'active',
    title:'企画ミーティング / Planning meeting', time:'10:30', end_time:'11:00', people:4,
    blocking:true, timed:true, kind:'default', room:false, video:false, location:'オフィス'
  }];
}

function deskSlot(arrival, events, meetings) {
  const intervals = [
    ...events.filter(event => event.blocking).map(event => [minutes(event.time),minutes(event.end_time)]),
    ...meetings.filter(item => fit(item,arrival.date)).map(item => [item.start,item.end])
  ].sort(([a],[b]) => a-b);
  let start = minutes(arrival.time);
  for (const [left,right] of intervals) {
    if (right <= start) continue;
    if (left-start >= 15) return [start,Math.min(left,1080)];
    start = Math.max(start,right);
  }
  return [start,1080];
}

function relevantEvents(events, arrival) {
  return events.filter(event => {
    const duration = minutes(event.end_time)-minutes(event.time);
    return event.timed && event.blocking && event.kind === 'default' && !event.room && event.format !== 'online' &&
      event.time >= arrival.time && event.end_time <= '18:00' && duration >= 15 && duration <= 480;
  });
}

function demoInterpretation(event) {
  if (event.people > 1) return {type:'meeting',people:event.people,features:[],unclear:[]};
  if (event.people === 1) return {type:'focus',people:1,features:[],unclear:[]};
  return {type:'focus',people:null,features:[],unclear:['meeting_requirements_unknown']};
}

function card(proposal, eventTitle, nextEvent = null) {
  const {id,activity,status,issues,candidates} = proposal;
  return {
    id, kind:activity.type === 'desk' ? 'desk' : 'meeting', title:eventTitle,
    time:activity.time, end_time:clock(minutes(activity.time)+activity.duration),
    people:activity.people, status, issues, next_event:nextEvent,
    candidates:candidates.slice(0,12).map(({id,name,area,capacity}) => ({id,name,area,capacity}))
  };
}

async function analyzeEvents({events, pending, snapshot, source, date, locale, dataset, checkCurrent, signal, recommend, calendarAgent, modelConfig}) {
  const proposals = new Map();
  const byId = new Map(pending.map(event => [event.id,event]));
  const blocks = events.filter(event => event.blocking);
  async function propose(event, interpretation) {
    checkCurrent();
    // Individual activities remain in the calendar. A separate rule finds the first seat window.
    if (interpretation.type === 'desk') interpretation = {...interpretation,type:'focus'};
    const result = await calendarProposal(event,interpretation,{
      snapshot,events:blocks,today:date,recommend
    });
    checkCurrent();
    const {calendar_event,...proposal}=result;
    if(source==='google')proposal.calendar_event=calendar_event;
    proposals.set(event.id,proposal);
    return {event_id:event.id,event_version:event.version,proposal:{
      status:proposal.status,issues:proposal.issues,candidates:proposal.candidates.slice(0,3).map(({id,name,capacity}) => ({id,name,capacity}))
    }};
  }
  if (!pending.length) return proposals;
  if (source === 'demo') {
    for (const event of pending) await propose(event,demoInterpretation(event));
    return proposals;
  }
  const {key,model} = await modelConfig();
  if (!key) throw new HttpError(401,'arrival_agent_unconfigured');
  const calendarData = dataset(date,snapshot.reservations);
  calendarData.calendarContext = {
    get_calendar_events(args) {
      if (args.date !== date) throw new HttpError(400,'calendar_invalid');
      checkCurrent();
      return {date,events:pending.map(({id,version,status,title,time,end_time,people,location,video,notes,format}) =>
        ({id,version,status,title,time,end_time,people,location,video,notes,format}))};
    },
    get_employee_bookings(args) {
      if (args.date !== date) throw new HttpError(400,'calendar_invalid');
      checkCurrent();
      return {date,bookings:snapshot.meetings.filter(item => fit(item,date)).map(({date,time,end_time,name}) => ({date,time,end_time,name}))};
    },
    recommend_calendar_event(args) {
      const event = byId.get(args.event_id);
      if (!event || event.version !== args.event_version) throw new HttpError(409,'calendar_changed');
      return propose(event,args);
    }
  };
  await withMcpClient(calendarData, client => calendarAgent(client,key,{date,model,locale,arrival:true},{checkCurrent,signal}));
  if (pending.some(event => !proposals.has(event.id))) throw new HttpError(502,'calendar_incomplete');
  return proposals;
}

// Transport-independent arrival handler. The preview has one workspace and one demo identity.
export function createProactiveService({workspace, google, modelConfig, dataset, calendarAgent, recommend}) {
  const runs = new Map();
  let active;
  const calendar = async (date,source,signal) => source === 'google'
    ? workspace.applyGoogleCalendarEdits(await google.readDay(date,signal)) : demoCalendar(workspace,date);

  async function nextSchedule(request) {
    const today=workspace.referenceDate();
    const first=new Date(today+'T00:00:00Z');
    first.setUTCDate(first.getUTCDate()+1);
    const dates=[first.toISOString().slice(0,10)];
    while(first.getUTCDay()===6||first.getUTCDay()===0){
      first.setUTCDate(first.getUTCDate()+1);
      dates.push(first.toISOString().slice(0,10));
    }
    const connection=google.status();
    const entries=connection.connected||connection.reauthorize
      ? await google.readDays(dates[0],dates.at(-1),AbortSignal.any([request.signal,AbortSignal.timeout(15000)]))
      : workspace.employeeCalendar().events;
    const active=entries.filter(event=>event.status==='active'&&event.kind!=='workingLocation');
    const date=dates.find(day=>active.some(event=>event.date===day))??dates.at(-1);
    const events=active.filter(event=>event.date===date)
      .sort((a,b)=>a.time.localeCompare(b.time)||a.id.localeCompare(b.id))
      .map(({title,time,end_time,timed})=>({title,time,end_time,all_day:timed===false}));
    return json({today,date,events});
  }

  async function editCalendar(request,url){
    const signal=AbortSignal.any([request.signal,AbortSignal.timeout(15000)]);
    if(request.method==='GET'){
      const start=dateField.safeParse(url.searchParams.get('start')),end=dateField.safeParse(url.searchParams.get('end'));
      if(!start.success||!end.success||end.data<start.data||Date.parse(end.data)-Date.parse(start.data)>41*86400000)
        throw new HttpError(400,'calendar_invalid');
      const entries=await google.readDays(start.data,end.data,signal);
      return json({source:'google',revision:workspace.googleCalendarRevision(),events:workspace.applyGoogleCalendarEdits(entries)});
    }
    if(request.method!=='POST')throw new HttpError(405,'method');
    const parsed=googleCalendarEdit.safeParse(await readJson(request,5000));
    if(!parsed.success)throw new HttpError(400,'calendar_invalid');
    const {id,date,source_version,revision,...fields}=parsed.data;
    assertToday(date,workspace.referenceDate());
    const entries=await google.readDay(date,signal);
    assertToday(date,workspace.referenceDate());
    const original=entries.find(event=>event.id===id);
    if(!original||original.source_version!==source_version||workspace.googleCalendarRevision()!==revision)
      throw new HttpError(409,'calendar_changed');
    if(!original.timed||original.end_time==='24:00')throw new HttpError(400,'calendar_invalid');
    const defaults={...original,notes:'',format:'unspecified'};
    const patch=Object.fromEntries(Object.entries(fields).filter(([key,value])=>defaults[key]!==value));
    workspace.saveGoogleCalendarEdit(date,id,patch);
    const [entry]=workspace.applyGoogleCalendarEdits([original]);
    return json({source:'google',revision:workspace.googleCalendarRevision(),entry});
  }

  function current(snapshot) {
    const run = active;
    return run && run.date === workspace.referenceDate() && run.reset === snapshot.reset_generation &&
      (run.source !== 'google' || run.connectionVersion === google.version()) &&
      (snapshot.clock.date+' '+snapshot.clock.time >= run.date+' '+run.time) ? run : null;
  }

  function view() {
    const snapshot = workspace.snapshot(), date = workspace.referenceDate();
    const time = snapshot.clock.date === date ? snapshot.clock.time : '09:00';
    const run = current(snapshot);
    const metadata = {clock:{date,time},google:google.status()};
    if (!run) return {...metadata,status:'waiting'};
    const {date:arrivalDate,time:arrivalTime,source,eventId} = run;
    const arrival = {date:arrivalDate,time:arrivalTime,source,event_id:eventId};
    if (run.status !== 'ready') return {...metadata,status:run.status,arrival,error:run.error};
    if(run.source==='google'&&run.editRevision!==workspace.googleCalendarRevision())return {...metadata,status:'stale',arrival};
    if (run.planId) {
      try { workspace.getPlan(run.planId); }
      catch (error) {
        if (error.message !== 'plan_expired') throw error;
        return {...metadata,status:'expired',arrival};
      }
    }
    const cards = run.cards.map(item => {
      const booking = snapshot.meetings.find(record => record.plan_id === run.planId && record.proposal_id === item.id && !record.deleted && record.status !== 'cancelled');
      return {...item,...(booking ? {status:'confirmed',booking:{id:booking.id,name:booking.name}} : {})};
    });
    return {...metadata,status:'ready',arrival,plan_id:run.planId,cards,more_events:run.moreEvents};
  }

  async function analyze(run, snapshot, locale) {
    const checkCurrent = () => {
      if (current(workspace.snapshot()) !== run || workspace.currentRevision() !== snapshot.revision)
        throw new HttpError(409,'state_changed');
    };
    const signal = AbortSignal.timeout(110000);
    const events = await calendar(run.date,run.source,signal);
    checkCurrent();
    const eligible = relevantEvents(events,run);
    const pending = eligible.slice(0,12);
    const interpreted = await analyzeEvents({
      events,pending,snapshot,source:run.source,date:run.date,locale,dataset,calendarAgent,modelConfig,recommend,checkCurrent,signal
    });
    const proposals = [], cards = [];
    const [start,end] = deskSlot(run,events,snapshot.meetings);
    const duration = Math.min(end-start,480);
    if (duration >= 15) {
      const title = locale === 'en' ? 'Individual workspace' : '個人作業席';
      const activity = {
        type:'desk',title,date:run.date,time:clock(start),duration,people:1,window_start:null,window_end:null,
        features:[],participants:[],existing_id:null,unclear:[]
      };
      const result = await allocateDayPlan(validateDayPlan({activities:[activity],questions:[]},run.date),
        snapshot.meetings,run.date,recommend,{notBefore:run});
      const proposal = result.proposals[0];
      const next = events.find(event => event.blocking && event.time === clock(start+duration));
      proposals.push(proposal);
      cards.push(card(proposal,title,next ? {title:next.title,time:next.time} : null));
    }
    for (const event of pending) {
      const proposal = interpreted.get(event.id);
      if (proposal?.status === 'note') continue;
      proposals.push(proposal);
      const item = card(proposal,event.title);
      item.kind = 'meeting';
      if(run.source==='google')item.event_id=event.id;
      cards.push(item);
    }
    checkCurrent();
    signal.throwIfAborted();
    run.fingerprint = calendarFingerprint(events);
    run.editRevision = workspace.googleCalendarRevision();
    run.planId = proposals.some(item => item.status === 'proposed') ? workspace.savePlan({proposals,questions:[],arrival_origin:true}) : null;
    run.cards = cards;
    run.moreEvents = eligible.length - pending.length;
    run.status = 'ready';
  }

  function receiveArrival(input) {
    const snapshot = workspace.snapshot();
    const prior = runs.get(input.event_id);
    if (prior && prior.reset === snapshot.reset_generation) return;
    if (current(snapshot)?.status === 'analyzing') throw new HttpError(409,'arrival_in_progress');
    const date = workspace.referenceDate();
    const time = snapshot.clock.date === date && snapshot.clock.time > '09:05' ? snapshot.clock.time : '09:05';
    workspace.recordArrival(date,time);
    const next = workspace.snapshot(), connection = google.status();
    const run = {date,time,reset:next.reset_generation,eventId:input.event_id,status:'analyzing',
      source:connection.connected || connection.reauthorize ? 'google' : 'demo',connectionVersion:google.version()};
    active = run;
    runs.set(input.event_id,run);
    if (runs.size > 30) runs.delete(runs.keys().next().value);
    startAnalysis(run,next,input.locale);
  }

  function startAnalysis(run,snapshot,locale) {
    void analyze(run,snapshot,locale).catch(error => {
      run.status = 'error';
      run.error = error instanceof HttpError ? error.message : error.name === 'TimeoutError' ? 'agent_timeout' : 'arrival_unavailable';
    });
  }

  async function confirm(input, signal) {
    const snapshot = workspace.snapshot(), run = current(snapshot);
    if (run?.status !== 'ready' || run.planId !== input.plan_id) throw new HttpError(409,'arrival_changed');
    // Retried confirmations can reuse the exact same saved record through the existing booking path.
    const existing = snapshot.meetings.find(record => record.plan_id === input.plan_id && record.proposal_id === input.proposal_id && !record.deleted && record.status !== 'cancelled');
    if (!existing) {
      workspace.getPlan(input.plan_id);
      const events = await calendar(run.date,run.source,AbortSignal.any([signal,AbortSignal.timeout(15000)]));
      if (current(workspace.snapshot()) !== run || workspace.currentRevision() !== snapshot.revision ||
          calendarFingerprint(events) !== run.fingerprint) throw new HttpError(409,'arrival_changed');
    }
    return workspace.confirm(input,recommend,run.date,{arrivalVerified:true,todayOnly:true});
  }

  async function handler(request) {
    const url = new URL(request.url);
    if (url.pathname === prefix && request.method === 'GET') return json(view());
    if (url.pathname === prefix+'/next-calendar' && request.method === 'GET') return nextSchedule(request);
    if (url.pathname === prefix+'/calendar')return editCalendar(request,url);
    if (request.method !== 'POST') throw new HttpError(405,'method');
    if (url.pathname === prefix+'/arrival') {
      const input = arrivalInput.safeParse(await readJson(request,1800));
      if (!input.success) throw new HttpError(400,'arrival_invalid');
      receiveArrival(input.data);
      return json(view(),202);
    }
    if (url.pathname === prefix+'/refresh') {
      const input=z.object({locale:z.enum(['ja','en']).default('ja')}).strict().safeParse(await readJson(request,500));
      if(!input.success)throw new HttpError(400,'arrival_invalid');
      const snapshot=workspace.snapshot(),previous=current(snapshot);
      if(previous?.source!=='google'||!['ready','error','expired'].includes(previous.status))
        throw new HttpError(409,'arrival_changed');
      const run={...previous,status:'analyzing',error:undefined};
      active=run;
      startAnalysis(run,snapshot,input.data.locale);
      return json(view(),202);
    }
    if (url.pathname === prefix+'/confirm') {
      const input = confirmInput.safeParse(await readJson(request,1800));
      if (!input.success) throw new HttpError(400,'confirmation_required');
      return json(await confirm(input.data,request.signal));
    }
    if (url.pathname === prefix+'/google/connect') {
      const {url:target,cookie} = google.connect(url.origin);
      const response = json({url:target});
      response.headers.set('Set-Cookie',cookie);
      return response;
    }
    if (url.pathname === prefix+'/google/disconnect') {
      google.disconnect();
      if (active?.source === 'google') active = undefined;
      return json(view());
    }
    throw new HttpError(404,'invalid_action');
  }
  return handler;
}
