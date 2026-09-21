/* =============================================================
 * Runroll 画布批量导入器（可复用版）
 * 用法：在 Runroll 画布页面（runroll.cn/my-canvas/.../canvas/...）的控制台粘贴本文件全部内容并回车。
 * 依赖：本地素材服务 asset-server.js 运行在 http://localhost:8899（需 v2，含 /__list）。
 * 约束：只建节点/连线/上传素材，绝不触碰「生成」按钮（积分操作永远由人完成）。
 *
 * 快速上手：
 *   RB.cfg.episodes = [6, 23];      // 集数范围（含两端），或 'all'
 *   RB.cfg.modelName = '低价渠道';  // 见 RB.MODELS，也可直接 RB.cfg.model = 33
 *   await RB.plan();                // 只解析+规划，不动画布；返回清单
 *   await RB.clear();               // （可选）清空当前画布
 *   await RB.upload();              // 上传所需素材
 *   await RB.build();               // 建视频节点 + 自动参考连线 + 排位
 *   // 或一步到位：await RB.run();
 * ============================================================= */
(function () {
  'use strict';

  /* ---------- 模型表：mode/model 绑定，id 来自界面实测 ---------- */
  const MODELS = {
    '满血全能参考': 7,      // Seedance 2.0(满血渠道) 全能参考
    '满血文生': 5,          // Seedance 2.0(满血渠道) 默认
    '低价渠道': 33,         // Seedance 2.0(低价渠道)
  };

  const cfg = {
    assetRoot: 'http://localhost:8899',
    mdFile: 'storyboard.md',
    mappingFile: 'mapping-data.js',
    episodes: 'all',            // [起,止] 或 'all'
    modelName: '低价渠道',      // MODELS 的键；或直接给数字 cfg.model
    model: null,                // 数字优先
    resolution: '720P',
    aspect: '16x9',             // '16x9' | '9x16'
    duration: 'auto',           // 'auto'=按分镜时长(最低4s)，或固定数字
    perColumn: 6,               // 每列节点数，超出换列
    clearFirst: false,          // build 前是否清空画布
    tags: true,                 // 提示词内联【参考图/参考音频】标签
    minDuration: 4,
    origin: { x: 100, y: 100 }, // 排版原点
    charStepX: 520, charStepY: 620, itemStepY: 380,
    colStepX: 700, gridPerCol: 6, epGapCols: 1,
  };

  /* ---------- 运行时状态 ---------- */
  const S = { segs: [], plan: null, uids: null };

  /* ---------- 小工具 ---------- */
  const norm = s => String(s || '')
    .replace(/\.(png|jpg|jpeg|webp|wav|mp3|m4a|flac)$/i, '')
    .replace(/\s*\d{3,4}\s*[×xX]\s*\d{3,4}\s*$/, '')
    .replace(/\d{1,2}:\d{2}\s*\/.*$/, '')
    .trim();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const enc = s => encodeURIComponent(s);

  function api() {
    const tok = localStorage.getItem('access_token');
    const acc = localStorage.getItem('current_account_id') || '';
    return { 'Authorization': 'Bearer ' + tok, 'X-Account-Id': acc, 'Content-Type': 'application/json' };
  }
  function ids() {
    const m = location.href.match(/my-canvas\/(\d+)\/canvas\/(\d+)/);
    if (!m) throw new Error('请先打开 Runroll 画布页面（my-canvas/{项目}/canvas/{画布}）');
    return { projectId: m[1], canvasId: m[2] };
  }
  async function state() {
    const { projectId, canvasId } = ids();
    const r = await fetch(`/api/v1/canvas-studio/projects/${projectId}/canvases/${canvasId}?sessionId=x`, { headers: api() });
    const j = await r.json();
    return { nodes: j.data.nodes || [], edges: j.data.edges || [] };
  }
  async function batch(payload) {
    const { projectId, canvasId } = ids();
    const r = await fetch(`/api/v1/canvas-studio/projects/${projectId}/canvases/${canvasId}/batch`,
      { method: 'POST', headers: api(), body: JSON.stringify(payload) });
    if (r.status !== 200) throw new Error('batch ' + r.status + ' ' + (await r.text()).slice(0, 120));
    return r.json();
  }
  async function health() {
    const r = await fetch(cfg.assetRoot + '/__health');
    return (await r.json()).ok === true;
  }

  /* ---------- 1. 解析分镜 + 素材匹配（只读） ---------- */
  async function parse() {
    if (!(await health())) throw new Error('素材服务未启动：node asset-server.js（端口 8899）');
    const mt = await (await fetch(cfg.assetRoot + '/4-文本/' + enc(cfg.mappingFile))).text();
    (new Function(mt))();
    const M = window.MJ_MAPPING || {};
    const md = (await (await fetch(cfg.assetRoot + '/4-文本/' + enc(cfg.mdFile))).text()).replace(/\r/g, '');
    const segs = []; let cur = null;
    for (const ln of md.split('\n')) {
      const h = ln.match(/【本段时长：(\d+)秒】【(\d+(?:-\d+)+)】/);
      if (h) { if (cur) segs.push(cur); cur = { id: h[2], dur: +h[1], lines: [] }; }
      else if (cur) cur.lines.push(ln);
    }
    if (cur) segs.push(cur);
    const eps = cfg.episodes === 'all' ? null : cfg.episodes;
    const inRange = s => {
      if (!eps) return true;
      const ep = +s.id.split('-')[0];
      return ep >= eps[0] && ep <= eps[1];
    };
    S.segs = segs.filter(inRange).map(s => ({ ...s, ep: +s.id.split('-')[0], prompt: s.lines.filter(l => l.trim()).join('\n') }));

    // 目录清单（自动发现素材）
    const dirs = {};
    for (const d of ['0-角色和声音', '1-场景', '2-道具']) {
      const r = await fetch(cfg.assetRoot + '/__list/' + enc(d));
      dirs[d] = (await r.json()).files;
    }
    const roleAll = dirs['0-角色和声音'].map(f => ({ f: f.name, base: norm(f.name), isAudio: f.isAudio }));
    const sceneFiles = dirs['1-场景'].map(f => ({ f: f.name, base: norm(f.name) }));
    const propFiles = dirs['2-道具'].map(f => ({ f: f.name, base: norm(f.name) }));
    const fScene = t => sceneFiles.find(n => n.base === t || n.base.startsWith(t));
    const fRole = t => roleAll.find(n => !n.isAudio && (n.base === t || n.base.startsWith(t)));
    const fAud = ch => roleAll.find(n => n.isAudio && n.base.includes(ch) && n.base.includes('音轨'));
    const sceneTxts = new Set(), outfitTxts = new Set();
    Object.values(M.sceneMap || {}).forEach(v => sceneTxts.add(v.txt));
    Object.values(M.outfitMap || {}).forEach(a => a.forEach(o => outfitTxts.add(o.txt)));

    for (const p of S.segs) {
      const sm = (M.sceneMap || {})[p.id], of = (M.outfitMap || {})[p.id] || [];
      p.scene = sm ? fScene(sm.txt) : null;
      p.chars = {}; p.audios = {}; p.props = [];
      for (const o of of) {
        const rf = fRole(o.txt); if (rf) p.chars[o.char] = rf;
        const au = fAud(o.char); if (au) p.audios[o.char] = au;
      }
      if (!of.length) { // 无映射兜底：角色行 + 场景行 + 默认服装
        const chLine = p.lines.find(l => l.startsWith('角色：'));
        if (chLine) for (const ch of chLine.replace(/^角色：/, '').split(/[、，,]/).map(t => t.trim()).filter(Boolean)) {
          const au = fAud(ch); if (au) p.audios[ch] = au;
          const rf = roleAll.filter(n => !n.isAudio && outfitTxts.has(n.base) && n.base.includes(ch)).sort((a, b) => a.base < b.base ? -1 : 1)[0];
          if (rf) p.chars[ch] = rf;
        }
        const scLine = p.lines.find(l => /^\d+(?:-\d+)*\s+(夜|日|晨|清晨|黄昏|傍晚)\s*\/\s*(内|外)\s+/.test(l));
        if (scLine) {
          const nm = scLine.replace(/^\d+(?:-\d+)*\s+[^\s]+\s*\/\s*[^\s]+\s+/, '').trim();
          p.scenePhrase = nm;
          if (!p.scene) p.scene = sceneFiles.find(n => !sceneTxts.has(n.base) && n.base.includes(nm)) || null;
        }
      }
      const propLine = p.lines.find(l => l.startsWith('道具：'));
      if (propLine) for (const t of propLine.replace(/^道具：/, '').split(/[、，,]/).map(x => x.trim()).filter(Boolean)) {
        const pf = propFiles.find(n => n.base.includes(t)); if (pf) p.props.push({ term: t, file: pf });
      }
    }
    return summary();
  }

  function summary() {
    const chars = new Set(); const files = new Map();
    for (const p of S.segs) {
      if (p.scene) files.set('1-场景/' + p.scene.f, { dir: '1-场景', f: p.scene.f });
      Object.values(p.chars).forEach(f => { files.set('0-角色和声音/' + f.f, { dir: '0-角色和声音', f: f.f }); chars.add(Object.keys(p.chars).find(k => p.chars[k] === f)); });
      Object.values(p.audios).forEach(f => files.set('0-角色和声音/' + f.f, { dir: '0-角色和声音', f: f.f }));
      p.props.forEach(x => files.set('2-道具/' + x.file.f, { dir: '2-道具', f: x.file.f }));
    }
    S.files = [...files.values()]; S.chars = [...chars].filter(Boolean).sort();
    return { segments: S.segs.length, episodes: [...new Set(S.segs.map(p => p.ep))].length, chars: S.chars.length, files: S.files.length,
      durations: [Math.min(...S.segs.map(p => p.dur)), Math.max(...S.segs.map(p => p.dur))] };
  }

  /* ---------- 2. 规划（只读，不动画布） ---------- */
  async function plan() {
    const epsKey = JSON.stringify(cfg.episodes);
    if (!S.segs.length || S.parsedEps !== epsKey) { await parse(); S.parsedEps = epsKey; }
    const st = await state();
    const byBase = {}; st.nodes.forEach(n => byBase[norm(n.label)] = n.node_uid);
    const uidOf = f => byBase[norm(f)] || null;
    const missing = [];
    // 角色区（阶梯：每角色一列一排，图上音下）
    const charPlaced = [];
    S.chars.forEach((ch, i) => {
      const x = cfg.origin.x + i * cfg.charStepX, y0 = cfg.origin.y + i * cfg.charStepY;
      const fs = []; const seen = new Set();
      for (const p of S.segs) { const rf = p.chars[ch]; if (rf && !seen.has(rf.f)) { seen.add(rf.f); fs.push(rf); } }
      for (const p of S.segs) { const au = p.audios[ch]; if (au && !seen.has(au.f)) { seen.add(au.f); fs.push(au); } }
      fs.forEach((f, k) => {
        const uid = uidOf(f.f);
        if (!uid) missing.push(norm(f.f));
        charPlaced.push({ uid, kind: f.isAudio ? 'upload_audio' : 'upload_image', x, y: y0 + k * cfg.itemStepY });
      });
    });
    // 场景/道具区（仿视频列排：每列 gridPerCol 个）
    const grid = []; const seenG = new Set(); let gi = 0;
    const gridX0 = cfg.origin.x + S.chars.length * cfg.charStepX + 300;
    for (const p of S.segs) {
      const items = [];
      if (p.scene) items.push(p.scene);
      p.props.forEach(x => items.push(x.file));
      for (const f of items) {
        if (seenG.has(f.f)) continue; seenG.add(f.f);
        const uid = uidOf(f.f); if (!uid) { missing.push(norm(f.f)); continue; }
        grid.push({ uid, kind: 'upload_image', x: gridX0 + Math.floor(gi / cfg.gridPerCol) * cfg.colStepX, y: cfg.origin.y + (gi % cfg.gridPerCol) * cfg.itemStepY });
        gi++;
      }
    }
    // 视频节点区（每集一列，超 perColumn 换列；集间留一列空隙）
    const vidX0 = gridX0 + Math.ceil(gi / cfg.gridPerCol) * cfg.colStepX + 300;
    const creates = []; const edges = []; let colCursor = 0;
    const eps = [...new Set(S.segs.map(p => p.ep))].sort((a, b) => a - b);
    for (const ep of eps) {
      const list = S.segs.filter(p => p.ep === ep);
      const epX = vidX0 + colCursor * cfg.colStepX;
      list.forEach((p, k) => {
        const col = Math.floor(k / cfg.perColumn), row = k % cfg.perColumn;
        const uid = 'video-' + ids().canvasId + '-rb-' + p.id;
        const refs = [];
        if (p.scene) { const u = uidOf(p.scene.f); if (u) refs.push(u); }
        Object.values(p.chars).forEach(f => { const u = uidOf(f.f); if (u) refs.push(u); });
        Object.values(p.audios).forEach(f => { const u = uidOf(f.f); if (u) refs.push(u); });
        p.props.forEach(x => { const u = uidOf(x.file.f); if (u) refs.push(u); });
        creates.push({
          node_uid: uid, node_kind: 'video', label: p.id,
          canvas_x: epX + col * cfg.colStepX, canvas_y: cfg.origin.y + row * cfg.itemStepY,
          z_index: 0, width: cfg.aspect === '9x16' ? 350 : 622, height: cfg.aspect === '9x16' ? 622 : 350,
          data: {
            action: 'video_generate', prompt: tagPrompt(p), input: null, output: null,
            model: cfg.model || MODELS[cfg.modelName] || 33, resolution: cfg.resolution,
            aspect: cfg.aspect, duration: cfg.duration === 'auto' ? Math.max(p.dur, cfg.minDuration) : cfg.duration,
            generate_audio: true, params: null, generation_status: null, generation_message: null, generation_at: null, task_id: null,
          },
        });
        [...new Set(refs)].forEach((u, i) => edges.push({ edge_uid: 'e-rb-' + p.id + '-' + i, from_node_uid: u, to_node_uid: uid, source_node_uid: u, target_node_uid: uid, source_handle: 'source', target_handle: 'target' }));
      });
      colCursor += Math.ceil(list.length / cfg.perColumn) + cfg.epGapCols - 1;
    }
    S.plan = { charPlaced, grid, creates, edges, missing };
    return { assetsOnCanvas: st.nodes.length, videoNodes: creates.length, edges: edges.length, charAssets: charPlaced.length, gridAssets: grid.length, missingUids: missing.length, missing: missing.slice(0, 8) };
  }

  /* ---------- 内联参考标签 ---------- */
  function tagPrompt(p) {
    if (!cfg.tags) return p.prompt;
    const tag = (k, n) => '【' + k + '：' + n + '】';
    const names = [];
    for (const [name, f] of Object.entries(p.chars)) if (name) names.push({ name, asset: norm(f.f), kind: '参考图' });
    if (p.scene && p.scenePhrase) names.push({ name: p.scenePhrase, asset: norm(p.scene.f), kind: '参考图' });
    if (p.scene && !p.scenePhrase) { const m = p.prompt.match(/^\d+(?:-\d+)*\s+[^\s]+\s*\/\s*[^\s]+\s+(.+)/m); if (m) names.push({ name: m[1], asset: norm(p.scene.f), kind: '参考图' }); }
    p.props.forEach(x => { if (x.term) names.push({ name: x.term, asset: norm(x.file.f), kind: '参考图' }); });
    names.sort((a, b) => b.name.length - a.name.length);
    const chars = Object.keys(p.chars).filter(Boolean).sort((a, b) => b.length - a.length);
    let out = '', i = 0, guard = 0;
    while (i < p.prompt.length && guard++ < p.prompt.length * 3) {
      let spoken = null;
      for (const ch of chars) {
        if (!p.prompt.startsWith(ch, i)) continue;
        const rest = p.prompt.slice(i + ch.length);
        const m = rest.match(/^(\s*（[^）]{1,12}）\s*)([：:])/);
        if (m) { spoken = { ch, m }; break; }
        if (rest[0] === '：' || rest[0] === ':') { spoken = { ch, m: { 0: rest[0], 1: '', 2: rest[0] } }; break; }
      }
      if (spoken) {
        const f = p.chars[spoken.ch], au = p.audios[spoken.ch];
        out += spoken.ch + (f ? tag('参考图', norm(f.f)) : '') + spoken.m[1] + spoken.m[2] + (au ? tag('参考音频', norm(au.f)) : '');
        i += spoken.ch.length + spoken.m[0].length; continue;
      }
      let hit = null; for (const n of names) { if (n.name && p.prompt.startsWith(n.name, i)) { hit = n; break; } }
      if (hit) { out += hit.name + tag(hit.kind, hit.asset); i += hit.name.length; continue; }
      out += p.prompt[i++];
    }
    return out + p.prompt.slice(i);
  }

  /* ---------- 3. 清空画布 ---------- */
  async function clear() {
    guardPage();
    const st = await state();
    let fails = 0;
    for (let i = 0; i < st.edges.length; i += 150) {
      await batch({ nodes: { create: [], update: [], delete: [] }, edges: { create: [], delete: st.edges.slice(i, i + 150).map(e => ({ edge_uid: e.edge_uid })) } }).catch(() => fails++);
      await sleep(150);
    }
    for (let i = 0; i < st.nodes.length; i += 8) {
      await batch({ nodes: { create: [], update: [], delete: st.nodes.slice(i, i + 8).map(n => ({ node_uid: n.node_uid, node_kind: n.node_kind, label: n.label || '' })) }, edges: { create: [], delete: [] } }).catch(() => fails++);
      await sleep(150);
    }
    const after = await state();
    if (after.nodes.length) for (let i = 0; i < after.nodes.length; i += 8) {
      await batch({ nodes: { create: [], update: [], delete: after.nodes.slice(i, i + 8).map(n => ({ node_uid: n.node_uid, node_kind: n.node_kind, label: n.label || '' })) }, edges: { create: [], delete: [] } }).catch(() => fails++);
      await sleep(150);
    }
    const fin = await state();
    return { cleared: st.nodes.length, fails, remain: fin.nodes.length + ' nodes / ' + fin.edges.length + ' edges' };
  }

  /* ---------- 4. 上传素材（走画布上传口） ---------- */
  async function upload() {
    guardPage();
    if (!S.files) await parse();
    const input = document.querySelector('.cs-dock__file-input');
    if (!input) throw new Error('找不到上传口 .cs-dock__file-input（需停留在画布页）');
    let done = 0; const fails = [];
    while (done < S.files.length) {
      const batchF = S.files.slice(done, done + 8);
      const dt = new DataTransfer();
      for (const u of batchF) {
        try {
          const url = cfg.assetRoot + '/' + u.dir.split('-')[0] + '-' + enc(u.dir.split('-').slice(1).join('-')) + '/' + enc(u.f);
          const blob = await (await fetch(url)).blob();
          dt.items.add(new File([blob], u.f, { type: blob.type || (/\.(wav|mp3)$/i.test(u.f) ? 'audio/mpeg' : 'image/png') }));
        } catch (e) { fails.push(u.f); }
      }
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      done += batchF.length;
      await sleep(4500);
    }
    await sleep(3000);
    const st = await state();
    const byBase = {}; st.nodes.forEach(n => byBase[norm(n.label)] = n.node_uid);
    const stillMissing = S.files.filter(u => !byBase[norm(u.f)]).map(u => u.f);
    return { uploaded: done - fails.length, failed: fails, canvasNodes: st.nodes.length, notFoundOnCanvas: stillMissing };
  }

  function guardPage() {
    if (document.querySelector('.cs-session-expired')) throw new Error('会话冲突：请点击「刷新页面」后重试');
  }

  /* ---------- 5. 建（排位 + 节点 + 连线） ---------- */
  async function build() {
    guardPage();
    if (!S.plan) await plan();
    if (cfg.clearFirst) await clear();
    const P = S.plan;
    const st = await state();
    const meta = Object.fromEntries(st.nodes.map(n => [n.node_uid, { kind: n.node_kind, label: n.label }]));
    // 资产排位
    const layout = [...P.charPlaced, ...P.grid].filter(a => meta[a.uid]);
    for (let i = 0; i < layout.length; i += 40) {
      await batch({ nodes: { create: [], update: layout.slice(i, i + 40).map(a => ({ node_uid: a.uid, node_kind: meta[a.uid].kind, label: meta[a.uid].label, canvas_x: a.x, canvas_y: a.y })), delete: [] }, edges: { create: [], delete: [] } });
      await sleep(150);
    }
    // 视频节点
    for (let i = 0; i < P.creates.length; i += 40) {
      await batch({ nodes: { create: P.creates.slice(i, i + 40), update: [], delete: [] }, edges: { create: [], delete: [] } });
      await sleep(200);
    }
    // 连线
    for (let i = 0; i < P.edges.length; i += 120) {
      await batch({ nodes: { create: [], update: [], delete: [] }, edges: { create: P.edges.slice(i, i + 120), delete: [] } });
      await sleep(200);
    }
    const fin = await state();
    const vids = fin.nodes.filter(n => n.node_kind === 'video');
    return { videos: vids.length, assets: fin.nodes.length - vids.length, edges: fin.edges.length };
  }

  /* ---------- 一键（仍不碰生成按钮） ---------- */
  async function run() {
    const log = {};
    log.parse = await parse();
    log.plan = await plan();
    if (cfg.clearFirst) log.clear = await clear();
    log.upload = await upload();
    S.plan = null;               // 上传后 uid 全新，重新规划
    log.build = await build();
    return log;
  }

  window.RB = { cfg, MODELS, state, parse, plan, clear, upload, build, run, summary, _S: S };
  console.log('%cRB 批量导入器已加载', 'color:#0a0;font-weight:bold',
    '\n步骤：RB.parse() → RB.plan() → RB.clear()(可选) → RB.upload() → RB.build()\n一键：await RB.run()（cfg.clearFirst 控制是否清空）\n配置：RB.cfg.episodes=[6,23]; RB.cfg.modelName=\'低价渠道\'; …\n安全：全程不触碰「生成」按钮。');
})();
