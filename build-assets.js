import { mkdir, copyFile, readdir, readFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { argv, env } from 'node:process';
import { pathToFileURL } from 'node:url';
import { loopbackHttpOrigin } from './http-utils.js';

const files = ['home.html', 'home.js', 'index.html', 'styles.css', 'app.js', 'ai.js', 'session.js', 'office.html', 'office.css', 'office.js', 'ui-i18n.js', 'office-layout.js', 'calendar-ui.js', 'equipment-feedback-ui.js', 'insights-ui.js', 'replay-ui.js'];
const pageAliases = [
  ['/','home.html'], ['/arrival-replay','home.html'], ['/admin','office.html'], ['/history','index.html']
];
const assets = new Map([...pageAliases,...files.map(file=>['/'+file,file])]);

async function buildAssets() {
  const target = new URL('./.build/assets/',import.meta.url);
  await mkdir(target,{recursive:true});
  const existing = await readdir(target);
  if (existing.some(file=>!files.includes(file))) throw new Error('公開資産ディレクトリに未承認のファイルがあります');
  for (const file of files) await copyFile(new URL(file,import.meta.url),new URL(file,target));
  console.log(`公開する Web 資産：${files.join(', ')}。TSG配置の派生モデルを含みます。企業CSV・原図画像は含みません。`);
}

export async function serveAsset(req,res,path) {
  const file = assets.get(path);
  if (!file || !['GET','HEAD'].includes(req.method)) return false;
  const body = req.method === 'GET' ? await readFile(new URL(file,import.meta.url)) : undefined;
  const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript';
  res.setHeader('Content-Type',type+'; charset=utf-8');
  res.end(body);
  return true;
}

const hopByHop = ['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade'];
function forwardedHeaders(headers) {
  const excluded = new Set([...hopByHop,...String(headers.connection??'').toLowerCase().split(',').map(name=>name.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([name])=>!excluded.has(name)));
}

function proxyBackend(req,res,backend,path) {
  const upstream = httpRequest(backend,{
    method:req.method,path,headers:forwardedHeaders(req.headers)
  },reply=>{
    res.writeHead(reply.statusCode,forwardedHeaders(reply.headers));
    reply.on('error',error=>res.destroy(error));
    reply.pipe(res);
  });
  upstream.setTimeout(120000,()=>upstream.destroy(new Error('Backend timed out')));
  upstream.on('error',()=>{
    if (res.destroyed) return;
    if (res.headersSent) res.destroy();
    else {
      res.writeHead(502,{'Content-Type':'application/json; charset=utf-8'});
      res.end(JSON.stringify({error:'backend_unavailable'}));
    }
  });
  req.on('error',error=>upstream.destroy(error));
  res.on('close',()=>{if (!res.writableEnded) upstream.destroy();});
  req.pipe(upstream);
}

export function createFrontendServer({origin,backend}) {
  const frontend = loopbackHttpOrigin(origin);
  const target = loopbackHttpOrigin(backend);
  if (target.port === frontend.port) throw new Error('Frontend and backend must use different ports');
  return createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    try {
      if (req.headers.host !== frontend.host) {res.writeHead(403);res.end();return;}
      const url = new URL(req.url,frontend);
      if (url.origin !== frontend.origin) {res.writeHead(403);res.end();return;}
      const path = url.pathname;
      if (path.startsWith('/api/') || path === '/oauth/google/callback' || path === '/mcp') {
        proxyBackend(req,res,target,path+url.search);
        return;
      }
      if (await serveAsset(req,res,path)) return;
      res.writeHead(404);
      res.end('見つかりません');
    } catch {
      if (res.headersSent) res.destroy();
      else {res.writeHead(500);res.end('読み込みに失敗しました');}
    }
  });
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  if (argv[2] === '--serve') {
    const port=Number(env.PORT||4180);
    const origin=env.INTENTSPACE_FRONTEND_ORIGIN??`http://127.0.0.1:${port}`;
    const backend=env.INTENTSPACE_BACKEND_URL??'http://127.0.0.1:4182';
    const frontend=createFrontendServer({origin,backend});
    frontend.listen(port,'127.0.0.1',()=>console.log(`IntentSpace frontend: ${origin}`));
  } else await buildAssets();
}
