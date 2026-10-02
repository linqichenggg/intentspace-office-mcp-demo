import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runTool } from './data.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => { const d = new Date(`${s}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === s; }, '日期无效');
const period = { start_date: date, end_date: date, space_id: z.string().optional() };
const page = { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) };
const definitions = [
  ['get_data_status', '查看办公室数据范围、加载时间、源文件校验值和限制。', {}],
  ['search_spaces', '按名称、类型和报告容量查询空间；不能证明实时可用。', { query: z.string().max(100).optional(), type: z.enum(['Area','Workspot']).optional(), min_capacity: z.number().int().min(1).optional(), reservable_only: z.boolean().default(false), ...page }],
  ['query_reservations', '按源数据开始日期查询预约，返回分类与状态；支持分页。', { ...period, status: z.enum(['all','used','unused_not_precancelled']).default('all'), ...page }],
  ['summarize_reservations', '按空间汇总预约记录，列出非事前取消且未使用数量；非小时利用率。', { ...period, limit: z.number().int().min(1).max(100).default(20) }],
  ['get_evidence', '按预约 ID 返回字段与来源逻辑行号，不返回人员身份。', { reservation_id: z.string().min(1).max(200) }]
];
const server = new McpServer({ name: 'intentspace-office-data', version: '0.1.0' });
for (const [name, description, inputSchema] of definitions) {
  server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, async args => {
    try {
      const output = runTool(name, args);
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
}
await server.connect(new StdioServerTransport());
