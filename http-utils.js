export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function readJson(request, limit = 32000) {
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
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new HttpError(400, 'JSON の形式が無効です'); }
  } finally {
    if (length > limit) await reader.cancel();
    reader.releaseLock();
  }
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
  return json({ error: error instanceof HttpError ? error.message : '処理に失敗しました。条件を確認して再試行してください。' }, error instanceof HttpError ? error.status : 500);
}
