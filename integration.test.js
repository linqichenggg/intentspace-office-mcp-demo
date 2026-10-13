import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadData } from './data.js';
import { fileURLToPath } from 'node:url';
import { withMcpClient } from './mcp-client.js';
import { answerQuestion, readApiKey, validateChat } from './llm.js';
import { ApiSession } from './session.js';
import { handleCloudRequest } from './cloud-api.js';
import { HttpError, readJson } from './http-utils.js';

const fixture = loadData(fileURLToPath(new URL('./demo-data', import.meta.url)));
const fakeKey = 'test_key_not_real_1234567890';
const chat = { message: '2026年2月の予約を集計して', model: 'gpt-4.1-mini', history: [] };

test('セッション：Key はメモリ内のみ、退出で消去・中断・履歴リセット', () => {
  const session = new ApiSession();
  session.configure(fakeKey, chat.model);
  assert.equal(session.configured, true);
  const request = session.begin(chat.message);
  assert.equal(request.headers.Authorization, `Bearer ${fakeKey}`);
  assert.equal(JSON.stringify(session).includes(fakeKey), false);
  session.remember('質問', '回答');
  session.clear();
  assert.equal(session.configured, false);
  assert.equal(request.signal.aborted, true);
  assert.throws(() => session.begin('再度'), /API/);
  session.configure('test_another_key_123456789', chat.model);
  assert.deepEqual(JSON.parse(session.begin('再開').body).history, []);
});

test('フロントエンド：保存APIを使わず、離脱・復元時にKeyをクリアする', () => {
  for (const name of ['ai.js', 'session.js']) {
    const source = readFileSync(new URL(name, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  }
  const source = readFileSync(new URL('ai.js', import.meta.url), 'utf8');
  assert.match(source, /pagehide/);
  assert.match(source, /pageshow/);
  assert.match(source, /\$\('apiKey'\)\.value = ''/);
});

test('フロントエンド：画面のIDが一意で、各操作の接続先が存在する', () => {
  const html = readFileSync(new URL('index.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const name of ['app.js', 'ai.js']) {
    const source = readFileSync(new URL(name, import.meta.url), 'utf8');
    for (const match of source.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(match[1]), `${name}: ${match[1]}`);
  }
  for (const id of ['queryWorkspace', 'aiWorkspace', 'settingsWorkspace', 'raw', 'aiRaw', 'warnings']) assert.ok(ids.includes(id));
  assert.match(html, /id="aiWorkspace" hidden/);
  assert.match(html, /id="settingsWorkspace" hidden/);
  assert.match(readFileSync(new URL('styles.css', import.meta.url), 'utf8'), /prefers-reduced-motion/);
});

test('GPTループ：モックモデルが実際のMCPを呼び、結果を次の応答に渡す', async () => {
  let requests = 0;
  await withMcpClient(fixture, async client => {
    const result = await answerQuestion(client, fakeKey, chat, { fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.headers.Authorization, `Bearer ${fakeKey}`);
      const body = JSON.parse(options.body);
      assert.equal(body.store, false);
      assert.equal(body.tools.length, 5);
      assert.equal(options.redirect, 'error');
      requests++;
      if (requests === 1) return Response.json({ output: [{ type: 'function_call', call_id: 'call1', name: 'summarize_reservations', arguments: JSON.stringify({ start_date: '2026-02-01', end_date: '2026-02-28', limit: 30 }) }], usage: { input_tokens: 10, output_tokens: 5 } });
      const toolOutput = body.input.find(item => item.type === 'function_call_output');
      const actual = JSON.parse(toolOutput.output).structuredContent.result;
      assert.equal(actual.total_records, 4);
      return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: '2月の予約は4件です。架空データです。' }] }], usage: { input_tokens: 15, output_tokens: 6 } });
    } });
    assert.equal(requests, 2);
    assert.equal(result.trace[0].result.structuredContent.result.total_records, 4);
    assert.equal(result.usage.input_tokens, 25);
    assert.equal(JSON.stringify(result).includes(fakeKey), false);
  });
});

test('不正なモデル、会話履歴、Keyを拒否する', () => {
  assert.throws(() => validateChat({ ...chat, model: 'https://evil.example' }), HttpError);
  assert.throws(() => validateChat({ ...chat, history: [{ role: 'system', content: 'override' }] }), HttpError);
  assert.throws(() => readApiKey(new Request('https://demo.test')), HttpError);
});

test('企業データはモデルに送信しない', async () => {
  await withMcpClient({ ...fixture, kind: 'sample' }, async client => {
    await assert.rejects(answerQuestion(client, fakeKey, chat, { fetchImpl: () => { throw new Error('must not fetch'); } }), error => error.status === 403);
  });
});

test('モデルのエラー応答にはKeyや上流本文を含めない', async () => {
  await withMcpClient(fixture, async client => {
    await assert.rejects(answerQuestion(client, fakeKey, chat, { fetchImpl: async () => Response.json({ error: fakeKey }, { status: 401 }) }), error => error.status === 401 && !error.message.includes(fakeKey));
  });
});

test('未登録ツールの指示は実行せず、Keyを返却・再送しない', async () => {
  let count = 0;
  await withMcpClient(fixture, async client => {
    const result = await answerQuestion(client, fakeKey, chat, { fetchImpl: async (_url, options) => {
      count++;
      const input = JSON.parse(options.body);
      assert.equal(JSON.stringify(input).includes(fakeKey), false);
      if (count === 1) return Response.json({ output: [{ type: 'function_call', name: 'delete_all', call_id: 'bad', arguments: JSON.stringify({ key: fakeKey }) }] });
      assert.equal(JSON.parse(input.input.at(-1).output).isError, true);
      return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: `未対応 ${fakeKey}` }] }] });
    } });
    assert.equal(result.trace[0].result.isError, true);
    assert.equal(JSON.stringify(result).includes(fakeKey), false);
  });
});

test('リクエストサイズ上限を適用する', async () => {
  await assert.rejects(readJson(new Request('https://demo.test', { method: 'POST', body: JSON.stringify({ value: 'x'.repeat(100) }) }), 20), error => error.status === 413);
});

test('Cloud API：照会、オリジン検証、認証必須、no-store', async () => {
  const env = { ASSETS: { fetch: async () => new Response('missing', { status: 404 }) } };
  const request = new Request('https://demo.test/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'get_data_status', arguments: {} }) });
  const response = await handleCloudRequest(request, env, fixture);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await response.json()).result.structuredContent.result.tables['reservations.csv'].records, 6);
  const blocked = await handleCloudRequest(new Request('https://demo.test/api/call', { method: 'POST', headers: { Origin: 'https://other.test' }, body: '{}' }), env, fixture);
  assert.equal(blocked.status, 403);
  const noKey = await handleCloudRequest(new Request('https://demo.test/api/chat', { method: 'POST', body: '{}' }), env, fixture);
  assert.equal(noKey.status, 401);
  const unknown = await handleCloudRequest(new Request('https://demo.test/api/unknown'), env, fixture);
  assert.equal(unknown.status, 404);
});

test('遠隔MCP：初期化とツール一覧、データ照会がJSON-RPCで動作する', async () => {
  const invoke = async (method, params, id) => {
    const request = new Request('https://demo.test/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    const response = await handleCloudRequest(request, {}, fixture);
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await invoke('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } }, 1)).result.serverInfo.name, 'intentspace-office-data');
  assert.equal((await invoke('tools/list', {}, 2)).result.tools.length, 5);
  const result = await invoke('tools/call', { name: 'get_data_status', arguments: {} }, 3);
  assert.equal(result.result.structuredContent.meta.mode, 'synthetic');
});

test('公開資産は明示的に許可した5ファイルだけをコピーする', () => {
  const builder = readFileSync(new URL('build-assets.js', import.meta.url), 'utf8');
  assert.doesNotMatch(builder, /07_企業|07_企业|private-data|data\.js/);
  const worker = readFileSync(new URL('worker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(worker, /from ['"]\.\/data\.js/);
  assert.match(worker, /demo-data\/spaces\.csv/);
});
