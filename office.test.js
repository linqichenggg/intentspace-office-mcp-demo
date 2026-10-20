import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {parseOfficeIntent,recommendOfficeRooms,createOfficeService} from './office-service.js';
import {parseOfficeIntentWithGpt,parseDayPlanWithGpt} from './llm.js';
import {errorResponse} from './http-utils.js';
import {ApiSession,ReviewComparison} from './session.js';
import {translator} from './ui-i18n.js';

const today='2026-10-20';
const need={date:'2026-10-21',time:'10:00',duration:60,people:4,kind:'meeting',features:['monitor']};

// Minimal DOM adapter for the actual employee event handlers. Visual QA uses a real browser.
async function employeeUi({dayParser}={}){
  const elements=new Map();
  class Element {
    constructor(id=''){this.id=id;this.dataset={};this.disabled=false;this.value='';this.textContent='';this.events={};this.attributes={};this.open=false;
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
  const get=id=>elements.get(id),document={title:'',getElementById:get,querySelector:()=>new Element(),
    querySelectorAll:selector=>selector.includes('#intentForm button')?[get('parseButton')]:[],documentElement:{}};
  const handle=createOfficeService({now:()=>new Date(today+'T01:00:00Z'),...(dayParser?{dayParser}:{})});
  let nextWorkspace=null;
  async function request(path,options={}){
    if(path==='/api/office/workspace'&&nextWorkspace){const value=nextWorkspace;nextWorkspace=null;return Response.json(value);}
    try{return await handle(new Request('http://demo.test'+path,options));}catch(error){return errorResponse(error);}
  }
  const source=readFileSync(new URL('./office.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
  const run=new (Object.getPrototypeOf(async function(){}).constructor)('ApiSession','ReviewComparison','translator','applyLanguage','document','window','fetch','location','history','innerWidth','innerHeight','matchMedia','setInterval','clearInterval',source+'\nreturn {sync,showBooking};');
  get('parserMode').value='rules';
  const controller=await run(ApiSession,ReviewComparison,translator,()=>{},document,{addEventListener(){}},request,
    {search:'?lang=en',pathname:'/office.html',href:'http://demo.test/office.html?lang=en'}, {replaceState(){}},1280,720,()=>({matches:true}),()=>1,()=>{});
  async function fire(element,type,event={}){
    for(const listener of element.events[type]??[])await listener({preventDefault(){},...event});
    for(let i=0;get('parseButton').disabled;i++){if(i>1000)throw new Error('UI remained busy');await new Promise(resolve=>setImmediate(resolve));}
  }
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
    state:async()=> (await request('/api/office/workspace')).json()
  };
}

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
  assert.equal(ui.get('personA').style.getPropertyValue('--x'),'79%');
  assert.equal((await ui.state()).meetings.at(-1).status,'in_progress');
  await ui.click('data-meeting-action');
  assert.equal(ui.get('personA').style.getPropertyValue('--x'),'10%');
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
  assert.match(ui.get('agendaContent').innerHTML,/Your meeting suggestions will appear here/);
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

test('自然文：自分の中国語・日本語を日時・人数・設備へ変換',()=>{
  for(const text of ['明天上午十点，四个人开一个小时，需要屏幕','明日午前10時から4人で1時間、モニター付きの会議室','2026年10月21日10:00から11:00まで4人、モニター','2026-10-21 10:00-11:00，4人，需要显示器']){
    const result=parseOfficeIntent(text,today);
    assert.equal(result.ready,true,text);
    const {unclear,...draft}=result.draft;assert.deepEqual(draft,need,text);
  }
  const half=parseOfficeIntent('明天下午一点半，3个人，1小时半，需要白板',today);
  assert.equal(half.draft.time,'13:30');assert.equal(half.draft.duration,90);
  const minute=parseOfficeIntent('今天下午2時30分，2人，1時間',today);
  assert.equal(minute.draft.time,'14:30');assert.equal(minute.draft.duration,60);
  assert.equal(parseOfficeIntent('来週金曜日14:00から2人で30分',today).draft.date,'2026-10-30');
  assert.equal(parseOfficeIntent('后天上午九点，1人专注工作半小时',today).draft.duration,30);
  assert.equal(parseOfficeIntent('明天09:00，一人集中工作30分钟，需要安静和屏幕',today).draft.kind,'desk');
});

test('自然文：不足・曖昧・未知の条件を勝手に補完しない',()=>{
  const vague=parseOfficeIntent('明天下午找个房间',today);
  assert.equal(vague.ready,false);assert.deepEqual(vague.missing,['開始時刻','所要時間','合計人数']);
  assert.equal(parseOfficeIntent('明天2点，4人，1小时',today).draft.time,null);
  assert.equal(parseOfficeIntent('明天10:00，我和3位同事开1小时',today).draft.people,null);
  assert.deepEqual(parseOfficeIntent('明天14:00，4人，1小时，不需要屏幕',today).draft.features,[]);
  assert.ok(parseOfficeIntent('明天14:00，4人，1小时，需要投影和靠窗',today).draft.features.includes('window'));
  assert.ok(parseOfficeIntent('明天14:00，4人，1小时，需要隔音',today).draft.features.includes('隔音'));
  assert.ok(parseOfficeIntent('明天14:00，4人，1小时，需要USB-C',today).draft.features.includes('USB-C'));
  assert.equal(parseOfficeIntent('明天14:00，4人，1小时，需要屏幕或者白板',today).ready,false);
  assert.throws(()=>parseOfficeIntent('2026-02-30 14:00，4人，1小时',today));
  assert.throws(()=>parseOfficeIntent('',today));
  assert.equal(parseOfficeIntent('昨天14:00，4人，1小时',today).draft.date,null);
});

test('推薦：MCPを実際に呼び、定員・設備・時間重複で候補が変わる',async()=>{
  const first=await recommendOfficeRooms(need,[],today);
  assert.deepEqual(first.candidates.map(r=>r.name),['C-04','M-02']);
  assert.deepEqual(first.trace.map(t=>t.name),['search_spaces','query_reservations']);
  assert.equal(first.trace[1].result.total,3);
  assert.equal((await recommendOfficeRooms({...need,people:5},[],today)).candidates[0].name,'M-02');
  assert.deepEqual((await recommendOfficeRooms({...need,features:['whiteboard']},[],today)).candidates.map(r=>r.name),['C-04']);
  assert.deepEqual((await recommendOfficeRooms({...need,time:'14:00'},[],today)).candidates.map(r=>r.name),['M-02']);
  assert.equal((await recommendOfficeRooms({...need,time:'14:00',features:['quiet']},[],today)).candidates.length,0);
  for(const feature of ['projector','window','隔音'])assert.equal((await recommendOfficeRooms({...need,features:[feature]},[],today)).candidates.length,0);
  assert.equal((await recommendOfficeRooms({...need,people:50},[],today)).candidates.length,0);
  assert.deepEqual((await recommendOfficeRooms({...need,time:'09:00',people:1,kind:'desk',features:['quiet']},[],today)).candidates.map(r=>r.name),['F-12']);
});

test('推薦：終端時刻は隣接可能、営業時間外・過去・無効値を拒否',async()=>{
  assert.ok((await recommendOfficeRooms({...need,time:'13:00'},[],today)).candidates.some(r=>r.name==='C-04'));
  assert.ok((await recommendOfficeRooms({...need,time:'15:00'},[],today)).candidates.some(r=>r.name==='C-04'));
  for(const request of [{...need,time:'08:00'},{...need,time:'17:30'},{...need,date:'2026-10-19'},{...need,date:'2026-12-01'},{...need,people:0},{...need,duration:0},{...need,time:'25:00'},{...need,features:['x'.repeat(61)]},{...need,extra:'bypass'}])await assert.rejects(recommendOfficeRooms(request,[],today));
});

test('模擬予約：確認・作成・再検索・取消を一連で処理する',async()=>{
  const s=await session();const input={request:need,space_id:'office-c04',request_id:randomUUID(),confirmed:true};
  assert.equal((await s.call('book',{...input,confirmed:false})).status,400);
  const booked=await s.call('book',input);assert.equal(booked.status,201);
  assert.equal((await s.call('book',input)).body.booking.id,booked.body.booking.id);
  const repeated=await s.call('recommend',{request:need});assert.deepEqual(repeated.body.candidates.map(r=>r.name),['M-02']);
  assert.equal((await s.call('book',{...input,request_id:randomUUID()})).status,409);
  assert.equal((await s.call('bookings',undefined,'GET')).body.bookings.length,1);
  assert.equal((await s.call('cancel',{booking_id:booked.body.booking.id})).status,200);
  assert.equal((await s.call('cancel',{booking_id:booked.body.booking.id})).status,404);
  assert.equal((await s.call('recommend',{request:need})).body.candidates.length,2);
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
  assert.equal((await invoke('recommend',{request:need},b)).body.candidates.length,2);
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
