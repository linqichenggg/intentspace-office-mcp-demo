import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfficeService, officeRooms, recommendOfficeRooms } from './office-service.js';
import { createMeetingState } from './meeting-state.js';
import { allocateDayPlan } from './day-plan.js';
import { errorResponse } from './http-utils.js';
import { createDataset } from './queries.js';
import { randomUUID } from 'node:crypto';

const today='2026-10-20',instant=()=>new Date(today+'T01:00:00Z');
const activity={type:'meeting',title:'Project review',date:today,time:'13:00',window_start:null,window_end:null,duration:45,people:4,features:['monitor'],participants:[],existing_id:null,unclear:[]};
async function prepared(store,changes={}){
  const plan=await allocateDayPlan({activities:[{...activity,...changes}],questions:[]},store.snapshot().meetings,today,recommendOfficeRooms);
  const id=store.savePlan(plan);
  return {plan_id:id,proposal_id:plan.proposals[0].id,space_id:plan.proposals[0].candidates[0]?.id,confirmed:true};
}
function api(dayParser,options={}){
  const handle=createOfficeService({now:instant,...(dayParser?{dayParser}:{}),...options});
  return async(path,body,headers={})=>{
    let response;
    try{response=await handle(new Request('http://demo.test/api/office/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));}
    catch(error){response=errorResponse(error);}
    return {status:response.status,body:await response.json()};
  };
}

async function attendanceInput(store,changes={}){
  const value={...activity,time:'14:00',features:['whiteboard'],...changes};
  const plan=await allocateDayPlan({activities:[value],questions:[]},store.snapshot().meetings,today,recommendOfficeRooms);
  return {plan_id:store.savePlan(plan),proposal_id:plan.proposals[0].id,space_id:'office-c04',time:value.time??'14:00'};
}

test('参加登録：既存予約の部屋を指定しても新予約を作らず、開始・終了と管理表示を同期',async()=>{
  const store=createMeetingState({rooms:officeRooms,now:instant}),before=store.snapshot().reservations;
  const input=await attendanceInput(store),result=store.attend(input),id=result.meeting.id;
  assert.equal(result.meeting.source,'attendance');assert.equal(result.meeting.booking_required,false);
  assert.equal(store.attend(input).meeting.id,id);assert.equal(store.snapshot().meetings.length,1);
  assert.deepEqual(store.snapshot().reservations,before);
  assert.equal(store.calendar().some(r=>r.id===id),false);
  const listed=store.queryReservations({state:'attending'});assert.equal(listed.total,1);assert.equal(listed.counts.reserved,0);
  assert.equal(store.queryReservations({state:'reserved'}).items.some(r=>r.id===id),false);
  store.transition(id,'start');assert.equal(store.snapshot().meetings[0].status,'in_progress');
  assert.ok(store.calendar().some(r=>r.id===id));
  assert.equal(store.queryReservations({state:'in_progress'}).items[0].id,id);
  assert.throws(()=>store.transition(id,'cancel'),/invalid_transition/);
  store.transition(id,'finish');assert.equal(store.snapshot().meetings[0].status,'completed');
  assert.equal(store.calendar().some(r=>r.id===id),false);assert.deepEqual(store.snapshot().reservations,before);
  assert.deepEqual(store.snapshot().events.map(e=>e.type),['attendance_registered','attendance_started','attendance_completed']);
  await assert.rejects(store.adminMutate('delete',{operation_id:randomUUID(),meeting_id:id,expected_version:3,confirmed:true},recommendOfficeRooms),/attendance_readonly/);
  store.reset();assert.deepEqual(store.snapshot().meetings,[]);assert.deepEqual(store.snapshot().reservations,[]);
});

test('参加取消：他人の予約を保持し、提案失効後も再登録を別IDで続けられる',async()=>{
  let time=instant();const store=createMeetingState({rooms:officeRooms,now:()=>time}),before=store.snapshot().reservations;
  const input=await attendanceInput(store),first=store.attend(input).meeting;
  store.transition(first.id,'cancel');assert.throws(()=>store.attend(input),/cancelled_replan/);
  time=new Date(time.getTime()+31*60000);
  const nextInput={meeting_id:first.id,space_id:'office-c04',time:'14:00'};
  const second=store.attend(nextInput).meeting;assert.notEqual(first.id,second.id);
  assert.equal(store.attend(nextInput).meeting.id,second.id);
  store.transition(second.id,'cancel');const third=store.attend({meeting_id:second.id,space_id:'office-c04',time:'14:00'}).meeting;
  assert.notEqual(second.id,third.id);assert.deepEqual(store.snapshot().reservations,before);
  assert.throws(()=>store.attend({meeting_id:third.id,space_id:'office-c04',time:'14:00'}),/invalid_transition/);
});

test('参加条件：部屋・人数・設備・日付・指定時間・不明条件と本人の予定を検査',async()=>{
  const store=createMeetingState({rooms:officeRooms,now:instant});
  const input=await attendanceInput(store);
  for(const [changes,error] of [[{space_id:'unknown'},'invalid_room'],[{space_id:'office-f12'},'capacity_exceeded'],
    [{space_id:'office-m02'},'equipment_missing'],[{time:'18:00'},'hours'],[{time:'15:00'},'invalid_window'],[{time:'bad'},'invalid_attendance']]){
    assert.throws(()=>store.attend({...input,...changes}),new RegExp(error));
  }
  assert.throws(()=>store.attend({...input,unexpected:true}),/invalid_attendance/);
  const missing=await attendanceInput(store,{people:null});assert.throws(()=>store.attend(missing),/attendance_conditions/);
  const unclear=await attendanceInput(store,{unclear:['機密区分を確認してください。']});assert.throws(()=>store.attend(unclear),/attendance_conditions/);
  const draft={...activity,time:null,window_start:'13:00',window_end:'15:00',duration:30};
  const busy={...draft,type:'focus',title:'Focus',people:1,time:null,features:[],duration:120};
  const plan=await allocateDayPlan({activities:[busy,draft],questions:[]},[],today,recommendOfficeRooms);
  assert.throws(()=>store.attend({plan_id:store.savePlan(plan),proposal_id:plan.proposals[1].id,space_id:'office-c04',time:'13:30'}),/personal_conflict/);
  const first=store.attend(input).meeting;
  const overlapInput=await attendanceInput(store,{title:'Another meeting'});
  assert.throws(()=>store.attend(overlapInput),/personal_conflict/);
  const duplicate=await prepared(store,{time:'14:00',features:['whiteboard']});
  assert.equal(store.getPlan(duplicate.plan_id).proposals[0].status,'existing');
  assert.equal(store.getPlan(duplicate.plan_id).proposals[0].existing.id,first.id);
  const independent=createMeetingState({rooms:officeRooms,now:instant});independent.reset();
  const pending=await prepared(independent,{time:'13:00'});
  const attended=independent.attend(await attendanceInput(independent,{time:'13:00',features:['monitor']})).meeting;
  assert.equal((await independent.confirm(pending,recommendOfficeRooms,today)).booking.id,attended.id);
  assert.equal(independent.snapshot().reservations.length,0);
  const later=createMeetingState({rooms:officeRooms,now:()=>new Date('2026-11-21T01:00:00Z')});
  const oldInput=await attendanceInput(later);
  assert.throws(()=>later.attend(oldInput),/date_range/);
});

test('参加HTTP：予約なし・本人の重複防止・管理変更制限・Originと不正入力',async()=>{
  const call=api();
  const plan=(await call('day-plan',{mode:'rules',message:'Today 14:00 meeting for 4 people, 30 minutes, whiteboard'})).body;
  assert.equal(plan.proposals[0].status,'no_slot');
  const input={plan_id:plan.plan_id,proposal_id:plan.proposals[0].id,space_id:'office-c04',time:'14:00'};
  assert.equal((await call('attendance',input,{Origin:'https://evil.test'})).status,403);
  assert.equal((await call('attendance',{...input,space_id:''})).status,400);
  const result=await call('attendance',input);assert.equal(result.status,200);
  const id=result.body.meeting.id;
  assert.equal((await call('workspace')).body.reservations.length,93);
  assert.equal((await call('admin/reservations?state=attending')).body.total,1);
  const data={title:'Owned meeting',date:today,time:'14:00',duration:30,people:2,space_id:'office-m02',features:[],booked_by:'A',assigned_to:'A'};
  const conflict=await call('admin/create',{operation_id:randomUUID(),confirmed:true,data});
  assert.equal(conflict.status,409);assert.equal(conflict.body.error,'personal_conflict');
  const readonly=await call('admin/delete',{operation_id:randomUUID(),meeting_id:id,expected_version:1,confirmed:true});
  assert.equal(readonly.status,409);assert.equal(readonly.body.error,'attendance_readonly');
  await call('transition',{meeting_id:id,action:'cancel'});
  assert.equal((await call('rebook',{meeting_id:id})).body.error,'attendance_readonly');
  assert.equal((await call('attendance',{meeting_id:id,space_id:'office-c04',time:'14:00'})).status,200);
});

test('共有ワークスペース：予約・開始・終了・取消の状態とイベントが同期する',async()=>{
  const store=createMeetingState({rooms:officeRooms,now:instant});const input=await prepared(store);
  assert.equal(store.snapshot().meetings.length,0);
  const {booking}=await store.confirm(input,recommendOfficeRooms,today);
  assert.equal(booking.status,'reserved');assert.equal(store.snapshot().clock.time,'09:00');
  assert.equal((await store.confirm(input,recommendOfficeRooms,today)).reused,true);
  let state=store.transition(booking.id,'start');assert.equal(state.meetings[0].status,'in_progress');assert.equal(state.clock.time,'13:00');
  assert.throws(()=>store.transition(booking.id,'cancel'),/invalid_transition/);
  state=store.transition(booking.id,'finish');assert.equal(state.meetings[0].status,'completed');assert.equal(state.clock.time,'13:45');
  assert.deepEqual(state.events.map(e=>e.type),['reserved','started','completed']);
  assert.throws(()=>store.transition(booking.id,'start'),/invalid_transition/);
  state.meetings[0].title='tampered';assert.equal(store.snapshot().meetings[0].title,'Project review');
});

test('取消は再検索で解放し、同じ古い操作から再予約しない',async()=>{
  const store=createMeetingState({rooms:officeRooms,now:instant}),input=await prepared(store);
  const {booking}=await store.confirm(input,recommendOfficeRooms,today);
  store.transition(booking.id,'cancel');
  await assert.rejects(store.confirm(input,recommendOfficeRooms,today),/cancelled_replan/);
  const next=await prepared(store);assert.ok(next.space_id);
  await store.confirm(next,recommendOfficeRooms,today);assert.equal(store.snapshot().meetings.length,2);
});

test('再確認：古い提案の時間衝突・部屋差替え・未確認・不正IDを拒否',async()=>{
  const store=createMeetingState({rooms:officeRooms,now:instant});
  const first=await prepared(store),second=await prepared(store,{title:'Different discussion'});
  await assert.rejects(store.confirm({...first,confirmed:false},recommendOfficeRooms,today),/confirmation_required/);
  await assert.rejects(store.confirm({...first,space_id:'invalid'},recommendOfficeRooms,today),/invalid_proposal/);
  await store.confirm(first,recommendOfficeRooms,today);
  await assert.rejects(store.confirm(second,recommendOfficeRooms,today),/personal_conflict/);
  await assert.rejects(store.confirm({...first,space_id:'office-m02'},recommendOfficeRooms,today),/changed_selection/);
  await assert.rejects(store.confirm({...first,plan_id:'fake'},recommendOfficeRooms,today),/plan_expired/);
});

test('同時の確認は1件だけ成功、独立した提案の同一会議も増殖しない',async()=>{
  const store=createMeetingState({rooms:officeRooms,now:instant});const a=await prepared(store),b=await prepared(store);
  const both=await Promise.allSettled([store.confirm(a,recommendOfficeRooms,today),store.confirm(b,recommendOfficeRooms,today)]);
  assert.equal(both.filter(r=>r.status==='fulfilled').length,1);assert.equal(store.snapshot().meetings.length,1);
  assert.equal((await store.confirm(b,recommendOfficeRooms,today)).reused,true);
});

test('開始は一会議ずつ、早期終了時刻・提案期限・ワークスペース再起動の境界',async()=>{
  let time=instant();const store=createMeetingState({rooms:officeRooms,now:()=>time});
  const first=(await store.confirm(await prepared(store),recommendOfficeRooms,today)).booking;
  const second=(await store.confirm(await prepared(store,{title:'Other',time:'15:00'}),recommendOfficeRooms,today)).booking;
  store.transition(first.id,'start');assert.throws(()=>store.transition(second.id,'start'),/already_in_meeting/);
  assert.throws(()=>store.transition(first.id,'finish','12:00'),/invalid_end/);
  const ended=store.transition(first.id,'finish','13:30');assert.equal(ended.meetings[0].actual_end,'13:30');
  store.transition(second.id,'start');
  const expiring=await prepared(store,{title:'Tomorrow',date:'2026-10-21',time:'10:00'});
  time=new Date(time.getTime()+30*60000);
  await assert.rejects(store.confirm(expiring,recommendOfficeRooms,today),/plan_expired/);
  assert.equal(createMeetingState({rooms:officeRooms,now:instant}).snapshot().meetings.length,0);
});

test('HTTP閉ループ：ページセッション不要で共有、再入力で再利用、取消後は再提案',async()=>{
  const call=api();const message='Today 13:00 project meeting for 4 people, 45 minutes, monitor';
  const p=await call('day-plan',{message,mode:'rules',locale:'en'});assert.equal(p.status,200);
  const proposal=p.body.proposals[0];assert.equal(proposal.status,'proposed');
  const booked=await call('confirm',{plan_id:p.body.plan_id,proposal_id:proposal.id,space_id:'office-c04',confirmed:true});assert.equal(booked.status,200);
  assert.equal((await call('workspace')).body.meetings.length,1);
  assert.equal((await call('day-plan',{message,mode:'rules',locale:'en'})).body.proposals[0].status,'existing');
  await call('transition',{meeting_id:booked.body.booking.id,action:'cancel'});
  assert.equal((await call('day-plan',{message,mode:'rules',locale:'en'})).body.proposals[0].status,'proposed');
});

test('HTTP：GPTは認証必須、模擬抽出でも予約は作成しない、Origin検査',async()=>{
  let calls=0;const call=api(async()=>{calls++;return {activities:[activity],questions:[]};});
  assert.equal((await call('day-plan',{message:'Plan',mode:'gpt',model:'gpt-4.1-mini'})).status,401);
  assert.equal(calls,0);
  const parsed=await call('day-plan',{message:'Plan',mode:'gpt',model:'gpt-4.1-mini'},{Authorization:'Bearer test_key_not_real_1234567890'});
  assert.equal(parsed.body.parser,'gpt');assert.equal(calls,1);assert.equal((await call('workspace')).body.meetings.length,0);
  assert.equal((await call('transition',{action:'start',meeting_id:'missing'},{Origin:'https://evil.test'})).status,403);
  assert.equal((await call('transition',{action:'start',meeting_id:'missing'})).status,404);
});

test('HTTP：不足項目の手動補完と、疑似重複を別会議として確認する',async()=>{
  const call=api();const p=await call('day-plan',{message:'午後に会議をしたいです',mode:'rules'});
  const proposal=p.body.proposals[0];assert.equal(proposal.status,'needs_input');
  const edited=await call('replan',{plan_id:p.body.plan_id,proposal_id:proposal.id,activity:{...activity,time:null,window_start:'13:00',window_end:'16:00'}});
  assert.equal(edited.body.proposals[0].status,'proposed');
  const input={plan_id:edited.body.plan_id,proposal_id:edited.body.proposals[0].id,space_id:'office-c04',confirmed:true};
  await call('confirm',input);
  const repeated=await call('replan',{plan_id:edited.body.plan_id,proposal_id:edited.body.proposals[0].id,distinct:true});
  assert.equal(repeated.body.proposals[0].status,'proposed');assert.equal(repeated.body.proposals[0].request.time,'13:45');
});

test('模擬状態のリセットは予約・プリセット・イベント・古い提案を消去し、時計を戻す',async()=>{
  const store=createMeetingState({rooms:officeRooms,now:instant});
  const input=await prepared(store);
  const {booking}=await store.confirm(input,recommendOfficeRooms,today);
  store.transition(booking.id,'start');store.transition(booking.id,'finish');
  const revision=store.snapshot().revision;
  const state=store.reset();
  assert.equal(state.revision,revision+1);assert.equal(state.reset_generation,1);
  assert.equal(state.clock.time,'09:00');assert.equal(state.rooms.length,3);
  assert.deepEqual(state.meetings,[]);assert.deepEqual(state.reservations,[]);
  assert.deepEqual(state.events,[]);assert.deepEqual(store.calendar(),[]);
  assert.throws(()=>store.getPlan(input.plan_id),/plan_expired/);
  assert.equal(store.queryReservations().total,0);
});

test('HTTP：リセットには明示確認と同一Originが必要、消去後の14時にプリセットは復活しない',async()=>{
  const call=api();
  assert.equal((await call('workspace/reset')).status,405);
  assert.equal((await call('workspace/reset',{})).status,400);
  assert.equal((await call('workspace/reset',{confirmed:true},{Origin:'https://evil.test'})).status,403);
  assert.equal((await call('workspace')).body.reservations.length,93);
  const reset=await call('workspace/reset',{confirmed:true});
  assert.equal(reset.status,200);assert.deepEqual(reset.body.events,[]);
  assert.equal((await call('workspace')).body.reservations.length,0);
  const result=await call('day-plan',{message:'Today 14:00 project meeting for 3 people, 30 minutes, whiteboard',mode:'rules',locale:'en'});
  assert.equal(result.status,200);
  assert.equal(result.body.proposals[0].status,'proposed');
  assert.ok(result.body.proposals[0].candidates.some(r=>r.id==='office-c04'));
  const proposal=result.body.proposals[0];
  assert.equal((await call('confirm',{plan_id:result.body.plan_id,proposal_id:proposal.id,space_id:'office-c04',confirmed:true})).status,200);
  assert.equal((await call('workspace')).body.meetings.length,1);
});

test('企業データや期間未指定の空CSVは空き日程として扱わない',()=>{
  const files={'spaces.csv':'space_id\nroom','reservations.csv':'reservations_id','reservations_classified_mapping.csv':'reservations_id,category'};
  assert.throws(()=>createDataset(files,'synthetic'),/予約データが空/);
  assert.throws(()=>createDataset(files,'company',{emptyCoverage:{start:today,end:today}}),/予約データが空/);
});

const adminData={title:'Design review',date:today,time:'09:00',duration:30,people:3,space_id:'office-c04',booked_by:'Test organiser',assigned_to:'other',features:['whiteboard']};
const mutation=(data=adminData)=>({operation_id:randomUUID(),confirmed:true,data:{...data}});
const recordMutation=record=>({operation_id:randomUUID(),confirmed:true,meeting_id:record.id,expected_version:record.version});

test('管理一覧：プリセットの所有者・日付・状態・検索・ページングを確認できる',async()=>{
  const call=api();
  const list=await call('admin/reservations');assert.equal(list.status,200);assert.equal(list.body.total,3);
  assert.ok(list.body.items.every(r=>r.source==='preset'&&r.booked_by==='System'&&r.assigned_to==='other'));
  const filtered=await call('admin/reservations?space_id=office-c04&query=System&state=reserved');
  assert.equal(filtered.body.total,1);assert.equal(filtered.body.items[0].time,'14:00');
  const page=await call('admin/reservations?start_date='+today+'&end_date=2026-11-19&limit=2&offset=2');
  assert.equal(page.body.total,93);assert.equal(page.body.items.length,2);
  for(const query of ['state=bad','start_date=2026-02-30','start_date=2026-10-22&end_date=2026-10-20','limit=201','extra=x','space_id=missing'])assert.equal((await call('admin/reservations?'+query)).status,400);
});

test('管理CRUD：追加・更新・削除・復元を同じ社員カレンダーへ反映する',async()=>{
  const call=api();await call('workspace/reset',{confirmed:true});
  const created=await call('admin/create',mutation());assert.equal(created.status,200);
  let record=created.body.record;assert.equal(record.source,'admin');assert.equal(record.version,1);
  assert.equal((await call('workspace')).body.meetings.length,0);
  const message='Today 09:00 project meeting for 3 people, 30 minutes, whiteboard';
  assert.equal((await call('day-plan',{message,mode:'rules'})).body.proposals[0].status,'no_slot');
  const updated=await call('admin/update',{...recordMutation(record),data:{...adminData,time:'10:00',title:'Revised',assigned_to:'A'}});
  assert.equal(updated.status,200);record=updated.body.record;assert.equal(record.version,2);
  assert.equal((await call('workspace')).body.meetings[0].title,'Revised');
  assert.equal((await call('day-plan',{message,mode:'rules'})).body.proposals[0].status,'proposed');
  const deletion=await call('admin/delete',recordMutation(record));assert.equal(deletion.status,200);record=deletion.body.record;
  assert.equal((await call('admin/reservations')).body.total,0);
  assert.equal((await call('admin/reservations?state=deleted')).body.total,1);
  assert.equal((await call('workspace')).body.meetings.length,0);
  const restore=await call('admin/restore',recordMutation(record));assert.equal(restore.status,200);
  assert.equal((await call('workspace')).body.meetings.length,1);
  assert.deepEqual((await call('workspace')).body.events.map(e=>e.type),['admin_create','admin_update','admin_delete','admin_restore']);
});

test('管理編集：定員・設備・営業時間・日付・部屋・本人重複を検証する',async()=>{
  const call=api();await call('workspace/reset',{confirmed:true});
  for(const [change,status] of [[{people:5},409],[{features:['projector']},409],[{time:'08:00'},400],[{time:'17:45',duration:30},400],[{date:'2026-11-20'},400],[{space_id:'unknown'},400],[{title:''},400],[{unexpected:true},400]])assert.equal((await call('admin/create',mutation({...adminData,...change}))).status,status,JSON.stringify(change));
  const first=await call('admin/create',mutation({...adminData,assigned_to:'A'}));assert.equal(first.status,200);
  assert.equal((await call('admin/create',mutation({...adminData,title:'Overlap'}))).status,409);
  assert.equal((await call('admin/create',mutation({...adminData,title:'Other room',assigned_to:'A',space_id:'office-m02',features:[]}))).body.error,'personal_conflict');
  assert.equal((await call('admin/create',mutation({...adminData,title:'Different organiser',space_id:'office-m02',features:[]}))).status,200);
  assert.equal((await call('admin/update',{...recordMutation(first.body.record),data:{...adminData,title:'Same time edited',assigned_to:'A'}})).status,200);
});

test('プリセットの編集・削除が隠れた占有を解放し、復元は衝突時に拒否する',async()=>{
  const call=api();const preset=(await call('admin/reservations?space_id=office-c04')).body.items[0];
  assert.equal((await call('admin/update',{...recordMutation(preset),data:{...adminData,time:'14:00',assigned_to:'A'}})).body.error,'preset_owner');
  let response=await call('admin/update',{...recordMutation(preset),data:{...adminData,time:'15:00'}});assert.equal(response.status,200);
  const input={message:'Today 14:00 planning meeting for 3 people, 30 minutes, whiteboard',mode:'rules'};
  assert.equal((await call('day-plan',input)).body.proposals[0].status,'proposed');
  response=await call('admin/delete',recordMutation(response.body.record));assert.equal(response.status,200);
  const deleted=response.body.record;
  assert.equal((await call('admin/create',mutation({...adminData,time:'15:00'}))).status,200);
  assert.equal((await call('admin/restore',recordMutation(deleted))).body.error,'room_conflict');
});

test('管理操作：再送は冪等、古いバージョンと並行する二重予約を拒否する',async()=>{
  const call=api();await call('workspace/reset',{confirmed:true});const input=mutation();
  const first=await call('admin/create',input);assert.equal(first.status,200);
  assert.deepEqual((await call('admin/create',input)).body,first.body);
  assert.equal((await call('admin/create',{...input,data:{...adminData,title:'Changed payload'}})).body.error,'operation_reused');
  const record=first.body.record;
  assert.equal((await call('admin/update',{...recordMutation(record),data:{...adminData,title:'Changed'}})).status,200);
  assert.equal((await call('admin/delete',recordMutation(record))).body.error,'record_changed');
  const both=await Promise.all([call('admin/create',mutation({...adminData,time:'13:00'})),call('admin/create',mutation({...adminData,time:'13:00'}))]);
  assert.deepEqual(both.map(r=>r.status).sort(),[200,409]);
  assert.equal((await call('admin/create',mutation({...adminData,time:'13:30'}))).status,200);
});

test('管理操作：進行中の変更を防ぎ、終了・取消済みの編集を防ぐ',async()=>{
  const call=api();await call('workspace/reset',{confirmed:true});
  let record=(await call('admin/create',mutation({...adminData,assigned_to:'A'}))).body.record;
  let state=(await call('transition',{meeting_id:record.id,action:'start'})).body;record=state.meetings[0];
  assert.equal((await call('admin/update',{...recordMutation(record),data:adminData})).body.error,'active_readonly');
  assert.equal((await call('admin/delete',recordMutation(record))).body.error,'active_readonly');
  record=(await call('transition',{meeting_id:record.id,action:'finish'})).body.meetings[0];
  assert.equal((await call('admin/update',{...recordMutation(record),data:adminData})).body.error,'record_readonly');
  const deletion=await call('admin/delete',recordMutation(record));assert.equal(deletion.status,200);
  assert.equal((await call('admin/restore',recordMutation(deletion.body.record))).body.record.status,'completed');
  const second=(await call('admin/create',mutation({...adminData,time:'10:00',assigned_to:'A'}))).body.record;
  record=(await call('transition',{meeting_id:second.id,action:'cancel'})).body.meetings.find(r=>r.id===second.id);
  assert.equal((await call('admin/update',{...recordMutation(record),data:adminData})).body.error,'record_readonly');
});

test('管理HTTP：確認必須、異常JSON・未知の操作・他サイトを拒否する',async()=>{
  const call=api();
  assert.equal((await call('admin/create',{...mutation(),confirmed:false})).status,400);
  assert.equal((await call('admin/create',mutation(),{Origin:'https://evil.test'})).status,403);
  assert.equal((await call('admin/create')).status,405);
  assert.equal((await call('admin/reservations',{})).status,405);
  assert.equal((await call('admin/unknown',mutation())).status,400);
  const handler=createOfficeService({now:instant});
  await assert.rejects(handler(new Request('http://demo.test/api/office/admin/create',{method:'POST',body:'{bad'})),/JSON/);
});

test('空にしたカレンダー：別日に追加しても空き日をMCPで照会でき、100件超も全件検査する',async()=>{
  const call=api();await call('workspace/reset',{confirmed:true});
  assert.equal((await call('admin/create',mutation())).status,200);
  assert.equal((await call('admin/create',mutation({...adminData,date:'2026-10-21'}))).status,200);
  const bookings=Array.from({length:105},(_,i)=>({id:'page-'+i,space_id:'office-c04',date:today,start:540,end:570}));
  bookings.push({id:'last-conflict',space_id:'office-c04',date:today,start:780,end:825});
  const valid=await recommendOfficeRooms({date:today,time:'13:00',duration:45,people:3,kind:'meeting',features:['whiteboard']},bookings,today,{includeSeeded:false});
  assert.equal(valid.candidates.length,0);assert.equal(valid.trace.at(-1).arguments.offset,100);
});

test('管理者が先に確保した部屋は古い社員提案から予約できず、リセット中の書込も拒否する',async()=>{
  const call=api();await call('workspace/reset',{confirmed:true});
  const parsed=await call('day-plan',{message:'Today 09:00 project meeting for 3 people, 30 minutes, whiteboard',mode:'rules'});
  const proposal=parsed.body.proposals[0];assert.equal(proposal.status,'proposed');
  assert.equal((await call('admin/create',mutation())).status,200);
  const confirmed=await call('confirm',{plan_id:parsed.body.plan_id,proposal_id:proposal.id,space_id:'office-c04',confirmed:true});
  assert.equal(confirmed.status,409);assert.equal((await call('workspace')).body.meetings.length,0);
  const store=createMeetingState({rooms:officeRooms,now:instant});store.reset();
  let release;const blocked=new Promise(resolve=>{release=resolve;});
  const pending=store.adminMutate('create',mutation(),async()=>{await blocked;return {candidates:[{id:'office-c04'}]};});
  store.reset();release();await assert.rejects(pending,/state_changed/);assert.equal(store.calendar().length,0);
});

test('連続操作：予約→取消→再予約候補→確定→開始→終了、取消履歴は別IDで残る',async()=>{
  const call=api();await call('workspace/reset',{confirmed:true});
  const parsed=await call('day-plan',{message:'Today 13:00 project meeting for 4 people, 45 minutes, monitor',mode:'rules'});
  const input={plan_id:parsed.body.plan_id,proposal_id:parsed.body.proposals[0].id,space_id:'office-c04',confirmed:true};
  const original=(await call('confirm',input)).body.booking;
  await call('transition',{meeting_id:original.id,action:'cancel'});
  let currentId=original.id;
  for(let i=0;i<3;i++){
    const next=await call('rebook',{meeting_id:i?currentId:original.id});assert.equal(next.status,200);
    assert.equal(next.body.proposals[0].status,'proposed');
    assert.equal((await call('workspace')).body.meetings.filter(r=>r.status==='reserved').length,0);
    const confirmation={...input,plan_id:next.body.plan_id,proposal_id:next.body.proposals[0].id};
    const booking=(await call('confirm',confirmation)).body.booking;
    assert.notEqual(booking.id,original.id);assert.equal(booking.status,'reserved');
    assert.equal((await call('confirm',confirmation)).body.booking.id,booking.id);
    currentId=booking.id;
    if(i<2)await call('transition',{meeting_id:booking.id,action:'cancel'});
  }
  let state=(await call('transition',{meeting_id:currentId,action:'start'})).body;
  assert.equal(state.meetings.find(r=>r.id===currentId).status,'in_progress');
  state=(await call('transition',{meeting_id:currentId,action:'finish'})).body;
  assert.equal(state.meetings.find(r=>r.id===currentId).status,'completed');
  assert.equal(state.meetings.filter(r=>r.status==='cancelled').length,3);
  assert.equal((await call('rebook',{meeting_id:currentId})).status,409);
  assert.equal((await call('rebook',{meeting_id:'missing'})).status,404);
});

test('再予約：元の提案の期限後も使用可能、競合時の補完と再確定が続けられる',async()=>{
  let time=instant();const call=api(null,{now:()=>time});await call('workspace/reset',{confirmed:true});
  const original=(await call('admin/create',mutation({...adminData,time:'13:00',assigned_to:'A'}))).body.record;
  await call('transition',{meeting_id:original.id,action:'cancel'});
  time=new Date(time.getTime()+31*60000);
  const other=(await call('admin/create',mutation({...adminData,time:'13:00',title:'Other organiser'}))).body.record;
  const unavailable=await call('rebook',{meeting_id:original.id});assert.equal(unavailable.status,200);
  assert.equal(unavailable.body.proposals[0].status,'no_slot');
  const proposal=unavailable.body.proposals[0];
  const edited=await call('replan',{plan_id:unavailable.body.plan_id,proposal_id:proposal.id,activity:{...proposal.activity,time:'14:00'}});
  assert.equal(edited.body.proposals[0].status,'proposed');
  assert.equal((await call('confirm',{plan_id:edited.body.plan_id,proposal_id:edited.body.proposals[0].id,space_id:'office-c04',confirmed:true})).body.booking.status,'reserved');
  const deleted=await call('admin/delete',recordMutation(other));assert.equal(deleted.status,200);
  assert.equal((await call('rebook',{meeting_id:other.id})).status,404);
  assert.equal((await call('rebook',{meeting_id:original.id},{Origin:'https://evil.test'})).status,403);
});

test('管理者による個人席の予約も取消後に同じ種類・設備で再予約できる',async()=>{
  const call=api();await call('workspace/reset',{confirmed:true});
  const record=(await call('admin/create',mutation({...adminData,space_id:'office-f12',people:1,features:['quiet'],assigned_to:'A'}))).body.record;
  await call('transition',{meeting_id:record.id,action:'cancel'});
  const next=await call('rebook',{meeting_id:record.id});assert.equal(next.body.proposals[0].request.kind,'desk');
  const proposal=next.body.proposals[0];
  const edited=await call('replan',{plan_id:next.body.plan_id,proposal_id:proposal.id,activity:{...proposal.activity,time:'10:00'}});
  assert.equal(edited.body.proposals[0].request.kind,'desk');
  assert.equal((await call('confirm',{plan_id:edited.body.plan_id,proposal_id:edited.body.proposals[0].id,space_id:'office-f12',confirmed:true})).body.booking.space_id,'office-f12');
});
