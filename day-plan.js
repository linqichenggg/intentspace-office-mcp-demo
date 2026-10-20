import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from './http-utils.js';

export const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
export const clock = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
export const overlap = (a, b) => a.date === b.date && a.start < b.end && b.start < a.end;
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable();
export const activitySchema = z.object({
  type: z.enum(['meeting', 'focus', 'unavailable']), title: z.string().min(1).max(160),
  date: z.string().refine(validDate), time, window_start: time, window_end: time,
  duration: z.number().int().min(15).max(480).nullable(), people: z.number().int().min(1).max(100).nullable(),
  features: z.array(z.string().min(1).max(60)).max(12), participants: z.array(z.string().min(1).max(60)).max(20),
  existing_id: z.string().max(100).nullable(), unclear: z.array(z.string().max(240)).max(10)
}).strict();
export const dayPlanSchema = z.object({activities: z.array(activitySchema).max(12), questions: z.array(z.string().max(300)).max(12)}).strict();

export const gptUncertaintyFields = ['date','time','duration','people','features','constraints'];
const gptActivitySchema = activitySchema.omit({unclear:true}).extend({
  uncertainties:z.array(z.object({field:z.enum(gptUncertaintyFields),evidence:z.string().trim().min(1).max(240)}).strict()).max(6)
}).strict();
const gptExtractionSchema = z.object({
  input_status:z.enum(['supported','unsupported_language','not_a_plan']),
  activities:z.array(gptActivitySchema).max(12)
}).strict();

// GPT extracts facts and grounded ambiguity codes, never dialogue or booking commands.
// Keep the internal plan contract unchanged for rules, editors and saved proposals.
export function validateGptExtraction(value,{message,today,existing=[]}) {
  const parsed=gptExtractionSchema.safeParse(value);
  if(!parsed.success)throw new HttpError(502,'model_output');
  const {input_status,activities:extracted}=parsed.data;
  if(input_status!=='supported'){
    if(extracted.length)throw new HttpError(502,'model_output');
    return {activities:[],questions:[input_status==='unsupported_language'?'language_only':'no_activities']};
  }
  const normalized=value=>value.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
  const source=normalized(message),allowedIds=new Set(existing.filter(r=>r.status!=='cancelled').map(r=>r.id));
  const activities=extracted.map(({uncertainties,...activity})=>{
    const fields=new Set();
    for(const issue of uncertainties){
      if(!source.includes(normalized(issue.evidence)))throw new HttpError(502,'model_output');
      fields.add(issue.field);
    }
    if(fields.has('time')){activity.time=null;activity.window_start=null;activity.window_end=null;}
    if(fields.has('duration'))activity.duration=null;
    if(fields.has('people'))activity.people=null;
    activity.participants=[...new Set(activity.participants.map(name=>name.trim()).filter(name=>name&&source.includes(normalized(name))))];
    if(!allowedIds.has(activity.existing_id))activity.existing_id=null;
    const unclear=[...fields].map(field=>field==='constraints'?'unparsed_constraint':'ambiguous_'+field);
    if(activity.type!=='meeting'&&!activity.time&&activity.window_start&&activity.window_end){
      const duration=minutes(activity.window_end)-minutes(activity.window_start);
      if(activity.duration===null||activity.duration===duration){activity.time=activity.window_start;activity.duration=duration;}
      else unclear.push('unresolved_constraints');
    }
    return {...activity,unclear};
  });
  return validateDayPlan({activities,questions:activities.length?[]:['no_activities']},today);
}

export function validateDayPlan(value, today) {
  const parsed = dayPlanSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'invalid_plan');
  const last = new Date(Date.parse(today) + 30 * 86400000).toISOString().slice(0, 10);
  for (const item of parsed.data.activities) {
    if (item.date < today || item.date > last) throw new HttpError(400, 'date_range');
    if (item.window_start && item.window_end && item.window_start >= item.window_end) throw new HttpError(400, 'invalid_window');
    if (item.time && (minutes(item.time) < 540 || minutes(item.time) >= 1080)) throw new HttpError(400, 'hours');
  }
  return parsed.data;
}

function localTime(source) {
  const result = [];
  const pattern = /(\d{1,2})(?::(\d{2})|時(半|\d{1,2}分)?|\s*(am|pm)\b)/gi;
  for (const match of source.matchAll(pattern)) {
    let hour = Number(match[1]);
    const minute = Number(match[2] ?? (match[3] === '半' ? 30 : match[3]?.replace('分', '') || 0));
    const prefix = source.slice(Math.max(0, match.index - 5), match.index);
    const pm = /pm/i.test(match[4] || '') || /午後/.test(prefix);
    const am = /am/i.test(match[4] || '') || /午前/.test(prefix);
    if (pm && hour < 12) hour += 12;
    if (am && hour === 12) hour = 0;
    if (hour < 24 && minute < 60) result.push(clock(hour * 60 + minute));
  }
  return result;
}

// The offline parser is deliberately bounded; unhandled clauses remain visible for review.
export function parseLocalDayPlan(message, today, locale = 'ja') {
  if (typeof message !== 'string' || !message.trim() || message.length > 4000) throw new HttpError(400, 'input_length');
  const source = message.normalize('NFKC');
  if (/[\u4e00-\u9fff]/.test(source) && /明天|今天|需要|小时|会议室|上午|下午|个人/.test(source)) throw new HttpError(400, 'language_only');
  const dateMatch = source.match(/\b\d{4}-\d{2}-\d{2}\b/);
  const date = dateMatch?.[0] ?? (/明後日|day after tomorrow/i.test(source) ? new Date(Date.parse(today) + 2 * 86400000).toISOString().slice(0,10)
    : /明日|tomorrow/i.test(source) ? new Date(Date.parse(today) + 86400000).toISOString().slice(0,10) : today);
  const clauses = source.split(/\n+|[。;；]+|\.\s+(?=[A-Z])/).map(s => s.trim()).filter(Boolean);
  if (clauses.length > 12) throw new HttpError(400, 'too_many_items');
  const activities = [], questions = [];
  for (const clause of clauses) {
    const times = localTime(clause);
    const type = /別の予定|外出|不在|unavailable|another appointment|away|busy/i.test(clause) ? 'unavailable'
      : /集中|資料作成|個人作業|focus|write|writing|report|documentation/i.test(clause) && !/会議|相談|商談|打合|meeting|discuss|review|sync/i.test(clause) ? 'focus' : 'meeting';
    const morning = /午前|morning/i.test(clause), afternoon = /午後|afternoon/i.test(clause);
    let windowStart = morning ? '09:00' : afternoon ? '13:00' : null;
    let windowEnd = morning ? '12:00' : afternoon ? '18:00' : null;
    const hours = clause.match(/(\d+(?:\.5)?)\s*[-–]?\s*(?:時間|hours?|hrs?)/i);
    const mins = clause.match(/(\d+)\s*[-–]?\s*(?:分(?:間)?|minutes?|mins?)/i);
    let duration = hours ? Number(hours[1]) * 60 : mins ? Number(mins[1]) : null;
    const range = times.length === 2 && /から|まで|〜|～|\bto\b|\buntil\b|\d{2}\s*[-–]\s*\d/.test(clause);
    if (range) duration = minutes(times[1]) - minutes(times[0]);
    let start = times[0] ?? null;
    if (times.length === 1 && /(?:before\s+\d|\d[^\n]*までに)/i.test(clause)) { windowEnd = times[0]; start = null; }
    if (times.length === 1 && /(?:after\s+\d|\d[^\n]*以降)/i.test(clause)) { windowStart = times[0]; start = null; }
    if (type !== 'meeting' && start && !duration && /から|以降|\bfrom\b|\bafter\b/i.test(clause)) duration = 1080 - minutes(start);
    if (type !== 'meeting' && !start && windowStart && windowEnd) { start = windowStart; duration ??= minutes(windowEnd) - minutes(windowStart); }
    const people = clause.match(/(\d+)\s*(?:人|名|people|persons?|participants?)/i);
    const features = [];
    for (const [key, expression] of Object.entries({monitor:/モニター|画面|monitor|screen/i, whiteboard:/ホワイトボード|白板|whiteboard/i,
      quiet:/静か|静音|quiet/i, video:/オンライン|ビデオ会議|video|camera/i, projector:/プロジェクター|projector/i, window:/窓際|window/i})) {
      if (expression.test(clause)) features.push(key);
    }
    for(const match of clause.matchAll(/USB[- ]?C|防音|車椅子|マイク|soundproof|wheelchair|microphone|recording/gi))features.push(match[0]);
    const uncertain = [];
    if (/または|あるいは|\bor\b|できれば|prefer/i.test(clause)) uncertain.push(locale === 'en' ? 'Check optional or alternative conditions.' : '希望条件・選択条件を確認してください。');
    if (/不要|要らない|without|do not|don.t need/i.test(clause)) uncertain.push(locale === 'en' ? 'Check which equipment is not required.' : '不要な設備を確認してください。');
    const known = /会議|相談|商談|打合|ミーティング|meeting|discuss|review|sync|集中|資料作成|個人作業|focus|write|writing|report|documentation|別の予定|外出|不在|unavailable|appointment|away|busy/i.test(clause);
    if (!known) uncertain.push(locale === 'en' ? 'This sentence needs review; use GPT for richer wording.' : '文の意味を確認してください。複雑な表現はGPTで解析できます。');
    activities.push({type, title:clause.slice(0,160), date, time:start, window_start:windowStart, window_end:windowEnd,
      duration, people:people ? Number(people[1]) : type === 'meeting' ? null : 1, features, participants:[], existing_id:null, unclear:uncertain});
  }
  return validateDayPlan({activities, questions}, today);
}

// Free-text model questions are not authoritative required fields. Suppress only
// recognized redundant questions; keep unknown or conflicting requirements for review.
function redundantClarification(question, activities) {
  if (!activities.length) return false;
  const text = question.normalize('NFKC').toLowerCase();
  const parts = text.split(/[。！？!?;\n]+/).map(part => part.trim()).filter(Boolean);
  if (parts.length > 1) return parts.every(part => redundantClarification(part, activities));
  const otherRequirement = /人数|何人|所要|何分|何時間|設備|機材|空き|参加可否|参加可能|権限|本人確認|終了|締切|矛盾|どちら|または|あるいは|曖昧|people|headcount|how many|duration|how long|equipment|availability|available|permission|identity|deadline|end time|conflict|ambig|\bor\b/;
  if (otherRequirement.test(text)) return false;
  const names = /(?:参加者|出席者|参加する人|出席する人|メンバー).*(?:名前|氏名|誰)|(?:名前|氏名).*(?:参加|出席)|誰が(?:参加|出席)|(?:participant|attendee|member)s?['’]?\s*(?:names?|list)|names?\s+of\s+(?:the\s+)?(?:participant|attendee|member)s?|who\s+(?:(?:will|is|are)\s+)?(?:be\s+)?(?:attend(?:ing)?|participat(?:e|ing)|join(?:ing)?)/;
  if (names.test(text)) return true;
  const start = /開始(?:時刻|時間)|何時(?:から|に開始)|(?:(?:exact|specific|precise)\s+)?start(?:ing)?\s+time|what\s+time.*(?:start|begin)/;
  if (!start.test(text)) return false;
  return activities.every(a => a.time || a.window_start && a.window_end);
}

export function normalizeDayPlanClarifications(plan) {
  const activities = plan.activities.map(activity => ({
    ...activity,
    unclear: activity.unclear.filter(question => !redundantClarification(question, [activity]))
  }));
  const questions = plan.questions.filter(question => {
    const text = question.normalize('NFKC').toLowerCase();
    const named = activities.filter(a => text.includes(a.title.normalize('NFKC').toLowerCase()));
    return !redundantClarification(question, named.length ? named : activities);
  });
  return {...plan, activities, questions};
}

export function activityIssues(item) {
  const issues = [...item.unclear];
  if (!item.duration && !issues.includes('ambiguous_duration')) issues.push('missing_duration');
  if (item.type === 'meeting' && !item.people && !issues.includes('ambiguous_people')) issues.push('missing_people');
  if (!item.time && !(item.window_start && item.window_end) && !issues.includes('ambiguous_time')) issues.push('missing_window');
  if (item.time && item.duration && minutes(item.time) + item.duration > 1080) issues.push('hours');
  return issues;
}

export function sameMeeting(activity, record) {
  const normalized = value => value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
  const sameParticipants = JSON.stringify([...activity.participants].sort()) === JSON.stringify([...(record.participants ?? [])].sort());
  const coversTime = activity.time ? activity.time === record.time : activity.window_start && activity.window_end
    && record.time >= activity.window_start && record.end_time <= activity.window_end;
  return record.status !== 'cancelled' && activity.date === record.date && normalized(activity.title) === normalized(record.title)
    && activity.people === record.people && activity.duration === record.request.duration && sameParticipants && coversTime
    && activity.features.every(f=>(record.request.features??[]).includes(f));
}

export async function allocateDayPlan(plan, records, today, recommend, {distinctIndex = -1, kind = 'meeting'} = {}) {
  plan = normalizeDayPlanClarifications(plan);
  const proposals = [], provisional = [];
  const busy = plan.activities.filter(a => a.type !== 'meeting' && a.time && a.duration).map(a => ({date:a.date,start:minutes(a.time),end:minutes(a.time)+a.duration}));
  const unresolved = plan.activities.some(a=>a.type!=='meeting'&&activityIssues(a).length);
  for (const activity of plan.activities) {
    const proposal = {id:randomUUID(), activity, status:'note', issues:activityIssues(activity), candidates:[], trace:[]};
    if (activity.type !== 'meeting') { proposal.status=proposal.issues.length?'needs_input':'note';proposals.push(proposal);continue; }
    const previous=proposals.find(p=>p.status==='proposed'&&sameMeeting(activity,{...p.activity,...p.request,id:p.id,end_time:clock(minutes(p.request.time)+p.request.duration),request:p.request,status:'reserved'}));
    if(previous){proposal.status='duplicate_in_plan';proposal.existing_proposal_id=previous.id;proposals.push(proposal);continue;}
    proposal.distinct = proposals.length === distinctIndex;
    const existing = !proposal.distinct && records.find(r => sameMeeting(activity, r));
    const possible = !proposal.distinct && records.find(r => r.id === activity.existing_id && r.status !== 'cancelled' && r.date === activity.date);
    if (existing || possible) { proposal.status = existing ? 'existing' : 'possible_duplicate'; proposal.existing = existing || possible; proposals.push(proposal); continue; }
    if(unresolved)proposal.issues.push('unresolved_constraints');
    if (proposal.issues.length) { proposal.status = 'needs_input'; proposals.push(proposal); continue; }
    const occupied = [...records.filter(r=>r.status !== 'cancelled').map(r=>({...r,end:r.status === 'completed' ? minutes(r.actual_end) : r.end})), ...provisional];
    const first = activity.time ? minutes(activity.time) : Math.max(540, minutes(activity.window_start));
    const last = activity.time ? first : Math.min(1080, minutes(activity.window_end)) - activity.duration;
    let lastResult;
    for (let start = first; start <= last; start += 15) {
      const interval = {date:activity.date,start,end:start+activity.duration};
      if(activity.window_start && start < minutes(activity.window_start) || activity.window_end && interval.end > minutes(activity.window_end))continue;
      if (start < 540 || interval.end > 1080 || busy.some(b=>overlap(interval,b)) || occupied.some(b=>overlap(interval,b))) continue;
      const request = {date:activity.date,time:clock(start),duration:activity.duration,people:activity.people,kind,features:activity.features};
      const result = await recommend(request, occupied, today);
      lastResult = result;
      if (!result.candidates.length) continue;
      proposal.status='proposed';proposal.request=request;proposal.candidates=result.candidates;proposal.trace=result.trace;
      provisional.push({...interval,id:proposal.id,space_id:result.candidates[0].id,title:activity.title});
      break;
    }
    if (proposal.status !== 'proposed') { proposal.status='no_slot'; proposal.trace=lastResult?.trace ?? []; proposal.excluded=lastResult?.excluded ?? []; }
    proposals.push(proposal);
  }
  return {proposals, questions:plan.questions};
}
