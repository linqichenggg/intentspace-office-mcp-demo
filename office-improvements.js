// Reservation-fit analysis only. Planned headcounts are not measured occupancy.
export function analyzeRoomFit({rooms, reservations}, period) {
  const rule = {min_room_reservations:3, min_oversized:3, min_oversized_percent:50, max_people:4, min_capacity:8, max_capacity_ratio:0.5};
  const inventory = new Map(rooms.map(room => [room.id, room]));
  const excluded = {deleted:0, cancelled:0, attendance:0, preset:0, desk:0, invalid:0, duplicate:0};
  const eligible = [], seen = new Set();
  const within = record => record.date >= period.start_date && record.date <= period.end_date;
  for (const record of reservations.filter(within)) {
    const room = inventory.get(record.space_id);
    const reason = record.deleted ? 'deleted' : record.status === 'cancelled' ? 'cancelled'
      : record.source === 'attendance' ? 'attendance' : record.source === 'preset' ? 'preset'
      : room?.kind === 'desk' ? 'desk' : seen.has(record.id) ? 'duplicate'
      : !room || room.kind !== 'meeting' || !Number.isInteger(room.capacity) || room.capacity < 1
        || !Number.isInteger(record.people) || record.people < 1 || record.people > room.capacity
        || !Number.isFinite(record.start) || !Number.isFinite(record.end) || record.start >= record.end
        || !['reserved','in_progress','completed'].includes(record.status)
        || !Array.isArray(record.request?.features) ? 'invalid' : null;
    if (reason) { excluded[reason]++; continue; }
    seen.add(record.id); eligible.push(record);
  }
  // Presets still block alternative rooms, although their placeholder headcounts are excluded above.
  const calendar = reservations.filter(record => !record.deleted && record.status !== 'cancelled' && record.source !== 'attendance');
  const items = [];
  for (const room of rooms.filter(room => room.kind === 'meeting' && room.capacity >= rule.min_capacity)) {
    const records = eligible.filter(record => record.space_id === room.id);
    const oversized = records.filter(record => record.people <= rule.max_people && record.people / room.capacity <= rule.max_capacity_ratio);
    if (records.length < rule.min_room_reservations || oversized.length < rule.min_oversized
      || oversized.length * 100 < records.length * rule.min_oversized_percent) continue;
    const evidence = oversized.map(record => {
      const smaller = rooms.filter(candidate => candidate.kind === 'meeting' && candidate.capacity >= record.people && candidate.capacity < room.capacity
        && record.request.features.every(feature => candidate.features?.includes(feature)));
      const alternatives = smaller.filter(candidate => !calendar.some(other => other.id !== record.id && other.space_id === candidate.id
        && other.date === record.date && record.start < other.end && other.start < record.end));
      return {reservation_id:record.id, date:record.date, start:record.start, end:record.end, people:record.people,
        features:[...record.request.features], alternatives:alternatives.map(candidate => ({id:candidate.id,name:candidate.name,capacity:candidate.capacity})),
        alternative_status:alternatives.length ? 'available' : smaller.length ? 'blocked' : 'no_compatible_room'};
    });
    const alternativeCount = evidence.filter(record => record.alternatives.length).length;
    items.push({finding_id:'room-fit:'+room.id, room_id:room.id, name:room.name, capacity:room.capacity,
      finding_type:'small_party_in_large_room',capacity_relation:'planned_people_below_capacity',
      planned_people_range:{min:Math.min(...oversized.map(record=>record.people)),max:Math.max(...oversized.map(record=>record.people))},
      total:records.length, oversized_count:oversized.length, oversized_percent:Math.round(oversized.length / records.length * 100),
      alternative_count:alternativeCount, action:alternativeCount ? 'review_allocation' : 'investigate_constraints',
      evidence_total:evidence.length, evidence:evidence.slice(0,10)});
  }
  items.sort((a,b) => b.alternative_count-a.alternative_count || b.oversized_count-a.oversized_count || a.room_id.localeCompare(b.room_id));
  return {status:eligible.length < rule.min_room_reservations ? 'insufficient_data' : items.length ? 'review' : 'no_obvious_issue',
    period, rule, total_records:reservations.filter(within).length, eligible_count:eligible.length, excluded,
    review_count:items.length, items, simulation:true, scope:'current_workspace', metric:'planned_people_vs_registered_capacity',
    meaning:allocationMeaning,
    limitations:['Simulation only; equipment attributes are demo settings.', 'Headcounts and time intervals describe reservations, not actual occupancy.',
      'This trial rule is not an enterprise-approved benchmark. No finding is not proof of optimal allocation.',
      'At most 10 evidence records per room are returned; counts and alternative checks cover all eligible records.',
      'Unmet demand, procurement needs, room construction and layout changes cannot be inferred. No booking is modified.']};
}

// The Agent selects a supported next step. Numeric claims are rendered from MCP facts.
export const allocationMeaning='small_party_in_large_room means room capacity exceeds the planned party size. It NEVER means too many people for the room. Over-capacity bookings are excluded. Planned headcount is not actual attendance.';
export function allocationSelectionSchema(analysis,verifiedIds){
  if(!analysis.items.length)return {type:'object',additionalProperties:false,properties:{},required:[]};
  return {type:'object',additionalProperties:false,properties:Object.fromEntries(analysis.items.map(finding=>{
    const evidence=finding.evidence.filter(e=>verifiedIds.has(e.reservation_id));
    const choices=['confirm_requirements'];
    if(evidence.some(e=>e.alternatives.length))choices.push('guide_smaller_rooms');
    if(evidence.some(e=>!e.alternatives.length))choices.push('review_constraints');
    return [finding.finding_id,{type:'object',additionalProperties:false,properties:{
      evidence_ids:{type:'array',minItems:1,maxItems:3,items:{type:'string',enum:evidence.map(e=>e.reservation_id)}},
      recommendation:{type:'string',enum:choices,description:'Select the administrator next step supported by the independently checked evidence. Do not generate factual prose.'}
    },required:['evidence_ids','recommendation']}];
  })),required:analysis.items.map(f=>f.finding_id)};
}

export function allocationSummary(analysis,locale='ja'){
  return locale==='en'
    ?`Simulated bookings only. ${analysis.eligible_count} bookings analyzed; ${analysis.items.length} room-allocation review candidates. Findings concern room capacity exceeding the planned party size; planned headcount is not measured occupancy.`
    :`模擬予約${analysis.eligible_count}件を分析し、配分の確認候補は${analysis.items.length}室です。対象は少人数で大きい会議室を使う予約です。予定人数を比較しており、実際の在室人数ではありません。`;
}

function allocationExplanation(finding,recommendation,locale){
  const range=finding.planned_people_range;
  const people=range?(range.min===range.max?String(range.min):range.min+'–'+range.max):null;
  const steps=locale==='en'?{
    guide_smaller_rooms:'Review guiding these meetings to the compatible smaller rooms shown in the evidence.',
    review_constraints:'Check the recorded blocked time slots or unmet room requirements before changing allocation.',
    confirm_requirements:'Confirm the meeting requirements with employees before adjusting allocation.'
  }:{
    guide_smaller_rooms:'根拠にある条件適合の小会議室へ案内できるか確認してください。',
    review_constraints:'配分を変える前に、根拠にある重複時間帯・必須条件を確認してください。',
    confirm_requirements:'配分を変える前に、社員の会議条件を確認してください。'
  };
  const facts=locale==='en'
    ?`${finding.name}: capacity ${finding.capacity}; ${finding.oversized_count} small-party bookings${people?', planned '+people+' people':''}. Planned headcounts are below capacity. A compatible smaller room was available for ${finding.alternative_count} of these bookings.`
    :`${finding.name}は定員${finding.capacity}人。少人数条件の${finding.oversized_count}件${people?'は予定'+people+'人':''}で、予定人数は定員を下回ります。このうち${finding.alternative_count}件で、同時間帯に条件に合う小会議室の空きがありました。`;
  return steps[recommendation]+' '+facts;
}

export function groundAllocationSelection(selection,analysis,locale='ja'){
  const reject=(reason,field,details={})=>{const error=new Error('model_output');error.validation={reason,field,...details};throw error;};
  let cards,recommendations={};
  if(Array.isArray(selection)){
    // Existing response-shaped drafts remain validated, but their free factual prose is never displayed.
    validateImprovementDraft({items:selection},analysis);cards=selection;
    for(const card of cards){
      const finding=analysis.items.find(f=>f.finding_id===card.finding_id),evidence=finding.evidence.filter(e=>card.evidence_ids.includes(e.reservation_id));
      recommendations[card.finding_id]=evidence.some(e=>e.alternatives.length)?'guide_smaller_rooms':'review_constraints';
    }
  }else{
    if(!selection||typeof selection!=='object')reject('allocation_shape','allocation_items');
    const entries=Object.entries(selection);
    if(entries.some(([id])=>!analysis.items.some(f=>f.finding_id===id)))reject('allocation_unknown_finding','allocation_items');
    if(entries.length!==analysis.items.length)reject('allocation_count','allocation_items',{expected_count:analysis.items.length,actual_count:entries.length});
    cards=entries.map(([id,item],index)=>{
      const field='allocation_items.'+index;
      if(!item||Object.keys(item).sort().join(',')!=='evidence_ids,recommendation')reject('allocation_shape',field);
      const finding=analysis.items.find(f=>f.finding_id===id);
      const canonical={finding_id:id,action:finding.action,evidence_ids:item.evidence_ids,note:'Selection received.'};
      try{validateImprovementDraft({items:[canonical]}, {...analysis,items:[finding]});}
      catch(error){if(error.validation?.field)error.validation.field=error.validation.field.replace(/^allocation_items\.0/,field);throw error;}
      const evidence=finding.evidence.filter(e=>item.evidence_ids.includes(e.reservation_id));
      if(!['confirm_requirements','guide_smaller_rooms','review_constraints'].includes(item.recommendation)
        ||item.recommendation==='guide_smaller_rooms'&&!evidence.some(e=>e.alternatives.length)
        ||item.recommendation==='review_constraints'&&!evidence.some(e=>!e.alternatives.length))reject('allocation_recommendation',field+'.recommendation');
      recommendations[id]=item.recommendation;return canonical;
    });
  }
  return {summary:allocationSummary(analysis,locale),items:cards.map(card=>({...card,note:allocationExplanation(analysis.items.find(f=>f.finding_id===card.finding_id),recommendations[card.finding_id],locale)})),
    recommendations,note_source:'verified_mcp_facts_and_agent_selection'};
}

export function validateImprovementDraft(value, analysis) {
  const reject=(reason,field,details={})=>{const error=new Error('model_output');error.validation={reason,field,...details};throw error;};
  if (!value || Object.keys(value).length !== 1 || !Array.isArray(value.items))reject('allocation_shape','allocation_items');
  if(value.items.length!==analysis.items.length)reject('allocation_count','allocation_items',{expected_count:analysis.items.length,actual_count:value.items.length});
  const seen = new Set();
  for (const [index,card] of value.items.entries()) {
    const field='allocation_items.'+index;
    if(!card||Object.keys(card).sort().join(',')!=='action,evidence_ids,finding_id,note')reject('allocation_shape',field);
    const finding = analysis.items.find(item => item.finding_id === card?.finding_id);
    if(!finding)reject('allocation_unknown_finding',field+'.finding_id');
    if(seen.has(card.finding_id))reject('allocation_duplicate_finding',field+'.finding_id');
    if(card.action!==finding.action)reject('allocation_action',field+'.action');
    if(!Array.isArray(card.evidence_ids)||!card.evidence_ids.length||card.evidence_ids.length>3||new Set(card.evidence_ids).size!==card.evidence_ids.length)reject('allocation_reference_count',field+'.evidence_ids');
    if(card.evidence_ids.some(id=>!finding.evidence.some(record=>record.reservation_id===id)))reject('allocation_unknown_reference',field+'.evidence_ids');
    if(typeof card.note!=='string'||!card.note.trim()||card.note.length>400)reject('allocation_note',field+'.note');
    seen.add(card.finding_id);
  }
  return value;
}
