import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealReplay, wallClock, classifyBooking, replayFrame } from './real-replay.js';
import { createOfficeService, officeRooms, handleStoredOfficeRequest } from './office-service.js';
import { createHistoricalDemoState } from './meeting-state.js';
import { renderReplayShell, renderReplayMap, renderReplaySide, peakMinute, dayStats, clockText } from './replay-ui.js';
import { translator, messages } from './ui-i18n.js';
import { errorResponse } from './http-utils.js';

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
