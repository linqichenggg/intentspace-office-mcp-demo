export class ApiSession {
  #key = '';
  #model = '';
  #controller = null;
  #history = [];
  #localAvailable = false;
  #localModel = 'gpt-6.1-sol';

  configureLocal({available=false,model='gpt-6.1-sol'}={}) {
    if(typeof available!=='boolean'||!/^gpt-[a-zA-Z0-9.-]{1,90}$/.test(model))throw new Error('local_config_invalid');
    this.#localAvailable=available;
    this.#localModel=model;
  }

  configure(key, model) {
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(key)) throw new Error('OpenAI API Key の形式を確認してください');
    if (!/^gpt-[a-zA-Z0-9.-]{1,90}$/.test(model)) throw new Error('GPT のモデル名を確認してください');
    this.clear();
    this.#key = key;
    this.#model = model;
  }

  get configured() { return Boolean(this.#key)||this.#localAvailable; }
  get source() { return this.#key?'page':this.#localAvailable?'local':null; }
  get localAvailable() { return this.#localAvailable; }
  get model() { return this.#key?this.#model:this.#localModel; }

  begin(message) {
    if (!this.configured) throw new Error('API 設定で Key を入力してください');
    this.#controller?.abort();
    this.#controller = new AbortController();
    return {
      signal: this.#controller.signal,
      headers: { 'Content-Type': 'application/json', ...(this.#key?{Authorization:`Bearer ${this.#key}`}:{'X-IntentSpace-Key-Source':'local'}) },
      body: JSON.stringify({ message, model: this.model, history: this.#history }),
    };
  }

  remember(message, answer) {
    if (!this.configured) return;
    this.#history.push({ role: 'user', content: message }, { role: 'assistant', content: answer.slice(0, 6000) });
    this.#history = this.#history.slice(-6);
  }

  clear() {
    this.#controller?.abort();
    this.#controller = null;
    this.#key = '';
    this.#model = '';
    this.#history = [];
  }
}

function validateReviewSnapshot(snapshot) {
  const invalid = () => { throw new Error('比較用データが不完全または無効です。再確認してください。'); };
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
  if (!snapshot || snapshot.schema_version !== 1 || typeof snapshot.metric_version !== 'string' || !snapshot.metric_version ||
      !/^[a-f0-9]{64}$/.test(snapshot.dataset_scope) || !/^[a-f0-9]{64}$/.test(snapshot.data_hash)) invalid();
  const {scope, rule, items} = snapshot;
  if (!scope || !date(scope.start_date) || !date(scope.end_date) || scope.start_date > scope.end_date ||
      !(scope.space_id === null || (typeof scope.space_id === 'string' && scope.space_id.length > 0))) invalid();
  if (!rule || !integer(rule.min_reservations) || rule.min_reservations < 1 || rule.min_reservations > 100000 ||
      !integer(rule.min_unused) || rule.min_unused < 1 || rule.min_unused > 100000 ||
      !Number.isFinite(rule.min_unused_percent) || rule.min_unused_percent < 0 || rule.min_unused_percent > 100) invalid();
  if (!Array.isArray(items) || snapshot.total_spaces !== items.length || !integer(snapshot.total_spaces)) invalid();
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item.space_id !== 'string' || !item.space_id || seen.has(item.space_id) || typeof item.name !== 'string' ||
        !integer(item.eligible_reservations) || !integer(item.unused_count) || item.unused_count > item.eligible_reservations || !integer(item.excluded_unknown)) invalid();
    const expected = item.eligible_reservations < rule.min_reservations ? 'insufficient_data'
      : item.unused_count >= rule.min_unused && item.unused_count * 100 >= item.eligible_reservations * rule.min_unused_percent ? 'review' : 'below_threshold';
    if (item.status !== expected) invalid();
    seen.add(item.space_id);
  }
}

export function compareReviewSnapshots(previous, current) {
  validateReviewSnapshot(current);
  const counts = {new:0, ongoing:0, no_longer_matches:0, uncertain:0, unchanged:0};
  if (!previous) return {state:'baseline', reason:null, data_changed:false, counts, total_spaces:current.total_spaces, items:[]};
  validateReviewSnapshot(previous);
  const mismatch = previous.dataset_scope !== current.dataset_scope ? 'dataset_changed'
    : previous.metric_version !== current.metric_version ? 'metric_changed'
    : ['start_date','end_date','space_id'].some(key => previous.scope[key] !== current.scope[key]) ? 'scope_changed'
    : ['min_reservations','min_unused','min_unused_percent'].some(key => previous.rule[key] !== current.rule[key]) ? 'rule_changed' : null;
  if (mismatch) return {state:'incomparable', reason:mismatch, data_changed:false, counts, total_spaces:0, items:[]};
  const before = new Map(previous.items.map(item => [item.space_id,item]));
  const after = new Map(current.items.map(item => [item.space_id,item]));
  const items = [...new Set([...before.keys(),...after.keys()])].sort().map(spaceId => {
    const old = before.get(spaceId), next = after.get(spaceId);
    const reason = !old || !next ? 'missing_record'
      : old.status === 'insufficient_data' || next.status === 'insufficient_data' ? 'insufficient_data'
      : old.excluded_unknown > 0 || next.excluded_unknown > 0 ? 'unknown_status' : null;
    const change = reason ? 'uncertain' : next.status === 'review' ? old.status === 'review' ? 'ongoing' : 'new'
      : old.status === 'review' ? 'no_longer_matches' : 'unchanged';
    counts[change]++;
    return {space_id:spaceId, name:next?.name ?? old.name, change, reason, previous:old ?? null, current:next ?? null};
  });
  return {state:'compared', reason:null, data_changed:previous.data_hash !== current.data_hash, counts, total_spaces:items.length, items};
}

export class ReviewComparison {
  #previous = null;

  check(snapshot) {
    const result = compareReviewSnapshots(this.#previous, snapshot);
    // A changed query must not silently replace a comparable baseline.
    if (result.state !== 'incomparable') this.#previous = structuredClone(snapshot);
    return result;
  }

  setBaseline(snapshot) {
    const result = compareReviewSnapshots(null, snapshot);
    this.#previous = structuredClone(snapshot);
    return result;
  }

  clear() { this.#previous = null; }
}
