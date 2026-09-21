/* =============================================================
 * RB Adapter —— Runroll（完整能力）
 * 依赖 rb-core.js。能力：读状态 / 上传 / 建节点 / 连线 / 清空。
 * 实测约束：节点删除每批 ≤8；节点建/改每批 ≤40；连线每批 ≤120。
 * ============================================================= */
(function () {
  'use strict';
  if (!window.RBCore) throw new Error('请先加载 rb-core.js');

  const { norm, sleep } = window.RBCore;

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
      const r = await fetch(`/api/v1/canvas-studio/collab/projects/${projectId}/canvases/${canvasId}?sessionId=${sid}`, { headers: api() });
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
      const st = await this.state();
      const meta = Object.fromEntries(st.nodes.map(n => [n.node_uid, { kind: n.node_kind, label: n.label }]));
      // 资产排位
      const layout = [...P.charPlaced, ...P.grid].filter(a2 => meta[a2.uid]);
      for (let i = 0; i < layout.length; i += this.limits.nodeCreate) {
        await this.batch({ nodes: { create: [], update: layout.slice(i, i + this.limits.nodeCreate).map(a3 => ({ node_uid: a3.uid, node_kind: meta[a3.uid].kind, label: meta[a3.uid].label, canvas_x: a3.x, canvas_y: a3.y })), delete: [] }, edges: { create: [], delete: [] } });
        await sleep(150);
      }
      // 视频节点 + 连线
      let ei = 0;
      for (let i = 0; i < P.segPlans.length; i += this.limits.nodeCreate) {
        const chunk = P.segPlans.slice(i, i + this.limits.nodeCreate);
        const creates = chunk.map(sp => { sp.uid = 'video-' + ids().canvasId + '-rb-' + sp.seg.id; return this.makeVideoNode(sp, cfg); });
        const edges = chunk.flatMap(sp => sp.refs.map((u, k) => ({ edge_uid: 'e-rb-' + sp.seg.id + '-' + k, from_node_uid: u, to_node_uid: sp.uid, source_node_uid: u, target_node_uid: sp.uid, source_handle: 'source', target_handle: 'target' })));
        await this.batch({ nodes: { create: creates, update: [], delete: [] }, edges: { create: [], delete: [] } });
        for (let j = 0; j < edges.length; j += this.limits.edgeCreate) {
          await this.batch({ nodes: { create: [], update: [], delete: [] }, edges: { create: edges.slice(j, j + this.limits.edgeCreate), delete: [] } });
        }
        ei += edges.length;
        await sleep(200);
      }
      const fin = await this.state();
      const vids = fin.nodes.filter(n => n.node_kind === 'video');
      return { videos: vids.length, assets: fin.nodes.length - vids.length, edges: fin.edges.length };
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
