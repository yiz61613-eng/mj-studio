/* =============================================================
 * RB Adapter —— UpDream（B站 AI 视频创作平台，完整能力）
 * 依赖 rb-core.js。
 * 实测要点（2026-09-20 逆向）：
 *  - 鉴权：localStorage.access_token → Authorization: Bearer
 *  - 读：GET /api/canvas-nodes/project/{extId}?include_generation_history=false
 *        GET /api/canvas-nodes/project/{extId}/connections
 *  - 建：POST /api/canvas-nodes/project/{extId}（每节点一次）
 *        节点字段：{x,y,width,height,node_type,name,prompt,text_content,
 *                  source_type:'upload',source_url,url,cover_url,node_config}
 *  - 连线：POST /api/canvas-nodes/project/{extId}/connections {from_node_id,to_node_id}
 *        默认 is_reference:true —— 天然“自动参考”
 *  - 改位：POST /api/canvas-nodes/project/{extId}/batch-update-positions [{id,x,y}]
 *  - 删：POST /api/canvas-nodes/project/{extId}/batch-delete {node_ids:[]}
 *        DELETE /api/canvas-nodes/connections/{id}
 *  - 上传：GET /api/upload/file-presign?filename&size → PUT bytes → file_url
 * ============================================================= */
(function () {
  'use strict';
  if (!window.RBCore) throw new Error('请先加载 rb-core.js');
  const { norm, sleep } = window.RBCore;

  function extId() {
    const m = location.href.match(/canvas\?project=(\d+)/);
    if (!m) throw new Error('不在 UpDream 画布页面');
    return m[1];
  }
  function H(json) {
    const h = { 'Authorization': 'Bearer ' + localStorage.getItem('access_token') };
    if (json !== false) h['Content-Type'] = 'application/json';
    return h;
  }
  const AUDIO_RE = /\.(wav|mp3|m4a|aac|ogg|flac)$/i;

  const adapter = {
    id: 'updream',
    name: 'UpDream 画布',
    capabilities: { createNodes: true, createEdges: true, clear: true },
    limits: { nodeCreate: 1, nodeDelete: 200, edgeCreate: 1 },
    match: () => /updream\.cn\/canvas\?project=\d+/.test(location.href),
    init: async () => {
      if (!localStorage.getItem('access_token')) throw new Error('未登录 UpDream');
    },
    ids: extId,
    state: async () => {
      const pid = extId();
      const n = await (await fetch(`/api/canvas-nodes/project/${pid}?include_generation_history=false`, { headers: H() })).json();
      const c = await (await fetch(`/api/canvas-nodes/project/${pid}/connections`, { headers: H() })).json();
      const nd = n.data || n, cd = c.data || c;
      return {
        nodes: (Array.isArray(nd) ? nd : (nd.nodes || [])).filter(x => !x.is_deleted),
        edges: Array.isArray(cd) ? cd : (cd.connections || []),
      };
    },
    normalizeLabel: s => norm(s),
    uidIndex: nodes => { const m = {}; nodes.forEach(n => m[norm(n.name)] = String(n.id)); return m; },
    listModels: async () => {
      const r = await fetch('/api/ai/video-models', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('access_token') } });
      const j = await r.json();
      const d = j.data || j;
      const models = (d.models || []).map(m => ({ value: m.value, label: m.label }));
      return { models, defaultModel: 'sed2-fast' };
    },
    upload: async function (files) {
      const pid = extId();
      let done = 0; const fails = []; const created = [];
      for (const f of files) {
        try {
          const q = new URLSearchParams({ filename: f.name, size: String(f.blob.size) });
          const p = await (await fetch('/api/upload/file-presign?' + q.toString(), { headers: H() })).json();
          const d = p.data || p;
          const put = await fetch(d.upload_url, { method: 'PUT', body: f.blob });
          if (!put.ok) throw new Error('PUT ' + put.status);
          const isAudio = AUDIO_RE.test(f.name);
          const payload = {
            x: 0, y: 0, width: isAudio ? 300 : 300, height: isAudio ? 120 : 200,
            node_type: isAudio ? 'audio' : 'image', name: f.name.replace(/\.[^.]+$/, ''),
            source_type: 'upload', source_url: d.file_url, url: d.file_url,
            cover_url: isAudio ? '' : d.file_url, node_config: {},
          };
          const cr = await (await fetch(`/api/canvas-nodes/project/${pid}`, { method: 'POST', headers: H(), body: JSON.stringify(payload) })).json();
          const dd = cr.data || cr;
          if (!dd || !dd.id) throw new Error('create failed');
          created.push(String(dd.id));
          done++;
          await sleep(300);
        } catch (e) { fails.push(f.name); }
      }
      return { uploaded: done, failed: fails, createdIds: created };
    },
    makeNodePayload: function (segPlan, cfg) {
      const p = segPlan.seg;
      const isVideo = true; // 分镜节点统一建视频节点
      return {
        x: segPlan.x, y: segPlan.y, width: cfg.aspect === '9x16' ? 200 : 356, height: cfg.aspect === '9x16' ? 356 : 200,
        node_type: 'video', name: p.id, prompt: segPlan.prompt,
        node_config: {
          params: {
            prompt: segPlan.prompt, model: cfg.model || 'sed2-fast',
            ratio: cfg.aspect === '9x16' ? '9:16' : '16:9',
            duration: segPlan.duration, audio: true,
            referenceImages: [], videoRefs: [], numImages: 1, videoCount: 1,
          },
        },
      };
    },
    build: async function (S) {
      const cfg = window.RBCore.cfg;
      const P = S.plan;
      const pid = extId();
      if (cfg.clearFirst) await this.clear();
      // 1. 资产排位（updream 资产节点在 plan 时已有 uid；直接批量改位）
      const layout = [...P.charPlaced, ...P.grid].filter(a => a.uid);
      if (layout.length) {
        await fetch(`/api/canvas-nodes/project/${pid}/batch-update-positions`, { method: 'POST', headers: H(), body: JSON.stringify(layout.map(a => ({ id: Number(a.uid), x: a.x, y: a.y }))) });
      }
      // 2. 建视频节点（逐个）+ 连线（逐条，默认 is_reference）
      const edgesMade = [];
      for (const sp of P.segPlans) {
        try {
          const r = await (await fetch(`/api/canvas-nodes/project/${pid}`, { method: 'POST', headers: H(), body: JSON.stringify(this.makeNodePayload(sp, cfg)) })).json();
          const d = r.data || r;
          sp.uid = d.id;
        } catch (e) { continue; }
        for (const from of sp.refs) {
          try {
            await fetch(`/api/canvas-nodes/project/${pid}/connections`, { method: 'POST', headers: H(), body: JSON.stringify({ from_node_id: Number(from), to_node_id: sp.uid }) });
            edgesMade.push(1);
          } catch (e) {}
          await sleep(120);
        }
        await sleep(150);
      }
      const fin = await this.state();
      return { videos: fin.nodes.filter(n => n.node_type === 'video').length, assets: fin.nodes.length, edges: fin.edges.length, edgesMade: edgesMade.length };
    },
    clear: async function () {
      const pid = extId();
      const st = await this.state();
      let fails = 0;
      for (const e of st.edges) {
        await fetch(`/api/canvas-nodes/connections/${e.id}`, { method: 'DELETE', headers: H(false) }).catch(() => fails++);
        await sleep(80);
      }
      const ids = st.nodes.map(n => n.id);
      for (let i = 0; i < ids.length; i += 100) {
        await fetch(`/api/canvas-nodes/project/${pid}/batch-delete`, { method: 'POST', headers: H(), body: JSON.stringify({ node_ids: ids.slice(i, i + 100) }) }).catch(() => fails++);
        await sleep(200);
      }
      const fin = await this.state();
      return { cleared: st.nodes.length, fails, remain: fin.nodes.length + ' nodes / ' + fin.edges.length + ' edges' };
    },
  };

  window.RBAdapterUpdream = adapter;
  window.RBCore.register(adapter);
  console.log('%c[RB] UpDream 适配器已注册', 'color:#f80');
})();
