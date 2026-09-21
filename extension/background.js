/* RB 扩展后台：心跳 + 任务领取 + 事件回传 + 与画布页 content script 通信 */
'use strict';
const ROOT = 'http://localhost:8899';
const WORKER = 'ext-' + String(chrome.runtime.id || 'x' + Math.random().toString(36).slice(2, 8)).slice(0, 10).replace(/[^a-zA-Z0-9-]/g, '');
const CANVAS_URLS = ['*://*.runroll.cn/*', '*://runroll.cn/*', '*://*.updream.cn/*', '*://updream.cn/*'];

async function post(url, body) {
  const r = await fetch(ROOT + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}

async function heartbeat(tabId) {
  try {
    const st = await chrome.tabs.sendMessage(tabId, { type: 'RB_STATUS' });
    if (st && st.platform) {
      await post('/__bridge/heartbeat', { platform: st.platform, pageUrl: st.pageUrl, worker: WORKER, models: st.models });
      return true;
    }
  } catch (e) { /* 内容脚本未就绪 */ }
  return false;
}

async function pollJobs(tabId) {
  try {
    const r = await (await fetch(ROOT + '/__jobs/next?worker=' + WORKER)).json();
    if (r.job) {
      try { await chrome.tabs.sendMessage(tabId, { type: 'RB_JOB', job: r.job }); }
      catch (e) { await post('/__jobs/' + r.job.id + '/done', { ok: false, result: '画布页不可达，请刷新画布标签页' }); }
    }
  } catch (e) { /* 服务未启动，静默 */ }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'RB_TICK' && sender.tab) {
    (async () => {
      const alive = await heartbeat(sender.tab.id);
      if (alive) await pollJobs(sender.tab.id);
      sendResponse({ ok: alive });
    })();
    return true;
  }
  if (msg.type === 'RB_EVENT') {
    post('/__jobs/' + msg.id + '/events', { msg: msg.msg, pct: msg.pct }).catch(() => {});
    sendResponse({ ok: true });
  }
  if (msg.type === 'RB_JOB_DONE') {
    post('/__jobs/' + msg.id + '/done', { ok: msg.ok, result: msg.result }).catch(() => {});
    sendResponse({ ok: true });
  }
});
