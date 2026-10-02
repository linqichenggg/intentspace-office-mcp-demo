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
  '当前连接企业历史样例；部署时可配置同结构的新数据目录，重启后重新加载。',
  'JST 字段含 UTC 后缀，时区未确认；日期筛选使用源数据预约开始日期，不进行时区转换。',
  '使用、取消状态按提供方字段统计；未使用记录不直接代表浪费或可释放。',
  '容量为源数据报告值；空值和 0 均不作为已确认容量。没有实时空闲或设备可用性判断。'
];
export function selectedRows(db, args) {
  if (args.start_date > args.end_date) throw new Error('开始日期不能晚于结束日期');
  if (args.start_date < db.coverage.start || args.end_date > db.coverage.end) {
    throw new Error(`超出当前样例覆盖范围 ${db.coverage.start} ～ ${db.coverage.end}；不能将范围外无记录解释为零。`);
  }
  return db.reservations.filter(r => r.base_condition_start_date >= args.start_date && r.base_condition_start_date <= args.end_date && (!args.space_id || r.space_id === args.space_id));
}
function meta(db) { return { mode: db.kind, loaded_at: db.loadedAt, source_updated_at: null, coverage: db.coverage, date_basis: 'reservation_start_date', sources: db.sources, warnings: db.kind === 'synthetic' ? ['当前使用公开仓库自带的虚构演示数据，所有名称、ID 和行为记录均为人工编写。', '统计仅用于验证工具功能，不代表企业真实使用情况。', '可通过 OFFICE_DATA_DIR 配置同结构数据目录；重启后重新读取。'] : warnings }; }
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
    result = { total: matches.length, items: matches.slice(args.offset, args.offset + args.limit).map(s => ({ space_id: s.space_id, name: s.space_name, type: s.type, attributes: s.attribute_list, capacity_reported: Number(s.capacity) > 0 ? Number(s.capacity) : null, observed_in_reservations: booked.has(s.space_id) })), reservation_filter_basis: '仅表示样例预约中出现，不证明当前可预约' };
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
    result = { total_records: rows.length, total_spaces: groups.size, metric_definition: '非事前取消且未使用 = is_reserved=true 且 is_used!=true；按记录计数，不代表小时利用率。', items: [...groups.values()].sort((a,b) => b.unused_not_precancelled - a.unused_not_precancelled || a.space_id.localeCompare(b.space_id)).slice(0,args.limit) };
  } else if (name === 'get_evidence') {
    const r = db.reservations.find(r => r.reservations_id === args.reservation_id);
    if (!r) throw new Error('未找到该预约 ID');
    result = { record: reservation(r, db), source: { file: 'reservations.csv', sha256: db.sources['reservations.csv'].sha256, logical_record_including_header: db.reservations.indexOf(r) + 2 }, classification_source: 'reservations_classified_mapping.csv' };
  } else throw new Error('未知工具');
  return { result, meta: meta(db) };
}
