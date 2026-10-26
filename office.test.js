import {layoutAreas,layoutPosition,layoutSeats,renderOfficeLayout} from './office-layout.js';
import {summarizeEnterpriseComfort,comfortOrder,compareComfort} from './seat-comfort.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {recommendOfficeRooms as recommendCurrentRooms,createOfficeService,officeRooms} from './office-service.js';
import {historicalDemoReservations,createMeetingState} from './meeting-state.js';
import {createSimulatedCalendar,runCalendarAgent} from './calendar-service.js';
import {parseOfficeIntentWithGpt,parseDayPlanWithGpt,runOfficeImprovementAgent} from './llm.js';
import {analyzeRoomFit,validateImprovementDraft} from './office-improvements.js';
import {errorResponse,HttpError} from './http-utils.js';
import {createCalendarUI,calendarMonthDates} from './calendar-ui.js';
import {ApiSession,ReviewComparison} from './session.js';
import {translator,errorKey} from './ui-i18n.js';

// Explicit old calendar only for the established conflict regression fixtures.
const recommendOfficeRooms=(request,bookings,date,options={includeSeeded:true})=>recommendCurrentRooms(request,bookings,date,options);

const fitPeriod={start_date:'2026-10-20',end_date:'2026-10-20'};
function fitFixture(count=3){
  const rooms=[{id:'large',name:'Large',kind:'meeting',capacity:8,features:['monitor','whiteboard']},
    {id:'small',name:'Small',kind:'meeting',capacity:4,features:['monitor']},
    {id:'desk',name:'Desk',kind:'desk',capacity:1,features:[]}];
  const reservations=Array.from({length:count},(_,i)=>({id:'fit-'+i,space_id:'large',date:'2026-10-20',start:540+i*30,end:570+i*30,
    people:3,status:'reserved',source:'admin',deleted:false,request:{features:['monitor']}}));
  return {rooms,reservations};
}
test('会議室改善：閾値と同時刻の小会議室を全件計算し、証拠だけ10件に限定',()=>{
  const data=fitFixture(105),result=analyzeRoomFit(data,fitPeriod);
  assert.equal(result.status,'review');assert.equal(result.eligible_count,105);assert.equal(result.items[0].alternative_count,105);
  assert.equal(result.items[0].evidence.length,10);assert.equal(result.items[0].evidence_total,105);
  assert.equal(result.items[0].oversized_percent,100);assert.equal(result.items[0].action,'review_allocation');
  assert.equal(result.items[0].evidence[0].alternatives[0].id,'small');
  assert.equal(analyzeRoomFit(fitFixture(2),fitPeriod).status,'insufficient_data');
  const full=fitFixture();full.reservations.forEach(record=>record.people=7);
  assert.equal(analyzeRoomFit(full,fitPeriod).status,'no_obvious_issue');
});
test('会議室改善：取消・削除・参加・初期予約・席・未知値・重複を母数にしない',()=>{
  const data=fitFixture(),base=data.reservations[0];
  data.reservations.push({...base,id:'cancel',status:'cancelled'},{...base,id:'delete',deleted:true},
    {...base,id:'attendance',source:'attendance'},{...base,id:'preset',source:'preset'},
    {...base,id:'desk',space_id:'desk',people:1},{...base,id:'unknown',people:null}, {...base});
  const result=analyzeRoomFit(data,fitPeriod);
  assert.equal(result.eligible_count,3);assert.deepEqual(result.excluded,{deleted:1,cancelled:1,attendance:1,preset:1,desk:1,invalid:1,duplicate:1});
});
test('会議室改善：設備、部分重複、隣接時刻、削除・取消済みの空きを区別',()=>{
  const data=fitFixture(),base=data.reservations[0];
  data.reservations.push({...base,id:'blocked',space_id:'small',start:550,end:560,source:'preset'});
  data.reservations[1].request.features=['whiteboard'];
  data.reservations.push({...base,id:'adjacent',space_id:'small',start:630,end:660,source:'preset'},
    {...base,id:'deleted',space_id:'small',start:600,end:630,deleted:true},
    {...base,id:'cancelled',space_id:'small',start:600,end:630,status:'cancelled'});
  const result=analyzeRoomFit(data,fitPeriod).items[0];
  assert.deepEqual(result.evidence.map(record=>record.alternative_status),['blocked','no_compatible_room','available']);
  assert.equal(result.alternative_count,1);
  data.reservations[2].request.features=['whiteboard'];
  assert.equal(analyzeRoomFit(data,fitPeriod).items[0].action,'investigate_constraints');
});
test('会議室改善：期間と未丸めの比率、人数境界を守る',()=>{
  const data=fitFixture(7);
  data.reservations.slice(3).forEach(record=>record.people=7);
  assert.equal(analyzeRoomFit(data,fitPeriod).status,'no_obvious_issue');
  data.reservations.pop();
  assert.equal(analyzeRoomFit(data,fitPeriod).items[0].oversized_percent,50);
  data.reservations[0].date='2026-10-21';
  assert.equal(analyzeRoomFit(data,fitPeriod).status,'no_obvious_issue');
  const boundary=fitFixture();boundary.reservations.forEach(record=>record.people=4);
  assert.equal(analyzeRoomFit(boundary,fitPeriod).items[0].oversized_count,3);
  boundary.reservations.forEach(record=>record.people=5);
  assert.equal(analyzeRoomFit(boundary,fitPeriod).status,'no_obvious_issue');
});
function fitDraft(analysis){return {items:analysis.items.map(item=>({finding_id:item.finding_id,action:item.action,evidence_ids:[item.evidence[0].reservation_id],note:'Review the compatible alternatives with the administrator.'}))};}
test('エラー分類：OpenAI状態・コードを区別し、安全な診断項目だけを保持する',async()=>{
  const key='test_key_not_real_1234567890';
  const cases=[[401,'invalid_api_key',null,'api_key_invalid'],[401,'ip_not_authorized',null,'api_ip_restricted'],[401,null,null,'api_authentication'],
    [403,'unsupported_country_region_territory',null,'api_region_restricted'],[403,'insufficient_permissions',null,'api_permission'],
    [404,'model_not_found',null,'api_model_unavailable'],[404,null,null,'api_not_found'],[400,'invalid_json_schema',null,'api_request_invalid'],
    [400,'unsupported_parameter',null,'api_request_invalid'],[400,'context_length_exceeded',null,'api_context_length'],
    [429,'credit_balance_exhausted','insufficient_quota','api_credit_balance'],[429,'project_spend_limit_exceeded','insufficient_quota','api_project_budget'],
    [429,'organization_spend_limit_exceeded','insufficient_quota','api_org_budget'],[429,'organization_usage_limit_exceeded','insufficient_quota','api_usage_limit'],
    [429,'insufficient_quota',null,'api_quota'],[429,null,'insufficient_quota','api_quota'],[429,'rate_limit_exceeded',null,'api_rate_limit'],
    [429,'slow_down','rate_limit_error','api_rate_limit'],[429,null,null,'api_limit_unknown'],[503,'server_is_overloaded',null,'api_overloaded'],
    [500,null,null,'api_service_error'],[504,null,null,'api_upstream_timeout'],[418,'unknown_error',null,'api_upstream_error']];
  for(const [status,code,type,expected] of cases){
    let failure;
    await assert.rejects(parseOfficeIntentWithGpt(key,{message:'test',model:'gpt-4.1-mini',today},{fetchImpl:async()=>Response.json({error:{message:'Do not expose '+key,code,type,param:'text.format.schema'}},
      {status,headers:{'x-request-id':'req_test_123'}})}),error=>{
      failure=error;
      assert.equal(error.message,expected);assert.equal(error.diagnostics.upstream_status,status);assert.equal(error.diagnostics.request_id,'req_test_123');
      for(const language of ['ja','en'])assert.notEqual(translator(language)(errorKey(error)),expected);
      return true;
    });
    const payload=await errorResponse(failure).json();assert.equal(payload.diagnostics.param,'text.format.schema');assert.doesNotMatch(JSON.stringify(payload),/Do not expose|test_key_not_real/);
  }
});
test('エラー分類：不正・巨大・HTMLの上流本文は公開せず、認証原因を推測しない',async()=>{
  const key='test_key_not_real_1234567890';
  for(const body of ['<html>private provider body</html>','not json',JSON.stringify({error:{message:'x'.repeat(33000)}})]){
    await assert.rejects(parseOfficeIntentWithGpt(key,{message:'x',model:'gpt-4.1-mini',today},{fetchImpl:async()=>new Response(body,{status:401})}),error=>{
      assert.equal(error.message,'api_authentication');assert.equal(error.diagnostics.code,undefined);assert.doesNotMatch(JSON.stringify(error.diagnostics),/private provider|<html>/);return true;
    });
  }
});
test('エラー分類：秘密入りcode・param・request-idや任意の診断項目を返さない',async()=>{
  const key='test_key_not_real_1234567890';
  await assert.rejects(parseOfficeIntentWithGpt(key,{message:'x',model:'gpt-4.1-mini',today},{fetchImpl:async()=>Response.json({error:{code:key,type:'sk-other-secret',param:'input.'+key,message:key}},
    {status:400,headers:{'x-request-id':'req_'+key}})}),error=>{
    assert.deepEqual(error.diagnostics,{source:'openai',upstream_status:400});assert.doesNotMatch(JSON.stringify(error),/test_key|other-secret/);return true;
  });
  const payload=await errorResponse(new HttpError(502,'api_request_invalid',{source:'openai',upstream_status:400,raw_body:key,authorization:key,request_id:'<invalid>'})).json();
  assert.deepEqual(payload.diagnostics,{source:'openai',upstream_status:400});
});
test('エラー分類：ネットワーク・応答JSON・中断・入力未設定を別々に扱う',async()=>{
  const input={message:'x',model:'gpt-4.1-mini',today},key='test_key_not_real_1234567890';
  await assert.rejects(parseOfficeIntentWithGpt(key,input,{fetchImpl:async()=>{throw new TypeError('network failure');}}),error=>error.message==='api_network');
  await assert.rejects(parseOfficeIntentWithGpt(key,input,{fetchImpl:async()=>new Response('not json')}),error=>error.message==='api_response_invalid');
  const controller=new AbortController();controller.abort(new DOMException('stop','AbortError'));
  await assert.rejects(parseOfficeIntentWithGpt(key,input,{signal:controller.signal,fetchImpl:async()=>{throw controller.signal.reason;}}),error=>error.name==='AbortError');
  assert.equal(errorKey(new DOMException('timeout','TimeoutError')),'request_timeout');
  assert.equal(errorKey(new Error('Key appears in an unrelated failure')),'genericError');
  const generic=new Error('unknown authentication');generic.status=401;assert.equal(errorKey(generic),'local_authentication');
});
test('管理画面エラー：Key・権限・パラメータ・残高・証拠を区別して日英詳細を表示する',async()=>{
  for(const [key,status,code] of [['api_key_invalid',401,'invalid_api_key'],['api_permission',502,'insufficient_permissions'],
    ['api_request_invalid',502,'unsupported_parameter'],['api_credit_balance',502,'credit_balance_exhausted'],['agent_evidence_required',502,null]]){
    const ui=await employeeUi({role:'admin',improvementAgent:async()=>{throw new HttpError(status,key,{source:'openai',upstream_status:key==='api_key_invalid'?401:400,...(code?{code}:{}),param:'text.format.schema',request_id:'req_ui_test'});}});
    await ui.adminSection('improvements');await ui.analyzeRooms();assert.equal(ui.get('notice').textContent,translator('en')(key));
    assert.equal(ui.get('errorDetails').hidden,false);await ui.tab('errorDetails');assert.match(ui.get('detailText').textContent,/OpenAI|verified/);
    if(code)assert.match(ui.get('detailText').textContent,new RegExp(code));
    await ui.language('ja');assert.equal(ui.get('notice').textContent,translator('ja')(key));
    assert.doesNotMatch(ui.get('detailText').textContent,/test_key/);assert.equal((await ui.state()).purged_ids.length,0);
  }
});
test('管理画面エラー：デモ接続切断・HTML応答・ブラウザー待機切れをKeyに置き換えない',async()=>{
  for(const [fault,key] of [[()=>{throw new TypeError('demo offline');},'demo_network'],[()=>new Response('<html>proxy error</html>',{status:502}),'demo_response_invalid'],
    [()=>{throw new DOMException('request timed out','TimeoutError');},'request_timeout']]){
    const ui=await employeeUi({role:'admin',transportFault:fault});await ui.adminSection('improvements');await ui.analyzeRooms();
    assert.equal(ui.get('notice').textContent,translator('en')(key));assert.equal(ui.get('errorDetails').hidden,false);assert.equal(ui.get('adminTrace').disabled,true);
  }
});
test('API設定：未送信の設定を接続成功と表示せず、入力形式の不正を区別する',async()=>{
  const ui=await employeeUi({role:'admin'});assert.match(ui.get('keyStatus').textContent,/Connectivity and permissions are checked/);assert.equal(ui.get('keyBadge').textContent,'API configured');
  await ui.adminSection('improvements');assert.match(ui.get('improvementRunStatus').textContent,/checked when analysis runs/);
  assert.equal(errorKey(new Error('OpenAI API Key の形式を確認してください')),'api_key_format');
  assert.equal(errorKey(new Error('GPT のモデル名を確認してください')),'invalid_model');
});
// A model-response fixture only. Production has no local Agent fallback.
function improvementModelFixture({inspect=()=>{},mutate=value=>value,skipEvidence=false,firstTool='get_data_status'}={}){
  return async(url,options)=>{
    const body=JSON.parse(options.body);inspect(body,url);
    const period=JSON.parse(body.input[0].content),outputs=body.input.filter(item=>item.type==='function_call_output').map(item=>JSON.parse(item.output));
    const analysis=outputs.find(item=>item.result?.rule?.min_room_reservations)?.result;
    let name,args;
    if(!outputs.length){name=firstTool;args=firstTool==='search_spaces'?{type:'Area',limit:20}:{};}
    else if(!analysis){name='analyze_room_fit';args={start_date:period.start_date,end_date:period.end_date};}
    else{
      const next=analysis.items.flatMap(item=>item.evidence.slice(0,1)).find(evidence=>!outputs.some(output=>output.result?.record?.reservation_id===evidence.reservation_id));
      if(next&&!skipEvidence){name='get_evidence';args={reservation_id:next.reservation_id};}
      else return Response.json({status:'completed',usage:{input_tokens:12,output_tokens:8},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(mutate({summary:'Review the verified room allocation evidence. Synthetic bookings only.',...fitDraft(analysis)}))}]}]});
    }
    return Response.json({status:'completed',usage:{input_tokens:12,output_tokens:8},output:[{type:'function_call',name,arguments:JSON.stringify(args),call_id:'fixture-'+outputs.length}]});
  };
}
const mockImprovementAgent=(client,key,input,options)=>runOfficeImprovementAgent(client,key,input,{...options,fetchImpl:improvementModelFixture()});
async function runAgentFixture(options={}){
  const reservations=options.reservations??historicalDemoReservations('2026-10-23',officeRooms);
  const handle=createOfficeService({now:()=>new Date('2026-10-23T00:00:00Z'),initialReservations:reservations,
    improvementAgent:(client,key,input,context)=>runOfficeImprovementAgent(options.wrapClient?.(client)??client,key,input,{...context,...options.agentOptions,fetchImpl:(url,request)=>(options.fetchImpl??improvementModelFixture(options))(url,request,handle)})});
  const workspace=await (await handle(new Request('https://demo.test/api/office/workspace'))).json();
  const response=await handle(new Request('https://demo.test/api/office/improvements',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer test_key_not_real_1234567890'},
    body:JSON.stringify({start_date:options.period?.start_date??'2026-10-16',end_date:options.period?.end_date??'2026-10-22',revision:workspace.revision,instance_id:workspace.instance_id,locale:'en',model:'gpt-4.1-mini'})}));
  return {result:await response.json(),handle,workspace};
}
test('Agent改善：モデル選択の複数MCP照会と個別証拠、構造・Key非保存・原文最小化',async()=>{
  const {result}=await runAgentFixture({inspect:(body,url)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(body.store,false);assert.equal(body.text.format.strict,true);assert.match(body.instructions,/English/);
    assert.doesNotMatch(JSON.stringify(body.input),/Small meeting|DEMO-HISTORY \/|booked_by|test_key|category/);
    assert.ok(body.tools.every(tool=>!['create','delete','purge'].includes(tool.name)));
  }});
  assert.equal(result.draft.items.length,2);assert.equal(result.model,'gpt-4.1-mini');
  assert.deepEqual(result.trace.map(step=>step.name),['get_data_status','analyze_room_fit','get_evidence','get_evidence']);
  assert.equal(result.usage.input_tokens,60);assert.equal(result.trace.filter(step=>step.result.result?.record).length,2);
  const analysis=result.analysis;
  for(const mutate of [value=>value.items[0].evidence_ids=['invented'],value=>value.items[0].action='build_rooms',
    value=>value.items.push(value.items[0]),value=>value.items[0].finding_id='invented',value=>value.items=[]]){
    const bad=fitDraft(analysis);mutate(bad);assert.throws(()=>validateImprovementDraft(bad,analysis),/model_output/);
  }
});
test('Agent改善：個別照会の省略・偽の引用・異なる予約内容を成功扱いにしない',async()=>{
  await assert.rejects(runAgentFixture({skipEvidence:true}),/agent_evidence_required/);
  await assert.rejects(runAgentFixture({mutate:value=>{value.items[0].evidence_ids=['invented'];return value;}}),/agent_evidence_required/);
  await assert.rejects(runAgentFixture({wrapClient:client=>({listTools:()=>client.listTools(),callTool:async input=>{const output=await client.callTool(input);if(input.name==='get_evidence')output.structuredContent.result.record.people_count=99;return output;}})}),error=>error.message==='agent_stalled'&&error.diagnostics.agent.trace.some(step=>step.error_code==='evidence_mismatch'));
  const alternate=await runAgentFixture({firstTool:'search_spaces'});assert.equal(alternate.result.trace[0].name,'search_spaces');
});
test('Agent改善：Keyなし・無効モデル・非対応MCPはモデルAPIを呼ばない',async()=>{
  let calls=0;const options={fetchImpl:async()=>{calls++;throw new Error('No network in this test');}};
  const client={listTools:async()=>({tools:[]})},input={...fitPeriod,model:'gpt-4.1-mini'};
  await assert.rejects(runOfficeImprovementAgent(client,'',input,options),error=>error.status===401);
  await assert.rejects(runOfficeImprovementAgent(client,'test_key_not_real_1234567890',{...input,model:'unknown'},options),error=>error.status===400);
  await assert.rejects(runOfficeImprovementAgent(client,'test_key_not_real_1234567890',input,options),error=>error.status===403);
  assert.equal(calls,0);
});
test('Agent改善：調査しない回答・拒否・打切り・形式不正・HTTP失敗で代替提案を作らない',async()=>{
  const finals=[{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"summary":"No evidence","items":[]}'}]}]},
    {status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]},
    {status:'incomplete',output:[]},{status:'completed',output:null},
    {status:'completed',output:[{type:'message',content:[{type:'output_text',text:'not json'}]}]}];
  for(const value of finals)await assert.rejects(runAgentFixture({fetchImpl:async()=>Response.json(value)}),error=>error.status===502);
  for(const status of [401,429,500])await assert.rejects(runAgentFixture({fetchImpl:async()=>new Response('',{status})}),error=>error.status===(status===401?401:502));
  await assert.rejects(runAgentFixture({fetchImpl:async()=>{throw new Error('offline');}}),error=>error.status===502);
  for(const mutate of [value=>({...value,summary:''}),value=>({...value,summary:'x'.repeat(601)}),value=>({...value,extra:true}),
    value=>({...value,items:[]}),value=>({...value,items:value.items.map(item=>({...item,action:'build_rooms'}))})])
    await assert.rejects(runAgentFixture({mutate}),/agent_evidence_required/);
});
test('Agent改善：データ不足と問題未検出も実際にモデルとMCPで調査して説明する',async()=>{
  let requests=0;
  const empty=await runAgentFixture({reservations:[],period:{start_date:'2026-10-23',end_date:'2026-10-23'},inspect:()=>requests++});
  assert.equal(requests,3);assert.equal(empty.result.analysis.status,'insufficient_data');assert.equal(empty.result.draft.items.length,0);
  assert.equal(empty.result.trace.some(step=>step.name==='analyze_room_fit'),true);assert.ok(empty.result.draft.summary);
  const matched=historicalDemoReservations('2026-10-23',officeRooms).filter(record=>record.name==='C');
  const noIssue=await runAgentFixture({reservations:matched});assert.equal(noIssue.result.analysis.status,'no_obvious_issue');assert.equal(noIssue.result.draft.items.length,0);
});
test('Agent改善：未知の書込・期間外照会を実行せず、修正したツール要求は続行する',async()=>{
  const normal=improvementModelFixture();let first=true;const executed=[];
  const {result,handle,workspace}=await runAgentFixture({wrapClient:client=>({listTools:()=>client.listTools(),callTool:input=>{executed.push(input);return client.callTool(input);}}),fetchImpl:async(url,options)=>{
    if(first){first=false;return Response.json({output:[
      {type:'function_call',name:'purge',arguments:'{"range":"all"}',call_id:'write'},
      {type:'function_call',name:'analyze_room_fit',arguments:'{"start_date":"2026-10-01","end_date":"2026-10-22"}',call_id:'outside'},
      {type:'function_call',name:'query_reservations',arguments:'{"start_date":"2026-10-01","end_date":"2026-10-22"}',call_id:'query-outside'}]});}
    return normal(url,options);
  }});
  assert.equal(result.trace.filter(step=>step.result.isError).length,3);assert.equal(result.trace[0].name,'rejected_tool');
  assert.ok(executed.every(input=>input.name!=='purge'&&input.arguments.start_date!=='2026-10-01'));
  const after=await (await handle(new Request('https://demo.test/api/office/workspace'))).json();assert.deepEqual(after,workspace);
});
test('Agent改善：MCPの証拠取得失敗を根拠に数えず、再取得してから引用する',async()=>{
  let failed=false;
  const {result}=await runAgentFixture({wrapClient:client=>({listTools:()=>client.listTools(),callTool:input=>{
    if(input.name==='get_evidence'&&!failed){failed=true;return {isError:true,content:[{type:'text',text:'unavailable'}]};}
    return client.callTool(input);
  }})});
  assert.equal(result.trace.filter(step=>step.result.isError).length,1);
  for(const item of result.draft.items)for(const id of item.evidence_ids)assert.ok(result.trace.some(step=>!step.result.isError&&step.result.result?.record?.reservation_id===id));
});
test('Agent改善：ラウンド・ツール数・文脈上限で停止し、無限調査をしない',async()=>{
  let rounds=0;
  await assert.rejects(runAgentFixture({fetchImpl:async()=>{rounds++;return Response.json({output:[{type:'function_call',name:'get_data_status',arguments:'{}',call_id:'repeat-'+rounds}]});}}),error=>error.message==='agent_stalled'&&error.diagnostics.agent.limit_kind==='stalled');
  assert.equal(rounds,4);
  let executed=0;
  await assert.rejects(runAgentFixture({wrapClient:client=>({listTools:()=>client.listTools(),callTool:input=>{executed++;return client.callTool(input);}}),fetchImpl:async()=>Response.json({output:Array.from({length:21},(_,i)=>({type:'function_call',name:'get_data_status',arguments:'{}',call_id:'many-'+i}))})}),error=>error.message==='agent_tool_limit'&&error.diagnostics.agent.tool_calls===20);
  assert.equal(executed,1);
  await assert.rejects(runAgentFixture({wrapClient:client=>({listTools:()=>client.listTools(),callTool:async input=>{const output=await client.callTool(input);output.structuredContent.result.padding='x'.repeat(180001);return output;}})}),error=>error.message==='agent_context_limit'&&error.diagnostics.agent.limit_kind==='context');
});
test('Agent改善：中断後は追加のモデル・MCPを呼ばない',async()=>{
  const controller=new AbortController();let requests=0;
  await assert.rejects(runAgentFixture({agentOptions:{signal:controller.signal},fetchImpl:async()=>{requests++;controller.abort(new DOMException('Cancelled','AbortError'));throw controller.signal.reason;}}),error=>error.name==='AbortError');
  // Direct signal contract: an already cancelled run never reaches the model.
  const client={listTools:async()=>({tools:['analyze_room_fit','get_evidence'].map(name=>({name,inputSchema:{type:'object'}}))})};
  await assert.rejects(runOfficeImprovementAgent(client,'test_key_not_real_1234567890',{...fitPeriod,model:'gpt-4.1-mini'},
    {signal:controller.signal,fetchImpl:async()=>{requests++;}}),error=>error.name==='AbortError');
  assert.equal(requests,1);
});
test('Agent収束：独立証拠をまとめて取得し、確認後はtool_choice noneでモデルが報告する',async()=>{
  const normal=improvementModelFixture();let requests=0,finals=0;
  const {result}=await runAgentFixture({fetchImpl:async(url,options)=>{
    requests++;const body=JSON.parse(options.body);assert.equal(body.parallel_tool_calls,true);
    const outputs=body.input.filter(item=>item.type==='function_call_output').map(item=>JSON.parse(item.output));
    const analysis=outputs.find(item=>item.result?.rule)?.result;
    if(analysis&&body.tool_choice!=='none'){
      assert.deepEqual(body.tools.map(tool=>tool.name),['get_evidence']);assert.equal(body.tool_choice,'required');
      return Response.json({output:analysis.items.flatMap(item=>item.evidence.slice(0,3)).map((e,index)=>({
        type:'function_call',name:'get_evidence',arguments:JSON.stringify({reservation_id:e.reservation_id}),call_id:'batch-'+index}))});
    }
    if(body.tool_choice==='none'){finals++;assert.deepEqual(body.tools,[]);assert.match(body.input.at(-1).content,/Return the final JSON/);}
    return normal(url,options);
  }});
  assert.equal(requests,4);assert.equal(finals,1);assert.equal(result.rounds,4);
  assert.equal(result.trace.filter(step=>step.name==='get_evidence').length,6);assert.equal(result.draft.items.length,2);
});
test('Agent収束：同じ成功照会を再実行せず、探索2応答後は対象分析へ誘導する',async()=>{
  const normal=improvementModelFixture();let requests=0,statusCalls=0;
  const {result}=await runAgentFixture({wrapClient:client=>({listTools:()=>client.listTools(),callTool:input=>{
    if(input.name==='get_data_status')statusCalls++;return client.callTool(input);
  }}),fetchImpl:async(url,options)=>{
    requests++;const body=JSON.parse(options.body);
    if(requests<=2)return Response.json({output:[{type:'function_call',name:'get_data_status',arguments:'{}',call_id:'same-'+requests}]});
    if(requests===3){assert.deepEqual(body.tool_choice,{type:'function',name:'analyze_room_fit'});assert.deepEqual(body.tools.map(tool=>tool.name),['analyze_room_fit']);}
    return normal(url,options);
  }});
  assert.equal(statusCalls,1);assert.equal(result.trace[1].cached,true);assert.equal(result.draft.items.length,2);
  assert.equal(result.mcp_calls,4);assert.equal(result.cache_hits,1);assert.equal(result.tool_calls,5);
});
test('Agent収束：根拠取得で進捗が2回止まったら理由と未確認件数を残して停止する',async()=>{
  const normal=improvementModelFixture();let calls=0;
  let failure;
  await assert.rejects(runAgentFixture({wrapClient:client=>({listTools:()=>client.listTools(),callTool:input=>{
    if(input.name==='get_evidence')calls++;return client.callTool(input);
  }}),fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);
    if(body.tools.length===1&&body.tools[0].name==='get_evidence')return Response.json({output:[{type:'function_call',name:'get_evidence',arguments:'{"reservation_id":"unknown"}',call_id:'bad-'+body.input.length}]});
    return normal(url,options);
  }}),error=>{failure=error;return error.message==='agent_stalled';});
  assert.equal(calls,0);assert.equal(failure.diagnostics.agent.pending_rooms,2);assert.equal(failure.diagnostics.agent.limit_kind,'stalled');
  assert.equal(failure.diagnostics.agent.trace.filter(step=>step.error_code==='invalid_arguments').length,2);
});
test('Agent収束：報告段階の追加ツール指示を実行せず、失敗ログを返す',async()=>{
  const normal=improvementModelFixture();let statusCalls=0;
  let failure;
  await assert.rejects(runAgentFixture({wrapClient:client=>({listTools:()=>client.listTools(),callTool:input=>{
    if(input.name==='get_data_status')statusCalls++;return client.callTool(input);
  }}),fetchImpl:async(url,options)=>JSON.parse(options.body).tool_choice==='none'
    ?Response.json({output:[{type:'function_call',name:'get_data_status',arguments:'{}',call_id:'ignored-none'}]}):normal(url,options)}),
  error=>{failure=error;return error.message==='agent_finalization_failed';});
  assert.equal(statusCalls,1);assert.equal(failure.diagnostics.agent.phase,'finalize');assert.equal(failure.diagnostics.agent.pending_rooms,0);
  assert.equal(failure.diagnostics.agent.trace.length,4);
});
test('Agent収束：最後の1応答を報告用に確保し、12応答を超える調査をしない',async()=>{
  const normal=improvementModelFixture();let requests=0;
  // Expand independent evidence obligations in the fixture to exercise the fixed round budget.
  const options=count=>({wrapClient:client=>({listTools:()=>client.listTools(),callTool:async input=>{
    const raw=await client.callTool(input);
    if(input.name==='analyze_room_fit'){
      const report=raw.structuredContent.result,base=report.items[0];
      report.items=base.evidence.slice(0,count).map((e,index)=>({...base,finding_id:'budget-'+index,evidence:[e]}));report.review_count=count;
    }
    return raw;
  }}),fetchImpl:async(url,options)=>{
    requests++;if(requests===2)return Response.json({output:[{type:'function_call',name:'search_spaces',arguments:'{"type":"Area"}',call_id:'discovery-two'}]});
    return normal(url,options);
  }});
  let failure;
  await assert.rejects(runAgentFixture(options(10)),error=>{failure=error;return error.message==='agent_round_limit';});
  assert.equal(requests,11);assert.equal(failure.diagnostics.agent.limit,12);assert.equal(failure.diagnostics.agent.pending_rooms,2);
  requests=0;
  const {result}=await runAgentFixture(options(8));assert.equal(requests,12);assert.equal(result.rounds,12);assert.equal(result.draft.items.length,8);
});
test('Agent診断：上流失敗・タイムアウトでも既実行の段階と安全な照会記録を返す',async()=>{
  const normal=improvementModelFixture();
  for(const kind of ['upstream','timeout']){
    let requests=0,failure;
    await assert.rejects(runAgentFixture({fetchImpl:async(url,options)=>{
      if(++requests===1)return normal(url,options);
      if(kind==='timeout')throw new DOMException('test timeout','TimeoutError');
      return Response.json({error:{code:'server_error',message:'PRIVATE BODY'}},{status:500,headers:{'x-request-id':'req_after_tool'}});
    },agentOptions:kind==='timeout'?{signal:{throwIfAborted(){if(requests>1)throw new DOMException('timeout','TimeoutError');},aborted:false}}:{}}),error=>{
      failure=error;return error.message===(kind==='timeout'?'agent_timeout':'api_service_error');
    });
    const payload=await errorResponse(failure).json();assert.equal(payload.diagnostics.agent.trace.length,1);assert.equal(payload.diagnostics.agent.rounds,2);
    assert.doesNotMatch(JSON.stringify(payload),/PRIVATE BODY|test_key_not_real/);
    if(kind==='upstream'){assert.equal(payload.diagnostics.upstream_status,500);assert.equal(payload.diagnostics.request_id,'req_after_tool');}
  }
});
test('Agent診断：失敗用メタデータは件数・名前・引数を制限し、生本文と秘密を除く',async()=>{
  const error=new HttpError(422,'agent_context_limit',{agent:{phase:'evidence',rounds:3,tool_calls:1,context_characters:190000,model:'gpt-4.1-mini',
    raw:'PRIVATE',usage:{input_tokens:10,output_tokens:2,secret:'PRIVATE'},verified_ids:['valid-id','sk-secret'],
    trace:[{name:'get_evidence',arguments:{reservation_id:'valid-id',query:'PRIVATE',secret:'sk-secret'},result:'PRIVATE',is_error:true,error_code:'evidence_mismatch'},
      {name:'PRIVATE',arguments:{reservation_id:'sk-secret'},error_code:'PRIVATE'}]}});
  const payload=await errorResponse(error).json();assert.equal(payload.diagnostics.agent.trace.length,2);
  assert.doesNotMatch(JSON.stringify(payload),/PRIVATE|sk-secret|"result"|"query"/);
  assert.deepEqual(payload.diagnostics.agent.verified_ids,['valid-id']);
});
test('管理画面Agent失敗：調査ログ・具体的上限を日英表示し、Key消去で記録を破棄する',async()=>{
  const ui=await employeeUi({role:'admin',initialReservations:historicalDemoReservations('2026-10-23',officeRooms),includeLegacyPresets:false,
    improvementAgent:(client,key,input,context)=>runOfficeImprovementAgent(client,key,input,{...context,fetchImpl:async()=>Response.json({output:[
      {type:'function_call',name:'get_data_status',arguments:'{}',call_id:'same'}]})})});
  await ui.adminSection('improvements');await ui.analyzeRooms();
  assert.match(ui.get('notice').textContent,/made no progress/);assert.match(ui.get('adminResults').innerHTML,/investigation did not finish/);
  assert.equal(ui.get('adminTrace').disabled,false);await ui.tab('adminTrace');assert.match(ui.get('detailText').textContent,/Model responses: 4/);
  await ui.tab('errorDetails');assert.match(ui.get('detailText').textContent,/Stopping condition/);
  await ui.change('language','ja');await ui.tab('adminTrace');assert.match(ui.get('detailText').textContent,/モデル応答回数: 4/);
  await ui.tab('clearKey');assert.equal(ui.get('adminTrace').disabled,true);assert.doesNotMatch(ui.get('adminResults').innerHTML,/調査を完了/);
});
test('Agent改善：調査中に元データが変わると次のMCPを実行せず失効する',async()=>{
  let executed=0,requests=0;
  await assert.rejects(runAgentFixture({wrapClient:client=>({listTools:()=>client.listTools(),callTool:input=>{executed++;return client.callTool(input);}}),
    fetchImpl:async(_url,_request,handle)=>{
      requests++;await handle(new Request('https://demo.test/api/office/workspace/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"confirmed":true}'}));
      return Response.json({output:[{type:'function_call',name:'get_data_status',arguments:'{}',call_id:'stale'}]});
    }}),error=>error.status===409&&error.message==='state_changed');
  assert.equal(requests,1);assert.equal(executed,0);
});
test('管理画面Agent：失敗後に古い提案を残さず、Key消去で調査と結果を破棄する',async()=>{
  let fail=false;
  const ui=await employeeUi({role:'admin',initialReservations:historicalDemoReservations('2026-10-23',officeRooms),now:()=>new Date('2026-10-23T00:00:00Z'),includeLegacyPresets:false,
    improvementAgent:(...args)=>{if(fail)throw new Error('upstream failure');return mockImprovementAgent(...args);}});
  await ui.adminSection('improvements');await ui.analyzeRooms();assert.match(ui.get('adminResults').innerHTML,/Repeated small-party bookings/);
  fail=true;await ui.analyzeRooms();assert.doesNotMatch(ui.get('adminResults').innerHTML,/Repeated small-party bookings/);assert.equal(ui.get('adminTrace').disabled,true);
  await ui.tab('clearKey');assert.match(ui.get('improvementRunStatus').textContent,/API key is required/);
  let started;const waiting=new Promise(resolve=>{started=resolve;});
  const pendingUi=await employeeUi({role:'admin',improvementAgent:async(_client,_key,_input,{signal})=>{started();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  await pendingUi.adminSection('improvements');const pending=pendingUi.analyzeRooms();await waiting;
  assert.match(pendingUi.get('improvementAnalyze').textContent,/investigating/);assert.equal(pendingUi.get('improvementAnalyze').disabled,true);
  await pendingUi.tab('clearKey');await pending;
  assert.equal(pendingUi.get('improvementAnalyze').disabled,false);assert.equal(pendingUi.get('adminTrace').disabled,true);assert.match(pendingUi.get('notice').textContent,/Key cleared/);
});
test('管理画面Agent：Key必須・単一入口・根拠と調査ログ・日英・期間変更時の失効',async()=>{
  let calls=0;
  const ui=await employeeUi({role:'admin',dayParser:mockDayParser,improvementAgent:async(...args)=>{calls++;return mockImprovementAgent(...args);}});
  await ui.adminSection('improvements');assert.equal(ui.get('improvementForm').hidden,false);
  assert.match(ui.get('adminResults').innerHTML,/Configure an API key/);
  await ui.analyzeRooms();assert.equal(calls,0);assert.match(ui.get('notice').textContent,/Key/);assert.equal(ui.get('settingsDialog').open,true);
  await ui.configureGpt();await ui.analyzeRooms();assert.match(ui.get('adminResults').innerHTML,/Not enough bookings/);
  const workspace=await ui.state(),room=workspace.rooms.find(room=>room.kind==='meeting'&&room.capacity===8&&room.features.includes('monitor'));
  for(const time of ['13:00','14:00','15:00']){
    const response=await ui.request('/api/office/admin/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation_id:randomUUID(),confirmed:true,
      data:{title:'Room fit demo',date:today,time,duration:30,people:3,space_id:room.id,booked_by:'Admin',assigned_to:'other',features:['monitor']}})});
    assert.equal(response.status,200);
  }
  await ui.controller.sync();assert.match(ui.get('adminResults').innerHTML,/Analyze again/);
  await ui.analyzeRooms();assert.match(ui.get('adminResults').innerHTML,/Repeated small-party bookings/);
  assert.equal(calls,2);assert.match(ui.get('adminResults').innerHTML,/gpt-4.1-mini|Review the compatible/);
  await ui.tab('adminTrace');assert.match(ui.get('detailText').textContent,/get_evidence|analyze_room_fit/);
  await ui.language('ja');assert.match(ui.get('adminResults').innerHTML,/再生成/);assert.equal(calls,2);
  await ui.change('improvementStart','2026-10-21');assert.match(ui.get('adminResults').innerHTML,/再分析/);
  await ui.analyzeRooms();assert.match(ui.get('notice').textContent,/期間/);
  await ui.adminSection('live');assert.equal(ui.get('improvementForm').hidden,true);assert.equal(ui.get('adminTrace').disabled,false);
});
test('歴史デモMCP：40件から30件を分析し、予約衝突・正常例・取消・席を区別',async()=>{
  const initialReservations=historicalDemoReservations('2026-10-23',officeRooms);
  const handler=createOfficeService({now:()=>new Date('2026-10-23T00:00:00Z'),initialReservations});
  const request=async(start,end)=>{
    const response=await handler(new Request('http://demo.test/api/office/data/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'analyze_room_fit',arguments:{start_date:start,end_date:end}})}));
    return (await response.json()).result.structuredContent.result;
  };
  const result=await request('2026-10-16','2026-10-22');
  assert.equal(result.total_records,40);assert.equal(result.eligible_count,30);assert.equal(result.excluded.desk,5);assert.equal(result.excluded.cancelled,5);
  assert.equal(result.excluded.preset,0);assert.equal(result.review_count,2);
  const b=result.items.find(item=>item.name==='B'),x=result.items.find(item=>item.name==='X');
  assert.equal(b.total,10);assert.equal(b.oversized_count,10);assert.equal(b.alternative_count,7);
  assert.equal(x.total,5);assert.equal(x.alternative_count,5);assert.ok(b.evidence.some(record=>record.alternative_status==='blocked'));
  const today=await request('2026-10-23','2026-10-23');assert.equal(today.eligible_count,0);assert.equal(today.status,'insufficient_data');
  const candidate=await recommendCurrentRooms({date:'2026-10-23',time:'14:00',duration:30,people:4,kind:'meeting',features:['monitor']},initialReservations,'2026-10-23');
  assert.ok(candidate.candidates.some(room=>room.id==='office-c04'));
});
test('歴史デモ画面：過去の期間を初期選択し、本人の現在・履歴や今日の空きへ混入しない',async()=>{
  const now=()=>new Date('2026-10-23T00:00:00Z');
  const ui=await employeeUi({role:'admin',now,initialReservations:historicalDemoReservations('2026-10-23',officeRooms),includeLegacyPresets:false});
  const snapshot=await ui.state();assert.equal(snapshot.current_meetings.length,0);assert.equal(snapshot.meeting_history.length,0);
  await ui.adminSection('improvements');
  assert.equal(ui.get('improvementStart').value,'2026-10-16');assert.equal(ui.get('improvementEnd').value,'2026-10-22');
  assert.match(ui.get('adminDescription').textContent,/DEMO-HISTORY/);
  await ui.analyzeRooms();assert.match(ui.get('adminResults').innerHTML,/Repeated small-party bookings/);
  await ui.change('improvementStart','2026-10-23');await ui.change('improvementEnd','2026-10-23');
  await ui.analyzeRooms();assert.match(ui.get('adminResults').innerHTML,/Not enough bookings/);
  await ui.adminSection('live');await ui.adminSection('improvements');
  assert.equal(ui.get('improvementStart').value,'2026-10-23');assert.equal(ui.get('improvementEnd').value,'2026-10-23');
});
function purgeUiRecord(changes={}){
  const date='2026-10-19';
  return {id:'ui-purge-record',title:'Purge only this record',space_id:'office-c04',name:'D',source:'employee',assigned_to:'A',booked_by:'Demo',version:1,
    date,time:'13:00',end_time:'13:30',start:780,end:810,people:3,status:'completed',actual_start:'13:00',actual_end:'13:30',deleted:true,
    request:{date,time:'13:00',duration:30,people:3,kind:'meeting',features:['monitor']},...changes};
}
test('一括完全削除UI：4範囲・確認・取消・日英と削除済み以外の保護',async()=>{
  const deleted=purgeUiRecord({date:today}),older=purgeUiRecord({id:'older-ui',date:'2026-10-10'}),active=purgeUiRecord({id:'keep-ui',deleted:false,date:today});
  const ui=await employeeUi({role:'admin',initialReservations:[deleted,older,active],includeLegacyPresets:false});
  await ui.tab('adminBulkPurge');assert.equal(ui.get('bulkClearTitle').textContent,'Permanently clear Deleted');
  assert.equal(ui.get('bulkHour').hidden,true);assert.match(ui.get('bulkClearCounts').innerHTML,/Records to delete permanently<\/span><b>1/);
  assert.match(ui.get('bulkClearBoundary').textContent,/cannot be restored/);assert.equal(ui.get('bulkClearConfirm').disabled,true);
  await ui.clearRecords();assert.equal((await ui.state()).reservations.length,3);
  ui.get('bulkClearDialog').close();await ui.tab('adminBulkPurge');assert.equal(ui.get('bulkClearAgree').checked,false);
  await ui.agreeClear();await ui.change('bulkRange','all');assert.equal(ui.get('bulkClearAgree').checked,false);
  assert.match(ui.get('bulkClearCounts').innerHTML,/Records to delete permanently<\/span><b>2/);
  await ui.language('ja');assert.equal(ui.get('bulkClearTitle').textContent,'削除済みを一括完全削除');
  assert.match(ui.get('bulkClearAgreement').textContent,/復元できなくなる/);
  await ui.agreeClear();await ui.clearRecords();
  assert.deepEqual((await ui.state()).reservations,[active]);assert.equal((await ui.state()).meeting_history.length,1);
  assert.equal(ui.get('liveState').value,'deleted');assert.match(ui.get('notice').textContent,/2.*完全に削除/);
  await ui.language('en');assert.match(ui.get('notice').textContent,/2.*permanently removed/);
  await ui.tab('adminBulkPurge');assert.equal(ui.get('bulkClearConfirm').disabled,true);assert.equal(ui.get('bulkClearAgree').disabled,true);
  ui.get('bulkClearDialog').close();await ui.tab('adminClear');assert.equal(ui.get('bulkClearTitle').textContent,'Clear records');assert.equal(ui.get('bulkHour').hidden,false);
});
test('一括完全削除UI：他の画面の復元後は一件も消さず、再確認を要求する',async()=>{
  const deleted=purgeUiRecord({date:today}),ui=await employeeUi({role:'admin',initialReservations:[deleted],includeLegacyPresets:false});
  await ui.tab('adminBulkPurge');await ui.agreeClear();
  const restored=await ui.request('/api/office/admin/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({meeting_id:deleted.id,expected_version:deleted.version,operation_id:randomUUID(),confirmed:true})});
  assert.equal(restored.status,200);await ui.clearRecords();
  assert.equal(ui.get('bulkClearDialog').open,true);assert.equal(ui.get('bulkClearAgree').checked,false);assert.equal(ui.get('bulkClearConfirm').disabled,true);
  assert.match(ui.get('bulkClearStatus').textContent,/Records changed/);assert.equal((await ui.state()).reservations[0].deleted,false);
  await ui.tab('bulkClearPreview');assert.equal(ui.get('bulkClearAgree').disabled,true);
});
test('完全削除UI：削除済みだけに表示し、確認チェック・取消・日英・他の予約を守る',async()=>{
  const target=purgeUiRecord(),other=purgeUiRecord({id:'unrelated-ui',title:'Keep this record',deleted:false,assigned_to:'other'});
  const ui=await employeeUi({role:'admin',initialReservations:[target,other],includeLegacyPresets:false});
  assert.equal((ui.get('adminResults').innerHTML.match(/data-admin-action="purge"/g)??[]).length,1);
  await ui.adminAction('purge');assert.equal(ui.get('adminDeleteTitle').textContent,'Delete permanently');
  assert.equal(ui.get('adminPurgeAgreement').hidden,false);assert.equal(ui.get('adminDeleteConfirm').disabled,true);
  assert.match(ui.get('adminDeleteHint').textContent,/cannot be restored/);
  await ui.tab('adminDeleteConfirm');assert.equal((await ui.state()).reservations.length,2,'Unchecked confirmation does not mutate');
  ui.get('adminDeleteDialog').close();assert.equal((await ui.state()).reservations.length,2);
  await ui.adminAction('purge');assert.equal(ui.get('adminPurgeAgree').checked,false);
  await ui.agreePurge();assert.equal(ui.get('adminDeleteConfirm').disabled,false);
  await ui.tab('adminDeleteConfirm');const result=await ui.state();
  assert.equal(result.reservations.length,1);assert.deepEqual(result.reservations[0],other);assert.equal(result.meeting_history.length,0);
  assert.equal(ui.get('adminDeleteDialog').open,false);assert.doesNotMatch(ui.get('adminResults').innerHTML,/Purge only this record/);
  assert.match(ui.get('notice').textContent,/permanently deleted/);
  await ui.language('ja');assert.match(ui.get('notice').textContent,/完全に削除/);
});
test('完全削除UI：確認画面を開いた後に復元された記録を古い版数で削除しない',async()=>{
  const target=purgeUiRecord(),ui=await employeeUi({role:'admin',initialReservations:[target],includeLegacyPresets:false});
  await ui.adminAction('purge');await ui.agreePurge();
  const restored=await ui.request('/api/office/admin/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({meeting_id:target.id,expected_version:target.version,operation_id:randomUUID(),confirmed:true})});
  assert.equal(restored.status,200);
  await ui.tab('adminDeleteConfirm');assert.equal(ui.get('adminDeleteDialog').open,true);
  assert.match(ui.get('adminDeleteStatus').textContent,/changed|updated|version/i);
  const state=await ui.state();assert.equal(state.reservations.length,1);assert.equal(state.reservations[0].deleted,false);
});

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
async function employeeUi({dayParser,calendarAgent,improvementAgent=mockImprovementAgent,transportFault,role='employee',now=()=>new Date(today+'T01:00:00Z'),initialReservations=[],includeLegacyPresets=true}={}){
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
  const adminButtons=Array.from(html.matchAll(/data-admin="([^"]+)"/g),match=>{const button=new Element();button.dataset.admin=match[1];return button;});
  const get=id=>elements.get(id),document={title:'',getElementById:get,querySelector:()=>new Element(),
    querySelectorAll:selector=>selector==='[data-area]'?areaButtons:selector==='[data-admin]'?adminButtons:selector.includes('#intentForm button')?[get('parseButton')]:[],documentElement:{}};
  const handle=createOfficeService({now,dayParser:dayParser??mockDayParser,calendarAgent,improvementAgent,initialReservations,includeLegacyPresets});
  let nextWorkspace=null;
  async function request(path,options={}){
    options.signal?.throwIfAborted();
    if(path==='/api/office/improvements'&&transportFault)return transportFault();
    if(path==='/api/office/workspace'&&nextWorkspace){const value=nextWorkspace;nextWorkspace=null;return Response.json(value);}
    try{const response=await handle(new Request('http://demo.test'+path,options));options.signal?.throwIfAborted();return response;}
    catch(error){options.signal?.throwIfAborted();return errorResponse(error);}
  }
  const source=readFileSync(new URL('./office.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
  const run=new (Object.getPrototypeOf(async function(){}).constructor)('ApiSession','ReviewComparison','translator','errorKey','applyLanguage','document','window','fetch','location','history','innerWidth','innerHeight','matchMedia','setInterval','clearInterval','layoutAreas','layoutPosition','renderOfficeLayout','createCalendarUI',source+'\nreturn {sync,showBooking,isWorking:()=>working};');
  const controller=await run(ApiSession,ReviewComparison,translator,errorKey,value=>{document.documentElement.lang=value;},document,{addEventListener(){}},request,
    {search:'?lang=en',pathname:role==='admin'?'/admin':'/office.html',href:'http://demo.test/'+(role==='admin'?'admin':'office.html')+'?lang=en'}, {replaceState(){}},1280,720,()=>({matches:true}),()=>1,()=>{},layoutAreas,layoutPosition,renderOfficeLayout,createCalendarUI);
  async function fire(element,type,event={}){
    for(const listener of element.events[type]??[])await listener({preventDefault(){},...event});
    for(let i=0;controller.isWorking();i++){if(i>1000)throw new Error('UI remained busy');await new Promise(resolve=>setImmediate(resolve));}
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
    adminSection:async tab=>fire(adminButtons.find(button=>button.dataset.admin===tab),'click'),
    adminAction:async action=>{
      const button=get('adminResults').querySelectorAll('button').find(button=>button.dataset.adminAction===action);
      assert.ok(button,'Missing admin action '+action);await fire(get('adminResults'),'click',{target:button});
    },
    agreePurge:async()=>{get('adminPurgeAgree').checked=true;await fire(get('adminPurgeAgree'),'change');},
    analyzeRooms:async()=>fire(get('improvementForm'),'submit'),
    importCalendar:async(start=today,end=start)=>{get('planSource').value='calendar';await fire(get('planSource'),'change');get('calendarExportStart').value=start;get('calendarExportEnd').value=end;await fire(get('exportCalendar'),'click');},
    reviewImported:async()=>fire(get('intentForm'),'submit'),
    reviewCalendar:async()=>{await fire(get('calendarToHome'),'click');await fire(get('exportCalendar'),'click');await fire(get('intentForm'),'submit');},
    supplement:async value=>{get('calendarSupplement').value=value;await fire(get('calendarSupplement'),'input');},
    calendarSave:async()=>fire(get('calendarEditForm'),'submit'),
    calendarInput:async()=>fire(get('calendarEditForm'),'input'),
    calendarDay:async(date=today)=>{const button=get('calendarMonthGrid').children.find(b=>b.dataset.calendarDay===date);assert.ok(button,'Missing calendar date '+date);await fire(get('calendarMonthGrid'),'click',{target:button});},
    calendarMonthKey:async(date,key)=>{const button=get('calendarMonthGrid').children.find(b=>b.dataset.calendarDay===date);assert.ok(button);await fire(get('calendarMonthGrid'),'keydown',{target:button,key});},
    calendarSelect:async id=>{const button=get('calendarList').children.find(b=>b.dataset.calendarEvent===id);assert.ok(button);await fire(get('calendarList'),'click',{target:button});},
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

test('管理UI旧削除のみ：社員履歴を清空でき、日英件数と復元入口を残す',async()=>{
  const ui=await employeeUi({role:'admin'});
  const post=async(path,body)=>{const r=await ui.request('/api/office/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};
  await post('workspace/reset',{confirmed:true});
  let record=(await post('admin/create',{operation_id:randomUUID(),confirmed:true,data:{title:'Old deleted history',date:today,time:'13:00',duration:30,people:1,space_id:'office-c04',booked_by:'Employee A',assigned_to:'A',features:[]}})).record;
  await post('admin/delete',{operation_id:randomUUID(),confirmed:true,meeting_id:record.id,expected_version:record.version});
  await ui.controller.sync();assert.equal((await ui.state()).meeting_history.length,1);
  await ui.tab('adminClear');assert.match(ui.get('bulkClearCounts').innerHTML,/Deleted employee history<\/span><b>1/);
  await ui.agreeClear();assert.equal(ui.get('bulkClearConfirm').disabled,false);
  await ui.clearRecords();assert.equal((await ui.state()).meeting_history.length,0);assert.match(ui.get('notice').textContent,/1 records cleared/);
  await ui.change('liveState','deleted');assert.match(ui.get('adminResults').innerHTML,/data-admin-action="restore"/);
  record=(await ui.state()).reservations[0];
  await post('admin/restore',{operation_id:randomUUID(),confirmed:true,meeting_id:record.id,expected_version:record.version});
  await post('admin/delete',{operation_id:randomUUID(),confirmed:true,meeting_id:record.id,expected_version:record.version+1});
  await ui.controller.sync();await ui.language('ja');await ui.tab('adminClear');
  assert.match(ui.get('bulkClearCounts').innerHTML,/うち削除済み社員履歴<\/span><b>1/);
  await ui.agreeClear();await ui.clearRecords();assert.equal((await ui.state()).meeting_history.length,0);
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
  const handler=createOfficeService({now:()=>new Date(today+'T01:00:00Z'),includeLegacyPresets:true,...options});
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


// Explicit model fixtures exercise the production Agent loop and real MCP transport.
function calendarModel({fail,mutate,omitFinal=false,wrongPeople=false,onlyFirst=false,types={},failAfter=Infinity}={}){
  const requests=[];
  const fetchImpl=async(_url,options)=>{
    const body=JSON.parse(options.body);requests.push(body);
    if(fail||requests.length>failAfter)return Response.json({error:{code:'rate_limit_exceeded'}},{status:429});
    if(mutate){await mutate();mutate=null;}
    const results=body.input.filter(i=>i.type==='function_call_output').map(i=>JSON.parse(i.output));
    const events=results.find(r=>Array.isArray(r.result?.events))?.result.events.filter(e=>e.status==='active')??[];
    const checked=new Set(results.filter(r=>r.result?.event_id).map(r=>r.result.event_id));
    let name=body.tool_choice?.name,args=JSON.parse(body.input[0].content);
    const next=events.find(e=>!checked.has(e.id));
    if(!name&&next&&(!onlyFirst||!checked.size)){
      name='recommend_calendar_event';
      const type=types[next.title]??(next.time==='12:00'?'unavailable':next.time==='09:00'?'desk':'meeting');
      args={event_id:next.id,event_version:next.version,type,people:wrongPeople?99:type==='desk'?1:next.people,
        features:type==='desk'?['area_east','window','quiet','low_airflow','avoid_cold']:type==='meeting'?['monitor']:[],unclear:[]};
    }
    return Response.json({output:name?[{type:'function_call',name,arguments:JSON.stringify(args),call_id:'cal-'+requests.length}]
      :omitFinal?[]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Calendar checked using MCP. Confirm each booking.'}]}]});
  };
  return {requests,setFailureAfter:value=>{failAfter=value;},agent:(client,key,input,options)=>runCalendarAgent(client,key,input,{...options,fetchImpl})};
}
async function calendarFixture(modelOptions={}){
  const model=calendarModel(modelOptions),workspace=createMeetingState({rooms:officeRooms,now:()=>new Date(today+'T01:00:00Z')});
  const service=createOfficeService({workspace,calendarAgent:model.agent});
  async function call(path,body,key=true){try{return await service(new Request('http://demo.test/api/office/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(key?{Authorization:'Bearer test_key_not_real_1234567890'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));}catch(e){return errorResponse(e);}}
  const change=async(action,extra={})=>call('calendar',{action,expected_revision:workspace.employeeCalendar().revision,operation_id:randomUUID(),confirmed:true,...extra});
  const analyze=async()=>{const state=workspace.snapshot();return call('calendar/analyze',{date:today,revision:state.revision,instance_id:state.instance_id,locale:'en',model:'gpt-4.1-mini'});};
  const exportRange=async(start=today,end=start)=>{const state=workspace.snapshot();return call('calendar/export',{start_date:start,end_date:end,revision:state.revision,instance_id:state.instance_id,locale:'en'},false);};
  const review=async(id,supplement='',key=true)=>{const state=workspace.snapshot();return call('calendar/review',{export_id:id,revision:state.revision,instance_id:state.instance_id,locale:'en',model:'gpt-4.1-mini',supplement},key);};
  const complete=async(id,supplement='')=>{let response,totalNew=0;for(let i=0;i<20;i++){response=await review(id,supplement);if(response.status!==200)return {response};const result=await response.json();totalNew+=result.progress.newly_analyzed;if(!result.progress.remaining)return {response,result,totalNew};}throw new Error('Review did not finish');};
  return {model,workspace,call,change,analyze,exportRange,review,complete};
}

test('模擬日程CRUD：固定ID・版数・再送・上限・入力検証、予約を変更しない',async()=>{
  const f=await calendarFixture();const before=f.workspace.snapshot();
  const input={action:'examples',date:today,expected_revision:0,operation_id:randomUUID(),confirmed:true,locale:'en'};
  assert.equal((await f.call('calendar',input,false)).status,200);
  assert.equal((await f.call('calendar',input,false)).status,200);
  assert.equal(f.workspace.employeeCalendar().events.length,3);
  assert.equal(f.workspace.employeeCalendar().revision,1);
  assert.equal((await f.call('calendar',{...input,operation_id:randomUUID()},false)).status,409);
  assert.equal(f.workspace.snapshot().reservations.length,before.reservations.length);
  const event=f.workspace.employeeCalendar().events[0];
  const {id,version,status,example_key,...data}=event;
  assert.equal((await f.change('update',{event_id:id,event:{...data,end_time:'08:00'}})).status,400);
  assert.equal(f.workspace.employeeCalendar().events[0].version,version);
  assert.equal((await f.change('update',{event_id:id,event:{...data,notes:'New preference'}})).status,200);
  assert.equal(f.workspace.employeeCalendar().events[0].id,id);
  assert.equal(f.workspace.employeeCalendar().events[0].version,2);
  assert.equal((await f.change('cancel',{event_id:id})).status,200);
  await f.change('examples',{date:today});
  assert.equal(f.workspace.employeeCalendar().events.length,3);
  assert.equal(f.workspace.employeeCalendar().events[0].status,'cancelled');
  for(const extra of [{event:{...data,date:'2026-02-30'}},{event:{...data,end_time:'09:05'}},{event:{...data,people:101}},{event:{...data,title:''}}])assert.equal((await f.change('create',extra)).status,400);
  const cal=createSimulatedCalendar();for(let i=0;i<12;i++)cal.change({action:'create',event:{...data,title:'Event '+i},expected_revision:i,confirmed:true,operation_id:randomUUID()},today);
  assert.throws(()=>cal.change({action:'create',event:data,expected_revision:12,confirmed:true,operation_id:randomUUID()},today),/calendar_limit/);
});

test('日程Agent：実MCP調査→座席と会議の提案→本人確認→再分析の重複抑止',async()=>{
  const f=await calendarFixture();await f.change('examples',{date:today,locale:'en'});
  const response=await f.analyze();assert.equal(response.status,200,await response.clone().text());const plan=await response.json();
  assert.equal(plan.proposals.length,3);assert.equal(f.workspace.snapshot().meetings.length,0);
  const [seat,lunch,meeting]=plan.proposals;
  assert.equal(seat.status,'proposed');assert.ok(seat.candidates.every(r=>r.kind==='desk'&&r.area==='east'&&r.features.includes('window')&&r.features.includes('quiet')));
  assert.equal(lunch.status,'note');assert.equal(meeting.status,'proposed');assert.equal(meeting.candidates[0].capacity,4);
  assert.ok(plan.trace.some(t=>t.name==='get_employee_bookings'));assert.ok(meeting.trace.some(t=>t.name==='query_reservations'));
  assert.ok(f.model.requests.every(r=>r.store===false&&!r.tools.some(t=>/book|confirm/.test(t.name)&&t.name!=='get_employee_bookings')));
  for(const proposal of [seat,meeting]){
    const input={plan_id:plan.plan_id,proposal_id:proposal.id,space_id:proposal.candidates[0].id,confirmed:true};
    assert.equal((await f.call('confirm',input)).status,200);assert.equal((await f.call('confirm',input)).status,200);
  }
  const state=f.workspace.snapshot();assert.equal(state.current_meetings.length,2);assert.ok(state.current_meetings.every(r=>r.calendar_event_id));
  const again=await (await f.analyze()).json();assert.equal(again.proposals.filter(p=>p.status==='existing').length,2);
  assert.equal(f.workspace.snapshot().meetings.length,2);
  assert.doesNotMatch(JSON.stringify(f.workspace.exportState()),/test_key_not_real|Calendar checked using MCP|function_call_output/);
});

test('日程の変更・取消：旧提案を拒否し、予約を保持して手動確認へ案内する',async()=>{
  const f=await calendarFixture();await f.change('examples',{date:today});const plan=await (await f.analyze()).json();
  const p=plan.proposals[2],confirm={plan_id:plan.plan_id,proposal_id:p.id,space_id:p.candidates[0].id,confirmed:true};
  await f.call('confirm',confirm);const record=f.workspace.snapshot().meetings[0];
  const {id,version,status,example_key,...data}=f.workspace.employeeCalendar().events.find(e=>e.id===record.calendar_event_id);
  await f.change('update',{event_id:id,event:{...data,time:'14:00',end_time:'14:45'}});
  assert.equal((await f.call('confirm',confirm)).status,409);
  assert.equal(f.workspace.snapshot().meetings[0].time,'13:00');
  const changed=await (await f.analyze()).json();const review=changed.proposals.find(p=>p.calendar_event.id===id);
  assert.equal(review.status,'needs_input');assert.deepEqual(review.issues,['calendar_booking_changed']);
  assert.equal((await f.call('replan',{plan_id:changed.plan_id,proposal_id:review.id})).status,409);
  await f.call('transition',{meeting_id:record.id,action:'cancel'});
  const retry=await (await f.analyze()).json();const replacement=retry.proposals.find(p=>p.calendar_event.id===id);assert.equal(replacement.status,'proposed');
  await f.call('confirm',{plan_id:retry.plan_id,proposal_id:replacement.id,space_id:replacement.candidates[0].id,confirmed:true});
  await f.change('cancel',{event_id:id});assert.equal(f.workspace.snapshot().current_meetings.length,1);
  assert.equal(f.workspace.snapshot().current_meetings[0].time,'14:00');
  assert.equal((await f.call('confirm',{plan_id:retry.plan_id,proposal_id:replacement.id,space_id:replacement.candidates[0].id,confirmed:true})).status,409);
});

test('日程Agent：Key必須、調査省略・人数捏造・API制限を正確に拒否する',async()=>{
  const f=await calendarFixture();await f.change('examples',{date:today});const state=f.workspace.snapshot();
  const body={date:today,revision:state.revision,instance_id:state.instance_id,model:'gpt-4.1-mini',locale:'en'};
  const missing=await f.call('calendar/analyze',body,false);assert.equal(missing.status,401);assert.equal((await missing.json()).error,'api_key_missing');assert.equal(f.model.requests.length,0);
  for(const options of [{onlyFirst:true},{wrongPeople:true},{omitFinal:true},{fail:true}]){
    const failed=await calendarFixture(options);await failed.change('examples',{date:today});const result=await failed.analyze();assert.equal(result.status,502);assert.equal(failed.workspace.snapshot().meetings.length,0);
    if(options.fail)assert.equal((await result.json()).error,'api_rate_limit');
  }
  const dishonest=createOfficeService({workspace:f.workspace,calendarAgent:async()=>({summary:'Pretend',trace:[]})});
  await assert.rejects(()=>dishonest(new Request('http://demo.test/api/office/calendar/analyze',{method:'POST',headers:{authorization:'Bearer test_key_not_real_1234567890','Content-Type':'application/json'},body:JSON.stringify(body)})),/calendar_incomplete/);
});

test('日程Agent：重なった予定・未定人数・既存予約の明示的な関連付けを検証',async()=>{
  const f=await calendarFixture();const data={title:'Discussion',date:today,time:'13:00',end_time:'13:45',people:4,notes:'Monitor required'};
  await f.change('create',{event:data});await f.change('create',{event:{...data,title:'Outside',time:'12:00',end_time:'14:00',people:null}});
  let plan=await (await f.analyze()).json();assert.equal(plan.proposals.find(p=>p.activity.title==='Discussion').status,'no_slot');
  const g=await calendarFixture();await g.change('create',{event:{...data,people:null}});plan=await (await g.analyze()).json();assert.equal(plan.proposals[0].status,'needs_input');
  const h=await calendarFixture();await h.change('create',{event:data});
  await h.call('admin/create',{operation_id:randomUUID(),confirmed:true,data:{title:'Discussion',date:today,time:'13:00',duration:45,people:4,features:['monitor'],space_id:'office-c04',assigned_to:'A',booked_by:'A'}});
  plan=await (await h.analyze()).json();assert.equal(plan.proposals[0].status,'existing');assert.equal(h.workspace.snapshot().meetings[0].calendar_event_id,undefined);
  const p=plan.proposals[0];await h.call('confirm',{plan_id:plan.plan_id,proposal_id:p.id,space_id:p.existing.space_id,confirmed:true});assert.ok(h.workspace.snapshot().meetings[0].calendar_event_id);
  assert.equal(h.workspace.snapshot().meetings.length,1);
});

test('日程Agent：API待機中の変更で旧応答を採用せず、12件も上限内で調査できる',async()=>{
  let f;f=await calendarFixture({mutate:async()=>f.change('create',{event:{title:'Changed concurrently',date:today,time:'16:00',end_time:'16:30',people:2,notes:''}})});
  await f.change('examples',{date:today});assert.equal((await f.analyze()).status,409);assert.equal(f.workspace.exportState().plans.length,0);
  const g=await calendarFixture();for(let i=0;i<12;i++)await g.change('create',{event:{title:'Meeting '+i,date:today,time:'13:00',end_time:'13:30',people:2,notes:''}});
  const result=await g.analyze();assert.equal(result.status,200,await result.clone().text());assert.equal(g.model.requests.length,15);
});

test('日程画面：例の編集・未保存防止・Keyなし案内・実Agent fixture・変更後の提案失効',async()=>{
  const mock=calendarModel();const ui=await employeeUi({calendarAgent:mock.agent,includeLegacyPresets:false});
  await ui.tab('openCalendar');await ui.calendarDay();assert.equal(ui.get('calendarDialog').open,true);
  await ui.tab('calendarExamples');assert.equal(ui.get('calendarList').children.length,3);
  await ui.reviewCalendar();assert.equal(ui.get('calendarDialog').open,false);assert.equal(mock.requests.length,6);
  assert.match(ui.get('agendaContent').innerHTML,/roomChoice/);
  await ui.click('data-confirm');assert.equal((await ui.state()).current_meetings.length,1);
  await ui.tab('openCalendar');await ui.calendarDay();const first=ui.get('calendarList').children[0].dataset.calendarEvent;await ui.calendarSelect(first);
  ui.get('calendarNotes').value='Changed preference';await ui.calendarInput();assert.equal(ui.get('calendarToHome').disabled,true);assert.equal(ui.get('calendarDate').disabled,true);
  await ui.calendarSave();await ui.tab('proposalsTab');assert.match(ui.get('agendaContent').innerHTML,/No suggestions|No plan|empty/);
  const noKey=await employeeUi({dayParser:async()=>{},calendarAgent:mock.agent,includeLegacyPresets:false});
  await noKey.tab('openCalendar');await noKey.calendarDay();await noKey.tab('calendarExamples');const count=mock.requests.length;await noKey.reviewCalendar();
  assert.equal(noKey.get('settingsDialog').open,true);assert.equal(mock.requests.length,count);assert.match(noKey.get('notice').textContent,/Key|key/);
});


test('日程Agent：管理者による予約の移動を追跡し、別日の二重予約を防ぐ',async()=>{
  const f=await calendarFixture();await f.change('create',{event:{title:'Discussion',date:today,time:'13:00',end_time:'13:30',people:4,notes:'Monitor'}});
  const plan=await (await f.analyze()).json(),p=plan.proposals[0];
  await f.call('confirm',{plan_id:plan.plan_id,proposal_id:p.id,space_id:p.candidates[0].id,confirmed:true});
  const record=f.workspace.snapshot().meetings[0];
  const response=await f.call('admin/update',{operation_id:randomUUID(),meeting_id:record.id,expected_version:record.version,confirmed:true,
    data:{title:record.title,date:'2026-10-21',time:'15:00',duration:30,people:4,features:['monitor'],space_id:record.space_id,assigned_to:'A',booked_by:'A'}});
  assert.equal(response.status,200,await response.clone().text());
  const changed=await (await f.analyze()).json();assert.equal(changed.proposals[0].status,'needs_input');assert.equal(changed.proposals[0].existing.date,'2026-10-21');
  assert.equal((await f.call('confirm',{plan_id:plan.plan_id,proposal_id:p.id,space_id:p.candidates[0].id,confirmed:true})).status,409);
  assert.equal(f.workspace.snapshot().meetings.length,1);
});

test('日程画面：取消済みの関連予約からカレンダーへ戻り、取消確認は2段階',async()=>{
  const mock=calendarModel(),ui=await employeeUi({calendarAgent:mock.agent,includeLegacyPresets:false});
  await ui.tab('openCalendar');await ui.calendarDay();await ui.tab('calendarExamples');await ui.reviewCalendar();await ui.click('data-confirm');
  const record=(await ui.state()).meetings[0];
  const cancel=ui.get('agendaContent').children.find(b=>b.dataset.meetingAction==='cancel');cancel.attributes['data-test-cancel']='';await ui.click('data-test-cancel');
  await ui.click('data-rebook');assert.equal(ui.get('calendarDialog').open,true);await ui.calendarDay();
  await ui.calendarSelect(record.calendar_event_id);await ui.tab('calendarCancel');
  let calendar=await (await ui.request('/api/office/calendar')).json();assert.equal(calendar.events.find(e=>e.id===record.calendar_event_id).status,'active');
  await ui.tab('calendarCancel');calendar=await (await ui.request('/api/office/calendar')).json();assert.equal(calendar.events.find(e=>e.id===record.calendar_event_id).status,'cancelled');
  assert.equal((await ui.state()).meetings[0].status,'cancelled');
});

test('日程Agent：中断・異常ツール・入力外の日付で予約や提案を保存しない',async()=>{
  const f=await calendarFixture();await f.change('examples',{date:today});
  const state=f.workspace.snapshot(),body={date:today,revision:state.revision,instance_id:state.instance_id,model:'gpt-4.1-mini',locale:'en'};
  assert.equal((await f.call('calendar/analyze',{...body,date:'2026-02-30'})).status,400);
  const controller=new AbortController();
  const abortAgent=(client,key,input,options)=>runCalendarAgent(client,key,input,{...options,signal:controller.signal,fetchImpl:async()=>{controller.abort();return Response.json({output:[]});}});
  const service=createOfficeService({workspace:f.workspace,calendarAgent:abortAgent});
  await assert.rejects(()=>service(new Request('http://demo.test/api/office/calendar/analyze',{method:'POST',headers:{Authorization:'Bearer test_key_not_real_1234567890','Content-Type':'application/json'},body:JSON.stringify(body)})),e=>e.name==='AbortError');
  assert.equal(f.workspace.exportState().plans.length,0);assert.equal(f.workspace.snapshot().meetings.length,0);
  const badAgent=(client,key,input,options)=>runCalendarAgent(client,key,input,{...options,fetchImpl:async()=>Response.json({output:[{type:'function_call',name:'create_booking',arguments:'{}',call_id:'unknown'}]})});
  const bad=createOfficeService({workspace:f.workspace,calendarAgent:badAgent});
  await assert.rejects(()=>bad(new Request('http://demo.test/api/office/calendar/analyze',{method:'POST',headers:{Authorization:'Bearer test_key_not_real_1234567890','Content-Type':'application/json'},body:JSON.stringify(body)})),/calendar_invalid_tool/);
});


test('日程画面：API障害をホームに表示し、古い候補や解析中表示を残さない',async()=>{
  const mock=calendarModel({fail:true}),ui=await employeeUi({calendarAgent:mock.agent,includeLegacyPresets:false});
  await ui.tab('openCalendar');await ui.calendarDay();await ui.tab('calendarExamples');await ui.reviewCalendar();
  assert.equal(ui.get('calendarDialog').open,false);assert.match(ui.get('notice').textContent,/rate|Rate|limit/);assert.doesNotMatch(ui.get('notice').textContent,/checking|key/i);
  assert.equal(ui.get('parseButton').disabled,false);assert.equal((await ui.state()).meetings.length,0);
});


test('日程画面：変更なしの定期同期で日程ボタンと入力中の値を置き換えない',async()=>{
  const ui=await employeeUi({includeLegacyPresets:false});await ui.tab('openCalendar');await ui.calendarDay();await ui.tab('calendarExamples');
  const button=ui.get('calendarList').children[0];await ui.controller.sync();assert.equal(ui.get('calendarList').children[0],button);
  ui.get('calendarTitle').value='Unsaved draft';await ui.calendarInput();await ui.controller.sync();assert.equal(ui.get('calendarTitle').value,'Unsaved draft');assert.equal(ui.get('calendarDate').disabled,true);
});


test('日程Agent：席の明示人数を1人に書き換えず、例の再追加は提案を失効させない',async()=>{
  const f=await calendarFixture();await f.change('examples',{date:today});const plan=await (await f.analyze()).json(),revision=f.workspace.employeeCalendar().revision;
  await f.change('examples',{date:today});assert.equal(f.workspace.employeeCalendar().revision,revision);
  const p=plan.proposals[0];assert.equal((await f.call('confirm',{plan_id:plan.plan_id,proposal_id:p.id,space_id:p.candidates[0].id,confirmed:true})).status,200);
  const g=await calendarFixture();await g.change('create',{event:{title:'Desk for two',date:today,time:'09:00',end_time:'10:00',people:2,notes:'Quiet seat'}});
  const result=await (await g.analyze()).json();assert.equal(result.proposals[0].status,'needs_input');assert.ok(result.proposals[0].issues.includes('seat_single_person'));assert.equal(result.proposals[0].activity.people,2);
});


test('月カレンダー：月曜始まりの42日、閏年、年末年始と不正月を検証',()=>{
  const october=calendarMonthDates('2026-10');assert.equal(october.length,42);assert.equal(october[0],'2026-09-28');assert.equal(october.at(-1),'2026-11-08');assert.equal(new Set(october).size,42);
  assert.ok(calendarMonthDates('2028-02').includes('2028-02-29'));
  assert.ok(!calendarMonthDates('2100-02').includes('2100-02-29'));
  assert.ok(calendarMonthDates('2026-12').includes('2027-01-01'));
  for(const month of ['2026-00','2026-13','bad','0000-01','2101-01'])assert.deepEqual(calendarMonthDates(month),[]);
});

test('月カレンダー画面：月一覧→日付選択→記録→月の摘要、予約は作成しない',async()=>{
  const ui=await employeeUi({includeLegacyPresets:false});await ui.tab('openCalendar');
  assert.equal(ui.get('calendarMonthView').hidden,false);assert.equal(ui.get('calendarDayView').hidden,true);
  assert.equal(ui.get('calendarMonthGrid').children.length,42);assert.equal(ui.get('calendarAnalyze'),undefined);
  assert.match(ui.get('calendarMonthTitle').textContent,/October 2026/);
  assert.ok(ui.get('calendarMonthGrid').children.find(b=>b.dataset.calendarDay===today).hasAttribute('aria-current'));
  await ui.calendarDay('2026-10-27');assert.equal(ui.get('calendarDate').value,'2026-10-27');assert.equal(ui.get('calendarDayView').hidden,false);
  ui.get('calendarTitle').value='A later October event';ui.get('calendarNotes').value='Personal notes';await ui.calendarInput();await ui.calendarSave();
  assert.equal((await ui.state()).meetings.length,0);await ui.tab('calendarBackMonth');
  const button=ui.get('calendarMonthGrid').children.find(b=>b.dataset.calendarDay==='2026-10-27');assert.match(button.textContent,/A later October event/);
  await ui.calendarDay('2026-10-27');const id=ui.get('calendarList').children[0].dataset.calendarEvent;await ui.calendarSelect(id);
  assert.equal(ui.get('calendarTitle').value,'A later October event');
});

test('月カレンダー画面：前後月・今日・年越し・キーボード移動・日英切替',async()=>{
  const ui=await employeeUi({includeLegacyPresets:false});await ui.tab('openCalendar');
  for(let i=0;i<3;i++)await ui.tab('calendarNextMonth');assert.match(ui.get('calendarMonthTitle').textContent,/January 2027/);
  await ui.tab('calendarPreviousMonth');assert.match(ui.get('calendarMonthTitle').textContent,/December 2026/);
  await ui.tab('calendarThisMonth');assert.match(ui.get('calendarMonthTitle').textContent,/October 2026/);
  await ui.calendarMonthKey('2026-10-31','ArrowRight');assert.match(ui.get('calendarMonthTitle').textContent,/November 2026/);
  await ui.calendarDay('2026-11-01');assert.equal(ui.get('calendarDate').value,'2026-11-01');
  await ui.language('ja');await ui.tab('calendarBackMonth');assert.equal(ui.get('calendarMonthTitle').textContent,'2026年11月');assert.match(ui.get('calendarWeekdays').innerHTML,/月.*火.*水.*木.*金.*土.*日/);
  await ui.calendarDay('2026-11-01');await ui.change('calendarDate','1900-01-01');await ui.tab('calendarBackMonth');assert.equal(ui.get('calendarPreviousMonth').disabled,true);
  await ui.calendarDay('1900-01-01');await ui.change('calendarDate','2100-12-31');await ui.tab('calendarBackMonth');assert.equal(ui.get('calendarNextMonth').disabled,true);
});

test('月カレンダー画面：未保存の入力を月移動や再オープンで失わず、予定の多い日を要約',async()=>{
  const ui=await employeeUi({includeLegacyPresets:false});await ui.tab('openCalendar');await ui.calendarDay();await ui.tab('calendarExamples');
  ui.get('calendarTitle').value='Unsaved event';await ui.calendarInput();assert.equal(ui.get('calendarBackMonth').disabled,true);
  await ui.tab('calendarBackMonth');assert.equal(ui.get('calendarDayView').hidden,false);await ui.tab('openCalendar');assert.equal(ui.get('calendarTitle').value,'Unsaved event');assert.equal(ui.get('calendarDayView').hidden,false);
  await ui.tab('calendarDiscard');await ui.tab('calendarBackMonth');
  const day=ui.get('calendarMonthGrid').children.find(b=>b.dataset.calendarDay===today);assert.match(day.textContent,/Desk work/);assert.match(ui.get('calendarMonthGrid').innerHTML,/title="3 events"/);
});

test('月カレンダー：過去・翌年も記録でき、Agentの予約期間は広げない',async()=>{
  const f=await calendarFixture();
  for(const date of ['2026-09-01','2027-01-15']){
    assert.equal((await f.change('create',{event:{title:'Calendar note',date,time:'10:00',end_time:'10:30',people:null,notes:'Notes only'}})).status,200);
    const state=f.workspace.snapshot();const response=await f.call('calendar/analyze',{date,revision:state.revision,instance_id:state.instance_id,locale:'en',model:'gpt-4.1-mini'});
    assert.equal(response.status,400);assert.equal((await response.json()).error,'date_range');
  }
  assert.equal(f.workspace.snapshot().meetings.length,0);assert.equal(f.model.requests.length,0);
  for(const date of ['1899-12-31','2101-01-01'])assert.equal((await f.change('create',{event:{title:'Out of range',date,time:'10:00',end_time:'10:30',people:null,notes:''}})).status,400);
});

test('月カレンダー画面：過去日の記録、Agentボタンの期間表示と安全なプレビュー',async()=>{
  const mock=calendarModel(),ui=await employeeUi({calendarAgent:mock.agent,includeLegacyPresets:false});await ui.tab('openCalendar');await ui.calendarDay('2026-10-01');
  const title='<img src=x onerror=alert(1)>';ui.get('calendarTitle').value=title;await ui.calendarInput();await ui.calendarSave();
  assert.equal(ui.get('calendarAnalyze'),undefined);assert.equal(ui.get('calendarBookingWindow').hidden,false);assert.equal(mock.requests.length,0);
  await ui.tab('calendarBackMonth');assert.ok(ui.get('calendarMonthGrid').innerHTML.includes('&lt;img'));assert.doesNotMatch(ui.get('calendarMonthGrid').innerHTML,/<img/);
});


test('月カレンダー画面：別画面の変更では古い日付操作を止め、開き直しで最新を取得',async()=>{
  const ui=await employeeUi({includeLegacyPresets:false});await ui.tab('openCalendar');
  const calendar=await (await ui.request('/api/office/calendar')).json();
  await ui.request('/api/office/calendar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'create',operation_id:randomUUID(),expected_revision:calendar.revision,confirmed:true,
    event:{title:'Another page event',date:today,time:'15:00',end_time:'15:30',people:null,notes:''}})});
  await ui.controller.sync();assert.match(ui.get('calendarStatus').textContent,/Close and reopen/);assert.ok(ui.get('calendarMonthGrid').children.every(b=>b.disabled));
  await ui.tab('openCalendar');assert.equal(ui.get('calendarMonthGrid').children.find(b=>b.dataset.calendarDay===today).disabled,false);assert.match(ui.get('calendarMonthGrid').innerHTML,/Another page event/);
});


test('月カレンダー：夕方の私用を記録し、営業時間外の会議を自動予約しない',async()=>{
  const f=await calendarFixture({types:{'Evening class':'unavailable'}});await f.change('examples',{date:today});
  assert.equal((await f.change('create',{event:{title:'Evening class',date:today,time:'19:30',end_time:'20:30',people:null,notes:'Outside office'}})).status,200);
  assert.equal((await f.change('create',{event:{title:'Late meeting',date:today,time:'21:00',end_time:'21:30',people:2,notes:'Monitor'}})).status,200);
  const response=await f.analyze();assert.equal(response.status,200,await response.clone().text());const plan=await response.json();
  assert.equal(plan.proposals.find(p=>p.activity.title==='Evening class').status,'note');
  const late=plan.proposals.find(p=>p.activity.title==='Late meeting');assert.equal(late.status,'needs_input');assert.deepEqual(late.issues,['hours']);assert.equal(late.candidates.length,0);
  assert.equal(plan.proposals.find(p=>p.activity.type==='desk').status,'proposed');assert.equal(f.workspace.snapshot().meetings.length,0);
});


test('日历导出增量：导出不调用模型，重复复用理解，空位仍经真实MCP重算',async()=>{
  const f=await calendarFixture();await f.change('examples',{date:today});
  const exported=await (await f.exportRange()).json();assert.equal(exported.events.length,3);assert.equal(f.model.requests.length,0);
  const first=await f.complete(exported.export_id);assert.equal(first.response.status,200);assert.equal(first.totalNew,3);assert.equal(f.model.requests.length,6);
  const before=f.model.requests.length;
  const next=await f.complete(exported.export_id);assert.equal(next.result.progress.newly_analyzed,0);assert.equal(next.result.progress.reused,3);assert.equal(f.model.requests.length,before);
  assert.ok(next.result.proposals[0].trace.some(t=>t.name==='query_reservations'));
  assert.equal(f.workspace.snapshot().meetings.length,0);
  const p=next.result.proposals[2];
  const confirm=await f.call('confirm',{plan_id:next.result.plan_id,proposal_id:p.id,space_id:p.candidates[0].id,confirmed:true});assert.equal(confirm.status,200);
  const again=await f.complete(exported.export_id);assert.equal(again.result.proposals[2].status,'existing');assert.equal(f.model.requests.length,before);assert.equal(f.workspace.snapshot().meetings.length,1);
});

test('日历导出增量：一个月范围分批、只改一项只发送一项、未修改文本不重复发送',async()=>{
  const f=await calendarFixture();for(const date of ['2026-10-20','2026-10-21','2026-10-22','2026-10-23','2026-10-24'])await f.change('examples',{date});
  const exported=await (await f.exportRange(today,'2026-10-24')).json();const first=await f.complete(exported.export_id);
  assert.equal(first.totalNew,15);assert.equal(first.result.proposals.length,15);assert.equal(f.model.requests.length,21);
  const event=f.workspace.employeeCalendar().events.find(e=>e.date==='2026-10-21'&&e.time==='13:00');
  const {id,version,status,example_key,...data}=event;
  await f.change('update',{event_id:id,event:{...data,title:'CHANGED_ONLY',notes:'New preference'}});
  const before=f.model.requests.length;const fresh=await (await f.exportRange(today,'2026-10-24')).json();const changed=await f.complete(fresh.export_id);
  assert.equal(changed.totalNew,1);assert.equal(changed.result.progress.reused,14);assert.equal(f.model.requests.length-before,4);
  const returnedEvents=f.model.requests.slice(before).flatMap(r=>r.input.filter(i=>i.type==='function_call_output').map(i=>JSON.parse(i.output))).filter(r=>r.result?.events).flatMap(r=>r.result.events);
  assert.ok(returnedEvents.length);assert.ok(returnedEvents.every(e=>e.id===id));
  assert.doesNotMatch(JSON.stringify(f.workspace.exportState()),/Calendar checked using MCP|test_key_not_real/);
});

test('日历导出增量：相关预约变化只重新核查事实，不重新理解未改动事务',async()=>{
  const f=await calendarFixture();await f.change('examples',{date:today});const exp=await (await f.exportRange()).json();const first=await f.complete(exp.export_id);
  const room=first.result.proposals[2].candidates[0];
  await f.call('admin/create',{operation_id:randomUUID(),confirmed:true,data:{title:'New room conflict',date:today,time:'13:00',duration:45,people:4,features:['monitor'],space_id:room.id,assigned_to:'other',booked_by:'Admin'}});
  const before=f.model.requests.length,next=await f.complete(exp.export_id);
  assert.equal(next.totalNew,0);assert.equal(f.model.requests.length,before);assert.ok(next.result.proposals[2].candidates.every(r=>r.id!==room.id));
  assert.equal((await f.call('confirm',{plan_id:first.result.plan_id,proposal_id:first.result.proposals[2].id,space_id:room.id,confirmed:true})).status,409);
});

test('日历导出增量：其他日期的修改不使当前导出和预约建议失效',async()=>{
  const f=await calendarFixture();await f.change('examples',{date:today});const exp=await (await f.exportRange()).json();const result=await f.complete(exp.export_id);
  await f.change('create',{event:{title:'Other day',date:'2026-10-21',time:'14:00',end_time:'14:30',people:2,notes:''}});
  const p=result.result.proposals[2];assert.equal((await f.call('confirm',{plan_id:result.result.plan_id,proposal_id:p.id,space_id:p.candidates[0].id,confirmed:true})).status,200);
  assert.equal((await f.review(exp.export_id)).status,200);
  await f.change('create',{event:{title:'Same day change',date:today,time:'16:00',end_time:'16:30',people:2,notes:''}});
  const before=f.model.requests.length,response=await f.review(exp.export_id);assert.equal(response.status,409);assert.equal((await response.json()).error,'calendar_export_changed');assert.equal(f.model.requests.length,before);
});

test('日历导出增量：补充条件更改后重新分析；原样保存保持版本且无需再次调用模型',async()=>{
  const f=await calendarFixture();await f.change('examples',{date:today});const exp=await (await f.exportRange()).json();await f.complete(exp.export_id);
  const event=f.workspace.employeeCalendar().events[0],{id,version,status,example_key,...data}=event;const revision=f.workspace.employeeCalendar().revision;
  await f.change('update',{event_id:id,event:data});assert.equal(f.workspace.employeeCalendar().revision,revision);assert.equal(f.workspace.employeeCalendar().events[0].version,version);
  const before=f.model.requests.length;await f.complete(exp.export_id);assert.equal(f.model.requests.length,before);
  const note='Prefer a whiteboard for all meetings';const changed=await f.complete(exp.export_id,note);assert.equal(changed.totalNew,3);assert.equal(f.model.requests.length-before,6);
  assert.ok(f.model.requests.slice(before).some(r=>JSON.stringify(r.input).includes(note)));
  const after=f.model.requests.length;await f.complete(exp.export_id,note);assert.equal(f.model.requests.length,after);
});

test('日历导出增量：中途失败保留已完成批次，重试只处理剩余事项',async()=>{
  const f=await calendarFixture({failAfter:15});for(const date of [today,'2026-10-21','2026-10-22','2026-10-23','2026-10-24'])await f.change('examples',{date});
  const exp=await (await f.exportRange(today,'2026-10-24')).json();const first=await f.review(exp.export_id);assert.equal(first.status,200);assert.equal((await first.json()).progress.remaining,3);
  const failed=await f.review(exp.export_id);assert.equal(failed.status,502);assert.equal(f.workspace.employeeCalendar().interpretations.length,12);assert.equal(f.workspace.exportState().plans.length,0);
  f.model.setFailureAfter(Infinity);const before=f.model.requests.length,retry=await f.complete(exp.export_id);assert.equal(retry.totalNew,3);assert.equal(retry.result.progress.reused,12);assert.equal(f.model.requests.length-before,6);
});

test('日历导出增量：取消后提示保留预约；空日程不伪造建议，不调用GPT',async()=>{
  const f=await calendarFixture();await f.change('create',{event:{title:'Discussion',date:today,time:'13:00',end_time:'13:30',people:4,notes:'Monitor'}});
  let exp=await (await f.exportRange()).json();const result=await f.complete(exp.export_id),p=result.result.proposals[0];
  await f.call('confirm',{plan_id:result.result.plan_id,proposal_id:p.id,space_id:p.candidates[0].id,confirmed:true});await f.change('cancel',{event_id:p.calendar_event.id});
  exp=await (await f.exportRange()).json();const before=f.model.requests.length,cancelled=await f.complete(exp.export_id);assert.equal(cancelled.result.proposals.length,0);assert.equal(cancelled.result.cancelled_events[0].booking_ids.length,1);assert.equal(f.model.requests.length,before);assert.equal(f.workspace.snapshot().current_meetings.length,1);
  const empty=await (await f.exportRange('2026-10-21')).json();const noEvents=await f.complete(empty.export_id);assert.equal(noEvents.result.progress.total,0);assert.equal(noEvents.result.proposals.length,0);assert.equal(f.model.requests.length,before);
});

test('日历导出增量：Key必需、伪造导出和过期导出拒绝、失败不写分析缓存',async()=>{
  const f=await calendarFixture();await f.change('examples',{date:today});const exp=await (await f.exportRange()).json();
  assert.equal((await f.review(exp.export_id,'',false)).status,401);assert.equal((await f.review(randomUUID())).status,409);assert.equal(f.model.requests.length,0);
  const bad=await calendarFixture({onlyFirst:true});await bad.change('examples',{date:today});const wrong=await (await bad.exportRange()).json();assert.equal((await bad.review(wrong.export_id)).status,502);assert.equal(bad.workspace.employeeCalendar().interpretations.length,0);
  const cal=createSimulatedCalendar();const stored=cal.createExport({start_date:today,end_date:today},today,1000);assert.throws(()=>cal.getExport(stored.export_id,31*60000+1000),/calendar_export_expired/);
  assert.equal((await f.exportRange('2026-10-19')).status,400);assert.equal((await f.exportRange(today,'2027-01-01')).status,400);
});

test('主页导出：导出零模型调用、统一绿色按钮分析、再次分析复用、保留手动输入',async()=>{
  const model=calendarModel(),ui=await employeeUi({calendarAgent:model.agent,includeLegacyPresets:false});
  ui.get('intent').value='My manual draft';await ui.tab('openCalendar');await ui.calendarDay();await ui.tab('calendarExamples');await ui.tab('calendarToHome');
  assert.equal(ui.get('calendarDialog').open,false);assert.equal(ui.get('planSource').value,'calendar');assert.equal(ui.get('parseButton').disabled,true);assert.equal(ui.get('calendarAnalyze'),undefined);
  await ui.tab('exportCalendar');assert.equal(model.requests.length,0);assert.equal(ui.get('intent').readOnly,true);assert.match(ui.get('intent').value,/Desk work/);assert.equal(ui.get('parseButton').disabled,false);
  await ui.reviewImported();assert.equal(model.requests.length,6);assert.match(ui.get('calendarImportStatus').textContent,/Newly analyzed: 3/);
  await ui.reviewImported();assert.equal(model.requests.length,6);assert.match(ui.get('calendarImportStatus').textContent,/Interpretations reused: 3/);
  await ui.change('planSource','manual');assert.equal(ui.get('intent').value,'My manual draft');assert.equal(ui.get('intent').readOnly,false);assert.equal(ui.get('calendarExportControls').hidden,true);
});


test('主页导出：日程变更标记需重新导入，仅移除受影响日期的旧提案',async()=>{
  const model=calendarModel(),ui=await employeeUi({calendarAgent:model.agent,includeLegacyPresets:false});
  await ui.tab('openCalendar');await ui.calendarDay();await ui.tab('calendarExamples');await ui.change('calendarDate','2026-10-21');await ui.tab('calendarExamples');await ui.tab('calendarToHome');
  await ui.importCalendar(today,'2026-10-21');await ui.reviewImported();assert.equal(model.requests.length,9);assert.equal(ui.get('agendaPage').textContent,'1 / 6');
  const c=await (await ui.request('/api/office/calendar')).json(),event=c.events.find(e=>e.date==='2026-10-21'&&e.time==='13:00'),{id,version,status,example_key,...data}=event;
  await ui.request('/api/office/calendar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'update',event_id:id,event:{...data,notes:'Changed'},expected_revision:c.revision,operation_id:randomUUID(),confirmed:true})});
  await ui.controller.sync();assert.equal(ui.get('parseButton').disabled,true);assert.match(ui.get('calendarImportStatus').textContent,/changed/i);assert.equal(ui.get('agendaPage').textContent,'1 / 3');
  await ui.tab('exportCalendar');await ui.reviewImported();assert.equal(model.requests.length,13);assert.match(ui.get('calendarImportStatus').textContent,/Newly analyzed: 1/);
});

test('主页导出：多批自动处理、补充条件变动、取消日程保留原预约并明确提示',async()=>{
  const model=calendarModel(),ui=await employeeUi({calendarAgent:model.agent,includeLegacyPresets:false});
  await ui.tab('openCalendar');await ui.calendarDay();for(const day of [today,'2026-10-21','2026-10-22','2026-10-23','2026-10-24']){await ui.change('calendarDate',day);await ui.tab('calendarExamples');}
  await ui.tab('calendarToHome');await ui.importCalendar(today,'2026-10-24');await ui.reviewImported();assert.equal(model.requests.length,21);assert.equal(ui.get('agendaPage').textContent,'1 / 15');assert.match(ui.get('calendarImportStatus').textContent,/Newly analyzed: 15/);
  await ui.supplement('Prefer quiet rooms');await ui.reviewImported();assert.equal(model.requests.length,42);assert.match(ui.get('calendarImportStatus').textContent,/Newly analyzed: 15/);
  await ui.click('data-confirm');const record=(await ui.state()).meetings[0];
  await ui.tab('openCalendar');await ui.calendarDay(record.date);await ui.calendarSelect(record.calendar_event_id);await ui.tab('calendarCancel');await ui.tab('calendarCancel');await ui.tab('calendarToHome');
  await ui.importCalendar(today,'2026-10-24');await ui.reviewImported();assert.equal(model.requests.length,42);assert.equal((await ui.state()).current_meetings.length,1);assert.equal(ui.get('detailDialog').open,true);
});


test('主页导出：选择范围改变后不能通过直接提交绕过重新导入',async()=>{
  const model=calendarModel(),ui=await employeeUi({calendarAgent:model.agent,includeLegacyPresets:false});
  await ui.tab('openCalendar');await ui.calendarDay();await ui.tab('calendarExamples');await ui.tab('calendarToHome');await ui.tab('exportCalendar');
  await ui.change('calendarExportEnd','2026-10-21');assert.equal(ui.get('parseButton').disabled,true);
  await ui.reviewImported();assert.equal(model.requests.length,0);assert.match(ui.get('notice').textContent,/Import it again/i);
});
