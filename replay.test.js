import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealReplay, wallClock, classifyBooking, replayFrame, selectArrivalReplay, createArrivalReplay } from './real-replay.js';
import { createOfficeService, officeRooms, handleStoredOfficeRequest } from './office-service.js';
import { createHistoricalDemoState } from './meeting-state.js';
import { renderReplayShell, renderReplayMap, renderReplaySide, peakMinute, dayStats, clockText } from './replay-ui.js';
import { translator, messages } from './ui-i18n.js';
import { errorResponse } from './http-utils.js';
import { handleCloudRequest } from './cloud-api.js';

// Fictional rows in the supplier's column layout. They include IDs that must never be returned.
const row = (space, capacity, date, from, to, people, extra = {}) => ({ reservations_id: 'RES-SECRET-' + Math.random(), reservation_creator_persona_id: 'PERSONA-SECRET',
  organization_id: 'ORG-SECRET', space_name: space, capacity: String(capacity), base_condition_start_date: date,
  base_condition_start_time_jst: `${date} ${from}:00 UTC`, base_condition_end_time_jst: `${date} ${to}:00 UTC`, total_people_count: String(people),
  reservation_status: '1-1_通常予約', deleted: 'false', is_used: 'true', ...extra });
const rows = [
  row('会議室C', 8, '2026-02-25', '10:00', '11:00', 3), row('会議室C', 8, '2026-02-25', '13:00', '14:00', 2), row('会議室C', 8, '2026-02-24', '10:00', '11:00', 4),
  row('会議室B', 8, '2026-02-25', '10:30', '12:00', 7), row('会議室X', 30, '2026-02-25', '10:00', '10:30', 12),
  row('会議室D', 4, '2026-02-25', '10:00', '11:00', 4),
  row('Multi Booth 01', 4, '2026-02-25', '10:15', '10:45', 2), row('Personal Booth 01（モニターあり）', 1, '2026-02-25', '10:00', '12:00', 1),
  row('会議室G', 8, '2026-02-25', '15:00', '16:00', 3, { is_used: 'false', reservation_status: '4_利用なし・キャンセルなし' }),
  row('会議室F', 8, '2026-02-25', '09:00', '10:00', 2, { is_used: 'false', deleted: 'true', reservation_status: '2_事前キャンセル' }),
  row('会議室I', 8, '2026-02-25', '09:00', '10:00', 2, { deleted: 'true' }),
  row('会議室A', 6, '2026-02-25', '11:00', '10:00', 2)
];

test('実データ再生：時刻は表記どおり日本時間、利用・未利用・取消を区別、地図外ブースを集計', () => {
  assert.deepEqual(wallClock('2026-02-25 10:30:00 UTC'), { date: '2026-02-25', minute: 630 });
  assert.equal(wallClock('bad'), null);
  assert.equal(classifyBooking(rows[0]), 'used');
  assert.equal(classifyBooking(rows[8]), 'no_show');
  assert.equal(classifyBooking(rows[9]), null);
  assert.equal(classifyBooking(rows[10]), null, 'used but deleted afterwards is excluded, as in the poster analysis');
  const replay = createRealReplay(rows), summary = replay.summary();
  assert.equal(summary.busiest, '2026-02-25'); assert.equal(summary.invalid.time, 1);
  const day = replay.day('2026-02-25');
  assert.deepEqual(day.bookings.map(b => b.name + ':' + b.status), ['C:used', 'D:used', 'X:used', 'B:used', 'C:used', 'G:no_show']);
  const frame = replayFrame(day, 10 * 60 + 20);
  assert.deepEqual(frame.in_use.map(b => b.name).sort(), ['C', 'D', 'X']);
  assert.deepEqual(frame.off_map, { multi_booth: 1, single_booth: 1 });
  assert.equal(replay.day('2026-01-01'), null);
});

test('実データ再生：3か月の傾向はアプリの確認ルールと同じ基準、空いていた小部屋も数える', () => {
  const trend = createRealReplay(rows).summary().trend;
  const c = trend.rooms.find(r => r.name === 'C');
  assert.deepEqual([c.used, c.small, c.small_percent, c.small_2to4], [3, 3, 100, 3]);
  // 10:00 C(3 people): D busy, Multi Booth 01 busy from 10:15 -> overlaps; 13:00 and 02-24 have free rooms.
  assert.equal(c.free_smaller, 2);
  assert.equal(trend.rooms.find(r => r.name === 'B').small, 0);
  assert.equal(trend.rooms.find(r => r.name === 'X').small, 0, '12 people is not a small group');
  assert.equal(trend.used, 5); assert.equal(trend.small_percent, 60);
});

test('実データ再生：API出力に予約ID・人物ID・組織IDを含めない', async () => {
  const replay = createRealReplay(rows), service = createOfficeService({ workspace: createHistoricalDemoState({ rooms: officeRooms }), replayData: replay });
  const get = async path => { try { const r = await service(new Request('http://demo.test/api/office/' + path, { headers: { origin: 'http://demo.test' } })); return { status: r.status, body: await r.json() }; } catch (error) { const r = errorResponse(error); return { status: r.status, body: await r.json() }; } };
  const summary = await get('replay'), day = await get('replay/day?date=2026-02-25');
  assert.equal(summary.body.source, 'enterprise_sample'); assert.equal(day.body.bookings.length, 6);
  assert.doesNotMatch(JSON.stringify([summary.body, day.body]), /SECRET|persona|reservations_id|organization/);
  assert.equal((await get('replay/day?date=2026-13-01')).status, 400);
  assert.equal((await get('replay/day?date=2026-01-01')).status, 404);
  assert.equal((await get('replay/day?date=2026-02-25&x=1')).status, 400);
});

test('公開版：実データ再生は「ローカル専用」とだけ返し、企業データを持たない', async () => {
  let saved = null;
  const storage = { load: () => saved, commit: (expected, state) => { saved = { version: expected + 1, state }; return true; } };
  const response = await handleStoredOfficeRequest(new Request('http://demo.test/api/office/replay', { headers: { origin: 'http://demo.test' } }), storage, { withDemoHistory: true });
  assert.deepEqual(await response.json(), { source: 'unavailable', local_only: true });
  for (const locale of ['ja', 'en']) {
    const t = translator(locale), html = renderReplayShell({ source: 'unavailable' }, null, 600, 'day', t, locale);
    assert.match(html, new RegExp(t('replayUnavailableTitle'))); assert.doesNotMatch(html, /replayTime/);
  }
});

test('再生画面：使用中の部屋に人数/定員、少人数は黄色、未利用は「予約のみ」、傾向モードは割合', () => {
  for (const key of Object.keys(messages.ja).filter(k => k.startsWith('replay'))) assert.ok(messages.en[key], key);
  const replay = createRealReplay(rows), summary = replay.summary(), day = replay.day('2026-02-25');
  const t = translator('ja');
  assert.equal(peakMinute(day), 10 * 60); assert.equal(clockText(615), '10:15');
  assert.deepEqual(dayStats(day), { used: 5, peak: 3, big: 4, small: 2 });
  let svg = renderReplayMap('day', summary, day, 10 * 60 + 15, t, 'ja');
  assert.match(svg, /3\/8人/); assert.match(svg, /insightPin small/); assert.match(svg, /12\/30人/); assert.match(svg, /insightPin live/);
  assert.doesNotMatch(svg, / id="meeting-seat|tabindex=/);
  svg = renderReplayMap('day', summary, day, 15 * 60 + 10, t, 'ja');
  assert.match(svg, /予約のみ/); assert.match(svg, /replayNoShow/);
  svg = renderReplayMap('trend', summary, day, 600, t, 'ja');
  assert.match(svg, /少人数 100%/);
  const side = renderReplaySide('day', summary, day, 10 * 60 + 15, t, 'ja');
  assert.match(side, /2026-02-25（水） 10:15/); assert.match(side, /少人数/); assert.match(side, /Multi Booth 使用中 1/);
  const shell = renderReplayShell(summary, '2026-02-25', 615, 'day', t, 'ja');
  assert.match(shell, /2026-02-25（水） 利用5件 ★/); assert.match(shell, /data-replay-play="1"/); assert.doesNotMatch(shell, /\{\w+\}|undefined/);
});

test('傾向の表示：小部屋の空き率は時刻を確認できた少人数予約を分母とする', () => {
  const summary = createRealReplay(rows).summary();
  assert.equal(summary.trend.used, 5);
  assert.equal(summary.trend.free_checked, 3);
  const ja = renderReplaySide('trend', summary, null, 600, translator('ja'), 'ja');
  assert.match(ja, /大きい会議室の利用は5件/);
  assert.match(ja, /少人数予約3件のうち、2件（66\.7%）/);
  const en = renderReplaySide('trend', summary, null, 600, translator('en'), 'en');
  assert.match(en, /Of 3 small-group bookings with valid times, 2 \(66\.7%\)/);
  const noTimes = { ...summary, trend: { ...summary.trend, free_checked: 0, free_smaller: 0, free_percent: 0 } };
  const empty = renderReplaySide('trend', noTimes, null, 600, translator('en'), 'en');
  assert.match(empty, /No small-group bookings had valid times/);
});

test('公開ファイル一覧：ビルド・ローカル・Cloudflareの3か所が一致し、サーバー専用ファイルは含まない', async () => {
  const { readFile } = await import('node:fs/promises');
  const names = text => new Set([...text.matchAll(/'\/?([\w-]+\.(?:html|css|js))'/g)].map(m => m[1]));
  const build = names((await readFile('build-assets.js', 'utf8')).match(/\[[^\]]*'office\.html'[^\]]*\]/)[0]);
  const cloud = names((await readFile('cloud-api.js', 'utf8')).match(/publicAssets=new Set\(\[[^\]]*\]/)[0]);
  const local = names((await readFile('web.js', 'utf8')).match(/for\(const name of \[[^\]]*\]/)[0]);
  for (const file of ['home.html', 'home.js', 'office.html', 'office.js', 'insights-ui.js', 'replay-ui.js']) { assert.ok(build.has(file), 'build ' + file); assert.ok(cloud.has(file), 'cloud ' + file); }
  for (const file of local) assert.ok(cloud.has(file), 'served locally but not on Cloudflare: ' + file);
  for (const file of build) assert.ok(cloud.has(file), 'built but not served on Cloudflare: ' + file);
  for (const file of ['real-replay.js', 'office-service.js', 'meeting-state.js', 'google-calendar.js', 'proactive-service.js']) assert.ok(!cloud.has(file) && !build.has(file), file);
});

test('入室ログ再生：初回だけ提案し、確認してから模擬予約を保存する', async () => {
  const date = '2026-04-08', gateName = 'Demo entrance';
  const entry = (time, fields = {}) => ({
    event_date_jst:'2026/4/8',event_time_jst:date+' '+time+' UTC',direction:'enter',
    people_id:'PRIVATE-EMPLOYEE',space_id:'PRIVATE-GATE',...fields
  });
  const first = entry('09:07:18.150'), second = entry('11:28:31.200');
  const spaces = [{space_id:'PRIVATE-GATE',space_name:gateName}];
  const logs = [second,entry('09:02:00.100',{space_id:'OTHER'}),first,first,
    entry('09:05:00.000',{direction:'exit'}),entry('09:08:00.000',{people_id:'OTHER'})];
  const data = selectArrivalReplay(logs,spaces,{date,gateName,firstTime:'09:07:18.150'});
  assert.deepEqual(data,{date,gateName,times:['09:07:18.150','11:28:31.200']});
  assert.equal(selectArrivalReplay(logs,spaces,{date,gateName,firstTime:'09:06:00.000'}),null);
  let instant = 0, saved;
  const storage = {
    load:()=>structuredClone(saved),
    commit(expected,state) {
      if ((saved?.version??0) !== expected) return false;
      saved=structuredClone(state);
      return true;
    }
  };
  const advance = ms => {instant += ms;};
  const base = '/api/office/arrival-replay';
  const call = async (path='',body,origin='http://127.0.0.1') => {
    const request = new Request('http://127.0.0.1'+base+path,{
      method:body===undefined?'GET':'POST',
      headers:{Origin:origin,'Content-Type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    let response;
    try { response=await createArrivalReplay(data,{elapsed:()=>instant,storage})(request); }
    catch(error) { response=errorResponse(error); }
    return {status:response.status,body:await response.json()};
  };
  const state = async () => (await call()).body;
  const ready = async () => {
    const view = await state();
    assert.equal(view.status,'ready');
    return view;
  };

  const initial = await state();
  assert.deepEqual(initial.clock,{date,time:'09:00:00'});
  assert.equal(initial.status,'waiting');
  assert.equal((await call('/play',{},'http://different.test')).status,403);
  await call('/play',{locale:'en'});
  advance(730);
  assert.deepEqual((await state()).replay.entries,[]);
  await call('/pause',{});
  advance(100);
  assert.equal((await state()).status,'waiting');
  await call('/play',{locale:'en'});
  advance(1);
  const proposed = await ready();
  assert.equal(proposed.clock.time,'09:07:18');
  assert.deepEqual(proposed.replay.entries,[{time:data.times[0],suggestion_triggered:true}]);
  assert.equal(proposed.replay.bookings,0);
  assert.equal(proposed.cards.length,1);
  const [card] = proposed.cards;
  assert.deepEqual([card.kind,card.time,card.end_time],['desk','09:07','10:30']);
  assert.doesNotMatch(JSON.stringify(proposed),/PRIVATE-/);
  const choice={plan_id:proposed.plan_id,proposal_id:card.id,space_id:card.candidates[0].id};
  assert.equal((await call('/confirm',{...choice,confirmed:false})).status,400);
  assert.equal((await state()).replay.bookings,0);
  assert.equal((await call('/confirm',{...choice,confirmed:true})).status,200);
  assert.equal((await call('/confirm',{...choice,confirmed:true})).body.reused,true);
  assert.equal((await state()).replay.bookings,1);
  await call('/play',{});
  advance(15_000);
  const finished = await state();
  assert.equal(finished.clock.time,'11:28:31');
  assert.equal(finished.plan_id,proposed.plan_id);
  assert.deepEqual(finished.replay.entries.map(x=>x.suggestion_triggered),[true,false]);
  assert.equal(finished.cards[0].status,'confirmed');
  assert.equal(finished.replay.bookings,1);
  assert.equal((await call('/confirm',{...choice,confirmed:true})).status,409);

  assert.equal((await call('/reset',{})).body.status,'waiting');
  await call('/play',{});
  advance(731);
  const again = await ready();
  assert.notEqual(again.plan_id,proposed.plan_id);
  await call('/play',{});
  advance(15_000);
  const skipped = await state();
  assert.equal(skipped.replay.bookings,0);
  assert.equal(skipped.plan_id,again.plan_id);
  assert.equal(skipped.replay.can_confirm,false);
});

test('公開入室ログ再生：架空データを使い、ブラウザーごとに再生状態を保持する', async () => {
  const data = {date:'2026-04-08',gateName:'Demo entrance',times:['09:07:18.150','11:28:31.200']};
  const base = '/api/office/arrival-replay', origin = 'https://demo.test';
  let instant = 2000;
  const rooms = new Map();
  const env = {
    OFFICE_WORKSPACES:{getByName(id) {
      if (!rooms.has(id)) rooms.set(id,createArrivalReplay(data,{source:'synthetic',elapsed:()=>instant}));
      return {fetch:rooms.get(id)};
    }},
    ASSETS:{fetch:request=>new Response(new URL(request.url).pathname)}
  };
  const call = (path,{cookie,body,from=origin}={}) => handleCloudRequest(new Request(origin+path,{
    method:body===undefined?'GET':'POST',
    headers:{Origin:from,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  }),env);
  assert.equal(await (await call('/arrival-replay')).text(),'/home.html');
  const first = await call(base), other = await call(base);
  const cookie = first.headers.get('Set-Cookie').split(';')[0];
  const otherCookie = other.headers.get('Set-Cookie').split(';')[0];
  assert.notEqual(cookie,otherCookie);
  assert.equal((await first.json()).replay.source,'synthetic');
  assert.equal((await call(base+'/play',{cookie,body:{},from:'https://different.test'})).status,403);
  assert.equal((await call(base+'/play',{cookie,body:{}})).status,200);
  instant += 1000;
  const advanced = await (await call(base,{cookie})).json();
  assert.equal(advanced.cards[0].kind,'desk');
  assert.equal(advanced.replay.entries.length,1);
  assert.equal((await (await call(base,{cookie:otherCookie})).json()).status,'waiting');
});
