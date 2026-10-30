import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadData } from './data.js';
import { fileURLToPath } from 'node:url';
import { withMcpClient } from './mcp-client.js';
import { answerQuestion, readApiKey, validateChat, runOfficeImprovementAgent,parseLocalApiConfig,withLocalApiKey } from './llm.js';
import { ApiSession, ReviewComparison, compareReviewSnapshots } from './session.js';
import { handleCloudRequest } from './cloud-api.js';
import { HttpError, readJson } from './http-utils.js';
import { createDataset, createReviewDemoDataset } from './queries.js';
import { handleStoredOfficeRequest, officeRooms } from './office-service.js';
import { historicalDemoReservations, HISTORICAL_DEMO_ANCHOR } from './meeting-state.js';

const fixture = loadData(fileURLToPath(new URL('./demo-data', import.meta.url)));
// Fixed model-response fixtures: no NLP implementation or network requests in these tests.
const aiFixtures={
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
  "午後に会議をしたいです。": {
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
  }
};
function fixturePlan(message){assert.ok(aiFixtures[message], 'Missing explicit AI fixture: '+message);return structuredClone(aiFixtures[message]);}
const mockDayParser=async (_key,{message})=>fixturePlan(message);

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

test('本地Key：页面只持有可用标志，网页覆盖优先，清除恢复本地且中止旧请求',()=>{
  const session=new ApiSession();session.configureLocal({available:true,model:'gpt-4.1-mini'});
  assert.equal(session.source,'local');assert.equal(session.configured,true);
  const local=session.begin('test');assert.equal(local.headers.Authorization,undefined);assert.equal(local.headers['X-IntentSpace-Key-Source'],'local');
  session.configure(fakeKey,'gpt-4.1');assert.equal(local.signal.aborted,true);assert.equal(session.source,'page');assert.equal(session.model,'gpt-4.1');
  const page=session.begin('override');assert.equal(page.headers.Authorization,'Bearer '+fakeKey);assert.equal(page.headers['X-IntentSpace-Key-Source'],undefined);
  session.clear();assert.equal(page.signal.aborted,true);assert.equal(session.source,'local');assert.equal(session.model,'gpt-4.1-mini');
  assert.doesNotMatch(JSON.stringify(session),new RegExp(fakeKey));
  session.configureLocal({available:false});assert.equal(session.configured,false);assert.throws(()=>session.begin('missing'),/API/);
});
test('本地Key配置：空值不自动启用，Key和模型格式错误不回显内容',()=>{
  assert.deepEqual(parseLocalApiConfig({}),{key:'',model:'gpt-6.1-sol'});
  assert.equal(parseLocalApiConfig({OPENAI_API_KEY:' '+fakeKey+' ',OPENAI_MODEL:'gpt-4.1'}).key,fakeKey);
  for(const values of [{OPENAI_API_KEY:'bad key private value'},{OPENAI_MODEL:'private invalid model'}])
    assert.throws(()=>parseLocalApiConfig(values),error=>error.message==='local_config_invalid'&&!error.message.includes('private'));
});
test('本地Key注入：只对明确选择本地的模型入口生效，保留请求正文和中断信号',async()=>{
  const paths=['/api/chat','/api/office/day-plan','/api/office/replan','/api/office/rebook','/api/office/parse','/api/office/improvements','/api/office/calendar/analyze','/api/office/calendar/review','/api/office/equipment/analyze','/api/office/data/chat'];
  for(const path of paths){
    let reads=0;const controller=new AbortController(),body=JSON.stringify({model:chat.model,message:'test'});
    const original=new Request('http://127.0.0.1:4205'+path,{method:'POST',headers:{'X-IntentSpace-Key-Source':'local','Content-Type':'application/json'},body,signal:controller.signal});
    const prepared=await withLocalApiKey(original,async()=>{reads++;return fakeKey;});
    assert.equal(readApiKey(prepared),fakeKey);assert.equal(prepared.headers.has('x-intentspace-key-source'),false);assert.equal(await prepared.text(),body);assert.equal(reads,1);
    controller.abort();assert.equal(prepared.signal.aborted,true);
  }
});
test('本地Key隔离：网页Key包括错误值均不回退，无标志及非模型路径不读取默认Key',async()=>{
  const never=()=>{throw new Error('Local key must not be read');};
  for(const authorization of ['Bearer '+fakeKey,'Bearer wrong','']){
    const original=new Request('http://localhost/api/office/day-plan',{method:'POST',headers:{authorization,'X-IntentSpace-Key-Source':'local'},body:'{}'});
    const result=await withLocalApiKey(original,never);assert.equal(result,original);
    if(authorization==='Bearer '+fakeKey)assert.equal(readApiKey(result),fakeKey);else assert.throws(()=>readApiKey(result),/api_key/);
  }
  for(const path of ['/api/office/admin/create','/api/office/workspace','/api/call']){
    const original=new Request('http://localhost'+path,{method:'POST',headers:{'X-IntentSpace-Key-Source':'local'},body:'{}'});
    assert.equal(await withLocalApiKey(original,never),original);
  }
  const plain=new Request('http://localhost/api/office/day-plan',{method:'POST',body:'{}'});assert.equal(await withLocalApiKey(plain,never),plain);
});
test('本地Key安全：拒绝跨源和非回环Host，不读取配置；缺省Key不会伪装成功',async()=>{
  let reads=0;const load=async()=>{reads++;return fakeKey;};
  for(const [url,headers] of [['http://attacker.test/api/office/day-plan',{}],['http://127.0.0.1:4205/api/office/day-plan',{origin:'https://attacker.test'}],['http://127.0.0.1/api/office/day-plan',{'sec-fetch-site':'cross-site'}]]){
    await assert.rejects(withLocalApiKey(new Request(url,{method:'POST',headers:{'X-IntentSpace-Key-Source':'local',...headers},body:'{}'}),load),error=>error.status===403);
  }
  assert.equal(reads,0);
  await assert.rejects(withLocalApiKey(new Request('http://localhost/api/office/day-plan',{method:'POST',headers:{'X-IntentSpace-Key-Source':'local'},body:'{}'}),async()=>''),error=>error.message==='api_key_missing');
});
test('云端Key隔离与资源：无本地默认Key，缺网页Key拒绝，密钥文件不可下载，设备UI可访问',async()=>{
  let assetCalls=0;const env={OPENAI_API_KEY:fakeKey,ASSETS:{fetch:async request=>{assetCalls++;return new Response(new URL(request.url).pathname);}}};
  const config=await handleCloudRequest(new Request('https://demo.test/api/office/config'),env,fixture);
  assert.deepEqual(await config.json(),{local_key_available:false});
  const legacy=await (await handleCloudRequest(new Request('https://demo.test/api/config'),env,fixture)).json();assert.equal(legacy.local_key_available,false);assert.doesNotMatch(JSON.stringify(legacy),new RegExp(fakeKey));
  const denied=await handleCloudRequest(new Request('https://demo.test/api/chat',{method:'POST',headers:{'X-IntentSpace-Key-Source':'local'},body:'{}'}),env,fixture);assert.equal(denied.status,401);
  for(const path of ['/.env.local','/.env','/.dev.vars','/web.js'])assert.equal((await handleCloudRequest(new Request('https://demo.test'+path),env,fixture)).status,404);
  assert.equal(assetCalls,0);assert.equal((await handleCloudRequest(new Request('https://demo.test/equipment-feedback-ui.js'),env,fixture)).status,200);assert.equal(assetCalls,1);
});
test('发布排除：本地Key文件受Git规则保护，构建白名单和Worker入口不加载本机配置',()=>{
  const ignore=readFileSync(new URL('.gitignore',import.meta.url),'utf8');assert.match(ignore,/^\.env\.\*$/m);
  const builder=readFileSync(new URL('build-assets.js',import.meta.url),'utf8');assert.doesNotMatch(builder,/\.env|\.dev.vars|web\.js/);
  const worker=readFileSync(new URL('worker.js',import.meta.url),'utf8');assert.doesNotMatch(worker,/web\.js|OPENAI_API_KEY|\.env/);
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
test('Key入力エラー：未設定と不正形式を区別し、OpenAIの認証失敗と混同しない',()=>{
  assert.throws(()=>readApiKey(new Request('https://demo.test')),error=>error.message==='api_key_missing'&&error.status===401&&error.diagnostics.source==='local');
  assert.throws(()=>readApiKey(new Request('https://demo.test',{headers:{Authorization:'Bearer short'}})),error=>error.message==='api_key_format'&&error.diagnostics.source==='local');
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

test('公開資産は履歴・社員・管理・カレンダー・設備画面の12ファイルに限定する', () => {
  const builder = readFileSync(new URL('build-assets.js', import.meta.url), 'utf8');
  for(const name of ['office.html','office.css','office.js','ui-i18n.js','office-layout.js','calendar-ui.js','equipment-feedback-ui.js'])assert.ok(builder.includes("'"+name+"'"));
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

test('保存状態の一括完全削除：プレビュー保存・一括原子性・再送・復元競合・読取専用',async()=>{
  const storage=memoryStorage(),data={title:'Batch private content',date:'2026-10-20',time:'13:00',duration:30,people:3,space_id:'office-c04',booked_by:'Private person',assigned_to:'A',features:[]};
  const first=(await storedCall(storage,'admin/create',{operation_id:crypto.randomUUID(),confirmed:true,data})).record;
  const deleted=(await storedCall(storage,'admin/delete',{operation_id:crypto.randomUUID(),confirmed:true,meeting_id:first.id,expected_version:first.version})).record;
  const keep=(await storedCall(storage,'admin/create',{operation_id:crypto.randomUUID(),confirmed:true,data:{...data,title:'Keep me',time:'15:00',booked_by:'Admin'}})).record;
  let preview=await storedCall(storage,'admin/purge-preview',{range:'today'});assert.equal(preview.count,1);assert.equal(preview.skipped_not_deleted,1);
  const payload={preview_id:preview.preview_id,operation_id:crypto.randomUUID(),confirmed:true,purge_confirmation:'PERMANENT_DELETE'},before=storage.load();
  await assert.rejects(storedCall(storage,'admin/purge-deleted',{...payload,purge_confirmation:undefined}),error=>error.status===400);assert.deepEqual(storage.load(),before);
  await assert.rejects(storedCall({load:storage.load,commit:()=>false},'admin/purge-deleted',payload),error=>error.status===409);assert.deepEqual(storage.load(),before);
  const result=await storedCall(storage,'admin/purge-deleted',payload);assert.equal(result.purged_count,1);assert.deepEqual(await storedCall(storage,'admin/purge-deleted',payload),result);
  assert.deepEqual((await storedCall(storage,'admin/reservations?state=all')).items,[keep]);assert.doesNotMatch(JSON.stringify(storage.load()),/Batch private content|Private person/);
  await assert.rejects(storedCall(storage,'admin/restore',{operation_id:crypto.randomUUID(),confirmed:true,meeting_id:deleted.id,expected_version:deleted.version}),error=>error.status===404);
  const second=(await storedCall(storage,'admin/delete',{operation_id:crypto.randomUUID(),confirmed:true,meeting_id:keep.id,expected_version:keep.version})).record;
  preview=await storedCall(storage,'admin/purge-preview',{range:'all'});
  await storedCall(storage,'admin/restore',{operation_id:crypto.randomUUID(),confirmed:true,meeting_id:second.id,expected_version:second.version});
  await assert.rejects(storedCall(storage,'admin/purge-deleted',{...payload,preview_id:preview.preview_id,operation_id:crypto.randomUUID()}),error=>error.status===409&&error.message==='clear_targets_changed');
  assert.equal((await storedCall(storage,'admin/reservations?state=all')).items[0].deleted,false);
  for(const path of ['purge-preview','purge-deleted']){
    await assert.rejects(handleStoredOfficeRequest(new Request('https://demo.test/api/office/admin/'+path),storage),error=>error.status===405);
    await assert.rejects(handleStoredOfficeRequest(new Request('https://demo.test/api/office/admin/'+path,{method:'POST',headers:{Origin:'https://other.test'}}),storage),error=>error.status===403);
  }
  await assert.rejects(storedCall(storage,'data/call',{name:'purge-deleted',arguments:{range:'all'}}),error=>error.status===400);
});
test('保存状態の完全削除：復元不可・再送・最小監査・保存失敗の原子性・MCP読取専用',async()=>{
  const storage=memoryStorage();
  const create={operation_id:crypto.randomUUID(),confirmed:true,data:{title:'Private purge-only title',date:'2026-10-20',time:'13:00',duration:30,people:3,
    space_id:'office-c04',booked_by:'Private purge-only name',assigned_to:'A',features:['monitor']}};
  const created=(await storedCall(storage,'admin/create',create)).record;
  const deleted=(await storedCall(storage,'admin/delete',{operation_id:crypto.randomUUID(),confirmed:true,meeting_id:created.id,expected_version:created.version})).record;
  const payload={operation_id:crypto.randomUUID(),confirmed:true,purge_confirmation:'PERMANENT_DELETE',meeting_id:deleted.id,expected_version:deleted.version};
  const before=storage.load();
  await assert.rejects(storedCall({load:storage.load,commit:()=>false},'admin/purge',payload),error=>error.status===409);
  assert.deepEqual(storage.load(),before);
  const result=await storedCall(storage,'admin/purge',payload);assert.equal(result.purged_id,created.id);
  assert.deepEqual(await storedCall(storage,'admin/purge',payload),result);
  assert.equal((await storedCall(storage,'admin/reservations?state=all')).total,0);
  assert.equal((await storedCall(storage,'workspace')).meeting_history.length,0);
  await assert.rejects(storedCall(storage,'admin/restore',{operation_id:crypto.randomUUID(),confirmed:true,meeting_id:created.id,expected_version:deleted.version}),error=>error.status===404);
  await assert.rejects(storedCall(storage,'admin/create',create),error=>error.status===409&&error.message==='purged_operation');
  assert.doesNotMatch(JSON.stringify(storage.load()),/Private purge-only title|Private purge-only name/);
  await assert.rejects(storedCall(storage,'data/call',{name:'purge',arguments:{meeting_id:created.id}}),error=>error.status===400);
  await assert.rejects(handleStoredOfficeRequest(new Request('https://demo.test/api/office/admin/purge',{method:'POST',headers:{Origin:'https://other.test'}}),storage),error=>error.status===403);
  await assert.rejects(handleStoredOfficeRequest(new Request('https://demo.test/api/office/admin/purge'),storage),error=>error.status===405);
});

async function roomFitWorkspace(){
  const storage=memoryStorage();
  const workspace=await storedCall(storage,'workspace');
  const room=workspace.rooms.find(room=>room.kind==='meeting'&&room.capacity===8&&room.features.includes('monitor'));
  for(const time of ['13:00','14:00','15:00'])await storedCall(storage,'admin/create',{operation_id:crypto.randomUUID(),confirmed:true,
    data:{title:'Private title not for GPT',date:'2026-10-20',time,duration:30,people:3,space_id:room.id,booked_by:'Private person',assigned_to:'other',features:['monitor']}});
  return storage;
}
test('改善MCP：現在ワークスペースの全件、期間検証、サンプル非混在と読取専用',async()=>{
  const storage=await roomFitWorkspace(),before=storage.load();
  const payload=await storedCall(storage,'data/call',{name:'analyze_room_fit',arguments:{start_date:'2026-10-20',end_date:'2026-10-20'}});
  const result=payload.result.structuredContent.result;
  assert.equal(result.status,'review');assert.equal(result.eligible_count,3);assert.equal(result.items[0].alternative_count,3);
  assert.equal(payload.instance_id,before.state.instance_id);assert.equal(payload.scope,'current_workspace');
  assert.doesNotMatch(JSON.stringify(result),/Private title|Private person/);
  assert.deepEqual(storage.load(),before);
  const bad=await storedCall(storage,'data/call',{name:'analyze_room_fit',arguments:{start_date:'2026-10-21',end_date:'2026-10-20'}});
  assert.equal(bad.result.isError,true);
  const outside=await storedCall(storage,'data/call',{name:'analyze_room_fit',arguments:{start_date:'2026-01-01',end_date:'2026-01-01'}});
  assert.equal(outside.result.isError,true);
  await withMcpClient(fixture,async client=>assert.ok(!(await client.listTools()).tools.some(tool=>tool.name==='analyze_room_fit')));
});
test('改善GPT：Key必須、証拠をサーバー再計算、古いrevision拒否、状態とKeyを保存しない',async()=>{
  const storage=await roomFitWorkspace(),workspace=await storedCall(storage,'workspace'),before=storage.load();let calls=0;
  const body={start_date:'2026-10-20',end_date:'2026-10-20',revision:workspace.revision,instance_id:workspace.instance_id,locale:'en',model:'gpt-4.1-mini'};
  const improvementAgent=async(client,key,{start_date,end_date,locale})=>{calls++;assert.equal(key,fakeKey);assert.equal(locale,'en');const analysis=(await client.callTool({name:'analyze_room_fit',arguments:{start_date,end_date}})).structuredContent.result;assert.equal(analysis.eligible_count,3);return {analysis,draft:{items:[],summary:'Fixture',model:'mock'},trace:[],usage:{input_tokens:0,output_tokens:0},model:'mock'};};
  await assert.rejects(storedCall(storage,'improvements',body,{withoutKey:true,improvementAgent}),error=>error.status===401);
  await assert.rejects(storedCall(storage,'improvements',{...body,revision:workspace.revision-1},{improvementAgent}),error=>error.status===409);
  await assert.rejects(storedCall(storage,'improvements',{...body,analysis:{fake:true}},{improvementAgent}),error=>error.status===400);
  assert.equal(calls,0);
  const result=await storedCall(storage,'improvements',body,{improvementAgent});assert.equal(calls,1);
  assert.equal(result.analysis.items[0].oversized_count,3);assert.equal(result.revision,workspace.revision);
  assert.deepEqual(storage.load(),before);assert.doesNotMatch(JSON.stringify(storage.load()),/test_key|mock/);
  await assert.rejects(handleStoredOfficeRequest(new Request('https://demo.test/api/office/improvements',{method:'POST',headers:{Origin:'https://other.test'}}),storage),error=>error.status===403);
});
test('改善GPT：応答待機中の状態更新を検出し、古い提案を採用・保存しない',async()=>{
  const storage=await roomFitWorkspace(),workspace=await storedCall(storage,'workspace');
  let started,release;const waiting=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const result=storedCall(storage,'improvements',{start_date:'2026-10-20',end_date:'2026-10-20',revision:workspace.revision,instance_id:workspace.instance_id,locale:'ja',model:'gpt-4.1-mini'},
    {improvementAgent:async()=>{started();await gate;return {items:[]};}});
  await waiting;await storedCall(storage,'workspace/reset',{confirmed:true});const reset=storage.load();release();
  await assert.rejects(result,error=>error.status===409);assert.deepEqual(storage.load(),reset);
});
test('改善Agent保存統合：実MCPの複数照会と引用を検証し、調査・Keyは保存しない',async()=>{
  const storage=await roomFitWorkspace(),workspace=await storedCall(storage,'workspace'),before=storage.load();let requests=0;
  const improvementAgent=(client,key,input,options)=>runOfficeImprovementAgent(client,key,input,{...options,fetchImpl:async(_url,request)=>{
    requests++;const body=JSON.parse(request.body),outputs=body.input.filter(item=>item.type==='function_call_output').map(item=>JSON.parse(item.output));
    const analysis=outputs.find(output=>output.result?.rule)?.result;
    if(!analysis)return Response.json({output:[{type:'function_call',name:'analyze_room_fit',arguments:JSON.stringify({start_date:input.start_date,end_date:input.end_date}),call_id:'analyze'}]});
    if(outputs.length===1)return Response.json({output:[{type:'function_call',name:'get_evidence',arguments:JSON.stringify({reservation_id:analysis.items[0].evidence[0].reservation_id}),call_id:'verify'}]});
    return Response.json({output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'Synthetic evidence checked.',items:analysis.items.map(item=>({finding_id:item.finding_id,action:item.action,evidence_ids:[item.evidence[0].reservation_id],note:'Review smaller compatible rooms.'}))})}]}]});
  }});
  const body={start_date:'2026-10-20',end_date:'2026-10-20',revision:workspace.revision,instance_id:workspace.instance_id,locale:'en',model:'gpt-4.1-mini'};
  const report=await storedCall(storage,'improvements',body,{improvementAgent});assert.equal(requests,3);assert.equal(report.trace.length,2);assert.equal(report.draft.items.length,1);
  assert.deepEqual(storage.load(),before);assert.doesNotMatch(JSON.stringify(report),/Private title|Private person|test_key/);
  await assert.rejects(storedCall(storage,'improvements',body,{improvementAgent:async()=>{throw new DOMException('Too slow','TimeoutError');}}),error=>error.status===504&&error.message==='agent_timeout');
  assert.deepEqual(storage.load(),before);
});
const cloudNow=()=>new Date('2026-10-20T00:00:00Z');
const cloudPlan={message:'午後に4人で45分、モニターを使って企画を相談したいです。',mode:'gpt',locale:'ja'};
async function storedCall(storage,path,body,options={}){
  const request=new Request('https://demo.test/api/office/'+path,{method:body===undefined?'GET':'POST',
    headers:{'Content-Type':'application/json',Origin:'https://demo.test',...(!options.withoutKey?{Authorization:'Bearer '+fakeKey}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return (await handleStoredOfficeRequest(request,storage,{now:cloudNow,dayParser:mockDayParser,...options})).json();
}

const publishedHistory={now:()=>new Date('2026-10-23T00:00:00Z'),withDemoHistory:true};
test('公開歴史バッチ：初回40件を保存し、MCPは30件とB/X根拠を読取専用で返す',async()=>{
  const storage=memoryStorage();
  const state=await storedCall(storage,'workspace',undefined,publishedHistory);
  assert.deepEqual(state.reservations,historicalDemoReservations(HISTORICAL_DEMO_ANCHOR,officeRooms));
  assert.equal(state.demo_history_initialized,true);assert.equal(state.demo_history.count,40);
  assert.equal(state.demo_history.start_date,'2026-10-16');assert.equal(state.demo_history.end_date,'2026-10-22');
  assert.equal(state.current_meetings.length,0);assert.equal(state.meeting_history.length,0);
  const saved=storage.load();
  const report=(await storedCall(storage,'data/call',{name:'analyze_room_fit',arguments:{start_date:'2026-10-16',end_date:'2026-10-22'}},publishedHistory)).result.structuredContent.result;
  assert.equal(report.eligible_count,30);assert.equal(report.review_count,2);
  assert.equal(report.items.find(item=>item.name==='B').alternative_count,7);
  assert.equal(report.items.find(item=>item.name==='X').alternative_count,5);
  assert.deepEqual(await storedCall(storage,'workspace',undefined,publishedHistory),state);
  assert.deepEqual(storage.load(),saved);
  assert.match(readFileSync(new URL('./worker.js',import.meta.url),'utf8'),/withDemoHistory:true/);
});
test('公開歴史バッチ移行：既存予約・イベント・時計・操作ID・提案・個人履歴を保持する',async()=>{
  const storage=memoryStorage();
  const data={title:'My existing reservation',date:'2026-10-23',time:'10:00',duration:30,people:3,space_id:'office-c04',booked_by:'Own label',assigned_to:'A',features:['monitor']};
  const input={operation_id:crypto.randomUUID(),confirmed:true,data};
  const own=(await storedCall(storage,'admin/create',input,{now:publishedHistory.now})).record;
  await storedCall(storage,'transition',{meeting_id:own.id,action:'start'},{now:publishedHistory.now});
  await storedCall(storage,'transition',{meeting_id:own.id,action:'finish'},{now:publishedHistory.now});
  const before=storage.load();
  const migrated=await storedCall(storage,'workspace',undefined,publishedHistory),after=storage.load();
  assert.equal(migrated.reservations.length,41);assert.equal(migrated.meeting_history.length,1);
  assert.deepEqual(after.state.records.filter(record=>record.source!=='demo_history'),before.state.records);
  for(const field of ['clock','events','operations','plans','purged_ids','instance_id','reset_generation'])assert.deepEqual(after.state[field],before.state[field],field);
  assert.equal(after.state.revision,before.state.revision+1);assert.equal(after.version,before.version+1);
  assert.equal((await storedCall(storage,'admin/create',input,publishedHistory)).record.id,own.id);
  assert.equal((await storedCall(storage,'workspace',undefined,publishedHistory)).reservations.length,41);
});
test('公開歴史バッチ：論理削除・完全削除・リセット・日付変更後も復活させない',async()=>{
  const storage=memoryStorage();const state=await storedCall(storage,'workspace',undefined,publishedHistory);
  const target=state.reservations[0];
  const deleted=(await storedCall(storage,'admin/delete',{operation_id:crypto.randomUUID(),confirmed:true,meeting_id:target.id,expected_version:target.version},publishedHistory)).record;
  await storedCall(storage,'admin/purge',{operation_id:crypto.randomUUID(),confirmed:true,meeting_id:deleted.id,expected_version:deleted.version,purge_confirmation:'PERMANENT_DELETE'},publishedHistory);
  const later={...publishedHistory,now:()=>new Date('2026-10-26T00:00:00Z')};
  const loaded=await storedCall(storage,'workspace',undefined,later);assert.equal(loaded.reservations.length,39);assert.ok(loaded.purged_ids.includes(target.id));
  const preview=await storedCall(storage,'admin/clear-preview',{range:'all'},later);
  await storedCall(storage,'admin/clear',{preview_id:preview.preview_id,operation_id:crypto.randomUUID(),confirmed:true},later);
  assert.ok((await storedCall(storage,'workspace',undefined,later)).reservations.every(record=>record.deleted));
  await storedCall(storage,'workspace/reset',{confirmed:true},later);
  const reset=await storedCall(storage,'workspace',undefined,later);assert.equal(reset.reservations.length,0);assert.equal(reset.demo_history_initialized,true);
});
test('公開歴史バッチ：初期化の保存失敗と並行リクエストで既存データを失わない',async()=>{
  const storage=memoryStorage();await storedCall(storage,'workspace',undefined,{now:publishedHistory.now});const before=storage.load();
  await assert.rejects(storedCall({load:storage.load,commit:()=>false},'workspace',undefined,publishedHistory),error=>error.status===409);
  assert.deepEqual(storage.load(),before);
  const attempts=await Promise.allSettled([storedCall(storage,'workspace',undefined,publishedHistory),storedCall(storage,'workspace',undefined,publishedHistory)]);
  assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(attempts.find(result=>result.status==='rejected').reason.status,409);
  assert.equal((await storedCall(storage,'workspace',undefined,publishedHistory)).reservations.length,40);
  assert.equal(new Set(storage.load().state.records.map(record=>record.id)).size,40);
});
test('公開歴史バッチ：ルートとCookieごとの隔離を維持し、読取MCPや不正要求で初期化しない',async()=>{
  const stores=new Map();const env={OFFICE_WORKSPACES:{getByName(name){
    if(!stores.has(name))stores.set(name,memoryStorage());
    return {fetch:request=>handleStoredOfficeRequest(request,stores.get(name),publishedHistory)};
  }},ASSETS:{fetch:async()=>new Response('asset')}};
  const call=(cookie,origin='https://intentspace.linqicheng.uk')=>handleCloudRequest(new Request('https://intentspace.linqicheng.uk/api/office/workspace',{headers:{Origin:origin,...(cookie?{Cookie:cookie}:{})}}),env,fixture);
  const a=await call(),b=await call();const cookie=a.headers.get('Set-Cookie').split(';')[0],other=b.headers.get('Set-Cookie').split(';')[0];
  assert.equal((await a.json()).reservations.length,40);assert.equal((await b.json()).reservations.length,40);assert.notEqual(cookie,other);
  const own=stores.get(cookie.split('=')[1]);await storedCall(own,'workspace/reset',{confirmed:true},publishedHistory);
  assert.equal((await (await call(cookie)).json()).reservations.length,0);
  assert.equal((await (await call(other)).json()).reservations.length,40);
  const before=own.load();assert.equal((await call(cookie,'https://evil.test')).status,403);assert.deepEqual(own.load(),before);
  const empty=memoryStorage();await storedCall(empty,'workspace',undefined,{now:publishedHistory.now});const saved=empty.load();
  await storedCall(empty,'data/call',{name:'get_data_status',arguments:{}},publishedHistory);assert.deepEqual(empty.load(),saved);
  await assert.rejects(handleStoredOfficeRequest(new Request('https://demo.test/api/office/workspace',{method:'POST'}),empty,publishedHistory),error=>error.status===405);
  assert.deepEqual(empty.load(),saved);
});
test('公開歴史バッチ：Agentが実MCPで2室の引用を検証し、40件を変更しない',async()=>{
  const storage=memoryStorage(),state=await storedCall(storage,'workspace',undefined,publishedHistory),before=storage.load();let requests=0;
  const improvementAgent=(client,key,input,options)=>runOfficeImprovementAgent(client,key,input,{...options,fetchImpl:async(_url,request)=>{
    requests++;const body=JSON.parse(request.body),outputs=body.input.filter(item=>item.type==='function_call_output').map(item=>JSON.parse(item.output));
    const analysis=outputs.find(output=>output.result?.rule)?.result;
    if(!analysis)return Response.json({output:[{type:'function_call',name:'analyze_room_fit',arguments:JSON.stringify({start_date:input.start_date,end_date:input.end_date}),call_id:'analyze'}]});
    if(outputs.length===1)return Response.json({output:analysis.items.map((item,index)=>({type:'function_call',name:'get_evidence',arguments:JSON.stringify({reservation_id:item.evidence[0].reservation_id}),call_id:'verify-'+index}))});
    return Response.json({output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'Synthetic B/X evidence verified.',items:analysis.items.map(item=>({finding_id:item.finding_id,action:item.action,evidence_ids:[item.evidence[0].reservation_id],note:'Review smaller compatible rooms.'}))})}]}]});
  }});
  const body={start_date:'2026-10-16',end_date:'2026-10-22',revision:state.revision,instance_id:state.instance_id,locale:'ja',model:'gpt-4.1-mini'};
  const result=await storedCall(storage,'improvements',body,{...publishedHistory,improvementAgent});
  assert.equal(requests,3);assert.equal(result.analysis.eligible_count,30);assert.equal(result.draft.items.length,2);assert.equal(result.trace.length,3);
  assert.deepEqual(storage.load(),before);
  await assert.rejects(storedCall(storage,'improvements',body,{...publishedHistory,withoutKey:true,improvementAgent}),error=>error.status===401);
  assert.equal(requests,3);
});

test('保存状態の一括削除：確認を別リクエストへ引き継ぎ、再送・競合・保存失敗で記録を破壊しない',async()=>{
  const storage=memoryStorage();await storedCall(storage,'workspace');
  const data={title:'For clearing',date:'2026-10-20',time:'13:00',duration:30,people:2,space_id:'office-c04',booked_by:'Admin',assigned_to:'A',features:[]};
  const create=()=>storedCall(storage,'admin/create',{operation_id:crypto.randomUUID(),confirmed:true,data});
  const legacy=(await create()).record;
  await storedCall(storage,'admin/delete',{operation_id:crypto.randomUUID(),confirmed:true,meeting_id:legacy.id,expected_version:legacy.version});
  assert.equal((await storedCall(storage,'workspace')).meeting_history.length,1);
  let preview=await storedCall(storage,'admin/clear-preview',{range:'today'});assert.equal(preview.count,1);assert.equal(preview.history_count,1);
  assert.equal(storage.load().state.clear_previews.length,1);
  const saved=storage.load(),input={preview_id:preview.preview_id,operation_id:crypto.randomUUID(),confirmed:true};
  const unavailable={load:storage.load,commit:()=>false};
  await assert.rejects(storedCall(unavailable,'admin/clear',input),e=>e.status===409);
  assert.deepEqual(storage.load(),saved);
  assert.equal((await storedCall(storage,'admin/clear',input)).deleted_count,1);
  assert.equal((await storedCall(storage,'workspace')).meeting_history.length,0);
  const deleted=(await storedCall(storage,'admin/reservations?state=deleted')).items[0];
  await storedCall(storage,'admin/restore',{operation_id:crypto.randomUUID(),confirmed:true,meeting_id:deleted.id,expected_version:deleted.version});
  assert.equal((await storedCall(storage,'workspace')).current_meetings.length,1);
  assert.equal((await storedCall(storage,'admin/clear',input)).deleted_count,1);
  assert.equal((await storedCall(storage,'workspace')).current_meetings.length,1,'Retry cannot delete a later restored record');
  preview=await storedCall(storage,'admin/clear-preview',{range:'all'});
  await storedCall(storage,'transition',{meeting_id:deleted.id,action:'cancel'});
  await assert.rejects(storedCall(storage,'admin/clear',{...input,operation_id:crypto.randomUUID(),preview_id:preview.preview_id}),e=>e.status===409&&e.message==='clear_targets_changed');
  assert.equal((await storedCall(storage,'admin/reservations?state=not_deleted')).total,1);
});

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
  const separated=await storedCall(storage,'workspace');
  assert.deepEqual(separated.current_meetings.map(r=>r.id),[newBooking.booking.id]);
  assert.equal(separated.meeting_history[0].replacement_id,newBooking.booking.id);
  assert.equal(newBooking.booking.rebooked_from,booked.booking.id);
  assert.equal((await storedCall(storage,'transition',{meeting_id:newBooking.booking.id,action:'start'})).meetings.at(-1).status,'in_progress');
  const ended=await storedCall(storage,'transition',{meeting_id:newBooking.booking.id,action:'finish'});
  assert.equal(ended.meetings.at(-1).status,'completed');
  assert.equal(ended.current_meetings.length,0);assert.equal(ended.meeting_history.length,2);
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
  assert.equal((await storedCall(storage,'admin/reservations')).total,1);
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

test('クラウド転送：未認証でDOが本文を読まなくても受信ストリームを完了し、元のバイト列を保持する',async()=>{
  let forwarded;
  const env={OFFICE_WORKSPACES:{getByName:()=>({fetch:async request=>{
    forwarded=request;return Response.json({error:'api_key_missing'},{status:401});
  }})}};
  const body=' \n{"supplement":"窓際"}  ';
  const request=new Request('https://demo.test/api/office/calendar/review',{method:'POST',
    headers:{Cookie:'__Host-intentspace-workspace='+'a'.repeat(64)},body});
  const response=await handleCloudRequest(request,env,fixture);
  assert.equal(response.status,401);assert.equal(request.bodyUsed,true);
  assert.equal(forwarded.bodyUsed,false);assert.equal(await forwarded.text(),body);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
});

test('クラウド転送：過大な受信本文をDOへ渡さず、各APIのより小さい本文上限も維持する',async()=>{
  let calls=0;
  const env={OFFICE_WORKSPACES:{getByName:()=>({fetch:async request=>{
    calls++;return handleStoredOfficeRequest(request,memoryStorage(),{now:cloudNow});
  }})}};
  const request=body=>new Request('https://demo.test/api/office/calendar/export',{method:'POST',
    headers:{Cookie:'__Host-intentspace-workspace='+'b'.repeat(64)},body});
  assert.equal((await handleCloudRequest(request(' '.repeat(32001)),env,fixture)).status,413);
  assert.equal(calls,0);
  assert.equal((await handleCloudRequest(request(' '.repeat(2001)),env,fixture)).status,413);
  assert.equal(calls,1);
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
    {withoutKey:true,dayParser:async()=>{throw new Error('Keyなしで呼び出してはいけない');}}).catch(e=>e);
  assert.equal(plan.status,401);
  const incomplete=await storedCall(storage,'day-plan',{message:'午後に会議をしたいです。',mode:'gpt'});
  assert.equal(incomplete.proposals[0].status,'needs_input');
  assert.ok(incomplete.proposals[0].issues.includes('missing_people'));
  let calls=0;
  const response=await handleStoredOfficeRequest(new Request('https://demo.test/api/office/day-plan',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+fakeKey},
    body:JSON.stringify({...cloudPlan,mode:'gpt',model:'gpt-4.1-mini'})
  }),storage,{now:cloudNow,dayParser:async(key,input)=>{
    calls++;assert.equal(key,fakeKey);return fixturePlan(input.message);
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
  }),storage,{now:cloudNow,dayParser:async(key,input)=>{entered();await gate;return fixturePlan(input.message,input.today,'ja');}});
  await started;await storedCall(storage,'workspace/reset',{confirmed:true});release();
  await assert.rejects(()=>pending,error=>error.status===409&&error.message==='state_changed');
  const saved=storage.load();assert.equal(saved.state.plans.length,0);assert.equal(saved.state.records.length,0);
});

test('現在ワークスペースMCP：履歴サンプルと混ぜず、削除・参加を除外し、人数・状態を保持する',async()=>{
  const storage=memoryStorage();
  const data={title:'Current workspace review',date:'2026-10-20',time:'13:00',duration:30,people:4,space_id:'office-c04',booked_by:'Demo',assigned_to:'A',features:['monitor']};
  let record=(await storedCall(storage,'admin/create',{operation_id:crypto.randomUUID(),confirmed:true,data})).record;
  const call=(name,args={})=>storedCall(storage,'data/call',{name,arguments:args});
  const query={start_date:'2026-10-20',end_date:'2026-10-20',limit:100};
  let payload=await call('query_reservations',query);
  assert.equal(payload.scope,'current_workspace');assert.equal(payload.result.structuredContent.result.total,1);
  let row=payload.result.structuredContent.result.items[0];
  assert.equal(row.people_count,4);assert.equal(row.status,'reserved');assert.equal(row.is_used,null);
  const unknown=(await call('detect_unused_reservations',{...query,min_reservations:1,min_unused:1,min_unused_percent:0})).result.structuredContent.result;
  assert.equal(unknown.review_count,0,'Pending meetings are not known unused bookings');
  await storedCall(storage,'transition',{meeting_id:record.id,action:'start'});
  record=(await storedCall(storage,'transition',{meeting_id:record.id,action:'finish'})).meetings[0];
  payload=await call('query_reservations',query);row=payload.result.structuredContent.result.items[0];
  assert.equal(row.status,'completed');assert.equal(row.is_used,true);
  await storedCall(storage,'admin/delete',{operation_id:crypto.randomUUID(),confirmed:true,meeting_id:record.id,expected_version:record.version});
  assert.equal((await call('query_reservations',query)).result.structuredContent.result.total,0);
  assert.equal((await storedCall(storage,'admin/reservations')).total,1);
});

test('現在ワークスペースAI：Key必須、実MCPへの接続、状態とKeyを保存しない',async()=>{
  const storage=memoryStorage();await storedCall(storage,'workspace');
  const before=storage.load();
  const body={message:'Summarise current office bookings.',model:'gpt-4.1-mini',history:[]};
  await assert.rejects(storedCall(storage,'data/chat',body,{withoutKey:true}),e=>e.status===401);
  let calls=0;
  const result=await storedCall(storage,'data/chat',body,{answerer:async(client,key)=>{
    calls++;assert.equal(key,fakeKey);
    const status=await client.callTool({name:'get_data_status',arguments:{}});
    assert.equal(status.structuredContent.meta.coverage.start,'2026-10-20');
    const records=await client.callTool({name:'query_reservations',arguments:{start_date:'2026-10-20',end_date:'2026-10-20',limit:100}});
    assert.equal(records.structuredContent.result.total,0);
    return {answer:'No current bookings.',trace:[{name:'query_reservations'}]};
  }});
  assert.equal(result.answer,'No current bookings.');assert.equal(calls,1);
  assert.deepEqual(storage.load(),before);
  assert.equal(JSON.stringify(storage.load()).includes(fakeKey),false);
});

test('現在ワークスペースMCP：100件以降も照会でき、未登録操作と別Originを拒否する',async()=>{
  const storage=memoryStorage();await storedCall(storage,'workspace');
  const data={title:'Template',date:'2026-10-20',time:'13:00',duration:30,people:2,space_id:'office-c04',booked_by:'Demo',assigned_to:'other',features:[]};
  const record=(await storedCall(storage,'admin/create',{operation_id:crypto.randomUUID(),confirmed:true,data})).record;
  const saved=storage.load();
  saved.state.records=Array.from({length:151},(_,i)=>({...record,id:'pagination-'+i}));
  assert.equal(storage.commit(saved.version,saved.state),true);
  const args={start_date:'2026-10-20',end_date:'2026-10-20',limit:100};
  const first=await storedCall(storage,'data/call',{name:'query_reservations',arguments:args});
  const next=await storedCall(storage,'data/call',{name:'query_reservations',arguments:{...args,offset:100}});
  assert.equal(first.result.structuredContent.result.total,151);assert.equal(next.result.structuredContent.result.items.length,51);
  await assert.rejects(storedCall(storage,'data/call',{name:'delete_everything',arguments:{}}),e=>e.status===400);
  await assert.rejects(handleStoredOfficeRequest(new Request('https://demo.test/api/office/data/call',{method:'POST',headers:{Origin:'https://evil.test'},body:JSON.stringify({name:'get_data_status'})}),storage),e=>e.status===403);
});


test('保存日程：ページ間のCRUD・再送・版数・リセットと失敗時の原子性',async()=>{
  const storage=memoryStorage();const before=await storedCall(storage,'workspace');
  const input={action:'examples',date:'2026-10-20',expected_revision:before.calendar_revision,confirmed:true,operation_id:crypto.randomUUID()};
  const added=await storedCall(storage,'calendar',input);assert.equal(added.events.length,3);
  const reload=await storedCall(storage,'calendar');assert.deepEqual(reload.events,added.events);
  await storedCall(storage,'calendar',input);assert.equal((await storedCall(storage,'calendar')).events.length,3);
  const saved=storage.load();assert.equal(saved.state.employee_calendar.events.length,3);
  assert.equal(saved.state.records.length,before.reservations.length);
  await assert.rejects(storedCall(storage,'calendar',{...input,operation_id:crypto.randomUUID()}),/calendar_changed/);
  assert.deepEqual(storage.load(),saved);
  const state=await storedCall(storage,'workspace');
  await assert.rejects(storedCall(storage,'calendar/analyze',{date:'2026-10-20',revision:state.revision,instance_id:state.instance_id,model:'gpt-4.1-mini',locale:'en'},{withoutKey:true}),/api_key_missing/);
  assert.deepEqual(storage.load(),saved);
  await storedCall(storage,'workspace/reset',{confirmed:true});assert.equal((await storedCall(storage,'calendar')).events.length,0);
});

test('保存日程Agent：MCP結果のみで提案を保存し、CAS競合と未調査の応答を拒否する',async()=>{
  const storage=memoryStorage();await storedCall(storage,'workspace');
  const rev=(await storedCall(storage,'calendar')).revision;
  await storedCall(storage,'calendar',{action:'create',expected_revision:rev,confirmed:true,operation_id:crypto.randomUUID(),
    event:{title:'Discussion',date:'2026-10-20',time:'13:00',end_time:'13:30',people:4,notes:'Monitor'}});
  async function analyze(agent){const state=await storedCall(storage,'workspace');return storedCall(storage,'calendar/analyze',{
    date:'2026-10-20',revision:state.revision,instance_id:state.instance_id,model:'gpt-4.1-mini',locale:'en'},{calendarAgent:agent});}
  const agent=async(client)=>{
    const schedule=await client.callTool({name:'get_calendar_events',arguments:{date:'2026-10-20'}});
    await client.callTool({name:'get_employee_bookings',arguments:{date:'2026-10-20'}});
    const event=schedule.structuredContent.result.events[0];
    const result=await client.callTool({name:'recommend_calendar_event',arguments:{event_id:event.id,event_version:event.version,type:'meeting',people:4,features:['monitor'],unclear:[]}});
    assert.equal(result.isError,undefined);return {summary:'Checked',trace:[]};
  };
  const plan=await analyze(agent);assert.equal(plan.proposals[0].status,'proposed');assert.equal(storage.load().state.plans.length,1);
  assert.equal(storage.load().state.records.length,0);assert.doesNotMatch(JSON.stringify(storage.load()),/Checked|test_key/);
  const before=storage.load();await assert.rejects(analyze(async()=>({summary:'Pretend',trace:[]})),/calendar_incomplete/);assert.deepEqual(storage.load(),before);
  await assert.rejects(analyze(async client=>{const result=await agent(client);await storedCall(storage,'calendar',{action:'cancel',event_id:storage.load().state.employee_calendar.events[0].id,
    expected_revision:storage.load().state.employee_calendar.revision,confirmed:true,operation_id:crypto.randomUUID()});return result;}),/state_changed/);
  assert.equal(storage.load().state.plans.length,1);assert.equal(storage.load().state.employee_calendar.events[0].status,'cancelled');
});


async function storedCalendarExport(storage,start='2026-10-20',end=start){
  const state=await storedCall(storage,'workspace');return storedCall(storage,'calendar/export',{start_date:start,end_date:end,revision:state.revision,instance_id:state.instance_id,locale:'en'},{withoutKey:true});
}
async function storedCalendarReview(storage,exportId,agent,extra={}){
  const state=await storedCall(storage,'workspace');return storedCall(storage,'calendar/review',{export_id:exportId,revision:state.revision,instance_id:state.instance_id,locale:'en',model:'gpt-4.1-mini',supplement:''},{calendarAgent:agent,...extra});
}
function storedCalendarAgent(counter){return async(client,_key,input)=>{
  counter.count++;
  const args={start_date:input.start_date,end_date:input.end_date};
  const calendar=await client.callTool({name:'get_calendar_events',arguments:args});
  await client.callTool({name:'get_employee_bookings',arguments:args});
  for(const event of calendar.structuredContent.result.events){
    counter.ids.push(event.id);
    const type=event.time==='09:00'?'desk':event.time==='12:00'?'unavailable':'meeting';
    const result=await client.callTool({name:'recommend_calendar_event',arguments:{event_id:event.id,event_version:event.version,type,people:type==='desk'?1:event.people,features:type==='meeting'?['monitor']:[],unclear:[]}});
    assert.equal(result.isError,undefined);
  }
  return {summary:'Checked with MCP',trace:[]};
};}

test('保存版日历导出：不含Key的缓存跨请求复用，确认仍检查最新预约',async()=>{
  const storage=memoryStorage();await storedCall(storage,'workspace');const calendar=await storedCall(storage,'calendar');
  await storedCall(storage,'calendar',{action:'examples',date:'2026-10-20',expected_revision:calendar.revision,operation_id:crypto.randomUUID(),confirmed:true});
  const counter={count:0,ids:[]},agent=storedCalendarAgent(counter),exported=await storedCalendarExport(storage);
  assert.equal(counter.count,0);const first=await storedCalendarReview(storage,exported.export_id,agent);assert.equal(counter.count,1);assert.equal(first.progress.newly_analyzed,3);
  assert.equal(storage.load().state.employee_calendar.interpretations.length,3);
  const next=await storedCalendarReview(storage,exported.export_id,agent);assert.equal(counter.count,1);assert.equal(next.progress.reused,3);
  assert.doesNotMatch(JSON.stringify(storage.load()),/Checked with MCP|function_call_output|test_key/);
  const p=next.proposals[2];await storedCall(storage,'confirm',{plan_id:next.plan_id,proposal_id:p.id,space_id:p.candidates[0].id,confirmed:true});
  const again=await storedCalendarReview(storage,exported.export_id,agent);assert.equal(counter.count,1);assert.equal(again.proposals[2].status,'existing');
  assert.equal(storage.load().state.records.filter(r=>r.assigned_to==='A').length,1);
});

test('保存版日历导出：并发修改拒绝写入旧缓存，未知/过期导出及跨来源拒绝',async()=>{
  const storage=memoryStorage();await storedCall(storage,'workspace');let calendar=await storedCall(storage,'calendar');
  await storedCall(storage,'calendar',{action:'examples',date:'2026-10-20',expected_revision:calendar.revision,operation_id:crypto.randomUUID(),confirmed:true});
  const exp=await storedCalendarExport(storage),counter={count:0,ids:[]},agent=storedCalendarAgent(counter);
  const racing=async(...args)=>{const result=await agent(...args);calendar=await storedCall(storage,'calendar');await storedCall(storage,'calendar',{action:'cancel',event_id:calendar.events[0].id,expected_revision:calendar.revision,operation_id:crypto.randomUUID(),confirmed:true});return result;};
  await assert.rejects(storedCalendarReview(storage,exp.export_id,racing),/state_changed/);
  assert.equal(storage.load().state.employee_calendar.interpretations.length,0);assert.equal(storage.load().state.plans.length,0);
  const before=storage.load();await assert.rejects(storedCalendarReview(storage,exp.export_id,agent),/calendar_export_changed/);assert.deepEqual(storage.load(),before);
  await assert.rejects(storedCalendarReview(storage,crypto.randomUUID(),agent),/calendar_export_expired/);
  const request=new Request('https://demo.test/api/office/calendar/export',{method:'POST',headers:{Origin:'https://other.test','Content-Type':'application/json'},body:'{}'});
  await assert.rejects(handleStoredOfficeRequest(request,storage,{now:cloudNow}),e=>e.status===403);
  assert.deepEqual(storage.load(),before);
});

test('保存版日历导出：重置清空导出和缓存，新事务不会继承旧处理状态',async()=>{
  const storage=memoryStorage();await storedCall(storage,'workspace');let c=await storedCall(storage,'calendar');
  await storedCall(storage,'calendar',{action:'examples',date:'2026-10-20',expected_revision:c.revision,operation_id:crypto.randomUUID(),confirmed:true});
  const exp=await storedCalendarExport(storage);await storedCalendarReview(storage,exp.export_id,storedCalendarAgent({count:0,ids:[]}));
  await storedCall(storage,'workspace/reset',{confirmed:true});const saved=storage.load().state.employee_calendar;
  assert.equal(saved.interpretations.length,0);assert.equal(saved.exports.length,0);assert.equal(saved.events.length,0);
  await assert.rejects(storedCalendarReview(storage,exp.export_id,storedCalendarAgent({count:0,ids:[]})),/calendar_export_expired/);
});
