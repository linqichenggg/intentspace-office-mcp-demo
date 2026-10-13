import { withMcpClient } from './mcp-client.js';
import { createMcpServer } from './mcp-server.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { answerQuestion, readApiKey } from './llm.js';
import { assertSameOrigin, readJson, json, errorResponse, HttpError } from './http-utils.js';

export async function handleCloudRequest(request, env, data) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') assertSameOrigin(request);
      if (request.method === 'GET' && url.pathname === '/api/config') return json({ ai_enabled: true, data_mode: 'synthetic', deployment: 'cloud', endpoint: 'https://api.openai.com/v1/responses' });
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
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://cdn.getshifter.co; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      return new Response(response.body, { status: response.status, headers });
    } catch (error) { return errorResponse(error); }
}
