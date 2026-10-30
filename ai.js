import { ApiSession } from './session.js';
import { errorKey, translator } from './ui-i18n.js';

const $ = id => document.getElementById(id);
const session = new ApiSession();
let aiEnabled = false;
let generation = 0;

function updateSession() {
  $('keyStatus').textContent = session.source==='local'?`${session.model} / 本機のデフォルトKey`:session.configured ? `${session.model} / このページの一時Key` : '未設定 / API設定で入力';
  $('exitSession').textContent=session.localAvailable?'一時Key・会話を消去':'退出・Key を消去';
  $('ask').disabled = !aiEnabled || !session.configured;
  $('exitSession').disabled = !session.configured;
  document.querySelector('.sessionBar').dataset.configured = String(session.configured);
}

function clearSession() {
  generation++;
  session.clear();
  if(session.source==='local')$('apiModel').value=session.model;
  $('apiKey').value = '';
  $('settingsStatus').textContent = '';
  $('question').value = '';
  $('conversation').replaceChildren();
  $('conversation').setAttribute('aria-busy', 'false');
  $('aiEmpty').hidden = false;
  $('ask').textContent = '質問を送信';
  $('aiRaw').textContent = '未実行';
  $('aiStatus').textContent = session.source==='local'?'一時Keyと会話を消去し、本機のデフォルトKeyに戻りました。':'Key と会話を消去しました。再入力すると利用できます。';
  updateSession();
}

function showView(view) {
  $('stats').hidden = view !== 'query';
  $('queryWorkspace').hidden = view !== 'query';
  $('aiWorkspace').hidden = view !== 'ai';
  $('settingsWorkspace').hidden = view !== 'settings';
  document.querySelectorAll('.preset').forEach(button => button.classList.toggle('active', button.dataset.view === view && view !== 'query'));
  document.querySelectorAll('.preset').forEach(button => button.classList.contains('active') ? button.setAttribute('aria-current', 'page') : button.removeAttribute('aria-current'));
  if (view !== 'query') $('pageTitle').textContent = view === 'ai' ? 'AI に質問' : 'API 設定';
  if (view !== 'query') $('pageDescription').textContent = view === 'ai' ? '自然な言葉で質問し、データと根拠を確認する。' : 'ご自身の API Key で、GPT への接続を設定する。';
}

document.querySelectorAll('[data-view="ai"], [data-view="settings"]').forEach(button => {
  button.addEventListener('click', () => showView(button.dataset.view));
});
document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => {
  $('stats').hidden = false;
  $('queryWorkspace').hidden = false;
  $('aiWorkspace').hidden = true;
  $('settingsWorkspace').hidden = true;
}));
$('openSettings').addEventListener('click', () => showView('settings'));
$('exitSession').addEventListener('click', clearSession);

$('settingsForm').addEventListener('submit', event => {
  event.preventDefault();
  try {
    if (!aiEnabled) throw new Error('このデータでは AI 送信が無効です。公開版または架空データで利用してください');
    const key = $('apiKey').value.trim();
    const model = $('apiModel').value.trim();
    clearSession();
    session.configure(key, model);
    $('settingsStatus').textContent = '設定しました。Key は入力欄から消去し、このページのメモリでのみ保持しています。';
    $('aiStatus').textContent = '質問を入力してください。送信すると OpenAI API の利用料金が発生します。';
    updateSession();
    showView('ai');
    $('question').focus();
  } catch (error) { $('settingsStatus').textContent = error.message; }
});

document.querySelectorAll('.exampleQuestion').forEach(button => button.addEventListener('click', () => {
  $('question').value = button.textContent;
  $('question').focus();
}));

function addTurn(question, answer) {
  const article = document.createElement('article');
  article.className = 'answerTurn';
  const title = document.createElement('h3');
  title.textContent = question;
  const text = document.createElement('div');
  text.className = 'answerText';
  text.textContent = answer;
  article.append(title, text);
  $('conversation').append(article);
  $('aiEmpty').hidden = true;
}

$('askForm').addEventListener('submit', async event => {
  event.preventDefault();
  const currentGeneration = generation;
  const question = $('question').value.trim();
  if (!question || !aiEnabled || !session.configured) return;
  $('ask').disabled = true;
  $('ask').textContent = '回答を作成中…';
  $('conversation').setAttribute('aria-busy', 'true');
  $('aiStatus').textContent = 'GPT が質問を確認し、必要な MCP ツールを呼び出しています…';
  try {
    const request = session.begin(question);
    const response = await fetch('/api/chat', { method: 'POST', ...request, cache: 'no-store' });
    const result = await response.json();
    if (currentGeneration !== generation) return;
    if (!response.ok) {const error=new Error(result.error||'genericError');error.status=response.status;throw error;}
    addTurn(question, result.answer);
    session.remember(question, result.answer);
    $('aiRaw').textContent = JSON.stringify({ model: result.model, tool_calls: result.trace, usage: result.usage }, null, 2);
    $('aiStatus').textContent = `MCP ツール ${result.trace.length} 回 / 入力 ${result.usage.input_tokens}・出力 ${result.usage.output_tokens} トークン。架空データに基づく回答です。`;
    $('question').value = '';
  } catch (error) {
    if (currentGeneration === generation) $('aiStatus').textContent = error.name === 'AbortError' ? '処理を中止しました' : translator('ja')(errorKey(error));
  } finally { if (currentGeneration === generation) { $('ask').textContent = '質問を送信'; $('conversation').setAttribute('aria-busy', 'false'); updateSession(); } }
});

window.addEventListener('pagehide', clearSession);
window.addEventListener('pageshow', event => { if (event.persisted) clearSession(); });
try {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error();
  const config = await response.json();
  session.configureLocal({available:config.local_key_available===true,model:config.local_model??'gpt-6.1-sol'});
  if(session.source==='local')$('apiModel').value=session.model;
  aiEnabled = config.ai_enabled === true;
  $('apiEndpoint').value = config.endpoint;
  $('aiNotice').textContent = aiEnabled
    ? '架空のオフィスデータを GPT で照会します。質問とツール結果は OpenAI に送信され、API の利用料金が発生します。'
    : '企業サンプルを表示中です。外部 AI への送信は無効です。公開版または架空データで起動した環境で利用してください。';
  $('saveKey').disabled = !aiEnabled;
} catch {
  $('aiNotice').textContent = 'AI 接続の設定を取得できませんでした。ページを再読み込みしてください。';
}
updateSession();
