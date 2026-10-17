import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';

export function createDataset(files, kind) {
  const sources = {};
  function read(name) {
    const bytes = files[name];
    const rows = parse(bytes, { columns: true, bom: true, skip_empty_lines: true });
    sources[name] = { records: rows.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    return rows;
  }
  const spaces = read('spaces.csv');
  const reservations = read('reservations.csv');
  if (!reservations.length) throw new Error('予約データが空です');
  const categories = new Map(read('reservations_classified_mapping.csv').map(r => [r.reservations_id, r.category]));
  const dates = reservations.map(r => r.base_condition_start_date).sort();
  return { spaces, reservations, categories, sources, kind, coverage: { start: dates[0], end: dates.at(-1) }, loadedAt: new Date().toISOString() };
}

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
function meta(db) { return { mode: db.kind, loaded_at: db.loadedAt, source_updated_at: null, coverage: db.coverage, date_basis: 'reservation_start_date', sources: db.sources, warnings: db.kind === 'synthetic' ? ['公開リポジトリに含まれる架空のデモデータを使用しています。名称・ID・行動記録はすべてデモ用に作成したものです。', '集計はツールの動作確認用です。企業の実際の利用状況を示すものではありません。', '公開版は架空データのみを使用します。実際の企業データは含まれていません。'] : warnings }; }
function reservation(r, db) {
  return { reservation_id: r.reservations_id, space_id: r.space_id, space_name: r.space_name, date: r.base_condition_start_date, start_raw: r.base_condition_start_time_jst, end_raw: r.base_condition_end_time_jst, people_count: Number(r.total_people_count), status: r.reservation_status, is_used: r.is_used === 'true', category: db.categories.get(r.reservations_id) ?? null };
}

function groupReservations(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.space_id)) groups.set(row.space_id, {
      space_id: row.space_id, name: row.space_name, total: 0, used: 0,
      non_precancelled: 0, unused_not_precancelled: 0, statuses: {}, records: []
    });
    const group = groups.get(row.space_id);
    group.total++;
    group.records.push(row);
    group.statuses[row.reservation_status] = (group.statuses[row.reservation_status] || 0) + 1;
    if (row.is_used === 'true') group.used++;
    if (row.is_reserved === 'true') {
      group.non_precancelled++;
      if (row.is_used !== 'true') group.unused_not_precancelled++;
    }
  }
  return [...groups.values()];
}

function detectUnusedReservations(rows, args, db) {
  const rule = { min_reservations: args.min_reservations, min_unused: args.min_unused, min_unused_percent: args.min_unused_percent };
  const period = { start_date: args.start_date, end_date: args.end_date };
  const items = groupReservations(rows).map(group => {
    // Unknown flags must not become evidence of non-use. Pre-cancellations are excluded.
    const eligible = group.records.filter(row => row.is_reserved === 'true' && ['true', 'false'].includes(row.is_used));
    const unused = eligible.filter(row => row.is_used === 'false');
    const unknown = group.records.filter(row => !['true', 'false'].includes(row.is_reserved) || (row.is_reserved === 'true' && !['true', 'false'].includes(row.is_used)));
    const enough = eligible.length >= rule.min_reservations;
    // Compare unrounded counts; the displayed percentage is rounded independently.
    const triggered = enough && unused.length >= rule.min_unused && unused.length * 100 >= eligible.length * rule.min_unused_percent;
    const status = triggered ? 'review' : enough ? 'below_threshold' : 'insufficient_data';
    const evidence = unused.slice(0, 5).map(row => ({
      reservation_id: row.reservations_id, date: row.base_condition_start_date,
      status: row.reservation_status, category: db.categories.get(row.reservations_id) ?? null
    }));
    const findingId = createHash('sha256').update(JSON.stringify({ space_id: group.space_id, period, rule, source: db.sources['reservations.csv'].sha256 })).digest('hex').slice(0, 20);
    return {
      finding_id: triggered ? findingId : null, space_id: group.space_id, name: group.name, status,
      total_records: group.total, eligible_reservations: eligible.length, unused_count: unused.length,
      unused_percent: eligible.length ? Math.round(unused.length / eligible.length * 10000) / 100 : null,
      excluded_precancelled: group.records.filter(row => row.is_reserved === 'false').length,
      excluded_unknown: unknown.length, evidence: triggered ? evidence : [],
      evidence_total: triggered ? unused.length : 0,
      suggestion: triggered ? '関連する予約記録を確認し、未利用の理由を管理者が確認してください。必要に応じて予約前のリマインドや利用確認の運用を検討してください。' : null
    };
  }).sort((a, b) => Number(b.status === 'review') - Number(a.status === 'review') || b.unused_count - a.unused_count || a.space_id.localeCompare(b.space_id));
  return {
    period, rule, total_records: rows.length, total_spaces: items.length,
    review_count: items.filter(item => item.status === 'review').length,
    evaluated_count: items.filter(item => item.status !== 'insufficient_data').length,
    insufficient_count: items.filter(item => item.status === 'insufficient_data').length,
    excluded_unknown: items.reduce((sum, item) => sum + item.excluded_unknown, 0),
    items: items.slice(args.offset, args.offset + args.limit),
    // Comparison must use every space, independent of display pagination.
    comparison_snapshot: {
      schema_version: 1, metric_version: 'known-usage-v1',
      dataset_scope: createHash('sha256').update(JSON.stringify({ mode: db.kind, organizations: [...new Set(db.spaces.map(space => space.organization_id))].sort() })).digest('hex'),
      data_hash: createHash('sha256').update(JSON.stringify(Object.entries(db.sources).map(([name, source]) => [name, source.sha256]).sort())).digest('hex'),
      scope: { ...period, space_id: args.space_id || null }, rule: { ...rule }, total_spaces: items.length,
      items: items.map(({space_id, name, status, eligible_reservations, unused_count, excluded_unknown}) => ({space_id, name, status, eligible_reservations, unused_count, excluded_unknown}))
    },
    metric_definition: '判定母数は is_reserved=true かつ is_used が true/false の記録。未利用は is_used=false。事前キャンセルと不明なフラグは判定から除外します。',
    limitations: ['試験用のルールです。閾値は企業と合意した基準ではありません。', '読み込み済みの履歴を走査します。変化の自動検知・通知配信・予約変更は行いません。', '未利用の原因、浪費、現在の空き状況は判断できません。証拠は各スペース最大5件を表示し、追加の記録は予約明細で確認できます。']
  };
}
export function runTool(name, args, db) {
  let result;
  if (name === 'get_data_status') {
    result = { tables: db.sources, available_tools: ['search_spaces', 'query_reservations', 'summarize_reservations', 'detect_unused_reservations', 'get_evidence'] };
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
    const rows = selectedRows(db, args), groups = groupReservations(rows);
    result = { total_records: rows.length, total_spaces: groups.length, metric_definition: '事前キャンセルを除く未利用 = is_reserved=true かつ is_used!=true。レコード件数の集計であり、時間ベースの稼働率ではありません。', items: groups.map(({records, ...group}) => group).sort((a,b) => b.unused_not_precancelled - a.unused_not_precancelled || a.space_id.localeCompare(b.space_id)).slice(0,args.limit) };
  } else if (name === 'detect_unused_reservations') {
    result = detectUnusedReservations(selectedRows(db, args), args, db);
  } else if (name === 'get_evidence') {
    const r = db.reservations.find(r => r.reservations_id === args.reservation_id);
    if (!r) throw new Error('指定した予約 ID は見つかりません');
    result = { record: reservation(r, db), source: { file: 'reservations.csv', sha256: db.sources['reservations.csv'].sha256, logical_record_including_header: db.reservations.indexOf(r) + 2 }, classification_source: 'reservations_classified_mapping.csv' };
  } else throw new Error('不明なツールです');
  return { result, meta: meta(db) };
}
