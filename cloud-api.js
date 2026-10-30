import { withMcpClient } from './mcp-client.js';
import { createMcpServer } from './mcp-server.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { answerQuestion, readApiKey } from './llm.js';
import { assertSameOrigin, readJson, readRequestBody, json, errorResponse, HttpError } from './http-utils.js';
import { createReviewDemoDataset } from './queries.js';

const workspaceCookie='__Host-intentspace-workspace';
const workspaceToken=/^[a-f0-9]{64}$/;
const publicAssets=new Set(['/index.html','/styles.css','/app.js','/ai.js','/session.js','/office.html','/office.css','/office.js','/ui-i18n.js','/office-layout.js','/calendar-ui.js','/equipment-feedback-ui.js']);

async function cloudOfficeRequest(request,env){
  const url=new URL(request.url);
  if(!env.OFFICE_WORKSPACES)throw new HttpError(503,'workspace_unavailable');
  const cookies=request.headers.get('Cookie')??'';
  const matches=cookies.split(';').map(s=>s.trim()).filter(s=>s.startsWith(workspaceCookie+'='));
  let token=matches.length===1?matches[0].slice(workspaceCookie.length+1):'';
  const fresh=!workspaceToken.test(token);
  if(fresh){
    if(url.pathname!=='/api/office/workspace'||request.method!=='GET')throw new HttpError(401,'workspace_required');
    token=Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');
  }
  // Finish the bounded inbound stream before a DO can reject without reading it.
  const forwarded=request.body?new Request(request,{body:await readRequestBody(request)}):request;
  const response=await env.OFFICE_WORKSPACES.getByName(token).fetch(forwarded);
  const headers=new Headers(response.headers);
  if(fresh&&response.ok)headers.set('Set-Cookie',`${workspaceCookie}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800`);
  headers.set('Cache-Control','no-store');
  headers.set('Referrer-Policy','no-referrer');
  return new Response(response.body,{status:response.status,headers});
}

export async function handleReviewDemo(request) {
  assertSameOrigin(request);
  const url = new URL(request.url);
  const stepText = url.searchParams.get('step');
  if (!/^[0-3]$/.test(stepText ?? '') || url.searchParams.getAll('step').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'step')) {
    throw new HttpError(400, 'デモのステップは 0〜3 で指定してください。追加の条件やデータは指定できません。');
  }
  const step = Number(stepText);
  const { data, args } = createReviewDemoDataset(step);
  return withMcpClient(data, async client => {
    const result = await client.callTool({ name: 'detect_unused_reservations', arguments: args });
    if (result.isError) throw new Error('Demo rule check failed');
    const evidence = [];
    for (const row of data.reservations) {
      const response = await client.callTool({ name: 'get_evidence', arguments: { reservation_id: row.reservations_id } });
      if (response.isError) throw new Error('Demo evidence lookup failed');
      evidence.push(response.structuredContent.result);
    }
    return json({ simulation: true, step, batch: step === 0 ? 'A' : step === 3 ? 'C' : 'B', result: result.structuredContent.result, evidence });
  });
}

export async function handleCloudRequest(request, env, data) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') assertSameOrigin(request);
      if (url.pathname==='/api/office/config'&&request.method==='GET')return json({local_key_available:false});
      if (url.pathname.startsWith('/api/office/')) return await cloudOfficeRequest(request,env);
      if (request.method === 'GET' && url.pathname === '/api/review-demo') return await handleReviewDemo(request);
      if (request.method === 'GET' && url.pathname === '/api/config') return json({ ai_enabled: true, data_mode: 'synthetic', deployment: 'cloud', endpoint: 'https://api.openai.com/v1/responses',local_key_available:false });
      if (request.method === 'GET' && url.pathname === '/api/tools') return await withMcpClient(data, async client => json(await client.listTools()));
      if (request.method === 'POST' && url.pathname === '/api/call') {
        const input = await readJson(request, 10000);
        if (!input || typeof input.name !== 'string') throw new HttpError(400, 'ツール名を指定してください');
        const started = Date.now();
        return await withMcpClient(data, async client => {
          const { tools } = await client.listTools();
          if (!tools.some(tool => tool.name === input.name)) throw new HttpError(400, '不明なツールです');
          const result = await client.callTool({ name: input.name, arguments: input.arguments ?? {} });
          return json({ result, elapsed_ms: Date.now() - started });
        });
      }
      if (request.method === 'POST' && url.pathname === '/api/chat') {
        const apiKey = readApiKey(request);
        const input = await readJson(request);
        const timeout = AbortSignal.timeout(90000);
        return await withMcpClient(data, async client => json(await answerQuestion(client, apiKey, input, { signal: AbortSignal.any([request.signal, timeout]) })));
      }
      if (url.pathname === '/mcp') {
        const server = createMcpServer(data);
        const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: 10000 });
        try {
          await server.connect(transport);
          return await transport.handleRequest(request);
        } finally { await server.close(); }
      }
      if (url.pathname.startsWith('/api/')) return json({ error: '見つかりません' }, 404);
      const assetPath={'/':'/office.html','/admin':'/office.html','/history':'/index.html'}[url.pathname]??url.pathname;
      if(!publicAssets.has(assetPath)||!['GET','HEAD'].includes(request.method))return json({error:'見つかりません'},404);
      const assetUrl=new URL(request.url);assetUrl.pathname=assetPath;
      const response = await env.ASSETS.fetch(new Request(assetUrl,request));
      const headers = new Headers(response.headers);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('Cache-Control','no-store');
      headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://cdn.getshifter.co; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      return new Response(response.body, { status: response.status, headers });
    } catch (error) { return errorResponse(error); }
}
