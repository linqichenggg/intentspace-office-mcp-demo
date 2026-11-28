// Local-only replay of the supplied Bitkey reservation sample on the meeting-room floor.
// Privacy: only room, time, booked headcount and use status leave this module; no reservation,
// person or organisation IDs. Never bundle the source CSV into public assets or send it to a model.
//
// Time zone: the time columns are named *_jst but their values end in "UTC". Used bookings start
// mostly between 10:00 and 17:00 as written, which would be 19:00-02:00 in Japan if the values
// were UTC. The written wall-clock time is therefore treated as Japan time (to be confirmed by Bitkey).

import { randomUUID } from 'node:crypto';
import { createMeetingState } from './meeting-state.js';
import { createOfficeService, officeRooms } from './office-service.js';
import { createGoogleCalendar } from './google-calendar.js';
import { assertSameOrigin, HttpError, json, readJson } from './http-utils.js';

export const REAL_ROOM_MAP = {
  '会議室A': 'tsg-room-a', '会議室B': 'tsg-room-b', '会議室C': 'tsg-room-c', '会議室D': 'office-c04', '会議室E': 'office-m02',
  '会議室F': 'tsg-room-f', '会議室G': 'tsg-room-g', '会議室I': 'tsg-room-i', '会議室X': 'tsg-room-x'
};
// Smaller spaces that can host a small meeting but are not drawn on the meeting-room floor.
const SMALL_ALTERNATIVES = ['会議室A', '会議室D', ...[1, 2, 3, 4, 5, 6].map(n => 'Multi Booth 0' + n)];
export const REPLAY_RULE = { max_people: 4, max_capacity_ratio: 0.5, min_capacity: 8 };

const truthy = value => String(value).trim().toLowerCase() === 'true';
// "2026-03-04 10:30:00 UTC" -> {date:'2026-03-04', minute:630}
export function wallClock(text) {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(String(text ?? '').trim());
  return match ? { date: match[1], minute: Number(match[2]) * 60 + Number(match[3]) } : null;
}
export function classifyBooking(row) {
  // Same basis as the poster analysis: used and not deleted afterwards.
  if (truthy(row.is_used) && !truthy(row.deleted)) return 'used';
  if (String(row.reservation_status ?? '').startsWith('4_') && !truthy(row.deleted)) return 'no_show';
  return null; // cancelled before or after the start: not shown on the map
}
const offMapGroup = name => /^Multi Booth/.test(name) ? 'multi_booth' : /^(Personal|Single) Booth/.test(name) ? 'single_booth' : null;
const weekday = date => new Date(date + 'T00:00:00Z').getUTCDay();

export function createRealReplay(rows) {
  const bookings = [], offMap = [], trendRows = [], invalid = { time: 0, people: 0 };
  for (const row of rows) {
    const status = classifyBooking(row);
    if (!status) continue;
    const name = String(row.space_name ?? '').trim(), start = wallClock(row.base_condition_start_time_jst), end = wallClock(row.base_condition_end_time_jst);
    const people = Number(row.total_people_count), capacity = Number(row.capacity);
    if (!Number.isInteger(people) || people < 1) { invalid.people++; continue; }
    // The trend counts every used booking (same basis as the poster); drawing needs a valid time window.
    if (status === 'used' && REAL_ROOM_MAP[name] && Number.isInteger(capacity))
      trendRows.push({ room_id: REAL_ROOM_MAP[name], name: name.replace('会議室', ''), capacity, people,
        date: start?.date ?? null, start: start?.minute ?? null, end: end?.minute ?? null, timed: Boolean(start && end && end.date === start.date && end.minute > start.minute) });
    if (!start || !end || end.date !== start.date || end.minute <= start.minute) { invalid.time++; continue; }
    const record = { date: start.date, start: start.minute, end: end.minute, people, capacity: Number.isInteger(capacity) ? capacity : null, status, space: name };
    if (REAL_ROOM_MAP[name]) bookings.push({ ...record, room_id: REAL_ROOM_MAP[name], name: name.replace('会議室', '') });
    else if (offMapGroup(name)) offMap.push({ ...record, group: offMapGroup(name) });
  }
  const occupancy = new Map();
  for (const b of [...bookings, ...offMap]) if (SMALL_ALTERNATIVES.includes(b.space)) (occupancy.get(b.space) ?? occupancy.set(b.space, []).get(b.space)).push(b);
  const capacityOf = new Map([...bookings, ...offMap].filter(b => b.capacity).map(b => [b.space, b.capacity]));
  const smallParty = b => b.capacity >= REPLAY_RULE.min_capacity && b.people <= REPLAY_RULE.max_people && b.people / b.capacity <= REPLAY_RULE.max_capacity_ratio;
  const freeSmaller = b => SMALL_ALTERNATIVES.some(space => (capacityOf.get(space) ?? 0) >= b.people
    && !(occupancy.get(space) ?? []).some(o => o.date === b.date && o.start < b.end && b.start < o.end));

  const byDate = new Map();
  for (const b of bookings) (byDate.get(b.date) ?? byDate.set(b.date, []).get(b.date)).push(b);
  const offByDate = new Map();
  for (const b of offMap) (offByDate.get(b.date) ?? offByDate.set(b.date, []).get(b.date)).push(b);
  const days = [...byDate.keys()].sort().map(date => {
    const list = byDate.get(date), used = list.filter(b => b.status === 'used');
    return { date, weekday: weekday(date), used: used.length, no_show: list.length - used.length, peak: peakConcurrent(used) };
  }).filter(day => day.used > 0);
  const busiest = [...days].sort((a, b) => b.used - a.used || b.peak - a.peak || a.date.localeCompare(b.date))[0]?.date ?? null;

  // Three-month trend with the same thresholds as the in-app review rule.
  const big = trendRows.filter(b => b.capacity >= REPLAY_RULE.min_capacity);
  const rooms = [...new Set(big.map(b => b.room_id))].map(room_id => {
    const list = big.filter(b => b.room_id === room_id), small = list.filter(smallParty);
    const small24 = small.filter(b => b.people >= 2), checked = small.filter(b => b.timed), free = checked.filter(freeSmaller);
    return { room_id, name: list[0].name, capacity: list[0].capacity, used: list.length, small: small.length,
      small_percent: Math.round(small.length / list.length * 1000) / 10, small_2to4: small24.length,
      small_2to4_percent: Math.round(small24.length / list.length * 1000) / 10, free_checked: checked.length, free_smaller: free.length };
  }).sort((a, b) => b.small_percent - a.small_percent);
  const totalSmall = rooms.reduce((n, r) => n + r.small, 0), totalBig = rooms.reduce((n, r) => n + r.used, 0);
  const trend = { rule: REPLAY_RULE, used: totalBig, small: totalSmall, small_percent: totalBig ? Math.round(totalSmall / totalBig * 1000) / 10 : 0,
    free_checked: rooms.reduce((n, r) => n + r.free_checked, 0), free_smaller: rooms.reduce((n, r) => n + r.free_smaller, 0), rooms };
  trend.free_percent = trend.free_checked ? Math.round(trend.free_smaller / trend.free_checked * 1000) / 10 : 0;

  return {
    summary() {
      return { source: 'enterprise_sample', local_only: true, coverage: days.length ? { start: days[0].date, end: days.at(-1).date } : null,
        days, busiest, trend, invalid, time_basis: 'written_wall_clock_as_jst',
        limitations: ['Booked headcount, not measured attendance.', 'Registered capacity may be inaccurate (supplier note).',
          'Equipment is not checked for free smaller rooms.', 'Times are treated as Japan time although labelled UTC; to be confirmed.'] };
    },
    day(date) {
      if (!byDate.has(date)) return null;
      const strip = ({ space, alternative, ...rest }) => rest;
      return { date, weekday: weekday(date), bookings: byDate.get(date).map(strip).sort((a, b) => a.start - b.start || a.name.localeCompare(b.name)),
        off_map: (offByDate.get(date) ?? []).map(({ group, start, end, people, status }) => ({ group, start, end, people, status })) };
    }
  };
}

function peakConcurrent(list) {
  const edges = list.flatMap(b => [[b.start, 1], [b.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0, peak = 0;
  for (const [, d] of edges) { now += d; peak = Math.max(peak, now); }
  return peak;
}

// What the map shows at one minute of the day.
export function replayFrame(day, minute) {
  const active = day.bookings.filter(b => b.start <= minute && minute < b.end);
  return { minute, in_use: active.filter(b => b.status === 'used'), no_show: active.filter(b => b.status === 'no_show'),
    off_map: { multi_booth: day.off_map.filter(b => b.group === 'multi_booth' && b.status === 'used' && b.start <= minute && minute < b.end).length,
      single_booth: day.off_map.filter(b => b.group === 'single_booth' && b.status === 'used' && b.start <= minute && minute < b.end).length } };
}

// The selected timestamp and gate identify the demonstration row in the local CSV.
// Resolve the employee in memory and pass only event times to the replay session.
export function selectArrivalReplay(rows, spaces, {date, gateName, firstTime}) {
  const gates = spaces.filter(space => space.space_name === gateName);
  if (gates.length !== 1) return null;
  const day = date.split('-').map(Number).join('/');
  const entries = rows.filter(row => row.space_id === gates[0].space_id
    && row.direction === 'enter' && row.event_date_jst === day && row.people_id);
  const timestamp = row => /^(\d{4}-\d{2}-\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}) UTC$/.exec(row.event_time_jst);
  const matches = entries.filter(row => row.event_time_jst === date + ' ' + firstTime + ' UTC');
  const people = new Set(matches.map(row => row.people_id));
  if (people.size !== 1) return null;
  const [employee] = people;
  const times = [...new Set(entries.filter(row => row.people_id === employee)
    .map(timestamp).filter(match => match?.[1] === date).map(match => match[2]))].sort();
  if (times[0] !== firstTime || !times[1]) return null;
  return {date, gateName, times:times.slice(0,2)};
}

export const arrivalReplayPath = '/api/office/arrival-replay';
export const isArrivalReplayPath = path => path === arrivalReplayPath || path.startsWith(arrivalReplayPath + '/');
const proactivePath = '/api/office/proactive';
const replaySpeed = 600;
const displayTime = ms => new Date(ms).toISOString().slice(11,19);

export function createArrivalReplay({date,gateName,times}, {
  elapsed = Date.now, source = 'enterprise_sample', storage
} = {}) {
  const stops = times.map(time => Date.parse(date + 'T' + time + 'Z'));
  const start = Date.parse(date + 'T09:00:00Z');
  const internal = 'http://127.0.0.1';
  const now = () => new Date(date + 'T09:00:00+09:00');
  let memory;
  const store = storage ?? {
    load:()=>memory,
    commit(expected,version){
      if ((memory?.version ?? 0) !== expected) return false;
      memory = version;
      return true;
    }
  };

  function createWorkspace(persisted) {
    const workspace = createMeetingState({rooms:officeRooms,now,persisted});
    if (!persisted) workspace.changeCalendar({
      action:'create',confirmed:true,operation_id:randomUUID(),expected_revision:0,
      event:{date,time:'10:30',end_time:'11:00',title:'個人予定 / Personal appointment',people:1,notes:''}
    },{todayOnly:true});
    return workspace;
  }

  function officeAction(office, path, input, signal) {
    return office(new Request(internal + proactivePath + path,input === undefined ? {} : {
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal
    }));
  }

  return async request => {
    assertSameOrigin(request);
    const url = new URL(request.url);
    if (source === 'enterprise_sample' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname))
      throw new HttpError(403,'local_key_origin');
    const action = url.pathname.slice(arrivalReplayPath.length);
    const post = request.method === 'POST';
    if (post ? !['/play','/pause','/reset','/confirm'].includes(action) : action || request.method !== 'GET')
      throw new HttpError(404,'invalid_action');
    const input = post ? await readJson(request,1800) : undefined;
    const saved = store.load(), version = saved?.version ?? 0;
    const reset = action === '/reset';
    const round = !reset && saved
      ? {...saved.round}
      : {position:start,started:null,reached:0,locale:'ja'};
    const workspace = createWorkspace(reset ? undefined : saved?.workspace);
    const office = createOfficeService({workspace,now,proactiveGoogle:createGoogleCalendar({}),storedProactive:true});
    let dirty = reset;
    let confirmation;
    const t = elapsed();
    const stop = stops[round.reached];
    const position = () => round.started === null ? round.position
      : Math.min(stops[round.reached],round.position + Math.max(0,t - round.started) * replaySpeed);

    // Reconcile the elapsed interval on the next request. The saved clock and plan
    // survive Worker hibernation, and simultaneous polls can commit the event only once.
    if (round.started !== null && position() === stop) {
      workspace.advanceClock(date,times[round.reached].slice(0,5));
      if (round.reached === 0) {
        const response = await officeAction(office,'/arrival',{
          event_id:randomUUID(),employee_id:'A',direction:'enter',locale:round.locale
        });
        if (!response.ok) throw new HttpError(409,'replay_arrival_failed');
      }
      round.reached++;
      round.position = stop;
      round.started = null;
      dirty = true;
    }

    if (action === '/play' && round.started === null && round.reached < stops.length) {
      round.started = t;
      round.locale = input?.locale === 'en' ? 'en' : 'ja';
      dirty = true;
    } else if (action === '/pause' && round.started !== null) {
      round.position = position();
      round.started = null;
      dirty = true;
    } else if (action === '/confirm') {
      // Keep the just-reconciled arrival pending for the first confirmation.
      if (dirty || round.position !== stops[0] || round.started !== null)
        throw new HttpError(409,'replay_confirmation_closed');
      confirmation = await officeAction(office,'/confirm',input,request.signal);
      dirty = confirmation.ok;
    }

    if (dirty && !store.commit(version,{version:version+1,round,workspace:workspace.exportState()}))
      throw new HttpError(409,'state_changed');
    if (confirmation) return confirmation;

    const response = await officeAction(office,'');
    return json({
      ...await response.json(),
      clock:{date,time:displayTime(position())},
      replay:{source,gate:gateName,playing:round.started !== null,finished:round.reached === stops.length,
        can_confirm:round.position === stops[0] && round.started === null,
        entries:times.slice(0,round.reached).map((time,index)=>({time,suggestion_triggered:index===0})),
        bookings:workspace.snapshot().meetings.length}
    });
  };
}
