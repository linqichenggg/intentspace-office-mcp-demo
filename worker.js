import spaces from './demo-data/spaces.csv';
import reservations from './demo-data/reservations.csv';
import categories from './demo-data/reservations_classified_mapping.csv';
import { createDataset } from './queries.js';
import { handleCloudRequest, withCloudDemoAi } from './cloud-api.js';
import { createDemoAiLedger, demoAiTokensUsed } from './llm.js';
import { DurableObject } from 'cloudflare:workers';
import { handleStoredOfficeRequest } from './office-service.js';
import { errorResponse } from './http-utils.js';
import { createGoogleCalendar, encryptedGoogleStorage } from './google-calendar.js';
import { createArrivalReplay, isArrivalReplayPath } from './real-replay.js';

const syntheticReplay = {
  date:'2026-04-08',gateName:'デモ入口 / Demo entrance',times:['09:07:18.150','11:28:31.200']
};

export class OfficeWorkspace extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, body TEXT NOT NULL)');
    const key = 'arrival-replay';
    const load = () => ctx.storage.kv.get(key);
    this.arrivalReplay = createArrivalReplay(syntheticReplay,{source:'synthetic',storage:{
      load,
      commit:(expected,state)=>ctx.storage.transactionSync(()=>{
        if ((load()?.version ?? 0) !== expected) return false;
        ctx.storage.kv.put(key,state);
        return true;
      })
    }});
  }
  calendarFor(origin){
    const {GOOGLE_CALENDAR_CLIENT_ID:clientId,GOOGLE_CALENDAR_CLIENT_SECRET:clientSecret,
      GOOGLE_CALENDAR_STORAGE_KEY:secret,GOOGLE_CALENDAR_REDIRECT_URI:redirectUri}=this.env;
    if(!clientId||!clientSecret||!secret||!redirectUri||new URL(redirectUri).origin!==origin){
      return createGoogleCalendar({});
    }
    if(!this.google)this.google=createGoogleCalendar({clientId,clientSecret,redirectUri,
      storage:encryptedGoogleStorage(this.ctx.storage.kv,secret,this.ctx.id.toString())});
    return this.google;
  }
  async fetch(request){
    const load=()=>{
      const row=this.ctx.storage.sql.exec('SELECT version,body FROM workspace WHERE id=1').toArray()[0];
      return row?{version:row.version,state:JSON.parse(row.body)}:null;
    };
    try{
      const url=new URL(request.url);
      if(isArrivalReplayPath(url.pathname))return await this.arrivalReplay(request);
      const google=this.calendarFor(url.origin);
      if(url.pathname==='/oauth/google/callback')return await google.callback(request);
      const authorized=await withCloudDemoAi(request,this.env);
      const response=await handleStoredOfficeRequest(authorized,{load,commit:(expected,state)=>this.ctx.storage.transactionSync(()=>{
        if((load()?.version??0)!==expected)return false;
        this.ctx.storage.sql.exec('INSERT INTO workspace(id,version,body) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,body=excluded.body',expected+1,JSON.stringify(state));
        return true;
      })},{withDemoHistory:true,proactiveGoogle:google,storedProactive:true});
      const tokens=demoAiTokensUsed(authorized);
      if(response.ok&&tokens!==undefined)response.headers.set('X-IntentSpace-Demo-Tokens',String(tokens));
      return response;
    }catch(error){return errorResponse(error);}
  }
}

export class DemoAiQuota extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);
    this.ledger=createDemoAiLedger((sql,...bindings) => this.ctx.storage.sql.exec(sql,...bindings).toArray()[0]);
  }
  used(day){return this.ledger.used(day);}
  reserve(day,held){return this.ledger.reserve(day,held);}
  settle(day,delta){this.ledger.settle(day,delta);}
}

// This deployment can only load the fictional fixtures, never enterprise data.
const data = createDataset({ 'spaces.csv': spaces, 'reservations.csv': reservations, 'reservations_classified_mapping.csv': categories }, 'synthetic');
export default {
  fetch(request, env) { return handleCloudRequest(request, env, data); },
};
