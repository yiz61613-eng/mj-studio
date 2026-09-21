/* =============================================================
 * RB Core —— 平台无关核心（批量导入分镜节点 + 自动参考）
 * 依赖：本地素材服务 asset-server（/4-文本/*、/__list/*、/__tool/*）
 * 适配器：实现 RBAdapter 接口后调用 RBCore.register(adapter)。
 *   RBAdapter = {
 *     id, name,
 *     match(): bool                     // 当前页面是否属于该平台
 *     init(): Promise                   // 取令牌等一次性准备
 *     state(): Promise<{nodes,edges}>   // nodes: [{node_uid?, label, kind}], edges 同理（结构可平台自定义）
 *     batch(payload): Promise           // 平台批量写接口（节点/连线增删改）
 *     upload(files): Promise<{uploaded, failed, note?}>  // files: [{name, blob}]
 *     limits: {nodeCreate, nodeDelete, edgeCreate},
 *     uidIndex(nodes): {base->uid}      // label 归一化后建索引
 *     normalizeLabel(s): string         // 平台 label 清洗（去尺寸/时长后缀等）
 *     makeVideoNode(seg, planOpts): node 结构（平台自定义字段）
 *     wireEdges(plan): payload 片段      // 连线组装
 *     capabilities: {createNodes:bool, createEdges:bool, clear:bool}
 *   }
 * 安全约定：核心与适配器永远不触碰任何平台的「生成」按钮，不消耗积分。
 * ============================================================= */
(function () {
  'use strict';

  const cfg = {
    assetRoot: 'http://localhost:8899',
    mdFile: 'storyboard.md',
    mappingFile: 'mapping-data.js',
    textDir: '4-文本',
    episodes: 'all',            // [起,止] 或 'all'
    model: 33,                  // 数字 id，由适配器解释
    resolution: '720P',
    aspect: '16x9',             // '16x9' | '9x16'
    duration: 'auto',           // 'auto' 或固定数字
    minDuration: 4,
    perColumn: 6,
    tags: true,
    clearFirst: false,
    origin: { x: 100, y: 100 },
    charStepX: 520, charStepY: 620, itemStepY: 380,
    colStepX: 700, gridPerCol: 6, epGapCols: 1,
  };

  const S = { segs: [], files: [], chars: [], plan: null, parsedEps: null, adapter: null };
  const adapters = [];

  /* ---------- 工具 ---------- */
  const norm = s => String(s || '')
    .replace(/\.(png|jpg|jpeg|webp|wav|mp3|m4a|flac)$/i, '')
    .replace(/\s*\d{3,4}\s*[×xX]\s*\d{3,4}\s*$/, '')
    .replace(/\d{1,2}:\d{2}\s*\/.*$/, '')
    .trim();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const enc = encodeURIComponent;

  async function health() {
    try { return (await (await fetch(cfg.assetRoot + '/__health')).json()).ok === true; }
    catch (e) { return false; }
  }

  /* ---------- 适配器注册与选择 ---------- */
  function register(adapter) { adapters.push(adapter); }
  function pickAdapter() {
    for (const a of adapters) { try { if (a.match()) return a; } catch (e) {} }
    return null;
  }
  async function ensureAdapter() {
    if (S.adapter) return S.adapter;
    const a = pickAdapter();
    if (!a) throw new Error('未识别到支持的平台画布页面。通用兜底适配器未加载？');
    await a.init();
    S.adapter = a;
    return a;
  }

  /* ---------- 1. 解析（平台无关，全部只读） ---------- */
  async function parse() {
    if (!(await health())) throw new Error('素材服务未启动：双击 start.bat（端口 8899）');
    const T = cfg.assetRoot + '/' + enc(cfg.textDir) + '/';
    const mt = await (await fetch(T + enc(cfg.mappingFile))).text();
    // 映射表为纯 JSON，直接解析（兼容 CSP 严格的扩展环境）
    const mj = mt.match(/=\s*(\{[\s\S]*\})\s*;?\s*/) || mt.match(/(\{[\s\S]*\})/);
    const M = mj ? JSON.parse(mj[1]) : {};
    try { window.MJ_MAPPING = M; } catch (e) {}
    const md = (await (await fetch(T + enc(cfg.mdFile))).text()).replace(/\r/g, '');
    const segs = []; let cur = null;
    for (const ln of md.split('\n')) {
      const h = ln.match(/【本段时长：(\d+)秒】【(\d+(?:-\d+)+)】/);
      if (h) { if (cur) segs.push(cur); cur = { id: h[2], dur: +h[1], lines: [] }; }
      else if (cur) cur.lines.push(ln);
    }
    if (cur) segs.push(cur);
    const eps = cfg.episodes === 'all' ? null : cfg.episodes;
    S.segs = segs
      .filter(s => !eps || (+s.id.split('-')[0] >= eps[0] && +s.id.split('-')[0] <= eps[1]))
      .map(s => ({ ...s, ep: +s.id.split('-')[0], prompt: s.lines.filter(l => l.trim()).join('\n') }));

    const dirs = {};
    for (const d of ['0-角色和声音', '1-场景', '2-道具']) {
      dirs[d] = (await (await fetch(cfg.assetRoot + '/__list/' + enc(d))).json()).files;
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
      if (!of.length) {
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
    // 汇总所需文件与角色
    const files = new Map(); const chars = new Set();
    for (const p of S.segs) {
      if (p.scene) files.set('1-场景/' + p.scene.f, { dir: '1-场景', f: p.scene.f });
      Object.entries(p.chars).forEach(([c, f]) => { files.set('0-角色和声音/' + f.f, { dir: '0-角色和声音', f: f.f }); chars.add(c); });
      Object.values(p.audios).forEach(f => files.set('0-角色和声音/' + f.f, { dir: '0-角色和声音', f: f.f }));
      p.props.forEach(x => files.set('2-道具/' + x.file.f, { dir: '2-道具', f: x.file.f }));
    }
    S.files = [...files.values()]; S.chars = [...chars].filter(Boolean).sort();
    return { segments: S.segs.length, episodes: [...new Set(S.segs.map(p => p.ep))].length, chars: S.chars.length, files: S.files.length,
      durations: [Math.min(...S.segs.map(p => p.dur)), Math.max(...S.segs.map(p => p.dur))] };
  }

  /* ---------- 2. 规划（平台无关；uid 解析回调由适配器提供） ---------- */
  async function plan() {
    const epsKey = JSON.stringify(cfg.episodes);
    if (!S.segs.length || S.parsedEps !== epsKey) { await parse(); S.parsedEps = epsKey; }
    const a = await ensureAdapter();
    const st = await a.state();
    const idx = a.uidIndex(st.nodes);            // base -> uid
    const uidOf = f => idx[norm(f)] || null;
    const missing = [];
    // 角色区（阶梯）
    const charPlaced = [];
    S.chars.forEach((ch, i) => {
      const x = cfg.origin.x + i * cfg.charStepX, y0 = cfg.origin.y + i * cfg.charStepY;
      const fs = []; const seen = new Set();
      for (const p of S.segs) { const rf = p.chars[ch]; if (rf && !seen.has(rf.f)) { seen.add(rf.f); fs.push(rf); } }
      for (const p of S.segs) { const au = p.audios[ch]; if (au && !seen.has(au.f)) { seen.add(au.f); fs.push(au); } }
      fs.forEach((f, k) => {
        const uid = uidOf(f.f);
        if (!uid) missing.push(norm(f.f));
        charPlaced.push({ uid, name: f.f, isAudio: f.isAudio, x, y: y0 + k * cfg.itemStepY });
      });
    });
    // 场景/道具区（列排）
    const grid = []; const seenG = new Set(); let gi = 0;
    const gridX0 = cfg.origin.x + S.chars.length * cfg.charStepX + 300;
    for (const p of S.segs) {
      const items = [];
      if (p.scene) items.push(p.scene);
      p.props.forEach(x => items.push(x.file));
      for (const f of items) {
        if (seenG.has(f.f)) continue; seenG.add(f.f);
        const uid = uidOf(f.f); if (!uid) { missing.push(norm(f.f)); continue; }
        grid.push({ uid, name: f.f, x: gridX0 + Math.floor(gi / cfg.gridPerCol) * cfg.colStepX, y: cfg.origin.y + (gi % cfg.gridPerCol) * cfg.itemStepY });
        gi++;
      }
    }
    // 视频节点（每集一列，超 perColumn 换列）
    const vidX0 = gridX0 + Math.ceil(gi / cfg.gridPerCol) * cfg.colStepX + 300;
    const segPlans = []; let colCursor = 0;
    const epsList = [...new Set(S.segs.map(p => p.ep))].sort((x, y) => x - y);
    for (const ep of epsList) {
      const list = S.segs.filter(p => p.ep === ep);
      const epX = vidX0 + colCursor * cfg.colStepX;
      list.forEach((p, k) => {
        const col = Math.floor(k / cfg.perColumn), row = k % cfg.perColumn;
        const refs = [];
        if (p.scene) { const u = uidOf(p.scene.f); if (u) refs.push(u); }
        Object.values(p.chars).forEach(f => { const u = uidOf(f.f); if (u) refs.push(u); });
        Object.values(p.audios).forEach(f => { const u = uidOf(f.f); if (u) refs.push(u); });
        p.props.forEach(x => { const u = uidOf(x.file.f); if (u) refs.push(u); });
        segPlans.push({
          seg: p, uid: null, refs: [...new Set(refs)],
          x: epX + col * cfg.colStepX, y: cfg.origin.y + row * cfg.itemStepY,
          duration: cfg.duration === 'auto' ? Math.max(p.dur, cfg.minDuration) : cfg.duration,
          prompt: tagPrompt(p),
        });
      });
      colCursor += Math.ceil(list.length / cfg.perColumn) + cfg.epGapCols - 1;
    }
    S.plan = { charPlaced, grid, segPlans, missing, capabilities: a.capabilities };
    return {
      platform: a.name, assetsOnCanvas: st.nodes.length,
      videoNodes: segPlans.length, edges: segPlans.reduce((n, p) => n + p.refs.length, 0),
      charAssets: charPlaced.length, gridAssets: grid.length,
      missingUids: missing.length, missing: missing.slice(0, 8),
      canCreateNodes: a.capabilities.createNodes, note: a.capabilities.note || '',
    };
  }

  /* ---------- 内联参考标签 ---------- */
  function tagPrompt(p) {
    if (!cfg.tags) return p.prompt;
    const tag = (k, n) => '【' + k + '：' + n + '】';
    const names = [];
    for (const [name, f] of Object.entries(p.chars)) if (name) names.push({ name, asset: norm(f.f), kind: '参考图' });
    if (p.scene) {
      const m = p.scenePhrase || (p.prompt.match(/^\d+(?:-\d+)*\s+[^\s]+\s*\/\s*[^\s]+\s+(.+)/m) || [])[1];
      if (m) names.push({ name: m, asset: norm(p.scene.f), kind: '参考图' });
    }
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

  /* ---------- 3. 清空（交给适配器） ---------- */
  async function clear() {
    const a = await ensureAdapter();
    if (!a.capabilities.clear) throw new Error('当前适配器不支持清空画布');
    return a.clear();
  }

  /* ---------- 4. 上传（核心取文件，适配器注入页面） ---------- */
  async function upload() {
    if (!S.files) await parse();
    const a = await ensureAdapter();
    const st0 = await a.state();
    const idx0 = a.uidIndex(st0.nodes);
    const need = S.files.filter(u => !idx0[norm(u.f)]);
    if (!need.length) return { uploaded: 0, note: '所需素材已全部在画布上' };
    const files = [];
    for (const u of need) {
      const url = cfg.assetRoot + '/' + u.dir.split('-')[0] + '-' + enc(u.dir.split('-').slice(1).join('-')) + '/' + enc(u.f);
      const blob = await (await fetch(url)).blob();
      files.push({ name: u.f, blob });
    }
    const res = await a.upload(files);
    await sleep(3000);
    const st1 = await a.state();
    const idx1 = a.uidIndex(st1.nodes);
    const stillMissing = need.filter(u => !idx1[norm(u.f)]).map(u => u.f);
    return { ...res, canvasNodes: st1.nodes.length, notFoundAfterUpload: stillMissing };
  }

  /* ---------- 5. 建（排位 + 节点 + 连线，交给适配器） ---------- */
  async function build() {
    if (!S.plan) await plan();
    const a = await ensureAdapter();
    return a.build(S);
  }

  /* ---------- 一键 ---------- */
  async function run() {
    const log = {};
    log.parse = await parse();
    log.plan = await plan();
    if (cfg.clearFirst) log.clear = await clear();
    log.upload = await upload();
    S.plan = null;
    log.build = await build();
    return log;
  }

  /* ---------- 通用文件上传助手（多数画布平台通用） ---------- */
  async function commonFileUpload(files, { batch = 5, waitMs = 4000 } = {}) {
    const inputs = [...document.querySelectorAll('input[type=file]')]
      .filter(i => /image|audio|video|\*/i.test(i.accept || '') || !i.accept);
    if (!inputs.length) throw new Error('页面上找不到 input[type=file] 上传口');
    const input = inputs[0];
    let done = 0; const fails = [];
    while (done < files.length) {
      const dt = new DataTransfer();
      for (const f of files.slice(done, done + batch)) dt.items.add(new File([f.blob], f.name, { type: f.blob.type || undefined }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      done += Math.min(batch, files.length - done);
      await sleep(waitMs);
    }
    return { uploaded: done - fails.length, failed: fails };
  }

  /* ---------- 计划导出（不支持自动建节点的平台兜底） ---------- */
  function exportPlan() {
    if (!S.plan) throw new Error('请先 RB.plan()');
    const data = {
      generatedAt: new Date().toISOString(),
      cfg: { ...cfg }, plan: S.plan,
      segs: S.segs.map(p => ({ id: p.id, ep: p.ep, dur: p.dur, prompt: tagPrompt(p), refs: (S.plan.segPlans.find(x => x.seg === p) || {}).refs || [] })),
      chars: S.chars, files: S.files,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const aEl = document.createElement('a');
    aEl.href = URL.createObjectURL(blob);
    aEl.download = 'rb-plan-' + Date.now() + '.json';
    aEl.click();
    return '已下载 rb-plan-*.json（含每段提示词/参考清单/坐标，供手工或后续自动化使用）';
  }

  window.RBCore = { cfg, S, register, pickAdapter, ensureAdapter, parse, plan, clear, upload, build, run, exportPlan, norm, sleep, commonFileUpload,
    get adapter() { return S.adapter; } };
})();
