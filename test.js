import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

test('MCP 接続：ツール一覧・集計と明細の一致・参照元・入力エラー', async () => {
  const client = new Client({name:'office-test',version:'1.0.0'});
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./server.js',import.meta.url))]}));
    const tools=await client.listTools(); assert.equal(tools.tools.length,5);
    const invoke=async(name,args)=>client.callTool({name,arguments:args});
    const status=(await invoke('get_data_status',{})).structuredContent;
    assert.ok(status.result.tables['reservations.csv'].records > 0);
    const period={start_date:'2026-02-01',end_date:'2026-02-28'};
    const summary=(await invoke('summarize_reservations',{...period,limit:100})).structuredContent.result;
    const rows=(await invoke('query_reservations',{...period,limit:100})).structuredContent.result;
    assert.equal(summary.total_records,rows.total);
    assert.equal(summary.items.reduce((n,r)=>n+r.total,0),rows.total);
    for(const group of summary.items){
      const filtered=(await invoke('query_reservations',{...period,space_id:group.space_id,status:'unused_not_precancelled',limit:1})).structuredContent.result;
      assert.equal(group.unused_not_precancelled,filtered.total);
    }
    const evidence=(await invoke('get_evidence',{reservation_id:rows.items[0].reservation_id})).structuredContent.result;
    assert.deepEqual(evidence.record,rows.items[0]); assert.ok(evidence.source.logical_record_including_header>=2);
    assert.equal((await invoke('summarize_reservations',{start_date:'2026-10-01',end_date:'2026-10-02'})).isError,true);
    assert.equal((await invoke('query_reservations',{start_date:'2026-02-28',end_date:'2026-02-01'})).isError,true);
    assert.equal((await invoke('query_reservations',{start_date:'2026-02-30',end_date:'2026-03-01'})).isError,true);
    const spaces=(await invoke('search_spaces',{min_capacity:4,limit:100})).structuredContent.result;
    assert.ok(spaces.items.every(s=>s.capacity_reported>=4));
  } finally { await client.close(); }
});
