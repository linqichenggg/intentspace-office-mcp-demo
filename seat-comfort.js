// Pure, bounded comfort summaries. No file access, personal data or model calls.
export const thermalPreferences = new Set(['avoid_cold','avoid_hot']);
export function missingFeatures(space, features) {
  return features.filter(feature=>!(space.kind==='desk'&&thermalPreferences.has(feature))&&!space.features.includes(feature));
}
export function simulatedComfort(index) {
  const count=index%17===0?2:12+(index%5)*4;
  const cold=index%5,hot=(index*3)%6;
  return {source:'simulation',responses:count,cold:Math.min(cold,count),hot:Math.min(hot,Math.max(0,count-cold)),
    mean_score:Math.round((6.8+(index%14)/5)*10)/10,minimum_responses:3};
}
export function comfortOrder(space, preferences) {
  const data=space.comfort;
  if(!data||data.responses<3)return {known:false,thermal:null,satisfaction:null};
  const penalty=(preferences.includes('avoid_cold')?data.cold:0)+(preferences.includes('avoid_hot')?data.hot:0);
  return {known:true,thermal:penalty/data.responses,satisfaction:data.mean_score};
}
export function compareComfort(a,b,preferences) {
  const left=comfortOrder(a,preferences),right=comfortOrder(b,preferences);
  return Number(right.known)-Number(left.known)||(left.known&&right.known?
    left.thermal-right.thermal||right.satisfaction-left.satisfaction:0)||a.id.localeCompare(b.id);
}
const cleanDate=value=>{
  const parts=String(value??'').match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if(!parts)return null;
  const date=parts[1]+'-'+parts[2].padStart(2,'0')+'-'+parts[3].padStart(2,'0');
  return Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date?date:null;
};
function period(dates){const values=dates.filter(Boolean).sort();return {start:values[0]??null,end:values.at(-1)??null};}
function canonicalLocation(value){
  const text=String(value??'').normalize('NFKC').trim();
  const room=text.match(/^(?:会議室\s*([A-IX])|([A-IX])\s*会議室|([A-IX]))$/i);
  return room?'会議室'+(room[1]??room[2]??room[3]).toUpperCase():text;
}
// Aggregate only explicit source fields. Do not mine free-text comments or infer
// temperature, airflow, seat mapping, exposure or missing neutral responses.
export function summarizeEnterpriseComfort({airconRows=[],satisfactionRows=[],spaceRows=[]}={}) {
  const spaces=new Map(spaceRows.map(row=>[row.organization_id+'#'+row.space_id,row.space_name]));
  const locations=new Map(),airDates=[],scoreDates=[],seenScores=new Set(),settings=new Map();
  let unknownThermal=0,invalidScores=0,unmappedScores=0,duplicateScores=0;
  const get=name=>{
    if(!locations.has(name))locations.set(name,{location:name,hot_reports:0,cold_reports:0,thermal_dates:[],surveys:new Map()});
    return locations.get(name);
  };
  for(const row of airconRows){
    const name=canonicalLocation(row['場所']),date=cleanDate(row['投稿時間']);
    if(!name)continue;
    const state=row['状態'];
    if(!['ちょっと寒い','寒すぎて耐えられない','ちょっと暑い','暑すぎて耐えられない'].includes(state)){unknownThermal++;continue;}
    // Distinct submissions can share time/place/state. No submission ID is provided,
    // so keep rows rather than silently deduplicating legitimate repeated reports.
    const item=get(name);item[state.includes('寒')?'cold_reports':'hot_reports']++;
    item.thermal_dates.push(date);airDates.push(date);
  }
  for(const row of satisfactionRows){
    const id=row.satisfaction_id&&row.organization_id+'#'+row.satisfaction_id;
    if(id&&seenScores.has(id)){duplicateScores++;continue;}
    if(id)seenScores.add(id);
    const score=String(row.score).trim()===''?NaN:Number(row.score);
    if(!Number.isFinite(score)||score<1||score>10){invalidScores++;continue;}
    const sourceName=spaces.get(row.organization_id+'#'+row.space_id);
    if(!sourceName){unmappedScores++;continue;}
    const name=canonicalLocation(sourceName),date=cleanDate(row.answered_date_jst);
    const key=row.satisfaction_setting_id||'unidentified';
    if(!settings.has(key))settings.set(key,'Q'+String(settings.size+1).padStart(2,'0'));
    const item=get(name);
    if(!item.surveys.has(key))item.surveys.set(key,{question_group:settings.get(key),responses:0,score_total:0,dates:[]});
    const group=item.surveys.get(key);group.responses++;group.score_total+=score;group.dates.push(date);scoreDates.push(date);
  }
  return {source:'enterprise_sample',mapped_to_demo_seats:false,thermal_period:period(airDates),satisfaction_period:period(scoreDates),
    source_rows:{aircon:airconRows.length,satisfaction:satisfactionRows.length},
    excluded:{unknown_thermal:unknownThermal,invalid_scores:invalidScores,unmapped_scores:unmappedScores,duplicate_scores:duplicateScores},
    questionnaire_groups:settings.size,
    items:[...locations.values()].map(item=>({
      location:item.location,hot_reports:item.hot_reports,cold_reports:item.cold_reports,thermal_period:period(item.thermal_dates),
      surveys:[...item.surveys.values()].map(group=>({question_group:group.question_group,responses:group.responses,
        mean_score:Math.round(group.score_total/group.responses*100)/100,period:period(group.dates)}))
    })).sort((a,b)=>(b.hot_reports+b.cold_reports)-(a.hot_reports+a.cold_reports)||a.location.localeCompare(b.location))};
}
