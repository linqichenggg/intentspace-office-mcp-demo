export class ApiSession {
  #key = '';
  #model = '';
  #controller = null;
  #history = [];

  configure(key, model) {
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(key)) throw new Error('OpenAI API Key の形式を確認してください');
    if (!/^gpt-[a-zA-Z0-9.-]{1,90}$/.test(model)) throw new Error('GPT のモデル名を確認してください');
    this.clear();
    this.#key = key;
    this.#model = model;
  }

  get configured() { return Boolean(this.#key); }
  get model() { return this.#model; }

  begin(message) {
    if (!this.configured) throw new Error('API 設定で Key を入力してください');
    this.#controller?.abort();
    this.#controller = new AbortController();
    return {
      signal: this.#controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#key}` },
      body: JSON.stringify({ message, model: this.#model, history: this.#history }),
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
