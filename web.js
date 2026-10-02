import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'intentspace-demo-viewer', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./server.js', import.meta.url))], env: { ...process.env }, stderr: 'inherit' });
await client.connect(transport);
const tools = await client.listTools();
const files = new Map([['/', 'index.html'], ['/app.js','app.js'], ['/styles.css','styles.css']]);
const server = createServer(async (req,res) => {
  try {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) { res.writeHead(403); res.end('Origin rejected'); return; }
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/tools') {
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(tools)); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/call') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 10000) { res.writeHead(413); res.end(); return; } }
      const input = JSON.parse(body);
      if (!tools.tools.some(t => t.name === input.name)) throw new Error('未知工具');
      const started = Date.now();
      const result = await client.callTool({ name: input.name, arguments: input.arguments ?? {} });
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ result, elapsed_ms: Date.now()-started })); return;
    }
    if (req.method === 'GET' && files.has(url.pathname)) {
      const name = files.get(url.pathname);
      res.setHeader('Content-Type', name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(await readFile(new URL(name, import.meta.url))); return;
    }
    res.writeHead(404); res.end('Not found');
  } catch(error) { res.writeHead(400, { 'Content-Type':'application/json' }); res.end(JSON.stringify({ error: error.message })); }
});
server.listen(Number(process.env.PORT || 4180), '127.0.0.1', () => console.log('Office MCP Demo: http://127.0.0.1:4180'));
async function close() { server.close(); await client.close(); process.exit(0); }
process.on('SIGINT', close); process.on('SIGTERM', close);
