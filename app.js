const $ = id => document.getElementById(id);
let selected = 'summarize_reservations';
function escape(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
async function call(name,args) {
  const response = await fetch('/api/call', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,arguments:args})});
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error);
  $('raw').textContent = JSON.stringify({request:{name,arguments:args},response:payload},null,2);
  $('trace').textContent = `执行工具：${name}；通过本地 MCP 连接读取企业 CSV。`;
  $('timing').textContent = `查询耗时 ${payload.elapsed_ms} ms`;
  if (payload.result.isError) throw new Error(payload.result.content.map(c=>c.text).join('\n'));
  return payload.result.structuredContent ?? JSON.parse(payload.result.content[0].text);
}
function table(headers, rows) { $('results').innerHTML = `<div class="tableWrap"><table><thead><tr>${headers.map(h=>`<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`; }
function cell(v) { return `<td>${escape(v)}</td>`; }
async function execute(event) {
  event?.preventDefault(); $('run').disabled=true;
  $('resultTitle').textContent='正在查询'; $('summary').textContent='通过 MCP 执行工具…';
  try {
    const args = selected === 'search_spaces' ? { query:$('query').value, reservable_only:true, limit:30 } : {start_date:$('start').value,end_date:$('end').value,limit:30,...($('space').value.trim()?{space_id:$('space').value.trim()}:{})};
    if(selected==='query_reservations') args.status=$('status').value;
    const {result:r}=await call(selected,args);
    if(selected==='summarize_reservations') {
      $('resultTitle').textContent='空间使用记录';
      $('summary').textContent=`${r.total_records.toLocaleString()} 条预约，${r.total_spaces} 个空间。按非事前取消且未使用数量排序，展示前 ${r.items.length} 项。条形表示未使用记录占非事前取消记录的比例。`;
      table(['空间','全部预约','已使用','非事前取消','其中未使用'],r.items.map(x=>`<tr><td>${escape(x.name)}<span class="id">${escape(x.space_id)}</span></td><td class="number">${x.total}</td><td class="number">${x.used}</td><td class="number">${x.non_precancelled}</td><td class="count"><div class="measure"><span class="bar" aria-hidden="true"><i style="width:${x.non_precancelled?Math.round(x.unused_not_precancelled/x.non_precancelled*100):0}%"></i></span><strong>${x.unused_not_precancelled}</strong></div></td></tr>`));
    } else if(selected==='search_spaces') {
      $('resultTitle').textContent='空间列表';
      $('summary').textContent=`匹配 ${r.total} 个空间，展示 ${r.items.length} 个。${r.reservation_filter_basis}。`;
      table(['名称 / ID','类型','属性','报告容量'],r.items.map(x=>`<tr><td>${escape(x.name)}<span class="id">${escape(x.space_id)}</span></td>${cell(x.type)}${cell(x.attributes)}${cell(x.capacity_reported??'未知')}</tr>`));
    } else {
      $('resultTitle').textContent='预约记录';
      $('summary').textContent=`符合条件 ${r.total.toLocaleString()} 条，展示前 ${r.items.length} 条。时间保留源数据原文。`;
      table(['空间 / 日期','起止时间原文','状态 / 分类','依据'],r.items.map(x=>`<tr><td>${escape(x.space_name)}<span class="id">${escape(x.date)}</span></td><td>${escape(x.start_raw)}<br>${escape(x.end_raw)}</td><td>${escape(x.status)}<br>${escape(x.category)}</td><td><button class="evidence" data-id="${escape(x.reservation_id)}">查看来源</button></td></tr>`));
    }
  } catch(error) { $('resultTitle').textContent='查询未完成'; $('summary').textContent=error.message; $('results').replaceChildren(); }
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
  try { const {result:r}=await call('get_evidence',{reservation_id:button.dataset.id}); $('summary').textContent=`来源 ${r.source.file}，逻辑记录序号 ${r.source.logical_record_including_header}（含表头）。预约 ${r.record.reservation_id}。完整字段和文件 SHA-256 见下方原始返回。`; $('raw').parentElement.open=true; }
  catch(error){$('summary').textContent=error.message;} finally{button.disabled=false;}
});
try {
  const {result,meta}=await call('get_data_status',{});
  if(meta.mode==='synthetic') {
    document.querySelector('.office strong').textContent='演示办公室';
    document.querySelector('.office div>span').textContent='虚构场景';
    document.querySelector('.crumb').textContent='演示办公室 / 办公室数据';
    document.querySelector('.sourceBrand>span').textContent='课题企业';
    document.querySelector('footer>span').textContent='虚构数据 · 本机查询';
  }
  const entries=[['空间目录',result.tables['spaces.csv'].records],['预约记录',result.tables['reservations.csv'].records],['会议分类',result.tables['reservations_classified_mapping.csv'].records],['样例覆盖',`${meta.coverage.start} ～ ${meta.coverage.end}`]];
  $('stats').innerHTML=entries.map(([label,value])=>`<span class="${typeof value==='string'?'coverage':''}">${label}<strong>${escape(typeof value==='number'?value.toLocaleString():value)}</strong></span>`).join('');
  $('warnings').innerHTML=meta.warnings.map(w=>`<li>${escape(w)}</li>`).join('');
  $('connection').textContent='MCP 已连接';
  await execute();
} catch(error){$('connection').textContent='连接失败';$('summary').textContent=error.message;}
