import { errorKey } from './ui-i18n.js';

const escapeReport=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Shared presentation for the allocation-only and combined administrator reports.
export function suggestionView(card,t){
  if(card.kind==='allocation'){
    const f=card.finding,range=f.planned_people_range;
    return {name:f.name,title:f.name+' / '+t('improvementFinding'),source:t('improvementSimulation'),
      action:t('suggestionStep_'+(card.recommendation??(f.action==='review_allocation'?'guide_smaller_rooms':'review_constraints'))),
      facts:[t('suggestionCapacity')+': '+f.capacity,
        ...(range?[t('suggestionPlanned')+': '+(range.min===range.max?range.min:range.min+'–'+range.max)]:[]),
        t('suggestionCount')+': '+f.oversized_count+' / '+f.total,
        t('suggestionAlternatives')+': '+f.alternative_count+' / '+f.oversized_count],
      limits:t('suggestionAllocationLimits')};
  }
  const name=card.evidence[0].space_name??t('equipmentUnmapped');
  return {name,title:name+' / '+t('equipmentIssue_'+card.issue),source:t('equipmentSource'),
    action:t('equipmentAdvice_'+card.issue),facts:[card.reason],limits:t('equipmentUnknown')};
}
export function suggestionText(card,t){
  const view=suggestionView(card,t);
  return view.title+'\n'+view.source+'\n\n'+t('suggestionAction')+'\n'+view.action+'\n\n'+t('suggestionBasis')+'\n'+view.facts.join('\n')+'\n\n'+t('suggestionLimits')+'\n'+view.limits;
}
export function renderSuggestionBoard(cards,page,t,{evidenceAttribute,detailAttribute,identity=index=>index,emptyText}={}){
  const selected=cards[page],esc=escapeReport;
  if(!selected)return '<p>'+esc(emptyText??t('improvementUnifiedEmpty'))+'</p>';
  const v=suggestionView(selected,t),id=esc(identity(page));
  return '<div class="suggestionWorkspace"><nav class="suggestionList" aria-label="'+esc(t('suggestionList'))+'">'
    +cards.map((card,index)=>{const view=suggestionView(card,t);return '<button type="button" data-suggestion-select="'+index+'" aria-pressed="'+(index===page)+'" class="suggestionChoice'+(index===page?' selected':'')+'"><strong>'+esc(view.name)+'</strong><span>'+esc(t(card.kind==='allocation'?'improvementScopeAllocation':'improvementScopeEquipment'))+'</span></button>';}).join('')
    +'</nav><article class="suggestionDetail" aria-label="'+esc(v.title)+'"><header><h3>'+esc(v.title)+'</h3><span class="small">'+esc(v.source)+'</span></header>'
    +'<section class="suggestionAction"><h4>'+esc(t('suggestionAction'))+'</h4><p>'+esc(v.action)+'</p></section>'
    +'<section class="suggestionBasis"><h4>'+esc(t('suggestionBasis'))+'</h4><ul>'+v.facts.map(f=>'<li>'+esc(f)+'</li>').join('')+'</ul></section>'
    +'<section class="suggestionLimits"><h4>'+esc(t('suggestionLimits'))+'</h4><p>'+esc(v.limits)+'</p></section>'
    +'<div class="suggestionButtons"><button type="button" '+detailAttribute+'="'+id+'">'+esc(t('suggestionDetails'))+'</button><button type="button" '+evidenceAttribute+'="'+id+'">'+esc(t(selected.kind==='allocation'?'improvementEvidence':'equipmentEvidence'))+'</button></div></article></div>';
}

// Local source preview is separate from paid Agent analysis. No credentials persisted.
export function createEquipmentFeedbackUI({document,api,perform,getText,getLocale,isActive,isBusy,session,tell,showEvidence,clearEvidence,getWorkspace=()=>null,isCompact=()=>false}) {
  const $=id=>document.getElementById(id),t=key=>getText()(key);
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let source=null,preview=null,report=null,page=0,mode='source',generation=0,running=false,reportLocale=null;
  let wasStale=false,failure=null,reportFilter='all',settingsExpanded=false;
  const scope=()=>$('improvementScope').value||'equipment';
  const combined=()=>scope()==='combined';
  const allocationPeriod=()=>({start_date:$('improvementStart').value,end_date:$('improvementEnd').value});
  const stale=()=>!!report?.allocation&&(report.revision!==getWorkspace()?.revision||report.instance_id!==getWorkspace()?.instance_id);
  const allCards=()=>report?[...(report.allocation?.draft.items??[]).map(item=>({...item,kind:'allocation',recommendation:report.allocation.draft.recommendations?.[item.finding_id],finding:report.allocation.analysis.items.find(f=>f.finding_id===item.finding_id)})),...report.items.map(item=>({...item,kind:'equipment'}))]:[];
  const cards=()=>allCards().filter(card=>reportFilter==='all'||card.kind===reportFilter);
  const period=()=>({start_date:$('equipmentStart').value,end_date:$('equipmentEnd').value});
  const periodText=scope=>scope.start_date+' → '+scope.end_date;
  const previewSize=()=>Math.max(1,Math.min(10,Math.floor(($('adminResults').clientHeight-110)/44)));
    function clear(){generation++;report=null;failure=null;reportLocale=null;mode='source';page=0;wasStale=false;reportFilter='all';clearEvidence();$('equipmentConsent').checked=false;render();}
  function scopeChanged(){clear();preview=null;page=0;render();}
  function sourceText(record){
    return [t('equipmentSource')+' / '+(record.space_name??t('equipmentUnmapped')),record.date,
      t('equipmentOriginal')+':\n'+record.comment,
      t('equipmentScore')+': '+(record.score??'—')+' / '+(record.question_group??'—'),t('equipmentQuestionUnknown'),
      record.source.file+' / '+t('equipmentSourceRow')+' '+record.source.logical_record_including_header,
      t('equipmentUnknown')].join('\n\n');
  }
  function render(){
    $('equipmentForm').hidden=!isActive();
    if(!isActive())return;
    $('adminView').classList.toggle('improvementReportReady',!!report);
    $('adminView').classList.toggle('improvementSettingsOpen',settingsExpanded&&(isCompact()||!!report));
    $('improvementOptions').textContent=t(settingsExpanded?'improvementBackToReport':'improvementOptions');
    $('improvementOptions').setAttribute('aria-expanded',String(settingsExpanded));
    $('improvementOptions').disabled=isBusy();
    const ready=source?.source==='enterprise_feedback' && source.records>0;
    const isStale=stale();if(isStale&&!wasStale)clearEvidence();wasStale=isStale;
    $('adminDescription').textContent=t('improvementUnifiedDescription');
    $('equipmentAnalyze').textContent=t(running?'improvementRunning':'improvementAnalyze');
    for(const id of ['equipmentStart','equipmentEnd','equipmentPreview','equipmentConsent','equipmentAnalyze'])$(id).disabled=isBusy()||!ready;
    const unavailable=source?.source==='enterprise_feedback'?'equipmentNoComments':source?.source==='error'?'equipment_read_error':'equipment_unavailable';
    $('equipmentRunStatus').textContent=t(running?'equipmentWorking':ready?'equipmentSendNotice':unavailable);
    const metrics=ready?[[t('equipmentSourceRows'),source.source_rows],[t('equipmentComments'),source.records],
      ...(report?[[t('equipmentRead'),report.reviewed_comments],[t('improvementUnifiedCandidates'),allCards().length]]:[])]:[];
    $('adminMetrics').hidden=!metrics.length;
    $('adminMetrics').innerHTML=metrics.map(([label,value])=>'<div class="metric"><span>'+esc(label)+'</span><b>'+esc(value)+'</b></div>').join('');
    $('adminTrace').textContent=t('agentTrace');$('adminTrace').disabled=!report&&!failure;
    const pages=mode==='failure'?1:mode==='report'?Math.max(1,cards().length):Math.max(1,Math.ceil((preview?.total??0)/(preview?.page_size??previewSize())));
    page=Math.max(0,Math.min(page,pages-1));
    $('adminPrevious').disabled=isBusy()||page===0;$('adminNext').disabled=isBusy()||page===pages-1;
    $('adminPage').textContent=(page+1)+' / '+pages;
    if(!ready){$('adminResults').innerHTML='<p class="small">'+esc(t(unavailable))+'</p>';return;}
    const tabs='<div class="row equipmentModes"><button type="button" data-equipment-mode="source" class="'+(mode==='source'?'active':'')+'">'+esc(t('equipmentSourceView'))+'</button><button type="button" data-equipment-mode="report" '+(!report?'disabled':'')+' class="'+(mode==='report'?'active':'')+'">'+esc(t('improvementUnifiedReport'))+'</button>'
      +(failure?'<button data-equipment-mode="failure" class="'+(mode==='failure'?'active':'')+'">'+esc(t('agentFailureDetails'))+'</button>':'')
      +(mode==='report'&&report?'<button data-equipment-summary="true">'+esc(t('suggestionOverview'))+'</button>'+(combined()?'<label class="suggestionFilter">'+esc(t('suggestionFilter'))+'<select id="improvementReportFilter" data-improvement-filter="true" aria-label="'+esc(t('suggestionFilter'))+'">'+[['all','suggestionShowAll'],['allocation','improvementScopeAllocation'],['equipment','improvementScopeEquipment']].map(([value,key])=>'<option value="'+value+'" '+(reportFilter===value?'selected':'')+'>'+esc(t(key))+'</option>').join('')+'</select></label>':''):'')+'</div>';
    if(mode==='failure'&&failure){
      const reason=failure.validation?.reason;
      $('adminResults').innerHTML=tabs+'<article class="agentFailure"><h3>'+esc(t('improvementFailed'))+'</h3><p>'+esc(t(reason?'agentValidation_'+reason:failure.error))+'</p><p class="small">'+esc(t('agentNoAutomaticRetry'))+'</p><button data-equipment-failure="true">'+esc(t('agentFailureDetails'))+'</button></article>';
      return;
    }
    if(mode==='source'){
      $('adminResults').innerHTML=tabs+(preview?'<p class="small equipmentScope">'+esc(periodText(preview.period)+' / '+preview.total+' '+t('equipmentComments'))+'</p><table><thead><tr><th>'+esc(t('date'))+'</th><th>'+esc(t('room'))+'</th><th>'+esc(t('equipmentOriginal'))+'</th><th>'+esc(t('details'))+'</th></tr></thead><tbody>'
        +preview.items.map((record,index)=>'<tr><td>'+esc(record.date)+'</td><td>'+esc(record.space_name??t('equipmentUnmapped'))+'</td><td title="'+esc(record.comment)+'">'+esc(record.comment)+'</td><td><button data-equipment-source="'+index+'">'+esc(t('view'))+'</button></td></tr>').join('')+'</tbody></table>'
        :'<p class="small">'+esc(t('equipmentPreviewHint'))+'</p>');
      return;
    }
    if(!report){$('adminResults').innerHTML=tabs+'<p role="status">'+esc(t(running?'equipmentWorking':'equipmentPreviewHint'))+'</p>';return;}
    const shown=cards(),total=allCards().length;
    const count='<div class="suggestionCount" role="status">'+esc(t('suggestionShowing')+' '+shown.length+' / '+total)
      +(reportFilter!=='all'?' <span>'+esc(t('suggestionHidden')+' '+(total-shown.length))+'</span><button type="button" data-suggestion-reset="true">'+esc(t('suggestionShowAll'))+'</button>':'')+'</div>';
    const scopeText=t('improvementScopeEquipment')+': '+periodText(report.period)
      +(report.allocation?' / '+t('improvementScopeAllocation')+': '+periodText(report.allocation.analysis.period):'');
    $('adminResults').innerHTML=tabs+count+(isStale?'<div class="improvementWarning" role="status">'+esc(t('improvementStale'))+'</div>':'')
      +(reportLocale!==getLocale()?'<p class="staleNotice">'+esc(t('suggestionOriginalLanguage'))+'</p>':'')
      +'<p class="small suggestionPeriod">'+esc(scopeText)+'</p>'
      +renderSuggestionBoard(shown,page,t,{evidenceAttribute:'data-equipment-evidence',detailAttribute:'data-equipment-detail',emptyText:t(combined()?'improvementUnifiedEmpty':'equipmentNone')});
  }
  async function load(){
    const current=++generation;
    const result=await api('equipment/status');
    if(current!==generation||!isActive())return;
    if(source?.version!==result.version){clearEvidence();report=null;failure=null;preview=null;page=0;mode='source';$('equipmentConsent').checked=false;}
    source=result;
    if(result.coverage){
      for(const id of ['equipmentStart','equipmentEnd']){$(id).min=result.coverage.start;$(id).max=result.coverage.end;}
      if(!$('equipmentStart').value)$('equipmentStart').value=result.coverage.start;
      if(!$('equipmentEnd').value)$('equipmentEnd').value=result.coverage.end;
    }
    render();
    if(result.source==='enterprise_feedback' && result.records)await browse();
  }
  async function browse(nextPage=0){
    const current=++generation,scope=period();
    const size=preview?.page_size??previewSize();
    const result=await api('equipment/comments?'+new URLSearchParams({...scope,offset:nextPage*size,limit:size}));
    if(current!==generation||!isActive())return;
    if(result.version!==source?.version)throw new Error('equipment_changed');
    preview={...result,page_size:size};page=nextPage;mode='source';settingsExpanded=false;render();if(!failure)tell('equipmentLocalPreview');
  }
  async function analyze(){
    if(!session.configured){$('settingsDialog').showModal();tell('api_key_missing',true);return;}
    if(!$('equipmentConsent').checked){settingsExpanded=true;render();throw new Error('equipment_consent');}
    if(combined()&&(!allocationPeriod().start_date||!allocationPeriod().end_date||allocationPeriod().start_date>allocationPeriod().end_date))throw new Error('improvementPeriod');
    const current=++generation,auth=session.begin('Equipment feedback investigation');
    const language=getLocale(),snapshot=getWorkspace();
    report=null;failure=null;clearEvidence();running=true;render();tell('equipmentWorking');
    try{
      const result=await api('improvements',{body:{scope:scope(),...period(),version:source.version,model:session.model,locale:language,confirmed:true,
        revision:snapshot.revision,instance_id:snapshot.instance_id,...(combined()?{allocation_period:allocationPeriod()}:{} )},headers:auth.headers,signal:auth.signal,timeoutMs:115000});
      if(current!==generation||!isActive())return;
      if(combined()&&(result.revision!==getWorkspace().revision||result.instance_id!==getWorkspace().instance_id))throw new Error('state_changed');
      report=result;reportLocale=language;mode='report';page=0;reportFilter='all';settingsExpanded=false;tell('improvementDone');
    }catch(error){
      if(current!==generation||!isActive())return;
      failure={...error.diagnostics?.agent,period:period(),...(combined()?{allocation_period:allocationPeriod()}:{}),error:errorKey(error)};
      mode='failure';page=0;throw error;
    }
    finally{running=false;render();}
  }
  function trace(){const result=report??failure;if(!result)return;
    const validation=result.validation;
    const diagnosis=validation?[t('agentFailureDetails')+': '+t('agentValidation_'+validation.reason),
      ...(validation.field?[t('agentValidationField')+': '+validation.field]:[]),
      ...(validation.expected_count!==undefined?[t('agentExpectedCount')+': '+validation.expected_count+' / '+t('agentActualCount')+': '+validation.actual_count]:[])].join('\n'):result.error?t(result.error):'';
    showEvidence(t('agentTrace'),(stale()?t('improvementStale')+'\n\n':'')+periodText(result.period)+(result.allocation_period?'\n'+t('improvementSimulation')+': '+periodText(result.allocation_period):'')+'\n\n'+diagnosis+'\n\n'+(result.trace??[]).map((step,index)=>(index+1)+'. '+step.name+' '+JSON.stringify(step.arguments)+' / '+t(step.is_error?'agentToolFailed':'agentToolSucceeded')+(step.error_code?' / '+t('agentReason_'+step.error_code):'')).join('\n\n')+'\n\n'+t('agentModel')+': '+(result.model??session.model)+'\n'+t('agentTokens')+': '+(result.usage?.input_tokens??0)+' / '+(result.usage?.output_tokens??0));
  }
  $('improvementOptions').addEventListener('click',()=>{settingsExpanded=!settingsExpanded;render();});
  $('equipmentForm').addEventListener('submit',event=>{event.preventDefault();perform(analyze);});
  $('equipmentPreview').addEventListener('click',()=>perform(()=>browse()));
  for(const id of ['equipmentStart','equipmentEnd'])$(id).addEventListener('change',scopeChanged);
  $('adminResults').addEventListener('change',event=>{
    if(!isActive()||event.target.dataset.improvementFilter===undefined)return;
    reportFilter=event.target.value;page=0;clearEvidence();render();
  });
  $('adminResults').addEventListener('click',event=>{
    if(!isActive())return;
    const button=event.target.closest('[data-equipment-source],[data-equipment-evidence],[data-equipment-mode],[data-equipment-summary],[data-equipment-failure],[data-equipment-detail],[data-suggestion-select],[data-suggestion-reset]');
    if(!button)return;
    if(button.dataset.suggestionSelect!==undefined){const next=Number(button.dataset.suggestionSelect);if(Number.isInteger(next)&&cards()[next]){page=next;clearEvidence();render();document.querySelector('[data-suggestion-select="'+page+'"]')?.focus?.();}return;}
    if(button.dataset.suggestionReset){reportFilter='all';page=0;clearEvidence();render();return;}
    if(button.dataset.equipmentDetail!==undefined){const card=cards()[Number(button.dataset.equipmentDetail)];if(card)showEvidence(t('suggestionDetails'),(stale()?t('improvementStale')+'\n\n':'')+suggestionText(card,t));return;}
    if(button.dataset.equipmentFailure){trace();return;}
    if(button.dataset.equipmentMode){mode=button.dataset.equipmentMode;if(mode==='source')perform(()=>browse());else{page=0;render();}return;}
    if(button.dataset.equipmentSummary&&report){
      showEvidence(t('improvementUnifiedReport'),(stale()?t('improvementStale')+'\n\n':'')+report.summary+'\n\n'+t('improvementScopeEquipment')+': '+periodText(report.period)+' / '+t('equipmentHistorical')+'\n'+t('equipmentRead')+': '+report.reviewed_comments
        +(report.allocation?'\n\n'+t('improvementScopeAllocation')+': '+periodText(report.allocation.analysis.period)+' / '+t('improvementSimulation')+'\n'+t('improvementEligible')+': '+report.allocation.analysis.eligible_count+'\n'+t('improvementExcluded')+': '+Object.values(report.allocation.analysis.excluded).reduce((sum,n)=>sum+n,0)+'\n'+t(report.allocation.analysis.status==='insufficient_data'?'improvementInsufficient':report.allocation.analysis.status==='no_obvious_issue'?'improvementNoIssue':'improvementReviewRooms'):'')+'\n\n'+allCards().map(card=>suggestionText(card,t)).join('\n\n────────\n\n')+'\n\n'+t('improvementSourceBoundary')+'\n'+t('equipmentUnknown'));return;
    }
    const item=button.dataset.equipmentSource;
    if(item!==undefined && preview?.items[Number(item)]){showEvidence(t('equipmentOriginal'),sourceText(preview.items[Number(item)]));return;}
    const card=cards()[Number(button.dataset.equipmentEvidence)];
    if(card){
      const prefix=(stale()?t('improvementStale')+'\n\n':'')+report.summary+'\n\n';
      if(card.kind==='allocation'){
        const finding=card.finding;
        showEvidence(t('improvementEvidence'),prefix+t('improvementSimulation')+'\n'+periodText(report.allocation.analysis.period)+'\n\n'+finding.name+' / '+finding.capacity+'\n'+card.note+'\n\n'
          +finding.oversized_count+' / '+finding.total+' '+t('improvementBookings')+'\n'+t('improvementAlternative')+': '+finding.alternative_count+'\n\n'
          +finding.evidence.filter(e=>card.evidence_ids.includes(e.reservation_id)).map(e=>e.date+' / '+String(Math.floor(e.start/60)).padStart(2,'0')+':'+String(e.start%60).padStart(2,'0')+'–'+String(Math.floor(e.end/60)).padStart(2,'0')+':'+String(e.end%60).padStart(2,'0')+' / '+e.reservation_id+'\n'+e.people+' '+t('people')+' / '+e.features.map(f=>t(f)).join(', ')+'\n'+t('improvementAlternative')+': '+(e.alternatives.map(r=>r.name+' ('+r.capacity+')').join(', ')||t('improvement_'+e.alternative_status))).join('\n\n')+'\n\n'+t('improvementLimits'));
      }else showEvidence(t('equipmentEvidence'),prefix+periodText(report.period)+'\n\n'+card.reason+'\n\n'+t('equipmentAdvice_'+card.issue)+'\n\n'+card.evidence.map(sourceText).join('\n\n────────\n\n'));
    }
  });
  return {render,load,clear,isActive,leave:()=>{generation++;clearEvidence();$('adminView').classList.toggle('improvementReportReady',false);$('adminView').classList.toggle('improvementSettingsOpen',false);settingsExpanded=false;},languageChanged:clearEvidence,
    resize:()=>{if(isActive()&&!isBusy()&&mode==='source'&&preview&&preview.page_size!==previewSize()){preview=null;perform(()=>browse());}},
    next:direction=>{if(mode==='report'){page+=direction;render();}else perform(()=>browse(page+direction));},trace};
}
