// ==UserScript==
// @name         RB 画布批量导入器（多平台·带工作台桥）
// @namespace    rb.batch.importer
// @version      2.0
// @description  在画布平台页面自动加载 RB 核心+适配器：① Ctrl+Alt+B 手动加载；② 已知平台自动加载；③ 与本地「漫剧直出工作台」桥接——工作台切换模型/点一键直通后，素材和节点自动在本画布建好。生成按钮永远不碰。
// @author       Yi & Cola
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
/* 用法（同事版）：
 * 1) 浏览器装 Tampermonkey，新建脚本粘贴本文件保存；
 * 2) 双击 start.bat 启动素材服务（默认 http://localhost:8899）；
 * 3) 打开 Runroll / UpDream 画布页 → 自动加载并连上工作台；
 * 4) 在工作台「🌉 画布直通」面板里选模型、选集数、点一键直通即可。
 * 非已知平台的页面：Ctrl+Alt+B 手动加载。
 */
(function () {
  'use strict';
  const ROOT = localStorage.getItem('rb_assetRoot') || 'http://localhost:8899';
  const TOOL = ROOT + '/__tool/';
  const KNOWN = /(^|\.)runroll\.cn$|(^|\.)updream\.cn$/;
  const WORKER = 'w' + Math.random().toString(36).slice(2, 8);
  let loaded = false, bridging = false;

  const ROOTU = 'http://localhost:8899';
  let modelsCache = null, modelsAt = 0;
  async function load() {
    if (loaded) return;
    for (const f of ['rb-core.js', 'rb-adapter-runroll.js', 'rb-adapter-updream.js', 'rb-adapter-generic.js']) {
      const src = await (await fetch(TOOL + f)).text();
      (new Function(src))();
    }
    window.RBCore.cfg.assetRoot = ROOT;
    loaded = true;
    const a = window.RBCore.pickAdapter();
    console.log('%c[RB] 加载完成，平台：' + (a ? a.name : '未知'), 'color:#0a0;font-weight:bold');
  }

  /* ---------- 工作台桥：心跳 + 领任务 ---------- */
  async function bridgePost(url, body) {
    const r = await fetch(ROOT + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return r.json();
  }
  async function heartbeat() {
    if (!window.RBCore) return;
    const a = window.RBCore.pickAdapter();
    if (!a) return;
    if (a.listModels && Date.now() - modelsAt > 5 * 60 * 1000) {
      try { modelsCache = await a.listModels(); modelsAt = Date.now(); } catch (e) { modelsCache = modelsCache || null; }
    }
    try { await bridgePost('/__bridge/heartbeat', { platform: a.name, pageUrl: location.href, worker: WORKER, models: modelsCache }); } catch (e) {}
  }
  async function report(id, msg, pct) {
    try { await bridgePost('/__jobs/' + id + '/events', { msg, pct }); } catch (e) {}
    console.log('[RB·任务' + id + '] ' + msg);
  }

  async function execJob(job) {
    const { type, cfg } = job;
    const C = window.RBCore.cfg;
    // 覆盖配置（只覆盖传入的字段）
    ['episodes', 'model', 'aspect', 'duration', 'resolution', 'perColumn', 'tags', 'clearFirst', 'minDuration'].forEach(k => {
      if (cfg && cfg[k] !== undefined) C[k] = cfg[k];
    });
    await report(job.id, '解析分镜 MD…', 5);
    const parsed = await window.RBCore.parse();
    await report(job.id, '解析完成：' + parsed.segments + ' 段 / ' + parsed.files + ' 个素材', 15);
    if (type === 'plan') {
      await report(job.id, '核对规划…', 40);
      const plan = await window.RBCore.plan();
      await bridgePost('/__jobs/' + job.id + '/done', { ok: true, result: { ...plan, models: modelsCache } });
      return;
    }
    // import
    const plan0 = await window.RBCore.plan();
    if (plan0.missingUids === 0 && !C.clearFirst) {
      await report(job.id, '素材已齐（' + plan0.assetsOnCanvas + ' 个），跳过上传', 40);
    } else {
      await report(job.id, C.clearFirst ? '清空画布…' : '上传素材：需 ' + plan0.missingUids + ' 个…', 30);
      if (C.clearFirst) { const c = await window.RBCore.clear(); await report(job.id, '清空完成：' + (c.remain || c), 45); }
      const up = await window.RBCore.upload();
      await report(job.id, '上传完成：' + up.uploaded + ' 个' + (up.notFoundAfterUpload && up.notFoundAfterUpload.length ? '，未落位：' + up.notFoundAfterUpload.length : ''), 55);
    }
    C.clearFirst = false; // 清空已在上面完成，防止 build() 内部二次清空
    window.RBCore.S.plan = null; // 强制重新规划，解析新上传的 uid
    await report(job.id, '建节点与参考连线…', 65);
    const built = await window.RBCore.build();
    const plan = window.RBCore.S.plan;
    await report(job.id, '完成', 100);
    await bridgePost('/__jobs/' + job.id + '/done', { ok: true, result: { plan: plan0, built, cfg: { episodes: C.episodes, model: C.model, aspect: C.aspect } } });
  }

  async function bridgeLoop() {
    if (bridging) return; bridging = true;
    let hb = 0;
    while (true) {
      try {
        if (++hb % 5 === 0) await heartbeat();
        const r = await (await fetch(ROOT + '/__jobs/next?worker=' + WORKER)).json();
        if (r.job) {
          try { await execJob(r.job); }
          catch (e) { await bridgePost('/__jobs/' + r.job.id + '/done', { ok: false, result: String(e && e.message || e) }); }
        }
      } catch (e) { /* 服务未启动等，静默重试 */ }
      await new Promise(r2 => setTimeout(r2, 1500));
    }
  }

  async function start() {
    try { await load(); }
    catch (e) { console.log('[RB] 素材服务未就绪，5秒后自动重试…'); setTimeout(start, 5000); return; } // 服务重启/未启动时自动重连
    if (!bridging) { heartbeat(); bridgeLoop(); console.log('[RB] 工作台桥已启动（心跳+领任务）'); }
  }

  function registerMenu() {
    if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('RB 加载批量导入器', start);
    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.altKey && e.code === 'KeyB') { e.preventDefault(); start(); }
    });
    window.RB_A = start;
    // 已知平台画布页自动加载
    if (KNOWN.test(location.hostname)) setTimeout(start, 4000);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') registerMenu();
  else document.addEventListener('DOMContentLoaded', registerMenu);
})();

// Tampermonkey 沙箱提示：@grant none 时脚本运行在页面上下文，
// GM_registerMenuCommand 不可用——已知平台会自动加载，其他页面 Ctrl+Alt+B。
