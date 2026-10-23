import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runTool } from './queries.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => { const d = new Date(`${s}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === s; }, '日付が無効です');
const period = { start_date: date, end_date: date, space_id: z.string().optional() };
const page = { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) };
const definitions = [
  ['get_data_status', 'オフィスデータの対象期間、読み込み時刻、元ファイルのハッシュ値と制約を確認します。', {}],
  ['analyze_room_fit', '現在の模擬予約の人数と会議室定員を比較し、設備条件と同時刻の小会議室の空きを検証します。試験ルール、最大10件/室の根拠、除外理由を返します。実稼働・増設の必要性は判断しません。', {start_date:date,end_date:date}],
  ['search_spaces', '名称・種別・登録定員でスペースを検索します。リアルタイムの空き状況は判定しません。', { query: z.string().max(100).optional(), type: z.enum(['Area','Workspot']).optional(), min_capacity: z.number().int().min(1).optional(), reservable_only: z.boolean().default(false), ...page }],
  ['query_reservations', '元データの予約開始日で検索し、分類と状態を返します。ページングに対応します。', { ...period, status: z.enum(['all','used','unused_not_precancelled']).default('all'), ...page }],
  ['summarize_reservations', 'スペース別に予約を集計し、事前キャンセルを除く未利用件数を返します。時間ベースの稼働率は算出しません。', { ...period, limit: z.number().int().min(1).max(100).default(20) }],
  ['detect_unused_reservations', '履歴をルールで走査し、予約未利用の確認候補と根拠を返します。LLM不要。閾値は試験設定で、浪費や解放可能性は判定せず、自動通知・予約変更は行いません。', {
    ...period, ...page,
    min_reservations: z.number().int().min(1).max(100000).default(10),
    min_unused: z.number().int().min(1).max(100000).default(3),
    min_unused_percent: z.number().min(0).max(100).default(30)
  }],
  ['get_evidence', '予約 ID に対応する項目と参照元の論理レコード番号を返します。個人の識別情報は返しません。', { reservation_id: z.string().min(1).max(200) }]
];
export function createMcpServer(data) {
  const server = new McpServer({ name: 'intentspace-office-data', version: '0.1.0' });
  for (const [name, description, inputSchema] of definitions) {
    if (name === 'analyze_room_fit' && !data.roomFitContext) continue;
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, async args => {
      try {
        const output = runTool(name, args, data);
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    });
  }
  return server;
}
