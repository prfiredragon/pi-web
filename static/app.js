'use strict';

// ---------- config / auth ----------
const TOKEN_PARAMS = new URLSearchParams(location.search);
const TOKEN = TOKEN_PARAMS.get('token') || localStorage.getItem('piweb-token') || '';
if (TOKEN) localStorage.setItem('piweb-token', TOKEN);

function qs(extra = {}) {
  const p = new URLSearchParams(extra);
  if (TOKEN) p.set('token', TOKEN);
  const s = p.toString();
  return s ? `?${s}` : '';
}

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let currentSession = null;
let sessionSocket = null;
let globalSocket = null;
let pendingText = {}; // user typing buffer

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

// ---------- session list ----------
async function refreshSessions() {
  const data = await api('/sessions');
  const list = $('#session-list');
  list.innerHTML = '';
  for (const s of data.sessions) {
    const li = el('li', 'session-item' + (s.id === currentSession ? ' active' : ''));
    li.textContent = s.cwd;
    const meta = el('span', 'session-meta', s.id + (s.alive ? '' : ' (closed)'));
    li.appendChild(meta);
    li.addEventListener('click', () => selectSession(s.id));
    list.appendChild(li);
  }
  const sel = $('#session-select');
  sel.innerHTML = '';
  for (const s of data.sessions) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.id} — ${s.cwd}`;
    sel.appendChild(o);
  }
  if (currentSession) sel.value = currentSession;
  else if (data.sessions.length) sel.value = data.sessions[0].id;
}

async function selectSession(id) {
  if (!id) return;
  currentSession = id;
  currentAssistant = null;
  $('#transcript').innerHTML = '';
  await refreshSessions();
  connectSessionSocket(id);
  const st = await api(`/sessions/${id}`).catch(() => null);
  if (st && st.data) renderState(st.data);
  const snap = await api(`/sessions/${id}/snapshot`).catch(() => null);
  if (snap && snap.data && Array.isArray(snap.data.messages)) renderHistory(snap.data.messages);
}

function renderState(d) {
  const info = $('#session-info');
  info.innerHTML = '';
  info.appendChild(el('div', 'info-line', `cwd: ${d.cwd || ''}`));
  info.appendChild(el('div', 'info-line', `model: ${d.model ? d.model.id : '?'}`));
  info.appendChild(el('div', 'info-line', `thinking: ${d.thinkingLevel || 'medium'}`));
  info.appendChild(el('div', 'info-line', `messages: ${d.messageCount ?? 0}`));
  if (d.sessionFile) info.appendChild(el('div', 'info-line dim', d.sessionFile));
  const th = $('#thinking-select');
  if (d.thinkingLevel) th.value = d.thinkingLevel;
}

// ---------- transcript rendering ----------
function renderHistory(messages) {
  const t = $('#transcript');
  t.innerHTML = '';
  for (const m of messages) appendMessage(m, true);
}

function shortText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content.map((c) => (c.text ?? c.type === 'text' ? c.text : '')).filter(Boolean).join('\n');
}

function blockText(block) {
  if (block.type === 'text') return block.text || '';
  if (block.type === 'thinking') return block.thinking || block.text || '';
  if (block.type === 'toolCall' || block.type === 'tool_call') {
    return `[tool ${block.name ?? ''} ${JSON.stringify(block.arguments ?? {}).slice(0, 400)}]`;
  }
  return block.text || JSON.stringify(block);
}

function assistantBlocks(m) {
  const content = m.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

function appendMessage(m, history) {
  const t = $('#transcript');
  if (m.role === 'assistant') {
    const row = el('div', 'msg assistant');
    for (const b of assistantBlocks(m)) {
      if (b.type === 'thinking') {
        row.appendChild(el('div', 'thinking', blockText(b)));
      } else if (b.type === 'toolCall' || b.type === 'tool_call') {
        row.appendChild(el('div', 'toolcall', `${b.name ?? 'tool'} ${JSON.stringify(b.arguments ?? {}).slice(0, 400)}`));
      } else {
        const txt = blockText(b);
        if (txt.trim()) row.appendChild(el('div', 'msg-body', txt));
      }
    }
    t.appendChild(row);
    return;
  }
  if (m.role === 'user') {
    const row = el('div', 'msg user');
    row.appendChild(el('div', 'msg-body', shortText(m.content)));
    t.appendChild(row);
    return;
  }
  if (m.role === 'toolResult') {
    const row = el('div', 'msg tool-result');
    row.appendChild(el('div', 'msg-head', `${m.toolName || 'tool'}${m.isError ? ' (error)' : ''}`));
    const body = (m.content || []).map((c) => c.text || c.content || '').join('\n');
    row.appendChild(el('pre', 'msg-pre', body.slice(0, 4000)));
    t.appendChild(row);
    return;
  }
  if (m.role === 'custom') {
    const row = el('div', 'msg custom');
    row.appendChild(el('div', 'msg-body', String(m.content ?? '')));
    t.appendChild(row);
  }
}

let currentAssistant = null;   // { el, bodyEl, thinkEl, text, thinking }

// ---------- websocket ----------
function connectGlobalSocket() {
  globalSocket = new WebSocket(`/ws/events${qs()}`);
  globalSocket.onmessage = (e) => {
    const d = JSON.parse(e.data);
    logEvent(d);
    if (d.type === 'session_created') refreshSessions();
  };
  globalSocket.onclose = () => {
    $('#status').textContent = 'disconnected';
    setTimeout(connectGlobalSocket, 3000);
  };
  globalSocket.onopen = () => $('#status').textContent = 'connected';
}

function connectSessionSocket(id) {
  if (sessionSocket) sessionSocket.close();
  sessionSocket = new WebSocket(`/ws/sessions/${id}${qs()}`);
  sessionSocket.onmessage = (e) => handleSessionMessage(JSON.parse(e.data));
  sessionSocket.onclose = () => {
    if (currentSession === id) $('#status').textContent = 'session socket closed';
  };
}

function handleSessionMessage(msg) {
  switch (msg.type) {
    case 'history': {
      const d = msg.response?.data;
      if (d && Array.isArray(d.messages)) renderHistory(d.messages);
      break;
    }
    case 'stats': {
      const d = msg.response?.data;
      if (d) {
        const ctx = d.contextUsage || {};
        $('#usage-hint').textContent =
          `context: ${ctx.tokens ?? '?'} / ${ctx.contextWindow ?? '?'} tokens (${ctx.percent ?? 0}%)  cost: $${(d.cost ?? 0).toFixed ? d.cost.toFixed(2) : d.cost}`;
      }
      break;
    }
    case 'event':
      logEvent(msg.event);
      handleEvent(msg.event);
      break;
    case 'rpc_response':
      $('#raw-out').textContent = JSON.stringify(msg.response, null, 2);
      break;
    case 'error':
      logEvent({ type: 'error', error: msg.error });
      break;
    default:
      logEvent(msg);
  }
}

function handleEvent(ev) {
  if (ev.type === 'agent_start') {
    $('#status').textContent = 'running…';
  }
  if (ev.type === 'agent_end') {
    $('#status').textContent = 'idle';
  }
  if (ev.type === 'message_start' && ev.message && ev.message.role === 'assistant') {
    const row = el('div', 'msg assistant streaming');
    const bodyEl = el('div', 'msg-body', '');
    row.appendChild(bodyEl);
    $('#transcript').appendChild(row);
    currentAssistant = { el: row, bodyEl, text: '' };
  }
  if (ev.type === 'message_update' && ev.assistantMessageEvent) {
    const ae = ev.assistantMessageEvent;
    if (ae.type === 'text_delta' && currentAssistant) {
      currentAssistant.text += ae.delta || '';
      currentAssistant.bodyEl.textContent = currentAssistant.text;
    }
  }
  if (ev.type === 'message_end') {
    if (currentAssistant) {
      currentAssistant.el.classList.remove('streaming');
      // Replace streaming buffer with full content (thinking + tool calls included).
      const blocks = assistantBlocks(ev.message || {});
      currentAssistant.el.innerHTML = '';
      for (const b of blocks) {
        if (b.type === 'thinking') {
          currentAssistant.el.appendChild(el('div', 'thinking', blockText(b)));
        } else if (b.type === 'toolCall' || b.type === 'tool_call') {
          currentAssistant.el.appendChild(el('div', 'toolcall', `${b.name ?? 'tool'} ${JSON.stringify(b.arguments ?? {}).slice(0, 400)}`));
        } else {
          const txt = blockText(b);
          if (txt.trim()) currentAssistant.el.appendChild(el('div', 'msg-body', txt));
        }
      }
      currentAssistant = null;
    }
  }
  if (ev.type === 'tool_execution_start') {
    const row = el('div', 'msg tool-start');
    row.appendChild(el('div', 'msg-head', `→ ${ev.toolName} ${JSON.stringify(ev.args ?? {}).slice(0, 200)}`));
    $('#transcript').appendChild(row);
  }
  if (ev.type === 'tool_execution_end') {
    const row = el('div', 'msg tool-end');
    row.appendChild(el('div', 'msg-head', `← ${ev.toolName}${ev.isError ? ' (error)' : ''}`));
    $('#transcript').appendChild(row);
  }
  if (ev.type === 'extension_ui_request') {
    const q = prompt(`pi asks (${ev.title || ''}): ${ev.message || ''}`);
    sessionSocket.send(JSON.stringify({ type: 'extension_ui_response', id: ev.id, value: q }));
  }
}

function logEvent(d) {
  const log = $('#event-log');
  const line = el('div', 'event-line', `${d.type || 'event'} ${JSON.stringify(d).slice(0, 300)}`);
  log.prepend(line);
  while (log.children.length > 40) log.removeChild(log.lastChild);
}

// ---------- actions ----------
async function send() {
  const text = $('#input').value.trim();
  if (!text || !currentSession) return;
  const mode = $('#send-mode').value;
  const row = el('div', 'msg user local');
  row.appendChild(el('div', 'msg-body', text));
  $('#transcript').appendChild(row);
  $('#input').value = '';
  try {
    if (mode === 'prompt') {
      await api(`/sessions/${currentSession}/prompt`, {
        method: 'POST',
        body: JSON.stringify({ text, streaming: null }),
      });
    } else if (mode === 'steer') {
      sessionSocket.send(JSON.stringify({ type: 'steer', message: text }));
    } else {
      sessionSocket.send(JSON.stringify({ type: 'follow_up', message: text }));
    }
  } catch (e) {
    logEvent({ type: 'error', error: String(e) });
  }
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});
$('#input').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    send();
  }
});

$('#new-session-btn').addEventListener('click', () => {
  $('#new-session-panel').hidden = !$('#new-session-panel').hidden;
});
$('#create-session').addEventListener('click', async () => {
  const cwd = $('#new-cwd').value.trim();
  if (!cwd) return alert('cwd is required');
  try {
    const r = await api('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        cwd,
        name: $('#new-name').value.trim() || null,
        model: $('#new-model').value.trim() || null,
        no_session: $('#new-no-session').checked,
      }),
    });
    $('#new-session-panel').hidden = true;
    selectSession(r.id);
  } catch (e) {
    alert(String(e));
  }
});

$('#session-select').addEventListener('change', (e) => selectSession(e.target.value));

$('#saved-refresh').addEventListener('click', async () => {
  const cwd = $('#saved-cwd').value.trim() || $('#new-cwd').value.trim();
  const list = $('#saved-list');
  list.innerHTML = '';
  try {
    const r = await api('/saved-sessions', cwd ? { query: { cwd } } : {});
    for (const s of r.sessions) {
      const li = el('li', 'session-item');
      li.textContent = `${(s.timestamp || '').slice(0, 16)}  ${(s.id || '').slice(0, 8)}`;
      li.appendChild(el('span', 'session-meta', s.cwd || ''));
      li.addEventListener('click', async () => {
        try {
          const c = await api('/sessions', {
            method: 'POST',
            body: JSON.stringify({ cwd: s.cwd || cwd, session: s.path }),
          });
          selectSession(c.id);
        } catch (e) {
          alert(String(e));
        }
      });
      list.appendChild(li);
    }
    if (!r.sessions.length) list.appendChild(el('li', 'session-item', 'no saved sessions'));
  } catch (e) {
    list.appendChild(el('li', 'session-item', String(e)));
  }
});

$('#abort-btn').addEventListener('click', async () => {
  if (!currentSession) return;
  try {
    const r = await api(`/sessions/${currentSession}/abort`, { method: 'POST' });
    logEvent(r);
  } catch (e) {
    logEvent({ type: 'error', error: String(e) });
  }
});

$('#compact-btn').addEventListener('click', async () => {
  if (!currentSession) return;
  sessionSocket.send(JSON.stringify({ type: 'compact', context: 'summarize previous conversation' }));
});

$('#close-btn').addEventListener('click', async () => {
  if (!currentSession) return;
  try {
    await api(`/sessions/${currentSession}`, { method: 'DELETE' });
    currentSession = null;
    await refreshSessions();
    $('#transcript').innerHTML = '';
  } catch (e) {
    logEvent({ type: 'error', error: String(e) });
  }
});

$('#model-select').addEventListener('change', async (e) => {
  if (!currentSession) return;
  sessionSocket.send(JSON.stringify({ type: 'set_model', model: e.target.value }));
});

$('#thinking-select').addEventListener('change', async (e) => {
  if (!currentSession) return;
  sessionSocket.send(JSON.stringify({ type: 'set_thinking_level', level: e.target.value }));
});

$('#raw-send').addEventListener('click', async () => {
  if (!currentSession) return;
  const raw = $('#raw-input').value.trim();
  if (!raw) return;
  try {
    const cmd = JSON.parse(raw);
    sessionSocket.send(JSON.stringify(cmd));
  } catch (e) {
    $('#raw-out').textContent = String(e);
  }
});

async function loadModels() {
  try {
    const r = await api('/sessions/' + currentSession + '/models');
    const models = r?.data?.models ?? r?.models ?? [];
    const sel = $('#model-select');
    sel.innerHTML = '';
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name || m.id;
      sel.appendChild(o);
    }
  } catch (e) {
    $('#model-select').innerHTML = '<option>(no models)</option>';
  }
}

// boot
(async () => {
  connectGlobalSocket();
  await refreshSessions();
  const sel = $('#session-select');
  if (sel.value) {
    selectSession(sel.value);
  }
})();

setInterval(() => {
  if (currentSession) loadModels();
}, 30000);
