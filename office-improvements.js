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
      total:records.length, oversized_count:oversized.length, oversized_percent:Math.round(oversized.length / records.length * 100),
      alternative_count:alternativeCount, action:alternativeCount ? 'review_allocation' : 'investigate_constraints',
      evidence_total:evidence.length, evidence:evidence.slice(0,10)});
  }
  items.sort((a,b) => b.alternative_count-a.alternative_count || b.oversized_count-a.oversized_count || a.room_id.localeCompare(b.room_id));
  return {status:eligible.length < rule.min_room_reservations ? 'insufficient_data' : items.length ? 'review' : 'no_obvious_issue',
    period, rule, total_records:reservations.filter(within).length, eligible_count:eligible.length, excluded,
    review_count:items.length, items, simulation:true, scope:'current_workspace', metric:'planned_people_vs_registered_capacity',
    limitations:['Simulation only; equipment attributes are demo settings.', 'Headcounts and time intervals describe reservations, not actual occupancy.',
      'This trial rule is not an enterprise-approved benchmark. No finding is not proof of optimal allocation.',
      'At most 10 evidence records per room are returned; counts and alternative checks cover all eligible records.',
      'Unmet demand, procurement needs, room construction and layout changes cannot be inferred. No booking is modified.']};
}

export function validateImprovementDraft(value, analysis) {
  if (!value || Object.keys(value).length !== 1 || !Array.isArray(value.items) || value.items.length !== analysis.items.length) throw new Error('model_output');
  const seen = new Set();
  for (const card of value.items) {
    const finding = analysis.items.find(item => item.finding_id === card?.finding_id);
    if (!finding || seen.has(card.finding_id) || Object.keys(card).sort().join(',') !== 'action,evidence_ids,finding_id,note'
      || card.action !== finding.action || !Array.isArray(card.evidence_ids) || !card.evidence_ids.length || card.evidence_ids.length > 3
      || new Set(card.evidence_ids).size !== card.evidence_ids.length
      || card.evidence_ids.some(id => !finding.evidence.some(record => record.reservation_id === id))
      || typeof card.note !== 'string' || !card.note.trim() || card.note.length > 400) throw new Error('model_output');
    seen.add(card.finding_id);
  }
  return value;
}
