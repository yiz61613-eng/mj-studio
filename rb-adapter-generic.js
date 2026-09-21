/* =============================================================
 * RB Adapter —— 通用兜底（任意平台的画布页面）
 * 依赖 rb-core.js。
 * 能做：在页面上找到文件上传口 → 批量注入素材；导出完整导入计划。
 * 不能做（诚实降级）：在未知平台上凭空创建视频节点/连线——各平台
 *   内部结构不同，需要为它写专属适配器（参照 rb-adapter-runroll.js，
 *   约几百行）。此适配器不假装成功。
 * ============================================================= */
(function () {
  'use strict';
  if (!window.RBCore) throw new Error('请先加载 rb-core.js');
  const { norm, sleep, commonFileUpload } = window.RBCore;

  const adapter = {
    id: 'generic',
    name: '通用平台（兜底）',
    capabilities: { createNodes: false, createEdges: false, clear: false,
      note: '该平台未写专属适配器：可自动上传素材，节点与参考连线需按导出的计划手工挂接，或联系为该平台开发适配器。' },
    limits: {},
    match: () => true,   // 兜底，永远最后匹配
    init: async () => {},
    state: async () => {
      // 尽力枚举画布节点（vue-flow / react-flow 常见类名），仅作参考计数
      const sels = ['.vue-flow__node', '.react-flow__node', '[data-id][class*=node]'];
      let count = 0;
      for (const s of sels) { count = document.querySelectorAll(s).length; if (count) break; }
      return { nodes: [], edges: [], domNodeCount: count };
    },
    normalizeLabel: s => norm(s),
    uidIndex: () => ({}),   // 无法建立稳定 uid 索引 → plan 会报全部缺失，属预期
    upload: async (files) => commonFileUpload(files),
    build: async function (S) {
      const out = window.RBCore.exportPlan();
      return { degraded: true, note: out + '；素材已上传：' + (S.files ? S.files.length : 0) + ' 个（如页面上传口可用）' };
    },
    clear: async () => { throw new Error('通用适配器不支持清空，请在该平台手动操作'); },
  };

  window.RBAdapterGeneric = adapter;
  window.RBCore.register(adapter);
  console.log('%c[RB] 通用兜底适配器已注册', 'color:#888');
})();
