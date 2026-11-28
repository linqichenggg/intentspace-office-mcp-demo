import { createGoogleCalendar } from './google-calendar.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { answerQuestion, readApiKey, parseLocalApiConfig, withLocalApiKey, withDemoApiKey, createDemoAi, demoAiStatus } from './llm.js';
import { assertSameOrigin, readJson, json, HttpError, errorResponse, loopbackHttpOrigin } from './http-utils.js';
import { withMcpClient, handleReadOnlyMcp } from './mcp-client.js';
import { data } from './data.js';
import { handleReviewDemo } from './cloud-api.js';
import { createOfficeService, officeRooms } from './office-service.js';
import { createHistoricalDemoState } from './meeting-state.js';
import { parse } from 'csv-parse/sync';
import { summarizeEnterpriseComfort } from './seat-comfort.js';
import { createEquipmentFeedback } from './equipment-feedback.js';
import { createRealReplay, selectArrivalReplay, createArrivalReplay, isArrivalReplayPath } from './real-replay.js';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';

async function localApiValues(){
  let text;
  try{text=await readFile(new URL('./.env.local',import.meta.url),'utf8');}
  catch(error){if(error.code==='ENOENT')return {};throw new HttpError(500,'local_config_read');}
  if(text.length>8000)throw new HttpError(400,'local_config_invalid');
  try{return parseEnv(text);}
  catch{throw new HttpError(400,'local_config_invalid');}
}
const localApiConfig=async()=>parseLocalApiConfig(await localApiValues());
const localConfigMetadata=async()=>{const config=await localApiConfig();return {local_key_available:!!config.key,local_model:config.model};};
function demoKey(values) {
  const key=(values.OFFICE_DEMO_OPENAI_API_KEY??'').trim();
  return /^[A-Za-z0-9_-]{16,256}$/.test(key)&&key!==values.OPENAI_API_KEY?.trim()?key:'';
}
let configuredDemo;
async function demoQuota() {
  const {DatabaseSync}=await import('node:sqlite');
  if (!configuredDemo) {
    const dir=new URL('./.build/',import.meta.url);
    mkdirSync(dir,{recursive:true,mode:0o700});
    const db=new DatabaseSync(fileURLToPath(new URL('demo-ai-quota.sqlite',dir)));
    db.exec('PRAGMA busy_timeout = 3000');
    configuredDemo=createDemoAi(db);
  }
  return configuredDemo;
}
async function loadDemoCredential() {
  const key=demoKey(await localApiValues());
  if(!key)throw new HttpError(401,'demo_ai_unconfigured');
  return (await demoQuota()).credential(key);
}
async function officeConfigMetadata() {
  const values=await localApiValues(), config=parseLocalApiConfig(values), configured=!!demoKey(values);
  return {local_key_available:!!config.key,local_model:config.model,
    demo_ai:{...(configured?(await demoQuota()).status():demoAiStatus()),configured}};
}

const previous=process.env.OFFICE_WORKSPACE_SNAPSHOT?JSON.parse(process.env.OFFICE_WORKSPACE_SNAPSHOT):null;
delete process.env.OFFICE_WORKSPACE_SNAPSHOT;
const tools = await withMcpClient(data,client=>client.listTools());
const dataMode = data.kind;
const backendOnly = process.argv.includes('--backend-only');
const serveAsset = backendOnly ? null : (await import('./build-assets.js')).serveAsset;
// Read-only local summaries. Never copy private CSV into public assets or GPT context.
const comfortDirectory=process.env.OFFICE_COMFORT_DATA_DIR??fileURLToPath(new URL('../企业数据/2026-09-07_Bitkey/Data/',import.meta.url));
let comfortSummary;
let equipmentData;
try{
  const names=['slack空調申請_20260101-20260331.csv','satisfaction_for_space.csv','spaces.csv'];
  const bytes=await Promise.all(names.map(name=>readFile(comfortDirectory+'/'+name,'utf8')));
  const [airconRows,satisfactionRows,spaceRows]=bytes.map(text=>parse(text,{columns:true,bom:true,skip_empty_lines:true}));
  comfortSummary=summarizeEnterpriseComfort({airconRows,satisfactionRows,spaceRows});
}catch(error){comfortSummary={source:error.code==='ENOENT'?'unavailable':'error',items:[],mapped_to_demo_seats:false};}
try{
  const names=['satisfaction_for_space.csv','spaces.csv'];
  const bytes=await Promise.all(names.map(name=>readFile(comfortDirectory+'/'+name,'utf8')));
  const [satisfactionRows,spaceRows]=bytes.map(text=>parse(text,{columns:true,bom:true,skip_empty_lines:true}));
  equipmentData=createEquipmentFeedback({satisfactionRows,spaceRows,sources:Object.fromEntries(names.map((name,index)=>[name,{sha256:createHash('sha256').update(bytes[index]).digest('hex')}]))});
}catch(error){equipmentData={source:error.code==='ENOENT'?'unavailable':'error'};}
// Real-day replay: local only. OFFICE_REPLAY_CSV may point to a reduced copy (room/time/people/status).
let replayData=null;
try{
  const file=process.env.OFFICE_REPLAY_CSV??comfortDirectory+'/reservations.csv';
  replayData=createRealReplay(parse(await readFile(file,'utf8'),{columns:true,bom:true,skip_empty_lines:true}));
}catch(error){if(error.code!=='ENOENT')console.error('Replay data could not be read:',error.message);}
let arrivalReplay;
function loadArrivalReplay() {
  if (arrivalReplay) return arrivalReplay;
  arrivalReplay = (async()=>{
    const values = await localApiValues();
    const setting = name => process.env[name] ?? values[name];
    const date = setting('OFFICE_ARRIVAL_REPLAY_DATE');
    const gateName = setting('OFFICE_ARRIVAL_REPLAY_GATE');
    const firstTime = setting('OFFICE_ARRIVAL_REPLAY_FIRST_TIME');
    if (!date || !gateName || !firstTime) throw new HttpError(503,'replay_unavailable');
    const [logs,spaces] = await Promise.all(['activityLogs.csv','spaces.csv'].map(
      name=>readFile(comfortDirectory+'/'+name,'utf8').then(text=>parse(text,{columns:true,bom:true,skip_empty_lines:true}))
    ));
    const data = selectArrivalReplay(logs,spaces,{date,gateName,firstTime});
    if (!data) throw new HttpError(503,'replay_unavailable');
    return createArrivalReplay(data);
  })().catch(()=>{
    arrivalReplay = undefined;
    throw new HttpError(503,'replay_unavailable');
  });
  return arrivalReplay;
}
// Use the same fixed historical batch as the public Worker; never roll dates forward.
// A supplied snapshot preserves the user's records when replacing a local preview.
const workspace=createHistoricalDemoState({rooms:officeRooms,previousSnapshot:previous});
const port=Number(process.env.PORT || (backendOnly ? 4182 : 4180));
const frontendOrigin = loopbackHttpOrigin(process.env.INTENTSPACE_FRONTEND_ORIGIN
  ?? `http://127.0.0.1:${backendOnly ? 4180 : port}`).origin;
const backendOrigins = new Set([frontendOrigin,`http://127.0.0.1:${port}`,`http://localhost:${port}`]);
const google=createGoogleCalendar({
  clientId:process.env.GOOGLE_CALENDAR_CLIENT_ID,clientSecret:process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
  redirectUri:frontendOrigin+'/oauth/google/callback'
});
const handleOfficeRequest=createOfficeService({comfortSummary,equipmentData,replayData,workspace,
  proactiveGoogle:google,proactiveModelConfig:localApiConfig});

function sendResponse(res,response) {
  const headers=Object.fromEntries(response.headers);
  const cookies=response.headers.getSetCookie();
  if(cookies.length)headers['set-cookie']=cookies;
  res.writeHead(response.status,headers);
  if(!response.body){res.end();return;}
  const stream=Readable.fromWeb(response.body);
  stream.on('error',error=>res.destroy(error));
  res.on('close',()=>{if(!res.writableEnded)stream.destroy();});
  stream.pipe(res);
}

const server = createServer(async (req,res) => {
  const controller = new AbortController();
  req.on('aborted', () => controller.abort());
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const origin = req.headers.origin;
    const requestOrigin = `http://${req.headers.host}`;
    const url = new URL(req.url,requestOrigin);
    if (url.origin !== requestOrigin || (origin && origin !== requestOrigin) || (backendOnly && !backendOrigins.has(requestOrigin)))
      throw new HttpError(403,'許可されていないオリジンです');
    function incoming() {
      return new Request(url,{
        method:req.method,headers:req.headers,signal:controller.signal,
        ...(['GET','HEAD'].includes(req.method)?{}:{body:Readable.toWeb(req),duplex:'half'})
      });
    }
    if(url.pathname==='/mcp'){
      sendResponse(res,await handleReadOnlyMcp(incoming(),data));return;
    }
    if(url.pathname==='/oauth/google/callback'&&req.method==='GET'){
      sendResponse(res,await google.callback(incoming()));return;
    }
    if(url.pathname==='/api/office/config'&&req.method==='GET'){
      assertSameOrigin(incoming());
      sendResponse(res,json(await officeConfigMetadata()));return;
    }
    if(url.pathname.startsWith('/api/office/')){
      const input=incoming();
      if (isArrivalReplayPath(url.pathname)) {
        const replay = await loadArrivalReplay();
        sendResponse(res,await replay(input));return;
      }
      const request=await withLocalApiKey(input,async()=>(await localApiConfig()).key);
      await withDemoApiKey(request,loadDemoCredential);
      sendResponse(res,await handleOfficeRequest(request));return;
    }
    if (req.method === 'GET' && url.pathname === '/api/review-demo') {
      sendResponse(res,await handleReviewDemo(incoming()));return;
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      assertSameOrigin(incoming());
      sendResponse(res,json({ ai_enabled: dataMode === 'synthetic', data_mode: dataMode, deployment: 'local', endpoint: 'https://api.openai.com/v1/responses',...await (dataMode==='synthetic'?officeConfigMetadata():localConfigMetadata()) }));return;
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      if (dataMode !== 'synthetic') throw new HttpError(403, '企業サンプルの外部 AI 送信は無効です。架空データで起動してください');
      const inputRequest = incoming();
      assertSameOrigin(inputRequest);
      const request = await withLocalApiKey(inputRequest,async()=>(await localApiConfig()).key);
      const apiKey = readApiKey(await withDemoApiKey(request,loadDemoCredential));
      const input = await readJson(request);
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(90000)]);
      const result=await withMcpClient(data,client=>answerQuestion(client,apiKey,input,{signal}));
      sendResponse(res,json(result));return;
    }
    if (req.method === 'GET' && url.pathname === '/api/tools') {
      assertSameOrigin(incoming());
      sendResponse(res,json(tools));return;
    }
    if (req.method === 'POST' && url.pathname === '/api/call') {
      const request=incoming();
      assertSameOrigin(request);
      const input=await readJson(request,10000);
      if (!input || !tools.tools.some(tool=>tool.name===input.name)) throw new HttpError(400,'不明なツールです');
      const started = Date.now();
      const result = await withMcpClient(data,client=>client.callTool({name:input.name,arguments:input.arguments??{}}));
      sendResponse(res,json({result,elapsed_ms:Date.now()-started}));return;
    }
    if (serveAsset && await serveAsset(req,res,url.pathname)) return;
    res.writeHead(404); res.end('見つかりません');
  } catch(error) { if(res.headersSent)res.destroy();else sendResponse(res,errorResponse(error)); }
});
server.listen(port,'127.0.0.1',()=>console.log(`IntentSpace ${backendOnly?'backend':'demo'}: http://127.0.0.1:${server.address().port}`));
function close() { server.close(); }
process.on('SIGINT', close); process.on('SIGTERM', close);
