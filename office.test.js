import {layoutAreas,layoutPosition,layoutSeats,renderOfficeLayout} from './office-layout.js';
import {summarizeEnterpriseComfort,comfortOrder,compareComfort} from './seat-comfort.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {recommendOfficeRooms,createOfficeService,officeRooms} from './office-service.js';
import {parseOfficeIntentWithGpt,parseDayPlanWithGpt} from './llm.js';
import {errorResponse} from './http-utils.js';
import {ApiSession,ReviewComparison} from './session.js';
import {translator} from './ui-i18n.js';

test('個人席：既存の483図形と安定ID・変換座標を共有する',()=>{
  const seats=layoutSeats();assert.equal(seats.length,483);assert.equal(new Set(seats.map(r=>r.id)).size,483);
  for(const [zone,count] of [['east',219],['west',182],['connect',82]]){
    const inventory=seats.filter(r=>r.area===zone);assert.equal(inventory.length,count);
    const svg=renderOfficeLayout(zone,'en').svg;
    for(const seat of inventory){
      assert.ok(svg.includes('data-room="'+seat.id+'"'));assert.equal(seat.capacity,1);
      const point=layoutPosition(zone,seat.id);assert.ok(point.placed&&point.x>=0&&point.x<=100&&point.y>=0&&point.y<=100);
      assert.equal(seat.corporate_mapping,'unbound');
    }
  }
  assert.deepEqual(layoutSeats(),seats);
  assert.deepEqual(layoutPosition('east','east-seat-001').point,seats[0].point);
});

test('個人席推薦：全ページのMCP照会、エリア・設備・快適性と空きの検証',async()=>{
  const request={date:'2026-10-20',time:'09:00',duration:60,people:1,kind:'desk',features:[]};
  const all=await recommendOfficeRooms(request,[],request.date,{includeSeeded:false});
  assert.equal(all.candidates.length,484);
  assert.equal(all.trace.filter(x=>x.name==='search_spaces').length,5);
  for(const zone of ['east','west','connect']){
    const result=await recommendOfficeRooms({...request,features:['area_'+zone,'window','quiet','low_airflow','avoid_cold']},[],request.date,{includeSeeded:false});
    assert.ok(result.candidates.length>0);
    assert.ok(result.candidates.every(r=>r.area===zone&&['window','quiet','low_airflow'].every(f=>r.features.includes(f))));
    const ordered=[...result.candidates].sort((a,b)=>compareComfort(a,b,['avoid_cold']));assert.deepEqual(result.candidates,ordered);
    const first=result.candidates[0];
    const blocked=await recommendOfficeRooms({...request,features:['area_'+zone]},[{id:'busy',space_id:first.id,date:request.date,start:540,end:600,status:'reserved'}],request.date,{includeSeeded:false});
    assert.ok(!blocked.candidates.some(r=>r.id===first.id));
  }
  for(const features of [['area_east','area_west'],['soundproof'],['whiteboard']])assert.equal((await recommendOfficeRooms({...request,features},[],request.date,{includeSeeded:false})).candidates.length,0);
  assert.equal(comfortOrder({comfort:{responses:2,cold:0,hot:0,mean_score:10}},['avoid_cold']).known,false);
  const cold={id:'cold',comfort:{responses:10,cold:5,hot:0,mean_score:10}},warm={id:'warm',comfort:{responses:10,cold:0,hot:5,mean_score:7}};
  assert.ok(compareComfort(warm,cold,['avoid_cold'])<0);assert.ok(compareComfort(cold,warm,['avoid_hot'])<0);
});

test('実サンプル集計：設問・組織を分離し、IDやコメントを返さず欠損と重複を明示',()=>{
  const base={organization_id:'org',space_id:'room',score:'8',answered_date_jst:'2025/1/2',satisfaction_setting_id:'q1',people_id:'private-person',comment:'private-comment'};
  const summary=summarizeEnterpriseComfort({spaceRows:[{organization_id:'org',space_id:'room',space_name:'会議室G'},{organization_id:'other',space_id:'room',space_name:'TSG182'}],
    airconRows:[{'投稿時間':'2026-01-02','場所':'G会議室','状態':'ちょっと寒い'},{'投稿時間':'2026-03-31','場所':'会議室 G','状態':'ちょっと暑い'},{'投稿時間':'invalid','場所':'TSG182付近','状態':'ちょっと暑い'},{'場所':'G','状態':'unknown'}],
    satisfactionRows:[{...base,satisfaction_id:'1'},{...base,satisfaction_id:'2',score:'4',satisfaction_setting_id:'q2'},{...base,satisfaction_id:'1'},
      {...base,satisfaction_id:'3',organization_id:'other',score:'6'},{...base,satisfaction_id:'4',score:''},{...base,satisfaction_id:'5',space_id:'missing'},
      {...base,satisfaction_id:'6',score:'11'}]});
  const g=summary.items.find(x=>x.location==='会議室G');assert.equal(g.cold_reports,1);assert.equal(g.hot_reports,1);
  assert.deepEqual(g.surveys.map(s=>s.mean_score),[8,4]);assert.equal(summary.items.find(x=>x.location==='TSG182').surveys[0].mean_score,6);
  assert.ok(summary.items.some(x=>x.location==='TSG182付近'));assert.equal(summary.mapped_to_demo_seats,false);
  assert.deepEqual(summary.thermal_period,{start:'2026-01-02',end:'2026-03-31'});
  assert.deepEqual(summary.excluded,{unknown_thermal:1,invalid_scores:2,unmapped_scores:1,duplicate_scores:1});
  assert.doesNotMatch(JSON.stringify(summary),/private-person|private-comment|people_id|reservation_id|satisfaction_id|space_id/);
});

test('快適性API：ローカル集計は読取専用、未読込を偽装せず、別Originを拒否',async()=>{
  const handle=createOfficeService({comfortSummary:{source:'enterprise_sample',items:[],mapped_to_demo_seats:false}});
  const get=()=>new Request('http://demo.test/api/office/comfort');
  assert.equal((await (await handle(get())).json()).source,'enterprise_sample');
  assert.equal((await (await createOfficeService()(get())).json()).source,'unavailable');
  await assert.rejects(handle(new Request(get(),{headers:{Origin:'http://other.test'}})));
  await assert.rejects(handle(new Request(get(),{method:'POST'})));
});

// Fixed model-response fixtures: no NLP implementation or network requests in these tests.
const aiFixtures={
  "Today 14:00 project review for 4 people, 30 minutes, whiteboard": {
    "activities": [
      {
        "type": "meeting",
        "title": "Today 14:00 project review for 4 people, 30 minutes, whiteboard",
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
  "Today 14:00 meeting for 4 people, 30 minutes, monitor": {
    "activities": [
      {
        "type": "meeting",
        "title": "Today 14:00 meeting for 4 people, 30 minutes, monitor",
        "date": "2026-10-20",
        "time": "14:00",
        "window_start": null,
        "window_end": null,
        "duration": 30,
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
  "In the afternoon I need a 45-minute meeting for 4 people with a monitor.": {
    "activities": [
      {
        "type": "meeting",
        "title": "In the afternoon I need a 45-minute meeting for 4 people with a monitor.",
        "date": "2026-10-20",
        "time": null,
        "window_start": "13:00",
        "window_end": "18:00",
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
  "Afternoon meeting, 4 people, 45 minutes.": {
    "activities": [
      {
        "type": "meeting",
        "title": "Afternoon meeting, 4 people, 45 minutes.",
        "date": "2026-10-20",
        "time": null,
        "window_start": "13:00",
        "window_end": "18:00",
        "duration": 45,
        "people": 4,
        "features": [],
        "participants": [],
        "existing_id": null,
        "unclear": []
      }
    ],
    "questions": []
  },
  "In the afternoon, a meeting for 4 people, 45 minutes, monitor.": {
    "activities": [
      {
        "type": "meeting",
        "title": "In the afternoon, a meeting for 4 people, 45 minutes, monitor.",
        "date": "2026-10-20",
        "time": null,
        "window_start": "13:00",
        "window_end": "18:00",
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
  "午後に4人で45分、モニターを使って企画を相談したいです。": {
    "activities": [
      {
        "type": "meeting",
        "title": "午後に4人で45分、モニターを使って企画を相談したいです",
        "date": "2026-10-20",
        "time": null,
        "window_start": "13:00",
        "window_end": "18:00",
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
  "Today 13:00 review for 4 people, 30 minutes, monitor": {
    "activities": [
      {
        "type": "meeting",
        "title": "Today 13:00 review for 4 people, 30 minutes, monitor",
        "date": "2026-10-20",
        "time": "13:00",
        "window_start": null,
        "window_end": null,
        "duration": 30,
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
  "Today 15:00 review for 4 people, 30 minutes, monitor": {
    "activities": [
      {
        "type": "meeting",
        "title": "Today 15:00 review for 4 people, 30 minutes, monitor",
        "date": "2026-10-20",
        "time": "15:00",
        "window_start": null,
        "window_end": null,
        "duration": 30,
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
  "Today 13:00 review for 4 people, 30 minutes": {
    "activities": [
      {
        "type": "meeting",
        "title": "Today 13:00 review for 4 people, 30 minutes",
        "date": "2026-10-20",
        "time": "13:00",
        "window_start": null,
        "window_end": null,
        "duration": 30,
        "people": 4,
        "features": [],
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

const today='2026-10-20';
const need={date:'2026-10-21',time:'10:00',duration:60,people:4,kind:'meeting',features:['monitor']};

// Minimal DOM adapter for the actual employee event handlers. Visual QA uses a real browser.
async function employeeUi({dayParser,role='employee',now=()=>new Date(today+'T01:00:00Z')}={}){
  const elements=new Map();
  class Element {
    constructor(id=''){this.id=id;this.dataset={};this.disabled=false;this.value='';this.checked=false;this.options=[];this.clientHeight=400;this.textContent='';this.events={};this.attributes={};this.open=false;
      this.classList={toggle(){}};const styles=new Map();this.style={getPropertyValue:k=>styles.get(k),setProperty:(k,v)=>styles.set(k,v)};}
    addEventListener(type,callback){(this.events[type]??=[]).push(callback);}
    setAttribute(name,value){this.attributes[name]=value;}
    hasAttribute(name){return Object.hasOwn(this.attributes,name);}
    closest(){return this;}
    getBoundingClientRect(){return {left:0,top:0};}
    getAnimations(){return [];}
    showModal(){this.open=true;}close(){this.open=false;}
    set innerHTML(value){
      this.html=value;this.children=[];
      this.options=Array.from(value.matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g),m=>({value:m[1],textContent:m[2]}));
      for(const match of value.matchAll(/<(button|select)\b([^>]*)>([\s\S]*?)<\/\1>/g)){
        const child=new Element();child.textContent=match[3].replace(/<[^>]*>/g,'');
        for(const attr of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)){
          child.attributes[attr[1]]=attr[2]??'';
          if(attr[1]==='id'){child.id=attr[2];elements.set(child.id,child);}
          if(attr[1].startsWith('data-'))child.dataset[attr[1].slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=attr[2]??'';
          if(attr[1]==='disabled')child.disabled=true;
        }
        if(match[1]==='select')child.value=match[3].match(/<option value="([^"]*)"/)?.[1]??'';
        this.children.push(child);
      }
    }
    get innerHTML(){return this.html??'';}
    querySelectorAll(selector){return selector==='button,select'||selector==='button'?this.children??[]:[];}
  }
  const html=readFileSync(new URL('./office.html',import.meta.url),'utf8');
  for(const match of html.matchAll(/id="([^"]+)"/g))elements.set(match[1],new Element(match[1]));
  const areaButtons=Object.keys(layoutAreas).map(area=>{const button=new Element();button.dataset.area=area;return button;});
  const get=id=>elements.get(id),document={title:'',getElementById:get,querySelector:()=>new Element(),
    querySelectorAll:selector=>selector==='[data-area]'?areaButtons:selector.includes('#intentForm button')?[get('parseButton')]:[],documentElement:{}};
  const handle=createOfficeService({now,dayParser:dayParser??mockDayParser});
  let nextWorkspace=null;
  async function request(path,options={}){
    if(path==='/api/office/workspace'&&nextWorkspace){const value=nextWorkspace;nextWorkspace=null;return Response.json(value);}
    try{return await handle(new Request('http://demo.test'+path,options));}catch(error){return errorResponse(error);}
  }
  const source=readFileSync(new URL('./office.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
  const run=new (Object.getPrototypeOf(async function(){}).constructor)('ApiSession','ReviewComparison','translator','applyLanguage','document','window','fetch','location','history','innerWidth','innerHeight','matchMedia','setInterval','clearInterval','layoutAreas','layoutPosition','renderOfficeLayout',source+'\nreturn {sync,showBooking};');
  const controller=await run(ApiSession,ReviewComparison,translator,()=>{},document,{addEventListener(){}},request,
    {search:'?lang=en',pathname:role==='admin'?'/admin':'/office.html',href:'http://demo.test/'+(role==='admin'?'admin':'office.html')+'?lang=en'}, {replaceState(){}},1280,720,()=>({matches:true}),()=>1,()=>{},layoutAreas,layoutPosition,renderOfficeLayout);
  async function fire(element,type,event={}){
    for(const listener of element.events[type]??[])await listener({preventDefault(){},...event});
    for(let i=0;get('parseButton').disabled;i++){if(i>1000)throw new Error('UI remained busy');await new Promise(resolve=>setImmediate(resolve));}
  }
  if(!dayParser){get('key').value='test_key_not_real_1234567890';get('model').value='gpt-4.1-mini';await fire(get('keyForm'),'submit');}
  return {get,controller,request,queueSnapshot:value=>{nextWorkspace=value;},
    configureGpt:async()=>{get('key').value='test_key_not_real_1234567890';get('model').value='gpt-4.1-mini';await fire(get('keyForm'),'submit');},
    submit:async message=>{get('intent').value=message;await fire(get('intentForm'),'submit');},
    attend:async(room,time)=>{get('attendanceRoom').value=room;get('attendanceTime').value=time;await fire(get('attendanceForm'),'submit');},
    click:async attribute=>{
      const button=get('agendaContent').querySelectorAll('button').find(b=>b.hasAttribute(attribute));
      assert.ok(button,'Missing action '+attribute+' in '+get('agendaContent').innerHTML);
      assert.equal(button.disabled,false);await fire(get('agendaContent'),'click',{target:button});
    },
    tab:async id=>fire(get(id),'click'),
    change:async(id,value)=>{get(id).value=value;await fire(get(id),'change');},
    agreeClear:async()=>{get('bulkClearAgree').checked=true;await fire(get('bulkClearAgree'),'change');},
    clearRecords:async()=>fire(get('bulkClearForm'),'submit'),
    chooseSeat:async id=>{get('roomChoice').value=id;await fire(get('agendaContent'),'change',{target:get('roomChoice')});},
    area:async area=>fire(areaButtons.find(b=>b.dataset.area===area),'click'),
    inspectRoom:async id=>fire(get('officeMap'),'click',{target:{closest:selector=>selector==='[data-room]'?{dataset:{room:id}}:null}}),
    language:async value=>{get('language').value=value;await fire(get('language'),'change');},
    state:async()=> (await request('/api/office/workspace')).json()
  };
}

test('回帰：座席＋会議→取消→再予約後は現在2件、旧記録は履歴から後続だけを開く',async()=>{
  const common={date:today,window_start:null,window_end:null,participants:[],existing_id:null,unclear:[]};
  const ui=await employeeUi({dayParser:async()=>({activities:[
    {...common,type:'desk',title:'Desk work',time:'09:00',duration:120,people:1,features:['area_east','window','quiet','low_airflow','avoid_cold']},
    {...common,type:'meeting',title:'Discussion',time:'13:00',duration:45,people:4,features:['monitor']}
  ],questions:[]})});
  await ui.configureGpt();await ui.submit('Morning quiet window seat, afternoon meeting.');
  await ui.click('data-confirm');const seat=(await ui.state()).meetings[0];
  await ui.tab('proposalsTab');await ui.tab('agendaNext');await ui.click('data-confirm');
  const original=(await ui.state()).meetings.at(-1);
  const cancel=async()=>{const button=ui.get('agendaContent').children.find(b=>b.dataset.meetingAction==='cancel');assert.ok(button);button.attributes['data-test-cancel']='';await ui.click('data-test-cancel');};
  await cancel();assert.equal((await ui.state()).current_meetings.length,1);
  assert.match(ui.get('agendaContent').innerHTML,/data-rebook/);
  await ui.click('data-rebook');
  assert.equal((await ui.state()).meeting_history[0].replacement_id,null,'Searching must not mark a successful rebooking');
  await ui.click('data-confirm');let state=await ui.state(),current=state.meetings.at(-1);
  assert.deepEqual(state.current_meetings.map(r=>r.id),[seat.id,current.id]);assert.equal(state.meeting_history.length,1);
  assert.equal(state.meeting_history[0].replacement_id,current.id);assert.equal(current.rebooked_from,original.id);
  await ui.tab('bookingsTab');assert.equal(ui.get('agendaPage').textContent,'2 / 2');
  await ui.tab('agendaPrevious');assert.match(ui.get('agendaContent').innerHTML,/Desk work/);
  await ui.tab('agendaNext');assert.ok(ui.get('agendaContent').children.every(b=>b.dataset.bookingId===current.id));
  await ui.tab('historyTab');assert.equal(ui.get('agendaPage').textContent,'1 / 1');
  assert.match(ui.get('agendaContent').innerHTML,/Follow-up record exists|View follow-up record/);
  assert.doesNotMatch(ui.get('agendaContent').innerHTML,/data-rebook|data-meeting-action|data-attendance-record/);
  await ui.click('data-view-booking');assert.ok(ui.get('agendaContent').children.every(b=>b.dataset.bookingId===current.id));
  await cancel();await ui.click('data-rebook');await ui.click('data-confirm');state=await ui.state();current=state.meetings.at(-1);
  await ui.controller.showBooking(original.id);assert.doesNotMatch(ui.get('agendaContent').innerHTML,/data-rebook/);
  await ui.click('data-view-booking');assert.ok(ui.get('agendaContent').children.every(b=>b.dataset.bookingId===current.id));
  await ui.click('data-meeting-action');state=await ui.state();assert.equal(state.current_meetings.length,1);
  assert.equal(state.current_meetings[0].id,current.id);assert.ok(state.meeting_history.some(r=>r.id===seat.id),'An unstarted earlier desk cannot stay actionable after the simulated clock advances');
  await ui.controller.showBooking(seat.id);assert.match(ui.get('agendaContent').innerHTML,/Start time passed/);assert.doesNotMatch(ui.get('agendaContent').innerHTML,/data-meeting-action/);
  await ui.controller.showBooking(current.id);await ui.click('data-meeting-action');
  await ui.tab('bookingsTab');assert.equal(ui.get('agendaPage').textContent,'0 / 0');assert.match(ui.get('agendaContent').innerHTML,/No active bookings/);
  await ui.language('ja');await ui.controller.showBooking(original.id);assert.match(ui.get('agendaContent').innerHTML,/後続の記録/);assert.doesNotMatch(ui.get('agendaContent').innerHTML,/data-rebook/);
});

test('回帰：管理者の削除・復元・終了を現在と履歴へ同期し、過去カードの操作を残さない',async()=>{
  const ui=await employeeUi();await ui.submit('Today 13:00 review for 4 people, 30 minutes');await ui.click('data-confirm');
  let record=(await ui.state()).meetings[0];
  const mutate=async(action)=>{
    const response=await ui.request('/api/office/admin/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation_id:randomUUID(),meeting_id:record.id,expected_version:record.version,confirmed:true})});
    assert.equal(response.status,200);record=(await response.json()).record;await ui.controller.sync();
  };
  await mutate('delete');assert.equal(ui.get('agendaPage').textContent,'0 / 0');assert.doesNotMatch(ui.get('agendaContent').innerHTML,/data-meeting-action/);
  await ui.tab('historyTab');assert.match(ui.get('agendaContent').innerHTML,/Deleted/);assert.doesNotMatch(ui.get('agendaContent').innerHTML,/data-rebook|data-meeting-action/);
  await mutate('restore');assert.equal((await ui.state()).current_meetings.length,1);assert.equal(ui.get('agendaPage').textContent,'0 / 0');
  await ui.tab('bookingsTab');await ui.click('data-meeting-action');record=(await ui.state()).meetings[0];
  await mutate('finish');assert.equal(ui.get('agendaPage').textContent,'0 / 0');assert.equal(ui.get('personA').style.getPropertyValue('--x'),layoutPosition('meeting').x+'%');
  await ui.tab('historyTab');assert.match(ui.get('agendaContent').innerHTML,/Completed/);assert.doesNotMatch(ui.get('agendaContent').innerHTML,/data-rebook|data-meeting-action/);
  await mutate('delete');await mutate('restore');assert.equal((await ui.state()).current_meetings.length,0);assert.equal(record.status,'completed');
});

test('回帰：日付だけ進んだ同期でも現在予約を再描画し、前日の開始ボタンを残さない',async()=>{
  const ui=await employeeUi();await ui.submit('Today 13:00 review for 4 people, 30 minutes');await ui.click('data-confirm');
  const state=await ui.state();assert.equal(state.current_meetings.length,1);
  ui.queueSnapshot({...state,today:'2026-10-21',current_meetings:[],meeting_history:state.meetings});await ui.controller.sync();
  assert.equal(ui.get('agendaPage').textContent,'0 / 0');assert.doesNotMatch(ui.get('agendaContent').innerHTML,/data-meeting-action/);
  await ui.tab('historyTab');assert.match(ui.get('agendaContent').innerHTML,/Start time passed/);
});

test('管理UI一括削除：範囲と件数の確認が必要、削除後は除外表示・日英切替・復元先を案内',async()=>{
  const ui=await employeeUi({role:'admin'});await ui.tab('adminClear');
  assert.equal(ui.get('bulkClearDialog').open,true);assert.match(ui.get('bulkClearCounts').innerHTML,/3/);assert.equal(ui.get('bulkClearConfirm').disabled,true);
  await ui.clearRecords();assert.equal((await ui.state()).reservations.filter(r=>r.deleted).length,0);
  await ui.change('bulkRange','all');assert.match(ui.get('bulkClearCounts').innerHTML,/93/);
  await ui.agreeClear();assert.equal(ui.get('bulkClearConfirm').disabled,false);
  await ui.clearRecords();assert.equal(ui.get('bulkClearDialog').open,false);assert.equal(ui.get('liveState').value,'not_deleted');
  assert.equal((await ui.state()).reservations.filter(r=>!r.deleted).length,0);assert.match(ui.get('notice').textContent,/93 records cleared/);
  assert.doesNotMatch(ui.get('adminResults').innerHTML,/data-row=/);
  await ui.language('ja');assert.match(ui.get('notice').textContent,/93.*一括削除/);
  await ui.change('liveState','deleted');assert.match(ui.get('adminResults').innerHTML,/data-admin-action="restore"/);
  await ui.tab('adminClear');assert.equal(ui.get('bulkClearConfirm').disabled,true);assert.equal(ui.get('bulkClearAgree').disabled,true);
});

test('管理UI一括削除：確認後の更新は実行せず、再確認でチェックをリセットする',async()=>{
  const ui=await employeeUi({role:'admin'});await ui.tab('adminClear');await ui.agreeClear();
  const response=await ui.request('/api/office/admin/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation_id:randomUUID(),confirmed:true,data:{title:'New record',date:today,time:'16:00',duration:30,people:1,space_id:'office-c04',booked_by:'Admin',assigned_to:'other',features:[]}})});
  assert.equal(response.status,200);await ui.clearRecords();
  assert.equal(ui.get('bulkClearDialog').open,true);assert.match(ui.get('bulkClearStatus').textContent,/Records changed/);assert.equal(ui.get('bulkClearConfirm').disabled,true);
  assert.equal((await ui.state()).reservations.filter(r=>r.deleted).length,0);
  await ui.tab('bulkClearPreview');assert.equal(ui.get('bulkClearAgree').checked,false);assert.match(ui.get('bulkClearCounts').innerHTML,/4/);
  await ui.agreeClear();await ui.clearRecords();assert.equal((await ui.state()).reservations.filter(r=>r.deleted).length,4);
});

test('回帰：別画面で再予約しても元の提案は最新の記録へ収束し、古い再予約を促さない',async()=>{
  const ui=await employeeUi();await ui.submit('Today 13:00 review for 4 people, 30 minutes');await ui.click('data-confirm');
  const first=(await ui.state()).meetings[0];await ui.tab('proposalsTab');
  const post=async(path,body)=>{
    const response=await ui.request('/api/office/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,200);return response.json();
  };
  await post('transition',{meeting_id:first.id,action:'cancel'});
  const next=await post('rebook',{meeting_id:first.id}),proposal=next.proposals[0];
  const second=(await post('confirm',{plan_id:next.plan_id,proposal_id:proposal.id,space_id:proposal.candidates[0].id,confirmed:true})).booking;
  await ui.controller.sync();assert.match(ui.get('agendaContent').innerHTML,/View follow-up record/);assert.doesNotMatch(ui.get('agendaContent').innerHTML,/data-rebook|data-confirm/);
  await ui.click('data-view-booking');assert.ok(ui.get('agendaContent').children.every(b=>b.dataset.bookingId===second.id));
  await post('transition',{meeting_id:second.id,action:'cancel'});await ui.controller.sync();
  await ui.tab('proposalsTab');assert.doesNotMatch(ui.get('agendaContent').innerHTML,/data-rebook/);
  await ui.click('data-view-booking');assert.match(ui.get('agendaContent').innerHTML,/data-rebook/);
  await ui.click('data-rebook');await ui.click('data-confirm');assert.equal((await ui.state()).current_meetings.length,1);
});

test('実フロント：他者予約の部屋を手動指定→参加登録→取消→再登録→開始→終了、予約は増えない',async()=>{
  const ui=await employeeUi();await ui.submit('Today 14:00 project review for 4 people, 30 minutes, whiteboard');
  const before=await ui.state();
  await ui.click('data-attendance');assert.equal(ui.get('attendanceDialog').open,true);
  assert.equal(ui.get('attendanceRoom').value,'');
  await ui.attend('office-c04','14:00');
  assert.equal(ui.get('attendanceDialog').open,false);
  const registered=(await ui.state()).meetings[0];assert.equal(registered.source,'attendance');
  assert.equal((await ui.state()).reservations.length,before.reservations.length);
  assert.match(ui.get('agendaContent').innerHTML,/Attending|attendance/);
  assert.ok(ui.get('agendaContent').children.every(b=>!b.hasAttribute('data-confirm')));
  const cancel=ui.get('agendaContent').children.find(b=>b.dataset.meetingAction==='cancel');
  cancel.attributes['data-withdraw']='';await ui.click('data-withdraw');
  assert.match(ui.get('notice').textContent,/Other people’s bookings were not changed/);
  await ui.tab('proposalsTab');await ui.click('data-attendance-record');await ui.attend('office-c04','14:00');
  const current=(await ui.state()).meetings.at(-1);assert.notEqual(current.id,registered.id);
  await ui.tab('proposalsTab');await ui.click('data-view-booking');
  assert.ok(ui.get('agendaContent').children.every(b=>b.dataset.bookingId===current.id));
  await ui.click('data-meeting-action');
  assert.equal(ui.get('personA').style.getPropertyValue('--x'),layoutPosition('meeting','office-c04').x+'%');
  assert.equal((await ui.state()).meetings.at(-1).status,'in_progress');
  await ui.click('data-meeting-action');
  assert.equal(ui.get('personA').style.getPropertyValue('--x'),layoutPosition('meeting').x+'%');
  assert.equal((await ui.state()).meetings.at(-1).status,'completed');
  assert.deepEqual((await ui.state()).reservations,before.reservations);
});

test('実フロント：参加先の登録失敗後もフォームを保持し、修正して続行できる',async()=>{
  const ui=await employeeUi();await ui.submit('Today 14:00 meeting for 4 people, 30 minutes, monitor');
  await ui.click('data-attendance');await ui.attend('office-f12','14:00');
  assert.equal(ui.get('attendanceDialog').open,true);assert.notEqual(ui.get('attendanceStatus').textContent,'');
  assert.equal((await ui.state()).meetings.length,0);
  await ui.attend('office-c04','14:00');assert.equal(ui.get('attendanceDialog').open,false);
  assert.equal((await ui.state()).meetings.length,1);
});

test('実フロント：新GPT抽出契約→MCP推薦→予約→開始→終了、自由な追問は受け取らない',async()=>{
  let calls=0;
  const dayParser=(key,options)=>parseDayPlanWithGpt(key,options,{fetchImpl:async(url,request)=>{
    calls++;const body=JSON.parse(request.body);assert.equal(body.text.format.schema.additionalProperties,false);
    assert.equal('questions' in body.text.format.schema.properties,false);
    const result={input_status:'supported',activities:[{type:'meeting',title:'Review',date:today,time:null,window_start:'13:00',window_end:'15:00',duration:45,people:4,features:['monitor'],participants:[],existing_id:null,uncertainties:[]}]};
    return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}]});
  }});
  const ui=await employeeUi({dayParser});await ui.configureGpt();
  await ui.submit('In the afternoon I need a 45-minute meeting for 4 people with a monitor.');
  assert.equal(ui.get('detailDialog').open,false);assert.equal((await ui.state()).meetings.length,0);
  await ui.click('data-confirm');assert.equal((await ui.state()).meetings[0].time,'13:00');
  await ui.click('data-meeting-action');await ui.click('data-meeting-action');
  assert.equal((await ui.state()).meetings[0].status,'completed');assert.equal(calls,1);
});

test('実フロント：不正なGPT応答で古い候補を残さず、修正後に再解析できる',async()=>{
  let invalid=false;
  const dayParser=(key,options)=>parseDayPlanWithGpt(key,options,{fetchImpl:async()=>{
    const result={input_status:'supported',activities:[{type:'meeting',title:'Review',date:today,time:null,window_start:'13:00',window_end:'15:00',duration:45,people:4,features:['monitor'],participants:[],existing_id:null,uncertainties:[]}]};
    if(invalid)result.questions=['13:00でよいですか？'];
    return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}]});
  }});
  const ui=await employeeUi({dayParser});await ui.configureGpt();await ui.submit('Afternoon meeting, 4 people, 45 minutes.');
  assert.ok(ui.get('agendaContent').children.some(b=>b.hasAttribute('data-confirm')));
  invalid=true;await ui.submit('Changed request');
  assert.equal(ui.get('agendaContent').children.some(b=>b.hasAttribute('data-confirm')),false);
  assert.equal((await ui.state()).meetings.length,0);assert.match(ui.get('notice').textContent,/GPT|valid plan/);
  invalid=false;await ui.submit('Afternoon meeting, 4 people, 45 minutes.');
  await ui.click('data-confirm');assert.equal((await ui.state()).meetings.length,1);
});

test('実フロントGPT：候補がある時刻確認は不足情報として表示せず、詳細へ残す',async()=>{
  const question='13:00でよいですか？';
  const ui=await employeeUi({dayParser:async()=>({activities:[{type:'meeting',title:'Review',date:today,time:null,window_start:'13:00',window_end:'15:00',duration:45,people:4,features:['monitor'],participants:[],existing_id:null,unclear:[]}],questions:[question]})});
  await ui.configureGpt();await ui.submit('In the afternoon, a meeting for 4 people, 45 minutes, monitor.');
  assert.equal(ui.get('detailDialog').open,false);
  await ui.click('data-details');assert.match(ui.get('detailText').textContent,/13:00でよいですか/);
  ui.get('detailDialog').close();
  await ui.click('data-confirm');assert.equal((await ui.state()).meetings[0].time,'13:00');
  await ui.click('data-meeting-action');await ui.click('data-meeting-action');
  assert.equal((await ui.state()).meetings[0].status,'completed');
});

test('実フロントGPT：混在する提案では本当の不足だけを提示し、空の解析結果も説明する',async()=>{
  const complete={type:'meeting',title:'Review',date:today,time:'13:00',window_start:null,window_end:null,duration:30,people:4,features:[],participants:[],existing_id:null,unclear:[]};
  const ui=await employeeUi({dayParser:async()=>({activities:[complete,{...complete,title:'Budget',time:'15:00',people:null}],questions:['13:00でよいですか？']})});
  await ui.configureGpt();await ui.submit('Two meetings.');
  assert.equal(ui.get('detailDialog').open,true);
  assert.match(ui.get('detailText').textContent,/Budget|total number of participants/);
  assert.doesNotMatch(ui.get('detailText').textContent,/13:00でよいですか/);
  const empty=await employeeUi({dayParser:async()=>({activities:[],questions:['Please use Japanese or English.']})});
  await empty.configureGpt();await empty.submit('Unsupported input');
  assert.equal(empty.get('detailDialog').open,true);
  assert.match(empty.get('detailText').textContent,/Please use Japanese or English/);
});

test('実フロントGPT：余分な追問の除去から予約・取消・再予約・開始・終了まで接続する',async()=>{
  for(const question of ['企画相談の正確な開始時間は何時ですか？','企画の相談に参加する人の名前を教えてください。']){
    let calls=0;
    const ui=await employeeUi({dayParser:async()=>{
      calls++;
      return {activities:[{type:'meeting',title:'企画相談',date:today,time:null,window_start:'13:00',window_end:'15:00',duration:45,people:4,features:['monitor'],participants:[],existing_id:null,unclear:[question]}],questions:[question]};
    }});
    await ui.configureGpt();await ui.submit('午後に4人で45分、モニターを使って企画を相談したいです。');
    assert.equal(calls,1);assert.equal(ui.get('detailDialog').open,false);
    await ui.click('data-confirm');
    const original=(await ui.state()).meetings.at(-1);
    assert.equal(original.time,'13:00');assert.equal(original.status,'reserved');
    const cancel=ui.get('agendaContent').children.find(b=>b.dataset.meetingAction==='cancel');
    cancel.attributes['data-test-cancel']='';await ui.click('data-test-cancel');
    await ui.tab('proposalsTab');await ui.click('data-rebook');await ui.click('data-confirm');
    const current=(await ui.state()).meetings.at(-1);
    assert.notEqual(current.id,original.id);assert.equal(current.status,'reserved');
    await ui.click('data-meeting-action');assert.equal((await ui.state()).meetings.at(-1).status,'in_progress');
    await ui.click('data-meeting-action');assert.equal((await ui.state()).meetings.at(-1).status,'completed');
    assert.equal(calls,1, 'Transitions and rebooking do not require another model call');
  }
});

test('実フロントGPT：本当に人数・時間が不足する追問は表示し、予約を作らない',async()=>{
  const question='人数と開始時間を教えてください。';
  const ui=await employeeUi({dayParser:async()=>({activities:[{type:'meeting',title:'Review',date:today,time:null,window_start:null,window_end:null,duration:45,people:null,features:[],participants:[],existing_id:null,unclear:[question]}],questions:[question]})});
  await ui.configureGpt();await ui.submit('I would like a meeting.');
  assert.equal(ui.get('detailDialog').open,true);
  assert.equal(ui.get('agendaContent').children.some(b=>b.hasAttribute('data-confirm')),false);
  assert.equal((await ui.state()).meetings.length,0);
});

test('実フロント処理：取消→再提案→確定→新ID表示→開始→終了と履歴切替',async()=>{
  const ui=await employeeUi();
  await ui.submit('Today 13:00 review for 4 people, 30 minutes, monitor');await ui.click('data-confirm');
  const original=(await ui.state()).meetings[0].id;
  await ui.click('data-meeting-action'); // Start, then finish this first record.
  await ui.click('data-meeting-action');
  await ui.submit('Today 15:00 review for 4 people, 30 minutes, monitor');await ui.click('data-confirm');
  const booking=(await ui.state()).meetings.at(-1);
  const cancel=ui.get('agendaContent').children.find(b=>b.dataset.meetingAction==='cancel');
  assert.ok(cancel);
  // click() selects by attribute; target the cancel branch explicitly.
  cancel.attributes['data-test-cancel']='';await ui.click('data-test-cancel');
  await ui.tab('proposalsTab');assert.match(ui.get('agendaContent').innerHTML,/Find rooms to book again/);
  await ui.click('data-rebook');assert.equal((await ui.state()).meetings.length,2);
  await ui.click('data-confirm');const current=(await ui.state()).meetings.at(-1);
  assert.notEqual(current.id,booking.id);assert.equal(current.status,'reserved');
  assert.ok(ui.get('agendaContent').children.every(b=>b.dataset.bookingId===current.id));
  await ui.tab('bookingsTab');assert.ok(ui.get('agendaContent').children.every(b=>b.dataset.bookingId===current.id));
  await ui.click('data-meeting-action');assert.equal((await ui.state()).meetings.find(r=>r.id===current.id).status,'in_progress');
  await ui.click('data-meeting-action');assert.equal((await ui.state()).meetings.find(r=>r.id===current.id).status,'completed');
  assert.equal((await ui.state()).meetings.find(r=>r.id===original).status,'completed');
});

test('実フロント処理：管理者削除→古い提案の再検索→新規予約と新IDへの選択',async()=>{
  const ui=await employeeUi();await ui.submit('Today 13:00 review for 4 people, 30 minutes');await ui.click('data-confirm');
  const booking=(await ui.state()).meetings[0];
  const deleted=await ui.request('/api/office/admin/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation_id:randomUUID(),meeting_id:booking.id,expected_version:booking.version,confirmed:true})});
  assert.equal(deleted.status,200);await ui.controller.sync();await ui.tab('proposalsTab');
  assert.match(ui.get('agendaContent').innerHTML,/data-replan/);await ui.click('data-replan');await ui.click('data-confirm');
  const current=(await ui.state()).meetings[0];assert.notEqual(current.id,booking.id);assert.equal(current.status,'reserved');
  assert.ok(ui.get('agendaContent').children.every(b=>b.dataset.bookingId===current.id));
});

test('実フロント処理：遅れた古い応答は取消状態を戻さず、同じ版数の再起動は提案を消す',async()=>{
  const ui=await employeeUi();await ui.submit('Today 13:00 review for 4 people, 30 minutes');await ui.click('data-confirm');
  const older=await ui.state();
  const cancel=ui.get('agendaContent').children.find(b=>b.dataset.meetingAction==='cancel');cancel.attributes['data-test-cancel']='';
  await ui.click('data-test-cancel');const current=await ui.state();
  ui.queueSnapshot({...older,today});await ui.controller.sync();assert.match(ui.get('agendaContent').innerHTML,/Find rooms to book again/);
  ui.queueSnapshot({...current,today,instance_id:randomUUID(),meetings:[],reservations:[],events:[]});await ui.controller.sync();
  assert.match(ui.get('agendaContent').innerHTML,/Your plan becomes meeting-room and desk suggestions/);
});
async function session(options={}){
  const handler=createOfficeService({now:()=>new Date(today+'T01:00:00Z'),...options});
  let id='';
  async function call(path,body,method='POST',headers={}){
    const request=new Request('http://demo.test/api/office/'+path,{method,headers:{'Content-Type':'application/json','X-Office-Session':id,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    let response;try{response=await handler(request);}catch(error){response=errorResponse(error);}
    return {status:response.status,body:await response.json(),headers:response.headers};
  }
  const opened=await call('session');id=opened.body.session_id;
  return {call,id};
}

test('自然文：ローカル方式を拒否し、Keyなし・API失敗でも代替解析しない',async()=>{
  let calls=0;
  const s=await session({gptParser:async()=>{calls++;throw new Error('mock API unavailable');}});
  for(const mode of ['rules','offline'])assert.equal((await s.call('parse',{message:'Tomorrow 10:00, 4 people, 60 minutes',mode})).status,400);
  assert.equal((await s.call('parse',{message:'Tomorrow 10:00, 4 people, 60 minutes'})).status,401);
  assert.equal(calls,0);
  assert.equal((await s.call('parse',{message:'Plan',mode:'gpt',model:'gpt-4.1-mini'},'POST',{Authorization:'Bearer test_key_not_real_1234567890'})).status,500);
  assert.equal(calls,1);
});

test('推薦：MCPを実際に呼び、定員・設備・時間重複で候補が変わる',async()=>{
  const first=await recommendOfficeRooms(need,[],today);
  assert.deepEqual(first.candidates.map(r=>r.name),['D','E','B','C','G','I','X']);
  assert.deepEqual(first.trace.map(t=>t.name),['search_spaces','query_reservations']);
  assert.equal(first.trace[1].result.total,3);
  assert.equal((await recommendOfficeRooms({...need,people:5},[],today)).candidates[0].name,'E');
  assert.deepEqual((await recommendOfficeRooms({...need,features:['whiteboard']},[],today)).candidates.map(r=>r.name),['D']);
  assert.deepEqual((await recommendOfficeRooms({...need,time:'14:00'},[],today)).candidates.map(r=>r.name),['E','B','C','G','I','X']);
  assert.equal((await recommendOfficeRooms({...need,time:'14:00',features:['quiet']},[],today)).candidates.length,0);
  for(const feature of ['projector','window'])assert.ok((await recommendOfficeRooms({...need,features:[feature]},[],today)).candidates.length>0);
  assert.equal((await recommendOfficeRooms({...need,features:['隔音']},[],today)).candidates.length,0);
  assert.equal((await recommendOfficeRooms({...need,people:50},[],today)).candidates.length,0);
  const quietSeats=(await recommendOfficeRooms({...need,time:'09:00',people:1,kind:'desk',features:['quiet']},[],today)).candidates;
  assert.deepEqual(quietSeats.map(r=>r.id).sort(),officeRooms.filter(r=>r.kind==='desk'&&r.features.includes('quiet')).map(r=>r.id).sort());
  assert.ok(quietSeats.some(r=>r.name==='F-12'));
});

test('推薦：終端時刻は隣接可能、営業時間外・過去・無効値を拒否',async()=>{
  assert.ok((await recommendOfficeRooms({...need,time:'13:00'},[],today)).candidates.some(r=>r.name==='D'));
  assert.ok((await recommendOfficeRooms({...need,time:'15:00'},[],today)).candidates.some(r=>r.name==='D'));
  for(const request of [{...need,time:'08:00'},{...need,time:'17:30'},{...need,date:'2026-10-19'},{...need,date:'2026-12-01'},{...need,people:0},{...need,duration:0},{...need,time:'25:00'},{...need,features:['x'.repeat(61)]},{...need,extra:'bypass'}])await assert.rejects(recommendOfficeRooms(request,[],today));
});

test('模擬予約：確認・作成・再検索・取消を一連で処理する',async()=>{
  const s=await session();const input={request:need,space_id:'office-c04',request_id:randomUUID(),confirmed:true};
  assert.equal((await s.call('book',{...input,confirmed:false})).status,400);
  const booked=await s.call('book',input);assert.equal(booked.status,201);
  assert.equal((await s.call('book',input)).body.booking.id,booked.body.booking.id);
  const repeated=await s.call('recommend',{request:need});assert.deepEqual(repeated.body.candidates.map(r=>r.name),['E','B','C','G','I','X']);
  assert.equal((await s.call('book',{...input,request_id:randomUUID()})).status,409);
  assert.equal((await s.call('bookings',undefined,'GET')).body.bookings.length,1);
  assert.equal((await s.call('cancel',{booking_id:booked.body.booking.id})).status,200);
  assert.equal((await s.call('cancel',{booking_id:booked.body.booking.id})).status,404);
  assert.deepEqual((await s.call('recommend',{request:need})).body.candidates.map(r=>r.name),['D','E','B','C','G','I','X']);
  assert.equal((await s.call('bookings',undefined,'GET')).body.bookings.length,0);
});

test('模擬予約：API直接操作でも定員・条件・既存予約を迂回できない',async()=>{
  const s=await session();
  for(const [request,space_id] of [[{...need,people:6},'office-c04'],[{...need,features:['whiteboard']},'office-m02'],[{...need,time:'14:00'},'office-c04'],[need,'invented-room']])assert.equal((await s.call('book',{request,space_id,request_id:randomUUID(),confirmed:true})).status,409);
  assert.equal((await s.call('bookings',undefined,'GET')).body.bookings.length,0);
});

test('模擬予約：同時確認は1件だけ成功し、操作IDの使い回しを拒否',async()=>{
  const s=await session();const input={request:need,space_id:'office-c04',request_id:randomUUID(),confirmed:true};
  const results=await Promise.all([s.call('book',input),s.call('book',{...input,request_id:randomUUID()})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  assert.equal((await s.call('bookings',undefined,'GET')).body.bookings.length,1);
  const success=results.find(r=>r.status===201).body.booking;
  assert.equal((await s.call('book',{...input,request_id:success.request_id,space_id:'office-m02'})).status,409);
});

test('独立セッション：他のページの予約を変更せず、削除と失効を処理',async()=>{
  const handler=createOfficeService({now:()=>new Date(today+'T01:00:00Z')});
  async function invoke(path,body,id){let response;try{response=await handler(new Request('http://demo.test/api/office/'+path,{method:'POST',headers:{'X-Office-Session':id??''},body:JSON.stringify(body??{})}));}catch(e){response=errorResponse(e);}return {status:response.status,body:await response.json()};}
  const a=(await invoke('session')).body.session_id,b=(await invoke('session')).body.session_id;
  const booked=await invoke('book',{request:need,space_id:'office-c04',request_id:randomUUID(),confirmed:true},a);
  assert.equal((await invoke('cancel',{booking_id:booked.body.booking.id},b)).status,404);
  assert.deepEqual((await invoke('recommend',{request:need},b)).body.candidates.map(r=>r.name),['D','E','B','C','G','I','X']);
  const s=await session();assert.equal((await s.call('session',undefined,'DELETE')).status,200);assert.equal((await s.call('recommend',{request:need})).status,401);
  let instant=new Date(today+'T01:00:00Z');const expiry=await session({now:()=>instant});instant=new Date(instant.getTime()+30*60*1000);assert.equal((await expiry.call('recommend',{request:need})).status,401);
});

test('Office API：別オリジン、異常本文、無効な解析方式を拒否',async()=>{
  const s=await session();
  assert.equal((await s.call('session',{},'POST',{Origin:'https://evil.test'})).status,403);
  assert.equal((await s.call('session',{},'POST',{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await s.call('parse',{message:'x',mode:'gpt'})).status,401);
  assert.equal((await s.call('parse',{message:'x'.repeat(2001)})).status,400);
  assert.equal((await s.call('parse',{message:'x',mode:'unknown'})).status,400);
  assert.equal((await s.call('unknown',{})).status,404);
});

test('GPT解析：模擬応答を検証し、モデルには要望だけを渡す',async()=>{
  const fake='test_key_not_real_1234567890';let calls=0;
  const parsed=await parseOfficeIntentWithGpt(fake,{message:'明日10時、4人、1時間、画面が必要',model:'gpt-4.1-mini',today},{fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(options.body);
    assert.equal(body.store,false);assert.equal(body.text.format.type,'json_schema');assert.equal(body.text.format.strict,true);
    assert.equal('tools' in body,false);assert.equal(JSON.stringify(body).includes('reservations.csv'),false);
    return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({...need,unclear:[]})}]}]});
  }});
  assert.equal(calls,1);assert.deepEqual(parsed,{...need,unclear:[]});
  await assert.rejects(parseOfficeIntentWithGpt(fake,{message:'x',model:'gpt-4.1-mini',today},{fetchImpl:async()=>Response.json({output:[]})}));
  await assert.rejects(parseOfficeIntentWithGpt(fake,{message:'x',model:'gpt-4.1-mini',today},{fetchImpl:async()=>Response.json({error:fake},{status:401})}),error=>!error.message.includes(fake));
});

test('GPT入口：抽出結果を検証し、予約せずに条件確認へ返す',async()=>{
  const s=await session({gptParser:async()=>({...need,unclear:[]})});
  const result=await s.call('parse',{message:'自由な要望',mode:'gpt',model:'gpt-4.1-mini'},'POST',{Authorization:'Bearer test_key_not_real_1234567890'});
  assert.equal(result.status,200);assert.equal(result.body.parser,'gpt');assert.equal(result.body.ready,true);
  assert.equal((await s.call('bookings',undefined,'GET')).body.bookings.length,0);
  const invalid=await session({gptParser:async()=>({...need,people:999,unclear:[]})});
  assert.equal((await invalid.call('parse',{message:'自由な要望',mode:'gpt',model:'gpt-4.1-mini'},'POST',{Authorization:'Bearer test_key_not_real_1234567890'})).status,400);
});

test('Office画面：要望は自由入力、IDと動的処理が接続し自動劇場を使わない',()=>{
  const html=readFileSync(new URL('./office.html',import.meta.url),'utf8');const source=readFileSync(new URL('./office.js',import.meta.url),'utf8');
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);
  const dynamicIds=[...source.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  for(const match of source.matchAll(/\$\('([^']+)'\)/g))assert.ok(ids.includes(match[1])||dynamicIds.includes(match[1]),match[1]);
  assert.match(html,/textarea id="intent"/);assert.match(source,/pagehide/);assert.match(source,/pageshow/);
  assert.doesNotMatch(html,/person-b|装飾用のデモ社員B/);
  assert.doesNotMatch(source,/localStorage|sessionStorage|indexedDB|document\.cookie|setTimeout\(play|const scenes/);
  assert.match(readFileSync(new URL('./office.css',import.meta.url),'utf8'),/prefers-reduced-motion/);
  const service=readFileSync(new URL('./office-service.js',import.meta.url),'utf8');assert.doesNotMatch(service,/from ['"]\.\/data\.js|readFile|writeFile/);
});

test('TSG配置：9室の定員と互換ID、Hと未照合席の予約対象外を維持する',async()=>{
  const state=await (await employeeUi()).state();
  assert.deepEqual(Object.fromEntries(state.rooms.filter(r=>r.area==='meeting').map(r=>[r.name,r.capacity])),
    {D:4,E:6,A:6,B:8,C:8,F:8,G:8,I:8,X:30});
  assert.equal(state.rooms.find(r=>r.id==='office-c04').name,'D');
  assert.equal(state.rooms.find(r=>r.id==='office-m02').name,'E');
  assert.equal(state.rooms.find(r=>r.id==='office-f12').area,null);
  assert.ok(!state.rooms.some(r=>r.mapLabel==='H'));
  assert.ok(state.rooms.filter(r=>r.area==='meeting').every(r=>r.capacity_source==='spaces.csv'&&r.features_source==='simulation'));
});
test('TSG描画：4分区と日英、図形IDの安定性、未知H、外部資産なし',()=>{
  const counts={meeting:79,east:219,west:182,connect:82};
  for(const zone of Object.keys(layoutAreas)){
    const ja=renderOfficeLayout(zone,'ja'),en=renderOfficeLayout(zone,'en');
    const ids=Array.from(ja.svg.matchAll(/data-seat-id="([^"]+)"/g),m=>m[1]);
    assert.equal(ids.length,new Set(ids).size);assert.equal(ids.length,ja.seatCount);
    assert.deepEqual(ids,Array.from(en.svg.matchAll(/data-seat-id="([^"]+)"/g),m=>m[1]));
    assert.equal(ids.length,counts[zone]);assert.deepEqual(ja.box,layoutAreas[zone].box);
    assert.doesNotMatch(en.svg,/<script|<image|href=|原图|入口指引|中央通道/);
    assert.equal(renderOfficeLayout(zone,'ja').svg,ja.svg);
  }
  const meeting=renderOfficeLayout('meeting','en',{'office-c04':'in_progress'});
  assert.match(meeting.svg,/class="layoutRoom in_progress"[^>]*data-room="office-c04"/);
  assert.match(meeting.svg,/data-room="unbound-h"/);
  assert.match(meeting.svg,/Room H \/ \? \/ Unbound/);
  assert.equal((meeting.svg.match(/class="layoutRoom /g)??[]).length,10);
});
test('TSG推薦：人数4・6・8・9・30・31を実MCPで照合し、設備不明と衝突を除外する',async()=>{
  const request={...need,time:'09:00',features:[]};
  for(const [people,capacity] of [[4,4],[6,6],[8,8],[9,30],[30,30]]){
    const result=await recommendOfficeRooms({...request,people},[],today,{includeSeeded:false});
    assert.equal(result.candidates[0].capacity,capacity);
    assert.ok(result.candidates.every(r=>r.capacity>=people&&r.mapLabel!=='H'));
    assert.deepEqual(result.trace.map(x=>x.name),['search_spaces','query_reservations']);
  }
  assert.equal((await recommendOfficeRooms({...request,people:31},[],today,{includeSeeded:false})).candidates.length,0);
  assert.deepEqual((await recommendOfficeRooms({...request,people:9,features:['monitor']},[],today,{includeSeeded:false})).candidates.map(r=>r.name),['X']);
  assert.equal((await recommendOfficeRooms({...request,people:9,features:['whiteboard']},[],today,{includeSeeded:false})).candidates.length,0);
  const conflicts=[{id:'x-busy',space_id:'tsg-room-x',date:request.date,start:540,end:600,status:'reserved'}];
  assert.equal((await recommendOfficeRooms({...request,people:9},conflicts,today,{includeSeeded:false})).candidates.length,0);
});
test('実フロントTSG：別区切替を保ち、開始でDに移動、参加記録も使用中、終了で入口に戻る',async()=>{
  const ui=await employeeUi();
  await ui.area('east');assert.match(ui.get('layoutSvg').innerHTML,/east-seat-001/);assert.equal(ui.get('personA').hidden,true);
  await ui.submit('Today 14:00 project review for 4 people, 30 minutes, whiteboard');
  await ui.click('data-attendance');await ui.attend('office-c04','14:00');
  await ui.click('data-meeting-action');
  assert.match(ui.get('layoutSvg').innerHTML,/class="layoutRoom in_progress"[^>]*data-room="office-c04"/);
  assert.equal(ui.get('personA').hidden,false);
  assert.equal(ui.get('personA').style.getPropertyValue('--x'),layoutPosition('meeting','office-c04').x+'%');
  await ui.area('west');assert.match(ui.get('layoutSvg').innerHTML,/west-seat-001/);assert.equal(ui.get('personA').hidden,true);
  await ui.area('meeting');assert.equal(ui.get('personA').hidden,false);
  await ui.click('data-meeting-action');
  assert.equal(ui.get('personA').style.getPropertyValue('--x'),layoutPosition('meeting').x+'%');
  assert.doesNotMatch(ui.get('layoutSvg').innerHTML,/class="layoutRoom in_progress"/);
});

test('実フロント個人席：三区の推薦→取消→再予約→開始移動→終了、既存予約と競合を検査',async()=>{
  for(const zone of ['east','west','connect']){
    const activity={type:'desk',title:'Personal work',date:today,time:'09:00',duration:60,people:1,window_start:null,window_end:null,
      features:['area_'+zone,'window','quiet','low_airflow','avoid_cold'],participants:[],existing_id:null,unclear:[]};
    const ui=await employeeUi({dayParser:async()=>({activities:[activity],questions:[]})});await ui.configureGpt();
    await ui.submit('Today 09:00 for one hour, a quiet window seat with weak airflow.');
    assert.match(ui.get('layoutSvg').innerHTML,new RegExp(zone+'-seat-'));assert.ok(ui.get('roomChoice').value.startsWith(zone+'-seat-'));
    assert.equal((await ui.state()).meetings.length,0);
    const id=ui.get('roomChoice').value;await ui.inspectRoom(id);
    assert.match(ui.get('roomDemoNote').textContent,/Simulated seat/);assert.match(ui.get('roomComfort').textContent,/fictional/);ui.get('roomDialog').close();
    await ui.click('data-confirm');let record=(await ui.state()).meetings[0];assert.equal(record.request.kind,'desk');
    await ui.tab('proposalsTab');await ui.submit('Same work plan');assert.match(ui.get('agendaContent').innerHTML,/Use existing booking/);
    await ui.tab('bookingsTab');
    const cancel=ui.get('agendaContent').querySelectorAll('button').find(b=>b.dataset.meetingAction==='cancel');
    // The helper clicks by attribute; expose a distinct test attribute on the real cancel action.
    cancel.attributes['data-test-cancel']='';await ui.click('data-test-cancel');assert.equal((await ui.state()).meetings[0].status,'cancelled');
    await ui.click('data-rebook');await ui.click('data-confirm');
    record=(await ui.state()).meetings.find(r=>r.status==='reserved');assert.notEqual(record.id,(await ui.state()).meetings.find(r=>r.status==='cancelled').id);
    await ui.click('data-meeting-action');const point=layoutPosition(zone,record.space_id);
    assert.equal(ui.get('personA').hidden,false);assert.equal(ui.get('personA').style.getPropertyValue('--x'),point.x+'%');
    assert.match(ui.get('layoutSvg').innerHTML,new RegExp('layoutSeat in_progress[^>]*data-seat-id="'+record.space_id+'"'));
    await ui.click('data-meeting-action');assert.equal((await ui.state()).meetings.find(r=>r.id===record.id).status,'completed');
    assert.equal(ui.get('personA').hidden,true);
    const state=await ui.state();assert.equal(state.clock.time,'10:00');
    await ui.language('ja');await ui.inspectRoom(id);assert.match(ui.get('roomComfort').textContent,/架空/);
  }
});
test('TSG時刻状態：未開始予約を使用中にせず、終了・取消・削除は占有を残さない',async()=>{
  const ui=await employeeUi(),snapshot=await ui.state();
  snapshot.revision++;snapshot.clock.time='14:10';ui.queueSnapshot({...snapshot,today});
  await ui.controller.sync();
  assert.doesNotMatch(ui.get('layoutSvg').innerHTML,/class="layoutRoom in_progress"/);
  assert.match(ui.get('layoutSvg').innerHTML,/class="layoutRoom reserved"[^>]*data-room="office-c04"/);
});

test('会議室の施設案内：JSONを表示せず、設備アイコン・定員・当日予定を日英で表示する',async()=>{
  const ui=await employeeUi();await ui.inspectRoom('office-c04');
  assert.equal(ui.get('roomDialog').open,true);assert.equal(ui.get('detailDialog').open,false);
  assert.equal(ui.get('roomDetailTitle').textContent,'Meeting room D');
  assert.equal(ui.get('roomCapacity').textContent,'4 people maximum');
  assert.match(ui.get('roomFacilityList').innerHTML,/<svg/);
  for(const text of ['Monitor','Whiteboard','Quiet space'])assert.ok(ui.get('roomFacilityList').innerHTML.includes(text));
  assert.match(ui.get('roomDemoNote').textContent,/demo settings/);
  assert.match(ui.get('roomBookingList').innerHTML,/14:00–15:00/);
  assert.doesNotMatch(ui.get('roomFacilityList').innerHTML+ui.get('roomBookingList').innerHTML,/<pre|capacity_source|features_source|space_id|reservation_id/);
  await ui.language('ja');
  assert.equal(ui.get('roomDetailTitle').textContent,'会議室 D');assert.match(ui.get('roomDemoNote').textContent,/デモ用/);
  await ui.inspectRoom('tsg-room-a');
  for(const text of ['プロジェクター','窓際'])assert.ok(ui.get('roomFacilityList').innerHTML.includes(text));
});
test('施設案内と推薦：全室の模擬設備を共用し、複合条件でも未対応を満たした扱いにしない',async()=>{
  const ui=await employeeUi(),state=await ui.state();
  const meetingRooms=state.rooms.filter(r=>r.kind==='meeting');
  assert.ok(new Set(meetingRooms.map(r=>r.features.join(','))).size>=5);
  for(const room of meetingRooms){
    await ui.inspectRoom(room.id);
    assert.equal((ui.get('roomFacilityList').innerHTML.match(/<li class="roomFacility">/g)??[]).length,room.features.length);
    const request={...need,time:'09:00',people:room.capacity,features:room.features};
    const result=await recommendOfficeRooms(request,[],today,{includeSeeded:false});
    assert.ok(result.candidates.some(r=>r.id===room.id),room.name);
  }
  const request={...need,time:'09:00',people:8,features:['monitor','projector']};
  assert.deepEqual((await recommendOfficeRooms(request,[],today,{includeSeeded:false})).candidates.map(r=>r.name),['I','X']);
  await ui.inspectRoom('unbound-h');
  assert.equal(ui.get('roomCapacity').textContent,'Capacity unverified');
  assert.match(ui.get('roomFacilityList').innerHTML,/unverified/);
  assert.match(ui.get('roomBookingList').innerHTML,/unavailable/);
});
test('施設案内の同期：予約のページング・削除除外・取消・利用中・表示文字の安全性',async()=>{
  const ui=await employeeUi();await ui.inspectRoom('office-c04');const snapshot=await ui.state();
  const base={space_id:'office-c04',name:'D',date:today,time:'13:00',end_time:'13:30',status:'cancelled',deleted:false};
  const title='<img src=x onerror=alert(1)>';
  snapshot.reservations=Array.from({length:5},(_,i)=>({...base,id:'room-row-'+i,title:i===0?title:'Schedule '+i}));
  snapshot.reservations.push({...base,id:'deleted',title:'hidden deleted',deleted:true});
  snapshot.revision++;ui.queueSnapshot({...snapshot,today});await ui.controller.sync();
  assert.equal(ui.get('roomBookingPage').textContent,'1 / 3');
  assert.match(ui.get('roomBookingList').innerHTML,/&lt;img/);assert.doesNotMatch(ui.get('roomBookingList').innerHTML,/<img|hidden deleted/);
  assert.equal(ui.get('roomAvailability').textContent,'Free now (simulated)');
  await ui.tab('roomBookingNext');assert.equal(ui.get('roomBookingPage').textContent,'2 / 3');
  snapshot.reservations=[{...base,id:'active',title:'In use',status:'in_progress'}];snapshot.revision++;
  ui.queueSnapshot({...snapshot,today});await ui.controller.sync();
  assert.equal(ui.get('roomAvailability').textContent,'In use');
  assert.equal(ui.get('roomBookingPage').textContent,'1 / 1');
});
