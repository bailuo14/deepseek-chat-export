/* 冒烟测试：jsdom 模拟 chat.deepseek.com 页面，伪造接口数据，完整走一遍导出流程 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = readFileSync(path.join(__dirname, '..', 'deepseek-export-extension', 'content.js'), 'utf8');

/* ---------- 伪造的 DeepSeek 接口数据（时间用相对当前时刻，保证排序可预期） ---------- */
const NOW = Date.now();
const HOUR = 3600e3, DAY = 24 * HOUR;
const SESSIONS = {
  s1: { id: 's1', title: 'Rust 生命周期讨论', created_at: NOW - 20 * DAY, update_time: NOW - 1 * HOUR },
  s2: { id: 's2', title: '周报/未命名 测试:特殊*字符?', created_at: NOW - 30 * DAY, update_time: NOW - 3 * DAY },
  s3: { id: 's3', title: '老会话（10天没动，清理风险）', created_at: NOW - 40 * DAY, update_time: NOW - 10 * DAY }
};
const HISTORIES = {
  s1: {
    data: {
      chat_session: { id: 's1' },
      messages: [
        { id: 'm1', role: 'user', content: '解释一下 <b>Rust> 生命周期', created_at: NOW - 2 * HOUR },
        { id: 'm2', role: 'assistant', content: '生命周期标注语法是 `\'a`。', reasoning_content: '用户想要简短解释。', model: 'deepseek-chat', created_at: NOW - 1 * HOUR - 50 * 60e3 }
      ]
    }
  },
  s2: {
    data: {
      messages: [
        // 故意用分段数组 content + 秒级时间戳，测试规范化
        { role: 'user', content: [{ text: '第一段' }, { text: '第二段' }], created_at: (NOW - 3 * DAY) / 1000 },
        { role: 'assistant', content: '好的。', created_at: (NOW - 3 * DAY + 90e3) / 1000, model: 'deepseek-reasoner' }
      ]
    }
  },
  s3: { data: { messages: [{ role: 'user', content: '旧问题', created_at: NOW - 10 * DAY }] } }
};

let fetchCalls = [];
let authSeen = [];
function fakeFetch(url, opts) {
  fetchCalls.push(url);
  if (opts && opts.headers && opts.headers['Authorization']) authSeen.push(opts.headers['Authorization']);
  const u = new URL(url);
  const json = (obj) => Promise.resolve({ ok: true, status: 200, json: async () => obj });

  if (u.pathname.endsWith('/chat_session/fetch_page')) {
    // 11-16 新端点：游标翻页。第一页 s1/s2，带 update_time 游标续页返回 s3。
    const cur = u.searchParams.get('lte_cursor.update_time');
    // 真实世界形状（11-16 实测）：令牌有效时 API 回 biz 信封
    if (!cur) return json({ biz_code: 0, biz_msg: '', biz_data: { sessions: [SESSIONS.s1, SESSIONS.s2] } });
    return json({ biz_code: 0, biz_msg: '', biz_data: { sessions: [SESSIONS.s3] } });
  }
  if (u.pathname.endsWith('/chat_session/fetch_all')) {
    // 旧端点已退役：模拟真实世界——返回 HTML（触发扩展走新端点/诊断路径）
    return Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token '<'"); } });
  }
  if (u.pathname.endsWith('/chat/history_messages')) {
    const id = u.searchParams.get('chat_session_id');
    if (!HISTORIES[id]) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return json(HISTORIES[id]);
  }
  if (u.pathname.endsWith('/chat_history/fetch_chat_session')) {
    const id = u.searchParams.get('chat_session_id');
    if (!HISTORIES[id]) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return json(HISTORIES[id]);
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
}

/* ---------- 搭 jsdom 环境 ---------- */
const virtualConsole = new VirtualConsole(); // 吞掉 <a>.click() 触发的 not-implemented navigation 噪音
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://chat.deepseek.com/c/s1',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
  virtualConsole
});
const { window } = dom;

window.fetch = fakeFetch;
window.confirm = () => true;
window.localStorage.setItem('auth', JSON.stringify({ accessToken: 'test-token' }));

/* 捕获下载：记录 blob 内容 + 文件名 */
const downloads = [];
const nameByUrl = new Map();
let blobSeq = 0;
window.URL.createObjectURL = (blob) => {
  const name = 'blob:' + (++blobSeq);
  blob.text().then((text) => downloads.push({ url: name, text, size: text.length }));
  return name;
};
window.URL.revokeObjectURL = () => {};
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = (tag) => {
  const node = origCreate(tag);
  if (String(tag).toLowerCase() === 'a') {
    const origClick = node.click.bind(node);
    node.click = () => { nameByUrl.set(node.href, node.download); return origClick(); };
  }
  return node;
};

/* 注入被测脚本 */
window.eval(script);

const $ = (id) => window.document.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 断言工具 ---------- */
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra ? '  →  ' + extra : '')); }
}
const waitUntil = async (fn, ms = 8000, step = 50) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(step); }
  return false;
};
const idle = () => waitUntil(() => !$('dse-export-all').disabled && !$('dse-export-sel').disabled);

console.log('== 冒烟测试：DeepSeek 导出扩展 ==\n');

/* 1. 注入与 UI */
console.log('[1] 注入与 UI');
check('悬浮按钮存在', !!$('dse-launcher'));
check('面板存在且默认隐藏', !!$('dse-panel') && $('dse-panel').hidden);
$('dse-launcher').click();
check('点击后面板打开', !$('dse-panel').hidden);
check('自动开始加载列表（fetch_page 被调用）',
  await waitUntil(() => fetchCalls.some(u => u.includes('fetch_page'))));

/* 2. 会话列表 */
console.log('[2] 会话列表');
check('列表加载完成（3 个会话）', await waitUntil(() => $('dse-countline').textContent.includes('共 3 个会话')));
check('按最近活跃排序：s1 第一、s3 最后',
  $('dse-list').querySelector('.dse-item').getAttribute('data-id') === 's1' &&
  [...$('dse-list').querySelectorAll('.dse-item')].pop().getAttribute('data-id') === 's3');
check('当前会话标注', $('dse-list').innerHTML.includes('当前'));
check('7 天风险提醒出现', await waitUntil(() => $('dse-log').textContent.includes('清理风险')));

/* 3. 搜索与勾选 */
console.log('[3] 搜索与勾选');
$('dse-search').value = 'rust';
$('dse-search').dispatchEvent(new window.Event('input', { bubbles: true }));
check('搜索过滤只剩 1 条', $('dse-list').querySelectorAll('.dse-item').length === 1);
$('dse-selall').click();
check('全选后按钮计数更新', $('dse-export-sel').textContent.includes('1'));
check('导出已选按钮已启用', !$('dse-export-sel').disabled);
$('dse-search').value = '';
$('dse-search').dispatchEvent(new window.Event('input', { bubbles: true }));
$('dse-selinvert').click();
check('反选后 2 个被选', $('dse-export-sel').textContent.includes('2'));
$('dse-selinvert').click();
check('再反选回到 1 个', $('dse-export-sel').textContent.includes('1'));

/* 4. 合并导出（Markdown，默认设置） */
console.log('[4] 合并导出 Markdown');
$('dse-selall').click(); // 全选 3 个
$('dse-export-sel').click();
check('导出完成（日志+按钮恢复）', await waitUntil(() => $('dse-log').textContent.includes('全部导出完成') && !$('dse-export-sel').disabled));
await waitUntil(() => downloads.length >= 1);
check('合并模式只产生 1 个文件', downloads.length === 1, '实际 ' + downloads.length);
const md = downloads[0] ? downloads[0].text : '';
const mdName = downloads[0] ? nameByUrl.get(downloads[0].url) : '';
check('文件名形如 DeepSeek备份_日期_时间_全部会话.md', /^DeepSeek备份_\d{8}_\d{4}_全部会话\.md$/.test(mdName || ''), mdName);
check('MD 含目录', md.includes('## 目录'));
check('MD 含全部 3 个会话标题',
  md.includes('# Rust 生命周期讨论') &&
  md.includes('# 周报/未命名 测试:特殊*字符?') &&
  md.includes('# 老会话（10天没动，清理风险）'));
check('正文原样保留（尖括号不被转义破坏）', md.includes('<b>Rust> 生命周期'));
check('思考过程被保留', md.includes('💭 思考过程') && md.includes('用户想要简短解释。'));
check('分段 content 已拼接', md.includes('第一段') && md.includes('第二段'));
check('导出时间戳格式化正常', /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(md));
check('模型名保留', md.includes('`deepseek-reasoner`'));

/* 5. 每会话单独文件 + JSON + raw */
console.log('[5] 单文件模式 JSON（含 raw）');
await idle();
const before = downloads.length;
$('dse-filemode').value = 'per';
$('dse-filemode').dispatchEvent(new window.Event('change', { bubbles: true }));
$('dse-format').value = 'json';
$('dse-format').dispatchEvent(new window.Event('change', { bubbles: true }));
$('dse-raw').checked = true;
$('dse-raw').dispatchEvent(new window.Event('change', { bubbles: true }));
$('dse-export-all').click();
check('3 个会话产生 3 个文件', await waitUntil(() => downloads.length - before === 3));
const files = downloads.slice(before);
const names = files.map(f => nameByUrl.get(f.url));
check('文件名已消毒（不含 : * ? / 等非法字符）', names.every(n => n && !/[\\/:*?"<>|]/.test(n)), JSON.stringify(names));
check('文件带两位序号前缀', names.every((n, i) => n && n.startsWith(String(i + 1).padStart(2, '0'))), JSON.stringify(names));
const obj = JSON.parse(files[0].text);
check('JSON 结构正确', obj.title === 'Rust 生命周期讨论' && obj.messages.length === 2);
check('JSON messages 字段齐全',
  obj.messages[1].reasoning_content === '用户想要简短解释。' &&
  obj.messages[1].model === 'deepseek-chat' && obj.messages[1].role === 'assistant');
check('raw 模式含 _raw', !!obj._raw && Array.isArray(obj._raw.messages));
const obj2 = JSON.parse(files[1].text);
check('分段 content 在 JSON 中也已拼接', obj2.messages[0].content === '第一段\n第二段');
check('秒级时间戳转为 ISO', typeof obj2.messages[0].created_at === 'string' && obj2.messages[0].created_at.includes('T'));

/* 6. 导出当前会话 */
console.log('[6] 导出当前会话（URL /c/s1）');
await idle();
const before3 = downloads.length;
$('dse-format').value = 'md';
$('dse-format').dispatchEvent(new window.Event('change', { bubbles: true }));
$('dse-export-cur').click();
check('导出了 1 个文件', await waitUntil(() => downloads.length === before3 + 1));
const cur = downloads[before3];
check('当前会话文件内容正确', cur && cur.text.includes('# Rust 生命周期讨论'));

/* 7. 令牌多层兜底 */
console.log('[7] 令牌检测兜底');
await idle();
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

// 7a. 令牌不在 auth 键，而是非标准键（裸 JWT）
window.localStorage.removeItem('auth');
window.localStorage.setItem('ds_token', FAKE_JWT);
let n = authSeen.length;
$('dse-refresh').click();
check('非标准键中的 JWT 被自动发现并用于请求', await waitUntil(() => authSeen.length > n && authSeen[n] === 'Bearer ' + FAKE_JWT));
check('列表重新加载成功', await waitUntil(() => $('dse-countline').textContent.includes('共 3 个会话')));

// 7b. 完全没有令牌：不中断，走 Cookie 探测，列表照常加载
window.localStorage.removeItem('ds_token');
window.localStorage.clear();
n = authSeen.length;
$('dse-refresh').click();
check('无令牌时给出提示而非中断', await waitUntil(() => $('dse-log').textContent.includes('将先尝试直接使用浏览器 Cookie')));
check('无令牌请求不带 Authorization', await waitUntil(() => $('dse-countline').textContent.includes('共 3 个会话')) && authSeen.length === n);

// 7c. 手动粘贴令牌：保存后优先使用
$('dse-manual-token').value = 'MANUAL-TOKEN-abcdefghij0123456789';
$('dse-save-token').click();
n = authSeen.length;
check('手动令牌被持久化', window.localStorage.getItem('dse_manual_token') === 'MANUAL-TOKEN-abcdefghij0123456789');
check('保存后自动重新加载列表', await waitUntil(() => $('dse-log').textContent.includes('已保存手动令牌')));
check('手动令牌优先于其他来源', await waitUntil(() => authSeen.length > n) && authSeen[n] === 'Bearer MANUAL-TOKEN-abcdefghij0123456789');
$('dse-clear-token').click();
check('清除手动令牌后回退', window.localStorage.getItem('dse_manual_token') === null);

console.log('\n接口调用次数：' + fetchCalls.length);
console.log('生成文件：' + downloads.map(d => nameByUrl.get(d.url) + '（' + d.size + ' B）').join('\n           '));
console.log(`\n== 结果：${pass} 通过，${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
