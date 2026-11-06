// Outside agent app (Step 3a). An ordinary tool-calling LLM agent that holds NO wallet keys and NO funds. It
// connects to the Blindspot wallet with @blindspot/sdk (popup + owner approval + session) and can only ask the
// wallet to run tools.
import { connect, type BlindspotSession } from '@blindspot/sdk';
import { RULES_FIRST, SYSTEM_PROMPT, decryptSecret, encryptSecret, openAiCompatibleLlm, runAgentWith, scriptedLlm, type EncryptedKey, type LlmAdapter, type LlmResponse, type ScriptStep } from '@blindspot/core';
import cfg from '../../../config/sepolia.json';

declare const __AGENT__: { walletUrl: string };
const WALLET_URL = __AGENT__.walletUrl;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ------------------------------------------------------------------ models
type ModelChoice = { label: string; url: string; model: string; keyName: string; keyRequired: boolean; extraBody?: Record<string, unknown> };
const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
const MODELS: Record<string, ModelChoice> = {
  'groq-120b': { label: 'Groq · openai/gpt-oss-120b (default)', url: GROQ, model: 'openai/gpt-oss-120b', keyName: 'groq', keyRequired: true, extraBody: { reasoning_format: 'hidden' } },
  'groq-20b': { label: 'Groq · openai/gpt-oss-20b', url: GROQ, model: 'openai/gpt-oss-20b', keyName: 'groq', keyRequired: true, extraBody: { reasoning_format: 'hidden' } },
  custom: { label: 'Custom OpenAI-compatible endpoint (incl. local)', url: '', model: '', keyName: 'custom', keyRequired: false },
};
const choice = (): ModelChoice => {
  const c = MODELS[$<HTMLSelectElement>('model').value]!;
  return c.keyName === 'custom' ? { ...c, url: $<HTMLInputElement>('customUrl').value.trim(), model: $<HTMLInputElement>('customModel').value.trim() } : c;
};

// ------------------------------------------------------------------ AI key (encrypted in this browser, memory-only when unlocked)
const keyStoreName = (k: string) => `blindspot.agent.aiKey.${k}`;
const unlockedKeys = new Map<string, string>();
const storedKey = (k: string): EncryptedKey | undefined => {
  try {
    const s = localStorage.getItem(keyStoreName(k));
    return s ? (JSON.parse(s) as EncryptedKey) : undefined;
  } catch {
    return undefined;
  }
};
function renderKey() {
  const c = choice();
  $('customRow').style.display = c.keyName === 'custom' ? '' : 'none';
  const k = c.keyName;
  $('keyState').innerHTML = unlockedKeys.has(k) ? `<span class="ok">AI key unlocked</span> (memory only)` : storedKey(k) ? 'AI key stored encrypted — enter your passphrase and unlock' : c.keyRequired ? 'No AI key yet — paste it once (encrypted with your passphrase)' : 'Optional for this endpoint (many local servers need no key)';
  $('aiKeyRow').style.display = storedKey(k) ? 'none' : '';
  $('aiUnlockRow').style.display = unlockedKeys.has(k) || !storedKey(k) ? 'none' : '';
  if ($('hint')) renderSteps(); // keep the setup steps / chat box in sync after every key change
}
$('model').onchange = renderKey;
function keyMsg(text: string, cls = 'bad') {
  $('keyMsg').className = `field-msg ${cls}`;
  $('keyMsg').textContent = text;
  $('keyMsg').style.display = text ? '' : 'none';
}
/** Disables a button and shows a busy label while `fn` runs (no double clicks). */
async function busy(btn: HTMLButtonElement, label: string, fn: () => Promise<void>) {
  if (btn.disabled) return;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}
$('saveKey').onclick = () =>
  void busy($<HTMLButtonElement>('saveKey'), 'Saving…', async () => {
    const c = choice();
    const secret = $<HTMLInputElement>('aiKey').value.trim();
    const pass = $<HTMLInputElement>('aiPass').value;
    if (!secret) return (keyMsg(c.keyName === 'groq' ? 'Paste your Groq API key first (it starts with gsk_).' : 'Paste the API key first.'), $('aiKey').focus());
    if (pass.length < 8) return (keyMsg('Choose a password with at least 8 characters — it encrypts the key in this browser.'), $('aiPass').focus());
    try {
      localStorage.setItem(keyStoreName(c.keyName), JSON.stringify(await encryptSecret(secret, pass)));
      unlockedKeys.set(c.keyName, secret);
      $<HTMLInputElement>('aiKey').value = '';
      $<HTMLInputElement>('aiPass').value = '';
      keyMsg('');
      note('AI key saved (encrypted in this browser) and unlocked for this tab.', 'ok');
    } catch (e) {
      keyMsg(`Could not save the key: ${(e as Error).message}`);
    }
    renderKey();
  });
$('unlockKey').onclick = () =>
  void busy($<HTMLButtonElement>('unlockKey'), 'Unlocking…', async () => {
    const k = choice().keyName;
    const pass = $<HTMLInputElement>('aiUnlockPass').value;
    if (!pass) return (keyMsg('Enter the password you chose when you saved the AI key.'), $('aiUnlockPass').focus());
    try {
      unlockedKeys.set(k, await decryptSecret(storedKey(k)!, pass));
      $<HTMLInputElement>('aiUnlockPass').value = '';
      keyMsg('');
    } catch {
      keyMsg('Wrong password. Try again, or click Remove and paste the key again.');
      $<HTMLInputElement>('aiUnlockPass').select();
    }
    renderKey();
  });
$('forgetKey').onclick = () => {
  const k = choice().keyName;
  if (!confirm('Remove the saved AI key from this browser? You can paste it again any time.')) return;
  localStorage.removeItem(keyStoreName(k));
  unlockedKeys.delete(k);
  keyMsg('AI key removed. Paste a key to continue.', 'ok');
  renderKey();
};
const onEnter = (id: string, btn: string) =>
  $(id).addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') $(btn).click();
  });
onEnter('aiKey', 'saveKey');
onEnter('aiPass', 'saveKey');
onEnter('aiUnlockPass', 'unlockKey');

// ------------------------------------------------------------------ guided start
let showSetup = false;
/** True once the first task was sent: from then on the chat stays on screen (setup shrinks to the two step cards). */
let hasChat = false;
let wasReady = false;
function renderSteps() {
  const connected = Boolean(session && !session.endedBy);
  const c = choice();
  const keyOk = !c.keyRequired || unlockedKeys.has(c.keyName);
  const ready = connected && keyOk;
  $('hero').style.display = ready && !showSetup ? 'none' : '';
  $('hero').classList.toggle('compact', hasChat);
  if (hasChat && wasReady && !ready) setTimeout(() => $('setup').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  wasReady = ready;
  $('s1').classList.toggle('done', connected);
  $('s2').classList.toggle('done', keyOk);
  $('connect2').style.display = connected ? 'none' : '';
  $('s1done').style.display = connected ? '' : 'none';
  $('aiPill').style.display = keyOk ? '' : 'none';
  ($('run') as HTMLButtonElement).disabled = running || connecting;
  (document.querySelector('footer') as HTMLElement).style.display = '';
  $('hint').textContent = !keyOk ? 'Add your AI key (step 2) — then just type a task.' : !connected ? 'Type a task and press Send — Blindspot opens to connect (or type /connect).' : 'Your Blindspot wallet checks every payment against your rules before anything is sent.';
  $('s1').classList.toggle('now', !connected);
  $('s2').classList.toggle('now', connected && !keyOk);
}
$('connect2').onclick = () => $('connect').click();
$('aiPill').onclick = () => {
  showSetup = !showSetup;
  renderSteps();
};

// ------------------------------------------------------------------ wallet session (@blindspot/sdk)
let session: BlindspotSession | null = null;
let lastEnded: string | null = null;

function renderSession() {
  const s = session && !session.endedBy ? session : null;
  $('session').innerHTML = s
    ? `<span class="ok">●</span> ${esc(s.ensName)}`
    : lastEnded
      ? `<span class="warn">●</span> Disconnected (${esc(lastEnded)})`
      : 'Not connected';
  $('disconnect').style.display = s ? '' : 'none';
  $('connect').style.display = s ? 'none' : '';
  renderSteps();
}
function connectError(e: unknown): string {
  const m = (e as Error).message ?? String(e);
  if (/did not load in time/i.test(m)) return `The wallet did not open. Make sure it is running (${WALLET_URL} — "corepack pnpm --filter @blindspot/wallet serve"), then click Connect Blindspot again.`;
  if (/blocked the wallet popup/i.test(m)) return 'Your browser blocked the wallet window. Allow pop-ups for this site (icon in the address bar), then click Connect Blindspot again.';
  if (/closed before/i.test(m)) return 'The wallet window was closed before you approved. Click Connect Blindspot to try again.';
  if (/rejected the connection/i.test(m)) return 'You rejected the connection in the wallet. Click Connect Blindspot to try again.';
  return m;
}
let connecting = false;
/** One status line for the wallet connection, updated in place instead of piling up notes. */
let connLi: HTMLLIElement | null = null;
function connStatus(text: string, cls = '') {
  const reusable = connLi && connLi.isConnected && (connLi === $('log').lastElementChild || (workEl !== null && connLi.nextElementSibling === workEl));
  if (!reusable) {
    connLi = add(`sys ${cls}`, esc(text));
    return;
  }
  connLi!.className = `msg sys ${cls}`;
  connLi!.textContent = text;
  if ($('hero').style.display !== 'none') {
    $('setupMsg').className = `setup-msg sys ${cls}`;
    $('setupMsg').textContent = text;
    $('setupMsg').style.display = '';
  }
}
/** The SDK call. Must start from a click / Enter (browsers only open pop-ups then): the Connect buttons, or Send. */
async function doConnect(): Promise<boolean> {
  if (connecting) return false;
  connecting = true;
  let ok = false;
  for (const id of ['connect', 'connect2']) {
    ($(id) as HTMLButtonElement).disabled = true;
    $(id).textContent = id === 'connect2' ? 'connect() — waiting for approval…' : 'Waiting for approval…';
  }
  connStatus('Opening your Blindspot wallet — approve the request there.');
  try {
    const s = await connect({ walletUrl: WALLET_URL, agentName: 'Blindspot example agent', features: 'popup,width=420,height=740' });
    session = s;
    lastEnded = null;
    s.onEnded((reason) => {
      lastEnded = reason;
      renderSession();
      const why: Record<string, string> = { closed: 'the wallet window was closed', locked: 'the wallet was locked', revoked: 'you disconnected it in the wallet', disconnected: 'you disconnected' };
      connStatus(`Wallet disconnected — ${why[reason] ?? reason}. Click Connect Blindspot to continue.`, 'warn');
    });
    connStatus(`Connected to ${s.ensName}.`, 'ok');
    ok = true;
    if (document.body.classList.contains('dev')) add('step', `Rules read at session start${tech(s.rules)}`);
  } catch (e) {
    connStatus(`Not connected — ${connectError(e)}`, 'bad');
  } finally {
    connecting = false;
    ($('connect') as HTMLButtonElement).disabled = false;
    ($('connect2') as HTMLButtonElement).disabled = false;
    $('connect').textContent = 'Connect Blindspot';
    $('connect2').textContent = '▶ Run connect()';
  }
  renderSession();
  return ok;
}
$('connect').onclick = () => void doConnect();
$('disconnect').onclick = () => {
  session?.disconnect();
  renderSession();
};

// ------------------------------------------------------------------ chat log (plain words; technical details folded)
const STEP: Record<string, string> = {
  get_rules: 'Reading your rules',
  get_balances: 'Checking balances',
  resolve_name: 'Looking up a name',
  token_info: 'Checking a token',
  read_document: 'Reading the document',
  read_repo: 'Reading the repository',
  run_script: 'Running a script (sandboxed)',
  propose: 'Asking the wallet to check a payment',
  execute: 'Sending — approve it in your wallet',
};
function add(cls: string, html: string): HTMLLIElement | null {
  $('empty').style.display = 'none';
  // Status notes during setup show inside the setup steps, so the steps stay visible.
  if (cls.startsWith('sys') && $('hero').style.display !== 'none') {
    $('setupMsg').className = `setup-msg ${cls}`;
    $('setupMsg').innerHTML = html;
    $('setupMsg').style.display = '';
    if (!hasChat) return null; // before the first task, setup notes live in the setup box only (no duplicates)
  }
  if (cls === 'user') {
    hasChat = true;
    $('hero').style.display = 'none';
  }
  const li = document.createElement('li');
  li.className = `msg ${cls}`;
  li.innerHTML = html;
  $('log').appendChild(li);
  if (workEl) $('log').appendChild(workEl); // the "working" line stays last
  (workEl ?? li).scrollIntoView({ behavior: 'smooth', block: 'end' });
  return li;
}
// ------------------------------------------------------------------ "agent is working" line (what it does + elapsed time)
let workEl: HTMLLIElement | null = null;
let workTimer: ReturnType<typeof setInterval> | undefined;
let workStart = 0;
let workLabel = '';
function working(label: string | null) {
  if (label === null) {
    clearInterval(workTimer);
    workEl?.remove();
    workEl = null;
    return;
  }
  workLabel = label;
  if (!workEl) {
    workEl = document.createElement('li');
    workEl.className = 'msg working';
    $('log').appendChild(workEl);
    workStart = Date.now();
    workTimer = setInterval(paintWork, 1000);
  }
  paintWork();
  workEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
}
function paintWork() {
  if (workEl) workEl.innerHTML = `<span class="spin"></span>${esc(workLabel)} <span class="muted">${Math.round((Date.now() - workStart) / 1000)} s</span>`;
}
/** Technical details: only visible in presenter mode (?dev or Ctrl+Shift+D). The wallet shows the real detail. */
const tech = (body: string) => `<details class="tech"><summary>details</summary><pre>${esc(body)}</pre></details>`;
function note(text: string, cls = '') {
  add(`sys ${cls}`, esc(text));
}
const DONE: Record<string, string> = {
  get_rules: '✓ Read your rules',
  get_balances: '✓ Checked balances',
  resolve_name: '✓ Looked up the name',
  token_info: '✓ Checked the token',
  read_document: '✓ Read the document',
  read_repo: '✓ Read the repository',
  run_script: '✓ Ran the script (sandboxed)',
};
/** Tool lines waiting for their result (one line per step, updated when the wallet answers). */
const pendingSteps = new Map<string, HTMLLIElement[]>();
function logReply(res: LlmResponse, step: number, scripted: boolean) {
  const m = res.meta;
  const meta = `step ${step} · model ${res.model}${m ? ` · request ${m.requestId} · ${m.usage.total} tokens · ${m.latencyMs} ms` : ''}`;
  const badge = scripted ? '<span class="badge">SCRIPTED</span> ' : '';
  if (!res.toolCalls.length) {
    if (res.content) add('assistant', `${badge}${esc(res.content)}${tech(`${meta}${m ? `\n\n${m.raw}` : ''}`)}`);
    return;
  }
  for (const c of res.toolCalls) {
    const li = add('step pending', `${badge}${esc(STEP[c.name] ?? c.name)}…${tech(`${meta}\n${c.name}(${c.arguments})`)}`);
    if (li) pendingSteps.set(c.name, [...(pendingSteps.get(c.name) ?? []), li]);
  }
}
/** The wallet's answer to a step, in a few words (the full story is in the wallet). */
function logTool(name: string, content: string) {
  let line = DONE[name] ?? '✓ Done';
  let cls = 'step';
  let html = false;
  try {
    const j = JSON.parse(content) as Record<string, any>;
    if (j.error) {
      line = `✕ ${String(j.error).slice(0, 140)}`;
      cls = 'step bad';
    } else if (name === 'propose') {
      if (j.verdict === 'ALLOW') line = '✓ Your wallet checked the payment';
      else if (j.verdict === 'BLOCK') ((line = '✕ Your wallet blocked this payment — open the wallet to see why'), (cls = 'step bad'));
      else ((line = '⚠ This payment needs your OK in the wallet'), (cls = 'step warn'));
    } else if (name === 'execute') {
      html = true;
      if (j.status === 'sent') ((line = `✓ Payment sent — <a href="https://sepolia.etherscan.io/tx/${esc(j.tx)}" target="_blank" rel="noopener">view transaction</a>`), (cls = 'step ok'));
      else if (j.status === 'simulated') line = '✓ Simulated — nothing was sent';
      else ((line = `Payment not sent${j.reason ? ` — ${esc(String(j.reason).slice(0, 120))}` : ''}`), (cls = 'step warn'));
    }
  } catch {
    /* plain text result */
  }
  const body = `${html ? line : esc(line)}${tech(content)}`;
  const li = pendingSteps.get(name)?.shift();
  if (li) {
    li.className = `msg ${cls}`;
    li.innerHTML = body;
  } else add(cls, body);
}

// ------------------------------------------------------------------ AI requests: retry network hiccups, explain failures
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** fetch for the AI endpoint: a dropped or changed connection (e.g. Wi-Fi switch, ERR_NETWORK_CHANGED) and
 *  "busy" answers (429 / 502 / 503 / 504) are retried a few times before giving up. Nothing else is retried. */
async function aiFetch(url: string, init: RequestInit): Promise<Response> {
  const delays = [1500, 3000, 6000];
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (![429, 502, 503, 504].includes(res.status) || attempt >= delays.length) return res;
      const wait = Math.min(Number(res.headers.get('retry-after')) * 1000 || delays[attempt]!, 20_000);
      note(`The AI service is busy (HTTP ${res.status}) — retrying in ${Math.round(wait / 1000)} s (${attempt + 1}/${delays.length})…`, 'warn');
      await sleep(wait);
    } catch (e) {
      if ((e as Error).name === 'AbortError' || attempt >= delays.length) throw e;
      note(`Connection to the AI service dropped — retrying (${attempt + 1}/${delays.length})…`, 'warn');
      await sleep(delays[attempt]!);
    }
  }
}
/** Agent / AI errors in plain words. */
function friendlyError(m: string): string {
  if (/failed to fetch|networkerror|load failed|network ?changed/i.test(m)) return 'Could not reach the AI service — your internet connection dropped or changed. Check the connection and press Send again.';
  if (/abort/i.test(m)) return 'The AI service took too long to answer. Press Send to try again.';
  if (/HTTP 401|invalid api key/i.test(m)) return 'The AI key was rejected. Click “AI ready” at the top, remove the key and paste a valid one.';
  if (/HTTP 429/i.test(m)) return 'The AI service is rate-limiting this key. Wait a minute, then press Send again.';
  if (/HTTP 5\d\d/i.test(m)) return 'The AI service is having problems right now. Try again in a moment.';
  return m;
}

// ------------------------------------------------------------------ run
let running = false;
async function run(scripted: boolean) {
  if (running || connecting) return;
  const typed = $<HTMLTextAreaElement>('task').value.trim();
  // Chat commands: the SDK straight from the chat box.
  if (!scripted && /^\/connect$/i.test(typed)) {
    $<HTMLTextAreaElement>('task').value = '';
    if (session && !session.endedBy) return note(`Already connected to ${session.ensName}.`, 'ok');
    add('user', 'connect()');
    return void doConnect();
  }
  if (!scripted && /^\/disconnect$/i.test(typed)) {
    $<HTMLTextAreaElement>('task').value = '';
    if (!session || session.endedBy) return note('Not connected.', 'warn');
    session.disconnect();
    renderSession();
    return connStatus('Disconnected. Send a task (or type /connect) to connect again.', 'warn');
  }
  if (!scripted && !typed) return note('Type what the agent should do first — e.g. “Pay this week\'s invoice from vendor1 (document invoice-0101)”.', 'warn');
  if (!scripted) {
    const c = choice();
    if (!/^https?:\/\//.test(c.url) || !c.model) return note('Set the AI endpoint URL and model name first (step 2).', 'bad');
    if (c.keyRequired && !unlockedKeys.has(c.keyName)) {
      showSetup = true;
      renderSteps();
      setTimeout(() => $('s2').scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
      return keyMsg(storedKey(c.keyName) ? 'Unlock your AI key here first, then press Send again.' : 'Add your AI key here first, then press Send again.');
    }
  }
  let userShown = false;
  // Not connected yet: this Send click calls the SDK (connect → wallet pop-up → approve), then the task continues.
  if (!session || session.endedBy) {
    add('user', esc(typed || 'Scripted demo: pay invoice-0101'));
    userShown = true;
    if (!(await doConnect())) return;
    showSetup = false;
    renderSteps();
  }
  const s = session && !session.endedBy ? session : null;
  if (!s) return;
  let llm: LlmAdapter;
  if (scripted) {
    const usdc = cfg.ens.MockUSDC;
    const vendor1 = cfg.payees.vendor1;
    const script: ScriptStep[] = [
      { tool: 'get_rules' },
      { tool: 'read_document', args: { url: 'invoice-0101' } },
      { tool: 'resolve_name', args: { name: 'vendor1.blindspot-demo.eth' } },
      { tool: 'propose', args: { actions: [{ type: 'transfer', token: usdc, to: vendor1, amount: '12' }], declared_effects: [{ kind: 'out', token: usdc, amount: '12', counterparty: vendor1 }], reason: 'Pay invoice-0101 (12 MockUSDC to vendor1)' } },
      { tool: 'execute', args: { proposal_id: '$lastProposalId' } },
      { final: 'Done with invoice-0101.' },
    ];
    llm = scriptedLlm(script);
  } else {
    const c = choice();
    if (!/^https?:\/\//.test(c.url) || !c.model) return note('Set the endpoint URL and model name.', 'bad');
    const apiKey = unlockedKeys.get(c.keyName);
    if (c.keyRequired && !apiKey) return note('Unlock (or add) the AI key first.', 'bad');
    llm = openAiCompatibleLlm({ url: c.url, model: c.model, fetch: (u, i) => aiFetch(u, i), timeoutMs: 90_000, ...(apiKey ? { apiKey } : {}), ...(c.extraBody ? { extraBody: c.extraBody } : {}) });
  }
  running = true;
  ($('run') as HTMLButtonElement).disabled = true;
  $('run').textContent = 'Working…';
  ($('runScripted') as HTMLButtonElement).disabled = true;
  const task = $<HTMLTextAreaElement>('task').value.trim();
  if (!userShown) add('user', esc(task || 'Scripted demo: pay invoice-0101'));
  if (scripted) note('Demo mode: recorded steps replace the AI model; your wallet still checks everything for real.', 'warn');
  working(scripted ? 'Starting the scripted run…' : 'The AI is thinking…');
  try {
    const r = await runAgentWith((name, args) => s.callTool(name, args), llm, task, {
      tools: s.tools,
      systemPrompt: `${SYSTEM_PROMPT} ${RULES_FIRST}`,
      preamble: [s.rulesMessage()],
      hooks: {
        onModelReply: (res, step) => {
          logReply(res, step, scripted);
          const t = res.toolCalls[0]?.name;
          if (t) working(t === 'execute' ? 'Waiting for your approval in the wallet window…' : t === 'propose' ? 'The wallet is simulating and checking the payment…' : `${STEP[t] ?? t} (privately, through the wallet)…`);
        },
        onToolResult: (name, content) => {
          logTool(name, content);
          working(scripted ? 'Next step…' : 'The AI is thinking about the next step…');
        },
      },
    });
    if (r.stoppedBy === 'final') $<HTMLTextAreaElement>('task').value = '';
    if (r.stoppedBy !== 'final') note(r.stoppedBy === 'stopped' ? `Stopped: ${r.error}` : r.stoppedBy === 'stepLimit' ? 'Stopped: too many steps.' : friendlyError(r.error ?? 'unknown error'), r.stoppedBy === 'stopped' ? 'warn' : 'bad');
  } catch (e) {
    note(friendlyError((e as Error).message), 'bad');
  } finally {
    working(null);
    running = false;
    renderSteps();
    $('run').textContent = 'Send';
    ($('runScripted') as HTMLButtonElement).disabled = false;
  }
}
$('run').onclick = () => void run(false);
$('runScripted').onclick = () => void run(true);

for (const [id, m] of Object.entries(MODELS)) {
  const o = document.createElement('option');
  o.value = id;
  o.textContent = m.label;
  $('model').appendChild(o);
}
document.querySelectorAll<HTMLButtonElement>('[data-task]').forEach((b) => (b.onclick = () => ($<HTMLTextAreaElement>('task').value = b.dataset.task ?? '')));
$<HTMLTextAreaElement>('task').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void run(false);
  }
});
const toggleDev = (on?: boolean) => {
  const p = $('devPanel');
  p.style.display = (on ?? p.style.display === 'none') ? '' : 'none';
  document.body.classList.toggle('dev', p.style.display === '');
};
if (new URLSearchParams(location.search).has('dev')) toggleDev(true);
addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    toggleDev();
  }
});
$<HTMLSelectElement>('model').value = 'groq-120b'; // default every load (browsers restore old form values)
addEventListener('unhandledrejection', (e) => note(`Something went wrong: ${(e.reason as Error)?.message ?? e.reason}`, 'bad'));
addEventListener('error', (e) => note(`Something went wrong: ${e.message}`, 'bad'));
renderKey();
renderSession();
renderSteps();
