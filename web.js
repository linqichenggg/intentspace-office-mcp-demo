import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { answerQuestion, readApiKey } from './llm.js';
import { readJson, HttpError, errorResponse } from './http-utils.js';
import { handleReviewDemo } from './cloud-api.js';
import { createOfficeService, officeRooms } from './office-service.js';
import { createHistoricalDemoState } from './meeting-state.js';
import { parse } from 'csv-parse/sync';
import { summarizeEnterpriseComfort } from './seat-comfort.js';

const previous=process.env.OFFICE_WORKSPACE_SNAPSHOT?JSON.parse(process.env.OFFICE_WORKSPACE_SNAPSHOT):null;
delete process.env.OFFICE_WORKSPACE_SNAPSHOT;
const client = new Client({ name: 'intentspace-demo-viewer', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./server.js', import.meta.url))], env: { ...process.env }, stderr: 'inherit' });
await client.connect(transport);
const tools = await client.listTools();
const status = await client.callTool({ name: 'get_data_status', arguments: {} });
const dataMode = status.structuredContent.meta.mode;
const files = new Map([['/', 'index.html'], ['/app.js','app.js'], ['/styles.css','styles.css'], ['/ai.js','ai.js'], ['/session.js','session.js']]);
for(const name of ['office.html','office.js','office.css','ui-i18n.js','office-layout.js'])files.set('/'+name,name);
files.set('/admin','office.html');
files.set('/history','index.html');
// Read-only local summaries. Never copy private CSV into public assets or GPT context.
const comfortDirectory=process.env.OFFICE_COMFORT_DATA_DIR??fileURLToPath(new URL('../企业数据/2026-09-07_Bitkey/Data/',import.meta.url));
let comfortSummary;
try{
  const names=['slack空調申請_20260101-20260331.csv','satisfaction_for_space.csv','spaces.csv'];
  const [airconRows,satisfactionRows,spaceRows]=await Promise.all(names.map(async name=>parse(await readFile(comfortDirectory+'/'+name,'utf8'),{columns:true,bom:true,skip_empty_lines:true})));
  comfortSummary=summarizeEnterpriseComfort({airconRows,satisfactionRows,spaceRows});
}catch(error){comfortSummary={source:error.code==='ENOENT'?'unavailable':'error',items:[],mapped_to_demo_seats:false};}
// Use the same fixed historical batch as the public Worker; never roll dates forward.
// A supplied snapshot preserves the user's records when replacing a local preview.
const workspace=createHistoricalDemoState({rooms:officeRooms,previousSnapshot:previous});
const handleOfficeRequest=createOfficeService({comfortSummary,workspace});
const server = createServer(async (req,res) => {
  const controller = new AbortController();
  req.on('aborted', () => controller.abort());
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) { res.writeHead(403); res.end('許可されていないオリジンです'); return; }
    const url = new URL(req.url, 'http://localhost');
    if(url.pathname.startsWith('/api/office/')){
      const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Readable.toWeb(req),duplex:'half'}),signal:controller.signal});
      const response=await handleOfficeRequest(request);
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;
    }
    if (req.method === 'GET' && url.pathname === '/api/review-demo') {
      const response = await handleReviewDemo(new Request(`http://${req.headers.host}${req.url}`, { headers: req.headers }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text()); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({ ai_enabled: dataMode === 'synthetic', data_mode: dataMode, deployment: 'local', endpoint: 'https://api.openai.com/v1/responses' })); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      if (dataMode !== 'synthetic') throw new HttpError(403, '企業サンプルの外部 AI 送信は無効です。架空データで起動してください');
      const request = new Request(`http://${req.headers.host}/api/chat`, { method: 'POST', headers: req.headers, body: Readable.toWeb(req), duplex: 'half', signal: controller.signal });
      const apiKey = readApiKey(request);
      const input = await readJson(request);
      const result = await answerQuestion(client, apiKey, input, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]) });
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(result)); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/tools') {
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(tools)); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/call') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 10000) { res.writeHead(413); res.end(); return; } }
      const input = JSON.parse(body);
      if (!tools.tools.some(t => t.name === input.name)) throw new Error('不明なツールです');
      const started = Date.now();
      const result = await client.callTool({ name: input.name, arguments: input.arguments ?? {} });
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ result, elapsed_ms: Date.now()-started })); return;
    }
    if (req.method === 'GET' && files.has(url.pathname)) {
      const name = files.get(url.pathname);
      res.setHeader('Content-Type', name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(await readFile(new URL(name, import.meta.url))); return;
    }
    res.writeHead(404); res.end('見つかりません');
  } catch(error) { const response=errorResponse(error);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text()); }
});
server.listen(Number(process.env.PORT || 4180), '127.0.0.1', () => console.log(`Office MCP Demo: http://127.0.0.1:${server.address().port} / RPG: /office.html`));
async function close() { server.close(); await client.close(); process.exit(0); }
process.on('SIGINT', close); process.on('SIGTERM', close);
