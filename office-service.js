import { layoutRooms, layoutSeats, layoutPosition } from './office-layout.js';
import { simulatedComfort, missingFeatures, compareComfort, comfortOrder } from './seat-comfort.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createDataset } from './queries.js';
import { withMcpClient } from './mcp-client.js';
import { assertSameOrigin, readJson, json, HttpError } from './http-utils.js';
import { parseOfficeIntentWithGpt, parseDayPlanWithGpt, readApiKey, answerQuestion, runOfficeImprovementAgent } from './llm.js';
import { validateDayPlan, allocateDayPlan, sameMeeting } from './day-plan.js';
import { createMeetingState, seededReservations } from './meeting-state.js';
import { runCalendarAgent, calendarAnalysisSchema, calendarExportSchema, calendarReviewSchema, reviewCalendarExport } from './calendar-service.js';

export const officeRooms = [
  ...layoutRooms.map(room=>({...room,kind:'meeting',area:'meeting',capacity_source:'spaces.csv',features_source:'simulation',
    x:layoutPosition('meeting',room.id).x,y:layoutPosition('meeting',room.id).y})),
  ...layoutSeats().map((seat,index)=>({...seat,comfort:simulatedComfort(index+1),
    x:layoutPosition(seat.area,seat.id).x,y:layoutPosition(seat.area,seat.id).y})),
  // The old single-seat demo remains functional, with no invented physical binding.
  {id:'office-f12',name:'F-12',capacity:1,kind:'desk',features:['monitor','quiet'],area:null,features_source:'simulation',x:10,y:85}
];
const featureNames = {monitor:'モニター',whiteboard:'ホワイトボード',quiet:'静かな場所',video:'オンライン会議設備',projector:'プロジェクター',window:'窓際',low_airflow:'空調の風が弱い',avoid_cold:'寒さを避けたい',avoid_hot:'暑さを避けたい'};
export const jstDate = (now = new Date()) => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(now);
const addDays = (date, days) => new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value);
const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const draftSchema = z.object({date:dateSchema.nullable(),time:timeSchema.nullable(),duration:z.number().int().min(15).max(480).nullable(),people:z.number().int().min(1).max(100).nullable(),kind:z.enum(['meeting','desk']),features:z.array(z.string().min(1).max(60)).max(12),unclear:z.array(z.string().max(180)).max(10)}).strict();
const requestSchema = draftSchema.omit({unclear:true}).extend({date:dateSchema,time:timeSchema,duration:z.number().int().min(15).max(480),people:z.number().int().min(1).max(100)}).strict();
function checked(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400,'条件の形式が無効です。日付・時刻・人数・所要時間を確認してください。');
  return result.data;
}
function completeDraft(value,today,parser) {
  const draft=checked(draftSchema,value);
  const missing=[];
  for(const [field,label] of Object.entries({date:'日付',time:'開始時刻',duration:'所要時間',people:'合計人数'}))if(draft[field]===null)missing.push(label);
  if(draft.date && (draft.date<today||draft.date>addDays(today,30)))draft.unclear.push('日付は今日から30日先までで指定してください。');
  return {draft,missing,ready:missing.length===0&&draft.unclear.length===0,parser,today};
}
function validateRequest(value,today) {
  const request=checked(requestSchema,value);
  if(request.date<today||request.date>addDays(today,30))throw new HttpError(400,'予約日は今日から30日先までです。');
  const start=Number(request.time.slice(0,2))*60+Number(request.time.slice(3));
  if(start<9*60||start+request.duration>18*60)throw new HttpError(400,'デモの予約時間は09:00〜18:00です。日をまたぐ予約はできません。');
  return {...request,start,end:start+request.duration};
}
const overlaps=(a,b)=>a.date===b.date&&a.start<b.end&&b.start<a.end;
const clock = minutes=>`${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
function officeDataset(today,bookings,includeSeeded) {
  const seeded=includeSeeded?seededReservations(today,officeRooms):[];
  const all=[...new Map([...seeded,...bookings].map(record=>[record.id,record])).values()].filter(r=>!r.deleted&&r.source!=='attendance');
  const csvValue=value=>'"'+String(value??'').replaceAll('"','""')+'"';
  const csv=['reservations_id,space_id,space_name,base_condition_start_date,base_condition_start_time_jst,base_condition_end_time_jst,total_people_count,reservation_status,is_used,is_reserved',...all.map(b=>`${b.id},${b.space_id},${officeRooms.find(r=>r.id===b.space_id).name},${b.date},${b.date} ${clock(b.start)}:00,${b.date} ${clock(b.status==='completed'&&b.actual_end?Number(b.actual_end.slice(0,2))*60+Number(b.actual_end.slice(3)):b.end)}:00,${b.people??1},${b.status??'reserved'},${b.status==='completed'?'true':b.status==='cancelled'?'false':''},${b.status==='cancelled'?'false':'true'}`)].join('\n');
  const dataset=createDataset({
    'spaces.csv':['space_id,organization_id,space_name,attribute_list,type,capacity',...officeRooms.map(r=>`${r.id},office-simulation,${r.name},${r.kind==='meeting'?'MeetingRoom':'Workspace'},${r.kind==='desk'?'Workspot':'Area'},${r.capacity}`)].join('\n'),
    'reservations.csv':csv,
    'reservations_classified_mapping.csv':['reservations_id,category',...all.map(b=>`${b.id},${csvValue(b.title??'Simulated meeting')}`)].join('\n')
  },'synthetic',{emptyCoverage:{start:today,end:addDays(today,30)}});
  // The simulated calendar is complete for this horizon, even on dates without bookings.
  dataset.coverage={start:all.map(b=>b.date).concat(today).sort()[0],end:all.map(b=>b.date).concat(addDays(today,30)).sort().at(-1)};
  dataset.scope='current_workspace';
  dataset.roomFitContext={rooms:officeRooms,reservations:[...seeded,...bookings]};
  return dataset;
}
export async function recommendOfficeRooms(request,bookings,today,{includeSeeded=false}={}) {
  const need=validateRequest(request,today);
  return withMcpClient(officeDataset(today,bookings,includeSeeded),async client=>{
    const trace=[];
    async function invoke(name,args){
      const response=await client.callTool({name,arguments:args});
      if(response.isError)throw new HttpError(500,'MCPの照会に失敗しました。');
      const result=response.structuredContent.result;
      trace.push({name,arguments:args,result});return result;
    }
    const spaceArgs={min_capacity:need.people,type:need.kind==='desk'?'Workspot':'Area',limit:100};
    const spaces=await invoke('search_spaces',spaceArgs);
    while(spaces.items.length<spaces.total){
      const next=await invoke('search_spaces',{...spaceArgs,offset:spaces.items.length});
      if(!next.items.length)throw new HttpError(500,'incomplete_spaces');
      spaces.items.push(...next.items);
    }
    const reservations=await invoke('query_reservations',{start_date:need.date,end_date:need.date,limit:100});
    while(reservations.items.length<reservations.total){
      const next=await invoke('query_reservations',{start_date:need.date,end_date:need.date,limit:100,offset:reservations.items.length});
      if(!next.items.length)throw new HttpError(500,'incomplete_calendar');
      reservations.items.push(...next.items);
    }
    const candidates=[],excluded=[];
    for(const room of officeRooms){
      const reasons=[];
      if(!spaces.items.some(s=>s.space_id===room.id))reasons.push(`定員${room.capacity}人：希望${need.people}人に不足`);
      if(room.kind!==need.kind)reasons.push(need.kind==='meeting'?'会議室ではありません':'個人作業席ではありません');
      for(const feature of missingFeatures(room,need.features))reasons.push(`${featureNames[feature]??feature}：対応情報なし`);
      const conflicts=reservations.items.filter(r=>r.space_id===room.id&&overlaps(need,{date:r.date,start:Number(r.start_raw.slice(11,13))*60+Number(r.start_raw.slice(14,16)),end:Number(r.end_raw.slice(11,13))*60+Number(r.end_raw.slice(14,16))}));
      if(conflicts.length)reasons.push('指定時間に模擬予約があります');
      if(reasons.length)excluded.push({id:room.id,name:room.name,reasons,conflicts:conflicts.map(r=>({id:r.reservation_id,start:r.start_raw,end:r.end_raw}))});
      else candidates.push({...room,...(room.kind==='desk'?{comfort_basis:comfortOrder(room,need.features)}:{}),reasons:[`定員${room.capacity}人 / 希望${need.people}人`,`${need.date} ${need.time}〜${clock(need.end)}の模擬日程に重複なし`,...need.features.map(f=>featureNames[f]??f)]});
    }
    candidates.sort((a,b)=>a.capacity-b.capacity||(need.kind==='desk'?compareComfort(a,b,need.features):a.id.localeCompare(b.id)));
    return {simulation:true,request:requestSchema.parse(request),end_time:clock(need.end),candidates,excluded,trace};
  });
}

// Local-only, bounded, page-scoped simulation sessions. No company data or disk writes.
export function createOfficeService({now=()=>new Date(),gptParser=parseOfficeIntentWithGpt,dayParser=parseDayPlanWithGpt,answerer=answerQuestion,improvementAgent=runOfficeImprovementAgent,calendarAgent=runCalendarAgent,workspace:providedWorkspace,comfortSummary=null,initialReservations=[],includeLegacyPresets=false}={}) {
  const sessions=new Map();
  const workspace=providedWorkspace??createMeetingState({rooms:officeRooms,now,initialReservations,includeLegacyPresets});
  const recommendCalendar=(need,bookings,today)=>recommendOfficeRooms(need,bookings,today,{includeSeeded:false});
  const recommendWorkspace=(need,bookings,today)=>{
    const all=new Map(workspace.calendar().map(record=>[record.id,record]));
    for(const record of bookings)all.set(record.id,record);
    return recommendCalendar(need,[...all.values()],today);
  };
  const ttl=30*60*1000;
  function purge(){const time=now().getTime();for(const [id,s] of sessions)if(time-s.touched>=ttl)sessions.delete(id);}
  return async function handleOfficeRequest(request){
    assertSameOrigin(request);purge();
    const path=new URL(request.url).pathname;
    const today=workspace.referenceDate();
    if(path==='/api/office/comfort'&&request.method==='GET')return json(comfortSummary??{source:'unavailable',items:[],mapped_to_demo_seats:false});
    if(path==='/api/office/workspace'&&request.method==='GET')return json({...workspace.snapshot(),today});
    if(path==='/api/office/calendar'){
      if(request.method==='GET')return json({...workspace.employeeCalendar(),instance_id:workspace.snapshot().instance_id,today});
      if(request.method!=='POST')throw new HttpError(405,'method');
      return json({...workspace.changeCalendar(await readJson(request,8000)),instance_id:workspace.snapshot().instance_id,today});
    }
    if(path==='/api/office/calendar/export'){
      if(request.method!=='POST')throw new HttpError(405,'method');
      const parsed=calendarExportSchema.safeParse(await readJson(request,2000));
      if(!parsed.success)throw new HttpError(400,'calendar_invalid');
      const input=parsed.data,state=workspace.snapshot();
      if(input.revision!==state.revision||input.instance_id!==state.instance_id)throw new HttpError(409,'state_changed');
      const result=workspace.createCalendarExport(input);
      return json({...result,calendar_days:state.calendar_day_versions,instance_id:state.instance_id,simulation:true});
    }
    if(path==='/api/office/calendar/review'){
      if(request.method!=='POST')throw new HttpError(405,'method');
      const key=readApiKey(request),parsed=calendarReviewSchema.safeParse(await readJson(request,5000));
      if(!parsed.success)throw new HttpError(400,'calendar_invalid');
      return json(await reviewCalendarExport({workspace,input:parsed.data,today,key,request,
        dataset:officeDataset(today,workspace.snapshot().reservations,false),withClient:withMcpClient,agent:calendarAgent,recommend:recommendWorkspace}));
    }
    if(path==='/api/office/calendar/analyze'){
      if(request.method!=='POST')throw new HttpError(405,'method');
      const key=readApiKey(request),parsed=calendarAnalysisSchema.safeParse(await readJson(request,2000));
      if(!parsed.success)throw new HttpError(400,'calendar_invalid');
      const input=parsed.data;
      const snapshot=workspace.snapshot(),calendar=workspace.employeeCalendar();
      if(input.revision!==snapshot.revision||input.instance_id!==snapshot.instance_id)throw new HttpError(409,'state_changed');
      if(input.date<today||input.date>addDays(today,30))throw new HttpError(400,'date_range');
      const entries=calendar.events.filter(e=>e.date===input.date),active=entries.filter(e=>e.status==='active');
      if(!active.length)throw new HttpError(400,'calendar_empty');
      const allOwn=snapshot.meetings.filter(r=>!r.deleted),own=allOwn.filter(r=>r.date===input.date||entries.some(e=>e.id===r.calendar_event_id)),proposals=new Map(),reads=new Set();
      const checkCurrent=()=>{const latest=workspace.snapshot();if(latest.revision!==snapshot.revision||latest.instance_id!==snapshot.instance_id)throw new HttpError(409,'state_changed');};
      const dataset=officeDataset(today,snapshot.reservations,false);
      dataset.calendarContext={
        get_calendar_events:({date})=>{checkCurrent();if(date!==input.date)throw new HttpError(400,'calendar_invalid');reads.add('events');return {events:entries,revision:calendar.revision,date,simulation:true};},
        get_employee_bookings:({date})=>{checkCurrent();if(date!==input.date)throw new HttpError(400,'calendar_invalid');reads.add('bookings');return {date,bookings:own.map(({id,title,space_id,name,date,time,end_time,people,status,request,calendar_event_id,calendar_event_version})=>({id,title,space_id,name,date,time,end_time,people,status,request,calendar_event_id,calendar_event_version}))};},
        recommend_calendar_event:async args=>{
          checkCurrent();if(reads.size!==2)throw new HttpError(409,'calendar_incomplete');
          const entry=active.find(e=>e.id===args.event_id&&e.version===args.event_version);
          if(!entry)throw new HttpError(409,'calendar_changed');
          const duration=Number(entry.end_time.slice(0,2))*60+Number(entry.end_time.slice(3))-Number(entry.time.slice(0,2))*60-Number(entry.time.slice(3));
          const activity={type:args.type,title:entry.title,date:entry.date,time:entry.time,duration,people:entry.people??(args.type==='desk'?1:null),
            window_start:null,window_end:null,features:args.features,participants:[],existing_id:null,unclear:args.unclear};
          // Explicit form values are authoritative; the model must not invent headcounts.
          if(args.type==='meeting'&&args.people!==entry.people)throw new HttpError(400,'calendar_invalid');
          const linkedRecords=allOwn.filter(r=>r.calendar_event_id===entry.id&&['reserved','in_progress','completed'].includes(r.status));
          const linked=linkedRecords[0];
          const resource=['desk','meeting'].includes(args.type);
          const outsideHours=entry.time<'09:00'||entry.end_time>'18:00';
          const conflict=active.some(e=>e.id!==entry.id&&e.time<entry.end_time&&entry.time<e.end_time);
          let proposal;
          if(linked){
            const matches=linkedRecords.length===1&&linked.calendar_event_version===entry.version&&sameMeeting(activity,{...linked,status:'reserved'},args.type==='desk'?'desk':'meeting');
            proposal={id:randomUUID(),activity,status:matches&&!conflict&&!outsideHours?'existing':'needs_input',existing:linked,
              issues:!matches?['calendar_booking_changed']:conflict?['calendar_event_conflict']:outsideHours?['hours']:[],candidates:[],trace:[]};
          }else if(!resource){
            proposal={id:randomUUID(),activity,status:args.unclear.length?'needs_input':'note',issues:args.unclear,candidates:[],trace:[]};
          }else if(outsideHours||conflict){
            proposal={id:randomUUID(),activity,status:outsideHours?'needs_input':'no_slot',issues:[outsideHours?'hours':'calendar_event_conflict'],candidates:[],trace:[]};
          }
          else {
            const result=await allocateDayPlan(validateDayPlan({activities:[activity],questions:[]},today),snapshot.meetings,today,recommendWorkspace,
              {notBefore:snapshot.clock.date<today?{date:today,time:'09:00'}:snapshot.clock});
            proposal=result.proposals[0];
          }
          proposal.calendar_event={id:entry.id,version:entry.version};
          checkCurrent();proposals.set(entry.id,proposal);
          return {event_id:entry.id,event_version:entry.version,proposal,simulation:true};
        }
      };
      let report;const signal=AbortSignal.any([request.signal,AbortSignal.timeout(110000)]);
      try{report=await withMcpClient(dataset,client=>calendarAgent(client,key,input,{checkCurrent,signal}));}
      catch(error){if(error.name==='TimeoutError')throw new HttpError(504,'agent_timeout');throw error;}
      checkCurrent();
      signal.throwIfAborted();
      if(reads.size!==2||active.some(e=>!proposals.has(e.id)))throw new HttpError(502,'calendar_incomplete');
      const result={proposals:active.sort((a,b)=>a.time.localeCompare(b.time)).map(e=>proposals.get(e.id)),questions:[],calendar_origin:{revision:calendar.revision,date:input.date}};
      const plan_id=workspace.savePlan(result);
      return json({...result,plan_id,parser:'calendar_agent',summary:report.summary,trace:report.trace,model:input.model,simulation:true});
    }
    if(path==='/api/office/workspace/reset'){
      if(request.method!=='POST')throw new HttpError(405,'method');
      const input=await readJson(request,1000);
      if(!input||input.confirmed!==true||Object.keys(input).length!==1)throw new HttpError(400,'confirmation_required');
      sessions.clear();
      return json({...workspace.reset(),today});
    }
    if(path==='/api/office/admin/reservations'){
      if(request.method!=='GET')throw new HttpError(405,'method');
      return json(workspace.queryReservations(Object.fromEntries(new URL(request.url).searchParams)));
    }
    if(['/api/office/admin/clear-preview','/api/office/admin/clear','/api/office/admin/purge-preview','/api/office/admin/purge-deleted'].includes(path)){
      if(request.method!=='POST')throw new HttpError(405,'method');
      const input=await readJson(request,2000);
      const handler={'clear-preview':workspace.previewClear,clear:workspace.clearRecords,'purge-preview':workspace.previewPurge,'purge-deleted':workspace.purgeDeleted}[path.split('/').at(-1)];
      return json(handler(input));
    }
    if(path==='/api/office/data/call'||path==='/api/office/data/chat'){
      if(request.method!=='POST')throw new HttpError(405,'method');
      const input=await readJson(request,24000);
      const snapshot=workspace.snapshot();
      const dataset=officeDataset(today,snapshot.reservations,false);
      return withMcpClient(dataset,async client=>{
        if(path.endsWith('/chat')){
          const key=readApiKey(request);
          return json(await answerer(client,key,input,{signal:AbortSignal.any([request.signal,AbortSignal.timeout(90000)])}));
        }
        const allowed=['get_data_status','search_spaces','query_reservations','summarize_reservations','detect_unused_reservations','get_evidence','analyze_room_fit'];
        if(!input||!allowed.includes(input.name))throw new HttpError(400,'invalid_action');
        return json({result:await client.callTool({name:input.name,arguments:input.arguments??{}}),revision:snapshot.revision,instance_id:snapshot.instance_id,scope:'current_workspace'});
      });
    }
    if(path==='/api/office/improvements'){
      if(request.method!=='POST')throw new HttpError(405,'method');
      const key=readApiKey(request);
      const input=checked(z.object({start_date:dateSchema,end_date:dateSchema,revision:z.number().int().nonnegative(),
        instance_id:z.string().min(1).max(200),locale:z.enum(['ja','en']),model:z.string().regex(/^gpt-[a-zA-Z0-9.-]{1,90}$/)}).strict(),await readJson(request,2000));
      const snapshot=workspace.snapshot();
      if(input.revision!==snapshot.revision||input.instance_id!==snapshot.instance_id)throw new HttpError(409,'state_changed');
      if(input.start_date>input.end_date)throw new HttpError(400,'invalid_window');
      const dataset=officeDataset(today,snapshot.reservations,false);
      if(input.start_date<dataset.coverage.start||input.end_date>dataset.coverage.end)throw new HttpError(400,'invalid_window');
      return withMcpClient(dataset,async client=>{
        const checkCurrent=()=>{const latest=workspace.snapshot();if(latest.revision!==snapshot.revision||latest.instance_id!==snapshot.instance_id)throw new HttpError(409,'state_changed');};
        let report;
        try{report=await improvementAgent(client,key,input,{signal:AbortSignal.any([request.signal,AbortSignal.timeout(110000)]),checkCurrent});}
        catch(error){if(error.name==='TimeoutError')throw new HttpError(504,'agent_timeout');throw error;}
        checkCurrent();
        return json({...report,revision:snapshot.revision,instance_id:snapshot.instance_id});
      });
    }
    if(path.startsWith('/api/office/admin/')){
      if(request.method!=='POST')throw new HttpError(405,'method');
      return json(await workspace.adminMutate(path.slice('/api/office/admin/'.length),await readJson(request,12000),recommendCalendar));
    }
    if (['/api/office/day-plan','/api/office/confirm','/api/office/attendance','/api/office/transition','/api/office/replan','/api/office/rebook'].includes(path)) {
      if(request.method!=='POST')throw new HttpError(405,'method');
      const input=await readJson(request,24000);
      if(!input||typeof input!=='object'||Array.isArray(input))throw new HttpError(400,'invalid_request');
      if(path.endsWith('/transition'))return json(workspace.transition(input.meeting_id,input.action,input.end_time));
      if(path.endsWith('/confirm'))return json(await workspace.confirm(input,recommendWorkspace,today));
      if(path.endsWith('/attendance'))return json(workspace.attend(input));
      let plan,rebookOf=null,rebookVersion=null,distinctIndex=-1,kind='meeting',parser=input.mode,locale=input.locale==='en'?'en':'ja';
      if(path.endsWith('/rebook')){
        const state=workspace.snapshot(),record=state.meetings.find(r=>r.id===input.meeting_id);
        if(!record)throw new HttpError(404,'meeting_missing');
        if(record.calendar_event_id)throw new HttpError(409,'calendar_recheck');
        if(record.source==='attendance')throw new HttpError(409,'attendance_readonly');
        const historical=state.meeting_history.find(r=>r.id===record.id);
        if(historical?.replacement_id)throw new HttpError(409,'rebook_replaced');
        if(record.status!=='cancelled')throw new HttpError(409,'invalid_transition');
        if(record.date<today||record.date>addDays(today,30))throw new HttpError(400,'date_range');
        const request=record.request;kind=request.kind;
        rebookOf=record.id;rebookVersion=record.version;
        plan={activities:[{type:request.kind==='desk'?'desk':'meeting',title:record.title,date:record.date,time:record.time,window_start:null,window_end:null,
          duration:request.duration,people:record.people,features:request.features,participants:record.participants??[],existing_id:null,unclear:[]}],questions:[]};
        parser='edited';
      }else if(path.endsWith('/replan')){
        const previous=workspace.getPlan(input.plan_id);
        if(previous.calendar_origin)throw new HttpError(409,'calendar_recheck');
        rebookOf=previous.rebook_of??null;rebookVersion=previous.rebook_version??null;
        const proposal=previous.proposals.find(p=>p.id===input.proposal_id);
        if(!proposal)throw new HttpError(404,'invalid_proposal');
        plan=validateDayPlan({activities:previous.proposals.map(p=>p.activity),questions:previous.questions},today);
        if(previous.proposals.length===1)kind=proposal.request?.kind??'meeting';
        if(input.activity){
          const index=previous.proposals.findIndex(p=>p.id===input.proposal_id);
          plan.activities[index]=validateDayPlan({activities:[input.activity],questions:[]},today).activities[0];
        }
        if(input.distinct===true){distinctIndex=previous.proposals.findIndex(p=>p.id===input.proposal_id);plan.activities[distinctIndex].existing_id=null;}
        parser='edited';
      }else{
        if(typeof input.message!=='string'||!input.message.trim()||input.message.length>4000)throw new HttpError(400,'input_length');
        if(parser!=='gpt'&&parser!==undefined)throw new HttpError(400,'ai_required');
        parser='gpt';plan=await dayParser(readApiKey(request),{message:input.message,model:input.model,today,locale,existing:workspace.snapshot().current_meetings},{signal:AbortSignal.any([request.signal,AbortSignal.timeout(60000)])});
      }
      plan=validateDayPlan(plan,today);
      const clock=workspace.snapshot().clock;
      const result=await allocateDayPlan(plan,workspace.snapshot().meetings,today,recommendWorkspace,{distinctIndex,kind,notBefore:clock.date<today?{date:today,time:'09:00'}:clock});
      if(rebookOf){result.rebook_of=rebookOf;result.rebook_version=rebookVersion;}
      const plan_id=workspace.savePlan(result);
      return json({...result,plan_id,parser,simulation:true});
    }
    if(path==='/api/office/session'&&request.method==='POST'){
      if(sessions.size>=100)throw new HttpError(429,'デモセッションが多すぎます。時間をおいて再試行してください。');
      const id=randomUUID();sessions.set(id,{bookings:[],touched:now().getTime(),generation:0});
      return json({session_id:id,today,rooms:officeRooms,simulation:true,expires_after_minutes:30});
    }
    const id=request.headers.get('X-Office-Session'),session=sessions.get(id);
    if(!session)throw new HttpError(401,'デモセッションが終了しました。ページを再読み込みしてください。');
    session.touched=now().getTime();
    const current=()=>{if(sessions.get(id)!==session)throw new HttpError(409,'セッションが更新されました。ページを再読み込みしてください。');};
    if(path==='/api/office/session'&&request.method==='DELETE'){sessions.delete(id);return json({deleted:true});}
    if(path==='/api/office/bookings'&&request.method==='GET')return json({bookings:session.bookings.map(({start,end,...b})=>({...b,time:clock(start),end_time:clock(end)})),simulation:true});
    if(request.method!=='POST')throw new HttpError(404,'見つかりません');
    const input=await readJson(request,10000);
    if(path==='/api/office/parse'){
      if(!input||typeof input.message!=='string'||!input.message.trim()||input.message.length>2000)throw new HttpError(400,'要望を1〜2,000文字で入力してください。');
      let result;
      if(input.mode==='gpt'||input.mode===undefined){
        const key=readApiKey(request);
        const model=input.model;
        if(typeof model!=='string'||!/^gpt-[a-zA-Z0-9.-]{1,90}$/.test(model))throw new HttpError(400,'モデル名を確認してください。');
        result=completeDraft(await gptParser(key,{message:input.message,model,today},{signal:AbortSignal.any([request.signal,AbortSignal.timeout(45000)])}),today,'gpt');
      }else throw new HttpError(400,'ai_required');
      current();return json(result);
    }
    if(path==='/api/office/recommend')return json(await recommendOfficeRooms(input.request,session.bookings,today,{includeSeeded:includeLegacyPresets}));
    if(path==='/api/office/book'){
      const need=validateRequest(input.request,today);
      if(input.confirmed!==true)throw new HttpError(400,'本人の確認が必要です。');
      if(typeof input.request_id!=='string'||!/^[a-f0-9-]{36}$/.test(input.request_id))throw new HttpError(400,'操作IDが無効です。');
      const prior=session.bookings.find(b=>b.request_id===input.request_id);
      if(prior){if(prior.space_id!==input.space_id||JSON.stringify(prior.request)!==JSON.stringify(input.request))throw new HttpError(409,'同じ操作IDで条件を変更できません。');return json({booking:prior,simulation:true});}
      if(session.bookings.length>=50)throw new HttpError(422,'このページの模擬予約は50件までです。不要な予約を取り消してください。');
      const generation=session.generation;
      const result=await recommendOfficeRooms(input.request,session.bookings,today,{includeSeeded:includeLegacyPresets});
      current();
      // Recheck after await; concurrent confirmations must never both claim one slot.
      if(session.generation!==generation)throw new HttpError(409,'予約状況が変わりました。候補を再検索してください。');
      const room=result.candidates.find(r=>r.id===input.space_id);
      if(!room)throw new HttpError(409,'この部屋は条件を満たさないか、予約が重複しています。候補を再検索してください。');
      const booking={id:randomUUID(),request_id:input.request_id,space_id:room.id,name:room.name,date:need.date,start:need.start,end:need.end,time:need.time,end_time:clock(need.end),people:need.people,request:requestSchema.parse(input.request)};
      session.bookings.push(booking);session.generation++;
      return json({booking,simulation:true},201);
    }
    if(path==='/api/office/cancel'){
      const index=session.bookings.findIndex(b=>b.id===input.booking_id);
      if(index<0)throw new HttpError(404,'このページの模擬予約が見つかりません。');
      session.bookings.splice(index,1);session.generation++;return json({cancelled:true,simulation:true});
    }
    throw new HttpError(404,'見つかりません');
  };
}

// Each request uses a private working copy. Commit after all I/O, only if no other
// request changed storage; a rejected write cannot corrupt the saved workspace.
export async function handleStoredOfficeRequest(request,storage,{now=()=>new Date(),withDemoHistory=false,...options}={}) {
  assertSameOrigin(request);
  const path=new URL(request.url).pathname;
  const reads=['/api/office/workspace','/api/office/admin/reservations','/api/office/comfort'];
  const readonlyPosts=['/api/office/data/call','/api/office/data/chat','/api/office/improvements'];
  const writes=['/api/office/workspace/reset','/api/office/day-plan','/api/office/confirm','/api/office/attendance',
    '/api/office/transition','/api/office/replan','/api/office/rebook',...['create','update','delete','restore','finish','cancel','purge','clear-preview','clear','purge-preview','purge-deleted'].map(a=>'/api/office/admin/'+a)];
  writes.push('/api/office/calendar/analyze','/api/office/calendar/export','/api/office/calendar/review');
  if(path==='/api/office/calendar'){if(request.method==='GET')reads.push(path);else writes.push(path);}
  if(!reads.includes(path)&&!writes.includes(path)&&!readonlyPosts.includes(path))throw new HttpError(404,'invalid_action');
  if(request.method!==(reads.includes(path)?'GET':'POST'))throw new HttpError(405,'invalid_action');
  const saved=storage.load();
  const workspace=createMeetingState({rooms:officeRooms,now,persisted:saved?.state});
  if(!saved)workspace.reset();
  // Only the workspace load initializes the demo batch; MCP and Agent reads stay read-only.
  const initialized=withDemoHistory&&path==='/api/office/workspace'&&workspace.initializeDemoHistory();
  const service=createOfficeService({...options,now,workspace});
  const response=await service(request);
  if(response.ok&&path==='/api/office/improvements'&&(storage.load()?.version??0)!==(saved?.version??0))throw new HttpError(409,'state_changed');
  if(response.ok&&(!saved||initialized||writes.includes(path))){
    if(!storage.commit(saved?.version??0,workspace.exportState()))throw new HttpError(409,'state_changed');
  }
  if(response.ok){
    const payload=await response.json();
    return json(payload.instance_id?{...payload,deployment:'cloud',workspace_scope:'browser'}:payload,response.status);
  }
  return response;
}
