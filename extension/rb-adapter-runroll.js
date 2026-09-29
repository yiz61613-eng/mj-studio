/* =============================================================
 * RB Adapter —— Runroll（完整能力）
 * 依赖 rb-core.js。能力：读状态 / 上传 / 建节点 / 连线 / 清空。
 * 实测约束：节点删除每批 ≤8；节点建/改每批 ≤40；连线每批 ≤120。
 * ============================================================= */
(function () {
  'use strict';
  if (!window.RBCore) throw new Error('请先加载 rb-core.js');

  const { norm, sleep } = window.RBCore;

  // [net 2026-09-23] 请求记录器：main world hook fetch+XHR，记录 POST 请求到 localStorage 供探针读取
  (function injectNetHook() {
    try {
      if (document.getElementById('rb-nethook')) return;
      const s = document.createElement('script'); s.id = 'rb-nethook';
      s.textContent = '(function(){if(window.__rbHooked)return;window.__rbHooked=1;' +
        'function rec(m,u,b){try{var l=JSON.parse(localStorage.getItem("__rbNetLog")||"[]");' +
        'l.push({t:Date.now(),m:m,u:u,b:b?String(b).slice(0,900):null});while(l.length>50)l.shift();' +
        'localStorage.setItem("__rbNetLog",JSON.stringify(l));}catch(e){}}' +
        'var of=window.fetch;window.fetch=function(...a){try{var u=typeof a[0]==="string"?a[0]:(a[0]&&a[0].url)||"";' +
        'var m=(a[1]&&a[1].method)||(a[0]&&a[0].method)||"GET";if(m!=="GET")rec(m,u,a[1]&&a[1].body);}catch(e){}return of.apply(this,a);};' +
        'var oo=XMLHttpRequest.prototype.open,os=XMLHttpRequest.prototype.send;' +
        'XMLHttpRequest.prototype.open=function(m,u){this.__rbM=m;this.__rbU=u;return oo.apply(this,arguments);};' +
        'XMLHttpRequest.prototype.send=function(b){try{if(this.__rbM&&this.__rbM!=="GET")rec(this.__rbM,this.__rbU,b);}catch(e){}return os.apply(this,arguments);};})();';
      (document.head || document.documentElement).appendChild(s);
    } catch (e) { console.warn('[RB] net hook 注入失败', e); }
  })();

  // capability_id → model_series_id 映射（2026-09-23 /video/models 实测）
  const CAP2SERIES = { 53:'34',54:'34',55:'34',56:'34', 132:'38',133:'38',134:'38',135:'38', 57:'16',58:'16',59:'16',60:'16', 61:'17',62:'17',63:'17',64:'17', 128:'37',129:'37',130:'37',131:'37', 5:'1',6:'1',7:'1',8:'1', 33:'10',34:'10',35:'10',36:'10', 1:'32',2:'32',3:'32',4:'32', 113:'33',114:'33',115:'33',116:'33', 107:'29',108:'29',109:'29', 110:'30',111:'30',112:'30', 9:'6',10:'6',11:'6',12:'6', 13:'7',14:'7',15:'7' };

  const MODELS = {
    '满血全能参考': 7,   // Seedance 2.0(满血渠道) 全能参考
    '满血文生': 5,       // Seedance 2.0(满血渠道) 默认
    '低价渠道': 33,      // Seedance 2.0(低价渠道)
  };

  function ids() {
    const m = location.href.match(/my-canvas\/(\d+)\/canvas\/(\d+)/);
    if (!m) throw new Error('不在 Runroll 画布页面');
    return { projectId: m[1], canvasId: m[2] };
  }
  function api() {
    return {
      'Authorization': 'Bearer ' + localStorage.getItem('access_token'),
      'X-Account-Id': localStorage.getItem('current_account_id') || '',
      'Content-Type': 'application/json',
    };
  }

  const adapter = {
    id: 'runroll',
    name: 'Runroll 画布',
    capabilities: { createNodes: true, createEdges: true, clear: true },
    limits: { nodeCreate: 40, nodeDelete: 8, edgeCreate: 120 },
    match: () => /runroll\.cn\/my-canvas\/\d+\/canvas\/\d+/.test(location.href),
    init: async () => {
      if (document.querySelector('.cs-session-expired')) throw new Error('会话冲突：请点击「刷新页面」后重试');
      if (!localStorage.getItem('access_token')) throw new Error('未登录 Runroll');
    },
    ids,
    state: async () => {
      const { projectId, canvasId } = ids();
      // 2026-09-20 起全量读走 collab 端点（旧 ?sessionId=x 已 404），需 X-Account-Id，sessionId 任意
      const sid = 'rb-' + Math.random().toString(36).slice(2);
      // [FIX 2026-09-23] QQ 浏览器疑似缓存了 collab GET 响应（稳定返回旧快照）：no-store + 时间戳参数强制绕缓存
      const r = await fetch(`/api/v1/canvas-studio/collab/projects/${projectId}/canvases/${canvasId}?sessionId=${sid}&_=${Date.now()}`, { headers: api(), cache: 'no-store' });
      if (r.status === 404) throw new Error('画布读取 404：可能未登录或被会话守卫拦住，请刷新画布页');
      const j = await r.json();
      return { nodes: j.data.nodes || [], edges: j.data.edges || [] };
    },
    listModels: async () => {
      const r = await fetch('/api/v1/canvas-studio/video/models', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('access_token'), 'X-Account-Id': localStorage.getItem('current_account_id') || '' } });
      const j = await r.json();
      const d = j.data || j;
      const out = [];
      for (const m of (d.models || [])) {
        for (const opt of (m.capability_options || [])) {
          out.push({ value: opt.id, label: m.label + '·' + opt.label });
        }
      }
      return { models: out, defaultModel: d.default_model };
    },
    batch: async (payload) => {
      const { projectId, canvasId } = ids();
      const r = await fetch(`/api/v1/canvas-studio/projects/${projectId}/canvases/${canvasId}/batch`,
        { method: 'POST', headers: api(), body: JSON.stringify(payload) });
      if (r.status !== 200) throw new Error('batch ' + r.status + ' ' + (await r.text()).slice(0, 120));
      return r.json();
    },
    normalizeLabel: s => norm(s),
    uidIndex: nodes => { const m = {}; nodes.forEach(n => m[norm(n.label)] = n.node_uid); return m; },
    makeVideoNode: (segPlan, cfg) => ({
      node_uid: 'video-' + ids().canvasId + '-rb-' + segPlan.seg.id,
      node_kind: 'video', label: segPlan.seg.id,
      canvas_x: segPlan.x, canvas_y: segPlan.y, z_index: 0,
      width: cfg.aspect === '9x16' ? 350 : 622, height: cfg.aspect === '9x16' ? 622 : 350,
      data: {
        action: 'video_generate', prompt: segPlan.prompt, input: null, output: null,
        model: cfg.model, resolution: cfg.resolution, aspect: cfg.aspect,
        duration: segPlan.duration, generate_audio: true, params: null,
        generation_status: null, generation_message: null, generation_at: null, task_id: null,
      },
    }),
    upload: async (files) => {
      const input = document.querySelector('.cs-dock__file-input');
      if (!input) throw new Error('找不到上传口 .cs-dock__file-input（需停留在画布页）');
      let done = 0; const fails = [];
      while (done < files.length) {
        const dt = new DataTransfer();
        for (const f of files.slice(done, done + 8)) dt.items.add(new File([f.blob], f.name, { type: f.blob.type || undefined }));
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        done += Math.min(8, files.length - done);
        await sleep(4500);
      }
      return { uploaded: done - fails.length, failed: fails };
    },
    build: async function (S) {
      const cfg = window.RBCore.cfg;
      const P = S.plan;
      if (window.RBCore.cfg.clearFirst) await this.clear();
      // collab 读偶发返回滞后快照：连读两次一致才采信，最多重试 4 轮
      const readStable = async (tries = 4) => {
        let s = await this.state();
        for (let i = 0; i < tries; i++) {
          await sleep(1500);
          const s2 = await this.state();
          if (s2.nodes.length === s.nodes.length && s2.edges.length === s.edges.length) return s2;
          s = s2;
        }
        return s;
      };
      let st = await readStable();
      const meta = Object.fromEntries(st.nodes.map(n => [n.node_uid, { kind: n.node_kind, label: n.label }]));
      // [avoid 2026-09-23] 分批导入避让：画布已有节点时，新批次整体右移到已有内容后方，不叠在已建节点上
      const occ = st.nodes.filter(n => typeof n.canvas_x === 'number');
      if (occ.length) {
        const cMaxX = Math.max(...occ.map(n => n.canvas_x + (n.width || 350)));
        const pMinX = Math.min(cfg.origin.x, ...P.charPlaced.map(a => a.x), ...P.grid.map(a => a.x), ...P.segPlans.map(sp => sp.x));
        const dx = Math.max(0, cMaxX + 300 - pMinX);
        if (dx > 0) {
          P.charPlaced.forEach(a => { a.x += dx; });
          P.grid.forEach(a => { a.x += dx; });
          P.segPlans.forEach(sp => { sp.x += dx; });
        }
      }
      const myUids = new Set(P.segPlans.map(sp => { sp.uid = 'video-' + ids().canvasId + '-rb-' + sp.seg.id; return sp.uid; }));
      // 重建前删旧视频节点/旧边：删完重读验证，没删干净就再来一轮（滞后快照下第一轮往往删不到东西）
      const touch = e => myUids.has(e.target_node_uid || e.to_node_uid) || myUids.has(e.source_node_uid || e.from_node_uid);
      for (let round = 0; round < 4; round++) {
        st = await readStable(2);
        const oldNodes = st.nodes.filter(n => myUids.has(n.node_uid));
        const oldEdges = st.edges.filter(touch);
        if (!oldNodes.length && !oldEdges.length) break;   // 节点和边都清干净才往下走，防悬空旧边占坑
        for (let i = 0; i < oldEdges.length; i += this.limits.edgeCreate) {
          await this.batch({ nodes: { create: [], update: [], delete: [] }, edges: { create: [], delete: oldEdges.slice(i, i + this.limits.edgeCreate).map(e => ({ edge_uid: e.edge_uid })) } }).catch(() => {});
          await sleep(150);
        }
        for (let i = 0; i < oldNodes.length; i += this.limits.nodeDelete) {
          await this.batch({ nodes: { create: [], update: [], delete: oldNodes.slice(i, i + this.limits.nodeDelete).map(n => ({ node_uid: n.node_uid, node_kind: n.node_kind, label: n.label || '' })) }, edges: { create: [], delete: [] } }).catch(() => {});
          await sleep(200);
        }
      }
      // 资产排位
      const layout = [...P.charPlaced, ...P.grid].filter(a2 => meta[a2.uid]);
      for (let i = 0; i < layout.length; i += this.limits.nodeCreate) {
        await this.batch({ nodes: { create: [], update: layout.slice(i, i + this.limits.nodeCreate).map(a3 => ({ node_uid: a3.uid, node_kind: meta[a3.uid].kind, label: meta[a3.uid].label, canvas_x: a3.x, canvas_y: a3.y })), delete: [] }, edges: { create: [], delete: [] } });
        await sleep(150);
      }
      // 视频节点 + 连线
      for (let i = 0; i < P.segPlans.length; i += this.limits.nodeCreate) {
        const creates = P.segPlans.slice(i, i + this.limits.nodeCreate).map(sp => this.makeVideoNode(sp, cfg));
        await this.batch({ nodes: { create: creates, update: [], delete: [] }, edges: { create: [], delete: [] } });
        await sleep(300);
      }
      const allEdges = P.segPlans.flatMap(sp => sp.refs.map((u, k) => ({ edge_uid: 'e-rb-' + sp.seg.id + '-' + k, from_node_uid: u, to_node_uid: sp.uid, source_node_uid: u, target_node_uid: sp.uid, source_handle: 'source', target_handle: 'target' })));
      for (let j = 0; j < allEdges.length; j += this.limits.edgeCreate) {
        await this.batch({ nodes: { create: [], update: [], delete: [] }, edges: { create: allEdges.slice(j, j + this.limits.edgeCreate), delete: [] } });
        await sleep(200);
      }
      // 校验补齐：连线/节点可能因滞后被服务端丢弃，缺了就重试，最多 3 轮
      let missedEdges = 0, missedNodes = 0;
      for (let round = 0; round < 3; round++) {
        st = await readStable(2);
        const haveE = new Set(st.edges.map(e => e.edge_uid));
        const haveN = new Set(st.nodes.map(n => n.node_uid));
        const missE = allEdges.filter(e => !haveE.has(e.edge_uid));
        const missN = P.segPlans.filter(sp => !haveN.has(sp.uid));
        missedEdges = missE.length; missedNodes = missN.length;
        if (!missE.length && !missN.length) { missedEdges = 0; missedNodes = 0; break; }
        for (const sp of missN) await this.batch({ nodes: { create: [this.makeVideoNode(sp, cfg)], update: [], delete: [] }, edges: { create: [], delete: [] } }).catch(() => {});
        for (let j = 0; j < missE.length; j += this.limits.edgeCreate) {
          await this.batch({ nodes: { create: [], update: [], delete: [] }, edges: { create: missE.slice(j, j + this.limits.edgeCreate), delete: [] } }).catch(() => {});
          await sleep(200);
        }
      }
      await sleep(2500);   // 等服务端写入追平再读终态
      const fin = await readStable(2);
      const vids = fin.nodes.filter(n => n.node_kind === 'video');
      return { videos: vids.length, assets: fin.nodes.length - vids.length, edges: fin.edges.length,
        edgesExpected: allEdges.length, verify: { missedNodes, missedEdges } };
    },
    // 探针：把指定段位节点完整数据抛出来，同时全画布扫描视频节点里的 URL 字段，摸清生成结果存在哪
    probe: async function (segId, cfg) {
      let st = await this.state();
      for (let i = 0; i < 3; i++) {
        await sleep(1500);
        const s2 = await this.state();
        if (s2.nodes.length === st.nodes.length && s2.edges.length === st.edges.length) { st = s2; break; }
        st = s2;
      }
      const uid = 'video-' + ids().canvasId + '-rb-' + segId;
      const target = st.nodes.find(n => n.node_uid === uid) || null;
      const urls = [];
      const walk = (v, path2, depth) => {
        if (v == null || depth > 6) return;
        if (typeof v === 'string') { if (/^https?:\/\//i.test(v)) urls.push({ path: path2, val: v.slice(0, 300) }); return; }
        if (typeof v !== 'object') return;
        for (const k of Object.keys(v)) walk(v[k], path2 + '.' + k, depth + 1);
      };
      const vids = st.nodes.filter(n => n.node_kind === 'video');
      const videos = vids.map(n => {
        urls.length = 0; walk(n.data, 'data', 0);
        return { uid: n.node_uid, label: n.label, status: (n.data && n.data.generation_status) || null, urls: urls.slice() };
      });
      // [deep 2026-09-23] collab 读端锁旧快照时，从页面内存拄实时数据：DOM 文本 + React fiber 浅挖
      let deep = null;
      if (cfg && cfg.deep) {
        const bodyText = (document.body && document.body.innerText) || '';
        let idb = null;
        try { idb = (await indexedDB.databases()).map(d => d.name + '(v' + d.version + ')'); } catch (e) { idb = ['ERR:' + e.message]; }
        let fiberKeys = null;
        try {
          const found = {};
          const els = document.querySelectorAll('*');
          for (let i = 0; i < els.length && i < 4000; i++) {
            for (const k of Object.keys(els[i])) {
              if (k.startsWith('__reactFiber') || k.startsWith('__reactContainer') || k.startsWith('__reactProps')) {
                found[k] = (found[k] || 0) + 1;
              }
            }
          }
          fiberKeys = found;
        } catch (e) { fiberKeys = { ERR: e.message }; }
        const ls = Object.keys(localStorage).slice(0, 80);
        const lsSizes = {};
        ls.forEach(k => { const v = localStorage.getItem(k) || ''; lsSizes[k] = v.length; });
        const ss = Object.keys(sessionStorage).slice(0, 60);
        deep = { domHasSeg: bodyText.includes(segId), domChars: bodyText.length,
          res: (() => { try { const rf = (cfg && cfg.resFilter) || 'canvas|studio|generat|task'; return performance.getEntriesByType('resource')
            .map(e => e.name).filter(u => new RegExp(rf, 'i').test(u) && !/\.(js|css|png|jpg|svg|woff|woff2|gif|mp4|wav)/i.test(u))
            .map(u => u.replace(/^https?:\/\/[^/]+/, ''))
            .filter((v, i, a) => a.indexOf(v) === i).slice(0, 80); } catch (e) { return ['ERR:' + e.message]; } })() };
      }
      let byLabel = null;
      if (cfg && cfg.label) {
        const re = new RegExp(cfg.label);
        byLabel = st.nodes.filter(n => re.test(n.label || ''))
          .map(n => ({ uid: n.node_uid, label: n.label, kind: n.node_kind,
            status: (n.data && n.data.generation_status) || null,
            hasOutput: !!(n.data && n.data.output && n.data.output.length) }));
      }
      let dumpNode = null;
      if (cfg && cfg.dumpNode) {
        const n2 = st.nodes.find(n => norm(n.label) === norm(cfg.dumpNode));
        dumpNode = n2 ? { uid: n2.node_uid, kind: n2.node_kind, data: n2.data } : null;
      }
      let watched = null;
      if (cfg && cfg.watch) {
        // 启动持续资源监听（content script 存活期间有效），抓提交生成等一次性请求
        if (!window.__rbNetWatch) {
          window.__rbNetWatch = [];
          try {
            new PerformanceObserver(list => {
              list.getEntries().forEach(e => {
                window.__rbNetWatch.push({ t: Math.round(e.startTime), it: e.initiatorType, u: e.name.replace(/^https?:\/\/[^/]+/, '') });
                if (window.__rbNetWatch.length > 300) window.__rbNetWatch.shift();
              });
            }).observe({ entryTypes: ['resource'] });
          } catch (e) {}
        }
      }
      if (cfg && cfg.watchReport) watched = (window.__rbNetWatch || []).slice(-80);
      let genStatus = null;
      if (cfg && cfg.genStatus) {
        try {
          const gr = await fetch('/api/v1/canvas-studio/video/generate/status?project_id=' + ids().projectId + '&canvas_id=' + ids().canvasId + '&node_uid=' + cfg.genStatus, { headers: api() });
          genStatus = { st: gr.status, body: (await gr.text()).slice(0, 500) };
        } catch (e) { genStatus = { err: e.message }; }
      }
      let genPost = null;
      if (cfg && cfg.genPost) {
        try {
          const pr = await fetch('/api/v1/canvas-studio/video/generate', { method: 'POST', headers: api(), body: JSON.stringify(cfg.genPost) });
          genPost = { st: pr.status, body: (await pr.text()).slice(0, 600) };
        } catch (e) { genPost = { err: e.message }; }
      }
      let rawApi = null;
      if (cfg && cfg.rawApi) {
        try {
          const rr = await fetch(cfg.rawApi, { headers: api() });
          const txt = await rr.text();
          let clean = txt;
          try {
            const d0 = JSON.parse(txt);
            const d = d0.data || d0;
            if (cfg.rawSummary) {
              clean = JSON.stringify({ default_model: d.default_model, models: (d.models || []).map(m => ({
                id: m.id, series_id: m.series_id, label: m.label,
                caps: (m.capability_options || []).map(c => ({ id: c.id, value: c.value, label: c.label }))
              })) });
            } else {
              const strip = v => {
                if (Array.isArray(v)) return v.map(strip);
                if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) if (!/^(icon|description)$/i.test(k)) o[k] = strip(v[k]); return o; }
                return v;
              };
              clean = JSON.stringify(strip(d0));
            }
          } catch (e) {}
          rawApi = { st: rr.status, body: clean.slice(0, 60000) };
        } catch (e) { rawApi = { err: e.message }; }
      }
      return { canvasId: ids().canvasId, target, deep, byLabel, dumpNode, watched, genStatus, genPost, rawApi,
        netLog: (() => { try { return JSON.parse(localStorage.getItem('__rbNetLog') || '[]').map(x => ({ m: x.m, u: String(x.u).slice(0, 160), b: x.b ? String(x.b).slice(0, 500) : null })); } catch (e) { return ['ERR:' + e.message]; } })(),
        pendingVideos: vids.filter(v => { urls.length = 0; walk(v.data, 'd', 0); return !urls.length; }).slice(0, 20).map(v => ({ uid: v.node_uid, label: v.label, status: v.data && v.data.generation_status || null })),
        videosWithUrls: videos.filter(v => v.urls.length),
        videoCount: vids.length, totalNodes: st.nodes.length, totalEdges: st.edges.length };
    },
    // [ref 2026-09-23] 截帧挂参考：源视频节点截帧 → 平台上传建图节点 → 连线到目标节点
    hangRef: async function (cfg) {
      const st = await this.state();
      const norm = s => (s || '').replace(/\s+/g, '').toLowerCase();
      const from = st.nodes.find(n => norm(n.label) === norm(cfg.fromLabel) || n.node_uid === cfg.fromUid);
      const to = st.nodes.find(n => norm(n.label) === norm(cfg.toLabel) || n.node_uid === cfg.toUid);
      if (!from) throw new Error('找不到源节点 ' + (cfg.fromLabel || cfg.fromUid));
      if (!to) throw new Error('找不到目标节点 ' + (cfg.toLabel || cfg.toUid));
      let url = cfg.url || null;
      (function walk(v) {
        if (url || v == null || typeof v === 'number') return;
        if (typeof v === 'string') { if (/^https?:\/\//i.test(v) && /\.(mp4|mov|webm|m4v)/i.test(v.split('?')[0])) url = v; return; }
        if (typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k]); }
      })(from.data);
      if (!url) throw new Error('源节点 ' + from.label + ' 里没有视频 URL（kind=' + from.node_kind + '）');
      if (!/^https?:\/\//i.test(url)) throw new Error('源节点 URL 无效: ' + url.slice(0, 80));
      const t = cfg.t || 60000;
      const snap = url.split('?')[0] + '?x-oss-process=video/snapshot,t_' + t + ',f_jpg,w_800,m_fast,ar_auto';
      let blob;
      try {
        const r = await fetch(snap); if (!r.ok) throw new Error('HTTP ' + r.status);
        blob = await r.blob();
      } catch (e) {
        throw new Error('截帧图下载失败（' + e.message + '）snap=' + snap.slice(0, 140));
      }
      const before = new Set(st.nodes.map(n => n.node_uid));
      await this.upload([{ blob: blob, name: 'ref-' + norm(cfg.fromLabel) + '-t' + t + '.jpg' }]);
      await sleep(3000);
      const st2 = await this.state();
      const newNodes = st2.nodes.filter(n => !before.has(n.node_uid));
      const imgNode = newNodes.find(n => /image|upload/i.test(n.node_kind || '')) || newNodes[0];
      if (!imgNode) throw new Error('上传后画布上没有出现新节点');
      const edge = { edge_uid: 'e-rb-ref-' + norm(cfg.fromLabel) + '-' + t, from_node_uid: imgNode.node_uid, to_node_uid: to.node_uid, source_node_uid: imgNode.node_uid, target_node_uid: to.node_uid, source_handle: 'source', target_handle: 'target' };
      await this.batch({ nodes: { create: [], update: [], delete: [] }, edges: { create: [edge], delete: [] } });
      await sleep(800);
      const st3 = await this.state();
      const edgeOk = st3.edges.some(e => e.edge_uid === edge.edge_uid);
      if (!edgeOk) throw new Error('截帧参考边未写入画布');
      const inputOk = await this.syncNodeInput(to.node_uid);
      if (!inputOk.ok) throw new Error('截帧边已建，但目标节点 input 未同步：' + to.label);
      return { ok: edgeOk && inputOk.ok, from: from.node_uid, to: to.node_uid, snap: snap.slice(0, 160),
        newNode: { uid: imgNode.node_uid, label: imgNode.label, kind: imgNode.node_kind }, edgeUid: edge.edge_uid, edgeOk: edgeOk, inputOk: inputOk.ok };
    },
    // 将画布实际入边写回视频节点 data.input；保留节点其他生成数据。
    syncNodeInput: async function (nodeUid) {
      let st = await this.state();
      let node = st.nodes.find(n => n.node_uid === nodeUid);
      if (!node) return { ok: false, error: '目标节点不存在' };
      const incomingEdges = st.edges.filter(e => (e.target_node_uid || e.to_node_uid) === nodeUid);
      if (incomingEdges.some(e => !(e.source_node_uid || e.from_node_uid) || !e.edge_uid)) return { ok: false, error: '存在缺少 source uid/edge uid 的入边' };
      const incoming = incomingEdges.map(e => e.edge_uid);
      const current = Array.isArray(node.data && node.data.input) ? node.data.input : [];
      if (incoming.every(uid => current.includes(uid)) && current.length === incoming.length) return { ok: true, input: current };
      const data = { ...(node.data || {}), input: incoming };
      await this.batch({ nodes: { create: [], update: [{ node_uid: node.node_uid, node_kind: node.node_kind, label: node.label || '', data }], delete: [] }, edges: { create: [], delete: [] } });
      let after = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        await sleep(800);
        st = await this.state(); node = st.nodes.find(n => n.node_uid === nodeUid);
        after = Array.isArray(node && node.data && node.data.input) ? node.data.input : [];
        if (incoming.every(uid => after.includes(uid)) && after.length === incoming.length) break;
      }
      return { ok: !!node && incoming.every(uid => after.includes(uid)) && after.length === incoming.length, input: after, expected: incoming };
    },
    // 只补资产边，不删/重建视频节点；repair=false 时纯校验，供生成前门禁使用。
    ensureChainRefs: async function (segPlans, labels, repair) {
      const normL = s => (s || '').replace(/\s+/g, '').toLowerCase();
      const wanted = new Set(labels || []), problems = [], rows = [];
      const plannedLabels = new Set((segPlans || []).map(x => x.seg.id));
      for (const label of wanted) if (!plannedLabels.has(label)) problems.push({ segment: label, reason: '未生成该段的资产规划' });
      if (problems.length) return { ready: false, problems, addedEdges: 0 };
      let st = await this.state();
      for (const sp of (segPlans || []).filter(x => wanted.has(x.seg.id))) {
        const matches = st.nodes.filter(n => normL(n.label) === normL(sp.seg.id) && n.node_kind === 'video');
        if (matches.length !== 1) { problems.push({ segment: sp.seg.id, reason: matches.length ? '画布上存在多个同名视频节点' : '画布上缺少视频节点' }); continue; }
        const target = matches[0], refs = [...new Set(sp.refs || [])];
        const absentSources = refs.filter(uid => !st.nodes.some(n => n.node_uid === uid));
        if (absentSources.length) { problems.push({ segment: sp.seg.id, reason: '参考资产节点不在画布', missingUids: absentSources }); continue; }
        rows.push({ sp, target, refs });
      }
      if (problems.length) return { ready: false, problems, addedEdges: 0 };
      let add = 0;
      const removedRefs = [];
      if (repair) {
        // 清单外参考边自动删除：以工作台清单为准，删掉指向视频节点的多余参考线，回报被删资产名
        const stale = [];
        for (const row of rows) {
          for (const e of st.edges.filter(e => (e.target_node_uid || e.to_node_uid) === row.target.node_uid)) {
            const src = e.source_node_uid || e.from_node_uid;
            if (!src || !e.edge_uid) continue;
            if (!row.refs.includes(src)) stale.push({ edge_uid: e.edge_uid, src, segment: row.sp.seg.id });
          }
        }
        const uniqStale = [...new Map(stale.map(x => [x.edge_uid, x])).values()];
        const batchDel = this.limits.edgeDelete || 150;
        for (let i = 0; i < uniqStale.length; i += batchDel) {
          await this.batch({ nodes: { create: [], update: [], delete: [] }, edges: { create: [], delete: uniqStale.slice(i, i + batchDel).map(x => ({ edge_uid: x.edge_uid })) } });
          await sleep(120);
        }
        if (uniqStale.length) {
          await sleep(600);
          st = await this.state();
          for (const x of uniqStale) {
            const n = st.nodes.find(n => n.node_uid === x.src);
            removedRefs.push({ segment: x.segment, asset: (n && n.label) || '（源节点已不存在）', uid: x.src });
          }
        }
        const create = [], usedEdgeUids = new Set(st.edges.map(e => e.edge_uid).filter(Boolean));
        for (const row of rows) {
          for (let i = 0; i < row.refs.length; i++) {
            const uid = row.refs[i];
            const exists = st.edges.some(e => (e.source_node_uid || e.from_node_uid) === uid && (e.target_node_uid || e.to_node_uid) === row.target.node_uid);
            if (exists) continue;
            const baseEdgeUid = 'e-rb-chain-' + row.sp.seg.id + '-' + i;
            let edgeUid = baseEdgeUid, suffix = 1;
            while (usedEdgeUids.has(edgeUid)) edgeUid = baseEdgeUid + '-c' + suffix++;
            usedEdgeUids.add(edgeUid);
            create.push({ edge_uid: edgeUid, from_node_uid: uid, to_node_uid: row.target.node_uid, source_node_uid: uid, target_node_uid: row.target.node_uid, source_handle: 'source', target_handle: 'target' });
          }
        }
        for (let i = 0; i < create.length; i += this.limits.edgeCreate) {
          await this.batch({ nodes: { create: [], update: [], delete: [] }, edges: { create: create.slice(i, i + this.limits.edgeCreate), delete: [] } });
          await sleep(200);
        }
        add = create.length;
        for (let attempt = 0; attempt < 4; attempt++) {
          await sleep(800);
          st = await this.state();
          const allWritten = rows.every(row => row.refs.every(uid => st.edges.some(e => (e.source_node_uid || e.from_node_uid) === uid && (e.target_node_uid || e.to_node_uid) === row.target.node_uid)));
          if (allWritten) break;
        }
      }
      const verified = [];
      for (const row of rows) {
        const node = st.nodes.find(n => n.node_uid === row.target.node_uid);
        const incoming = st.edges.filter(e => (e.target_node_uid || e.to_node_uid) === row.target.node_uid);
        if (incoming.some(e => !e.edge_uid || !(e.source_node_uid || e.from_node_uid))) { problems.push({ segment: row.sp.seg.id, reason: '画布参考边缺少 source uid/edge uid，无法安全核验' }); continue; }
        const sourceOf = e => e.source_node_uid || e.from_node_uid;
        const incomingSources = [...new Set(incoming.map(sourceOf))];
        const missing = row.refs.filter(uid => !incomingSources.includes(uid));
        const unexpected = incomingSources.filter(uid => !row.refs.includes(uid));
        if (missing.length) { problems.push({ segment: row.sp.seg.id, reason: '场景/角色/音频资产未连入视频节点', missingUids: missing }); continue; }
        if (repair) {
          const si = await this.syncNodeInput(row.target.node_uid);
          if (!si.ok) { problems.push({ segment: row.sp.seg.id, reason: 'data.input 未与画布全部入边同步', expectedInputCount: incoming.length, actualInputCount: (si.input || []).length }); continue; }
          if (unexpected.length) { problems.push({ segment: row.sp.seg.id, reason: '存在工作台资产清单之外的参考边；未删除，请核对后重试', unexpectedUids: unexpected, unexpectedAssets: unexpected.map(uid => (st.nodes.find(n => n.node_uid === uid) || {}).label || uid) }); continue; }
          verified.push({ segment: row.sp.seg.id, referenceCount: row.refs.length, inputCount: si.input.length });
        } else {
          const inputs = Array.isArray(node && node.data && node.data.input) ? node.data.input : [];
          const incomingIds = incoming.map(e => e.edge_uid).filter(Boolean);
          const inputsExact = inputs.length === incomingIds.length && incomingIds.every(uid => inputs.includes(uid));
          if (!inputsExact) { problems.push({ segment: row.sp.seg.id, reason: 'video.data.input 与全部实际入边不完全一致', expectedInputCount: incomingIds.length, actualInputCount: inputs.length }); continue; }
          if (unexpected.length) { problems.push({ segment: row.sp.seg.id, reason: '存在工作台资产清单之外的参考边', unexpectedUids: unexpected, unexpectedAssets: unexpected.map(uid => (st.nodes.find(n => n.node_uid === uid) || {}).label || uid) }); continue; }
          verified.push({ segment: row.sp.seg.id, referenceCount: row.refs.length, inputCount: inputs.length });
        }
      }
      return { ready: problems.length === 0, problems, addedEdges: add, segments: verified, removedRefs };
    },
    // 从工作台传入的显式挂载清单解析/上传资产；只增资产节点，不删建视频节点。
    resolveChainManifest: async function (segs, assetRoot, uploadMissing) {
      const key = s => (s || '').replace(/\.(png|jpg|jpeg|webp|wav|mp3|m4a|flac)$/i, '').replace(/\s+/g, '').toLowerCase();
      const problems = [], missingFiles = new Map(), fallbacks = new Map();
      let st = await this.state();
      const nodeKindOk = (n, cat) => cat === 'audio' ? /audio/i.test(n.node_kind || '') : /image|upload/i.test(n.node_kind || '') && n.node_kind !== 'video';
      const findAsset = (nodes, a) => nodes.filter(n => n.node_kind !== 'video' && key(n.label) === key(a.file) && nodeKindOk(n, a.category));
      // 同名节点取准：以「最新导入」为准——优先节点时间戳字段，缺了用 uid 序号兜底；其余重复节点在准备阶段删除（被引用的保留但不再使用）
      const nodeTime = n => {
        const cands = [n.created_at, n.create_time, n.updated_at, n.update_time, n.gmt_created, n.data && n.data.created_at, n.data && n.data.create_time];
        for (const v of cands) {
          if (v == null || v === '') continue;
          if (typeof v === 'number') return v;
          const t = Date.parse(v); if (!isNaN(t)) return t;
        }
        const parts = String(n.node_uid || '').split('-').filter(s => /^\d+$/.test(s));   // 'image-667-155-xxx' → ['667','155']，取最后一段序号（画布 ID 在前）
        return parts.length ? parseInt(parts[parts.length - 1], 10) : 0;
      };
      const pickNewest = found => found.slice().sort((a, b) => nodeTime(b) - nodeTime(a))[0];
      const dupGroups = [];   // {segment, category, character, asset, keep, stale:[node], keptBecauseReferenced}
      const recordDup = (segment, category, character, asset, found) => {
        const keep = pickNewest(found);
        dupGroups.push({ segment, category, character, asset, keep, stale: found.filter(n => n.node_uid !== keep.node_uid) });
        return keep;
      };
      // 画布兜底：工作台清单缺项时，先看画布上是否已有可用资产节点（场景精确同名；角色/音频按角色名识别），有就直接拿来做参考，不再急着报缺
      const canvasAudioChar = label => { const base = String(label || '').replace(/\.[^.]+$/, '').replace(/_?音轨$/, ''); const m = base.match(/^-?[0-9]+[-_](.+)$/); return key(m ? m[1] : base); };
      const sceneNameKeys = new Set();
      (segs || []).forEach(sp => {
        [sp.scene, sp.required && sp.required.sceneText].forEach(t => { const k = key(t); if (k) sceneNameKeys.add(k); });
        (sp.assets || []).forEach(a => { if (a.category === 'scene' && a.file) sceneNameKeys.add(key(a.file)); });
      });
      const sceneClaimed = new Set();
      const canvasFallback = (category, character, sceneText, segment) => {
        if (category === 'scene') {
          const k = key(sceneText);
          if (!k) return { reason: '缺少场景名' };
          const m = st.nodes.filter(n => n.node_kind !== 'video' && key(n.label) === k);
          if (!m.length) return { reason: '画布上没有同名场景节点' };
          const keep = m.length === 1 ? m[0] : recordDup(segment || '', 'scene', '', k, m);
          sceneClaimed.add(keep.node_uid);
          return { node: keep };
        }
        const ck = key(character);
        if (!ck) return { reason: '缺少角色名' };
        const kind = category === 'audio' ? '音轨' : '角色图';
        const m = st.nodes.filter(n => {
          if (sceneClaimed.has(n.node_uid) || sceneNameKeys.has(key(n.label))) return false;
          if (!nodeKindOk(n, category)) return false;
          const lk = key(n.label);
          if (lk.startsWith(ck)) return true;
          const core = category === 'audio' ? canvasAudioChar(n.label) : lk.replace(/^-?[0-9]+[-_]/, '');
          return core === ck || core.startsWith(ck);
        });
        if (!m.length) return { reason: '画布上没有匹配' + kind + '的节点' };
        const keep = m.length === 1 ? m[0] : recordDup(segment || '', category, character, character, m);
        return { node: keep };
      };
      // 第一遍：清单完整性（允许画布兜底），逐段收集画布兜底引用
      for (const sp of (segs || [])) {
        const assets = sp.assets || [], required = sp.required || {}, fb = [];
        fallbacks.set(sp.label, fb);
        if (!Array.isArray(required.characters)) problems.push({ segment: sp.label, category: 'role/audio', reason: '工作台清单缺少角色/音轨需求表' });
        if (required.scene !== true) problems.push({ segment: sp.label, category: 'scene', asset: required.sceneText || '', reason: '工作台清单未确认本段场景需求' });
        else if (!assets.some(a => a.category === 'scene' && a.file)) {
          const f = canvasFallback('scene', '', required.sceneText || sp.scene || '', sp.label);
          if (f.node) fb.push({ category: 'scene', character: '', asset: f.node.label, uid: f.node.node_uid, via: 'canvas' });
          else problems.push({ segment: sp.label, category: 'scene', asset: required.sceneText || '', reason: '工作台与画布均未找到场景资产；请先在工作台导入场景图', detail: f.reason });
        }
        for (const ch of required.characters || []) {
          if (!assets.some(a => a.category === 'role' && a.character === ch && a.file)) {
            const f = canvasFallback('role', ch, '', sp.label);
            if (f.node) fb.push({ category: 'role', character: ch, asset: f.node.label, uid: f.node.node_uid, via: 'canvas' });
            else problems.push({ segment: sp.label, category: 'role', character: ch, reason: '工作台与画布均未找到角色参考图；请先在工作台导入', detail: f.reason });
          }
          if (!assets.some(a => a.category === 'audio' && a.character === ch && a.file)) {
            const f = canvasFallback('audio', ch, '', sp.label);
            if (f.node) fb.push({ category: 'audio', character: ch, asset: f.node.label, uid: f.node.node_uid, via: 'canvas' });
            else problems.push({ segment: sp.label, category: 'audio', character: ch, reason: '工作台与画布均未找到角色音轨；请先在工作台导入', detail: f.reason });
          }
        }
        for (const a of assets) if (!a.file) problems.push({ segment: sp.label, category: a.category || 'unknown', character: a.character || '', reason: a.reason || '工作台挂载项没有素材文件' });
      }
      if (problems.length) return { ready: false, problems, uploaded: 0, plans: [] };
      const rows = [];
      for (const sp of (segs || [])) {
        const targets = st.nodes.filter(n => n.node_kind === 'video' && key(n.label) === key(sp.label));
        if (targets.length !== 1) { problems.push({ segment: sp.label, category: 'video', reason: targets.length ? '画布上存在多个同名视频节点' : '画布上缺少视频节点' }); continue; }
        const refs = (fallbacks.get(sp.label) || []).map(f => f.uid);
        for (const asset of (sp.assets || [])) {
          const found = findAsset(st.nodes, asset);
          if (found.length >= 1) {
            // 多个同名资产节点：以最新导入为准，其余在准备阶段删除
            const keep = found.length === 1 ? found[0] : recordDup(sp.label, asset.category, asset.character || '', asset.file, found);
            refs.push(keep.node_uid);
          }
          else missingFiles.set(asset.category + '|' + asset.file, asset);
        }
        rows.push({ sp, target: targets[0], refs });
      }
      if (problems.length) return { ready: false, problems, uploaded: 0, plans: [] };
      // 同名去重：仅资产节点、仅准备阶段；仍被参考线引用的旧节点保留但不再使用
      const deduped = [];
      if (dupGroups.length && uploadMissing) {
        const referenced = new Set(st.edges.map(e => e.source_node_uid || e.from_node_uid).filter(Boolean));
        const seenDel = new Set(), del = [];
        for (const g of dupGroups) for (const n of g.stale) {
          if (seenDel.has(n.node_uid)) continue;
          seenDel.add(n.node_uid);
          if (referenced.has(n.node_uid)) { g.keptBecauseReferenced = (g.keptBecauseReferenced || 0) + 1; continue; }
          del.push(n);
        }
        const batchN = this.limits.nodeDelete || 50;
        for (let i = 0; i < del.length; i += batchN) {
          await this.batch({ nodes: { create: [], update: [], delete: del.slice(i, i + batchN).map(n => ({ node_uid: n.node_uid, node_kind: n.node_kind, label: n.label || '' })) }, edges: { create: [], delete: [] } });
          await sleep(150);
        }
        if (del.length) { await sleep(800); st = await this.state(); }
        for (const g of dupGroups) deduped.push({ segment: g.segment || '', category: g.category, character: g.character || '', asset: g.asset, kept: g.keep.node_uid, keptLabel: g.keep.label, removed: g.stale.length - (g.keptBecauseReferenced || 0), keptBecauseReferenced: g.keptBecauseReferenced || 0 });
      }
      let uploaded = 0;
      if (missingFiles.size) {
        if (!uploadMissing) return { ready: false, problems: [...missingFiles.values()].map(a => ({ category: a.category, character: a.character || '', asset: a.file, reason: '画布上缺少该工作台资产' })), uploaded: 0, plans: [] };
        const toUpload = [];
        for (const asset of missingFiles.values()) {
          const dir = asset.category === 'scene' ? '1-场景' : asset.category === 'prop' ? '2-道具' : '0-角色和声音';
          const url = assetRoot.replace(/\/$/, '') + '/' + dir.split('-')[0] + '-' + encodeURIComponent(dir.split('-').slice(1).join('-')) + '/' + encodeURIComponent(asset.file);
          const r = await fetch(url);
          if (!r.ok) { problems.push({ category: asset.category, character: asset.character || '', asset: asset.file, reason: '工作台素材服务读取失败 HTTP ' + r.status }); continue; }
          toUpload.push({ blob: await r.blob(), name: asset.file });
        }
        if (problems.length) return { ready: false, problems, uploaded: 0, plans: [] };
        const up = await this.upload(toUpload);
        uploaded = up.uploaded || 0;
        await sleep(3000);
        st = await this.state();
      }
      const plans = [];
      for (const sp of (segs || [])) {
        const target = st.nodes.filter(n => n.node_kind === 'video' && key(n.label) === key(sp.label));
        if (target.length !== 1) { problems.push({ segment: sp.label, category: 'video', reason: target.length ? '上传后视频节点重名' : '上传后画布缺少视频节点' }); continue; }
        const refs = (fallbacks.get(sp.label) || []).map(f => {
          if (!st.nodes.some(n => n.node_uid === f.uid)) { problems.push({ segment: sp.label, category: f.category, character: f.character || '', asset: f.asset, reason: '上传后画布兜底资产节点消失' }); return null; }
          return f.uid;
        }).filter(Boolean);
        for (const asset of (sp.assets || [])) {
          const found = findAsset(st.nodes, asset);
          if (!found.length) problems.push({ segment: sp.label, category: asset.category, character: asset.character || '', asset: asset.file, reason: '上传后资产节点未出现' });
          else refs.push((found.length === 1 ? found[0] : pickNewest(found)).node_uid);
        }
        plans.push({ seg: { id: sp.label }, refs: [...new Set(refs)] });
      }
      return { ready: problems.length === 0, problems, uploaded, plans, deduped, fallbacks: [...fallbacks.entries()].flatMap(([label, list]) => list.map(f => Object.assign({}, f, { segment: label }))) };
    },
    // [chain 2026-09-23] 链式生成：逐段代点→轮询→同场景链内截帧传参考，场景切换断链（工作台已算好 segs/refTo）
    chainRun: async function (cfg, onProgress) {
      const rep = (m, p) => { try { onProgress && onProgress(m, p); } catch (e) {} };
      const normL = s => (s || '').replace(/\s+/g, '').toLowerCase();
      const segs = cfg.segs || [];
      if (!segs.length) throw new Error('chain.segs 为空');
      const log = [];
      for (let i = 0; i < segs.length; i++) {
        const sp = segs[i];
        const pct = 5 + Math.round(i / segs.length * 90);
        const canvasNow = await this.state();
        const nodeMatches = canvasNow.nodes.filter(n => normL(n.label) === normL(sp.label) && n.node_kind === 'video');
        if (nodeMatches.length !== 1) { log.push(sp.label + ': 视频节点缺失或重名，停止链式生成'); break; }
        const node = nodeMatches[0], d = node.data || {};
        const expectedRefs = (cfg.expectedRefs && cfg.expectedRefs[sp.label]) || [];
        const incoming = canvasNow.edges.filter(e => (e.target_node_uid || e.to_node_uid) === node.node_uid);
        const sourceOf = e => e.source_node_uid || e.from_node_uid;
        const malformedInput = incoming.some(e => !sourceOf(e) || !e.edge_uid);
        const incomingSources = [...new Set(incoming.map(sourceOf).filter(Boolean))];
        const missingRefs = expectedRefs.filter(uid => !incomingSources.includes(uid));
        const unexpectedRefs = incomingSources.filter(uid => !expectedRefs.includes(uid));
        const inputs = Array.isArray(d.input) ? d.input : [];
        const incomingIds = incoming.map(e => e.edge_uid).filter(Boolean);
        const inputMismatch = incomingIds.length !== incoming.length || inputs.length !== incomingIds.length || !incomingIds.every(uid => inputs.includes(uid));
        if (malformedInput || missingRefs.length || unexpectedRefs.length || inputMismatch) {
          log.push(sp.label + ': 场景/角色/音频参考校验失败（缺边 ' + missingRefs.length + '，清单外参考 ' + unexpectedRefs.length + '，无效边=' + malformedInput + '，data.input 不一致=' + inputMismatch + '），停止链式生成');
          rep('[' + sp.label + '] 参考校验失败，未提交生成；链式已停止', pct);
          break;
        }
        let okUrl = null;
        if (d.generation_status === 'succeeded') {
          log.push(sp.label + ': 已有生成结果，跳过代点');
        } else if (d.generation_status === 'processing' || d.generation_status === 'pending') {
          log.push(sp.label + ': 已在生成中，等待完成');
        } else {
          const cap = d.model || cfg.defaultModel;
          const series = CAP2SERIES[cap];
          if (!series) { log.push(sp.label + ': 未知模型 ' + cap + '，跳过'); continue; }
          if (!d.prompt) { log.push(sp.label + ': 节点无 prompt，跳过'); continue; }
          rep('[' + sp.label + '] 提交代点生成（模型 ' + cap + '）…', pct);
          const body = { project_id: ids().projectId, canvas_id: ids().canvasId, node_uid: node.node_uid,
            prompt: d.prompt, model_series_id: series, capability_id: String(cap), task_id: crypto.randomUUID() };
          const r = await fetch('/api/v1/canvas-studio/video/generate', { method: 'POST', headers: api(), body: JSON.stringify(body) });
          const rj = await r.json().catch(() => ({}));
          if (r.status !== 200) { log.push(sp.label + ': 提交失败 ' + r.status + ' ' + JSON.stringify(rj).slice(0, 120)); continue; }
          log.push(sp.label + ': 已提交（task ' + (rj.data && rj.data.task_id || body.task_id) + '）');
        }
        let done = false;
        for (let k = 0; k < (cfg.pollMax || 60); k++) {
          await sleep(10000);
          rep('[' + sp.label + '] 生成中…已等 ' + ((k + 1) * 10) + 's', pct);
          const gr = await fetch('/api/v1/canvas-studio/video/generate/status?project_id=' + ids().projectId + '&canvas_id=' + ids().canvasId + '&node_uid=' + node.node_uid, { headers: api() });
          const gj = (await gr.json().catch(() => ({}))).data || {};
          if (gj.status === 'succeeded') { okUrl = (gj.urls && gj.urls[0]) || null; done = true; break; }
          if (gj.status === 'failed') { log.push(sp.label + ': 生成失败 ' + (gj.message || '')); break; }
        }
        if (!done) { log.push(sp.label + ': 等待超时，中止后续（避免参考断裂）'); break; }
        log.push(sp.label + ': 生成完成');
        if (sp.refTo) {
          rep('[' + sp.label + '] 截帧挂参考 → ' + sp.refTo, pct);
          try {
            const hr = await this.hangRef({ fromUid: node.node_uid, fromLabel: sp.label, toLabel: sp.refTo, t: sp.t || 60000, url: okUrl ? okUrl.split('?')[0] : null });
            if (cfg.expectedRefs && cfg.expectedRefs[sp.refTo] && hr.newNode && hr.newNode.uid) cfg.expectedRefs[sp.refTo].push(hr.newNode.uid);
            log.push(sp.label + ' → ' + sp.refTo + ': 截帧已挂（' + hr.newNode.label + '）');
          } catch (e) { log.push(sp.label + ': 挂参考失败 ' + String(e.message).slice(0, 100)); }
        } else {
          log.push(sp.label + ': 场景链尾，不挂截帧');
        }
      }
      rep('链式生成结束', 100);
      return { log };
    },
    clear: async function () {
      const st = await this.state();
      let fails = 0;
      for (let i = 0; i < st.edges.length; i += 150) {
        await this.batch({ nodes: { create: [], update: [], delete: [] }, edges: { create: [], delete: st.edges.slice(i, i + 150).map(e => ({ edge_uid: e.edge_uid })) } }).catch(() => fails++);
        await sleep(120);
      }
      const del8 = async list => {
        for (let i = 0; i < list.length; i += this.limits.nodeDelete) {
          await this.batch({ nodes: { create: [], update: [], delete: list.slice(i, i + this.limits.nodeDelete).map(n => ({ node_uid: n.node_uid, node_kind: n.node_kind, label: n.label || '' })) }, edges: { create: [], delete: [] } }).catch(() => fails++);
          await sleep(150);
        }
      };
      await del8(st.nodes);
      const after = await this.state();
      if (after.nodes.length) await del8(after.nodes);
      const fin = await this.state();
      return { cleared: st.nodes.length, fails, remain: fin.nodes.length + ' nodes / ' + fin.edges.length + ' edges' };
    },
  };

  window.RBAdapterRunroll = adapter;
  window.RBCore.register(adapter);
  console.log('%c[RB] Runroll 适配器已注册', 'color:#08f');
})();
