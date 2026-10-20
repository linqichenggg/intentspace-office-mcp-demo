import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadData } from './data.js';
import { fileURLToPath } from 'node:url';
import { withMcpClient } from './mcp-client.js';
import { answerQuestion, readApiKey, validateChat } from './llm.js';
import { ApiSession, ReviewComparison, compareReviewSnapshots } from './session.js';
import { handleCloudRequest } from './cloud-api.js';
import { HttpError, readJson } from './http-utils.js';
import { createDataset, createReviewDemoDataset } from './queries.js';
import { handleStoredOfficeRequest } from './office-service.js';
import { parseLocalDayPlan } from './day-plan.js';

const fixture = loadData(fileURLToPath(new URL('./demo-data', import.meta.url)));
const fakeKey = 'test_key_not_real_1234567890';
const chat = { message: '2026年2月の予約を集計して', model: 'gpt-4.1-mini', history: [] };
const reviewPeriod = { start_date: '2026-02-01', end_date: '2026-02-28' };
const reviewArgs = { ...reviewPeriod, min_reservations: 2, min_unused: 1, min_unused_percent: 50 };
async function review(client, args = {}) {
  const response = await client.callTool({ name: 'detect_unused_reservations', arguments: { ...reviewPeriod, ...args } });
  assert.notEqual(response.isError, true);
  return response.structuredContent.result;
}

// Additional test records stay in memory; public demo CSVs are unchanged.
function ruleDataset(entries) {
  const template = fixture.reservations.find(row => row.reservations_id === 'demo-r2');
  const rows = [fixture.reservations[0], ...entries.map((entry, index) => ({ ...template, reservations_id: `rule-${index}`, ...entry })), fixture.reservations.at(-1)];
  const headers = Object.keys(template);
  const reservations = [headers.join(','), ...rows.map(row => headers.map(key => row[key]).join(','))].join('\n');
  return createDataset({
    'spaces.csv': readFileSync(new URL('demo-data/spaces.csv', import.meta.url), 'utf8'),
    'reservations.csv': reservations,
    'reservations_classified_mapping.csv': readFileSync(new URL('demo-data/reservations_classified_mapping.csv', import.meta.url), 'utf8')
  }, 'synthetic');
}

async function snapshotOf(entries, args = reviewArgs) {
  return withMcpClient(ruleDataset(entries), async client => (await review(client, args)).comparison_snapshot);
}

test('画面デモ：実際のMCPで基準・新規・継続・条件未達を計算する', async () => {
  const session = new ReviewComparison();
  const snapshots = [];
  const initialData = JSON.stringify(fixture);
  for (let step = 0; step < 4; step++) {
    const response = await handleCloudRequest(new Request(`https://demo.test/api/review-demo?step=${step}`), {}, fixture);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const payload = await response.json();
    assert.equal(payload.simulation, true);
    assert.equal(payload.step, step);
    const result = payload.result;
    assert.deepEqual(result.rule, {min_reservations:2, min_unused:1, min_unused_percent:50});
    assert.deepEqual(result.period, reviewPeriod);
    assert.equal(result.total_spaces, 1);
    const item = result.items[0];
    assert.equal(item.eligible_reservations, [2,4,4,9][step]);
    assert.equal(item.unused_count, [0,2,2,2][step]);
    assert.equal(item.unused_percent, [0,50,50,22.22][step]);
    const comparison = session.check(result.comparison_snapshot);
    assert.equal(comparison.state, step === 0 ? 'baseline' : 'compared');
    if (step > 0) assert.equal(comparison.counts[['','new','ongoing','no_longer_matches'][step]], 1);
    if (step === 2) { assert.equal(comparison.data_changed, false); assert.equal(comparison.counts.new, 0); }
    const hashes = new Set(payload.evidence.map(evidence => evidence.source.sha256));
    assert.equal(hashes.size, 1);
    assert.equal([...hashes][0], createReviewDemoDataset(step).data.sources['reservations.csv'].sha256);
    assert.equal(payload.evidence.length, item.eligible_reservations);
    payload.evidence.forEach(({record,source}, index) => {
      assert.equal(record.reservation_id, `scenario-r${index+1}`);
      assert.equal(source.logical_record_including_header, index+2);
      assert.equal(source.file, 'reservations.csv');
    });
    assert.deepEqual(item.evidence.map(row=>row.reservation_id), step===1 || step===2 ? ['scenario-r3','scenario-r4'] : []);
    snapshots.push(result.comparison_snapshot);
  }
  assert.equal(JSON.stringify(fixture), initialData);
  assert.equal(snapshots[0].dataset_scope, snapshots[3].dataset_scope);
  assert.notEqual(snapshots[0].data_hash, snapshots[1].data_hash);
  assert.notEqual(snapshots[1].data_hash, snapshots[3].data_hash);
  session.clear();
  assert.equal(session.check(snapshots[0]).state, 'baseline');
});

test('画面デモ：不正なステップ・条件注入・別オリジンを拒否する', async () => {
  for (const query of ['', '?step=-1', '?step=4', '?step=01', '?step=1.0', '?step=', '?step=one', '?step=1&step=2', '?step=1&space_id=private', '?step=1&min_unused=0']) {
    const response = await handleCloudRequest(new Request(`https://demo.test/api/review-demo${query}`), {}, fixture);
    assert.equal(response.status, 400, query);
  }
  for (const headers of [{Origin:'https://other.test'}, {'Sec-Fetch-Site':'cross-site'}]) {
    assert.equal((await handleCloudRequest(new Request('https://demo.test/api/review-demo?step=1', {headers}), {}, fixture)).status, 403);
  }
  assert.equal((await handleCloudRequest(new Request('https://demo.test/api/review-demo?step=1', {method:'POST'}), {}, fixture)).status, 404);
});

test('画面デモ：企業データと通常の比較基準から分離する', async () => {
  const normal = new ReviewComparison();
  const normalSnapshot = await withMcpClient(fixture, async client => (await review(client, reviewArgs)).comparison_snapshot);
  normal.check(normalSnapshot);
  const response = await handleCloudRequest(new Request('https://demo.test/api/review-demo?step=1'), {}, { kind:'sample', reservations:null });
  const demo = await response.json();
  assert.equal(response.status, 200);
  assert.ok(demo.evidence.every(({record}) => record.reservation_id.startsWith('scenario-')));
  assert.equal(normal.check(normalSnapshot).counts.ongoing, 1);
  assert.equal(compareReviewSnapshots(normalSnapshot,demo.result.comparison_snapshot).state, 'incomparable');
  assert.throws(()=>createReviewDemoDataset(4));
});

test('画面デモ：既存の記録を保持して追加し、各リクエストのデータを共有しない', () => {
  const a = createReviewDemoDataset(0).data;
  const b = createReviewDemoDataset(1).data;
  const repeated = createReviewDemoDataset(2).data;
  const c = createReviewDemoDataset(3).data;
  assert.deepEqual(b.reservations.slice(0,2), a.reservations);
  assert.deepEqual(c.reservations.slice(0,4), b.reservations);
  assert.deepEqual(b.sources, repeated.sources);
  b.reservations[0].is_used = 'false';
  assert.equal(createReviewDemoDataset(1).data.reservations[0].is_used, 'true');
  assert.equal(repeated.reservations[0].is_used, 'true');
});

test('結果比較：初回は基準のみ、新規・継続・条件未達を2バッチで識別', async () => {
  const below = await snapshotOf([{is_used:'true'}, {is_used:'true'}]);
  const candidate = await snapshotOf([{is_used:'true'}, {is_used:'false'}]);
  const session = new ReviewComparison();
  assert.equal(session.check(below).state, 'baseline');
  const added = session.check(candidate);
  assert.equal(added.data_changed, true);
  assert.equal(added.counts.new, 1);
  assert.equal(added.items[0].space_id, 'demo-room-a');
  assert.equal(added.items[0].previous.status, 'below_threshold');
  const repeated = session.check(candidate);
  assert.equal(repeated.data_changed, false);
  assert.equal(repeated.counts.new, 0);
  assert.equal(repeated.counts.ongoing, 1);
  assert.equal(session.check(below).counts.no_longer_matches, 1);
  assert.equal(session.check(below).counts.unchanged, 1);
  session.clear();
  assert.equal(session.check(candidate).state, 'baseline');
});

test('結果比較：条件変更時は比較せず、元の基準を保持し明示的に再設定', async () => {
  const below = await snapshotOf([{is_used:'true'}, {is_used:'true'}]);
  const candidate = await snapshotOf([{is_used:'true'}, {is_used:'false'}]);
  const session = new ReviewComparison();
  session.check(below);
  const variants = [
    ['rule_changed', value => { value.rule.min_unused_percent = 40; }],
    ['scope_changed', value => { value.scope.end_date = '2026-02-27'; }],
    ['scope_changed', value => { value.scope.space_id = 'demo-room-a'; }],
    ['dataset_changed', value => { value.dataset_scope = 'a'.repeat(64); }],
    ['metric_changed', value => { value.metric_version = 'another-metric'; }]
  ];
  for (const [reason, modify] of variants) {
    const changed = structuredClone(candidate);
    modify(changed);
    const result = session.check(changed);
    assert.equal(result.state, 'incomparable');
    assert.equal(result.reason, reason);
    assert.equal(result.counts.new, 0);
  }
  assert.equal(session.check(candidate).counts.new, 1);
  const changed = structuredClone(candidate);
  changed.rule.min_unused_percent = 40;
  assert.equal(session.setBaseline(changed).state, 'baseline');
  assert.equal(session.check(changed).counts.ongoing, 1);
});

test('結果比較：不足・不明・消えた空間を問題解消として扱わない', async () => {
  const candidate = await snapshotOf([{is_used:'true'}, {is_used:'false'}]);
  const insufficient = await snapshotOf([{is_used:'true'}]);
  const unknown = await snapshotOf([{is_used:'true'}, {is_used:'true'}, {is_used:''}]);
  const anotherSpace = await snapshotOf([{space_id:'demo-room-b',space_name:'Demo Meeting B',is_used:'true'}, {space_id:'demo-room-b',space_name:'Demo Meeting B',is_used:'false'}]);
  for (const current of [insufficient, unknown, anotherSpace]) {
    const result = compareReviewSnapshots(candidate, current);
    assert.equal(result.counts.no_longer_matches, 0);
    assert.equal(result.counts.new, 0);
    assert.ok(result.counts.uncertain >= 1);
  }
  assert.equal(compareReviewSnapshots(insufficient, candidate).counts.new, 0);
});

test('結果比較：表示ページに依存せず、名前変更や並べ替えで新規にならない', async () => {
  await withMcpClient(fixture, async client => {
    const first = (await review(client, {...reviewArgs,limit:1})).comparison_snapshot;
    const second = (await review(client, {...reviewArgs,offset:1,limit:1})).comparison_snapshot;
    assert.equal(first.total_spaces, 3);
    assert.deepEqual(first, second);
    assert.equal(compareReviewSnapshots(first, second).counts.new, 0);
    second.items.reverse();
    second.items.find(item=>item.space_id==='demo-room-a').name = '別の表示名';
    assert.equal(compareReviewSnapshots(first, second).counts.ongoing, 1);
  });
});

test('結果比較：欠損・重複・不正な状態を拒否し、失敗時に基準を壊さない', async () => {
  const below = await snapshotOf([{is_used:'true'}, {is_used:'true'}]);
  const candidate = await snapshotOf([{is_used:'true'}, {is_used:'false'}]);
  const session = new ReviewComparison();
  session.check(below);
  const mutations = [
    value => { value.items = []; },
    value => { value.items.push({...value.items[0]});value.total_spaces++; },
    value => { value.items[0].status = 'below_threshold'; },
    value => { value.items[0].unused_count = -1; },
    value => { value.rule.min_reservations = 0; },
    value => { value.scope.start_date = '2026-02-30'; },
    value => { value.data_hash = ''; },
    value => { value.schema_version = 99; }
  ];
  for (const modify of mutations) {
    const invalid = structuredClone(candidate);
    modify(invalid);
    assert.throws(()=>session.check(invalid), /無効/);
  }
  assert.throws(()=>session.check(null), /無効/);
  assert.equal(session.check(candidate).counts.new, 1);
});

test('結果比較：基準の外部変更から分離し、読込時刻だけの違いで更新扱いしない', async () => {
  const below = await snapshotOf([{is_used:'true'}, {is_used:'true'}]);
  const candidate = await snapshotOf([{is_used:'true'}, {is_used:'false'}]);
  const session = new ReviewComparison();
  session.setBaseline(below);
  below.rule.min_unused_percent = 10;
  assert.equal(session.check(candidate).counts.new, 1);
  const same = await snapshotOf([{is_used:'true'}, {is_used:'false'}]);
  assert.equal(session.check(same).data_changed, false);
});

test('未利用ルール：初期条件ではサンプル不足、母数ゼロは割合なし', async () => {
  await withMcpClient(fixture, async client => {
    const result = await review(client);
    assert.deepEqual(result.rule, { min_reservations: 10, min_unused: 3, min_unused_percent: 30 });
    assert.equal(result.review_count, 0);
    assert.equal(result.evaluated_count, 0);
    assert.equal(result.insufficient_count, 3);
    const booth = result.items.find(item => item.space_id === 'demo-booth');
    assert.equal(booth.eligible_reservations, 0);
    assert.equal(booth.unused_percent, null);
    assert.equal(booth.excluded_precancelled, 1);
    assert.ok(result.items.every(item => item.evidence.length === 0 && item.suggestion === null));
  });
});

test('未利用ルール：3条件の境界、根拠の一致、繰り返しても重複しない', async () => {
  await withMcpClient(fixture, async client => {
    const result = await review(client, reviewArgs);
    assert.equal(result.review_count, 1);
    const item = result.items.find(item => item.status === 'review');
    assert.equal(item.space_id, 'demo-room-a');
    assert.equal(item.eligible_reservations, 2);
    assert.equal(item.unused_count, 1);
    assert.equal(item.unused_percent, 50);
    assert.deepEqual(item.evidence.map(row => row.reservation_id), ['demo-r3']);
    const evidence = await client.callTool({ name: 'get_evidence', arguments: { reservation_id: item.evidence[0].reservation_id } });
    assert.equal(evidence.structuredContent.result.record.is_used, false);
    assert.equal(evidence.structuredContent.result.record.date, item.evidence[0].date);
    assert.deepEqual(await review(client, reviewArgs), result);
    assert.equal(new Set(result.items.filter(row => row.finding_id).map(row => row.finding_id)).size, result.review_count);
    assert.equal((await review(client, { ...reviewArgs, min_unused: 2 })).review_count, 0);
    assert.equal((await review(client, { ...reviewArgs, min_reservations: 3 })).review_count, 0);
    assert.equal((await review(client, { ...reviewArgs, min_unused_percent: 50.1 })).review_count, 0);
  });
});

test('未利用ルール：事前取消・不明フラグは判定から除外する', async () => {
  const entries = [
    ...Array.from({length:7}, () => ({ is_used:'true' })),
    ...Array.from({length:3}, () => ({ is_used:'false' })),
    ...Array.from({length:4}, () => ({ is_reserved:'false', is_used:'false' })),
    { is_used:'' }, { is_used:'unknown' }, { is_reserved:'', is_used:'false' }
  ];
  await withMcpClient(ruleDataset(entries), async client => {
    const result = await review(client);
    assert.equal(result.review_count, 1);
    assert.equal(result.excluded_unknown, 3);
    const item = result.items[0];
    assert.equal(item.eligible_reservations, 10);
    assert.equal(item.unused_count, 3);
    assert.equal(item.unused_percent, 30);
    assert.equal(item.excluded_precancelled, 4);
    assert.equal(item.evidence_total, 3);
  });
});

test('未利用ルール：丸め前の割合で判定し、根拠は最大5件', async () => {
  await withMcpClient(ruleDataset([{is_used:'true'}, {is_used:'true'}, {is_used:'false'}]), async client => {
    const result = await review(client, { min_reservations:3, min_unused:1, min_unused_percent:33.334 });
    assert.equal(result.review_count, 0);
    assert.equal(result.items[0].unused_percent, 33.33);
  });
  await withMcpClient(ruleDataset([...Array.from({length:7}, () => ({is_used:'false'})), ...Array.from({length:3}, () => ({is_used:'true'}))]), async client => {
    const result = await review(client);
    assert.equal(result.review_count, 1);
    assert.equal(result.items[0].evidence.length, 5);
    assert.equal(result.items[0].evidence_total, 7);
  });
});

test('未利用ルール：期間とスペースの絞り込み、ページング、空結果', async () => {
  await withMcpClient(fixture, async client => {
    const all = await review(client, reviewArgs);
    const page = await review(client, { ...reviewArgs, offset:1, limit:1 });
    assert.equal(page.total_spaces, 3);
    assert.equal(page.review_count, all.review_count);
    assert.deepEqual(page.items, all.items.slice(1,2));
    assert.equal((await review(client, { ...reviewArgs, space_id:'demo-room-b' })).total_spaces, 1);
    assert.equal((await review(client, { ...reviewArgs, start_date:'2026-02-02', end_date:'2026-02-02' })).review_count, 0);
    const empty = await review(client, { ...reviewArgs, space_id:'absent' });
    assert.equal(empty.total_records, 0);
    assert.equal(empty.review_count, 0);
    assert.deepEqual(empty.items, []);
    const usedOnly = await review(client, { ...reviewArgs, start_date:'2026-02-01', end_date:'2026-02-01', min_reservations:1, min_unused_percent:0 });
    assert.equal(usedOnly.review_count, 0);
    assert.equal(usedOnly.items[0].status, 'below_threshold');
  });
});

test('未利用ルール：無効な閾値と日付をMCPが拒否する', async () => {
  await withMcpClient(fixture, async client => {
    for (const invalid of [{min_reservations:0}, {min_reservations:1.5}, {min_unused:0}, {min_unused:-1}, {min_unused_percent:-.1}, {min_unused_percent:101}, {min_unused_percent:'30'}, {limit:0}, {offset:-1}, {start_date:'2026-02-30'}, {start_date:'2026-02-28',end_date:'2026-02-01'}, {end_date:'2026-04-01'}]) {
      const result = await client.callTool({ name:'detect_unused_reservations', arguments:{...reviewPeriod,...invalid} });
      assert.equal(result.isError, true, JSON.stringify(invalid));
    }
  });
});

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
  for (const prefix of ['comparison','demoComparison']) {
    for (const suffix of ['Panel','Title','Message','Results']) assert.ok(ids.includes(prefix+suffix));
  }
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
      assert.equal(body.tools.length, 6);
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
  assert.equal((await invoke('tools/list', {}, 2)).result.tools.length, 6);
  const result = await invoke('tools/call', { name: 'get_data_status', arguments: {} }, 3);
  assert.equal(result.result.structuredContent.meta.mode, 'synthetic');
});

test('公開資産は履歴画面と社員・管理画面の9ファイルに限定する', () => {
  const builder = readFileSync(new URL('build-assets.js', import.meta.url), 'utf8');
  for(const name of ['office.html','office.css','office.js','ui-i18n.js'])assert.ok(builder.includes("'"+name+"'"));
  assert.doesNotMatch(builder, /07_企業|07_企业|private-data|data\.js/);
  const worker = readFileSync(new URL('worker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(worker, /from ['"]\.\/data\.js/);
  assert.match(worker, /demo-data\/spaces\.csv/);
});

function memoryStorage(){
  let saved=null;
  return {load:()=>structuredClone(saved),commit:(expected,state)=>{
    if((saved?.version??0)!==expected)return false;
    saved={version:expected+1,state:structuredClone(state)};return true;
  }};
}
const cloudNow=()=>new Date('2026-10-20T00:00:00Z');
const cloudPlan={message:'午後に4人で45分、モニターを使って企画を相談したいです。',mode:'rules',locale:'ja'};
async function storedCall(storage,path,body,options={}){
  const request=new Request('https://demo.test/api/office/'+path,{method:body===undefined?'GET':'POST',
    headers:{'Content-Type':'application/json',Origin:'https://demo.test'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return (await handleStoredOfficeRequest(request,storage,{now:cloudNow,...options})).json();
}

test('クラウド状態：リクエスト毎に復元しても予約・取消・再予約・開始・終了が続く',async()=>{
  const storage=memoryStorage();
  const first=await storedCall(storage,'workspace');
  assert.equal(first.deployment,'cloud');assert.equal(first.reservations.length,0);
  const plan=await storedCall(storage,'day-plan',cloudPlan),p=plan.proposals.find(p=>p.status==='proposed');
  assert.deepEqual(p.trace.map(t=>t.name),['search_spaces','query_reservations']);
  assert.ok(!JSON.stringify(storage.load()).includes('"trace"'));
  const input={plan_id:plan.plan_id,proposal_id:p.id,space_id:p.candidates[0].id,confirmed:true};
  const booked=await storedCall(storage,'confirm',input);
  assert.equal((await storedCall(storage,'confirm',input)).booking.id,booked.booking.id);
  await storedCall(storage,'transition',{meeting_id:booked.booking.id,action:'cancel'});
  const again=await storedCall(storage,'rebook',{meeting_id:booked.booking.id});
  const newBooking=await storedCall(storage,'confirm',{plan_id:again.plan_id,proposal_id:again.proposals[0].id,space_id:'office-c04',confirmed:true});
  assert.notEqual(newBooking.booking.id,booked.booking.id);
  assert.equal((await storedCall(storage,'transition',{meeting_id:newBooking.booking.id,action:'start'})).meetings.at(-1).status,'in_progress');
  const ended=await storedCall(storage,'transition',{meeting_id:newBooking.booking.id,action:'finish'});
  assert.equal(ended.meetings.at(-1).status,'completed');
  assert.equal(ended.instance_id,first.instance_id);
  assert.equal((await storedCall(storage,'admin/reservations')).total,2);
});

test('クラウド管理CRUD：保存・復元・操作IDと他者予約への参加を保持する',async()=>{
  const storage=memoryStorage();
  const data={title:'Other organiser meeting',date:'2026-10-20',time:'13:00',duration:60,people:4,space_id:'office-c04',booked_by:'Demo colleague',assigned_to:'other',features:['monitor']};
  const create={operation_id:crypto.randomUUID(),confirmed:true,data};
  const record=(await storedCall(storage,'admin/create',create)).record;
  assert.equal((await storedCall(storage,'admin/create',create)).record.id,record.id);
  const edited=(await storedCall(storage,'admin/update',{operation_id:crypto.randomUUID(),confirmed:true,meeting_id:record.id,expected_version:record.version,data:{...data,title:'Updated meeting'}})).record;
  const deleted=(await storedCall(storage,'admin/delete',{operation_id:crypto.randomUUID(),confirmed:true,meeting_id:record.id,expected_version:edited.version})).record;
  assert.equal((await storedCall(storage,'admin/reservations')).total,0);
  const restored=(await storedCall(storage,'admin/restore',{operation_id:crypto.randomUUID(),confirmed:true,meeting_id:record.id,expected_version:deleted.version})).record;
  const plan=await storedCall(storage,'day-plan',cloudPlan),p=plan.proposals[0];
  const attendance=(await storedCall(storage,'attendance',{plan_id:plan.plan_id,proposal_id:p.id,space_id:'office-c04',time:'13:00'})).meeting;
  assert.equal(attendance.source,'attendance');
  await storedCall(storage,'transition',{meeting_id:attendance.id,action:'start'});
  const result=await storedCall(storage,'transition',{meeting_id:attendance.id,action:'finish'});
  assert.equal(result.reservations.length,1);assert.equal(result.reservations[0].version,restored.version);
  assert.equal(result.reservations[0].status,'reserved');
  assert.equal(result.meetings[0].status,'completed');
});

test('クラウド並行処理：古い作業コピーを保存せず、競合後の再送も安全',async()=>{
  const storage=memoryStorage();await storedCall(storage,'workspace');
  const data={title:'Parallel',date:'2026-10-20',time:'13:00',duration:30,people:4,space_id:'office-c04',booked_by:'A',assigned_to:'A',features:[]};
  const payload={operation_id:crypto.randomUUID(),confirmed:true,data};
  const settled=await Promise.allSettled([storedCall(storage,'admin/create',payload),storedCall(storage,'admin/create',{...payload,operation_id:crypto.randomUUID()})]);
  assert.equal(settled.filter(r=>r.status==='fulfilled').length,1);
  const error=settled.find(r=>r.status==='rejected').reason;assert.equal(error.status,409);
  assert.equal((await storedCall(storage,'workspace')).meetings.length,1);
  const before=storage.load();
  const bad=new Request('https://demo.test/api/office/transition',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({meeting_id:'missing',action:'start'})});
  await assert.rejects(()=>handleStoredOfficeRequest(bad,storage,{now:cloudNow}),/meeting_missing/);
  assert.deepEqual(storage.load(),before);
});

test('クラウドルーティング：Cookieでブラウザーを隔離し、管理画面と共有、別Origin・未知資産を拒否',async()=>{
  const stores=new Map(),paths=[];
  const env={OFFICE_WORKSPACES:{getByName(name){
    if(!stores.has(name))stores.set(name,memoryStorage());
    return {fetch:request=>handleStoredOfficeRequest(request,stores.get(name),{now:cloudNow})};
  }},ASSETS:{fetch:async request=>{paths.push(new URL(request.url).pathname);return new Response('asset');}}};
  const call=(path,body,cookie,extra={})=>handleCloudRequest(new Request('https://demo.test'+path,{method:body===undefined?'GET':'POST',
    headers:{'Content-Type':'application/json',Origin:'https://demo.test',...(cookie?{Cookie:cookie}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,fixture);
  const a=await call('/api/office/workspace'),b=await call('/api/office/workspace');
  const cookie=a.headers.get('Set-Cookie').split(';')[0],other=b.headers.get('Set-Cookie').split(';')[0];
  assert.notEqual(cookie,other);assert.match(a.headers.get('Set-Cookie'),/Secure; HttpOnly; SameSite=Strict/);
  assert.notEqual((await a.json()).instance_id,(await b.json()).instance_id);
  await call('/api/office/day-plan',cloudPlan,cookie);
  assert.equal((await call('/api/office/admin/reservations',undefined,cookie)).status,200);
  assert.equal((await call('/api/office/day-plan',cloudPlan)).status,401);
  assert.equal((await call('/api/office/day-plan',cloudPlan,cookie,{Origin:'https://evil.test'})).status,403);
  assert.equal((await call('/api/office/workspace',undefined,cookie,{'Sec-Fetch-Site':'cross-site'})).status,403);
  for(const [path,asset] of [['/','/office.html'],['/admin','/office.html'],['/history','/index.html']]){assert.equal((await call(path)).status,200);assert.equal(paths.at(-1),asset);}
  for(const path of ['/worker.js','/office-service.js','/demo-data/spaces.csv','/.env'])assert.equal((await call(path)).status,404);
  assert.equal((await call('/api/office/session',{},cookie)).status,404);
  assert.equal((await call('/api/office/workspace/reset',{confirmed:false},cookie)).status,400);
  const ownStore=stores.get(cookie.split('=')[1]);const id=(await storedCall(ownStore,'workspace')).instance_id;
  await call('/api/office/workspace/reset',{confirmed:true},cookie);
  assert.equal((await storedCall(ownStore,'workspace')).instance_id,id);
  assert.equal((await call('/api/office/workspace',undefined,other)).status,200);
});

test('クラウドGPT：Keyを保存せず、復元後も提案の確認と真の不足を検証',async()=>{
  const storage=memoryStorage();
  const plan=await storedCall(storage,'day-plan',{...cloudPlan,mode:'gpt',model:'gpt-4.1-mini'},
    {dayParser:async()=>{throw new Error('Keyなしで呼び出してはいけない');}}).catch(e=>e);
  assert.equal(plan.status,401);
  const incomplete=await storedCall(storage,'day-plan',{message:'午後に会議をしたいです。',mode:'rules'});
  assert.equal(incomplete.proposals[0].status,'needs_input');
  assert.ok(incomplete.proposals[0].issues.includes('missing_people'));
  let calls=0;
  const response=await handleStoredOfficeRequest(new Request('https://demo.test/api/office/day-plan',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+fakeKey},
    body:JSON.stringify({...cloudPlan,mode:'gpt',model:'gpt-4.1-mini'})
  }),storage,{now:cloudNow,dayParser:async(key,input)=>{
    calls++;assert.equal(key,fakeKey);return parseLocalDayPlan(input.message,input.today,'ja');
  }});
  const parsed=await response.json();assert.equal(calls,1);
  const candidate=parsed.proposals[0];assert.equal(candidate.status,'proposed');
  const booking=await storedCall(storage,'confirm',{plan_id:parsed.plan_id,proposal_id:candidate.id,space_id:candidate.candidates[0].id,confirmed:true});
  assert.equal(booking.booking.status,'reserved');
  assert.ok(!JSON.stringify(storage.load()).includes(fakeKey));
});

test('クラウドGPT待機中のリセット：古い提案を保存せず、消去状態を維持する',async()=>{
  const storage=memoryStorage();await storedCall(storage,'workspace');
  let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const pending=handleStoredOfficeRequest(new Request('https://demo.test/api/office/day-plan',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+fakeKey},
    body:JSON.stringify({...cloudPlan,mode:'gpt',model:'gpt-4.1-mini'})
  }),storage,{now:cloudNow,dayParser:async(key,input)=>{entered();await gate;return parseLocalDayPlan(input.message,input.today,'ja');}});
  await started;await storedCall(storage,'workspace/reset',{confirmed:true});release();
  await assert.rejects(()=>pending,error=>error.status===409&&error.message==='state_changed');
  const saved=storage.load();assert.equal(saved.state.plans.length,0);assert.equal(saved.state.records.length,0);
});
