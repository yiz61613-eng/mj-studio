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
      let url = null;
      (function walk(v) {
        if (url || v == null || typeof v === 'number') return;
        if (typeof v === 'string') { if (/^https?:\/\//i.test(v) && /\.(mp4|mov|webm|m4v)/i.test(v.split('?')[0])) url = v; return; }
        if (typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k]); }
      })(from.data);
      if (!url) throw new Error('源节点 ' + from.label + ' 里没有视频 URL（kind=' + from.node_kind + '）');
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
      return { ok: edgeOk, from: from.node_uid, to: to.node_uid, snap: snap.slice(0, 160),
        newNode: { uid: imgNode.node_uid, label: imgNode.label, kind: imgNode.node_kind }, edgeUid: edge.edge_uid, edgeOk: edgeOk };
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
