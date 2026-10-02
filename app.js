const $ = id => document.getElementById(id);
let selected = 'summarize_reservations';
function escape(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
async function call(name,args) {
  const response = await fetch('/api/call', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,arguments:args})});
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error);
  $('raw').textContent = JSON.stringify({request:{name,arguments:args},response:payload},null,2);
  $('trace').textContent = `実行ツール：${name}。ローカルの MCP 接続を通じて CSV を読み込みます。`;
  $('timing').textContent = `処理時間 ${payload.elapsed_ms} ms`;
  if (payload.result.isError) throw new Error(payload.result.content.map(c=>c.text).join('\n'));
  return payload.result.structuredContent ?? JSON.parse(payload.result.content[0].text);
}
function table(headers, rows) { $('results').innerHTML = `<div class="tableWrap"><table><thead><tr>${headers.map(h=>`<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`; }
function cell(v) { return `<td>${escape(v)}</td>`; }
async function execute(event) {
  event?.preventDefault(); $('run').disabled=true;
  $('resultTitle').textContent='検索中'; $('summary').textContent='MCP ツールを実行しています…';
  try {
    const args = selected === 'search_spaces' ? { query:$('query').value, reservable_only:true, limit:30 } : {start_date:$('start').value,end_date:$('end').value,limit:30,...($('space').value.trim()?{space_id:$('space').value.trim()}:{})};
    if(selected==='query_reservations') args.status=$('status').value;
    const {result:r}=await call(selected,args);
    if(selected==='summarize_reservations') {
      $('resultTitle').textContent='スペース別の利用記録';
      $('summary').textContent=`予約 ${r.total_records.toLocaleString('ja-JP')} 件、${r.total_spaces} スペース。事前キャンセルを除く未利用件数順に上位 ${r.items.length} 件を表示。バーは事前キャンセルを除く予約に対する未利用の割合です。`;
      table(['スペース','予約総数','利用済み','事前キャンセル除外','うち未利用'],r.items.map(x=>`<tr><td>${escape(x.name)}<span class="id">${escape(x.space_id)}</span></td><td class="number">${x.total}</td><td class="number">${x.used}</td><td class="number">${x.non_precancelled}</td><td class="count"><div class="measure"><span class="bar" aria-hidden="true"><i style="width:${x.non_precancelled?Math.round(x.unused_not_precancelled/x.non_precancelled*100):0}%"></i></span><strong>${x.unused_not_precancelled}</strong></div></td></tr>`));
    } else if(selected==='search_spaces') {
      $('resultTitle').textContent='スペース一覧';
      $('summary').textContent=`該当するスペースは ${r.total} 件、${r.items.length} 件を表示。${r.reservation_filter_basis}。`;
      table(['名称 / ID','種別','属性','登録定員'],r.items.map(x=>`<tr><td>${escape(x.name)}<span class="id">${escape(x.space_id)}</span></td>${cell(x.type)}${cell(x.attributes)}${cell(x.capacity_reported??'不明')}</tr>`));
    } else {
      $('resultTitle').textContent='予約記録';
      $('summary').textContent=`該当する予約は ${r.total.toLocaleString('ja-JP')} 件、先頭 ${r.items.length} 件を表示。日時は元データの表記です。`;
      table(['スペース / 日付','開始・終了日時（元表記）','状態 / 分類','参照元'],r.items.map(x=>`<tr><td>${escape(x.space_name)}<span class="id">${escape(x.date)}</span></td><td>${escape(x.start_raw)}<br>${escape(x.end_raw)}</td><td>${escape(x.status)}<br>${escape(x.category)}</td><td><button class="evidence" data-id="${escape(x.reservation_id)}">参照元を確認</button></td></tr>`));
    }
  } catch(error) { $('resultTitle').textContent='検索できませんでした'; $('summary').textContent=error.message; $('results').replaceChildren(); }
  finally { $('run').disabled=false; }
}
document.querySelectorAll('.preset').forEach(button=>button.addEventListener('click',()=>{
  selected=button.dataset.tool; document.querySelectorAll('.preset').forEach(b=>b.classList.toggle('active',b===button));
  $('pageTitle').textContent=button.querySelector('strong').textContent;
  $('dateFields').hidden=selected==='search_spaces'; $('searchField').hidden=selected!=='search_spaces'; $('spaceField').hidden=selected==='search_spaces'; $('statusField').hidden=selected!=='query_reservations';
  $('start').required=$('end').required=selected!=='search_spaces';
}));
$('form').addEventListener('submit',execute);
$('results').addEventListener('click',async event=>{
  const button=event.target.closest('[data-id]'); if(!button)return;
  button.disabled=true;
  try { const {result:r}=await call('get_evidence',{reservation_id:button.dataset.id}); $('summary').textContent=`参照元：${r.source.file}、論理レコード番号 ${r.source.logical_record_including_header}（ヘッダーを含む）。予約 ID：${r.record.reservation_id}。詳細とファイルの SHA-256 は返却データで確認できます。`; $('raw').parentElement.open=true; }
  catch(error){$('summary').textContent=error.message;} finally{button.disabled=false;}
});
try {
  const {result,meta}=await call('get_data_status',{});
  if(meta.mode==='synthetic') {
    document.querySelector('.office strong').textContent='デモオフィス';
    document.querySelector('.office div>span').textContent='架空のシナリオ';
    document.querySelector('.crumb').textContent='デモオフィス / オフィスデータ';
    document.querySelector('.sourceBrand>span').textContent='課題提供企業';
    document.querySelector('footer>span').textContent='架空データ / ローカル検索';
  }
  const entries=[['スペース一覧',result.tables['spaces.csv'].records],['予約記録',result.tables['reservations.csv'].records],['会議分類',result.tables['reservations_classified_mapping.csv'].records],['データ対象期間',`${meta.coverage.start} ～ ${meta.coverage.end}`]];
  $('stats').innerHTML=entries.map(([label,value])=>`<span class="${typeof value==='string'?'coverage':''}">${label}<strong>${escape(typeof value==='number'?value.toLocaleString():value)}</strong></span>`).join('');
  $('warnings').innerHTML=meta.warnings.map(w=>`<li>${escape(w)}</li>`).join('');
  $('connection').textContent='MCP 接続済み';
  await execute();
} catch(error){$('connection').textContent='接続に失敗しました';$('summary').textContent=error.message;}
