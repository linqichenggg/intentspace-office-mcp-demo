import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http-utils.js';
import { clock } from './day-plan.js';

const tokenUrl = 'https://oauth2.googleapis.com/token';
const scope = 'https://www.googleapis.com/auth/calendar.events.owned.readonly';
const stateCookie = 'intentspace_google_state';
const clearCookie = stateCookie + '=; Path=/oauth/google/callback; HttpOnly; SameSite=Lax; Max-Age=0';
const fields = 'nextPageToken,items(id,etag,status,summary,start,end,location,hangoutLink,conferenceData(entryPoints(entryPointType)),attendees(self,organizer,resource,responseStatus),attendeesOmitted,transparency,eventType)';
const digest = text => createHash('sha256').update(text).digest('hex');

function localDay(date) {
  const start = Date.parse(date + 'T00:00:00+09:00');
  return { start, end: start + 86400000 };
}

function eventTime(value) {
  return Date.parse(value?.dateTime ?? (value?.date ? value.date + 'T00:00:00+09:00' : ''));
}

export function normalizeGoogleCalendarEvents(date, items) {
  const day = localDay(date);
  return items.flatMap(item => {
    if (!item?.id || item.status === 'cancelled') return [];
    const guests = item.attendees ?? [];
    if (guests.some(guest => guest.self && guest.responseStatus === 'declined')) return [];
    const start = Math.max(eventTime(item.start), day.start);
    const end = Math.min(eventTime(item.end), day.end);
    if (!(end > start)) return [];
    const key = digest('google:' + item.id);
    const id = [key.slice(0,8),key.slice(8,12),'5'+key.slice(13,16),'8'+key.slice(17,20),key.slice(20,32)].join('-');
    const title = (item.summary?.trim() || '予定').slice(0,160);
    const declaredPeople = title.match(/^\[(\d{1,3})(?:人| people)\](?=\s|$)/i);
    // A meeting can state its headcount before the organizer sends invitations.
    const people = guests.length && !item.attendeesOmitted
      ? guests.filter(guest => !guest.resource && guest.responseStatus !== 'declined').length
        + Number(!guests.some(guest => guest.organizer))
      : declaredPeople ? Number(declaredPeople[1]) : null;
    return [{
      id, version:1, source_version:item.etag ?? '', status:'active', date,
      title,
      time:clock(Math.floor((start-day.start)/60000)),
      end_time:clock(Math.ceil((end-day.start)/60000)),
      people:people >= 1 && people <= 100 ? people : null,
      location:(item.location ?? '').slice(0,160),
      video:Boolean(item.hangoutLink || item.conferenceData?.entryPoints?.some(entry => entry.entryPointType === 'video')),
      room:guests.some(guest => guest.resource && guest.responseStatus !== 'declined'),
      blocking:item.transparency !== 'transparent' && item.eventType !== 'workingLocation',
      timed:Boolean(item.start.dateTime && item.end.dateTime),
      kind:item.eventType ?? 'default'
    }];
  }).sort((a,b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
}

// One local demo employee. OAuth tokens stay in server memory for this run.
export function createGoogleCalendar({clientId, clientSecret, redirectUri, fetchImpl=fetch, now=Date.now}) {
  const configured = Boolean(clientId && clientSecret);
  let pending;
  let tokens;
  let reauthorize = false;
  let refresh;
  let connectionVersion = 0;
  const status = () => ({configured,connected:Boolean(tokens),reauthorize});
  async function exchange(params, signal) {
    const result = await fetchImpl(tokenUrl,{
      method:'POST',body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,...params}),
      redirect:'error',signal
    });
    if (!result.ok) {
      if (result.status === 400 || result.status === 401) throw new HttpError(401,'google_authorization');
      throw new HttpError(502,'google_unavailable');
    }
    const payload = await result.json();
    if (typeof payload.access_token !== 'string' || !(payload.expires_in > 0)) throw new HttpError(502,'google_unavailable');
    return {access:payload.access_token,refresh:payload.refresh_token,expires:now()+payload.expires_in*1000};
  }
  const expired = () => {
    tokens = undefined;
    reauthorize = true;
    throw new HttpError(401,'google_authorization');
  };
  async function accessToken(signal) {
    if (!tokens) throw new HttpError(401,'google_authorization');
    if (tokens.expires > now() + 30000) return tokens.access;
    if (!refresh) {
      const owner = tokens;
      refresh = exchange({grant_type:'refresh_token',refresh_token:owner.refresh},AbortSignal.timeout(12000))
        .then(result => {
          if (tokens !== owner) throw new HttpError(401,'google_authorization');
          tokens = {...result,refresh:result.refresh ?? owner.refresh};
          return tokens.access;
        })
        .catch(error => {
          if (tokens === owner && error.message === 'google_authorization') expired();
          throw error;
        })
        .finally(() => {refresh = undefined;});
    }
    const access = await refresh;
    signal?.throwIfAborted();
    return access;
  }
  async function readDays(startDate,endDate,signal) {
    const first=localDay(startDate), last=localDay(endDate), items=[], version=connectionVersion;
    const url=new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    url.search=new URLSearchParams({
      timeMin:new Date(first.start).toISOString(),timeMax:new Date(last.end).toISOString(),
      timeZone:'Asia/Tokyo',singleEvents:'true',maxResults:'250',fields
    });
    const access=await accessToken(signal);
    const seenPages=new Set();
    do {
      const result=await fetchImpl(url,{headers:{Authorization:'Bearer '+access},redirect:'error',signal});
      if(result.status===401){
        if(tokens?.access===access)expired();
        throw new HttpError(401,'google_authorization');
      }
      if(!result.ok)throw new HttpError(502,'google_unavailable');
      const page=await result.json();
      if(!Array.isArray(page.items)||seenPages.has(page.nextPageToken))throw new HttpError(502,'google_unavailable');
      items.push(...page.items);
      if(!page.nextPageToken)break;
      seenPages.add(page.nextPageToken);
      url.searchParams.set('pageToken',page.nextPageToken);
    } while(true);
    if(version!==connectionVersion)throw new HttpError(409,'arrival_changed');
    const days=[];
    for(let start=first.start;start<last.end;start+=86400000){
      const date=new Date(start+9*3600000).toISOString().slice(0,10);
      days.push(...normalizeGoogleCalendarEvents(date,items));
    }
    return days;
  }
  return {
    status,
    version:()=>connectionVersion,
    connect(origin) {
      if (!configured || origin !== new URL(redirectUri).origin) throw new HttpError(400,'google_config');
      const state = randomBytes(32).toString('hex'), verifier = randomBytes(48).toString('base64url');
      pending = {state,verifier,expires:now()+10*60000};
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({
        client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope,access_type:'offline',prompt:'consent',state,
        code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'
      });
      return {url:url.href,cookie:stateCookie+'='+state+'; Path=/oauth/google/callback; HttpOnly; SameSite=Lax; Max-Age=600'};
    },
    async callback(request) {
      const url = new URL(request.url), params = url.searchParams;
      const state = params.get('state') ?? '';
      const cookie = (request.headers.get('Cookie') ?? '').split(';').map(item => item.trim()).find(item => item.startsWith(stateCookie+'='));
      const attempt = pending;
      if (!configured || url.href.split('?')[0] !== redirectUri || !attempt || attempt.expires <= now() ||
          !/^[0-9a-f]{64}$/.test(state) || !timingSafeEqual(Buffer.from(attempt.state),Buffer.from(state)) || cookie !== stateCookie+'='+state) {
        throw new HttpError(400,'google_state');
      }
      pending = undefined;
      const version = connectionVersion;
      let location = '/?google=error';
      if (params.get('code') && !params.has('error')) {
        try {
          const acquired = await exchange({
            grant_type:'authorization_code',code:params.get('code'),redirect_uri:redirectUri,code_verifier:attempt.verifier
          },AbortSignal.timeout(12000));
          if (!acquired.refresh || pending || version !== connectionVersion) throw new HttpError(401,'google_authorization');
          tokens = acquired;
          connectionVersion++;
          reauthorize = false;
          location = '/?google=connected';
        } catch {}
      }
      return new Response(null,{status:303,headers:{Location:location,'Set-Cookie':clearCookie,'Cache-Control':'no-store'}});
    },
    disconnect() { tokens = undefined; pending = undefined; reauthorize = false; connectionVersion++; },
    readDay:(date,signal)=>readDays(date,date,signal),
    readDays
  };
}
