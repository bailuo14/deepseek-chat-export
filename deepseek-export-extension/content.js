/* ============================================================
 * DeepSeek 聊天记录导出 —— content script
 * 运行于 https://chat.deepseek.com/*
 *
 * 原理：
 *   1. 从页面 localStorage / Cookie 中读取当前登录令牌；
 *   2. 以页面同源身份调用 DeepSeek 网页版自身的会话接口
 *      （/api/v0/chat_session/fetch_all、/api/v0/chat_history/fetch_chat_session）；
 *   3. 在本地把会话整理成 Markdown / JSON，通过浏览器下载保存。
 *   全过程数据不经过任何第三方服务器。
 * ============================================================ */
(() => {
  'use strict';
  if (window.__dseInjected) return;
  window.__dseInjected = true;

  const VERSION = '1.0.0';
  const API_BASE = 'https://chat.deepseek.com/api/v0';
  const LS_SETTINGS = 'dse_settings';
  const MAX_PAGES = 300;

  /* ---------------- 小工具 ---------------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => String(n).padStart(2, '0');

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /** 把各种时间表示（秒/毫秒/ISO 字符串）统一成毫秒时间戳 */
  function toTs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && isFinite(v)) return v < 1e12 ? v * 1000 : v;
    const s = String(v);
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return n < 1e12 ? n * 1000 : n;
    }
    const t = Date.parse(s);
    return isNaN(t) ? null : t;
  }

  function fmtTime(ts) {
    if (!ts) return '未知';
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtIso(ts) {
    return ts ? new Date(ts).toISOString() : null;
  }

  function stampName() {
    const d = new Date();
    return 'DeepSeek备份_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      '_' + pad(d.getHours()) + pad(d.getMinutes());
  }

  function sanitizeName(s) {
    const r = String(s || '')
      .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
    return (r || '未命名会话').slice(0, 80);
  }

  /* ---------------- 登录令牌（多层兜底检测） ---------------- */
  const JWT_RE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$/;
  const TOKEN_KEY_RE = /auth|token|jwt|login|session/i;

  function pickTokenFromObject(j) {
    if (!j || typeof j !== 'object') return null;
    const t = j.accessToken || j.access_token || j.token || j.jwt || j.id_token ||
      (j.data && (j.data.accessToken || j.data.access_token || j.data.token));
    return typeof t === 'string' && t.length > 16 ? t : null;
  }

  /** 遍历一个 Storage（localStorage/sessionStorage），返回疑似令牌 */
  function scanStore(store) {
    if (!store) return null;
    let best = null, any = null;
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        let v;
        try { v = store.getItem(k); } catch (_) { continue; }
        if (!v || v.length > 64 * 1024) continue;
        let t = null;
        try { t = pickTokenFromObject(JSON.parse(v)); } catch (_) { /* 非 JSON，忽略 */ }
        if (!t && JWT_RE.test(v.trim())) t = v.trim();
        if (!t && TOKEN_KEY_RE.test(k) && v.length >= 20 && v.length <= 4096 &&
            /^[\w.\-:~+/=]+$/.test(v) && v[0] !== '{') t = v;
        if (t) {
          if (!any) any = t;
          if (TOKEN_KEY_RE.test(k) && !best) best = t;
        }
      }
    } catch (_) { /* ignore */ }
    return best || any;
  }

  function scanCookies() {
    try {
      for (const c of document.cookie.split(';')) {
        const idx = c.indexOf('=');
        if (idx < 0) continue;
        const k = c.slice(0, idx).trim();
        if (!TOKEN_KEY_RE.test(k)) continue;
        let v = c.slice(idx + 1).trim();
        try { v = decodeURIComponent(v); } catch (_) { /* ignore */ }
        let t = null;
        try { t = pickTokenFromObject(JSON.parse(v)); } catch (_) { /* ignore */ }
        if (!t && JWT_RE.test(v)) t = v;
        if (!t && v.length >= 20 && v.length <= 4096 && /^[\w.\-:~+/=]+$/.test(v) && v[0] !== '{') t = v;
        if (t) return t;
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  /** 仅列出键名（绝不输出值），用于登录失败时帮助用户/我定位存储位置 */
  function diagKeys() {
    const names = [];
    try { for (let i = 0; i < localStorage.length; i++) names.push('本地:' + localStorage.key(i)); } catch (_) { /* ignore */ }
    try { for (let i = 0; i < sessionStorage.length; i++) names.push('会话:' + sessionStorage.key(i)); } catch (_) { /* ignore */ }
    try {
      document.cookie.split(';').forEach((c) => {
        const k = (c.split('=')[0] || '').trim();
        if (k) names.push('Cookie:' + k);
      });
    } catch (_) { /* ignore */ }
    return names.join('、') || '（无）';
  }

  function getToken() {
    try {
      const manual = localStorage.getItem('dse_manual_token');
      if (manual && manual.trim()) return manual.trim();
    } catch (_) { /* ignore */ }
    try {
      const raw = localStorage.getItem('auth');
      if (raw) {
        let t = null;
        try { t = pickTokenFromObject(JSON.parse(raw)); } catch (_) { /* ignore */ }
        if (!t && JWT_RE.test(raw.trim())) t = raw.trim();
        if (t) return t;
      }
    } catch (_) { /* ignore */ }
    let t = scanStore(localStorage);
    if (t) return t;
    t = scanStore(sessionStorage);
    if (t) return t;
    return scanCookies();
  }

  /* ---------------- API 请求（带重试与退避） ---------------- */
  async function apiFetch(path, opt) {
    opt = opt || {};
    const method = opt.method || 'GET';
    const body = opt.body;
    const retries = opt.retries == null ? 3 : opt.retries;
    let lastErr = null;

    for (let i = 0; i <= retries; i++) {
      if (i > 0) await sleep(800 * Math.pow(2, i - 1));
      try {
        const token = getToken();
        const headers = { 'Accept': 'application/json' };
        if (token) headers['Authorization'] = 'Bearer ' + token;
        if (body !== undefined) headers['Content-Type'] = 'application/json';

        const res = await fetch(API_BASE + path, {
          method,
          headers,
          credentials: 'include',
          body: body !== undefined ? JSON.stringify(body) : undefined
        });

        if (res.status === 401 || res.status === 403) {
          const e = new Error('登录状态无效（HTTP ' + res.status + '），请先在页面重新登录后再试');
          e.fatal = true; e.status = res.status;
          throw e;
        }
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error('HTTP ' + res.status + ' ' + path);
          continue;
        }
        if (!res.ok) {
          const e = new Error('HTTP ' + res.status + ' ' + path);
          e.status = res.status;
          throw e;
        }
        const data = await res.json();
        if (data && data.is_auth_err) {
          const e = new Error('登录状态已失效（is_auth_err），请先重新登录');
          e.fatal = true;
          throw e;
        }
        return data;
      } catch (err) {
        if (err && err.fatal) throw err;
        lastErr = err;
      }
    }
    throw lastErr || new Error('请求失败：' + path);
  }

  /* ---------------- 拉取全部会话列表 ---------------- */
  // 11-16 改版：/chat_session/fetch_all 已退役（返回 HTML），新端点
  // /chat_session/fetch_page?lte_cursor.pinned=false —— 游标翻页。
  // 游标字段名未知，用"键名诊断"兜底：解析不出时面板只报结构键名，绝不输出内容值。
  function shapeDiag(d) {
    if (d == null) return '响应为空';
    if (typeof d !== 'object') return '响应类型=' + typeof d;
    const keys = Object.keys(d);
    const parts = [];
    for (const k of keys) {
      const v = d[k];
      if (Array.isArray(v)) parts.push(k + '[]×' + v.length);
      else if (v && typeof v === 'object') parts.push(k + '{}');
      else parts.push(k + '=' + String(v).slice(0, 12));
    }
    return parts.join(' , ');
  }
  function extractList(d) {
    if (!d) return null;
    const cand = d.sessions || d.chat_sessions || d.session_list || d.items || d.data || d.list;
    if (Array.isArray(cand)) return cand;
    if (Array.isArray(d)) return d;
    for (const k of Object.keys(d)) if (Array.isArray(d[k])) return d[k];
    return null;
  }
  async function fetchAllSessions(onPage) {
    const seen = new Set();
    const sessions = [];
    let cursor = null;

    for (let round = 1; round <= MAX_PAGES; round++) {
      let qs = 'lte_cursor.pinned=false';
      if (cursor) qs += '&' + cursor;
      const data = await apiFetch('/chat_session/fetch_page?' + qs);
      let d = (data && data.data) || data || {};
      if (d.biz_data) d = d.biz_data; // 11-16 第二轮：令牌有效后 API 用 biz_code=0/biz_data 信封，真数据在里面
      const list = extractList(d);
      if (!list) {
        // 防御：把真实结构键名报给面板（无会话内容），据此一轮修准
        throw new Error('fetch_page 结构未识别，实际结构：' + shapeDiag(d));
      }

      let added = 0;
      for (const s of list) {
        const n = normalizeSession(s);
        if (n.id && !seen.has(n.id)) {
          seen.add(n.id);
          sessions.push(n);
          added++;
        }
      }
      if (onPage) onPage(sessions.length);
      if (list.length === 0 || added === 0) break;

      // 游标推进：优先用响应里明示的 cursor 字段；没有就用末条时间戳构造
      const ck = Object.keys(d).find((k) => /cursor/i.test(k) && typeof d[k] !== 'object');
      if (ck && d[ck]) {
        cursor = 'lte_cursor.' + ck.replace(/^.*cursor\.?/i, '') + '=' + encodeURIComponent(String(d[ck]));
        if (!/=/g.test(cursor.slice(cursor.indexOf('=') + 1))) cursor = ck + '=' + encodeURIComponent(String(d[ck]));
      } else {
        const last = list[list.length - 1] || {};
        const ld = last.update_time || last.created_time || last.created_at || 0;
        if (!ld) break; // 拿不出游标就停，已导出的不亏
        cursor = 'lte_cursor.update_time=' + encodeURIComponent(String(ld));
      }
      await sleep(200);
    }

    sessions.sort((a, b) => (b.update_time || 0) - (a.update_time || 0));
    return sessions;
  }

  /* ---------------- 拉取单个会话的消息 ---------------- */
  // 11-16 改版：新端点 /chat/history_messages?chat_session_id=...（旧 /chat_history/fetch_chat_session 退役）
  // cache_version/cache_reset_at 是客户端缓存戳，先不带；报错时输出结构键名诊断。
  async function fetchHistory(sessionId) {
    let data = null;
    const tries = [
      '/chat/history_messages?chat_session_id=' + encodeURIComponent(sessionId),
      '/chat_history/fetch_chat_session?chat_session_id=' + encodeURIComponent(sessionId),
    ];
    let lastErr = null;
    for (const path of tries) {
      try {
        data = await apiFetch(path);
        break;
      } catch (e) {
        lastErr = e;
        if (e.fatal) throw e;
      }
    }
    if (!data) throw lastErr || new Error('消息接口全部失败');
    let d = (data && data.data) || data || {};
    if (d.biz_data) d = d.biz_data; // 同上：biz 信封解包（11-16）
    let msgs = d.messages || d.chat_messages || d.items || null;
    if (!Array.isArray(msgs)) {
      // 兜底：找第一个数组字段
      msgs = null;
      for (const k of Object.keys(d)) if (Array.isArray(d[k])) { msgs = d[k]; break; }
      if (!msgs) throw new Error('消息结构未识别，实际结构：' + shapeDiag(d));
    }

    const norm = msgs.map(normalizeMessage).filter((m) => m.role || m.content || m.reasoning);
    // 空正文警报（11-16）：如果过半消息正文为空，把首条消息的键名结构报进日志（只有键名，无内容）
    const emptyish = norm.filter((m) => !m.content).length;
    if (norm.length > 0 && emptyish >= norm.length * 0.6) {
      const probe = msgs[0] || {};
      const keys = Object.keys(probe).map((k) => {
        const v = probe[k];
        return Array.isArray(v) ? k + '[]' : (v && typeof v === 'object' ? k + '{}' : k);
      });
      log('⚠️ ' + emptyish + '/' + norm.length + ' 条消息正文为空，首条结构：' + keys.join(','), 'warn');
    }
    norm.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    return { messages: norm, chat_session: d.chat_session || null };
  }

  /* ---------------- 数据规范化 ---------------- */
  function normalizeSession(s) {
    s = s || {};
    return {
      id: String(s.id || s.chat_session_id || s.session_id || ''),
      title: String(s.title || s.name || '（未命名会话）'),
      created_at: toTs(s.created_at != null ? s.created_at : s.create_time),
      update_time: toTs(s.update_time != null ? s.update_time :
        (s.updated_at != null ? s.updated_at : (s.created_at != null ? s.created_at : s.create_time))),
      raw: s
    };
  }

  /** 消息正文可能是字符串、分段数组或嵌套对象，统一抽成纯文本 */
  function extractText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (typeof content === 'number' || typeof content === 'boolean') return String(content);
    if (Array.isArray(content)) {
      return content.map(extractText).filter(Boolean).join('\n');
    }
    if (typeof content === 'object') {
      if (typeof content.text === 'string') return content.text;
      if ('content' in content) return extractText(content.content);
      return '';
    }
    return '';
  }

  function normalizeMessage(m) {
    m = m || {};
    // 11-16 第三轮：新端点把正文套在 msg/message 里（可能是对象或 JSON 字符串），先扒壳
    const inner = (() => {
      const cands = [m.msg, m.message, m.data];
      for (const c of cands) {
        if (!c) continue;
        if (typeof c === 'string') { try { return JSON.parse(c); } catch (_) { continue; } }
        if (typeof c === 'object') return c;
      }
      return null;
    })();
    const src = Object.assign({}, inner || {}, m); // 外层字段优先，内层兜底
    let content = extractText(src.content);
    if (!content && src.groups != null) content = extractText(src.groups);
    let reasoning = extractText(
      src.reasoning_content != null ? src.reasoning_content : src.reasoning);
    if (!reasoning && src.groups != null) {
      try {
        const g = Array.isArray(src.groups) ? src.groups : [src.groups];
        reasoning = g.map((x) => extractText(x && (x.reasoning_content != null ? x.reasoning_content : x.reasoning)))
          .filter(Boolean).join('\n');
      } catch (_) { /* ignore */ }
    }
    // 11-16 第四轮（结构证词指路）：新格式正文在 fragments[]——流式片段数组，逐片抽取拼接
    if (Array.isArray(m.fragments) && m.fragments.length) {
      const parts = [], rs = [];
      for (const f of m.fragments) {
        if (f == null) continue;
        let fo = f;
        if (typeof fo === 'string') { try { fo = JSON.parse(fo); } catch (_) { parts.push(f); continue; } }
        if (fo && typeof fo === 'object') {
          const t = extractText(fo.content != null ? fo.content : (fo.text != null ? fo.text : (fo.delta != null ? fo.delta : '')));
          if (t) parts.push(t);
          const r = extractText(fo.reasoning_content != null ? fo.reasoning_content : (fo.reasoning != null ? fo.reasoning : ''));
          if (r) rs.push(r);
        }
      }
      if (!content && parts.length) content = parts.join('');
      if (!reasoning && rs.length) reasoning = rs.join('\n');
    }
    return {
      id: m.id != null ? m.id : (m.message_id != null ? m.message_id : null),
      role: (src.role || m.role || m.name || '').toLowerCase() || null,
      content,
      reasoning,
      created_at: toTs(m.created_at != null ? m.created_at : (m.inserted_at != null ? m.inserted_at : (m.create_time != null ? m.create_time : (m.dt != null ? m.dt : m.timestamp)))),
      model: src.model || m.model || null,
      raw: m
    };
  }

  /* ---------------- 渲染为 Markdown ---------------- */
  function roleLabel(m) {
    if (m.role === 'user') return '👤 用户';
    if (m.role === 'assistant') return '🤖 DeepSeek';
    if (m.role === 'system') return '⚙️ System';
    return 'ℹ️ ' + (m.role || 'unknown');
  }

  function buildSessionMarkdown(sess, messages) {
    const L = [];
    L.push('# ' + sess.title);
    L.push('');
    L.push('> 会话 ID：`' + sess.id + '`  ');
    L.push('> 创建时间：' + fmtTime(sess.created_at) + ' ｜ 最后更新：' + fmtTime(sess.update_time) +
      ' ｜ 消息数：' + messages.length + '  ');
    L.push('> 导出时间：' + fmtTime(Date.now()) + ' ｜ 工具：DeepSeek 聊天记录导出 v' + VERSION);
    L.push('');
    L.push('---');
    for (const m of messages) {
      L.push('');
      L.push('## ' + roleLabel(m) +
        (m.created_at ? ' · ' + fmtTime(m.created_at) : '') +
        (m.model ? ' · `' + m.model + '`' : ''));
      L.push('');
      if (m.reasoning) {
        L.push('<details><summary>💭 思考过程</summary>');
        L.push('');
        L.push(m.reasoning);
        L.push('');
        L.push('</details>');
        L.push('');
      }
      L.push(m.content || '（空消息）');
    }
    return L.join('\n') + '\n';
  }

  function buildCombinedMarkdown(entries) {
    const parts = [];
    parts.push('# DeepSeek 聊天记录备份');
    parts.push('');
    parts.push('> 导出时间：' + fmtTime(Date.now()) +
      ' ｜ 会话数：' + entries.length +
      ' ｜ 工具版本：v' + VERSION);
    parts.push('');
    parts.push('## 目录');
    parts.push('');
    entries.forEach((e, i) => {
      parts.push((i + 1) + '. ' + e.session.title +
        '（' + e.messages.length + ' 条 · 更新于 ' + fmtTime(e.session.update_time) + '）');
    });
    parts.push('');
    parts.push('---');
    const body = entries.map((e) => buildSessionMarkdown(e.session, e.messages));
    return parts.join('\n') + '\n\n' + body.join('\n\n\n---\n\n\n');
  }

  /* ---------------- 渲染为 JSON ---------------- */
  function buildSessionJsonObj(e, includeRaw) {
    const o = {
      id: e.session.id,
      title: e.session.title,
      created_at: fmtIso(e.session.created_at),
      update_time: fmtIso(e.session.update_time),
      message_count: e.messages.length,
      messages: e.messages.map((m) => {
        const x = { role: m.role, content: m.content, created_at: fmtIso(m.created_at) };
        if (m.reasoning) x.reasoning_content = m.reasoning;
        if (m.model) x.model = m.model;
        if (m.id != null) x.id = m.id;
        return x;
      })
    };
    if (includeRaw) {
      o._raw = {
        session: e.session.raw,
        messages: e.messages.map((m) => m.raw)
      };
    }
    return o;
  }

  function buildCombinedJson(entries, includeRaw) {
    return {
      tool: 'deepseek-export-extension',
      version: VERSION,
      exported_at: new Date().toISOString(),
      session_count: entries.length,
      sessions: entries.map((e) => buildSessionJsonObj(e, includeRaw))
    };
  }

  /* ---------------- 下载 ---------------- */
  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);
  }

  /* ---------------- 并发池 ---------------- */
  async function runPool(items, size, worker, onOneDone) {
    const results = new Array(items.length).fill(null);
    let next = 0;
    let fatal = null;

    async function lane() {
      while (fatal === null) {
        const i = next++;
        if (i >= items.length) return;
        let rec;
        try {
          const v = await worker(items[i], i);
          rec = { item: items[i], ok: true, value: v };
        } catch (e) {
          if (e && e.fatal) { fatal = e; return; }
          rec = { item: items[i], ok: false, error: e };
        }
        results[i] = rec;
        if (onOneDone) onOneDone(i, rec, results.filter(Boolean).length);
      }
    }

    const lanes = [];
    const n = Math.max(1, Math.min(size || 1, items.length));
    for (let k = 0; k < n; k++) lanes.push(lane());
    await Promise.all(lanes);
    return { results, fatal };
  }

  /* ---------------- 状态 ---------------- */
  const state = {
    sessions: [],
    loadingList: false,
    checked: new Set(),
    filter: '',
    exporting: false,
    failedTargets: [],
    currentId: (location.pathname.match(/\/c\/([0-9a-zA-Z-]+)/) || [])[1] || null,
    panelOpen: false
  };

  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(LS_SETTINGS)) || {}; }
    catch (_) { return {}; }
  }
  function saveSettings(s) {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); } catch (_) { /* ignore */ }
  }

  /* ---------------- UI 构建 ---------------- */
  const st = loadSettings();

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  const launcher = el(
    '<button id="dse-launcher" type="button" title="导出聊天记录（Alt+Shift+E）">📥 导出</button>'
  );

  const panel = el(
    '<div id="dse-panel" hidden>' +
    '  <div class="dse-header">' +
    '    <span class="dse-title">📥 DeepSeek 聊天记录导出 <small>v' + VERSION + '</small></span>' +
    '    <button id="dse-close" class="dse-iconbtn" title="关闭">✕</button>' +
    '  </div>' +
    '  <div class="dse-toolbar">' +
    '    <label>格式 <select id="dse-format">' +
    '      <option value="md">Markdown</option>' +
    '      <option value="json">JSON</option>' +
    '      <option value="both">Markdown + JSON</option>' +
    '    </select></label>' +
    '    <label>文件 <select id="dse-filemode">' +
    '      <option value="merge">合并为单文件</option>' +
    '      <option value="per">每个会话单独文件</option>' +
    '    </select></label>' +
    '    <label>并发 <select id="dse-concurrency">' +
    '      <option value="1">1（最稳）</option>' +
    '      <option value="3">3</option>' +
    '      <option value="5">5</option>' +
    '    </select></label>' +
    '    <label class="dse-checklabel"><input type="checkbox" id="dse-raw"> JSON 含原始数据</label>' +
    '  </div>' +
    '  <div class="dse-tokenrow">' +
    '    <input id="dse-manual-token" type="password" autocomplete="off" placeholder="自动检测失败时：手动粘贴 accessToken（按 F12 → Application/应用 → Local Storage 找 auth/token 相关键）">' +
    '    <button id="dse-save-token" class="dse-btn">保存令牌</button>' +
    '    <button id="dse-clear-token" class="dse-btn">清除</button>' +
    '  </div>' +
    '  <div class="dse-actions">' +
    '    <button id="dse-refresh" class="dse-btn">🔄 刷新列表</button>' +
    '    <button id="dse-selall" class="dse-btn">全选</button>' +
    '    <button id="dse-selinvert" class="dse-btn">反选</button>' +
    '    <button id="dse-export-cur" class="dse-btn">导出当前会话</button>' +
    '  </div>' +
    '  <input id="dse-search" class="dse-search" type="search" placeholder="搜索会话标题 / ID…">' +
    '  <div class="dse-countline" id="dse-countline">尚未加载会话列表</div>' +
    '  <div id="dse-list" class="dse-list"><div class="dse-empty">点击「🔄 刷新列表」加载你的全部会话</div></div>' +
    '  <div class="dse-export-row">' +
    '    <button id="dse-export-sel" class="dse-btn dse-primary" disabled>导出已选（0）</button>' +
    '    <button id="dse-export-all" class="dse-btn dse-primary">导出全部会话</button>' +
    '    <button id="dse-retry-failed" class="dse-btn dse-warn" hidden>重试失败项</button>' +
    '  </div>' +
    '  <div class="dse-progress"><div id="dse-bar"></div></div>' +
    '  <div id="dse-proglabel" class="dse-proglabel"></div>' +
    '  <div id="dse-log" class="dse-log"></div>' +
    '  <div class="dse-footer">数据仅在本机浏览器拉取生成，不上传任何第三方 · 快捷键 <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd></div>' +
    '</div>'
  );

  document.body.appendChild(launcher);
  document.body.appendChild(panel);

  const $ = (id) => document.getElementById(id);
  $('dse-format').value = st.format || 'md';
  $('dse-filemode').value = st.filemode || 'merge';
  $('dse-concurrency').value = String(st.concurrency || 3);
  $('dse-raw').checked = !!st.raw;

  ['dse-format', 'dse-filemode', 'dse-concurrency', 'dse-raw'].forEach((id) => {
    $(id).addEventListener('change', () => {
      saveSettings({
        format: $('dse-format').value,
        filemode: $('dse-filemode').value,
        concurrency: Number($('dse-concurrency').value),
        raw: $('dse-raw').checked
      });
    });
  });

  /* 手动令牌 */
  const manualInput = $('dse-manual-token');
  try { manualInput.value = localStorage.getItem('dse_manual_token') || ''; } catch (_) { /* ignore */ }
  $('dse-save-token').addEventListener('click', () => {
    const v = manualInput.value.trim();
    if (!v) { log('令牌输入为空。', 'warn'); return; }
    try { localStorage.setItem('dse_manual_token', v); } catch (_) { /* ignore */ }
    log('已保存手动令牌，正在重新加载会话列表…', 'ok');
    refreshSessions();
  });
  $('dse-clear-token').addEventListener('click', () => {
    try { localStorage.removeItem('dse_manual_token'); } catch (_) { /* ignore */ }
    manualInput.value = '';
    log('已清除手动令牌，将改回自动检测。', 'ok');
  });

  /* ---------------- UI 行为 ---------------- */
  function togglePanel(force) {
    state.panelOpen = force != null ? force : !state.panelOpen;
    panel.hidden = !state.panelOpen;
    if (state.panelOpen && !state.sessions.length && !state.loadingList) refreshSessions();
  }
  launcher.addEventListener('click', () => togglePanel());
  $('dse-close').addEventListener('click', () => togglePanel(false));
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
      e.preventDefault();
      togglePanel();
    }
  });

  function log(msg, cls) {
    const box = $('dse-log');
    const line = document.createElement('div');
    if (cls) line.className = 'dse-log-' + cls;
    line.textContent = '[' + fmtTime(Date.now()) + '] ' + msg;
    box.appendChild(line);
    while (box.childElementCount > 400) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function setProgress(done, total, label) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    $('dse-bar').style.width = pct + '%';
    $('dse-proglabel').textContent = label || (total > 0 ? done + ' / ' + total + '（' + pct + '%）' : '');
  }

  function setBusy(busy) {
    state.exporting = busy;
    ['dse-export-sel', 'dse-export-all', 'dse-export-cur', 'dse-refresh', 'dse-retry-failed']
      .forEach((id) => { $(id).disabled = busy; });
    updateSelectionUI();
  }

  function filteredSessions() {
    const q = state.filter.trim().toLowerCase();
    if (!q) return state.sessions;
    return state.sessions.filter((s) =>
      s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
  }

  function updateSelectionUI() {
    const sel = $('dse-export-sel');
    sel.textContent = '导出已选（' + state.checked.size + '）';
    sel.disabled = state.exporting || state.checked.size === 0;
    $('dse-countline').textContent =
      '共 ' + state.sessions.length + ' 个会话 · 当前筛选 ' + filteredSessions().length +
      ' 个 · 已选 ' + state.checked.size + ' 个' +
      (state.currentId ? ' · 正在查看的会话已在列表中标注「当前」' : '');
  }

  function renderList() {
    const list = $('dse-list');
    const items = filteredSessions();
    if (!items.length) {
      list.innerHTML = '<div class="dse-empty">' +
        (state.sessions.length ? '没有匹配当前搜索的会话' : '暂无会话，点击「🔄 刷新列表」加载') +
        '</div>';
      updateSelectionUI();
      return;
    }
    list.innerHTML = items.map((s) =>
      '<label class="dse-item' + (state.checked.has(s.id) ? ' on' : '') +
      (s.id === state.currentId ? ' cur' : '') + '" data-id="' + escHtml(s.id) + '">' +
      '<input type="checkbox"' + (state.checked.has(s.id) ? ' checked' : '') + '>' +
      '<span class="dse-item-t">' + escHtml(s.title) +
      (s.id === state.currentId ? ' <em class="dse-tag">当前</em>' : '') + '</span>' +
      '<span class="dse-item-m">' + fmtTime(s.update_time) + '</span>' +
      '</label>'
    ).join('');
    updateSelectionUI();
  }

  $('dse-list').addEventListener('change', (e) => {
    const item = e.target.closest('.dse-item');
    if (!item) return;
    const id = item.getAttribute('data-id');
    if (e.target.checked) state.checked.add(id); else state.checked.delete(id);
    item.classList.toggle('on', e.target.checked);
    updateSelectionUI();
  });

  $('dse-search').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderList();
  });

  $('dse-selall').addEventListener('click', () => {
    filteredSessions().forEach((s) => state.checked.add(s.id));
    renderList();
  });
  $('dse-selinvert').addEventListener('click', () => {
    filteredSessions().forEach((s) => {
      if (state.checked.has(s.id)) state.checked.delete(s.id);
      else state.checked.add(s.id);
    });
    renderList();
  });

  async function refreshSessions() {
    if (state.loadingList) return;
    state.loadingList = true;
    $('dse-refresh').disabled = true;
    try {
      if (!getToken()) {
        log('未检测到登录令牌，将先尝试直接使用浏览器 Cookie 访问接口；若仍失败，请在上方「手动粘贴令牌」中填入 accessToken。', 'warn');
      }
      log('正在拉取会话列表…');
      const sessions = await fetchAllSessions((n) => {
        $('dse-countline').textContent = '正在加载会话列表…已发现 ' + n + ' 个';
      });
      state.sessions = sessions;
      // 丢掉已不存在的勾选
      const ids = new Set(sessions.map((s) => s.id));
      state.checked.forEach((id) => { if (!ids.has(id)) state.checked.delete(id); });
      renderList();
      log('会话列表加载完成，共 ' + sessions.length + ' 个。', 'ok');
      if (sessions.length) {
        const seven = sessions.filter((s) => {
          const t = s.update_time || s.created_at;
          return t && (Date.now() - t) > 7 * 86400 * 1000;
        }).length;
        if (seven > 0) log('提示：其中 ' + seven + ' 个会话已超过 7 天未活跃，属于清理风险对象，建议尽快完整备份。', 'warn');
      }
    } catch (e) {
      log('加载会话列表失败：' + (e && e.message || e), 'err');
      if (e && e.fatal) {
        log('键名诊断（仅名称、不含内容），可据此在 F12 里找到令牌所在键：' + diagKeys(), 'warn');
      }
    } finally {
      state.loadingList = false;
      $('dse-refresh').disabled = state.exporting;
    }
  }
  $('dse-refresh').addEventListener('click', refreshSessions);

  /* ---------------- 导出主流程 ---------------- */
  async function doExport(targets, whatLabel) {
    if (state.exporting) return;
    targets = targets.filter(Boolean);
    if (!targets.length) { log('没有可导出的会话。', 'warn'); return; }
    if (!getToken()) {
      log('未检测到登录令牌，将尝试直接使用浏览器 Cookie；若失败请用面板上方「手动粘贴令牌」。', 'warn');
    }

    const opts = {
      format: $('dse-format').value,
      filemode: $('dse-filemode').value,
      concurrency: Number($('dse-concurrency').value),
      raw: $('dse-raw').checked
    };

    if (opts.filemode === 'per' && targets.length > 5 &&
        !confirm('将连续下载 ' + targets.length * (opts.format === 'both' ? 2 : 1) +
          ' 个文件，浏览器可能会询问「是否允许下载多个文件」，请选择允许。继续？')) {
      return;
    }

    togglePanel(true);
    setBusy(true);
    state.failedTargets = [];
    log('开始' + whatLabel + '：' + targets.length + ' 个会话（格式 ' + opts.format +
      '，' + (opts.filemode === 'merge' ? '合并单文件' : '每会话单文件') + '，并发 ' + opts.concurrency + '）');

    const stamp = stampName();
    const entries = new Array(targets.length).fill(null);

    setProgress(0, targets.length, '准备中…');
    const { fatal } = await runPool(
      targets, opts.concurrency,
      async (sess, i) => {
        await sleep(120);
        const h = await fetchHistory(sess.id);
        entries[i] = { session: sess, messages: h.messages };
        return sess;
      },
      (i, rec, done) => {
        if (rec.ok) {
          log('✓ ' + rec.item.title + '（' + (entries[i] ? entries[i].messages.length : 0) + ' 条消息）', 'ok');
        } else {
          log('✗ ' + rec.item.title + '：' + (rec.error && rec.error.message || rec.error), 'err');
        }
        setProgress(done, targets.length);
      }
    );

    if (fatal) {
      log('导出中断：' + fatal.message, 'err');
      setBusy(false);
      return;
    }

    const okEntries = entries.filter(Boolean);
    state.failedTargets = targets.filter((s, i) => !entries[i]);

    /* 生成文件 */
    log('拉取完成（成功 ' + okEntries.length + ' / ' + targets.length + '），正在生成本地文件…');
    try {
      if (opts.filemode === 'merge') {
        if (okEntries.length) {
          if (opts.format !== 'json') {
            downloadText(stamp + '_全部会话.md', buildCombinedMarkdown(okEntries), 'text/markdown');
            log('已下载合并 Markdown：' + stamp + '_全部会话.md', 'ok');
          }
          if (opts.format !== 'md') {
            downloadText(stamp + '_全部会话.json',
              JSON.stringify(buildCombinedJson(okEntries, opts.raw), null, 2), 'application/json');
            log('已下载合并 JSON：' + stamp + '_全部会话.json', 'ok');
          }
        }
      } else {
        let doneFiles = 0;
        const totalFiles = okEntries.length;
        setProgress(0, totalFiles, '下载文件中…');
        for (let i = 0; i < okEntries.length; i++) {
          const e = okEntries[i];
          const base = pad2(i + 1) + '_' + sanitizeName(e.session.title) + '_' + e.session.id.slice(0, 8);
          if (opts.format !== 'json') {
            downloadText(base + '.md', buildSessionMarkdown(e.session, e.messages), 'text/markdown');
          }
          if (opts.format !== 'md') {
            downloadText(base + '.json',
              JSON.stringify(buildSessionJsonObj(e, opts.raw), null, 2), 'application/json');
          }
          doneFiles++;
          setProgress(doneFiles, totalFiles, '下载文件中…');
          await sleep(400);
        }
      }
    } catch (e) {
      log('生成/下载文件失败：' + (e && e.message || e), 'err');
    }

    if (state.failedTargets.length) {
      log('完成，但有 ' + state.failedTargets.length + ' 个会话失败，可点击「重试失败项」。', 'warn');
      const rb = $('dse-retry-failed');
      rb.hidden = false;
      rb.textContent = '重试失败项（' + state.failedTargets.length + '）';
    } else {
      log('全部导出完成 🎉 共 ' + okEntries.length + ' 个会话。', 'ok');
      $('dse-retry-failed').hidden = true;
    }
    setProgress(okEntries.length, targets.length,
      '完成：成功 ' + okEntries.length + ' / ' + targets.length);
    setBusy(false);
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  $('dse-export-sel').addEventListener('click', () => {
    const targets = state.sessions.filter((s) => state.checked.has(s.id));
    doExport(targets, '导出已选');
  });
  $('dse-export-all').addEventListener('click', async () => {
    if (!state.sessions.length) { await refreshSessions(); }
    if (state.sessions.length &&
        !confirm('将导出全部 ' + state.sessions.length + ' 个会话，可能需要几分钟。继续？')) return;
    doExport(state.sessions, '导出全部');
  });
  $('dse-export-cur').addEventListener('click', () => {
    if (!state.currentId) { log('当前页面似乎不是某个会话（URL 中没有 /c/xxx），无法定位“当前会话”。', 'warn'); return; }
    const known = state.sessions.find((s) => s.id === state.currentId);
    doExport([known || { id: state.currentId, title: document.title || '当前会话', created_at: null, update_time: null, raw: null }], '导出当前会话');
  });
  $('dse-retry-failed').addEventListener('click', () => {
    doExport(state.failedTargets, '重试失败项');
  });

  log('插件已加载。打开任意 DeepSeek 会话页即可使用；首次使用请先点「刷新列表」。');
})();
