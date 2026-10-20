import spaces from './demo-data/spaces.csv';
import reservations from './demo-data/reservations.csv';
import categories from './demo-data/reservations_classified_mapping.csv';
import { createDataset } from './queries.js';
import { handleCloudRequest } from './cloud-api.js';
import { DurableObject } from 'cloudflare:workers';
import { handleStoredOfficeRequest } from './office-service.js';
import { errorResponse } from './http-utils.js';

export class OfficeWorkspace extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, body TEXT NOT NULL)');
  }
  async fetch(request){
    const load=()=>{
      const row=this.ctx.storage.sql.exec('SELECT version,body FROM workspace WHERE id=1').toArray()[0];
      return row?{version:row.version,state:JSON.parse(row.body)}:null;
    };
    try{
      return await handleStoredOfficeRequest(request,{load,commit:(expected,state)=>this.ctx.storage.transactionSync(()=>{
        if((load()?.version??0)!==expected)return false;
        this.ctx.storage.sql.exec('INSERT INTO workspace(id,version,body) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,body=excluded.body',expected+1,JSON.stringify(state));
        return true;
      })});
    }catch(error){return errorResponse(error);}
  }
}

// This deployment can only load the fictional fixtures, never enterprise data.
const data = createDataset({ 'spaces.csv': spaces, 'reservations.csv': reservations, 'reservations_classified_mapping.csv': categories }, 'synthetic');
export default {
  fetch(request, env) { return handleCloudRequest(request, env, data); },
};
