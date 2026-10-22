import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfficeService, officeRooms, recommendOfficeRooms } from './office-service.js';
import { createMeetingState } from './meeting-state.js';
import { allocateDayPlan } from './day-plan.js';
import { errorResponse } from './http-utils.js';
import { createDataset } from './queries.js';
import { randomUUID } from 'node:crypto';

test('個人席：確認直前の他者予約と並行更新を検査し、取消・削除・復元も同じ台帳へ反映',async()=>{
  const today='2026-10-20',now=()=>new Date(today+'T00:00:00Z');
  const store=createMeetingState({rooms:officeRooms,now});store.reset();
  const recommend=(request,bookings,date)=>recommendOfficeRooms(request,bookings,date,{includeSeeded:false});
  const activity={type:'desk',title:'Desk work',date:today,time:'09:00',window_start:null,window_end:null,duration:60,people:1,features:['area_connect','window','quiet','avoid_hot'],participants:[],existing_id:null,unclear:[]};
  const result=await allocateDayPlan({activities:[activity],questions:[]},[],today,recommend);
  const id=store.savePlan(result),proposal=result.proposals[0],seat=proposal.candidates[0];
  const data={title:'Other booking',date:today,time:'09:00',duration:60,people:1,space_id:seat.id,booked_by:'Other',assigned_to:'other',features:['avoid_hot']};
  const created=await store.adminMutate('create',{operation_id:randomUUID(),confirmed:true,data},recommend);
  await assert.rejects(store.confirm({plan_id:id,proposal_id:proposal.id,space_id:seat.id,confirmed:true},recommend,today),/room_conflict/);
  await store.adminMutate('delete',{operation_id:randomUUID(),meeting_id:created.record.id,expected_version:created.record.version,confirmed:true},recommend);
  const confirmed=await store.confirm({plan_id:id,proposal_id:proposal.id,space_id:seat.id,confirmed:true},recommend,today);
  let deleted=store.snapshot().reservations.find(r=>r.id===created.record.id);
  await assert.rejects(store.adminMutate('restore',{operation_id:randomUUID(),meeting_id:deleted.id,expected_version:deleted.version,confirmed:true},recommend),/room_conflict/);
  store.transition(confirmed.booking.id,'cancel');
  const restored=await store.adminMutate('restore',{operation_id:randomUUID(),meeting_id:deleted.id,expected_version:deleted.version,confirmed:true},recommend);
  assert.equal(restored.record.status,'reserved');assert.equal(restored.record.request.kind,'desk');
  assert.equal(store.queryReservations({space_id:seat.id}).total,2);
  const tooMany={...data,space_id:proposal.candidates[1].id,people:2};
  await assert.rejects(store.adminMutate('create',{operation_id:randomUUID(),confirmed:true,data:tooMany},recommend),/capacity_exceeded/);
});

// Fixed model-response fixtures: no NLP implementation or network requests in these tests.
const aiFixtures={
  "Today 14:00 meeting for 4 people, 30 minutes, whiteboard": {
    "activities": [
      {
        "type": "meeting",
        "title": "Today 14:00 meeting for 4 people, 30 minutes, whiteboard",
        "date": "2026-10-20",
        "time": "14:00",
        "window_start": null,
        "window_end": null,
        "duration": 30,
        "people": 4,
        "features": [
          "whiteboard"
        ],
        "participants": [],
        "existing_id": null,
        "unclear": []
      }
    ],
    "questions": []
  },
  "Tomorrow": {
    "activities": [
      {
        "type": "meeting",
        "title": "Tomorrow",
        "date": "2026-10-21",
        "time": null,
        "window_start": null,
        "window_end": null,
        "duration": null,
        "people": null,
        "features": [],
        "participants": [],
        "existing_id": null,
        "unclear": [
          "文の意味を確認してください。複雑な表現はGPTで解析できます。"
        ]
      }
    ],
    "questions": []
  },
  "Today 13:00 project meeting for 4 people, 45 minutes, monitor": {
    "activities": [
      {
        "type": "meeting",
        "title": "Today 13:00 project meeting for 4 people, 45 minutes, monitor",
        "date": "2026-10-20",
        "time": "13:00",
        "window_start": null,
        "window_end": null,
        "duration": 45,
        "people": 4,
        "features": [
          "monitor"
        ],
        "participants": [],
        "existing_id": null,
        "unclear": []
      }
    ],
    "questions": []
  },
  "午後に会議をしたいです": {
    "activities": [
      {
        "type": "meeting",
        "title": "午後に会議をしたいです",
        "date": "2026-10-20",
        "time": null,
        "window_start": "13:00",
        "window_end": "18:00",
        "duration": null,
        "people": null,
        "features": [],
        "participants": [],
        "existing_id": null,
        "unclear": []
      }
    ],
    "questions": []
  },
  "Today 14:00 project meeting for 3 people, 30 minutes, whiteboard": {
    "activities": [
      {
        "type": "meeting",
        "title": "Today 14:00 project meeting for 3 people, 30 minutes, whiteboard",
        "date": "2026-10-20",
        "time": "14:00",
        "window_start": null,
        "window_end": null,
        "duration": 30,
        "people": 3,
        "features": [
          "whiteboard"
        ],
        "participants": [],
        "existing_id": null,
        "unclear": []
      }
    ],
    "questions": []
  },
  "Today 09:00 project meeting for 3 people, 30 minutes, whiteboard": {
    "activities": [
      {
        "type": "meeting",
        "title": "Today 09:00 project meeting for 3 people, 30 minutes, whiteboard",
        "date": "2026-10-20",
        "time": "09:00",
        "window_start": null,
        "window_end": null,
        "duration": 30,
        "people": 3,
        "features": [
          "whiteboard"
        ],
        "participants": [],
        "existing_id": null,
        "unclear": []
      }
    ],
    "questions": []
  },
  "Today 14:00 planning meeting for 3 people, 30 minutes, whiteboard": {
    "activities": [
      {
        "type": "meeting",
        "title": "Today 14:00 planning meeting for 3 people, 30 minutes, whiteboard",
        "date": "2026-10-20",
        "time": "14:00",
        "window_start": null,
        "window_end": null,
        "duration": 30,
        "people": 3,
        "features": [
          "whiteboard"
        ],
        "participants": [],
        "existing_id": null,
        "unclear": []
      }
    ],
    "questions": []
  }
};
function fixturePlan(message){assert.ok(aiFixtures[message], 'Missing explicit AI fixture: '+message);return structuredClone(aiFixtures[message]);}
const mockDayParser=async (_key,{message})=>fixturePlan(message);

const today='2026-10-20',instant=()=>new Date(today+'T01:00:00Z');
const activity={type:'meeting',title:'Project review',date:today,time:'13:00',window_start:null,window_end:null,duration:45,people:4,features:['monitor'],participants:[],existing_id:null,unclear:[]};
async function prepared(store,changes={}){
  const plan=await allocateDayPlan({activities:[{...activity,...changes}],questions:[]},store.snapshot().meetings,today,recommendOfficeRooms);
  const id=store.savePlan(plan);
  return {plan_id:id,proposal_id:plan.proposals[0].id,space_id:plan.proposals[0].candidates[0]?.id,confirmed:true};
}
function api(dayParser,options={}){
  const handle=createOfficeService({now:instant,dayParser:dayParser??mockDayParser,...options});
  return async(path,body,headers={})=>{
    let response;
    try{response=await handle(new Request('http://demo.test/api/office/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(!dayParser?{Authorization:'Bearer test_key_not_real_1234567890'}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));}
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
  const deleted=await store.adminMutate('delete',{operation_id:randomUUID(),meeting_id:id,expected_version:3,confirmed:true},recommendOfficeRooms);
  assert.equal(deleted.record.deleted,true);assert.equal(store.queryReservations({state:'deleted'}).total,1);
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
  const plan=(await call('day-plan',{mode:'gpt',message:'Today 14:00 meeting for 4 people, 30 minutes, whiteboard'})).body;
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
  assert.equal(readonly.status,200);assert.equal(readonly.body.record.source,'attendance');
  await call('admin/restore',{operation_id:randomUUID(),meeting_id:id,expected_version:readonly.body.record.version,confirmed:true});
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
  const p=await call('day-plan',{message,mode:'gpt',locale:'en'});assert.equal(p.status,200);
  const proposal=p.body.proposals[0];assert.equal(proposal.status,'proposed');
  const booked=await call('confirm',{plan_id:p.body.plan_id,proposal_id:proposal.id,space_id:'office-c04',confirmed:true});assert.equal(booked.status,200);
  assert.equal((await call('workspace')).body.meetings.length,1);
  assert.equal((await call('day-plan',{message,mode:'gpt',locale:'en'})).body.proposals[0].status,'existing');
  await call('transition',{meeting_id:booked.body.booking.id,action:'cancel'});
  assert.equal((await call('day-plan',{message,mode:'gpt',locale:'en'})).body.proposals[0].status,'proposed');
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
  const call=api();const p=await call('day-plan',{message:'午後に会議をしたいです',mode:'gpt'});
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
  assert.equal(state.clock.time,'09:00');assert.equal(state.rooms.length,officeRooms.length);
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
  const result=await call('day-plan',{message:'Today 14:00 project meeting for 3 people, 30 minutes, whiteboard',mode:'gpt',locale:'en'});
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
  const list=await call('admin/reservations');assert.equal(list.status,200);assert.equal(list.body.total,93);
  assert.ok(list.body.items.every(r=>r.source==='preset'&&r.booked_by==='System'&&r.assigned_to==='other'));
  const filtered=await call('admin/reservations?space_id=office-c04&query=System&state=reserved');
  assert.equal(filtered.body.total,31);assert.equal(filtered.body.items[0].time,'14:00');
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
  assert.equal((await call('day-plan',{message,mode:'gpt'})).body.proposals[0].status,'no_slot');
  const updated=await call('admin/update',{...recordMutation(record),data:{...adminData,time:'10:00',title:'Revised',assigned_to:'A'}});
  assert.equal(updated.status,200);record=updated.body.record;assert.equal(record.version,2);
  assert.equal((await call('workspace')).body.meetings[0].title,'Revised');
  assert.equal((await call('day-plan',{message,mode:'gpt'})).body.proposals[0].status,'proposed');
  const deletion=await call('admin/delete',recordMutation(record));assert.equal(deletion.status,200);record=deletion.body.record;
  assert.equal((await call('admin/reservations')).body.total,1);
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
  const input={message:'Today 14:00 planning meeting for 3 people, 30 minutes, whiteboard',mode:'gpt'};
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

test('管理操作：進行中の終了・履歴の訂正・削除・復元で状態を保持する',async()=>{
  const call=api();await call('workspace/reset',{confirmed:true});
  let record=(await call('admin/create',mutation({...adminData,assigned_to:'A'}))).body.record;
  record=(await call('transition',{meeting_id:record.id,action:'start'})).body.meetings[0];
  assert.equal((await call('admin/update',{...recordMutation(record),data:adminData})).body.error,'active_readonly');
  record=(await call('admin/finish',recordMutation(record))).body.record;
  assert.equal(record.status,'completed');
  const data={...adminData,assigned_to:'A',title:'Corrected history'};
  record=(await call('admin/update',{...recordMutation(record),data})).body.record;
  assert.equal(record.status,'completed');assert.equal(record.title,data.title);
  const deletion=await call('admin/delete',recordMutation(record));assert.equal(deletion.status,200);
  assert.equal((await call('admin/restore',recordMutation(deletion.body.record))).body.record.status,'completed');
  assert.equal((await call('admin/update',{...recordMutation(record),data:{...data,time:'12:00'}})).body.error,'record_changed');
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
  const parsed=await call('day-plan',{message:'Today 09:00 project meeting for 3 people, 30 minutes, whiteboard',mode:'gpt'});
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
  const parsed=await call('day-plan',{message:'Today 13:00 project meeting for 4 people, 45 minutes, monitor',mode:'gpt'});
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

test('再予約の連鎖：成功時だけ旧記録を関連付け、失敗・重送・並行確認で履歴を壊さない',async()=>{
  const call=api();await call('workspace/reset',{confirmed:true});
  const original=(await call('admin/create',mutation({...adminData,time:'13:00',assigned_to:'A'}))).body.record;
  await call('transition',{meeting_id:original.id,action:'cancel'});
  const next=(await call('rebook',{meeting_id:original.id})).body;
  const competing=(await call('rebook',{meeting_id:original.id})).body;
  let state=(await call('workspace')).body;assert.equal(state.current_meetings.length,0);assert.equal(state.meeting_history[0].replacement_id,null);
  const occupied=(await call('admin/create',mutation({...adminData,time:'13:00',title:'Other person'}))).body.record;
  const confirmation={plan_id:next.plan_id,proposal_id:next.proposals[0].id,space_id:'office-c04',confirmed:true};
  assert.equal((await call('confirm',confirmation)).status,409);
  state=(await call('workspace')).body;assert.equal(state.meeting_history[0].replacement_id,null);assert.equal(state.meeting_history[0].status,'cancelled');
  await call('admin/delete',recordMutation(occupied));
  const booked=(await call('confirm',confirmation)).body.booking;
  assert.equal(booked.rebooked_from,original.id);assert.equal((await call('confirm',confirmation)).body.booking.id,booked.id);
  assert.equal((await call('confirm',{...confirmation,plan_id:competing.plan_id,proposal_id:competing.proposals[0].id})).body.error,'rebook_replaced');
  assert.equal((await call('rebook',{meeting_id:original.id})).body.error,'rebook_replaced');
  state=(await call('workspace')).body;assert.deepEqual(state.current_meetings.map(r=>r.id),[booked.id]);assert.equal(state.meeting_history[0].replacement_id,booked.id);
  assert.equal(state.meetings.length,2);assert.equal(state.events.filter(e=>e.type==='rebooked').length,1);
  await call('transition',{meeting_id:booked.id,action:'cancel'});
  assert.equal((await call('rebook',{meeting_id:original.id})).body.error,'rebook_replaced','An earlier link cannot restart the chain');
  const latest=(await call('rebook',{meeting_id:booked.id})).body;
  assert.equal(latest.rebook_of,booked.id);
  const edited=(await call('replan',{plan_id:latest.plan_id,proposal_id:latest.proposals[0].id,activity:{...latest.proposals[0].activity,time:'15:00'}})).body;
  assert.equal(edited.rebook_of,booked.id);assert.equal(edited.rebook_version,latest.rebook_version);
  const third=(await call('confirm',{plan_id:edited.plan_id,proposal_id:edited.proposals[0].id,space_id:'office-c04',confirmed:true})).body.booking;
  assert.equal(third.rebooked_from,booked.id);assert.equal((await call('workspace')).body.meeting_history.find(r=>r.id===booked.id).replacement_id,third.id);
});

test('再予約の旧記録：管理者の編集・削除は古い提案を失効させ、復元で取消を有効化しない',async()=>{
  const call=api();await call('workspace/reset',{confirmed:true});
  let original=(await call('admin/create',mutation({...adminData,time:'13:00',assigned_to:'A'}))).body.record;
  await call('transition',{meeting_id:original.id,action:'cancel'});
  const next=(await call('rebook',{meeting_id:original.id})).body;
  original=(await call('workspace')).body.meetings[0];
  original=(await call('admin/update',{...recordMutation(original),data:{...adminData,title:'Corrected',time:'13:00',assigned_to:'A'}})).body.record;
  const confirmation={plan_id:next.plan_id,proposal_id:next.proposals[0].id,space_id:'office-c04',confirmed:true};
  assert.equal((await call('confirm',confirmation)).body.error,'record_changed');
  assert.equal((await call('workspace')).body.current_meetings.length,0);
  const retry=(await call('rebook',{meeting_id:original.id})).body;
  original=(await call('admin/delete',recordMutation(original))).body.record;
  assert.equal((await call('confirm',{...confirmation,plan_id:retry.plan_id,proposal_id:retry.proposals[0].id})).status,404);
  assert.equal((await call('workspace')).body.meeting_history[0].deleted,true);
  original=(await call('admin/restore',recordMutation(original))).body.record;
  assert.equal(original.status,'cancelled');assert.equal((await call('workspace')).body.current_meetings.length,0);
});

test('履歴：旧形式の取消と後続予約、開始期限超過・削除・完了を復元後も区別する',async()=>{
  const store=createMeetingState({rooms:officeRooms,now:instant});store.reset();
  const first=(await store.confirm(await prepared(store),recommendOfficeRooms,today)).booking;store.transition(first.id,'cancel');
  const second=(await store.confirm(await prepared(store),recommendOfficeRooms,today)).booking;
  let state=store.snapshot();assert.equal(state.meeting_history[0].replacement_id,second.id);assert.equal(state.current_meetings.length,1);
  const restored=createMeetingState({rooms:officeRooms,now:instant,persisted:store.exportState()});
  assert.equal(restored.snapshot().meeting_history[0].replacement_id,second.id);
  restored.transition(second.id,'start');restored.transition(second.id,'finish');
  state=restored.snapshot();assert.equal(state.current_meetings.length,0);assert.equal(state.meeting_history.length,2);
  const old=store.exportState();old.records[0].request={...old.records[0].request,duration:30};
  assert.equal(createMeetingState({rooms:officeRooms,now:instant,persisted:old}).snapshot().meeting_history[0].replacement_id,null,'Different conditions are not inferred as replacements');
});

test('開始期限超過：未開始の履歴は200件上限を消費せず、再解析で既存予約に戻さない',async()=>{
  const store=createMeetingState({rooms:officeRooms,now:instant});store.reset();
  const first=(await store.confirm(await prepared(store,{time:'09:00',duration:60}),recommendOfficeRooms,today)).booking;
  const exported=store.exportState();exported.clock.time='12:00';
  exported.records=Array.from({length:200},(_,i)=>({...first,id:'overdue-'+i}));
  const restored=createMeetingState({rooms:officeRooms,now:instant,persisted:exported});
  assert.equal(restored.snapshot().current_meetings.length,0);assert.equal(restored.snapshot().meeting_history.length,200);
  const result=await allocateDayPlan({activities:[{...activity,time:'09:00',duration:60,existing_id:first.id}],questions:[]},[first],today,recommendOfficeRooms,{notBefore:{date:today,time:'12:00'}});
  assert.equal(result.proposals[0].status,'no_slot');
  const fresh=await prepared(restored,{time:'13:00'});assert.equal((await restored.confirm(fresh,recommendOfficeRooms,today)).booking.status,'reserved');
  assert.equal(restored.snapshot().current_meetings.length,1);
});

test('参加の再登録：旧履歴から操作を増やさず、同じ入力の重送は同じ記録を返す',async()=>{
  const store=createMeetingState({rooms:officeRooms,now:instant});store.reset();
  const first=store.attend(await attendanceInput(store)).meeting;store.transition(first.id,'cancel');
  const input={meeting_id:first.id,space_id:'office-c04',time:'14:00'};
  const second=store.attend(input).meeting;
  assert.equal(store.attend(input).meeting.id,second.id);assert.equal(store.snapshot().meeting_history[0].replacement_id,second.id);
  store.transition(second.id,'cancel');const third=store.attend({...input,meeting_id:second.id}).meeting;
  assert.throws(()=>store.attend(input),/cancelled_replan/);assert.equal(store.snapshot().current_meetings[0].id,third.id);
  assert.equal(store.snapshot().meeting_history.length,2);assert.equal(store.snapshot().reservations.length,0);
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

test('回帰：ローカル自然文方式は旧APIでも新APIでも利用できず、未設定Keyで実行しない',async()=>{
  let calls=0;const call=api(async()=>{calls++;return {activities:[activity],questions:[]};});
  assert.equal((await call('day-plan',{message:'Today 13:00 meeting',mode:'rules'})).body.error,'ai_required');
  assert.equal((await call('day-plan',{message:'Today 13:00 meeting'})).status,401);
  assert.equal(calls,0);
  const failed=api(async()=>{throw new Error('API unavailable');});
  const result=await failed('day-plan',{message:'Today 13:00 meeting',mode:'gpt'},{Authorization:'Bearer test_key_not_real_1234567890'});
  assert.equal(result.status,500);assert.equal((await failed('workspace')).body.meetings.length,0);
});

test('回帰：全期間と全状態を一覧・ページングし、削除記録と参加を含む件数が一致する',async()=>{
  const call=api();await call('workspace/reset',{confirmed:true});
  const a=(await call('admin/create',mutation())).body.record;
  const b=(await call('admin/create',mutation({...adminData,date:'2026-10-21'}))).body.record;
  await call('admin/delete',recordMutation(a));
  const all=(await call('admin/reservations?limit=1')).body;
  assert.equal(all.total,2);assert.equal(all.counts.total,2);assert.equal(all.counts.deleted,1);
  const next=(await call('admin/reservations?limit=1&offset=1')).body;
  assert.equal(next.items[0].id,b.id);
  assert.equal((await call('admin/reservations?start_date=2026-10-21')).body.total,1);
  assert.equal((await call('admin/reservations?end_date=2026-10-20')).body.total,1);
});

test('回帰：終了済みは既存会議として再利用せず、模擬時刻の巻戻りを防ぐ',async()=>{
  const store=createMeetingState({rooms:officeRooms,now:instant});store.reset();
  const first=(await store.confirm(await prepared(store,{time:'13:00'}),recommendOfficeRooms,today)).booking;
  const early=(await store.confirm(await prepared(store,{title:'Earlier',time:'10:00'}),recommendOfficeRooms,today)).booking;
  store.transition(first.id,'start');store.transition(first.id,'finish');
  assert.throws(()=>store.transition(early.id,'start'),/past_time/);
  assert.equal(store.snapshot().clock.time,'13:45');
  const plan=await allocateDayPlan({activities:[{...activity,time:null,window_start:'13:00',window_end:'17:00'}],questions:[]},store.snapshot().meetings,today,recommendOfficeRooms,{notBefore:store.snapshot().clock});
  assert.equal(plan.proposals[0].status,'proposed');assert.equal(plan.proposals[0].request.time,'13:45');
  assert.equal(plan.proposals[0].existing,undefined);
});

test('回帰：古い日付の終了履歴を訂正・削除・復元しても予約に戻らない',async()=>{
  let now=instant();const store=createMeetingState({rooms:officeRooms,now:()=>now});store.reset();
  let record=(await store.confirm(await prepared(store),recommendOfficeRooms,today)).booking;
  store.transition(record.id,'start');record=store.transition(record.id,'finish').meetings[0];
  now=new Date('2026-10-22T00:00:00Z');
  const data={title:'History correction',date:record.date,time:record.time,duration:record.request.duration,people:record.people,space_id:record.space_id,features:record.request.features,booked_by:record.booked_by,assigned_to:'A'};
  record=(await store.adminMutate('update',{...recordMutation(record),data},recommendOfficeRooms)).record;
  assert.equal(record.status,'completed');assert.equal(record.actual_end,'13:45');
  await assert.rejects(store.adminMutate('update',{...recordMutation(record),data:{...data,time:'14:00'}},recommendOfficeRooms),/history_schedule/);
  record=(await store.adminMutate('delete',recordMutation(record),recommendOfficeRooms)).record;
  record=(await store.adminMutate('restore',recordMutation(record),recommendOfficeRooms)).record;
  assert.equal(record.status,'completed');assert.equal(record.deleted,false);assert.equal(store.snapshot().clock.time,'13:45');
});

test('回帰：進行中の参加記録を管理者が終了・編集・削除・復元できる',async()=>{
  const store=createMeetingState({rooms:officeRooms,now:instant});
  let record=store.attend(await attendanceInput(store)).meeting;
  record=store.transition(record.id,'start').meetings[0];
  record=(await store.adminMutate('finish',recordMutation(record),recommendOfficeRooms)).record;
  const data={title:'Corrected attendance',date:record.date,time:record.time,duration:record.request.duration,people:record.people,space_id:record.space_id,features:record.request.features,booked_by:'Display name',assigned_to:'A'};
  record=(await store.adminMutate('update',{...recordMutation(record),data},recommendOfficeRooms)).record;
  assert.equal(record.source,'attendance');assert.equal(record.booking_required,false);
  record=(await store.adminMutate('delete',recordMutation(record),recommendOfficeRooms)).record;
  assert.equal(store.snapshot().meetings.length,0);
  record=(await store.adminMutate('restore',recordMutation(record),recommendOfficeRooms)).record;
  assert.equal(record.status,'completed');assert.equal(store.snapshot().reservations.some(r=>r.id===record.id),false);
});

test('回帰：管理者の会議中削除は終了と解放を記録し、復元しても再開しない',async()=>{
  const store=createMeetingState({rooms:officeRooms,now:instant});store.reset();
  let record=(await store.confirm(await prepared(store),recommendOfficeRooms,today)).booking;
  record=store.transition(record.id,'start').meetings[0];
  record=(await store.adminMutate('delete',recordMutation(record),recommendOfficeRooms)).record;
  assert.equal(record.deleted,true);assert.equal(record.status,'completed');assert.equal(store.snapshot().clock.time,'13:45');
  record=(await store.adminMutate('restore',recordMutation(record),recommendOfficeRooms)).record;
  assert.equal(record.status,'completed');assert.equal(store.snapshot().meetings.some(r=>r.status==='in_progress'),false);
});

test('回帰：200件の削除済み履歴は新規予約を妨げず、有効200件の上限は維持する',async()=>{
  const initial=createMeetingState({rooms:officeRooms,now:instant});initial.reset();
  const template=(await initial.adminMutate('create',mutation(),recommendOfficeRooms)).record;
  const state=initial.exportState();
  state.records=Array.from({length:200},(_,i)=>({...template,id:'history-'+i,status:'cancelled',deleted:true}));
  const store=createMeetingState({rooms:officeRooms,now:instant,persisted:state});
  assert.equal((await store.adminMutate('create',mutation(),recommendOfficeRooms)).record.status,'reserved');
  assert.equal(store.queryReservations().total,201);
  state.records=state.records.map(r=>({...r,deleted:false,status:'reserved'}));
  const full=createMeetingState({rooms:officeRooms,now:instant,persisted:state});
  await assert.rejects(full.adminMutate('create',mutation({...adminData,time:'16:00'}),recommendOfficeRooms),/workspace_limit/);
});

test('回帰：過去の未実施予約の復元は取消履歴となり、時計・部屋の占有を戻さない',async()=>{
  let now=instant();const store=createMeetingState({rooms:officeRooms,now:()=>now});store.reset();
  let record=(await store.adminMutate('create',mutation(),recommendOfficeRooms)).record;
  record=(await store.adminMutate('delete',recordMutation(record),recommendOfficeRooms)).record;
  now=new Date('2026-10-22T00:00:00Z');
  record=(await store.adminMutate('restore',recordMutation(record),recommendOfficeRooms)).record;
  assert.equal(record.status,'cancelled');assert.equal(store.calendar().length,0);
});

test('一括削除の期間：実時計の日本日付・開始時刻で当日、直近1時間、7日、30日を区別する',async()=>{
  const initial=createMeetingState({rooms:officeRooms,now:instant});initial.reset();
  const template=(await initial.adminMutate('create',mutation(),recommendOfficeRooms)).record;
  const state=initial.exportState();
  const points=[['month-out','2026-09-20','23:59'],['month-start','2026-09-21','00:00'],
    ['week-out','2026-10-13','23:59'],['week-start','2026-10-14','00:00'],['yesterday','2026-10-19','23:59'],
    ['midnight',today,'00:00'],['hour-out',today,'08:59'],['hour-start',today,'09:00'],
    ['now',today,'10:00'],['hour-after',today,'10:01'],['today-end',today,'23:59'],['tomorrow','2026-10-21','00:00']];
  state.records=points.map(([id,date,time])=>({...template,id,date,time}));
  // The simulated clock must not change the administrator's real-time range.
  state.clock={date:'2026-10-25',time:'17:00'};
  for(const [range,ids] of [['hour',['hour-start','now']],['today',['midnight','hour-out','hour-start','now','hour-after','today-end']],
    ['week',points.slice(3,-1).map(p=>p[0])],['month',points.slice(1,-1).map(p=>p[0])],['all',points.map(p=>p[0])]]){
    const store=createMeetingState({rooms:officeRooms,now:instant,persisted:state});
    const before=store.snapshot(),preview=store.previewClear({range});
    assert.equal(preview.count,ids.length,range);assert.equal(preview.reference_at,'2026-10-20T10:00:00.000+09:00');
    assert.deepEqual(store.snapshot(),before,'Preview cannot mutate bookings');
    const result=store.clearRecords({preview_id:preview.preview_id,operation_id:randomUUID(),confirmed:true});
    assert.equal(result.deleted_count,ids.length);
    assert.deepEqual(store.queryReservations({state:'deleted'}).items.map(r=>r.id).sort(),ids.sort(),range);
    assert.deepEqual(store.snapshot().clock,state.clock);
  }
  const boundary=createMeetingState({rooms:officeRooms,now:()=>new Date('2026-10-19T15:00:00Z'),persisted:state});
  assert.equal(boundary.previewClear({range:'today'}).start_at,'2026-10-20T00:00:00.000+09:00');
});

test('一括削除の安全性：確認必須・5分期限・変更後は全件中止・同一操作の再送で新規記録を消さない',async()=>{
  let at=instant();const store=createMeetingState({rooms:officeRooms,now:()=>at});store.reset();
  let record=(await store.adminMutate('create',mutation(),recommendOfficeRooms)).record;
  assert.throws(()=>store.previewClear({range:'year'}),/invalid_clear_range/);
  assert.throws(()=>store.previewClear({range:'all',query:'ignored'}),/invalid_clear_range/);
  let preview=store.previewClear({range:'today'});
  const input={preview_id:preview.preview_id,operation_id:randomUUID(),confirmed:true};
  for(const invalid of [{...input,confirmed:false},{...input,confirmed:undefined},{...input,range:'all'}, {...input,preview_id:'invalid'}]){
    assert.throws(()=>store.clearRecords(invalid),/invalid_clear_input/);
  }
  assert.throws(()=>store.clearRecords({...input,preview_id:randomUUID()}),/clear_preview_expired/);
  record=(await store.adminMutate('update',{...recordMutation(record),data:{...adminData,title:'Updated'}},recommendOfficeRooms)).record;
  assert.throws(()=>store.clearRecords(input),/clear_targets_changed/);assert.equal(store.queryReservations({state:'deleted'}).total,0);
  preview=store.previewClear({range:'today'});at=new Date(at.getTime()+300000);
  assert.throws(()=>store.clearRecords({...input,preview_id:preview.preview_id}),/clear_preview_expired/);
  preview=store.previewClear({range:'all'});const retry={...input,preview_id:preview.preview_id};
  const result=store.clearRecords(retry);assert.equal(result.deleted_count,1);
  await store.adminMutate('create',mutation({...adminData,time:'16:00'}),recommendOfficeRooms);
  assert.deepEqual(store.clearRecords(retry),result);assert.equal(store.queryReservations({state:'not_deleted'}).total,1);
  assert.throws(()=>store.clearRecords({...retry,preview_id:randomUUID()}),/operation_reused/);
});

test('一括削除：全ページの履歴と参加を処理し、既存削除を除外、復元できる状態を残す',async()=>{
  const initial=createMeetingState({rooms:officeRooms,now:instant});initial.reset();
  const template=(await initial.adminMutate('create',mutation({...adminData,time:'13:00',assigned_to:'A'}),recommendOfficeRooms)).record;
  const state=initial.exportState();
  state.records=Array.from({length:240},(_,i)=>({...template,id:'row-'+i,status:i%2?'cancelled':'completed',actual_end:'13:30',
    source:i%3?'admin':'attendance',deleted:i===239}));
  const store=createMeetingState({rooms:officeRooms,now:instant,persisted:state}),preview=store.previewClear({range:'all'});
  assert.equal(preview.count,239);assert.equal(preview.attendance_count,80);assert.equal(preview.skipped_deleted,1);
  store.clearRecords({preview_id:preview.preview_id,operation_id:randomUUID(),confirmed:true});
  assert.equal(store.queryReservations({state:'not_deleted'}).total,0);assert.equal(store.queryReservations({state:'deleted'}).total,240);
  assert.equal(store.queryReservations({state:'deleted',offset:200}).items.length,40);
  assert.deepEqual(store.snapshot().current_meetings,[]);
  assert.deepEqual(store.snapshot().meeting_history.map(r=>r.id),['row-239'],'Only pre-existing individual deletion stays in employee history');
  const completed=store.queryReservations({state:'deleted'}).items.find(r=>r.id==='row-2');
  const restored=(await store.adminMutate('restore',recordMutation(completed),recommendOfficeRooms)).record;
  assert.equal(restored.status,'completed');assert.equal(restored.bulk_cleared,false);
  assert.ok(store.snapshot().meeting_history.some(r=>r.id===restored.id));assert.equal(store.snapshot().current_meetings.length,0);
});

test('一括削除：進行中の会議を終了して解放、予約を復元、全件削除後は翌日の初期予約を再生成しない',async()=>{
  let at=instant();const store=createMeetingState({rooms:officeRooms,now:()=>at});
  const booking=(await store.confirm(await prepared(store),recommendOfficeRooms,today)).booking;
  store.transition(booking.id,'start');
  let preview=store.previewClear({range:'today'});assert.equal(preview.count,4);assert.equal(preview.active_count,1);assert.equal(preview.preset_count,3);
  store.clearRecords({preview_id:preview.preview_id,operation_id:randomUUID(),confirmed:true});
  assert.equal(store.queryReservations({state:'not_deleted'}).total,90);
  assert.equal(store.snapshot().clock.time,'13:45');assert.equal(store.snapshot().meetings.length,0);
  const deleted=store.queryReservations({state:'deleted'}).items.find(r=>r.id===booking.id);
  assert.equal(deleted.status,'completed');assert.equal(deleted.actual_end,'13:45');
  await store.adminMutate('restore',recordMutation(deleted),recommendOfficeRooms);
  assert.equal(store.snapshot().current_meetings.length,0);assert.equal(store.snapshot().meeting_history[0].status,'completed');
  const future=(await store.adminMutate('create',mutation({...adminData,time:'16:00',assigned_to:'A'}),recommendOfficeRooms)).record;
  preview=store.previewClear({range:'all'});store.clearRecords({preview_id:preview.preview_id,operation_id:randomUUID(),confirmed:true});
  const futureDeleted=store.queryReservations({state:'deleted'}).items.find(r=>r.id===future.id);
  await store.adminMutate('restore',recordMutation(futureDeleted),recommendOfficeRooms);
  assert.equal(store.snapshot().current_meetings[0].id,future.id);
  preview=store.previewClear({range:'all'});store.clearRecords({preview_id:preview.preview_id,operation_id:randomUUID(),confirmed:true});
  at=new Date('2026-10-22T00:00:00Z');assert.equal(store.queryReservations({state:'not_deleted'}).total,0);
  assert.ok(store.snapshot().events.some(e=>e.type==='admin_delete'));
});

test('一括削除HTTP：同一Origin・POST・確認・期限を検証し、未知の範囲や引数を拒否する',async()=>{
  const call=api();const preview=await call('admin/clear-preview',{range:'today'});assert.equal(preview.status,200);
  assert.equal((await call('admin/clear-preview')).status,405);
  assert.equal((await call('admin/clear')).status,405);
  assert.equal((await call('admin/clear-preview',{range:'all'},{Origin:'https://other.test'})).status,403);
  assert.equal((await call('admin/clear-preview',{range:'all',state:'reserved'})).status,400);
  const input={preview_id:preview.body.preview_id,operation_id:randomUUID(),confirmed:true};
  assert.equal((await call('admin/clear',{...input,confirmed:false})).status,400);
  assert.equal((await call('admin/clear',input,{Origin:'https://other.test'})).status,403);
  assert.equal((await call('admin/clear',input)).body.deleted_count,3);
  assert.equal((await call('admin/reservations?state=not_deleted')).body.total,90);
});
