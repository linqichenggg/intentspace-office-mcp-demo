import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateDayPlan, allocateDayPlan, sameMeeting, normalizeDayPlanClarifications, validateGptExtraction, gptUncertaintyFields } from './day-plan.js';
import { recommendOfficeRooms } from './office-service.js';
import { parseDayPlanWithGpt } from './llm.js';
import { messages, reservationStatusLabel } from './ui-i18n.js';

// Fixed model-response fixtures: no NLP implementation or network requests in these tests.
const aiFixtures={
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
  "午後に4人で45分、モニターを使って相談したいです。": {
    "activities": [
      {
        "type": "meeting",
        "title": "午後に4人で45分、モニターを使って相談したいです",
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
  "Tomorrow 13:00 meeting for 4 people, 30 minutes, USB-C required": {
    "activities": [
      {
        "type": "meeting",
        "title": "Tomorrow 13:00 meeting for 4 people, 30 minutes, USB-C required",
        "date": "2026-10-21",
        "time": "13:00",
        "window_start": null,
        "window_end": null,
        "duration": 30,
        "people": 4,
        "features": [
          "USB-C"
        ],
        "participants": [],
        "existing_id": null,
        "unclear": []
      }
    ],
    "questions": []
  },
  "田中と午後に4人で45分、USB-Cを使って相談します。": {
    "activities": [
      {
        "type": "meeting",
        "title": "田中と午後に4人で45分、USB-Cを使って相談します",
        "date": "2026-10-20",
        "time": null,
        "window_start": "13:00",
        "window_end": "18:00",
        "duration": 45,
        "people": 4,
        "features": [
          "USB-C"
        ],
        "participants": [],
        "existing_id": null,
        "unclear": []
      }
    ],
    "questions": []
  },
  "午前は資料作成に集中します。午後に4人で45分、モニターを使って企画を相談したいです。15:00から18:00は別の予定があります。": {
    "activities": [
      {
        "type": "focus",
        "title": "午前は資料作成に集中します",
        "date": "2026-10-20",
        "time": "09:00",
        "window_start": "09:00",
        "window_end": "12:00",
        "duration": 180,
        "people": 1,
        "features": [],
        "participants": [],
        "existing_id": null,
        "unclear": []
      },
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
      },
      {
        "type": "unavailable",
        "title": "15:00から18:00は別の予定があります",
        "date": "2026-10-20",
        "time": "15:00",
        "window_start": null,
        "window_end": null,
        "duration": 180,
        "people": 1,
        "features": [],
        "participants": [],
        "existing_id": null,
        "unclear": []
      }
    ],
    "questions": []
  },
  "I will focus on documentation in the morning. In the afternoon I need a 45-minute project meeting for 4 people with a monitor. I am unavailable from 15:00 to 18:00.": {
    "activities": [
      {
        "type": "focus",
        "title": "I will focus on documentation in the morning",
        "date": "2026-10-20",
        "time": "09:00",
        "window_start": "09:00",
        "window_end": "12:00",
        "duration": 180,
        "people": 1,
        "features": [],
        "participants": [],
        "existing_id": null,
        "unclear": []
      },
      {
        "type": "meeting",
        "title": "In the afternoon I need a 45-minute project meeting for 4 people with a monitor",
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
      },
      {
        "type": "unavailable",
        "title": "I am unavailable from 15:00 to 18:00.",
        "date": "2026-10-20",
        "time": "15:00",
        "window_start": null,
        "window_end": null,
        "duration": 180,
        "people": 1,
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

const today='2026-10-20';
const activity={type:'meeting',title:'Project review',date:today,time:null,window_start:'13:00',window_end:'15:00',duration:45,people:4,features:['monitor'],participants:[],existing_id:null,unclear:[]};
const one = value => ({activities:[{...activity,...value}],questions:[]});
const wire = plan => ({input_status:'supported',activities:plan.activities.map(({unclear,...a})=>({...a,uncertainties:[]}))});
const extraction = (value,message='午後に4人で45分、モニターを使って相談したいです。',existing=[]) => validateGptExtraction(value,{message,today,existing});

test('GPT個人席契約：日英の抽出fixtureから柔軟な席と会議を別々に配分する',async()=>{
  for(const locale of ['ja','en']){
    const desk={...activity,type:'desk',title:'Focus seat',people:1,window_start:'09:00',window_end:'12:00',duration:120,features:['area_east','window','quiet','avoid_cold']};
    const mock=async(url,request)=>{
      const body=JSON.parse(request.body);assert.ok(body.text.format.schema.properties.activities.items.properties.type.enum.includes('desk'));
      assert.match(body.instructions,/low_airflow/);assert.match(body.instructions,/Ordinary focus work/);
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(wire({activities:[desk,activity]}))}]}]});
    };
    const plan=await parseDayPlanWithGpt('test_key_not_real_1234567890',{message:messages[locale].planPlaceholder,today,locale,model:'gpt-4.1-mini',existing:[]},{fetchImpl:mock});
    const result=await allocateDayPlan(plan,[],today,recommendOfficeRooms);
    assert.deepEqual(result.proposals.map(p=>p.request.kind),['desk','meeting']);
    assert.equal(result.proposals[0].request.time,'09:00');assert.equal(result.proposals[0].request.duration,120);
    assert.ok(result.proposals[0].candidates.every(r=>r.area==='east'&&r.features.includes('window')&&r.features.includes('quiet')));
    assert.equal(result.proposals[1].request.time,'13:00');
  }
});

test('席と通常の集中作業：人数・時間の不足と重複を規則で検証する',async()=>{
  const desk={...activity,type:'desk',title:'Desk',time:'09:00',window_start:null,window_end:null,duration:60,people:null,features:['area_west']};
  const normal=validateDayPlan({activities:[desk,{...desk,type:'focus',title:'Write',time:'11:00'}],questions:[]},today);
  assert.equal(normal.activities[0].people,1);
  const planned=await allocateDayPlan(normal,[],today,recommendOfficeRooms);
  assert.deepEqual(planned.proposals.map(p=>p.status),['proposed','note']);
  const double=await allocateDayPlan(validateDayPlan({activities:[desk,desk],questions:[]},today),[],today,recommendOfficeRooms);
  assert.equal(double.proposals[1].status,'duplicate_in_plan');
  const multi=await allocateDayPlan(one({...desk,people:2}),[],today,recommendOfficeRooms);assert.ok(multi.proposals[0].issues.includes('seat_single_person'));
  const missing=await allocateDayPlan(one({...desk,people:1,time:null,duration:null}),[],today,recommendOfficeRooms);assert.ok(missing.proposals[0].issues.includes('missing_duration'));assert.ok(missing.proposals[0].issues.includes('missing_window'));
});

test('管理画面：キャンセルなしと事前・事後キャンセルを混同しない',()=>{
  assert.equal(reservationStatusLabel({status:'未利用・キャンセルなし',is_used:false},'en'),'Unused, not cancelled');
  assert.equal(reservationStatusLabel({status:'事前キャンセル',is_used:false},'en'),'Cancelled before start');
  assert.equal(reservationStatusLabel({status:'事後キャンセル',is_used:false},'ja'),'事後キャンセル');
});

test('AI応答fixtureの日英全天計画：集中作業・柔軟な会議・別の予定を分離する',async()=>{
  for(const locale of ['ja','en']){
    const parsed=fixturePlan(locale==='ja'?'午前は資料作成に集中します。午後に4人で45分、モニターを使って企画を相談したいです。15:00から18:00は別の予定があります。': 'I will focus on documentation in the morning. In the afternoon I need a 45-minute project meeting for 4 people with a monitor. I am unavailable from 15:00 to 18:00.');
    assert.deepEqual(parsed.activities.map(a=>a.type),['focus','meeting','unavailable']);
    assert.equal(parsed.activities[1].duration,45);assert.equal(parsed.activities[1].people,4);
    assert.equal(parsed.activities[1].time,null);assert.equal(parsed.activities[2].duration,180);
    const result=await allocateDayPlan(parsed,[],today,recommendOfficeRooms);
    const meeting=result.proposals[1];
    assert.equal(meeting.status,'proposed');assert.equal(meeting.request.time,'13:00');
    assert.deepEqual(meeting.trace.map(x=>x.name),['search_spaces','query_reservations']);
    assert.equal(result.proposals.filter(p=>p.status==='proposed').length,1);
  }
});

test('不足情報・中国語・無効な日付・未知設備を隠さない',async()=>{
  const result=await allocateDayPlan(fixturePlan('午後に会議をしたいです',today),[],today,recommendOfficeRooms);
  assert.equal(result.proposals[0].status,'needs_input');
  assert.ok(result.proposals[0].issues.includes('missing_people'));
  assert.ok(result.proposals[0].issues.includes('missing_duration'));
  assert.deepEqual(validateGptExtraction({input_status:'unsupported_language',activities:[]},{message:'明天需要会议室',today}),{activities:[],questions:['language_only']});
  assert.throws(()=>validateDayPlan(one({date:'2026-02-30'}),today),/invalid_plan/);
  assert.throws(()=>validateDayPlan(one({date:'2026-12-01'}),today),/date_range/);
  assert.throws(()=>validateDayPlan(one({window_start:'15:00',window_end:'13:00'}),today),/invalid_window/);
  const unknown=fixturePlan('Tomorrow 13:00 meeting for 4 people, 30 minutes, USB-C required',today,'en');
  assert.ok(unknown.activities[0].features.includes('USB-C'));
  assert.equal((await allocateDayPlan(unknown,[],today,recommendOfficeRooms)).proposals[0].status,'no_slot');
});

test('GPTの余分な追問：参加者名と正確な開始時刻は有効な時間帯予約を止めない',async()=>{
  for (const question of [
    '企画相談の正確な開始時間は何時ですか？', '開始時刻が未指定です。',
    '企画の相談に参加する人の名前を教えてください。', '誰が参加しますか？', '参加者は誰ですか？',
    'What is the exact start time?', 'Who will participate?', 'Please provide the names of the participants.'
  ]) {
    const input={...one({unclear:[question]}),questions:[question]};
    const result=await allocateDayPlan(input,[],today,recommendOfficeRooms);
    assert.equal(result.proposals[0].status,'proposed',question);
    assert.equal(result.proposals[0].request.time,'13:00',question);
    assert.deepEqual(result.proposals[0].issues,[]);assert.deepEqual(result.questions,[]);
    assert.deepEqual(input.activities[0].unclear,[question], 'Do not mutate the model response');
    assert.deepEqual(result.proposals[0].activity.participants,[]);
  }
  const fixed=await allocateDayPlan({...one({time:'14:00',window_start:null,window_end:null,unclear:['What is the exact start time?']}),questions:[]},[],today,recommendOfficeRooms);
  assert.equal(fixed.proposals[0].request.time,'14:00');
});

test('余分な追問を除いても、本当の不足と曖昧さ・未知設備を維持する',async()=>{
  for (const [changes,issue] of [
    [{people:null},'missing_people'], [{duration:null},'missing_duration'],
    [{window_start:null},'missing_window'], [{window_end:null},'missing_window']
  ]) {
    const result=await allocateDayPlan(one({...changes,unclear:['誰が参加しますか？']}),[],today,recommendOfficeRooms);
    assert.equal(result.proposals[0].status,'needs_input');assert.ok(result.proposals[0].issues.includes(issue));
  }
  for (const question of [
    '開始時間は13時または14時のどちらですか？', '開始時間と所要時間を教えてください。',
    '参加者の名前と参加可否を確認してください。', 'Who will participate and how many people?',
    'What is the start time or the deadline?', 'The requested equipment is ambiguous.',
    '開始時刻を教えてください。機密区分の確認が必要です。',
    '防音は必須ですか？', '企画相談の人数は何人ですか？'
  ]) {
    const result=await allocateDayPlan({...one({unclear:[question]}),questions:[question]},[],today,recommendOfficeRooms);
    assert.equal(result.proposals[0].status,'needs_input',question);assert.deepEqual(result.questions,[question]);
  }
  const missingTime=await allocateDayPlan({...one({window_start:null,window_end:null,unclear:['What is the exact start time?']}),questions:['What is the exact start time?']},[],today,recommendOfficeRooms);
  assert.equal(missingTime.proposals[0].status,'needs_input');assert.equal(missingTime.questions.length,1);
  const unknown=await allocateDayPlan(one({features:['USB-C'],unclear:['誰が参加しますか？']}),[],today,recommendOfficeRooms);
  assert.equal(unknown.proposals[0].status,'no_slot');
  const empty={activities:[],questions:['Please use Japanese or English.']};
  assert.deepEqual(normalizeDayPlanClarifications(empty),empty);
});

test('複数予定：追問の対象を照合し、他の未解決予定と再計画の条件を保つ',async()=>{
  const plan={activities:[{...activity,title:'Review'}, {...activity,title:'Budget',window_start:null,window_end:null}],questions:['Review: What is the exact start time?', 'Budget: What is the exact start time?']};
  const normalized=normalizeDayPlanClarifications(plan);
  assert.deepEqual(normalized.questions,['Budget: What is the exact start time?']);
  assert.deepEqual(normalizeDayPlanClarifications(normalized),normalized);
  const busy={...activity,type:'focus',time:null,window_start:null,window_end:null,unclear:['開始時間は何時ですか？']};
  const result=await allocateDayPlan({activities:[busy,{...activity,unclear:['誰が参加しますか？']}],questions:[]},[],today,recommendOfficeRooms);
  assert.equal(result.proposals[1].status,'needs_input');
  assert.ok(result.proposals[1].issues.includes('unresolved_constraints'));
});

test('複数会議は社員の予定同士も検査し、部分重複と営業時間外を拒否',async()=>{
  const result=await allocateDayPlan({activities:[{...activity},{...activity,title:'Budget review'}],questions:[]},[],today,recommendOfficeRooms);
  assert.equal(result.proposals[0].request.time,'13:00');
  assert.equal(result.proposals[1].request.time,'13:45');
  const fixed=await allocateDayPlan(one({time:'13:30',window_start:null,window_end:null}),[
    {id:'occupied',space_id:'office-c04',date:today,start:780,end:825,status:'reserved',time:'13:00',end_time:'13:45',title:'Other',request:{duration:45},participants:[]}
  ],today,recommendOfficeRooms);
  assert.equal(fixed.proposals[0].status,'no_slot');
  assert.equal((await allocateDayPlan(one({time:'17:45',duration:30,window_start:null,window_end:null}),[],today,recommendOfficeRooms)).proposals[0].status,'needs_input');
});

test('予約済みは再利用、意味的な一致は確認し、取消済みは再提案する',async()=>{
  const record={id:'existing',title:activity.title,date:today,time:'13:00',end_time:'13:45',start:780,end:825,people:4,participants:[],request:{duration:45,features:['monitor']},space_id:'office-c04',status:'reserved'};
  assert.ok(sameMeeting(activity,record));
  assert.equal(sameMeeting({...activity,features:['video']},record),false);
  assert.equal((await allocateDayPlan(one({}),[record],today,recommendOfficeRooms)).proposals[0].status,'existing');
  const possible=(await allocateDayPlan(one({title:'Discuss project progress',existing_id:'existing'}),[record],today,recommendOfficeRooms)).proposals[0];
  assert.equal(possible.status,'possible_duplicate');
  assert.equal((await allocateDayPlan(one({}),[{...record,status:'cancelled'}],today,recommendOfficeRooms)).proposals[0].status,'proposed');
  assert.equal((await allocateDayPlan(one({title:'Other',existing_id:'not-in-this-workspace'}),[record],today,recommendOfficeRooms)).proposals[0].status,'proposed');
  const separate=await allocateDayPlan(one({}),[record],today,recommendOfficeRooms,{distinctIndex:0});
  assert.equal(separate.proposals[0].request.time,'13:45');assert.equal(separate.proposals[0].distinct,true);
});

test('同じ計画内の重複は1件の提案にまとめ、不明な個人予定を無視しない',async()=>{
  const repeated=await allocateDayPlan({activities:[{...activity},{...activity}],questions:[]},[],today,recommendOfficeRooms);
  assert.equal(repeated.proposals[0].status,'proposed');assert.equal(repeated.proposals[1].status,'duplicate_in_plan');
  const unclear=await allocateDayPlan({activities:[{...activity,type:'focus',duration:null},{...activity}],questions:[]},[],today,recommendOfficeRooms);
  assert.equal(unclear.proposals[0].status,'needs_input');assert.equal(unclear.proposals[1].status,'needs_input');
  assert.ok(unclear.proposals[1].issues.includes('unresolved_constraints'));
});

test('個人作業と外出時間、明示の期限を越えて会議を割り当てない',async()=>{
  const busy={...activity,type:'unavailable',title:'Away',time:'13:00',duration:90,people:1};
  const result=await allocateDayPlan({activities:[busy,{...activity}],questions:[]},[],today,recommendOfficeRooms);
  assert.equal(result.proposals[1].status,'no_slot');
  const constrained=await allocateDayPlan(one({time:'14:45',window_end:'15:00'}),[],today,recommendOfficeRooms);
  assert.equal(constrained.proposals[0].status,'no_slot');
});

test('GPT全天計画：厳格な構造、最小の架空コンテキスト、返却値の再検証',async()=>{
  const key='test_key_not_real_1234567890';let count=0;
  const options={message:'My whole day. '+key,model:'gpt-4.1-mini',today,locale:'en',existing:[{id:'x',title:'Review',date:today,status:'reserved',secret:'should-not-send'}]};
  const mock=async(url,request)=>{
    count++;assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(request.body);
    assert.equal(body.store,false);assert.equal(body.text.format.strict,true);assert.equal('tools' in body,false);
    const schema=body.text.format.schema,fields=schema.properties.activities.items.properties;
    assert.deepEqual(schema.required,['input_status','activities']);assert.equal('questions' in schema.properties,false);
    assert.equal('unclear' in fields,false);assert.deepEqual(fields.uncertainties.items.properties.field.enum,gptUncertaintyFields);
    assert.doesNotMatch(request.body,/should-not-send|test_key_not_real/);
    assert.match(request.headers.Authorization,/Bearer/);
    return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(wire(one({})))}]}]});
  };
  assert.deepEqual(await parseDayPlanWithGpt(key,options,{fetchImpl:mock}),one({}));assert.equal(count,1);
  await assert.rejects(parseDayPlanWithGpt(key,options,{fetchImpl:async()=>Response.json({status:'incomplete',output:[]})}),/model_output/);
  await assert.rejects(parseDayPlanWithGpt(key,options,{fetchImpl:async()=>Response.json({output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(wire(one({people:999})))}]}]})}),/model_output/);
});

test('GPT抽出契約：時間帯・任意の名前・未指定の人数と時間はプログラムで扱う',async()=>{
  const result=extraction(wire(one({})));assert.deepEqual(result,one({}));
  const ready=await allocateDayPlan(result,[],today,recommendOfficeRooms);
  assert.equal(ready.proposals[0].request.time,'13:00');assert.deepEqual(ready.questions,[]);
  for(const [values,issue] of [[{people:null},'missing_people'],[{duration:null},'missing_duration'],[{window_start:null,window_end:null},'missing_window']]){
    const plan=extraction(wire(one(values)));
    assert.deepEqual(plan.questions,[]);assert.deepEqual(plan.activities[0].unclear,[]);
    const blocked=await allocateDayPlan(plan,[],today,recommendOfficeRooms);
    assert.equal(blocked.proposals[0].status,'needs_input');assert.ok(blocked.proposals[0].issues.includes(issue));
  }
});

test('GPT抽出契約：自由な追問・確認・名前の必須化・予約命令・根拠なしの歧義を拒否',()=>{
  const clean=wire(one({}));
  const invalid=[{...clean,questions:['13:00でよいですか？']},
    {...clean,activities:[{...clean.activities[0],unclear:['誰が参加しますか？']}]},
    {...clean,activities:[{...clean.activities[0],space_id:'office-c04'}]},
    {...clean,activities:[{...clean.activities[0],uncertainties:[{field:'participants',evidence:'4人'}]}]},
    {...clean,activities:[{...clean.activities[0],uncertainties:[{field:'time',evidence:'13:00でよいですか？'}]}]},
    {...clean,activities:[{...clean.activities[0],uncertainties:[{field:'people',evidence:' ' }]}]},
    {...clean,input_status:'not_a_plan'}, {...clean,activities:[{...clean.activities[0],people:999}]}];
  for(const value of invalid)assert.throws(()=>extraction(value),/model_output/);
});

test('GPT抽出契約：原文の矛盾はコード化し、勝手に時刻・人数・所要時間を選ばない',async()=>{
  for(const field of ['people','duration','time','features','date','constraints']){
    const raw=wire(one({}));raw.activities[0].uncertainties=[{field,evidence:'条件Aまたは条件B'}];
    const result=extraction(raw,'会議の条件Aまたは条件Bを確認。');
    const issue=field==='constraints'?'unparsed_constraint':'ambiguous_'+field;
    assert.ok(result.activities[0].unclear.includes(issue));
    if(field==='people'||field==='duration')assert.equal(result.activities[0][field],null);
    if(field==='time'){assert.equal(result.activities[0].time,null);assert.equal(result.activities[0].window_start,null);}
    const proposal=(await allocateDayPlan(result,[],today,recommendOfficeRooms)).proposals[0];
    assert.equal(proposal.status,'needs_input');assert.deepEqual(proposal.issues,[issue]);
  }
});

test('GPT抽出契約：全朝の作業と外出を保持し、部分的な未確定作業は会議割当を止める',async()=>{
  const focus={...activity,type:'focus',title:'Focus',people:1,time:null,window_start:'09:00',window_end:'12:00',duration:180,features:[]};
  const away={...activity,type:'unavailable',title:'Away',people:1,time:'15:00',window_start:null,window_end:null,duration:180,features:[]};
  const raw=wire({activities:[focus,{...activity,window_end:'18:00'},away]});
  const result=extraction(raw);assert.equal(result.activities[0].time,'09:00');assert.equal(result.activities[0].duration,180);
  const planned=await allocateDayPlan(result,[],today,recommendOfficeRooms);assert.equal(planned.proposals[1].request.time,'13:00');
  raw.activities[0].duration=30;
  const unresolved=await allocateDayPlan(extraction(raw),[],today,recommendOfficeRooms);
  assert.equal(unresolved.proposals[1].status,'needs_input');assert.ok(unresolved.proposals[0].issues.includes('unresolved_constraints'));
});

test('GPT抽出契約：架空の名前・IDを信用せず、未知設備と未対応入力を隠さない',async()=>{
  const raw=wire(one({participants:['田中','Invented Name'],existing_id:'fake-id',features:['USB-C']}));
  const result=extraction(raw,'田中と午後に4人で45分、USB-Cを使って相談します。');
  assert.deepEqual(result.activities[0].participants,['田中']);assert.equal(result.activities[0].existing_id,null);
  assert.deepEqual(result.activities[0].features,['USB-C']);assert.equal((await allocateDayPlan(result,[],today,recommendOfficeRooms)).proposals[0].status,'no_slot');
  raw.activities[0].existing_id='known';assert.equal(extraction(raw,'田中と相談。',[{id:'known',status:'reserved'}]).activities[0].existing_id,'known');
  assert.equal(extraction(raw,'田中と相談。',[{id:'known',status:'cancelled'}]).activities[0].existing_id,null);
  assert.deepEqual(extraction({input_status:'unsupported_language',activities:[]}),{activities:[],questions:['language_only']});
  assert.deepEqual(extraction({input_status:'not_a_plan',activities:[]}),{activities:[],questions:['no_activities']});
});

test('日英画面：同じ文言キー、Bなし、Key保存なし、ローカル公開資産を限定',()=>{
  assert.deepEqual(Object.keys(messages.ja).sort(),Object.keys(messages.en).sort());
  const html=readFileSync(new URL('./office.html',import.meta.url),'utf8');
  for(const match of html.matchAll(/data-(?:i18n|placeholder|label)="([^"]+)"/g))assert.ok(messages.ja[match[1]],match[1]);
  assert.doesNotMatch(html,/person-b|中文|中国語/);
  const js=readFileSync(new URL('./office.js',import.meta.url),'utf8');
  assert.doesNotMatch(js,/localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.match(js,/api\('transition'/);assert.match(js,/pagehide/);
  const css=readFileSync(new URL('./office.css',import.meta.url),'utf8');
  assert.match(css,/100dvh/);assert.match(css,/prefers-reduced-motion/);
  const web=readFileSync(new URL('./web.js',import.meta.url),'utf8');
  assert.match(web,/files\.set\('\/admin','office\.html'\)/);assert.doesNotMatch(web,/files\.set\([^\n]*meeting-state/);
});
