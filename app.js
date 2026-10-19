import { ReviewComparison } from './session.js';

const $ = id => document.getElementById(id);
const reviewComparison = new ReviewComparison();
const demoComparison = new ReviewComparison();
let demoStep = -1;
let demoGeneration = 0;
let demoController = null;
let latestReviewSnapshot = null;
let selected = 'summarize_reservations';
let queryGeneration = 0;
function escape(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
async function call(name,args,shouldDisplay = () => true) {
  const response = await fetch('/api/call', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,arguments:args})});
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error);
  if (shouldDisplay()) {
    $('raw').textContent = JSON.stringify({request:{name,arguments:args},response:payload},null,2);
    $('trace').textContent = `実行ツール：${name}。MCP 接続を通じて読み込み済みデータを照会します。`;
    $('timing').textContent = `処理時間 ${payload.elapsed_ms} ms`;
  }
  if (payload.result.isError) throw new Error(payload.result.content.map(c=>c.text).join('\n'));
  return payload.result.structuredContent ?? JSON.parse(payload.result.content[0].text);
}
function table(headers, rows) {
  $('results').innerHTML = rows.length
    ? `<div class="tableWrap" tabindex="0" role="region" aria-label="検索結果の表"><table><thead><tr>${headers.map(h=>`<th scope="col"${['予約総数','利用済み','事前キャンセル除外','うち未利用'].includes(h)?' class="number"':''}>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : '<div class="emptyResult"><strong>条件に一致する記録はありません</strong>検索条件を変更して、もう一度お試しください。</div>';
}
function cell(v) { return `<td>${escape(v)}</td>`; }
function runLabel() { return selected === 'detect_unused_reservations' ? 'ルールで確認する' : selected === 'summarize_reservations' ? '集計する' : '検索する'; }
function renderComparison(comparison, prefix = 'comparison') {
  const part = suffix => $(prefix + suffix);
  part('Panel').hidden = false;
  const reasons = {dataset_changed:'データ範囲が異なります。', metric_changed:'集計方法の版が異なります。', scope_changed:'期間またはスペースの絞り込みが異なります。', rule_changed:'判定の閾値が異なります。'};
  const labels = {new:'新規の候補', ongoing:'継続中', no_longer_matches:'条件を満たさなくなった', uncertain:'判断保留', unchanged:'変化なし'};
  const statusLabels = {review:'確認候補', below_threshold:'閾値未満', insufficient_data:'サンプル不足'};
  part('Title').textContent = comparison.state === 'baseline' ? '比較の基準を作成しました' : comparison.state === 'incomparable' ? '条件が異なるため比較できません' : '前回の確認からの変化';
  part('Message').textContent = comparison.state === 'baseline'
    ? `初回の ${comparison.total_spaces} スペースを基準として保持しました。今回は新規の候補として扱いません。`
    : comparison.state === 'incomparable' ? `${reasons[comparison.reason]}元の基準は保持しています。この条件で比較を始める場合は「今回を基準にする」を押してください。`
    : `${comparison.data_changed?'データ内容に更新があります。':'データ内容は前回と同じです。新しいデータの検知ではありません。'} 新規 ${comparison.counts.new} 件 / 継続 ${comparison.counts.ongoing} 件 / 条件を満たさなくなった ${comparison.counts.no_longer_matches} 件 / 判断保留 ${comparison.counts.uncertain} 件 / 変化なし ${comparison.counts.unchanged} 件。`;
  const priority = {new:0, ongoing:1, no_longer_matches:2, uncertain:3};
  const rows = comparison.items.filter(item => item.change !== 'unchanged').sort((a,b) => priority[a.change]-priority[b.change] || a.space_id.localeCompare(b.space_id));
  const describe = item => item ? `${statusLabels[item.status]}（未利用 ${item.unused_count} / 判定対象 ${item.eligible_reservations} 件）` : '対象内に記録なし';
  const uncertainReasons = {missing_record:'片方の結果に記録がありません。', insufficient_data:'少なくとも片方の結果がサンプル不足です。', unknown_status:'状態不明の記録が含まれています。'};
  part('Results').innerHTML = rows.length ? `<p>変化・継続・判断保留 ${rows.length} スペースのうち先頭 ${Math.min(rows.length,30)} 件を表示。条件を満たさなくなっても、問題解決を意味しません。</p><div class="tableWrap" tabindex="0" role="region" aria-label="前回と今回の比較表"><table><thead><tr><th scope="col">スペース</th><th scope="col">変化</th><th scope="col">前回</th><th scope="col">今回</th></tr></thead><tbody>${rows.slice(0,30).map(item=>`<tr><td>${escape(item.name)}<span class="id">${escape(item.space_id)}</span></td><td>${labels[item.change]}${item.reason?`<span class="id">${uncertainReasons[item.reason]}</span>`:''}</td><td>${escape(describe(item.previous))}</td><td>${escape(describe(item.current))}</td></tr>`).join('')}</tbody></table></div>` : '';
}

const demoActions = ['デモを始める', '未利用の記録を2件追加', '同じデータでもう一度確認', '利用済みの記録を5件追加'];
function resetDemo() {
  demoGeneration++;
  demoController?.abort();
  demoController = null;
  demoStep = -1;
  demoComparison.clear();
  $('demoNext').disabled = false;
  $('demoNext').textContent = demoActions[0];
  $('demoReset').disabled = true;
  $('demoOutcome').textContent = '「デモを始める」で最初の2件を読み込み、比較の基準を作成します。';
  $('demoResults').replaceChildren();
  $('demoResults').setAttribute('aria-busy', 'false');
  $('demoComparisonPanel').hidden = true;
  document.querySelectorAll('[data-demo-step]').forEach(item => { item.removeAttribute('aria-current'); item.classList.remove('done'); });
}
async function advanceDemo() {
  if ($('demoNext').disabled || demoStep >= 3) return;
  const next = demoStep + 1;
  const generation = ++demoGeneration;
  demoController = new AbortController();
  $('demoNext').disabled = true;
  $('demoReset').disabled = false;
  $('demoOutcome').textContent = '架空データを MCP で確認しています…';
  $('demoResults').setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(`/api/review-demo?step=${next}`, { signal: demoController.signal });
    const payload = await response.json();
    if (generation !== demoGeneration) return;
    if (!response.ok) throw new Error(payload.error || 'デモを実行できませんでした。');
    if (payload.simulation !== true || payload.step !== next) throw new Error('デモデータを確認できませんでした。');
    const comparison = demoComparison.check(payload.result.comparison_snapshot);
    const item = payload.result.items[0];
    renderComparison(comparison, 'demoComparison');
    $('demoOutcome').textContent = `架空バッチ ${payload.batch}：判定対象 ${item.eligible_reservations} 件 / 未利用 ${item.unused_count} 件（${item.unused_percent}%）。${next === 0 ? '初回の基準です。' : next === 1 ? '追加した2件により、試験条件を満たしました。' : next === 2 ? 'バッチ B を再確認しました。新規の候補は増えません。' : '利用済み5件の追加で割合が50%未満になりました。問題解決を意味しません。'}`;
    $('demoResults').innerHTML = `<details class="demoEvidence"><summary>このバッチの根拠 ${payload.evidence.length} 件を見る</summary><div class="tableWrap" tabindex="0" role="region" aria-label="架空バッチの予約記録"><table><thead><tr><th scope="col">予約 ID / 日付</th><th scope="col">利用状態</th><th scope="col">参照元</th></tr></thead><tbody>${payload.evidence.map(({record, source}) => `<tr><td>${escape(record.reservation_id)}<span class="id">${escape(record.date)}</span></td><td>${escape(record.status)}</td><td>${escape(source.file)}<span class="id">論理レコード ${source.logical_record_including_header}</span></td></tr>`).join('')}</tbody></table></div><p>このバッチだけの架空レコードです。通常検索の予約 ID とは別です。</p></details>`;
    demoStep = next;
    document.querySelectorAll('[data-demo-step]').forEach(item => {
      const step = Number(item.dataset.demoStep);
      step === demoStep ? item.setAttribute('aria-current', 'step') : item.removeAttribute('aria-current');
      item.classList.toggle('done', step < demoStep);
    });
    $('demoNext').textContent = demoActions[demoStep + 1] || 'デモ完了';
  } catch (error) {
    if (generation === demoGeneration) $('demoOutcome').textContent = `${error.message} 同じ操作で再試行できます。`;
  } finally {
    if (generation === demoGeneration) {
      $('demoNext').disabled = demoStep >= 3;
      $('demoResults').setAttribute('aria-busy', 'false');
    }
  }
}
$('demoNext').addEventListener('click', advanceDemo);
$('demoReset').addEventListener('click', resetDemo);
function renderReview(result) {
  const statusLabels = {review:'確認候補', below_threshold:'閾値未満', insufficient_data:'サンプル不足'};
  const percent = value => value === null ? '判定母数なし' : `${value.toLocaleString('ja-JP', {maximumFractionDigits:2})}%`;
  const findings = result.items.filter(item => item.status === 'review').map(item => `<article class="reviewFinding">
    <div class="findingHeading"><span class="reviewBadge">確認候補</span><h3>${escape(item.name)}</h3></div>
    <p>判定対象 ${item.eligible_reservations} 件のうち未利用 ${item.unused_count} 件（${percent(item.unused_percent)}）。<br>期間：${escape(result.period.start_date)} ～ ${escape(result.period.end_date)}</p>
    <h4>管理者への提案</h4><p>${escape(item.suggestion)}</p>
    <details class="findingEvidence"><summary>根拠の予約記録（${item.evidence.length} / ${item.evidence_total} 件）</summary><ul>${item.evidence.map(row=>`<li><span>${escape(row.date)} · ${escape(row.status)}<small>${escape(row.category ?? '分類なし')} / ${escape(row.reservation_id)}</small></span><button class="evidence" data-id="${escape(row.reservation_id)}">参照元を確認</button></li>`).join('')}</ul>${item.evidence_total>item.evidence.length?'<p>追加の記録は「予約明細」で同じ期間・スペース ID を指定し、未利用の状態で絞り込んでください。</p>':''}</details>
  </article>`).join('');
  table(['スペース','判定対象の予約','うち未利用','未利用割合','判定'],result.items.map(item=>`<tr><td>${escape(item.name)}<span class="id">${escape(item.space_id)}</span><span class="id">除外：事前取消 ${item.excluded_precancelled} 件 / 状態不明 ${item.excluded_unknown} 件</span></td><td class="number">${item.eligible_reservations}</td><td class="number">${item.unused_count}</td><td>${percent(item.unused_percent)}</td><td><span class="ruleStatus ${item.status}">${statusLabels[item.status]}</span></td></tr>`));
  $('results').insertAdjacentHTML('afterbegin', `<div class="ruleOverview"><h3>確認候補 ${result.review_count} 件</h3><p>${result.evaluated_count===0?'判定に必要な予約数を満たすスペースがありません。未利用の問題がないという意味ではありません。':result.review_count===0?'今回の試験条件を満たすスペースはありません。':'関連記録を確認してから、対応を検討してください。'} 不明な状態による除外は全体で ${result.excluded_unknown} 件です。</p><p>履歴のルール走査です。自動監視・通知配信・予約変更は行いません。未利用の原因や浪費は判断できません。</p></div>${findings?`<div class="reviewFindings">${findings}</div>`:''}`);
}
async function execute(event) {
  event?.preventDefault();
  const generation = ++queryGeneration;
  const tool = selected;
  const isCurrent = () => generation === queryGeneration;
  latestReviewSnapshot = null;
  $('comparisonPanel').hidden = true;
  if (!$('form').reportValidity()) {
    $('run').disabled = false;
    $('run').textContent = runLabel();
    $('resultTitle').textContent = '条件を確認してください';
    $('summary').textContent = '日付と数値を入力欄の範囲内で指定してください。';
    $('results').replaceChildren();
    $('results').setAttribute('aria-busy', 'false');
    $('evidenceSummary').hidden = true;
    return;
  }
  $('run').disabled=true;
  $('results').setAttribute('aria-busy', 'true');
  $('run').textContent = '検索中…';
  $('timing').textContent = '';
  $('evidenceSummary').hidden = true;
  $('resultTitle').textContent='検索中'; $('summary').textContent='MCP ツールを実行しています…';
  try {
    const args = selected === 'search_spaces' ? { query:$('query').value, reservable_only:true, limit:30 } : {start_date:$('start').value,end_date:$('end').value,limit:30,...($('space').value.trim()?{space_id:$('space').value.trim()}:{})};
    if(selected==='query_reservations') args.status=$('status').value;
    if (tool === 'detect_unused_reservations') Object.assign(args, {
      min_reservations: $('minReservations').valueAsNumber,
      min_unused: $('minUnused').valueAsNumber,
      min_unused_percent: $('minUnusedPercent').valueAsNumber
    });
    const {result:r}=await call(tool,args,isCurrent);
    if (!isCurrent()) return;
    if(tool==='summarize_reservations') {
      $('resultTitle').textContent='スペース別の利用記録';
      $('summary').textContent=`予約 ${r.total_records.toLocaleString('ja-JP')} 件、${r.total_spaces} スペース。事前キャンセルを除く未利用件数順に上位 ${r.items.length} 件を表示。バーは事前キャンセルを除く予約に対する未利用の割合です。`;
      table(['スペース','予約総数','利用済み','事前キャンセル除外','うち未利用'],r.items.map(x=>`<tr><td>${escape(x.name)}<span class="id">${escape(x.space_id)}</span></td><td class="number">${x.total}</td><td class="number">${x.used}</td><td class="number">${x.non_precancelled}</td><td class="count"><div class="measure"><span class="bar" aria-hidden="true"><i style="width:${x.non_precancelled?Math.round(x.unused_not_precancelled/x.non_precancelled*100):0}%"></i></span><strong>${x.unused_not_precancelled}</strong></div></td></tr>`));
    } else if(tool==='search_spaces') {
      $('resultTitle').textContent='スペース一覧';
      $('summary').textContent=`該当するスペースは ${r.total} 件、${r.items.length} 件を表示。${r.reservation_filter_basis}。`;
      table(['名称 / ID','種別','属性','登録定員'],r.items.map(x=>`<tr><td>${escape(x.name)}<span class="id">${escape(x.space_id)}</span></td>${cell(x.type)}${cell(x.attributes)}${cell(x.capacity_reported??'不明')}</tr>`));
    } else if (tool === 'detect_unused_reservations') {
      $('resultTitle').textContent='予約未利用の確認結果';
      $('summary').textContent=`試験条件：判定対象の予約 ${r.rule.min_reservations} 件以上、未利用 ${r.rule.min_unused} 件以上、未利用割合 ${r.rule.min_unused_percent}% 以上。対象 ${r.total_spaces} スペースの先頭 ${r.items.length} 件を表示。予約開始日で絞り込み、時間ベースの稼働率は計算しません。`;
      renderReview(r);
      const comparison = reviewComparison.check(r.comparison_snapshot);
      latestReviewSnapshot = structuredClone(r.comparison_snapshot);
      renderComparison(comparison);
    } else {
      $('resultTitle').textContent='予約記録';
      $('summary').textContent=`該当する予約は ${r.total.toLocaleString('ja-JP')} 件、先頭 ${r.items.length} 件を表示。日時は元データの表記です。`;
      table(['スペース / 日付','開始・終了日時（元表記）','状態 / 分類','参照元'],r.items.map(x=>`<tr><td>${escape(x.space_name)}<span class="id">${escape(x.date)}</span></td><td>${escape(x.start_raw)}<br>${escape(x.end_raw)}</td><td>${escape(x.status)}<br>${escape(x.category)}</td><td><button class="evidence" data-id="${escape(x.reservation_id)}">参照元を確認</button></td></tr>`));
    }
  } catch(error) { if (isCurrent()) { $('resultTitle').textContent='検索できませんでした'; $('summary').textContent=error.message; $('results').replaceChildren(); } }
  finally { if (isCurrent()) { $('run').disabled=false; $('run').textContent=runLabel(); $('results').setAttribute('aria-busy','false'); } }
}
document.querySelectorAll('[data-tool]').forEach(button=>button.addEventListener('click',()=>{
  selected=button.dataset.tool; document.querySelectorAll('.preset').forEach(b=>b.classList.toggle('active',b===button));
  document.querySelectorAll('.preset').forEach(b=>b===button?b.setAttribute('aria-current','page'):b.removeAttribute('aria-current'));
  $('pageTitle').textContent=button.querySelector('strong').textContent;
  $('pageDescription').textContent={summarize_reservations:'オフィスの使われ方を、データから確かめる。',search_spaces:'会議室・ブースの属性と登録定員を確認する。',query_reservations:'予約の日時、状態、分類をひとつずつ確かめる。',detect_unused_reservations:'履歴をルールで確認し、管理者が検討するきっかけに。LLM・API Key は不要です。'}[selected];
  $('dateFields').hidden=selected==='search_spaces'; $('searchField').hidden=selected!=='search_spaces'; $('spaceField').hidden=selected==='search_spaces'; $('statusField').hidden=selected!=='query_reservations';
  $('start').required=$('end').required=selected!=='search_spaces';
  $('ruleFields').hidden=selected!=='detect_unused_reservations';
  $('ruleFields').disabled=selected!=='detect_unused_reservations';
  $('demoPanel').hidden=selected!=='detect_unused_reservations';
  execute();
}));
$('form').addEventListener('submit',execute);
$('resetComparison').addEventListener('click', () => {
  if (latestReviewSnapshot) renderComparison(reviewComparison.setBaseline(latestReviewSnapshot));
});
window.addEventListener('pagehide', () => {
  resetDemo();
  queryGeneration++;
  reviewComparison.clear();
  latestReviewSnapshot = null;
  $('comparisonPanel').hidden = true;
  $('run').disabled = false;
  $('run').textContent = runLabel();
  $('results').setAttribute('aria-busy', 'false');
});
$('results').addEventListener('click',async event=>{
  const button=event.target.closest('[data-id]'); if(!button)return;
  const generation = queryGeneration;
  const isCurrent = () => generation === queryGeneration;
  button.disabled=true;
  try { const {result:r}=await call('get_evidence',{reservation_id:button.dataset.id},isCurrent); if (!isCurrent()) return; $('evidenceSummary').textContent=`参照元：${r.source.file}、論理レコード番号 ${r.source.logical_record_including_header}（ヘッダーを含む）。予約 ID：${r.record.reservation_id}。詳細とファイルの SHA-256 は返却データで確認できます。`; $('evidenceSummary').hidden=false; $('raw').parentElement.open=true; }
  catch(error){if(isCurrent()){$('evidenceSummary').textContent=error.message;$('evidenceSummary').hidden=false;}} finally{button.disabled=false;}
});
try {
  const {result,meta}=await call('get_data_status',{});
  if(meta.mode==='synthetic') {
    document.querySelector('.office strong').textContent='デモオフィス';
    document.querySelector('.office div>span').textContent='架空のシナリオ';
    document.querySelector('.crumb').textContent='デモオフィス / オフィスデータ';
    document.querySelector('.sourceBrand>span').textContent='課題提供企業';
    document.querySelector('footer>span').textContent='架空データ / 読み取り専用';
    $('dataMode').textContent='架空データ';
    $('dataContextText').textContent='企業の実データを含まない、動作確認用のデモです。';
  }
  const entries=[['スペース一覧',result.tables['spaces.csv'].records],['予約記録',result.tables['reservations.csv'].records],['会議分類',result.tables['reservations_classified_mapping.csv'].records],['データ対象期間',`${meta.coverage.start} ～ ${meta.coverage.end}`]];
  $('stats').innerHTML=entries.map(([label,value])=>`<span class="${typeof value==='string'?'coverage':''}">${label}<strong>${escape(typeof value==='number'?value.toLocaleString():value)}</strong></span>`).join('');
  $('warnings').innerHTML=meta.warnings.map(w=>`<li>${escape(w)}</li>`).join('');
  $('connection').textContent='MCP 接続済み';
  document.querySelector('.connection').dataset.state='ready';
  for (const id of ['start','end']) { $(id).min=meta.coverage.start; $(id).max=meta.coverage.end; }
  $('start').value = $('start').value < meta.coverage.start ? meta.coverage.start : $('start').value;
  $('end').value = $('end').value > meta.coverage.end ? meta.coverage.end : $('end').value;
  if ($('start').value > $('end').value) { $('start').value=meta.coverage.start; $('end').value=meta.coverage.end; }
  await execute();
} catch(error){$('connection').textContent='接続に失敗しました';document.querySelector('.connection').dataset.state='error';$('summary').textContent=error.message;}
