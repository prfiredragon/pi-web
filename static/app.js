'use strict';

// ============================================================
// AUTH & API HELPERS
// ============================================================
const TOKEN_PARAMS = new URLSearchParams(location.search);
const TOKEN = TOKEN_PARAMS.get('token') || localStorage.getItem('piweb-token') || '';
if (TOKEN) localStorage.setItem('piweb-token', TOKEN);

function qs(extra = {}) {
  const p = new URLSearchParams(extra);
  if (TOKEN) p.set('token', TOKEN);
  const s = p.toString();
  return s ? `?${s}` : '';
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

async function api(path, opts = {}) {
  const { query, ...rest } = opts;
  const p = new URLSearchParams(query || {});
  if (TOKEN) p.set('token', TOKEN);
  const s = p.toString();
  const res = await fetch(path + (s ? `?${s}` : ''), {
    headers: { 'content-type': 'application/json' },
    ...rest,
  });
  const data = await res.json().catch(() => ({ error: 'bad json' }));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortenPath(p) {
  if (typeof p !== 'string') return '';
  if (p.startsWith('/home/')) {
    const parts = p.split('/');
    if (parts.length > 2) return '~' + p.slice(('/home/' + parts[2]).length);
  }
  if (p.startsWith('/Users/')) {
    const parts = p.split('/');
    if (parts.length > 2) return '~' + p.slice(('/Users/' + parts[2]).length);
  }
  return p;
}

function formatTokens(count) {
  if (count == null || isNaN(count)) return '0';
  if (count < 1000) return String(count);
  if (count < 10000) return (count / 1000).toFixed(1) + 'k';
  if (count < 1000000) return Math.round(count / 1000) + 'k';
  return (count / 1000000).toFixed(1) + 'M';
}

function formatTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

async function copyText(text, btn) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = '✓ Copied';
      setTimeout(() => { btn.textContent = prev; }, 1400);
    }
  } catch (e) {
    showToast('Copy failed: ' + e, 'error');
  }
}

function showToast(message, type = 'info', duration = 4200) {
  const box = $('#toast-container');
  const t = el('div', `toast ${type}`, message);
  box.appendChild(t);
  setTimeout(() => {
    t.remove();
  }, duration);
}

// ============================================================
// MARKDOWN CONFIGURATION
// ============================================================
if (window.marked) {
  window.marked.use({
    breaks: true,
    gfm: true,
    tokenizer: {
      html() { return undefined; },
      tag() { return undefined; },
    },
    renderer: {
      code(token) {
        const lang = escapeHtml(token.lang || 'text');
        const codeEsc = escapeHtml(token.text || '');
        const encoded = encodeURIComponent(token.text || '');
        return `<div class="code-block-wrap">
          <div class="code-block-bar">
            <span>${lang}</span>
            <button type="button" class="code-copy-btn" data-copy="${encoded}">Copy</button>
          </div>
          <pre><code>${codeEsc}</code></pre>
        </div>`;
      },
      codespan(token) {
        return `<code>${escapeHtml(token.text)}</code>`;
      },
      link(token) {
        const href = String(token.href || '').trim();
        if (!/^(https?:|mailto:|\/|#)/i.test(href)) {
          return escapeHtml(token.text || '');
        }
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${this.parser.parseInline(token.tokens)}</a>`;
      },
    },
  });
}

function renderMarkdown(md) {
  if (!md) return '';
  if (window.marked) {
    try {
      return window.marked.parse(String(md));
    } catch {
      return `<pre>${escapeHtml(md)}</pre>`;
    }
  }
  return `<div style="white-space:pre-wrap">${escapeHtml(md)}</div>`;
}

// Delegate copy buttons inside transcript
document.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('.code-copy-btn');
  if (copyBtn && copyBtn.dataset.copy !== undefined) {
    copyText(decodeURIComponent(copyBtn.dataset.copy), copyBtn);
  }
});

// ============================================================
// APPLICATION STATE
// ============================================================
let currentSession = null;
let sessionSocket = null;
let globalSocket = null;

let sessionState = {
  isStreaming: false,
  isCompacting: false,
  thinkingLevel: 'medium',
  model: null,
  sessionName: null,
  sessionId: null,
  sessionFile: null,
  cwd: '',
  messageCount: 0,
  pendingMessageCount: 0,
  autoCompactionEnabled: true,
  steeringMode: 'one-at-a-time',
  followUpMode: 'one-at-a-time',
};

let availableModels = [];
let availableCommands = [];
let availableThinkingLevels = ['off', 'minimal', 'low', 'medium', 'high'];
let pendingImages = []; // Array of { type: 'image', data: base64, mimeType }
let activeQueue = { steering: [], followUp: [] };

// Extension UI state
const extStatuses = new Map();
const extWidgetsAbove = new Map();
const extWidgetsBelow = new Map();
let activeModalId = null;
let activeModalTimer = null;

// Tree state
let sessionTreeData = { tree: [], leafId: null };
let treeFilter = 'default';
let treeSearchQuery = '';

// Live streaming trackers
let currentAssistant = null; // { el, blocksContainer, blocks: [], toolEls: Map }
const toolElementsById = new Map(); // toolCallId -> DOM element & state
const bashCardsById = new Map(); // reqId -> DOM element & output buffer
let activeBashRunning = false;

// Built-in client slash commands
const BUILTIN_SLASH_COMMANDS = [
  { name: 'new', source: 'builtin', description: 'Start a fresh conversation in this session' },
  { name: 'compact', source: 'builtin', description: 'Compact conversation context (optional instructions)' },
  { name: 'clone', source: 'builtin', description: 'Clone current active branch into a new session' },
  { name: 'name', source: 'builtin', description: 'Set session display name: /name <title>' },
  { name: 'export', source: 'builtin', description: 'Export session as standalone Pi HTML' },
  { name: 'tree', source: 'builtin', description: 'Open the Conversation Tree sidebar tab' },
  { name: 'clear', source: 'builtin', description: 'Clear queued steering & follow-up messages' },
];

// ============================================================
// STATUS & HEADER UPDATES
// ============================================================
function setAppStatus(state, label) {
  const pill = $('#status-pill');
  const txt = $('#status');
  pill.dataset.state = state;
  txt.textContent = label || state;

  const runBanner = $('#run-banner');
  const runText = $('#run-banner-text');
  if (state === 'running' || state === 'compacting' || state === 'retrying') {
    runBanner.hidden = false;
    if (state === 'compacting') runText.textContent = 'Compacting conversation context…';
    else if (state === 'retrying') runText.textContent = label || 'Retrying after transient error…';
    else runText.textContent = label || 'Pi is working…';
  } else {
    runBanner.hidden = !activeBashRunning;
    if (activeBashRunning) {
      runText.textContent = 'Running bash command…';
    }
  }
  updateComposerModeUI();
}

function updateComposerModeUI() {
  const composer = $('#composer');
  const inputVal = $('#input').value;
  const sendMode = $('#send-mode');
  const indicator = $('#mode-indicator');
  const sendBtn = $('#send-btn');
  const hint = $('#send-kbd-hint');

  composer.dataset.thinking = sessionState.thinkingLevel || 'medium';

  if (inputVal.startsWith('!!')) {
    composer.dataset.mode = 'bash_silent';
    indicator.textContent = 'Bash (omit from LLM context)';
    sendBtn.textContent = 'Run !!Bash';
  } else if (inputVal.startsWith('!')) {
    composer.dataset.mode = 'bash';
    indicator.textContent = 'Bash (output added to next prompt)';
    sendBtn.textContent = 'Run !Bash';
  } else if (sendMode.value === 'bash' || sendMode.value === 'bash_silent') {
    composer.dataset.mode = sendMode.value;
    indicator.textContent = sendMode.value === 'bash_silent' ? 'Bash (no context)' : 'Bash (in context)';
    sendBtn.textContent = 'Run Bash';
  } else if (sessionState.isStreaming) {
    composer.dataset.mode = 'streaming';
    indicator.textContent = 'Agent busy — Enter steers, Alt+Enter queues follow-up';
    sendBtn.textContent = sendMode.value === 'follow_up' ? 'Queue Follow-up' : 'Steer';
    hint.textContent = 'Enter: Steer · Alt+Enter: Follow-up · Esc: Abort';
  } else {
    composer.dataset.mode = sendMode.value;
    indicator.textContent = `Thinking: ${sessionState.thinkingLevel || 'medium'}`;
    sendBtn.textContent = sendMode.value === 'prompt' ? 'Send' : sendMode.value === 'steer' ? 'Steer' : 'Follow-up';
    hint.textContent = 'Enter to send · Shift+Enter newline · ! for bash · / for commands';
  }
}

// ============================================================
// SESSIONS MANAGEMENT
// ============================================================
async function refreshSessions() {
  try {
    const data = await api('/sessions');
    const list = $('#session-list');
    const sel = $('#session-select');
    list.innerHTML = '';
    sel.innerHTML = '';

    if (!data.sessions.length) {
      list.appendChild(el('li', 'empty-hint', 'No running sessions. Click "+ Session" to start one.'));
      return;
    }

    for (const s of data.sessions) {
      const li = el('li', 'session-item' + (s.id === currentSession ? ' active' : ''));
      const top = el('div', 'session-item-top');
      const titleText = s.name ? `${s.name} (${s.id})` : s.id;
      top.appendChild(el('span', 'session-item-title', titleText));
      top.appendChild(el('span', 'session-meta', s.alive ? '● live' : '○ closed'));
      li.appendChild(top);
      li.appendChild(el('div', 'session-meta', shortenPath(s.cwd)));
      li.addEventListener('click', () => selectSession(s.id));
      list.appendChild(li);

      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = `${titleText} — ${shortenPath(s.cwd)}`;
      sel.appendChild(o);
    }

    if (currentSession) sel.value = currentSession;
  } catch (e) {
    console.warn('refreshSessions failed:', e);
  }
}

async function selectSession(id) {
  if (!id) return;
  currentSession = id;
  if (typeof isMobileViewport === 'function' && isMobileViewport()) {
    setSidebarCollapsed(true);
  }
  currentAssistant = null;
  toolElementsById.clear();
  bashCardsById.clear();
  extStatuses.clear();
  extWidgetsAbove.clear();
  extWidgetsBelow.clear();
  renderExtStatusAndWidgets();
  updateQueueBanner({ steering: [], followUp: [] });

  $('#transcript').innerHTML = '';
  await refreshSessions();
  connectSessionSocket(id);

  const err = await api(`/sessions/${id}/stderr`).catch(() => null);
  if (err && Array.isArray(err.stderr)) {
    $('#stderr-out').textContent = err.stderr.length ? err.stderr.join('\n') : '(empty)';
  }
}

function renderState(d) {
  sessionState = { ...sessionState, ...d };

  // Update topbar breadcrumb
  const crumb = $('#session-breadcrumb');
  crumb.hidden = false;
  $('#active-session-name').textContent = d.sessionName || currentSession || d.sessionId || 'session';
  const cwdEl = $('#active-session-cwd');
  cwdEl.textContent = shortenPath(d.cwd || sessionState.cwd || '');
  cwdEl.title = d.cwd || sessionState.cwd || '';

  // Update status pill
  if (d.isCompacting) setAppStatus('compacting', 'compacting…');
  else if (d.isStreaming) setAppStatus('running', 'running…');
  else setAppStatus('idle', 'idle');

  // Update thinking selector
  const th = $('#thinking-select');
  if (d.thinkingLevel) {
    th.value = d.thinkingLevel;
    th.dataset.level = d.thinkingLevel;
  }

  // Update model selector
  if (d.model) {
    syncModelSelectValue(d.model);
  }

  // Update Inspector tab
  const info = $('#session-info');
  info.innerHTML = '';
  const rows = [
    ['Session ID', d.sessionId || currentSession],
    ['Name', d.sessionName || '(none)'],
    ['Working Dir', shortenPath(d.cwd || sessionState.cwd || '')],
    ['Model', d.model ? `${d.model.provider}/${d.model.id}` : '(none)'],
    ['Thinking', d.thinkingLevel || 'off'],
    ['Messages', String(d.messageCount ?? 0)],
    ['Pending Queue', String(d.pendingMessageCount ?? 0)],
    ['Session File', d.sessionFile ? shortenPath(d.sessionFile) : '(in-memory)'],
  ];
  for (const [k, v] of rows) {
    const row = el('div', 'info-kv');
    row.appendChild(el('span', 'info-k', k));
    row.appendChild(el('span', 'info-v', v));
    info.appendChild(row);
  }

  if (typeof d.autoCompactionEnabled === 'boolean') {
    $('#auto-compact-toggle').checked = d.autoCompactionEnabled;
  }
  if (d.steeringMode) $('#steering-mode-select').value = d.steeringMode;
  if (d.followUpMode) $('#followup-mode-select').value = d.followUpMode;

  updateComposerModeUI();
}

function renderStats(d) {
  if (!d) return;
  const ctx = d.contextUsage || {};
  const pct = Math.min(100, Math.max(0, Number(ctx.percent ?? 0)));
  const fill = $('#context-meter-fill');
  fill.style.width = `${pct}%`;
  fill.className = 'context-meter-fill' + (pct >= 85 ? ' crit' : pct >= 65 ? ' warn' : '');

  const costNum = typeof d.cost === 'number' ? d.cost : (d.cost?.total ?? 0);
  const tokStr = ctx.tokens != null
    ? `${formatTokens(ctx.tokens)} / ${formatTokens(ctx.contextWindow)} (${Math.round(pct)}%)`
    : `${formatTokens(d.tokens?.total ?? 0)} tok`;
  $('#usage-hint').textContent = `${tokStr} · $${Number(costNum).toFixed(3)}`;
}

function renderModels(models) {
  availableModels = Array.isArray(models) ? models : [];
  const sel = $('#model-select');
  sel.innerHTML = '';
  if (!availableModels.length) {
    sel.innerHTML = '<option value="">(no models configured)</option>';
    return;
  }

  // Group models by provider
  const byProvider = new Map();
  for (const m of availableModels) {
    const prov = m.provider || 'default';
    if (!byProvider.has(prov)) byProvider.set(prov, []);
    byProvider.get(prov).push(m);
  }

  for (const [prov, list] of byProvider.entries()) {
    const group = document.createElement('optgroup');
    group.label = prov;
    for (const m of list) {
      const o = document.createElement('option');
      o.value = `${m.provider}::${m.id}`;
      const tags = [];
      if (m.reasoning) tags.push('🧠');
      if (Array.isArray(m.input) && m.input.includes('image')) tags.push('🖼');
      if (m.contextWindow) tags.push(formatTokens(m.contextWindow));
      o.textContent = `${m.name || m.id}${tags.length ? ' (' + tags.join(' ') + ')' : ''}`;
      group.appendChild(o);
    }
    sel.appendChild(group);
  }

  if (sessionState.model) {
    syncModelSelectValue(sessionState.model);
  }
}

function syncModelSelectValue(model) {
  if (!model) return;
  const sel = $('#model-select');
  const key = `${model.provider}::${model.id}`;
  if (sel.querySelector(`option[value="${CSS.escape(key)}"]`)) {
    sel.value = key;
  } else {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = `${model.provider}/${model.name || model.id}`;
    sel.prepend(o);
    sel.value = key;
  }
}

function renderThinkingLevels(levels) {
  if (!Array.isArray(levels) || !levels.length) return;
  availableThinkingLevels = levels;
  const sel = $('#thinking-select');
  const current = sessionState.thinkingLevel || sel.value || 'medium';
  sel.innerHTML = '';
  for (const lvl of levels) {
    const o = document.createElement('option');
    o.value = lvl;
    o.textContent = lvl;
    sel.appendChild(o);
  }
  if (levels.includes(current)) {
    sel.value = current;
  }
  sel.dataset.level = sel.value;
}

function renderCommandsList(commands) {
  availableCommands = Array.isArray(commands) ? commands : [];
  updateCommandsTab();
}

function updateCommandsTab() {
  const container = $('#commands-list');
  const q = ($('#commands-search')?.value || '').trim().toLowerCase();
  container.innerHTML = '';

  const all = [...BUILTIN_SLASH_COMMANDS, ...availableCommands];
  const filtered = all.filter((c) =>
    !q || c.name.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q)
  );

  if (!filtered.length) {
    container.appendChild(el('div', 'empty-hint', 'No matching commands found.'));
    return;
  }

  for (const c of filtered) {
    const card = el('div', 'cmd-item');
    const head = el('div', 'cmd-head');
    head.appendChild(el('span', 'cmd-name', `/${c.name}`));
    head.appendChild(el('span', 'cmd-badge', c.source || 'command'));
    card.appendChild(head);
    if (c.description) {
      card.appendChild(el('div', 'cmd-desc', c.description));
    }
    card.addEventListener('click', () => {
      const inp = $('#input');
      inp.value = `/${c.name} `;
      if (isMobileViewport()) setSidebarCollapsed(true);
      inp.focus();
      updateComposerModeUI();
    });
    container.appendChild(card);
  }
}

// ============================================================
// TRANSCRIPT & TOOL EXECUTION RENDERING
// ============================================================
function renderHistory(messages) {
  const t = $('#transcript');
  t.innerHTML = '';
  toolElementsById.clear();

  if (!Array.isArray(messages) || messages.length === 0) {
    const empty = el('div', 'empty-state');
    empty.innerHTML = `
      <div class="empty-logo">π</div>
      <h2>Session Ready (${escapeHtml(shortenPath(sessionState.cwd || ''))})</h2>
      <p>Send a prompt below, type <kbd>/</kbd> for skills &amp; commands, or prefix with <kbd>!</kbd> to run a shell command.</p>
    `;
    t.appendChild(empty);
    return;
  }

  // First pass: index toolResults by toolCallId so assistant toolCalls render with their results paired
  const resultByCallId = new Map();
  for (const m of messages) {
    if (m.role === 'toolResult' && m.toolCallId) {
      resultByCallId.set(m.toolCallId, m);
    }
  }

  for (const m of messages) {
    if (m.role === 'toolResult' && m.toolCallId && resultByCallId.has(m.toolCallId)) {
      // Paired inside assistant message
      continue;
    }
    appendMessage(m, resultByCallId);
  }
  scrollToBottom();
}

function scrollToBottom() {
  const t = $('#transcript');
  t.scrollTop = t.scrollHeight;
}

function parseSkillBlock(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return null;
  return {
    name: match[1],
    location: match[2],
    content: match[3],
    userMessage: match[4]?.trim() || '',
  };
}

function extractTextAndImages(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: String(content ?? ''), images: [] };
  const texts = [];
  const images = [];
  for (const item of content) {
    if (item.type === 'text' && item.text) texts.push(item.text);
    else if (item.type === 'image' && item.data) images.push(item);
  }
  return { text: texts.join('\n'), images };
}

function appendMessage(m, resultByCallId = new Map()) {
  const t = $('#transcript');
  $('#empty-state', t)?.remove();
  $('.empty-state', t)?.remove();

  if (m.role === 'user') {
    const { text, images } = extractTextAndImages(m.content);
    const skill = parseSkillBlock(text);

    if (skill) {
      const scard = el('div', 'skill-card');
      scard.innerHTML = `
        <div class="compaction-title">⚡ Skill loaded: ${escapeHtml(skill.name)} <span style="font-weight:normal;color:var(--muted)">(click to toggle)</span></div>
        <div class="compaction-body markdown-content">${renderMarkdown(skill.content)}</div>
      `;
      scard.addEventListener('click', (e) => {
        if (window.getSelection().toString()) return;
        scard.classList.toggle('expanded');
      });
      t.appendChild(scard);
    }

    const displayUserText = skill ? skill.userMessage : text;
    if (!displayUserText && images.length === 0) return;

    const row = el('div', 'msg user');
    const head = el('div', 'msg-header');
    head.innerHTML = `<span class="msg-role-badge">You</span><span>${formatTime(m.timestamp)}</span>`;
    const actions = el('div', 'msg-actions');
    const copyBtn = el('button', 'ghost xs', 'Copy');
    copyBtn.addEventListener('click', () => copyText(displayUserText, copyBtn));
    actions.appendChild(copyBtn);
    head.appendChild(actions);
    row.appendChild(head);

    if (images.length) {
      const imgWrap = el('div', 'message-images');
      for (const img of images) {
        const i = document.createElement('img');
        i.className = 'message-image';
        i.src = `data:${img.mimeType || 'image/png'};base64,${img.data}`;
        imgWrap.appendChild(i);
      }
      row.appendChild(imgWrap);
    }

    if (displayUserText) {
      const body = el('div', 'msg-body markdown-content');
      body.innerHTML = renderMarkdown(displayUserText);
      row.appendChild(body);
    }
    t.appendChild(row);
    return;
  }

  if (m.role === 'assistant') {
    const row = el('div', 'msg assistant');
    renderCompletedAssistantInto(row, m, resultByCallId);
    t.appendChild(row);
    return;
  }

  if (m.role === 'bashExecution') {
    const card = createBashCard(m.command, m.output, m.exitCode, m.cancelled, m.excludeFromContext, true);
    t.appendChild(card);
    return;
  }

  if (m.role === 'compactionSummary') {
    const card = el('div', 'compaction-card');
    card.innerHTML = `
      <div class="compaction-title">📦 Context Compacted (from ${formatTokens(m.tokensBefore)} tokens — click to view summary)</div>
      <div class="compaction-body markdown-content">${renderMarkdown(m.summary || '')}</div>
    `;
    card.addEventListener('click', () => {
      if (window.getSelection().toString()) return;
      card.classList.toggle('expanded');
    });
    t.appendChild(card);
    return;
  }

  if (m.role === 'branchSummary') {
    const card = el('div', 'compaction-card');
    card.innerHTML = `
      <div class="compaction-title">🌿 Branch Summary (click to view)</div>
      <div class="compaction-body markdown-content">${renderMarkdown(m.summary || '')}</div>
    `;
    card.addEventListener('click', () => {
      if (window.getSelection().toString()) return;
      card.classList.toggle('expanded');
    });
    t.appendChild(card);
    return;
  }

  if (m.role === 'custom') {
    if (m.display === false) return;
    const { text } = extractTextAndImages(m.content);
    const card = el('div', 'compaction-card expanded');
    card.innerHTML = `
      <div class="compaction-title">[${escapeHtml(m.customType || 'extension')}]</div>
      <div class="compaction-body markdown-content">${renderMarkdown(text)}</div>
    `;
    t.appendChild(card);
  }
}

function renderCompletedAssistantInto(row, m, resultByCallId = new Map()) {
  row.innerHTML = '';
  const head = el('div', 'msg-header');
  const modelLabel = m.model ? `${m.provider ? m.provider + '/' : ''}${m.model}` : 'Assistant';
  const tokInfo = m.usage?.totalTokens ? ` · ${formatTokens(m.usage.totalTokens)} tok` : '';
  head.innerHTML = `<span class="msg-role-badge">${escapeHtml(modelLabel)}</span><span>${formatTime(m.timestamp)}${escapeHtml(tokInfo)}</span>`;

  const blocks = Array.isArray(m.content)
    ? m.content
    : typeof m.content === 'string'
      ? [{ type: 'text', text: m.content }]
      : [];

  const fullText = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
  if (fullText) {
    const actions = el('div', 'msg-actions');
    const copyBtn = el('button', 'ghost xs', 'Copy');
    copyBtn.addEventListener('click', () => copyText(fullText, copyBtn));
    actions.appendChild(copyBtn);
    head.appendChild(actions);
  }
  row.appendChild(head);

  for (const b of blocks) {
    if (b.type === 'thinking' && (b.thinking || b.text)) {
      row.appendChild(createThinkingBlock(b.thinking || b.text, false));
    } else if (b.type === 'text' && (b.text || '').trim()) {
      const body = el('div', 'msg-body markdown-content');
      body.innerHTML = renderMarkdown(b.text);
      row.appendChild(body);
    } else if (b.type === 'toolCall' || b.type === 'tool_call') {
      const existingResult = resultByCallId.get(b.id) || toolElementsById.get(b.id)?.result || null;
      const toolCard = createOrUpdateToolCard(b.id, b.name, b.arguments, existingResult, !existingResult);
      row.appendChild(toolCard);
    }
  }

  if (m.stopReason === 'aborted') {
    row.appendChild(el('div', 'error-text', '■ Run aborted'));
  } else if (m.stopReason === 'error' && m.errorMessage) {
    row.appendChild(el('div', 'error-text', `⚠ ${m.errorMessage}`));
  }
}

function createThinkingBlock(text, isStreaming = false) {
  const wrap = el('div', 'thinking-block');
  const header = el('div', 'thinking-header', isStreaming ? '🧠 Thinking…' : '🧠 Reasoning (click to toggle)');
  const body = el('div', 'thinking-text', text || '');
  header.addEventListener('click', () => wrap.classList.toggle('collapsed'));
  wrap.appendChild(header);
  wrap.appendChild(body);
  return wrap;
}

function formatExpandableText(text, maxLines = 10) {
  const clean = String(text ?? '').replace(/\t/g, '   ');
  const lines = clean.split('\n');
  if (lines.length <= maxLines) {
    return `<div class="tool-output"><pre>${escapeHtml(clean)}</pre></div>`;
  }
  const preview = lines.slice(0, maxLines).join('\n');
  const more = lines.length - maxLines;
  return `<div class="tool-output expandable" onclick="if(window.getSelection().toString())return;this.classList.toggle('expanded')">
    <div class="output-preview">
      <pre>${escapeHtml(preview)}</pre>
      <div class="expand-hint">▸ Show ${more} more lines (${lines.length} total)</div>
    </div>
    <div class="output-full">
      <pre>${escapeHtml(clean)}</pre>
      <div class="expand-hint">▾ Collapse output</div>
    </div>
  </div>`;
}

function createOrUpdateToolCard(toolCallId, toolName, args, resultMsg, isPending = false, durationMs = undefined) {
  let entry = toolElementsById.get(toolCallId);
  if (!entry) {
    const dom = el('div', 'tool-execution pending');
    dom.id = `tool-call-${toolCallId}`;
    entry = { el: dom, name: toolName, args: args || {}, result: resultMsg, durationMs };
    toolElementsById.set(toolCallId, entry);
  } else {
    if (toolName) entry.name = toolName;
    if (args && Object.keys(args).length) entry.args = args;
    if (resultMsg) entry.result = resultMsg;
    if (durationMs !== undefined) entry.durationMs = durationMs;
  }

  const dom = entry.el;
  const res = entry.result;
  const isError = res?.isError || false;
  dom.className = `tool-execution ${isPending ? 'pending' : isError ? 'error' : 'success'}`;

  const a = entry.args || {};
  const name = entry.name || 'tool';
  let headerLeftHtml = `<span class="tool-name">${escapeHtml(name)}</span>`;

  if (name === 'bash') {
    headerLeftHtml = `<span class="tool-command">$ ${escapeHtml(a.command || '…')}</span>`;
  } else if (name === 'read' || name === 'write' || name === 'edit') {
    const p = shortenPath(String(a.path || a.file_path || ''));
    const range = a.offset ? `:${a.offset}${a.limit ? '-' + (Number(a.offset) + Number(a.limit) - 1) : ''}` : '';
    headerLeftHtml = `<span class="tool-name">${escapeHtml(name)}</span> <span class="tool-path">${escapeHtml(p + range)}</span>`;
  } else if (name === 'grep' || name === 'find' || name === 'ls') {
    const p = shortenPath(String(a.path || '.'));
    const pat = a.pattern ? ` /${a.pattern}/` : '';
    headerLeftHtml = `<span class="tool-name">${escapeHtml(name)}</span> <span class="tool-path">${escapeHtml(pat + ' ' + p)}</span>`;
  }

  const statusBadge = isPending
    ? '⏳ running…'
    : `${isError ? '✗ error' : '✓ ok'}${entry.durationMs != null ? ` · ${entry.durationMs}ms` : ''}`;

  let bodyHtml = '';
  if (name === 'write' && a.content) {
    bodyHtml += formatExpandableText(a.content, 10);
  } else if (name !== 'bash' && name !== 'read' && name !== 'write' && name !== 'edit' && name !== 'ls' && Object.keys(a).length) {
    bodyHtml += formatExpandableText(JSON.stringify(a, null, 2), 6);
  }

  if (res) {
    const { text: outText, images: outImages } = extractTextAndImages(res.content);
    if (outImages.length) {
      bodyHtml += '<div class="tool-images">' +
        outImages.map((img) => `<img class="tool-image" src="data:${escapeHtml(img.mimeType || 'image/png')};base64,${escapeHtml(img.data)}" />`).join('') +
        '</div>';
    }
    if (name === 'edit' && res.details?.diff) {
      const diffLines = String(res.details.diff).split('\n');
      bodyHtml += '<div class="tool-diff">' +
        diffLines.map((line) => {
          const cls = line.startsWith('+') ? 'diff-added' : line.startsWith('-') ? 'diff-removed' : 'diff-context';
          return `<div class="${cls}">${escapeHtml(line)}</div>`;
        }).join('') +
        '</div>';
    } else if (outText && outText.trim()) {
      bodyHtml += formatExpandableText(outText.trim(), name === 'bash' ? 8 : 12);
    }

    // Nested calls (e.g. codemode)
    if (res.nestedCalls?.calls?.length) {
      const lines = res.nestedCalls.calls.map((c) => {
        const icon = c.status === 'ok' ? '✓' : c.status === 'error' ? '✗' : '…';
        return `${icon} ${c.name} ${c.arguments ? JSON.stringify(c.arguments) : ''} ${c.durationMs ? c.durationMs + 'ms' : ''}`;
      });
      bodyHtml += formatExpandableText(`Nested calls (${lines.length}):\n` + lines.join('\n'), 5);
    }
  }

  dom.innerHTML = `
    <div class="tool-header">
      <div class="tool-header-left">${headerLeftHtml}</div>
      <span class="tool-meta">${escapeHtml(statusBadge)}</span>
    </div>
    ${bodyHtml}
  `;
  return dom;
}

function createBashCard(command, output = '', exitCode = undefined, cancelled = false, excludeFromContext = false, finished = false) {
  const isError = cancelled || (finished && exitCode !== 0 && exitCode !== undefined);
  const statusCls = !finished ? 'pending' : isError ? 'error' : 'success';
  const card = el('div', `msg tool-execution ${statusCls}`);
  const ctxBadge = excludeFromContext ? '!! (excluded from context)' : '! (in context)';
  const statusText = !finished
    ? '⏳ running…'
    : cancelled
      ? 'cancelled'
      : `exit ${exitCode ?? 0}`;

  card.innerHTML = `
    <div class="tool-header">
      <div class="tool-header-left">
        <span class="tool-command">$ ${escapeHtml(command)}</span>
      </div>
      <span class="tool-meta">${escapeHtml(ctxBadge)} · <strong class="bash-status">${escapeHtml(statusText)}</strong></span>
    </div>
    <div class="tool-output"><pre class="bash-stream-out">${escapeHtml(output || '')}</pre></div>
  `;
  return card;
}

// ============================================================
// WEBSOCKETS & REAL-TIME STREAMING
// ============================================================
function connectGlobalSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  globalSocket = new WebSocket(`${proto}//${location.host}/ws/events${qs()}`);
  globalSocket.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.type === 'session_created' || d.type === 'session_closed') {
      refreshSessions();
    }
  };
  globalSocket.onclose = () => {
    setAppStatus('disconnected', 'disconnected');
    setTimeout(connectGlobalSocket, 2500);
  };
  globalSocket.onopen = () => {
    if (!currentSession) setAppStatus('connected', 'connected');
  };
}

function connectSessionSocket(id) {
  if (sessionSocket) sessionSocket.close();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  sessionSocket = new WebSocket(`${proto}//${location.host}/ws/sessions/${id}${qs()}`);
  sessionSocket.onmessage = (e) => handleSessionMessage(JSON.parse(e.data));
  sessionSocket.onclose = () => {
    if (currentSession === id) setAppStatus('disconnected', 'session socket closed');
  };
}

function sendRpc(cmd) {
  if (!sessionSocket || sessionSocket.readyState !== WebSocket.OPEN) {
    showToast('Session WebSocket is not connected', 'error');
    return;
  }
  sessionSocket.send(JSON.stringify(cmd));
}

function handleSessionMessage(msg) {
  switch (msg.type) {
    case 'hello':
      sessionState.cwd = msg.cwd || sessionState.cwd;
      sessionState.sessionName = msg.name || sessionState.sessionName;
      break;
    case 'state':
      if (msg.response?.data) renderState(msg.response.data);
      break;
    case 'history':
      if (msg.response?.data?.messages) renderHistory(msg.response.data.messages);
      break;
    case 'stats':
      if (msg.response?.data) renderStats(msg.response.data);
      break;
    case 'models':
      if (msg.response?.data?.models) renderModels(msg.response.data.models);
      break;
    case 'thinking_levels':
      if (msg.response?.data?.levels) renderThinkingLevels(msg.response.data.levels);
      break;
    case 'commands':
      if (msg.response?.data?.commands) renderCommandsList(msg.response.data.commands);
      break;
    case 'event':
      logEvent(msg.event);
      handleEvent(msg.event);
      break;
    case 'rpc_response':
      handleRpcResponse(msg.response);
      break;
    case 'error':
      logEvent({ type: 'error', error: msg.error });
      showToast(String(msg.error), 'error');
      break;
    default:
      logEvent(msg);
  }
}

function handleRpcResponse(resp) {
  if (!resp) return;
  $('#raw-out').textContent = JSON.stringify(resp, null, 2);

  if (resp.success === false) {
    showToast(`${resp.command || 'RPC'} error: ${resp.error || 'failed'}`, 'error');
    return;
  }

  switch (resp.command) {
    case 'get_state':
      if (resp.data) renderState(resp.data);
      break;
    case 'get_session_stats':
      if (resp.data) renderStats(resp.data);
      break;
    case 'get_available_models':
      if (resp.data?.models) renderModels(resp.data.models);
      break;
    case 'get_available_thinking_levels':
      if (resp.data?.levels) renderThinkingLevels(resp.data.levels);
      break;
    case 'get_commands':
      if (resp.data?.commands) renderCommandsList(resp.data.commands);
      break;
    case 'set_model':
      if (resp.data) {
        sessionState.model = resp.data;
        renderState(sessionState);
        sendRpc({ type: 'get_available_thinking_levels' });
        showToast(`Model switched to ${resp.data.provider}/${resp.data.name || resp.data.id}`, 'info', 2500);
      }
      break;
    case 'cycle_model':
      if (resp.data?.model) {
        sessionState.model = resp.data.model;
        if (resp.data.thinkingLevel) sessionState.thinkingLevel = resp.data.thinkingLevel;
        renderState(sessionState);
        sendRpc({ type: 'get_available_thinking_levels' });
        showToast(`Cycled model to ${resp.data.model.provider}/${resp.data.model.id}`, 'info', 2500);
      }
      break;
    case 'cycle_thinking_level':
      if (resp.data?.level) {
        sessionState.thinkingLevel = resp.data.level;
        renderState(sessionState);
      }
      break;
    case 'clear_queue':
      if (resp.data) {
        const restored = [...(resp.data.steering || []), ...(resp.data.followUp || [])].join('\n\n');
        if (restored) {
          const inp = $('#input');
          inp.value = inp.value ? `${inp.value}\n${restored}` : restored;
          inp.focus();
        }
        updateQueueBanner({ steering: [], followUp: [] });
      }
      break;
    case 'new_session':
      if (!resp.data?.cancelled) {
        showToast('Started fresh session', 'info', 2200);
        sendRpc({ type: 'get_state' });
        sendRpc({ type: 'get_messages' });
        sendRpc({ type: 'get_session_stats' });
      }
      break;
    case 'clone':
      if (!resp.data?.cancelled) {
        showToast('Cloned active branch into new session', 'info', 2500);
        sendRpc({ type: 'get_state' });
        sendRpc({ type: 'get_messages' });
        loadSessionTree();
      }
      break;
    case 'fork':
      if (!resp.data?.cancelled) {
        showToast('Forked session from selected message', 'info', 2500);
        if (resp.data?.text) {
          $('#input').value = resp.data.text;
        }
        if (isMobileViewport()) setSidebarCollapsed(true);
        sendRpc({ type: 'get_state' });
        sendRpc({ type: 'get_messages' });
        loadSessionTree();
      }
      break;
    case 'get_messages':
      if (resp.data?.messages) renderHistory(resp.data.messages);
      break;
    case 'get_tree':
      if (resp.data) {
        sessionTreeData = resp.data;
        renderTreeUI();
      }
      break;
    case 'bash': {
      activeBashRunning = false;
      $('#abort-bash-btn').hidden = true;
      setAppStatus(sessionState.isStreaming ? 'running' : 'idle');
      const entry = bashCardsById.get(resp.id);
      if (entry && resp.data) {
        const d = resp.data;
        const isErr = d.cancelled || (d.exitCode !== 0 && d.exitCode !== undefined);
        entry.card.className = `msg tool-execution ${isErr ? 'error' : 'success'}`;
        $('.bash-status', entry.card).textContent = d.cancelled ? 'cancelled' : `exit ${d.exitCode ?? 0}`;
        if (d.output && !entry.output) {
          $('.bash-stream-out', entry.card).textContent = d.output;
        }
      }
      break;
    }
    case 'set_session_name':
      sendRpc({ type: 'get_state' });
      refreshSessions();
      break;
  }
}

function handleEvent(ev) {
  if (!ev || !ev.type) return;

  switch (ev.type) {
    case 'agent_start':
      sessionState.isStreaming = true;
      setAppStatus('running', 'running…');
      break;

    case 'agent_end':
      break;

    case 'agent_settled':
      sessionState.isStreaming = false;
      setAppStatus('idle', 'idle');
      sendRpc({ type: 'get_state' });
      sendRpc({ type: 'get_session_stats' });
      if ($('#tab-tree').classList.contains('active')) loadSessionTree();
      break;

    case 'message_start': {
      const m = ev.message;
      if (!m) break;
      if (m.role === 'user') {
        appendMessage(m);
        scrollToBottom();
      } else if (m.role === 'assistant') {
        const t = $('#transcript');
        $('.empty-state', t)?.remove();
        const row = el('div', 'msg assistant streaming');
        const head = el('div', 'msg-header');
        const modelLabel = m.model ? `${m.provider ? m.provider + '/' : ''}${m.model}` : 'Assistant';
        head.innerHTML = `<span class="msg-role-badge">${escapeHtml(modelLabel)}</span><span>streaming…</span>`;
        row.appendChild(head);
        const blocksContainer = el('div', 'assistant-blocks');
        row.appendChild(blocksContainer);
        t.appendChild(row);
        currentAssistant = {
          el: row,
          blocksContainer,
          blocks: [], // index -> { type, text, el, bodyEl, toolCall }
        };
        scrollToBottom();
      }
      break;
    }

    case 'message_update': {
      if (ev.usage && ev.usage.totalTokens) {
        const costTotal = ev.usage.cost?.total ?? 0;
        $('#usage-hint').textContent = `turn: ${formatTokens(ev.usage.totalTokens)} tok · $${Number(costTotal).toFixed(4)}`;
      }
      const ae = ev.assistantMessageEvent;
      if (!ae || !currentAssistant) break;
      const idx = ae.contentIndex ?? 0;
      let slot = currentAssistant.blocks[idx];

      if (ae.type === 'thinking_start') {
        const tb = createThinkingBlock('', true);
        currentAssistant.blocksContainer.appendChild(tb);
        currentAssistant.blocks[idx] = { type: 'thinking', text: '', el: tb, bodyEl: $('.thinking-text', tb) };
      } else if (ae.type === 'thinking_delta') {
        if (!slot || slot.type !== 'thinking') {
          const tb = createThinkingBlock('', true);
          currentAssistant.blocksContainer.appendChild(tb);
          slot = { type: 'thinking', text: '', el: tb, bodyEl: $('.thinking-text', tb) };
          currentAssistant.blocks[idx] = slot;
        }
        slot.text += ae.delta || '';
        slot.bodyEl.textContent = slot.text;
        scrollToBottom();
      } else if (ae.type === 'thinking_end') {
        if (slot && slot.type === 'thinking') {
          slot.text = ae.content ?? slot.text;
          slot.bodyEl.textContent = slot.text;
          $('.thinking-header', slot.el).textContent = '🧠 Reasoning (click to toggle)';
        }
      } else if (ae.type === 'text_start') {
        const body = el('div', 'msg-body markdown-content');
        currentAssistant.blocksContainer.appendChild(body);
        currentAssistant.blocks[idx] = { type: 'text', text: '', el: body };
      } else if (ae.type === 'text_delta') {
        if (!slot || slot.type !== 'text') {
          const body = el('div', 'msg-body markdown-content');
          currentAssistant.blocksContainer.appendChild(body);
          slot = { type: 'text', text: '', el: body };
          currentAssistant.blocks[idx] = slot;
        }
        slot.text += ae.delta || '';
        slot.el.innerHTML = renderMarkdown(slot.text);
        scrollToBottom();
      } else if (ae.type === 'text_end') {
        if (slot && slot.type === 'text') {
          slot.text = ae.content ?? slot.text;
          slot.el.innerHTML = renderMarkdown(slot.text);
        }
      } else if (ae.type === 'toolcall_start') {
        const tcCard = createOrUpdateToolCard(ae.id, ae.toolName, {}, null, true);
        currentAssistant.blocksContainer.appendChild(tcCard);
        currentAssistant.blocks[idx] = { type: 'toolCall', id: ae.id, toolName: ae.toolName, rawArgs: '', el: tcCard };
        scrollToBottom();
      } else if (ae.type === 'toolcall_end') {
        const tc = ae.toolCall;
        if (tc) {
          createOrUpdateToolCard(tc.id, tc.name, tc.arguments, null, true);
        }
      }
      break;
    }

    case 'message_end': {
      const m = ev.message;
      if (m && m.role === 'assistant') {
        if (currentAssistant) {
          currentAssistant.el.classList.remove('streaming');
          renderCompletedAssistantInto(currentAssistant.el, m);
          currentAssistant = null;
        } else {
          appendMessage(m);
        }
        scrollToBottom();
      }
      break;
    }

    case 'tool_execution_start': {
      setAppStatus('running', `Running ${ev.toolName}…`);
      const card = createOrUpdateToolCard(ev.toolCallId, ev.toolName, ev.args, null, true);
      if (!card.parentElement) {
        if (currentAssistant) currentAssistant.blocksContainer.appendChild(card);
        else $('#transcript').appendChild(card);
      }
      scrollToBottom();
      break;
    }

    case 'tool_execution_update': {
      createOrUpdateToolCard(ev.toolCallId, ev.toolName, ev.args, ev.partialResult, true);
      scrollToBottom();
      break;
    }

    case 'tool_execution_end': {
      const resultObj = {
        role: 'toolResult',
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        content: ev.result?.content || [],
        details: ev.result?.details,
        nestedCalls: ev.result?.nestedCalls,
        isError: ev.isError,
      };
      createOrUpdateToolCard(ev.toolCallId, ev.toolName, undefined, resultObj, false, ev.durationMs);
      setAppStatus('running', 'running…');
      scrollToBottom();
      break;
    }

    case 'bash_execution_update': {
      const entry = bashCardsById.get(ev.id);
      if (entry) {
        entry.output += ev.delta || '';
        const pre = $('.bash-stream-out', entry.card);
        if (pre) pre.textContent = entry.output;
        scrollToBottom();
      }
      break;
    }

    case 'queue_update': {
      updateQueueBanner({
        steering: ev.steering || [],
        followUp: ev.followUp || [],
      });
      break;
    }

    case 'compaction_start': {
      sessionState.isCompacting = true;
      setAppStatus('compacting', `Compacting (${ev.reason || 'manual'})…`);
      break;
    }

    case 'compaction_end': {
      sessionState.isCompacting = false;
      setAppStatus(sessionState.isStreaming ? 'running' : 'idle');
      if (ev.result) {
        appendMessage({
          role: 'compactionSummary',
          tokensBefore: ev.result.tokensBefore,
          summary: ev.result.summary,
        });
        showToast(`Compacted: ${formatTokens(ev.result.tokensBefore)} → ~${formatTokens(ev.result.estimatedTokensAfter)} tokens`, 'info');
      } else if (ev.errorMessage) {
        showToast(`Compaction failed: ${ev.errorMessage}`, 'error');
      }
      sendRpc({ type: 'get_session_stats' });
      break;
    }

    case 'auto_retry_start': {
      $('#abort-retry-btn').hidden = false;
      setAppStatus('retrying', `Retry ${ev.attempt}/${ev.maxAttempts} in ${Math.round((ev.delayMs || 0) / 1000)}s (${ev.errorMessage || ''})`);
      break;
    }

    case 'auto_retry_end': {
      $('#abort-retry-btn').hidden = true;
      if (!ev.success && ev.finalError) {
        showToast(`Retry failed: ${ev.finalError}`, 'error');
      }
      break;
    }

    case 'thinking_level_changed': {
      if (ev.level) {
        sessionState.thinkingLevel = ev.level;
        renderState(sessionState);
      }
      break;
    }

    case 'session_info_changed': {
      sessionState.sessionName = ev.name || null;
      renderState(sessionState);
      refreshSessions();
      break;
    }

    case 'extension_error': {
      showToast(`Extension error (${ev.event || ''}): ${ev.error || ''}`, 'error');
      break;
    }

    case 'extension_ui_request': {
      handleExtensionUIRequest(ev);
      break;
    }
  }
}

function updateQueueBanner(q) {
  activeQueue = q;
  const banner = $('#queue-banner');
  const items = $('#queue-items');
  items.innerHTML = '';
  const all = [
    ...(q.steering || []).map((t) => ({ kind: 'Steer', text: t })),
    ...(q.followUp || []).map((t) => ({ kind: 'Follow-up', text: t })),
  ];
  if (!all.length) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  for (const item of all) {
    items.appendChild(el('div', 'queue-chip', `⏳ [${item.kind}] ${item.text}`));
  }
}

// ============================================================
// EXTENSION UI PROTOCOL (DIALOGS, NOTIFICATIONS, WIDGETS, STATUS)
// ============================================================
function handleExtensionUIRequest(ev) {
  const method = ev.method;

  // Fire-and-forget methods:
  if (method === 'notify') {
    showToast(ev.message || '', ev.notifyType || 'info');
    return;
  }
  if (method === 'setStatus') {
    if (ev.statusText) extStatuses.set(ev.statusKey, ev.statusText);
    else extStatuses.delete(ev.statusKey);
    renderExtStatusAndWidgets();
    return;
  }
  if (method === 'setWidget') {
    const map = ev.widgetPlacement === 'belowEditor' ? extWidgetsBelow : extWidgetsAbove;
    if (Array.isArray(ev.widgetLines) && ev.widgetLines.length) {
      map.set(ev.widgetKey, ev.widgetLines.join('\n'));
    } else {
      map.delete(ev.widgetKey);
    }
    renderExtStatusAndWidgets();
    return;
  }
  if (method === 'setTitle') {
    if (ev.title) document.title = `${ev.title} — pi-web`;
    return;
  }
  if (method === 'set_editor_text') {
    $('#input').value = ev.text || '';
    updateComposerModeUI();
    return;
  }

  // Dialog methods requiring `extension_ui_response`:
  openExtensionModal(ev);
}

function renderExtStatusAndWidgets() {
  const sb = $('#ext-statusbar');
  sb.innerHTML = '';
  if (extStatuses.size === 0) {
    sb.hidden = true;
  } else {
    sb.hidden = false;
    for (const [k, v] of extStatuses.entries()) {
      const span = el('span', 'ext-status-item');
      span.innerHTML = `<span class="ext-status-key">${escapeHtml(k)}:</span> <span>${escapeHtml(v)}</span>`;
      sb.appendChild(span);
    }
  }

  const above = $('#widgets-above');
  if (extWidgetsAbove.size === 0) {
    above.hidden = true;
  } else {
    above.hidden = false;
    above.textContent = Array.from(extWidgetsAbove.values()).join('\n\n');
  }

  const below = $('#widgets-below');
  if (extWidgetsBelow.size === 0) {
    below.hidden = true;
  } else {
    below.hidden = false;
    below.textContent = Array.from(extWidgetsBelow.values()).join('\n\n');
  }
}

function openExtensionModal(ev) {
  closeExtensionModal();
  activeModalId = ev.id;
  const backdrop = $('#ext-modal-backdrop');
  const titleEl = $('#ext-modal-title');
  const timerEl = $('#ext-modal-timer');
  const msgEl = $('#ext-modal-message');
  const bodyEl = $('#ext-modal-body');
  const actionsEl = $('#ext-modal-actions');

  titleEl.textContent = ev.title || 'Extension Prompt';
  msgEl.textContent = ev.message || '';
  bodyEl.innerHTML = '';
  actionsEl.innerHTML = '';
  backdrop.hidden = false;

  const respond = (payload) => {
    if (!activeModalId) return;
    sendRpc({ type: 'extension_ui_response', id: activeModalId, ...payload });
    closeExtensionModal();
  };

  if (ev.timeout && ev.timeout > 0) {
    timerEl.hidden = false;
    let remaining = Math.ceil(ev.timeout / 1000);
    timerEl.textContent = `${remaining}s`;
    activeModalTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        closeExtensionModal();
      } else {
        timerEl.textContent = `${remaining}s`;
      }
    }, 1000);
  } else {
    timerEl.hidden = true;
  }

  if (ev.method === 'select') {
    for (const opt of ev.options || []) {
      const b = el('button', 'primary full', opt);
      b.style.marginBottom = '4px';
      b.addEventListener('click', () => respond({ value: opt }));
      bodyEl.appendChild(b);
    }
    const cancelBtn = el('button', 'ghost', 'Cancel');
    cancelBtn.addEventListener('click', () => respond({ cancelled: true }));
    actionsEl.appendChild(cancelBtn);
  } else if (ev.method === 'confirm') {
    const noBtn = el('button', 'ghost', 'No / Cancel');
    noBtn.addEventListener('click', () => respond({ confirmed: false }));
    const yesBtn = el('button', 'primary', 'Confirm');
    yesBtn.addEventListener('click', () => respond({ confirmed: true }));
    actionsEl.appendChild(noBtn);
    actionsEl.appendChild(yesBtn);
    yesBtn.focus();
  } else if (ev.method === 'input') {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = ev.placeholder || '';
    bodyEl.appendChild(inp);
    const cancelBtn = el('button', 'ghost', 'Cancel');
    cancelBtn.addEventListener('click', () => respond({ cancelled: true }));
    const okBtn = el('button', 'primary', 'Submit');
    okBtn.addEventListener('click', () => respond({ value: inp.value }));
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        respond({ value: inp.value });
      }
    });
    actionsEl.appendChild(cancelBtn);
    actionsEl.appendChild(okBtn);
    setTimeout(() => inp.focus(), 20);
  } else if (ev.method === 'editor') {
    const ta = document.createElement('textarea');
    ta.rows = 8;
    ta.value = ev.prefill || '';
    bodyEl.appendChild(ta);
    const cancelBtn = el('button', 'ghost', 'Cancel');
    cancelBtn.addEventListener('click', () => respond({ cancelled: true }));
    const okBtn = el('button', 'primary', 'Save');
    okBtn.addEventListener('click', () => respond({ value: ta.value }));
    actionsEl.appendChild(cancelBtn);
    actionsEl.appendChild(okBtn);
    setTimeout(() => ta.focus(), 20);
  }
}

function closeExtensionModal() {
  activeModalId = null;
  if (activeModalTimer) {
    clearInterval(activeModalTimer);
    activeModalTimer = null;
  }
  $('#ext-modal-backdrop').hidden = true;
}

// ============================================================
// CONVERSATION TREE VIEWER & FORKING
// ============================================================
async function loadSessionTree() {
  if (!currentSession) return;
  sendRpc({ type: 'get_tree' });
}

function renderTreeUI() {
  const container = $('#tree-container');
  container.innerHTML = '';
  const roots = sessionTreeData.tree || [];
  const leafId = sessionTreeData.leafId;

  if (!roots.length) {
    container.appendChild(el('div', 'empty-hint', 'No tree entries yet.'));
    $('#tree-status').textContent = '0 entries';
    return;
  }

  // Flatten tree DFS
  const flat = [];
  const activeIds = new Set();

  // Find active path
  function markActive(node) {
    let has = node.entry?.id === leafId;
    for (const c of node.children || []) {
      if (markActive(c)) has = true;
    }
    if (has && node.entry?.id) activeIds.add(node.entry.id);
    return has;
  }
  roots.forEach(markActive);

  function walk(node, depth) {
    flat.push({ node, depth });
    const children = [...(node.children || [])].sort(
      (a, b) => Number(activeIds.has(b.entry?.id)) - Number(activeIds.has(a.entry?.id))
    );
    for (const c of children) walk(c, children.length > 1 ? depth + 1 : depth);
  }
  roots.forEach((r) => walk(r, 0));

  const q = treeSearchQuery.toLowerCase().trim();
  const visible = flat.filter(({ node }) => {
    const e = node.entry || {};
    if (treeFilter === 'user-only' && !(e.type === 'message' && e.message?.role === 'user')) return false;
    if (treeFilter === 'no-tools' && e.type === 'message' && e.message?.role === 'toolResult') return false;
    if (treeFilter === 'default' && ['label', 'model_change', 'thinking_level_change'].includes(e.type)) return false;
    if (q) {
      const txt = JSON.stringify(e).toLowerCase();
      if (!txt.includes(q)) return false;
    }
    return true;
  });

  for (const { node, depth } of visible) {
    const e = node.entry || {};
    const inPath = activeIds.has(e.id);
    const isLeaf = e.id === leafId;
    const row = el('div', 'tree-node' + (inPath ? ' in-path' : '') + (isLeaf ? ' active' : ''));
    row.appendChild(el('span', 'tree-prefix', '  '.repeat(Math.min(depth, 8))));
    row.appendChild(el('span', 'tree-marker', inPath ? '•' : '◦'));

    const labelSpan = el('span', 'tree-content');
    if (e.type === 'message') {
      const m = e.message || {};
      const { text } = extractTextAndImages(m.content);
      const short = text.replace(/\s+/g, ' ').trim().slice(0, 55);
      if (m.role === 'user') {
        labelSpan.innerHTML = `<span class="tree-role-user">user:</span> ${escapeHtml(short || '(image)')}`;
      } else if (m.role === 'assistant') {
        labelSpan.innerHTML = `<span class="tree-role-assistant">assistant:</span> ${escapeHtml(short || '(tool call)')}`;
      } else if (m.role === 'toolResult') {
        labelSpan.innerHTML = `<span class="tree-role-tool">[${escapeHtml(m.toolName || 'tool')}]</span>`;
      } else {
        labelSpan.textContent = `[${m.role}] ${short}`;
      }
    } else if (e.type === 'compaction') {
      labelSpan.innerHTML = `<span class="tree-compaction">[compaction]</span>`;
    } else {
      labelSpan.textContent = `[${e.type}]`;
    }
    row.appendChild(labelSpan);

    // Fork button on user messages
    if (e.type === 'message' && e.message?.role === 'user' && e.id) {
      const forkBtn = el('button', 'ghost xs tree-fork-btn', '⑂ Fork');
      forkBtn.title = 'Fork session from this user message';
      forkBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (confirm('Create a new branch forked from this user prompt?')) {
          sendRpc({ type: 'fork', entryId: e.id });
        }
      });
      row.appendChild(forkBtn);
    }

    container.appendChild(row);
  }

  $('#tree-status').textContent = `${visible.length} / ${flat.length} entries`;
}

// ============================================================
// SLASH COMMAND AUTOCOMPLETE & COMPOSER ACTIONS
// ============================================================
let slashMenuIndex = 0;
let slashMatches = [];

function updateSlashMenu() {
  const val = $('#input').value;
  const menu = $('#slash-menu');
  if (!val.startsWith('/') || val.includes('\n') || val.includes(' ')) {
    menu.hidden = true;
    slashMatches = [];
    return;
  }

  const query = val.slice(1).toLowerCase();
  const all = [...BUILTIN_SLASH_COMMANDS, ...availableCommands];
  slashMatches = all.filter((c) => c.name.toLowerCase().includes(query)).slice(0, 12);

  if (!slashMatches.length) {
    menu.hidden = true;
    return;
  }

  slashMenuIndex = Math.min(slashMenuIndex, slashMatches.length - 1);
  menu.innerHTML = '';
  slashMatches.forEach((c, i) => {
    const item = el('div', 'slash-item' + (i === slashMenuIndex ? ' selected' : ''));
    item.innerHTML = `
      <span class="slash-item-name">/${escapeHtml(c.name)}</span>
      <span class="slash-item-desc">${escapeHtml(c.description || '')}</span>
      <span class="cmd-badge">${escapeHtml(c.source || 'cmd')}</span>
    `;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applySlashSelection(c);
    });
    menu.appendChild(item);
  });
  menu.hidden = false;
}

function applySlashSelection(cmd) {
  const inp = $('#input');
  $('#slash-menu').hidden = true;
  if (cmd.source === 'builtin' && ['new', 'clone', 'export', 'tree', 'clear'].includes(cmd.name)) {
    inp.value = `/${cmd.name}`;
    send();
  } else {
    inp.value = `/${cmd.name} `;
    inp.focus();
  }
  updateComposerModeUI();
}

// ============================================================
// IMAGE ATTACHMENTS
// ============================================================
function addImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result || '');
    const comma = dataUrl.indexOf(',');
    if (comma === -1) return;
    const base64 = dataUrl.slice(comma + 1);
    pendingImages.push({
      type: 'image',
      data: base64,
      mimeType: file.type || 'image/png',
    });
    renderImageAttachments();
  };
  reader.readAsDataURL(file);
}

function renderImageAttachments() {
  const box = $('#image-attachments');
  box.innerHTML = '';
  if (!pendingImages.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  pendingImages.forEach((img, idx) => {
    const thumb = el('div', 'att-thumb');
    const i = document.createElement('img');
    i.src = `data:${img.mimeType};base64,${img.data}`;
    const rm = el('button', 'att-remove', '✕');
    rm.type = 'button';
    rm.addEventListener('click', () => {
      pendingImages.splice(idx, 1);
      renderImageAttachments();
    });
    thumb.appendChild(i);
    thumb.appendChild(rm);
    box.appendChild(thumb);
  });
}

// ============================================================
// SEND PROMPT / STEER / FOLLOW-UP / BASH
// ============================================================
async function send(overrideMode = null) {
  const raw = $('#input').value;
  const text = raw.trim();
  if ((!text && pendingImages.length === 0) || !currentSession) return;

  $('#slash-menu').hidden = true;

  // Handle client-side built-in slash commands
  if (text.startsWith('/') && pendingImages.length === 0) {
    const [cmdWord, ...restWords] = text.slice(1).split(/\s+/);
    const argText = restWords.join(' ').trim();

    if (cmdWord === 'new') {
      $('#input').value = '';
      sendRpc({ type: 'new_session' });
      return;
    }
    if (cmdWord === 'clone') {
      $('#input').value = '';
      sendRpc({ type: 'clone' });
      return;
    }
    if (cmdWord === 'compact') {
      $('#input').value = '';
      sendRpc(argText ? { type: 'compact', customInstructions: argText } : { type: 'compact' });
      return;
    }
    if (cmdWord === 'name') {
      $('#input').value = '';
      const newName = argText || prompt('Session display name:', sessionState.sessionName || '') || '';
      sendRpc({ type: 'set_session_name', name: newName });
      return;
    }
    if (cmdWord === 'export') {
      $('#input').value = '';
      window.open(`/sessions/${currentSession}/export${qs()}`, '_blank');
      return;
    }
    if (cmdWord === 'tree') {
      $('#input').value = '';
      setSidebarCollapsed(false);
      switchSidebarTab('tree');
      loadSessionTree();
      return;
    }
    if (cmdWord === 'clear') {
      $('#input').value = '';
      sendRpc({ type: 'clear_queue' });
      return;
    }
  }

  // Handle `!cmd` or `!!cmd` or Bash mode
  let mode = overrideMode || $('#send-mode').value;
  if (text.startsWith('!!') || mode === 'bash_silent') {
    const cmdStr = text.startsWith('!!') ? text.slice(2).trim() : text;
    if (!cmdStr) return;
    $('#input').value = '';
    runBashCommand(cmdStr, true);
    return;
  }
  if (text.startsWith('!') || mode === 'bash') {
    const cmdStr = text.startsWith('!') ? text.slice(1).trim() : text;
    if (!cmdStr) return;
    $('#input').value = '';
    runBashCommand(cmdStr, false);
    return;
  }

  // Send Prompt / Steer / Follow-up
  const images = pendingImages.length ? [...pendingImages] : undefined;
  pendingImages = [];
  renderImageAttachments();
  $('#input').value = '';
  updateComposerModeUI();

  if (sessionState.isStreaming && mode === 'prompt') {
    mode = 'steer';
  }

  if (mode === 'steer') {
    sendRpc({ type: 'steer', message: text, ...(images ? { images } : {}) });
  } else if (mode === 'follow_up') {
    sendRpc({ type: 'follow_up', message: text, ...(images ? { images } : {}) });
  } else {
    sendRpc({
      type: 'prompt',
      message: text,
      ...(images ? { images } : {}),
    });
  }
}

function runBashCommand(command, excludeFromContext) {
  const reqId = `bash-${Date.now()}`;
  const t = $('#transcript');
  $('.empty-state', t)?.remove();
  const card = createBashCard(command, '', undefined, false, excludeFromContext, false);
  t.appendChild(card);
  bashCardsById.set(reqId, { card, output: '' });
  activeBashRunning = true;
  $('#abort-bash-btn').hidden = false;
  setAppStatus('running', `Running $ ${command.slice(0, 40)}…`);
  scrollToBottom();
  sendRpc({ id: reqId, type: 'bash', command, excludeFromContext });
}

// ============================================================
// EVENT LISTENERS & UI CONTROLS
// ============================================================
function logEvent(d) {
  const log = $('#event-log');
  if (!log) return;
  const row = el('div', 'event-line');
  row.innerHTML = `<span class="event-type">${escapeHtml(d.type || 'event')}</span> ${escapeHtml(JSON.stringify(d).slice(0, 260))}`;
  log.prepend(row);
  while (log.children.length > 60) log.removeChild(log.lastChild);
}

// Sidebar Tabs
function switchSidebarTab(tabName) {
  $$('.tab-btn').forEach((b) => {
    const active = b.dataset.tab === tabName;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  $$('.tab-pane').forEach((p) => {
    p.classList.toggle('active', p.id === `tab-${tabName}`);
  });
  if (tabName === 'tree') loadSessionTree();
  if (tabName === 'commands') updateCommandsTab();
}

$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchSidebarTab(btn.dataset.tab));
});

// Sidebar collapse, mobile drawer & resize
function isMobileViewport() {
  return window.matchMedia('(max-width: 860px)').matches;
}

function setSidebarCollapsed(collapsed) {
  const sidebar = $('#sidebar');
  const backdrop = $('#sidebar-backdrop');
  const toggleBtn = $('#sidebar-toggle');
  const isCollapsed = Boolean(collapsed);
  if (sidebar) {
    sidebar.classList.toggle('collapsed', isCollapsed);
  }
  if (backdrop) {
    backdrop.hidden = isCollapsed || !isMobileViewport();
  }
  if (toggleBtn) {
    toggleBtn.classList.toggle('active', !isCollapsed);
    toggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
  }
}

function toggleSidebar() {
  const sidebar = $('#sidebar');
  setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
}

$('#sidebar-toggle').addEventListener('click', () => {
  toggleSidebar();
});

$('#sidebar-close-btn')?.addEventListener('click', () => {
  setSidebarCollapsed(true);
});

$('#sidebar-backdrop')?.addEventListener('click', () => {
  setSidebarCollapsed(true);
});

$('#empty-open-sidebar-btn')?.addEventListener('click', () => {
  setSidebarCollapsed(false);
  switchSidebarTab('sessions');
});

$('#empty-new-session-btn')?.addEventListener('click', () => {
  $('#new-session-btn').click();
});

window.addEventListener('resize', () => {
  const sidebar = $('#sidebar');
  const backdrop = $('#sidebar-backdrop');
  if (backdrop && sidebar) {
    backdrop.hidden = sidebar.classList.contains('collapsed') || !isMobileViewport();
  }
});

(() => {
  const resizer = $('#sidebar-resizer');
  const sidebar = $('#sidebar');
  let dragging = false;
  resizer.addEventListener('pointerdown', (e) => {
    dragging = true;
    document.body.classList.add('resizing');
    resizer.setPointerCapture(e.pointerId);
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const w = Math.max(240, Math.min(600, e.clientX));
    document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
  });
  window.addEventListener('pointerup', () => {
    if (dragging) {
      dragging = false;
      document.body.classList.remove('resizing');
    }
  });
})();

// Theme switcher
$('#theme-toggle-btn').addEventListener('click', () => {
  const html = document.documentElement;
  const next = html.dataset.theme === 'light' ? 'dark' : 'light';
  html.dataset.theme = next;
  localStorage.setItem('piweb-theme', next);
});
if (localStorage.getItem('piweb-theme')) {
  document.documentElement.dataset.theme = localStorage.getItem('piweb-theme');
}

// Thinking & Tool output global toggles
$('#toggle-thinking-btn').addEventListener('click', () => {
  const hidden = document.body.classList.toggle('hide-thinking');
  const btn = $('#toggle-thinking-btn');
  btn.classList.toggle('active', !hidden);
  btn.setAttribute('aria-pressed', String(!hidden));
});

$('#toggle-tools-btn').addEventListener('click', () => {
  const expanded = document.body.classList.toggle('expand-tools');
  const btn = $('#toggle-tools-btn');
  btn.classList.toggle('active', expanded);
  btn.setAttribute('aria-pressed', String(expanded));
});

// Rename session from breadcrumb
$('#session-title-btn').addEventListener('click', () => {
  if (!currentSession) return;
  const next = prompt('Set session display name:', sessionState.sessionName || '');
  if (next !== null) {
    sendRpc({ type: 'set_session_name', name: next.trim() });
  }
});

// Export HTML
$('#export-html-btn').addEventListener('click', () => {
  if (!currentSession) return showToast('Select a session first', 'warning');
  window.open(`/sessions/${currentSession}/export${qs()}`, '_blank');
});

// Model & Thinking selectors
$('#model-select').addEventListener('change', (e) => {
  if (!currentSession || !e.target.value) return;
  const [provider, modelId] = e.target.value.split('::');
  if (provider && modelId) {
    sendRpc({ type: 'set_model', provider, modelId });
  }
});

$('#cycle-model-btn').addEventListener('click', () => {
  if (!currentSession) return;
  sendRpc({ type: 'cycle_model' });
});

$('#thinking-select').addEventListener('change', (e) => {
  if (!currentSession) return;
  e.target.dataset.level = e.target.value;
  sessionState.thinkingLevel = e.target.value;
  updateComposerModeUI();
  sendRpc({ type: 'set_thinking_level', level: e.target.value });
});

// New Session Panel & Directory Browser
$('#new-session-btn').addEventListener('click', () => {
  setSidebarCollapsed(false);
  switchSidebarTab('sessions');
  const panel = $('#new-session-panel');
  panel.hidden = false;
  $('#new-cwd').focus();
});
$('#close-new-session-panel').addEventListener('click', () => {
  $('#new-session-panel').hidden = true;
});

async function loadDirBrowser(path) {
  try {
    const r = await api('/dirs', path ? { query: { path } } : {});
    const browser = $('#dir-browser');
    browser.hidden = false;
    $('#dir-current-path').textContent = r.current || '';
    $('#dir-current-path').dataset.full = r.current || '';
    $('#dir-up-btn').onclick = () => {
      if (r.parent) loadDirBrowser(r.parent);
    };
    $('#dir-select-btn').onclick = () => {
      $('#new-cwd').value = r.current || '';
      browser.hidden = true;
    };
    const list = $('#dir-list');
    list.innerHTML = '';
    for (const d of r.dirs || []) {
      const name = d.split('/').pop() || d;
      const li = el('li', 'dir-item', `📁 ${name}`);
      li.addEventListener('click', () => {
        $('#new-cwd').value = d;
        loadDirBrowser(d);
      });
      list.appendChild(li);
    }
    if (!r.dirs?.length) {
      list.appendChild(el('li', 'empty-hint', '(no subdirectories)'));
    }
  } catch (e) {
    showToast(String(e), 'error');
  }
}

$('#browse-cwd-btn').addEventListener('click', () => {
  const box = $('#dir-browser');
  if (!box.hidden) {
    box.hidden = true;
    return;
  }
  loadDirBrowser($('#new-cwd').value.trim());
});

$('#create-session').addEventListener('click', async () => {
  const cwd = $('#new-cwd').value.trim();
  if (!cwd) return showToast('Working directory (cwd) is required', 'warning');
  try {
    const r = await api('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        cwd,
        name: $('#new-name').value.trim() || null,
        model: $('#new-model').value.trim() || null,
        thinking: $('#new-thinking').value || null,
        session: $('#new-session-id').value.trim() || null,
        no_session: $('#new-no-session').checked,
      }),
    });
    $('#new-session-panel').hidden = true;
    selectSession(r.id);
    showToast(`Started session ${r.id}`, 'info', 2200);
  } catch (e) {
    showToast(String(e), 'error');
  }
});

$('#refresh-sessions-btn').addEventListener('click', refreshSessions);

// Saved Sessions
async function loadSavedSessions() {
  const cwd = $('#saved-cwd').value.trim();
  const list = $('#saved-list');
  list.innerHTML = '';
  try {
    const r = await api('/saved-sessions', cwd ? { query: { cwd } } : {});
    for (const s of r.sessions || []) {
      const li = el('li', 'session-item');
      const top = el('div', 'session-item-top');
      const title = s.name || s.firstPrompt || (s.id || '').slice(0, 8) || 'Session';
      top.appendChild(el('span', 'session-item-title', title));
      top.appendChild(el('span', 'session-meta', `${s.messageCount ?? 0} msgs`));
      li.appendChild(top);
      if (s.firstPrompt && s.name) {
        li.appendChild(el('div', 'session-preview', s.firstPrompt));
      }
      const ts = (s.timestamp || '').slice(0, 16).replace('T', ' ');
      li.appendChild(el('div', 'session-meta', `${ts} · ${shortenPath(s.cwd || '')}`));
      li.addEventListener('click', async () => {
        try {
          const c = await api('/sessions', {
            method: 'POST',
            body: JSON.stringify({
              cwd: s.cwd || cwd || $('#new-cwd').value.trim(),
              session: s.path,
            }),
          });
          selectSession(c.id);
          showToast(`Resumed session ${c.id}`, 'info', 2200);
        } catch (e) {
          showToast(String(e), 'error');
        }
      });
      list.appendChild(li);
    }
    if (!r.sessions?.length) {
      list.appendChild(el('li', 'empty-hint', 'No saved sessions found.'));
    }
  } catch (e) {
    list.appendChild(el('li', 'empty-hint', String(e)));
  }
}

$('#saved-refresh').addEventListener('click', loadSavedSessions);
$('#saved-cwd').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadSavedSessions();
});

// Session Actions
$('#reset-session-btn').addEventListener('click', () => {
  if (!currentSession) return;
  sendRpc({ type: 'new_session' });
});

$('#clone-session-btn').addEventListener('click', () => {
  if (!currentSession) return;
  sendRpc({ type: 'clone' });
});

$('#compact-btn').addEventListener('click', () => {
  if (!currentSession) return;
  sendRpc({ type: 'compact' });
});

$('#close-btn').addEventListener('click', async () => {
  if (!currentSession) return;
  if (!confirm(`Terminate Pi process for ${currentSession}?`)) return;
  try {
    await api(`/sessions/${currentSession}`, { method: 'DELETE' });
    currentSession = null;
    $('#session-breadcrumb').hidden = true;
    await refreshSessions();
    $('#transcript').innerHTML = '';
  } catch (e) {
    showToast(String(e), 'error');
  }
});

$('#abort-btn').addEventListener('click', async () => {
  if (!currentSession) return;
  try {
    await api(`/sessions/${currentSession}/abort`, { method: 'POST' });
  } catch (e) {
    showToast(String(e), 'error');
  }
});

$('#abort-bash-btn').addEventListener('click', () => {
  if (!currentSession) return;
  sendRpc({ type: 'abort_bash' });
});

$('#abort-retry-btn').addEventListener('click', () => {
  if (!currentSession) return;
  sendRpc({ type: 'abort_retry' });
});

$('#clear-queue-btn').addEventListener('click', () => {
  if (!currentSession) return;
  sendRpc({ type: 'clear_queue' });
});

// Inspector controls
$('#auto-compact-toggle').addEventListener('change', (e) => {
  if (!currentSession) return;
  sendRpc({ type: 'set_auto_compaction', enabled: e.target.checked });
});

$('#auto-retry-toggle').addEventListener('change', (e) => {
  if (!currentSession) return;
  sendRpc({ type: 'set_auto_retry', enabled: e.target.checked });
});

$('#steering-mode-select').addEventListener('change', (e) => {
  if (!currentSession) return;
  sendRpc({ type: 'set_steering_mode', mode: e.target.value });
});

$('#followup-mode-select').addEventListener('change', (e) => {
  if (!currentSession) return;
  sendRpc({ type: 'set_follow_up_mode', mode: e.target.value });
});

$('#raw-send').addEventListener('click', () => {
  if (!currentSession) return;
  const raw = $('#raw-input').value.trim();
  if (!raw) return;
  try {
    sendRpc(JSON.parse(raw));
  } catch (e) {
    $('#raw-out').textContent = String(e);
  }
});

$('#refresh-stderr-btn').addEventListener('click', async () => {
  if (!currentSession) return;
  const err = await api(`/sessions/${currentSession}/stderr`).catch(() => null);
  if (err && Array.isArray(err.stderr)) {
    $('#stderr-out').textContent = err.stderr.length ? err.stderr.join('\n') : '(empty)';
  }
});

$('#clear-events-btn').addEventListener('click', () => {
  $('#event-log').innerHTML = '';
});

// Tree Tab Controls
$('#refresh-tree-btn').addEventListener('click', loadSessionTree);
$('#tree-search').addEventListener('input', (e) => {
  treeSearchQuery = e.target.value;
  renderTreeUI();
});
$$('.filter-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    $$('.filter-chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    treeFilter = chip.dataset.filter;
    renderTreeUI();
  });
});

// Commands Tab Controls
$('#refresh-commands-btn').addEventListener('click', () => {
  if (currentSession) sendRpc({ type: 'get_commands' });
});
$('#commands-search').addEventListener('input', updateCommandsTab);

// Composer & Keyboard Shortcuts
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});

$('#send-mode').addEventListener('change', updateComposerModeUI);

$('#input').addEventListener('input', () => {
  updateComposerModeUI();
  updateSlashMenu();
});

$('#input').addEventListener('keydown', (e) => {
  const menu = $('#slash-menu');
  if (!menu.hidden && slashMatches.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      slashMenuIndex = (slashMenuIndex + 1) % slashMatches.length;
      updateSlashMenu();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      slashMenuIndex = (slashMenuIndex - 1 + slashMatches.length) % slashMatches.length;
      updateSlashMenu();
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      applySlashSelection(slashMatches[slashMenuIndex]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      menu.hidden = true;
      return;
    }
  }

  if (e.altKey && e.key === 'Enter') {
    e.preventDefault();
    send('follow_up');
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

$('#input').addEventListener('paste', (e) => {
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      addImageFile(item.getAsFile());
    }
  }
});

$('#image-input').addEventListener('change', (e) => {
  for (const f of e.target.files || []) addImageFile(f);
  e.target.value = '';
});

$('#insert-slash-btn').addEventListener('click', () => {
  const inp = $('#input');
  if (!inp.value.startsWith('/')) inp.value = '/';
  inp.focus();
  updateSlashMenu();
});

$('#insert-bash-btn').addEventListener('click', () => {
  const inp = $('#input');
  if (!inp.value.startsWith('!')) inp.value = '!' + inp.value;
  inp.focus();
  updateComposerModeUI();
});

// Global Hotkeys (matching Pi TUI conventions)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && currentSession && (sessionState.isStreaming || activeBashRunning)) {
    e.preventDefault();
    if (activeBashRunning) sendRpc({ type: 'abort_bash' });
    else api(`/sessions/${currentSession}/abort`, { method: 'POST' }).catch(() => {});
    return;
  }
  if (e.shiftKey && e.key === 'Tab' && currentSession) {
    e.preventDefault();
    sendRpc({ type: 'cycle_thinking_level' });
    return;
  }
  if (e.altKey && e.key === 'ArrowUp' && currentSession) {
    e.preventDefault();
    sendRpc({ type: 'clear_queue' });
    return;
  }
  if (e.altKey && e.key.toLowerCase() === 't') {
    e.preventDefault();
    $('#toggle-thinking-btn').click();
    return;
  }
  if (e.altKey && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    $('#toggle-tools-btn').click();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    $('#sidebar-toggle').click();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l' && currentSession) {
    e.preventDefault();
    sendRpc({ type: 'cycle_model' });
  }
});

// ============================================================
// BOOTSTRAP
// ============================================================
(async () => {
  if (isMobileViewport()) {
    setSidebarCollapsed(true);
  } else {
    setSidebarCollapsed(false);
  }
  connectGlobalSocket();
  try {
    const cfg = await api('/config');
    if (cfg.defaultCwd) {
      $('#new-cwd').value = cfg.defaultCwd;
      $('#saved-cwd').value = cfg.defaultCwd;
    }
  } catch (e) {
    console.warn('config fetch failed', e);
  }
  await refreshSessions();
  await loadSavedSessions();
  const sel = $('#session-select');
  if (sel.value) {
    selectSession(sel.value);
  }
})();
