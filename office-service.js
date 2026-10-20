import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createDataset } from './queries.js';
import { withMcpClient } from './mcp-client.js';
import { assertSameOrigin, readJson, json, HttpError } from './http-utils.js';
import { parseOfficeIntentWithGpt, parseDayPlanWithGpt, readApiKey } from './llm.js';
import { parseLocalDayPlan, validateDayPlan, allocateDayPlan } from './day-plan.js';
import { createMeetingState, seededReservations } from './meeting-state.js';

export const officeRooms = [
  { id:'office-c04', name:'C-04', capacity:4, kind:'meeting', features:['monitor','whiteboard','quiet'], x:79, y:36 },
  { id:'office-m02', name:'M-02', capacity:6, kind:'meeting', features:['monitor','video'], x:83, y:79 },
  { id:'office-f12', name:'F-12', capacity:1, kind:'desk', features:['monitor','quiet'], x:20, y:39 }
];
const featureNames = {monitor:'モニター',whiteboard:'ホワイトボード',quiet:'静かな場所',video:'オンライン会議設備',projector:'プロジェクター',window:'窓際'};
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
function normalize(text) {
  const numerals = {'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
  return text.normalize('NFKC').replace(/一个/g,'一').replace(/([零〇一二两三四五六七八九十]{1,3})(?=\s*(?:个?人|名|位|点|时|時|小时|時間|分|月|日))/g, value=>{
    if(value==='十')return '10';
    if(value.includes('十')) { const [a,b]=value.split('十');return String((a?numerals[a]:1)*10+(b?numerals[b]:0)); }
    return String(numerals[value] ?? value);
  });
}
export function parseOfficeIntent(message, today) {
  if(typeof message!=='string' || !message.trim() || message.length>2000)throw new HttpError(400,'要望を1〜2,000文字で入力してください。');
  const text = normalize(message);
  const result = {date:null,time:null,duration:null,people:null,kind:/座位|工位|席|专注|集中作業|集中工作|集中して|個人作業/.test(text)?'desk':'meeting',features:[],unclear:[]};
  const fullDate = text.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/);
  const monthDay = text.match(/(\d{1,2})月(\d{1,2})日/);
  if(fullDate)result.date=`${fullDate[1]}-${fullDate[2].padStart(2,'0')}-${fullDate[3].padStart(2,'0')}`;
  else if(monthDay)result.date=`${today.slice(0,4)}-${monthDay[1].padStart(2,'0')}-${monthDay[2].padStart(2,'0')}`;
  else if(/后天|後天|明後日/.test(text))result.date=addDays(today,2);
  else if(/明天|明日/.test(text))result.date=addDays(today,1);
  else if(/今天|今日|本日/.test(text))result.date=today;
  else {
    const weekday=text.match(/(下周|下週|来週|本周|这周|今週|周|週)([一二三四五六日天月火水木金土])/);
    if(weekday){
      const n={'一':1,'月':1,'二':2,'火':2,'三':3,'水':3,'四':4,'木':4,'五':5,'金':5,'六':6,'土':6,'日':0,'天':0}[weekday[2]];
      const day=new Date(today+'T00:00:00Z').getUTCDay();
      const mondayOffset=day===0?-6:1-day;
      const explicitNext=/下|来/.test(weekday[1]);
      const offset=explicitNext?mondayOffset+7+(n===0?6:n-1):/本|这|今/.test(weekday[1])?mondayOffset+(n===0?6:n-1):(n-day+7)%7;
      result.date=addDays(today,offset);
    }
  }
  const clockPattern=/(\d{1,2})[:：](\d{2})|(?<![\d小])(\d{1,2})(?:点|時(?!間)|时(?!间))(半|\d{1,2}分)?/g;
  const clocks=[...text.matchAll(clockPattern)].map(match=>{
    let hour=Number(match[1]??match[3]), minute=match[2]?Number(match[2]):match[4]==='半'?30:Number(match[4]?.replace('分','')||0);
    const prefix=text.slice(Math.max(0,match.index-10),match.index);
    const afternoon=/下午|晚上|傍晚|午後|夕方/.test(prefix)||(/下午|午後/.test(text)&&!(/上午|午前/.test(text)));
    const morning=/上午|早上|午前/.test(prefix);
    if(afternoon&&hour<12)hour+=12;
    if(morning&&hour===12)hour=0;
    if(hour>23||minute>59)return null;
    if(!match[1]&&hour<12&&!afternoon&&!morning){result.unclear.push('午前・午後を指定するか、14:00のように24時間表記で入力してください。');return null;}
    return `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
  });
  if(clocks.length)result.time=clocks[0];
  const durationText=text.replace(clockPattern,' ');
  const hours=durationText.match(/(\d+(?:\.5)?)\s*(?:个)?(?:小时|時間)(半)?/);
  const minutes=durationText.match(/(\d+)\s*(?:分钟|分鐘|分間|分)(?![\d钟])/);
  if(hours)result.duration=Number(hours[1])*60+(hours[2]?30:0)+(minutes?Number(minutes[1]):0);
  else if(/半(?:个)?小时|半時間/.test(text))result.duration=30;
  else if(minutes)result.duration=Number(minutes[1]);
  if(clocks.length===2&&clocks.every(Boolean)){
    if(/から|到|至|〜|～|~|—|\d{2}-\d/.test(text)){
      const delta=Number(clocks[1].slice(0,2))*60+Number(clocks[1].slice(3))-Number(clocks[0].slice(0,2))*60-Number(clocks[0].slice(3));
      if(result.duration!==null&&result.duration!==delta)result.unclear.push('終了時刻と所要時間が一致しません。');
      result.duration=delta;
    }else result.unclear.push('複数の開始時刻があります。1件の要望に分けてください。');
  }else if(clocks.length>2)result.unclear.push('複数の時間指定があります。1件ずつ入力してください。');
  const people=[...text.matchAll(/(\d+)\s*(?:个?人|名|位)/g)];
  if(people.length===1)result.people=Number(people[0][1]);
  if(people.length>1||/我和|私と|加上我|含め/.test(text)){result.people=null;result.unclear.push('参加者の合計人数を明記してください。例：合計4人。');}
  const positive=text.replace(/(?:不需要|不需|不要|无需|不用|要らない|不要な)\s*(?:屏幕|显示器|モニター|白板|ホワイトボード|视频设备|オンライン会議設備|安静|静か)/g,'').replace(/(?:モニター|ホワイトボード|オンライン会議設備)(?:は|が)?(?:不要|要らない)/g,'');
  for(const [feature,pattern] of Object.entries({monitor:/屏幕|显示器|显示屏|モニター|ディスプレイ|スクリーン/,whiteboard:/白板|ホワイトボード/,quiet:/安静|静か|静音|低噪/,video:/视频|視訊|オンライン会議|ビデオ会議|カメラ/,projector:/投影|プロジェクター/,window:/靠窗|窗边|窓際|窓のある/}))if(pattern.test(positive))result.features.push(feature);
  // Unsupported requirements stay visible and block automatic filtering until clarified.
  for(const value of positive.matchAll(/(?:需要|需|要|付きの?|がある)([^，。；、\n]{1,40})/g)){
    const clause=value[1];
    if(/咖啡|茶水|轮椅|无障碍|無障害|車椅子|隔音|防音|录音|マイク|音响|音響|吸烟|喫煙|海景/.test(clause))result.features.push(clause.trim().slice(0,60));
  }
  for(const value of positive.matchAll(/(?:需要|要求|必须有|需配备|带有|要有)([^，。；\n]{1,80})/g)){
    const remainder=value[1].replace(/屏幕|显示器|显示屏|モニター|ディスプレイ|スクリーン|白板|ホワイトボード|安静|静か|静音|低噪|视频|視訊|オンライン会議|ビデオ会議|カメラ|投影仪?|プロジェクター|靠窗|窗边|窓際|窓のある/g,'').replace(/[\s、和及与的有带设备，]/g,'');
    if(remainder&&!result.features.includes(value[1].trim().slice(0,60)))result.features.push(value[1].trim().slice(0,60));
  }
  if(/或者|或是|または|どちらか/.test(text))result.unclear.push('選択条件を検出しました。必要な設備を確認画面で選んでください。');
  if(/(?:不要|不需要|无需)[^，。\n]*(?:和|及|与)/.test(text))result.unclear.push('複数の不要条件があります。設備のチェックを確認してください。');
  result.features=[...new Set(result.features)];
  return completeDraft(result,today,'rules');
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
  const all=[...new Map([...seeded,...bookings].map(record=>[record.id,record])).values()];
  const csv=['reservations_id,space_id,space_name,base_condition_start_date,base_condition_start_time_jst,base_condition_end_time_jst,total_people_count,reservation_status,is_used,is_reserved',...all.map(b=>`${b.id},${b.space_id},${officeRooms.find(r=>r.id===b.space_id).name},${b.date},${b.date} ${clock(b.start)}:00,${b.date} ${clock(b.end)}:00,1,模擬予約,false,true`)].join('\n');
  const dataset=createDataset({
    'spaces.csv':['space_id,organization_id,space_name,attribute_list,type,capacity',...officeRooms.map(r=>`${r.id},office-simulation,${r.name},${r.kind==='meeting'?'MeetingRoom':'Workspace'},${r.kind==='desk'?'Workspot':'Area'},${r.capacity}`)].join('\n'),
    'reservations.csv':csv,
    'reservations_classified_mapping.csv':['reservations_id,category',...all.map(b=>`${b.id},模擬会議`)].join('\n')
  },'synthetic',{emptyCoverage:{start:today,end:addDays(today,30)}});
  // The simulated calendar is complete for this horizon, even on dates without bookings.
  dataset.coverage={start:today,end:addDays(today,30)};
  return dataset;
}
export async function recommendOfficeRooms(request,bookings,today,{includeSeeded=true}={}) {
  const need=validateRequest(request,today);
  return withMcpClient(officeDataset(today,bookings,includeSeeded),async client=>{
    const trace=[];
    async function invoke(name,args){
      const response=await client.callTool({name,arguments:args});
      if(response.isError)throw new HttpError(500,'MCPの照会に失敗しました。');
      const result=response.structuredContent.result;
      trace.push({name,arguments:args,result});return result;
    }
    const spaces=await invoke('search_spaces',{min_capacity:need.people,limit:100});
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
      for(const feature of need.features)if(!room.features.includes(feature))reasons.push(`${featureNames[feature]??feature}：対応情報なし`);
      const conflicts=reservations.items.filter(r=>r.space_id===room.id&&overlaps(need,{date:r.date,start:Number(r.start_raw.slice(11,13))*60+Number(r.start_raw.slice(14,16)),end:Number(r.end_raw.slice(11,13))*60+Number(r.end_raw.slice(14,16))}));
      if(conflicts.length)reasons.push('指定時間に模擬予約があります');
      if(reasons.length)excluded.push({id:room.id,name:room.name,reasons,conflicts:conflicts.map(r=>({id:r.reservation_id,start:r.start_raw,end:r.end_raw}))});
      else candidates.push({...room,reasons:[`定員${room.capacity}人 / 希望${need.people}人`,`${need.date} ${need.time}〜${clock(need.end)}の模擬日程に重複なし`,...need.features.map(f=>featureNames[f]??f)]});
    }
    candidates.sort((a,b)=>a.capacity-b.capacity||a.id.localeCompare(b.id));
    return {simulation:true,request:requestSchema.parse(request),end_time:clock(need.end),candidates,excluded,trace};
  });
}

// Local-only, bounded, page-scoped simulation sessions. No company data or disk writes.
export function createOfficeService({now=()=>new Date(),gptParser=parseOfficeIntentWithGpt,dayParser=parseDayPlanWithGpt,workspace:providedWorkspace}={}) {
  const sessions=new Map();
  const workspace=providedWorkspace??createMeetingState({rooms:officeRooms,now});
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
    const today=jstDate(now());
    if(path==='/api/office/workspace'&&request.method==='GET')return json({...workspace.snapshot(),today});
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
      let plan,distinctIndex=-1,kind='meeting',parser=input.mode,locale=input.locale==='en'?'en':'ja';
      if(path.endsWith('/rebook')){
        const record=workspace.snapshot().meetings.find(r=>r.id===input.meeting_id);
        if(!record)throw new HttpError(404,'meeting_missing');
        if(record.source==='attendance')throw new HttpError(409,'attendance_readonly');
        if(record.status!=='cancelled')throw new HttpError(409,'invalid_transition');
        if(record.date<today||record.date>addDays(today,30))throw new HttpError(400,'date_range');
        const request=record.request;kind=request.kind;
        plan={activities:[{type:'meeting',title:record.title,date:record.date,time:record.time,window_start:null,window_end:null,
          duration:request.duration,people:record.people,features:request.features,participants:record.participants??[],existing_id:null,unclear:[]}],questions:[]};
        parser='edited';
      }else if(path.endsWith('/replan')){
        const previous=workspace.getPlan(input.plan_id);
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
        if(parser==='gpt')plan=await dayParser(readApiKey(request),{message:input.message,model:input.model,today,locale,existing:workspace.snapshot().meetings},{signal:AbortSignal.any([request.signal,AbortSignal.timeout(60000)])});
        else if(parser==='rules')plan=parseLocalDayPlan(input.message,today,locale);
        else throw new HttpError(400,'invalid_mode');
      }
      plan=validateDayPlan(plan,today);
      const result=await allocateDayPlan(plan,workspace.snapshot().meetings,today,recommendWorkspace,{distinctIndex,kind});
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
      if(input.mode==='gpt'){
        const key=readApiKey(request);
        const model=input.model;
        if(typeof model!=='string'||!/^gpt-[a-zA-Z0-9.-]{1,90}$/.test(model))throw new HttpError(400,'モデル名を確認してください。');
        result=completeDraft(await gptParser(key,{message:input.message,model,today},{signal:AbortSignal.any([request.signal,AbortSignal.timeout(45000)])}),today,'gpt');
      }else if(input.mode==='rules'||input.mode===undefined)result=parseOfficeIntent(input.message,today);
      else throw new HttpError(400,'解析方式を確認してください。');
      current();return json(result);
    }
    if(path==='/api/office/recommend')return json(await recommendOfficeRooms(input.request,session.bookings,today));
    if(path==='/api/office/book'){
      const need=validateRequest(input.request,today);
      if(input.confirmed!==true)throw new HttpError(400,'本人の確認が必要です。');
      if(typeof input.request_id!=='string'||!/^[a-f0-9-]{36}$/.test(input.request_id))throw new HttpError(400,'操作IDが無効です。');
      const prior=session.bookings.find(b=>b.request_id===input.request_id);
      if(prior){if(prior.space_id!==input.space_id||JSON.stringify(prior.request)!==JSON.stringify(input.request))throw new HttpError(409,'同じ操作IDで条件を変更できません。');return json({booking:prior,simulation:true});}
      if(session.bookings.length>=50)throw new HttpError(422,'このページの模擬予約は50件までです。不要な予約を取り消してください。');
      const generation=session.generation;
      const result=await recommendOfficeRooms(input.request,session.bookings,today);
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
export async function handleStoredOfficeRequest(request,storage,{now=()=>new Date(),...options}={}) {
  assertSameOrigin(request);
  const path=new URL(request.url).pathname;
  const reads=['/api/office/workspace','/api/office/admin/reservations'];
  const writes=['/api/office/workspace/reset','/api/office/day-plan','/api/office/confirm','/api/office/attendance',
    '/api/office/transition','/api/office/replan','/api/office/rebook',...['create','update','delete','restore'].map(a=>'/api/office/admin/'+a)];
  if(!reads.includes(path)&&!writes.includes(path))throw new HttpError(404,'invalid_action');
  if(request.method!==(reads.includes(path)?'GET':'POST'))throw new HttpError(405,'invalid_action');
  const saved=storage.load();
  const workspace=createMeetingState({rooms:officeRooms,now,persisted:saved?.state});
  if(!saved)workspace.reset();
  const service=createOfficeService({...options,now,workspace});
  const response=await service(request);
  if(response.ok&&(!saved||request.method!=='GET')){
    if(!storage.commit(saved?.version??0,workspace.exportState()))throw new HttpError(409,'state_changed');
  }
  if(response.ok){
    const payload=await response.json();
    return json(payload.instance_id?{...payload,deployment:'cloud',workspace_scope:'browser'}:payload,response.status);
  }
  return response;
}
