import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';

const base = dirname(fileURLToPath(import.meta.url));
const localData = resolve(base, '../07_企业数据/2026-09-07_Bitkey/Data');
export const dataDir = resolve(process.env.OFFICE_DATA_DIR || (existsSync(resolve(localData, 'reservations.csv')) ? localData : resolve(base, 'demo-data')));
export function loadData(dir = dataDir) {
  const sources = {};
  function read(name) {
    const bytes = readFileSync(resolve(dir, name));
    const rows = parse(bytes, { columns: true, bom: true, skip_empty_lines: true });
    sources[name] = { records: rows.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    return rows;
  }
  const spaces = read('spaces.csv');
  const reservations = read('reservations.csv');
  const categories = new Map(read('reservations_classified_mapping.csv').map(r => [r.reservations_id, r.category]));
  const dates = reservations.map(r => r.base_condition_start_date).sort();
  return { spaces, reservations, categories, sources, kind: resolve(dir) === resolve(base, 'demo-data') ? 'synthetic' : 'sample', coverage: { start: dates[0], end: dates.at(-1) }, loadedAt: new Date().toISOString() };
}
export const data = loadData();
export const warnings = [
  '現在は企業提供の履歴サンプルを使用しています。同じ形式の新しいデータを指定し、再起動すると再読み込みできます。',
  'JST 項目に UTC の表記があり、タイムゾーンの意味は未確認です。元データの予約開始日で絞り込み、時差変換は行いません。',
  '利用・キャンセル状態は提供元の項目に従って集計します。未利用の記録だけでは、無駄な予約や解放可能なスペースとは判断できません。',
  '定員は元データの登録値です。空欄と 0 は不明として扱います。リアルタイムの空き状況や設備の使用可否は判定しません。'
];
export function selectedRows(db, args) {
  if (args.start_date > args.end_date) throw new Error('開始日は終了日以前の日付を指定してください');
  if (args.start_date < db.coverage.start || args.end_date > db.coverage.end) {
    throw new Error(`データ対象期間 ${db.coverage.start} ～ ${db.coverage.end} 内の日付を指定してください。対象期間外に記録がないことは、件数ゼロを意味しません。`);
  }
  return db.reservations.filter(r => r.base_condition_start_date >= args.start_date && r.base_condition_start_date <= args.end_date && (!args.space_id || r.space_id === args.space_id));
}
function meta(db) { return { mode: db.kind, loaded_at: db.loadedAt, source_updated_at: null, coverage: db.coverage, date_basis: 'reservation_start_date', sources: db.sources, warnings: db.kind === 'synthetic' ? ['公開リポジトリに含まれる架空のデモデータを使用しています。名称・ID・行動記録はすべてデモ用に作成したものです。', '集計はツールの動作確認用です。企業の実際の利用状況を示すものではありません。', 'OFFICE_DATA_DIR で同じ形式のデータディレクトリを指定できます。再起動後に読み込みます。'] : warnings }; }
function reservation(r, db) {
  return { reservation_id: r.reservations_id, space_id: r.space_id, space_name: r.space_name, date: r.base_condition_start_date, start_raw: r.base_condition_start_time_jst, end_raw: r.base_condition_end_time_jst, people_count: Number(r.total_people_count), status: r.reservation_status, is_used: r.is_used === 'true', category: db.categories.get(r.reservations_id) ?? null };
}
export function runTool(name, args, db = data) {
  let result;
  if (name === 'get_data_status') {
    result = { tables: db.sources, available_tools: ['search_spaces', 'query_reservations', 'summarize_reservations', 'get_evidence'] };
  } else if (name === 'search_spaces') {
    const booked = new Set(db.reservations.map(r => r.space_id));
    const matches = db.spaces.filter(s => (!args.query || s.space_name.toLowerCase().includes(args.query.toLowerCase())) && (!args.type || s.type === args.type) && (!args.reservable_only || booked.has(s.space_id)) && (args.min_capacity === undefined || (Number(s.capacity) > 0 && Number(s.capacity) >= args.min_capacity)));
    result = { total: matches.length, items: matches.slice(args.offset, args.offset + args.limit).map(s => ({ space_id: s.space_id, name: s.space_name, type: s.type, attributes: s.attribute_list, capacity_reported: Number(s.capacity) > 0 ? Number(s.capacity) : null, observed_in_reservations: booked.has(s.space_id) })), reservation_filter_basis: 'サンプル内に予約記録があるスペースです。現在予約可能であることを保証しません' };
  } else if (name === 'query_reservations') {
    let rows = selectedRows(db, args);
    if (args.status === 'used') rows = rows.filter(r => r.is_used === 'true');
    if (args.status === 'unused_not_precancelled') rows = rows.filter(r => r.is_used !== 'true' && r.is_reserved === 'true');
    result = { total: rows.length, items: rows.slice(args.offset, args.offset + args.limit).map(r => reservation(r, db)) };
  } else if (name === 'summarize_reservations') {
    const rows = selectedRows(db, args), groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.space_id)) groups.set(r.space_id, { space_id: r.space_id, name: r.space_name, total: 0, used: 0, non_precancelled: 0, unused_not_precancelled: 0, statuses: {} });
      const g = groups.get(r.space_id);
      g.total++;
      g.statuses[r.reservation_status] = (g.statuses[r.reservation_status] || 0) + 1;
      if (r.is_used === 'true') g.used++;
      if (r.is_reserved === 'true') { g.non_precancelled++; if (r.is_used !== 'true') g.unused_not_precancelled++; }
    }
    result = { total_records: rows.length, total_spaces: groups.size, metric_definition: '事前キャンセルを除く未利用 = is_reserved=true かつ is_used!=true。レコード件数の集計であり、時間ベースの稼働率ではありません。', items: [...groups.values()].sort((a,b) => b.unused_not_precancelled - a.unused_not_precancelled || a.space_id.localeCompare(b.space_id)).slice(0,args.limit) };
  } else if (name === 'get_evidence') {
    const r = db.reservations.find(r => r.reservations_id === args.reservation_id);
    if (!r) throw new Error('指定した予約 ID は見つかりません');
    result = { record: reservation(r, db), source: { file: 'reservations.csv', sha256: db.sources['reservations.csv'].sha256, logical_record_including_header: db.reservations.indexOf(r) + 2 }, classification_source: 'reservations_classified_mapping.csv' };
  } else throw new Error('不明なツールです');
  return { result, meta: meta(db) };
}
