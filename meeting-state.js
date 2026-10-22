import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from './http-utils.js';
import { missingFeatures } from './seat-comfort.js';
import { clock, minutes, overlap, sameMeeting, validateDayPlan, activityIssues, normalizeDayPlanClarifications } from './day-plan.js';

const jstDate = now => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(now);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v);
const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const inputSchema = z.object({
  title:z.string().trim().min(1).max(160),date:dateSchema,time:timeSchema,
  duration:z.number().int().min(15).max(480),people:z.number().int().min(1).max(100),
  space_id:z.string().max(100),booked_by:z.string().trim().min(1).max(80),
  assigned_to:z.enum(['A','other']),features:z.array(z.string().min(1).max(60)).max(12)
}).strict();
const mutationSchema = z.object({
  operation_id:z.string().uuid(),meeting_id:z.string().min(1).max(160).optional(),
  expected_version:z.number().int().positive().optional(),confirmed:z.literal(true),
  data:inputSchema.optional()
}).strict();
const clearRangeSchema=z.object({range:z.enum(['all','today','hour','week','month'])}).strict();
const clearInputSchema=z.object({preview_id:z.string().uuid(),operation_id:z.string().uuid(),confirmed:z.literal(true)}).strict();
const jstTimestamp=value=>new Date(value+9*3600000).toISOString().replace('Z','+09:00');
function clearWindow(range,instant){
  const at=instant.getTime();
  if(range==='all')return {start:null,end:null,reference_at:jstTimestamp(at)};
  if(range==='hour')return {start:at-3600000,end:at+1,reference_at:jstTimestamp(at)};
  const midnight=Date.parse(jstDate(instant)+'T00:00:00+09:00');
  const days={today:1,week:7,month:30}[range];
  return {start:midnight-(days-1)*86400000,end:midnight+86400000,reference_at:jstTimestamp(at)};
}
function matchesClearWindow(record,window){
  if(window.start===null)return true;
  const at=Date.parse(record.date+'T'+record.time+':00+09:00');
  return at>=window.start&&at<window.end;
}

export function seededReservations(today, rooms) {
  const result=[];
  for(let day=0;day<=30;day++){
    const date=new Date(Date.parse(today)+day*86400000).toISOString().slice(0,10);
    for(const [space_id,start,end] of [['office-c04',840,900],['office-m02',660,720],['office-f12',600,660]]){
      const room=rooms.find(r=>r.id===space_id);
      result.push({id:'seed-'+date+'-'+space_id,space_id,name:room.name,date,start,end,time:clock(start),end_time:clock(end),
        title:room.name+' / Demo reservation',booked_by:'System',assigned_to:'other',source:'preset',version:1,deleted:false,
        people:1,participants:[],status:'reserved',actual_start:null,actual_end:null,
        request:{date,time:clock(start),duration:end-start,people:1,kind:room.kind,features:[]}});
    }
  }
  return result;
}

// This is one local synthetic workspace. A role switch is not production authentication.
export function createMeetingState({rooms, now=()=>new Date(),persisted}={}) {
  if(persisted&&(persisted.schema_version!==1||!Array.isArray(persisted.records)||!Array.isArray(persisted.plans)))throw new Error('Unsupported workspace state');
  const instanceId=persisted?.instance_id??randomUUID();
  const records=structuredClone(persisted?.records??[]),events=structuredClone(persisted?.events??[]);
  const plans=new Map(structuredClone(persisted?.plans??[])),seedChanges=new Map(structuredClone(persisted?.seed_changes??[])),operations=new Map(structuredClone(persisted?.operations??[]));
  const clearPreviews=new Map(structuredClone(persisted?.clear_previews??[]));
  let revision=persisted?.revision??0;
  let resetGeneration=persisted?.reset_generation??0,includePresets=persisted?.include_presets??true;
  let demoClock=structuredClone(persisted?.clock??{date:jstDate(now()),time:'09:00'});
  const referenceDate = () => [jstDate(now()),demoClock.date].sort().at(-1);
  const advanceClock = (date,time) => {if(date+' '+time>demoClock.date+' '+demoClock.time)demoClock={date,time};};
  const assertCapacity = () => {if(records.filter(isCurrent).length>=200)throw new HttpError(422,'workspace_limit');};
  const assertFuture = data => {if(data.date+' '+data.time<referenceDate()+' '+(referenceDate()===demoClock.date?demoClock.time:'09:00'))throw new HttpError(409,'past_time');};
  const reservations = () => {
    const all=new Map((includePresets?seededReservations(jstDate(now()),rooms):[]).map(record=>[record.id,record]));
    for(const [id,record] of seedChanges)all.set(id,record);
    return [...all.values(),...records.filter(r=>r.source!=='attendance')];
  };
  const ownMeetings = () => records.filter(r=>r.assigned_to==='A'&&!r.deleted);
  const isCurrent = record => !record.deleted&&!record.replaced_by&&['reserved','in_progress'].includes(record.status)
    &&(record.status==='in_progress'||record.date+' '+record.time>=referenceDate()+' '+(referenceDate()===demoClock.date?demoClock.time:'09:00'));
  function replacementFor(record){
    if(record.replaced_by)return record.replaced_by;
    // Older local records have no lineage. An exact later active equivalent is
    // sufficient to suppress a redundant retry; never merge or delete history.
    if(record.status!=='cancelled')return null;
    const activity={...record.request,title:record.title,type:record.request.kind==='desk'?'desk':'meeting',participants:record.participants??[]};
    const index=records.findIndex(r=>r.id===record.id);
    return records.slice(index+1).find(r=>r.assigned_to==='A'&&isCurrent(r)&&(r.source==='attendance')===(record.source==='attendance')
      &&sameMeeting(activity,r))?.id??null;
  }
  function linkReplacement(previous,next){
    if(!previous||previous.replaced_by===next.id)return;
    previous.replaced_by=next.id;event('rebooked',previous);
  }
  const occupied = all => all.filter(r=>!r.deleted&&r.status!=='cancelled').map(r=>({...r,end:r.status==='completed'?minutes(r.actual_end):r.end}));
  const calendar = () => structuredClone(occupied([...reservations(),...records.filter(r=>r.source==='attendance'&&r.status==='in_progress')]));
  const snapshot = () => {
    const own=records.filter(r=>r.assigned_to==='A'&&!(r.deleted&&r.bulk_cleared)).map(r=>({...r,replacement_id:replacementFor(r)}));
    return structuredClone({instance_id:instanceId,revision,reset_generation:resetGeneration,clock:demoClock,rooms,meetings:ownMeetings(),
      current_meetings:own.filter(isCurrent),meeting_history:own.filter(r=>!isCurrent(r)),
      reservations:reservations(),events:events.slice(-100),simulation:true,admin_crud:true});
  };
  function reset(){
    records.length=0;events.length=0;plans.clear();seedChanges.clear();operations.clear();clearPreviews.clear();
    includePresets=false;resetGeneration++;revision++;
    demoClock={date:jstDate(now()),time:'09:00'};
    return snapshot();
  }
  function event(type,record){
    revision++;record.version=(record.version??0)+1;
    events.push({id:randomUUID(),type,meeting_id:record.id,room:record.name,title:record.title,at:now().toISOString(),demo_date:demoClock.date,demo_time:demoClock.time});
    if(events.length>200)events.shift();
  }
  function savePlan(plan){
    for(const [id,entry] of plans)if(now().getTime()-entry.created>=30*60000)plans.delete(id);
    if(plans.size>=30)plans.delete(plans.keys().next().value);
    const id=randomUUID();plans.set(id,{...structuredClone(plan),created:now().getTime()});return id;
  }
  function getPlan(id){
    const plan=plans.get(id);
    if(!plan||now().getTime()-plan.created>=30*60000){plans.delete(id);throw new HttpError(409,'plan_expired');}
    return structuredClone(plan);
  }
  async function confirm({plan_id,proposal_id,space_id,confirmed},recommend,today){
    if(confirmed!==true)throw new HttpError(400,'confirmation_required');
    const plan=getPlan(plan_id),proposal=plan.proposals.find(p=>p.id===proposal_id);
    if(!proposal||proposal.status!=='proposed'||!proposal.candidates.some(r=>r.id===space_id))throw new HttpError(400,'invalid_proposal');
    const prior=records.find(r=>r.proposal_id===proposal_id&&r.plan_id===plan_id);
    if(prior){
      if(prior.deleted||prior.status==='cancelled')throw new HttpError(409,'cancelled_replan');
      if(prior.space_id!==space_id)throw new HttpError(409,'changed_selection');
      return {booking:structuredClone(prior),reused:true};
    }
    const rebooking=plan.rebook_of&&records.find(r=>r.id===plan.rebook_of);
    if(plan.rebook_of){
      if(!rebooking||rebooking.deleted||rebooking.assigned_to!=='A')throw new HttpError(404,'meeting_missing');
      if(replacementFor(rebooking))throw new HttpError(409,'rebook_replaced');
      if(rebooking.status!=='cancelled'||rebooking.version!==plan.rebook_version)throw new HttpError(409,'record_changed');
    }
    const duplicate=!proposal.distinct&&ownMeetings().find(r=>sameMeeting(proposal.activity,r));
    if(duplicate){linkReplacement(rebooking,duplicate);return {booking:structuredClone(duplicate),reused:true};}
    assertCapacity();
    const currentRevision=revision,request=proposal.request;
    assertFuture(request);
    const interval={date:request.date,start:minutes(request.time),end:minutes(request.time)+request.duration};
    const blocking=occupied(ownMeetings());
    if(blocking.some(r=>overlap(interval,r)))throw new HttpError(409,'personal_conflict');
    const result=await recommend(request,calendar(),today);
    if(revision!==currentRevision)throw new HttpError(409,'state_changed');
    if(!result.candidates.some(r=>r.id===space_id))throw new HttpError(409,'room_conflict');
    const room=rooms.find(r=>r.id===space_id);
    const booking={...interval,id:randomUUID(),plan_id,proposal_id,space_id,name:room.name,title:proposal.activity.title,
      participants:proposal.activity.participants,people:request.people,time:request.time,end_time:clock(interval.end),request,
      status:'reserved',actual_start:null,actual_end:null,assigned_to:'A',booked_by:'Employee A',source:'employee',version:0,deleted:false,
      ...(rebooking?{rebooked_from:rebooking.id}:{})};
    records.push(booking);event('reserved',booking);linkReplacement(rebooking,booking);return {booking:structuredClone(booking),reused:false};
  }
  function attend(raw) {
    const schema=z.object({plan_id:z.string().min(1).optional(),proposal_id:z.string().min(1).optional(),
      meeting_id:z.string().min(1).optional(),space_id:z.string().min(1).max(100),time:timeSchema}).strict();
    const parsed=schema.safeParse(raw);
    if(!parsed.success)throw new HttpError(400,'invalid_attendance');
    const input=parsed.data;
    let activity,blocks,plan_id,proposal_id,prior,rebooking;
    if(input.meeting_id){
      if(input.plan_id||input.proposal_id)throw new HttpError(400,'invalid_attendance');
      const previous=ownMeetings().find(r=>r.id===input.meeting_id);
      if(!previous||previous.source!=='attendance')throw new HttpError(404,'meeting_missing');
      if(previous.status!=='cancelled')throw new HttpError(409,'invalid_transition');
      activity=previous.attendance_activity;blocks=previous.attendance_blocks;
      plan_id=previous.plan_id;proposal_id=previous.proposal_id;
      prior=records.find(r=>r.attendance_parent===previous.id);
      rebooking=previous;
    }else{
      const plan=getPlan(input.plan_id),proposal=plan.proposals.find(p=>p.id===input.proposal_id);
      if(!proposal||proposal.activity.type!=='meeting'||proposal.status==='duplicate_in_plan')throw new HttpError(400,'invalid_proposal');
      activity=proposal.activity;blocks=plan.proposals.filter(p=>p.activity.type!=='meeting').map(p=>p.activity);
      plan_id=input.plan_id;proposal_id=input.proposal_id;
      prior=records.find(r=>r.plan_id===plan_id&&r.proposal_id===proposal_id);
    }
    if(prior){
      if(prior.deleted||prior.status==='cancelled')throw new HttpError(409,'cancelled_replan');
      if(prior.space_id!==input.space_id||prior.time!==input.time)throw new HttpError(409,'changed_selection');
      return {meeting:structuredClone(prior),reused:true};
    }
    if(rebooking&&replacementFor(rebooking))throw new HttpError(409,'rebook_replaced');
    const today=referenceDate();
    const checked=normalizeDayPlanClarifications(validateDayPlan({activities:[{...activity,time:input.time}],questions:[]},today)).activities[0];
    if(activityIssues(checked).length||blocks.some(b=>activityIssues(b).length))throw new HttpError(400,'attendance_conditions');
    const data=checkedData({title:checked.title,date:checked.date,time:checked.time,duration:checked.duration,
      people:checked.people,features:checked.features,space_id:input.space_id,booked_by:'Other organiser (unverified)',assigned_to:'A'});
    if(data.request.kind!=='meeting')throw new HttpError(400,'invalid_room');
    if(activity.time&&activity.time!==input.time||activity.window_start&&input.time<activity.window_start
      ||activity.window_end&&data.end_time>activity.window_end)throw new HttpError(400,'invalid_window');
    if(blocks.some(b=>overlap(data,{date:b.date,start:minutes(b.time??b.window_start),end:b.time?minutes(b.time)+b.duration:minutes(b.window_end)})))throw new HttpError(409,'personal_conflict');
    const duplicate=ownMeetings().find(r=>sameMeeting(checked,r));
    if(duplicate){linkReplacement(rebooking,duplicate);return {meeting:structuredClone(duplicate),reused:true};}
    if(occupied(ownMeetings()).some(r=>overlap(data,r)))throw new HttpError(409,'personal_conflict');
    assertCapacity();
    const record={...data,id:randomUUID(),plan_id,proposal_id,participants:checked.participants,
      source:'attendance',booking_required:false,status:'reserved',actual_start:null,actual_end:null,version:0,deleted:false,
      attendance_activity:structuredClone(activity),attendance_blocks:structuredClone(blocks),attendance_parent:input.meeting_id??null};
    records.push(record);event('attendance_registered',record);linkReplacement(rebooking,record);
    return {meeting:structuredClone(record),reused:false};
  }
  function transition(id,action,endTime){
    const record=ownMeetings().find(r=>r.id===id);
    if(!record)throw new HttpError(404,'meeting_missing');
    if(action==='start'){
      if(record.status==='in_progress')return snapshot();
      if(record.status!=='reserved')throw new HttpError(409,'invalid_transition');
      if(ownMeetings().some(r=>r.status==='in_progress'))throw new HttpError(409,'already_in_meeting');
      assertFuture(record);
      record.status='in_progress';record.actual_start=record.time;
      advanceClock(record.date,record.time);event(record.source==='attendance'?'attendance_started':'started',record);
    }else if(action==='finish'){
      if(record.status==='completed')return snapshot();
      if(record.status!=='in_progress')throw new HttpError(409,'invalid_transition');
      const end=endTime??record.end_time;
      if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(end)||end<=record.actual_start||end>record.end_time)throw new HttpError(400,'invalid_end');
      record.status='completed';record.actual_end=end;advanceClock(record.date,end);event(record.source==='attendance'?'attendance_completed':'completed',record);
    }else if(action==='cancel'){
      if(record.status==='cancelled')return snapshot();
      if(record.status!=='reserved')throw new HttpError(409,'invalid_transition');
      record.status='cancelled';event(record.source==='attendance'?'attendance_cancelled':'cancelled',record);
    }else throw new HttpError(400,'invalid_action');
    return snapshot();
  }
  function queryReservations(input={}){
    const schema=z.object({start_date:dateSchema.optional(),end_date:dateSchema.optional(),space_id:z.string().max(100).optional(),
      state:z.enum(['all','not_deleted','reserved','attending','in_progress','completed','cancelled','deleted']).default('all'),query:z.string().max(160).default(''),
      offset:z.coerce.number().int().min(0).max(100000).default(0),limit:z.coerce.number().int().min(1).max(200).default(200)}).strict();
    const parsed=schema.safeParse(input);if(!parsed.success)throw new HttpError(400,'invalid_admin_query');
    const args=parsed.data,start=args.start_date??'0000-01-01',end=args.end_date??'9999-12-31';
    if(start>end)throw new HttpError(400,'invalid_window');
    if(args.space_id&&!rooms.some(r=>r.id===args.space_id))throw new HttpError(400,'invalid_room');
    const q=args.query.toLocaleLowerCase();
    const rows=[...reservations(),...records.filter(r=>r.source==='attendance')].filter(r=>r.date>=start&&r.date<=end
      &&(args.state==='all'||(args.state==='not_deleted'?!r.deleted:args.state==='deleted'?r.deleted:!r.deleted&&(args.state==='attending'&&r.source==='attendance'&&r.status==='reserved'
        ||r.status===args.state&&(args.state!=='reserved'||r.source!=='attendance'))))
      &&(!args.space_id||r.space_id===args.space_id)
      &&(!q||[r.title,r.name,r.booked_by].some(value=>value.toLocaleLowerCase().includes(q))))
      .sort((a,b)=>a.date.localeCompare(b.date)||a.time.localeCompare(b.time)||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
    return structuredClone({items:rows.slice(args.offset,args.offset+args.limit),total:rows.length,revision,simulation:true,
      counts:{total:rows.length,attendance:rows.filter(r=>!r.deleted&&r.source==='attendance').length,deleted:rows.filter(r=>r.deleted).length,reserved:rows.filter(r=>!r.deleted&&r.status==='reserved'&&r.source!=='attendance').length,in_progress:rows.filter(r=>!r.deleted&&r.status==='in_progress').length,
        completed:rows.filter(r=>!r.deleted&&r.status==='completed').length,cancelled:rows.filter(r=>!r.deleted&&r.status==='cancelled').length}});
  }
  const allAdminRecords=()=>[...reservations(),...records.filter(r=>r.source==='attendance')];
  const visibleDeletedHistory=record=>record.deleted&&record.assigned_to==='A'&&!record.bulk_cleared;
  const clearTargets=window=>allAdminRecords().filter(r=>(!r.deleted||visibleDeletedHistory(r))&&matchesClearWindow(r,window));
  const targetVersions=rows=>rows.map(r=>[r.id,r.version??0]).sort((a,b)=>a[0].localeCompare(b[0]));
  function previewClear(raw){
    const parsed=clearRangeSchema.safeParse(raw);
    if(!parsed.success)throw new HttpError(400,'invalid_clear_range');
    const instant=now(),window=clearWindow(parsed.data.range,instant),targets=clearTargets(window);
    for(const [id,preview] of clearPreviews)if(preview.expires<=instant.getTime())clearPreviews.delete(id);
    if(clearPreviews.size>=5)clearPreviews.delete(clearPreviews.keys().next().value);
    const id=randomUUID(),preview={range:parsed.data.range,window,revision,targets:targetVersions(targets),expires:instant.getTime()+300000};
    clearPreviews.set(id,preview);
    return {preview_id:id,range:preview.range,count:targets.length,active_count:targets.filter(r=>r.status==='in_progress').length,
      preset_count:targets.filter(r=>r.source==='preset').length,attendance_count:targets.filter(r=>r.source==='attendance').length,
      history_count:targets.filter(visibleDeletedHistory).length,
      skipped_deleted:allAdminRecords().filter(r=>r.deleted&&!visibleDeletedHistory(r)&&matchesClearWindow(r,window)).length,
      reference_at:window.reference_at,start_at:window.start===null?null:jstTimestamp(window.start),end_at:window.end===null?null:jstTimestamp(window.end),
      revision,simulation:true};
  }
  function clearRecords(raw){
    const parsed=clearInputSchema.safeParse(raw);
    if(!parsed.success)throw new HttpError(400,'invalid_clear_input');
    const input=parsed.data,fingerprint=JSON.stringify({action:'bulk_clear',...input});
    const previous=operations.get(input.operation_id);
    if(previous){
      if(previous.fingerprint!==fingerprint)throw new HttpError(409,'operation_reused');
      return structuredClone(previous.result);
    }
    const preview=clearPreviews.get(input.preview_id);
    if(!preview||preview.expires<=now().getTime())throw new HttpError(409,'clear_preview_expired');
    const targets=clearTargets(preview.window),historyCount=targets.filter(visibleDeletedHistory).length;
    if(preview.revision!==revision||JSON.stringify(targetVersions(targets))!==JSON.stringify(preview.targets))throw new HttpError(409,'clear_targets_changed');
    // Validate the whole preview before making any synchronous mutations. Preserve
    // source records and event history; deleted records remain individually restorable.
    for(const record of targets){
      const updated={...record,deleted:true,bulk_cleared:true};
      if(record.status==='in_progress'){
        updated.status='completed';updated.actual_end=record.end_time;advanceClock(record.date,record.end_time);
      }
      if(record.source==='preset')seedChanges.set(record.id,updated);
      else records.splice(records.findIndex(r=>r.id===record.id),1,updated);
      event('admin_delete',updated);
    }
    // An explicit all-record clear must not seed new bookings on the next day.
    if(preview.range==='all'&&includePresets){includePresets=false;revision++;}
    clearPreviews.delete(input.preview_id);
    const result={deleted_count:targets.length,history_count:historyCount,range:preview.range,revision,simulation:true};
    operations.set(input.operation_id,{fingerprint,result});
    if(operations.size>500)operations.delete(operations.keys().next().value);
    return structuredClone(result);
  }
  function parseMutation(input){
    const result=mutationSchema.safeParse(input);
    if(!result.success)throw new HttpError(400,'invalid_admin_input');
    return result.data;
  }
  function checkedData(data,{historical=false}={}){
    if(!data)throw new HttpError(400,'invalid_admin_input');
    const today=referenceDate(),last=new Date(Date.parse(today)+30*86400000).toISOString().slice(0,10);
    if(!historical&&(data.date<today||data.date>last))throw new HttpError(400,'date_range');
    const start=minutes(data.time),end=start+data.duration;
    if(start<540||end>1080)throw new HttpError(400,'hours');
    if(!historical)assertFuture(data);
    const room=rooms.find(r=>r.id===data.space_id);if(!room)throw new HttpError(400,'invalid_room');
    if(data.people>room.capacity)throw new HttpError(409,'capacity_exceeded');
    if(missingFeatures(room,data.features).length)throw new HttpError(409,'equipment_missing');
    return {...data,start,end,end_time:clock(end),name:room.name,
      request:{date:data.date,time:data.time,duration:data.duration,people:data.people,kind:room.kind,features:data.features}};
  }
  async function checkAvailability(candidate,excludeId,recommend){
    const all=calendar().filter(r=>r.id!==excludeId);
    if(candidate.assigned_to==='A'&&occupied(ownMeetings()).some(r=>r.id!==excludeId&&overlap(candidate,r)))throw new HttpError(409,'personal_conflict');
    if(all.some(r=>r.space_id===candidate.space_id&&overlap(candidate,r)))throw new HttpError(409,'room_conflict');
    const result=await recommend(candidate.request,all,referenceDate());
    if(!result.candidates.some(r=>r.id===candidate.space_id))throw new HttpError(409,'room_conflict');
  }
  async function adminMutate(action,raw,recommend){
    if(!['create','update','delete','restore','finish','cancel'].includes(action))throw new HttpError(400,'invalid_action');
    const input=parseMutation(raw),fingerprint=JSON.stringify({action,...input});
    const previous=operations.get(input.operation_id);
    if(previous){
      if(previous.fingerprint!==fingerprint)throw new HttpError(409,'operation_reused');
      return structuredClone(previous.result);
    }
    let record=input.meeting_id&&[...reservations(),...records.filter(r=>r.source==='attendance')].find(r=>r.id===input.meeting_id);
    if(action==='create'){
      if(input.meeting_id||input.expected_version!==undefined)throw new HttpError(400,'invalid_admin_input');
      assertCapacity();
    }else{
      if(!record){
        throw new HttpError(404,'meeting_missing');
      }
      if(input.expected_version!==record.version)throw new HttpError(409,'record_changed');
      if(record.status==='in_progress'&&action==='update')throw new HttpError(409,'active_readonly');
      if(action==='update'&&record.deleted)throw new HttpError(409,'record_readonly');
      if(action==='finish'&&(record.deleted||record.status!=='in_progress')||action==='cancel'&&(record.deleted||record.status!=='reserved'))throw new HttpError(409,'invalid_transition');
      if(action==='delete'&&record.deleted||action==='restore'&&!record.deleted)throw new HttpError(409,'invalid_transition');
    }
    const currentRevision=revision;
    let updated;
    if(action==='create'||action==='update'){
      const historical=record&&['completed','cancelled'].includes(record.status);
      const data=checkedData(input.data,{historical});
      if(historical&&(data.date!==record.date||data.time!==record.time||data.duration!==record.request.duration||data.space_id!==record.space_id))throw new HttpError(409,'history_schedule');
      if(record?.source==='attendance'&&data.assigned_to!=='A')throw new HttpError(400,'attendance_owner');
      if(record?.source==='preset'&&data.assigned_to!=='other')throw new HttpError(400,'preset_owner');
      updated={...(record??{}),...data,id:record?.id??randomUUID(),source:record?.source??'admin',version:record?.version??0,
        participants:record?.participants??[],status:record?.status??'reserved',actual_start:record?.actual_start??null,actual_end:record?.actual_end??null,deleted:false};
      if(updated.source==='attendance')updated.attendance_activity={...updated.attendance_activity,title:updated.title,date:updated.date,time:updated.time,duration:updated.request.duration,people:updated.people,features:updated.request.features};
      if(updated.status==='reserved'){
        if(updated.source==='attendance'){
          if(updated.assigned_to!=='A')throw new HttpError(400,'attendance_owner');
          if(occupied(ownMeetings()).some(r=>r.id!==updated.id&&overlap(updated,r)))throw new HttpError(409,'personal_conflict');
        }else await checkAvailability(updated,record?.id,recommend);
      }
    }else{
      if(input.data!==undefined)throw new HttpError(400,'invalid_admin_input');
      updated={...record,deleted:action==='delete'?true:action==='restore'?false:record.deleted};
      if(action==='restore')updated.bulk_cleared=false;
      if(action==='cancel')updated.status='cancelled';
      if(action==='finish'||action==='delete'&&record.status==='in_progress'){
        updated.status='completed';updated.actual_end=record.end_time;advanceClock(record.date,record.end_time);
      }
      if(action==='restore'&&updated.status==='reserved'){
        const old=updated.date+' '+updated.time<referenceDate()+' '+(referenceDate()===demoClock.date?demoClock.time:'09:00');
        if(old){updated.status='cancelled';}else{
          assertCapacity();
          checkedData({...updated.request,space_id:updated.space_id,title:updated.title,booked_by:updated.booked_by,assigned_to:updated.assigned_to});
          if(updated.source==='attendance'){
            if(occupied(ownMeetings()).some(r=>r.id!==updated.id&&overlap(updated,r)))throw new HttpError(409,'personal_conflict');
          }else await checkAvailability(updated,record.id,recommend);
        }
      }
    }
    if(revision!==currentRevision)throw new HttpError(409,'state_changed');
    if(updated.source==='preset')seedChanges.set(updated.id,updated);
    else if(record)records.splice(records.findIndex(r=>r.id===record.id),1,updated);
    else records.push(updated);
    event('admin_'+action,updated);
    const result={record:structuredClone(updated),revision,simulation:true};
    operations.set(input.operation_id,{fingerprint,result});
    if(operations.size>500)operations.delete(operations.keys().next().value);
    return structuredClone(result);
  }
  function exportState(){
    // Persist only state needed for later actions; MCP traces remain in the response, not storage.
    const storedPlans=[...plans].filter(([,p])=>now().getTime()-p.created<30*60000).map(([id,p])=>[id,{...p,proposals:p.proposals.map(({trace,excluded,...proposal})=>proposal)}]);
    const state=structuredClone({schema_version:1,instance_id:instanceId,revision,reset_generation:resetGeneration,
      include_presets:includePresets,clock:demoClock,records,events,plans:storedPlans,seed_changes:[...seedChanges],operations:[...operations],
      clear_previews:[...clearPreviews].filter(([,p])=>p.expires>now().getTime())});
    while(JSON.stringify(state).length>1500000&&state.plans.length>1)state.plans.shift();
    if(new TextEncoder().encode(JSON.stringify(state)).byteLength>1800000)throw new HttpError(422,'workspace_limit');
    return state;
  }
  return {snapshot,referenceDate,calendar,savePlan,getPlan,confirm,attend,transition,queryReservations,previewClear,clearRecords,adminMutate,reset,exportState};
}
