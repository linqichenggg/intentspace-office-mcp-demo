export class HttpError extends Error {
  constructor(status, message, diagnostics) {
    super(message);
    this.status = status;
    if(diagnostics){
      this.diagnostics={source:diagnostics.source==='openai'?'openai':'local'};
      if(Number.isInteger(diagnostics.upstream_status)&&diagnostics.upstream_status>=100&&diagnostics.upstream_status<=599)this.diagnostics.upstream_status=diagnostics.upstream_status;
      for(const key of ['code','type','param','request_id'])if(typeof diagnostics[key]==='string'&&/^[A-Za-z0-9_.\[\]-]{1,100}$/.test(diagnostics[key])&&!diagnostics[key].includes('sk-'))this.diagnostics[key]=diagnostics[key];
      if(diagnostics.agent)this.diagnostics.agent=safeAgentDiagnostics(diagnostics.agent);
    }
  }
}

// Failure reports contain bounded operational facts, never model text or tool result bodies.
function safeAgentDiagnostics(input) {
  const safeToken=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(value)&&!value.includes('sk-');
  const result={phase:['discovery','evidence','finalize'].includes(input.phase)?input.phase:'discovery'};
  for(const key of ['rounds','tool_calls','mcp_calls','cache_hits','context_characters','pending_rooms','limit'])
    if(Number.isSafeInteger(input[key])&&input[key]>=0&&input[key]<=1000000000)result[key]=input[key];
  if(['rounds','tools','context','stalled'].includes(input.limit_kind))result.limit_kind=input.limit_kind;
  if(typeof input.model==='string'&&/^gpt-[A-Za-z0-9.-]{1,90}$/.test(input.model)&&!input.model.includes('sk-'))result.model=input.model;
  result.usage={};
  for(const key of ['input_tokens','output_tokens'])if(Number.isSafeInteger(input.usage?.[key])&&input.usage[key]>=0&&input.usage[key]<=1000000000)result.usage[key]=input.usage[key];
  result.verified_ids=(Array.isArray(input.verified_ids)?input.verified_ids:[]).filter(safeToken).slice(0,20);
  const names=new Set(['get_data_status','search_spaces','query_reservations','summarize_reservations','analyze_room_fit','get_evidence']);
  result.trace=(Array.isArray(input.trace)?input.trace:[]).filter(step=>step&&typeof step==='object').slice(0,20).map(step=>{
    const args={};
    for(const key of ['start_date','end_date'])if(typeof step.arguments?.[key]==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(step.arguments[key]))args[key]=step.arguments[key];
    for(const key of ['reservation_id','space_id'])if(safeToken(step.arguments?.[key]))args[key]=step.arguments[key];
    for(const key of ['offset','limit','min_capacity'])if(Number.isSafeInteger(step.arguments?.[key])&&step.arguments[key]>=0&&step.arguments[key]<=1000000)args[key]=step.arguments[key];
    if(['Area','Workspot'].includes(step.arguments?.type))args.type=step.arguments.type;
    if(['all','used','unused_not_precancelled'].includes(step.arguments?.status))args.status=step.arguments.status;
    const entry={name:names.has(step.name)?step.name:'rejected_tool',arguments:args,is_error:!!step.is_error,cached:!!step.cached};
    if(['invalid_arguments','mcp_failed','invalid_scope','evidence_mismatch','finalization_tool'].includes(step.error_code))entry.error_code=step.error_code;
    return entry;
  });
  return result;
}

export async function readRequestBody(request, limit = 32000) {
  if (Number(request.headers.get('content-length')) > limit) throw new HttpError(413, 'リクエストが大きすぎます');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'JSON を指定してください');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new HttpError(413, 'リクエストが大きすぎます');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    if (length > limit) await reader.cancel();
    reader.releaseLock();
  }
}

export async function readJson(request, limit = 32000) {
  const bytes = await readRequestBody(request, limit);
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new HttpError(400, 'JSON の形式が無効です'); }
}

export function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export function assertSameOrigin(request) {
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new HttpError(403, '許可されていないオリジンです');
  }
}

export function errorResponse(error) {
  const known=error instanceof HttpError;
  return json({ error:known?error.message:'処理に失敗しました。条件を確認して再試行してください。',
    ...(known&&error.diagnostics?{diagnostics:error.diagnostics}:{})},known?error.status:500);
}
