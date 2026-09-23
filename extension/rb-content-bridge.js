/* RB 扩展内容脚本桥：在画布页执行 RBCore 任务，与扩展后台通信。
 * 依赖 rb-core.js 与各适配器已在同一 content script 中先行加载。 */
(function () {
  'use strict';
  if (!window.RBCore) { console.warn('[RB] rb-core 未加载'); return; }

  let modelsCache = null, modelsAt = 0, busy = false;

  async function refreshModels() {
    const a = window.RBCore.pickAdapter();
    if (a && a.listModels && Date.now() - modelsAt > 5 * 60 * 1000) {
      try { modelsCache = await a.listModels(); modelsAt = Date.now(); } catch (e) { modelsCache = modelsCache || null; }
    }
    return modelsCache;
  }

  function report(id, msg, pct) {
    try { chrome.runtime.sendMessage({ type: 'RB_EVENT', id, msg, pct }).catch(() => {}); } catch (e) {}
    console.log('[RB·任务' + id + '] ' + msg);
  }

  async function execJob(job) {
    const { cfg } = job;
    const type = (cfg && cfg.type) || job.type;   // 服务端旧版会把 probe 归成 import，以 cfg.type 为准
    const C = window.RBCore.cfg;
    ['episodes', 'model', 'aspect', 'duration', 'resolution', 'perColumn', 'tags', 'clearFirst', 'minDuration'].forEach(k => {
      if (cfg && cfg[k] !== undefined) C[k] = cfg[k];
    });
    if (type === 'probe') {
      const a = window.RBCore.pickAdapter();
      if (!a || !a.probe) throw new Error('当前平台适配器不支持探针');
      await report(job.id, '探针读取画布节点 ' + (cfg.segId || '') + '…', 30);
      const r = await a.probe(cfg.segId || '', cfg || {});
      try { chrome.runtime.sendMessage({ type: 'RB_JOB_DONE', id: job.id, ok: true, result: r }).catch(() => {}); } catch (e) {}
      return;
    }
    if (type === 'chain') {
      // 链式生成：代点+截帧+建参考边，全部会动画布，走与一键直通相同的 confirm=build 保险丝
      if (!cfg || cfg.confirm !== 'build') throw new Error('chain 任务缺 confirm=build，已拒绝');
      const a = window.RBCore.pickAdapter();
      if (!a || !a.chainRun) throw new Error('当前平台适配器不支持链式生成');
      await report(job.id, '链式生成：' + (cfg.segs || []).length + ' 段排队…', 5);
      const r = await a.chainRun(cfg, (m, p) => report(job.id, m, p));
      try { chrome.runtime.sendMessage({ type: 'RB_JOB_DONE', id: job.id, ok: true, result: r }).catch(() => {}); } catch (e) {}
      return;
    }
    if (type === 'ref') {
      // 截帧挂参考：会动画布（上传建图节点+连线），必须带 confirm=build（与一键直通同保险丝）
      if (!cfg || cfg.confirm !== 'build') throw new Error('ref 任务缺 confirm=build，已拒绝');
      const a = window.RBCore.pickAdapter();
      if (!a || !a.hangRef) throw new Error('当前平台适配器不支持挂参考');
      await report(job.id, '截帧挂参考 ' + (cfg.fromLabel || cfg.fromUid) + ' → ' + (cfg.toLabel || cfg.toUid) + '…', 20);
      const r = await a.hangRef(cfg);
      try { chrome.runtime.sendMessage({ type: 'RB_JOB_DONE', id: job.id, ok: true, result: r }).catch(() => {}); } catch (e) {}
      return;
    }
    if (type !== 'plan' && (!cfg || cfg.confirm !== 'build')) {
      // 2026-09-22 保险丝：不带确认标记的任务一律拒绝导入，防止误触顶掉画布上已有节点（含已生成的视频）
      throw new Error('任务缺确认标记（confirm=build），已拒绝执行导入——只有工作台「一键直通」按钮能触发建删');
    }
    await report(job.id, '解析分镜…', 5);
    const parsed = await window.RBCore.parse();
    await report(job.id, '解析完成：' + parsed.segments + ' 段 / ' + parsed.files + ' 个素材', 15);
    if (type === 'plan') {
      await report(job.id, '核对规划…', 40);
      const plan = await window.RBCore.plan();
      await refreshModels();
      try { chrome.runtime.sendMessage({ type: 'RB_JOB_DONE', id: job.id, ok: true, result: { ...plan, models: modelsCache } }).catch(() => {}); } catch (e) {}
      return;
    }
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
    window.RBCore.S.plan = null;
    await report(job.id, '建节点与参考连线…', 65);
    const built = await window.RBCore.build();
    await report(job.id, '完成', 100);
    try { chrome.runtime.sendMessage({ type: 'RB_JOB_DONE', id: job.id, ok: true, result: { plan: plan0, built, cfg: { episodes: C.episodes, model: C.model, aspect: C.aspect } } }).catch(() => {}); } catch (e) {}
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'RB_STATUS') {
      refreshModels().then(m => sendResponse({
        platform: (window.RBCore.pickAdapter() || {}).name || null,
        pageUrl: location.href,
        models: m,
        busy,
      })).catch(() => sendResponse(null));
      return true;
    }
    if (msg.type === 'RB_JOB') {
      if (busy) { sendResponse({ ok: false, reason: 'busy' }); return; }
      busy = true;
      execJob(msg.job)
        .then(() => { busy = false; sendResponse({ ok: true }); })
        .catch(e => {
          busy = false;
          try { chrome.runtime.sendMessage({ type: 'RB_JOB_DONE', id: msg.job.id, ok: false, result: String(e && e.message || e) }).catch(() => {}); } catch (e2) {}
          sendResponse({ ok: false, reason: 'error' });
        });
      return true;
    }
  });

  // 心跳驱动：每 8 秒唤醒后台（后台据此心跳 + 领任务）
  setInterval(() => {
    try { chrome.runtime.sendMessage({ type: 'RB_TICK' }).catch(() => {}); } catch (e) {}
  }, 8000);
  setTimeout(() => { try { chrome.runtime.sendMessage({ type: 'RB_TICK' }).catch(() => {}); } catch (e) {} }, 3000);
  console.log('%c[RB] 扩展内容桥就绪（' + ((window.RBCore.pickAdapter() || {}).name || '未知平台') + '）', 'color:#0a0;font-weight:bold');
})();
