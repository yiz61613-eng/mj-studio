// 本地素材服务 v2.3：供画布页面拉取 D 盘素材（带 CORS）
// /__list/<目录名> 目录清单   /__health 健康检查   /__tool/<js> 工具脚本分发
// v2.3 新增：/__jobs 任务队列（工作台下发 → 画布页油猴桥领取执行）+ /__bridge 心跳
const http = require('http'), fs = require('fs'), path = require('path');
// 磁盘素材根目录（虚拟素材仓的兑底）：环境变量 MJ_ASSET_ROOT 或 ./assets
const root = process.env.MJ_ASSET_ROOT || './assets';
// 工具/扩展目录：开发机与服务同目录；安装版 extension/ 在 server/ 下
const TOOL_DIR = __dirname;
const EXT_DIR = fs.existsSync(path.join(TOOL_DIR, 'extension')) ? path.join(TOOL_DIR, 'extension') : TOOL_DIR;
const mime = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.wav':'audio/wav','.mp3':'audio/mpeg','.m4a':'audio/mp4','.txt':'text/plain','.md':'text/markdown','.json':'application/json'};
const AUDIO_RE = /\.(wav|mp3|m4a|aac|ogg|flac|wma)$/i;

/* ---------- 授权：机器码绑定 + 签名授权码（无授权则核心接口全部拒绝） ---------- */
/* 密钥不进仓库：首次运行时本地随机生成 lic-secret.key，每个部署独立一套授权体系 */
const crypto = require('crypto'), os = require('os');
const LIC_SECRET_FILE = path.join(__dirname, 'lic-secret.key');
const LIC_SECRET = (() => {
  try { const s = fs.readFileSync(LIC_SECRET_FILE, 'utf8').trim(); if (s) return s; } catch (e) {}
  const s = crypto.randomBytes(24).toString('hex');
  try { fs.writeFileSync(LIC_SECRET_FILE, s); } catch (e) {}
  return s;
})();
const LIC_FILE = path.join(__dirname, 'license.json');
const machineCode = (() => {
  const macs = [];
  for (const arr of Object.values(os.networkInterfaces()))
    for (const x of arr || []) if (x.mac && x.mac !== '00:00:00:00:00:00') macs.push(x.mac);
  const raw = os.hostname() + '|' + os.userInfo().username + '|' + macs.sort()[0];
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0,12).toUpperCase().replace(/(.{4})(?=.)/g,'$1-');
})();
function licHmac(payload){ return crypto.createHmac('sha256', LIC_SECRET).update(payload).digest('base64url'); }
function verifyLicense(code){
  try {
    code = String(code||'').trim().replace(/\s+/g,'');
    const i = code.lastIndexOf('.');
    if (i < 1) return {ok:false, err:'授权码格式不对'};
    const payload = code.slice(0,i), sig = code.slice(i+1);
    if (licHmac(payload) !== sig) return {ok:false, err:'授权码无效（签名不匹配）'};
    const data = JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
    if (String(data.m||'').toUpperCase() !== machineCode.replace(/-/g,'')) return {ok:false, err:'授权码与这台机器不匹配'};
    if (data.e && new Date(data.e+'T23:59:59') < new Date()) return {ok:false, err:'授权已到期（'+data.e+'）'};
    return {ok:true, name:data.n||'', expiry:data.e||'永久'};
  } catch(e) { return {ok:false, err:'授权码无法解析'}; }
}
let LIC = (()=>{ try { return verifyLicense(fs.readFileSync(LIC_FILE,'utf8')); } catch(e){ return {ok:false}; } })();
function gate(res){ if(!LIC.ok){ send(res,403,{error:'未授权：机器码 '+machineCode+'，请向管理员索取授权码'}); return true; } return false; }
const ACTIVATE_HTML = `<!doctype html><meta charset=utf-8><title>漫剧工作台 · 激活</title>
<body style="font-family:system-ui;background:#1b1f24;color:#e8eaed;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div style="background:#24292f;border:1px solid #3a8ee6;border-radius:14px;padding:32px 36px;width:440px;max-width:92vw">
<h2 style="margin:0 0 6px;color:#3a8ee6">🎬 漫剧直出工作台 · 授权激活</h2>
<p style="font-size:13px;color:#9aa0a6">把下面的机器码发给管理员，索取授权码粘贴到下方。</p>
<div style="background:#1b1f24;border:1px solid #444;border-radius:8px;padding:14px;font-size:26px;letter-spacing:2px;text-align:center;margin:14px 0" id="mc">-</div>
<input id="code" placeholder="粘贴授权码" style="width:100%;box-sizing:border-box;padding:10px;background:#1b1f24;border:1px solid #444;border-radius:8px;color:#e8eaed;font-size:14px">
<div id="msg" style="color:#f28b82;font-size:12px;min-height:18px;margin-top:8px"></div>
<button onclick="act()" style="width:100%;padding:10px;margin-top:6px;background:#3a8ee6;border:0;border-radius:8px;color:#fff;font-size:14px;cursor:pointer">激活</button>
<script>
fetch('/__license/status').then(r=>r.json()).then(s=>{ document.getElementById('mc').textContent=s.machine; });
async function act(){
  const r = await fetch('/__license/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:document.getElementById('code').value})});
  const j = await r.json();
  if(j.ok){ location.reload(); } else { document.getElementById('msg').textContent=j.err||j.error||'激活失败'; }
}
</script></div></body>`;

/* ---------- 安装版工作台目录（加密 .enc 优先，明文兜底=开发机） ---------- */
const WB_DIR = fs.existsSync(path.join(__dirname, 'index.html')) ? __dirname : path.join(__dirname, '..', 'workbench');
function xorBuf(buf){
  const key = Buffer.from('7d3a9f1ce8b24056a1d4f73b09e6c285','hex');
  const out = Buffer.alloc(buf.length);
  for(let i=0;i<buf.length;i++) out[i] = buf[i] ^ key[i % key.length];
  return out;
}
function serveWorkbench(res, file){
  const enc = path.join(WB_DIR, file + '.enc');
  fs.readFile(enc,(e,d)=>{
    if(!e){ res.setHeader('Content-Type', file.endsWith('.js')?'application/javascript; charset=utf-8':'text/html; charset=utf-8'); res.end(xorBuf(d)); return; }
    fs.readFile(path.join(WB_DIR, file),(e2,d2)=>{
      if(e2){ send(res,404,{error:'workbench missing'}); return; }
      res.setHeader('Content-Type', file.endsWith('.js')?'application/javascript; charset=utf-8':'text/html; charset=utf-8');
      res.end(d2);
    });
  });
}

/* ---------- 虚拟素材仓：工作台直传，优先于磁盘 ---------- */
const store = new Map();
/* ---------- 任务队列（内存态） ---------- */
const jobs = []; let jobSeq = 1;
const bridges = {}; // worker -> {worker, platform, pageUrl, models, ts}
const JOB = {
  new(cfg, label) {
    const j = { id: jobSeq++, type: cfg && cfg.type === 'plan' ? 'plan' : 'import',
      cfg: cfg || {}, label: label || (cfg && cfg.type === 'plan' ? '核对规划' : '一键直通'),
      target: (cfg && cfg.target) || null,
      status: 'queued', pct: 0, msg: '排队中', events: [], result: null,
      createdAt: Date.now(), startedAt: null, finishedAt: null, worker: null };
    jobs.push(j); return j;
  },
};

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } });
  });
}
function send(res, code, obj) {
  res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

http.createServer(async (req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','*');
  res.setHeader('Cache-Control','no-store');   // 虚拟仓内容随时变，禁掉浏览器缓存防旧分镜/素材
  if(req.method==='OPTIONS'){ res.end(); return; }
  const p = decodeURIComponent(req.url.split('?')[0]);
  const qs = new URLSearchParams(req.url.split('?')[1] || '');
  const safe = f => path.resolve(f).startsWith(path.resolve(root));

  /* ---------- 授权状态与激活（无需授权即可访问） ---------- */
  if(p === '/__license/status'){
    send(res,200,{ok:LIC.ok, machine:machineCode, name:LIC.name||'', expiry:LIC.expiry||'', err:LIC.err||''}); return;
  }
  if(p === '/__license/activate' && req.method==='POST'){
    const b = await readBody(req);
    const v = verifyLicense(b.code);
    if(!v.ok){ send(res,200,{ok:false, err:v.err}); return; }
    try { fs.writeFileSync(LIC_FILE, String(b.code).trim()); } catch(e) {}
    LIC = v;
    send(res,200,{ok:true, name:v.name, expiry:v.expiry}); return;
  }

  /* ---------- 安装版入口：无授权→激活页；已授权→解密下发工作台 ---------- */
  if(p === '/' || p === '/index.html'){
    if(!LIC.ok){ res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(ACTIVATE_HTML); return; }
    serveWorkbench(res,'index.html'); return;
  }
  if(p === '/mapping-data.js'){
    if(gate(res)) return;
    serveWorkbench(res,'mapping-data.js'); return;
  }

  /* ---------- 健康检查 ---------- */
  if(p === '/__health'){
    const alive = Object.values(bridges).filter(b=>Date.now()-b.ts<20000);
    send(res,200,{ok:true, root, jobs:jobs.length, bridge: alive[0]||null, bridges: alive, ts:Date.now()});
    return;
  }

  /* ---------- 画布桥：心跳（支持多画布同时在线） ---------- */
  if(p === '/__bridge/heartbeat' && req.method==='POST'){
    if(gate(res)) return;
    const b = await readBody(req);
    if(!b.worker){ send(res,200,{ok:false}); return; }
    const prev = bridges[b.worker] || {};
    bridges[b.worker] = { worker:b.worker, platform:b.platform||prev.platform||'未知', pageUrl:b.pageUrl||prev.pageUrl||'',
      models: b.models || prev.models || null, ts: Date.now() };
    send(res,200,{ok:true}); return;
  }
  if(p === '/__bridge' && req.method==='GET'){
    if(gate(res)) return;
    const list = Object.values(bridges).filter(b=>Date.now()-b.ts<20000);
    send(res,200,{alive:list.length>0, bridges:list}); return;
  }

  /* ---------- 任务队列 ---------- */
  if(p === '/__jobs' && req.method==='POST'){
    if(gate(res)) return;
    const b = await readBody(req);
    const j = JOB.new(b.cfg || b, b.label);
    send(res,200,{id:j.id}); return;
  }
  if(p === '/__jobs' && req.method==='GET'){
    if(gate(res)) return;
    send(res,200,{jobs:jobs.map(j=>({...j, events:undefined, eventCount:j.events.length}))}); return;
  }
  const mj = p.match(/^\/__jobs\/(\d+)(\/(next|events|done))?$/);
  if(mj){
    if(gate(res)) return;
    const j = jobs.find(x=>x.id===+mj[1]);
    if(!j){ send(res,404,{error:'no job'}); return; }
    if(mj[3]==='events' && req.method==='POST'){
      const b = await readBody(req);
      j.events.push({ts:Date.now(), pct:b.pct??j.pct, msg:b.msg||''});
      if(b.pct!=null) j.pct=b.pct; if(b.msg) j.msg=b.msg; if(b.status) j.status=b.status;
      send(res,200,{ok:true}); return;
    }
    if(mj[3]==='done' && req.method==='POST'){
      const b = await readBody(req);
      j.status = b.ok ? 'done' : 'failed'; j.result = b.result ?? null; j.pct = 100;
      j.finishedAt = Date.now(); send(res,200,{ok:true}); return;
    }
    send(res,200,{...j, events:j.events}); return;
  }
  if(p === '/__jobs/next' && req.method==='GET'){
    if(gate(res)) return;
    const w = qs.get('worker')||'';
    const j = jobs.find(x=>x.status==='queued' && (!x.target || !x.target.worker || x.target.worker===w));
    if(!j){ send(res,200,{}); return; }
    j.status='running'; j.startedAt=Date.now(); j.worker=w; j.pct=1; j.msg='画布页已领取';
    send(res,200,{job:j}); return;
  }

  /* ---------- 扩展分发：/updates.xml 与 /ext/*（供浏览器策略强制安装） ---------- */
  if(p === '/updates.xml'){
    res.setHeader('Content-Type','text/xml; charset=utf-8');
    res.end(fs.readFileSync(path.join(TOOL_DIR,'extension','updates.xml'))); return;
  }
  if(p.startsWith('/ext/')){
    const name = p.replace('/ext/','').replace(/^\/+/, '');
    if(!/^[\w.-]+$/.test(name)){ send(res,400,{error:'bad name'}); return; }
    fs.readFile(path.join(EXT_DIR, name),(e,d)=>{
      if(e){ send(res,404,{error:'not found'}); return; }
      res.setHeader('Content-Type', name.endsWith('.crx')?'application/x-chrome-extension':'application/octet-stream');
      res.end(d);
    });
    return;
  }

  /* ---------- 虚拟素材仓：工作台直传 ---------- */
  if(p === '/__store/md' && req.method==='POST'){
    if(gate(res)) return;
    const b = await readBody(req);
    const nm = String(b.name||'分镜.md').replace(/[\\/]/g,'_');
    store.set('4-文本/'+nm, Buffer.from(String(b.text||''), 'utf8'));
    send(res,200,{ok:true, path:'4-文本/'+nm}); return;
  }
  if(p === '/__store/mapping' && req.method==='POST'){
    if(gate(res)) return;
    const b = await readBody(req);
    store.set('4-文本/mapping-data.js', Buffer.from(String(b.text||'window.MJ_MAPPING={};'), 'utf8'));
    send(res,200,{ok:true}); return;
  }
  if(p === '/__store/asset' && req.method==='POST'){
    if(gate(res)) return;
    const dir = qs.get('dir')||'2-道具', name = (qs.get('name')||'').replace(/[\\/]/g,'_');
    if(!name){ send(res,400,{error:'missing name'}); return; }
    const chunks=[]; req.on('data',c=>chunks.push(c));
    req.on('end',()=>{ store.set(dir+'/'+name, Buffer.concat(chunks)); send(res,200,{ok:true, path:dir+'/'+name}); });
    return;
  }
  if(p === '/__store' && req.method==='GET'){
    const items={}; for(const k of store.keys()) items[k]=store.get(k).length;
    send(res,200,{count:store.size, items}); return;
  }
  if(p === '/__store/clear' && req.method==='POST'){
    if(gate(res)) return;
    const n = store.size; store.clear();
    send(res,200,{ok:true, cleared:n}); return;
  }

  /* ---------- 工具脚本分发 ---------- */
  if(p.startsWith('/__tool/')){
    if(gate(res)) return;
    const name = p.replace('/__tool/','').replace(/^\/+/, '');
    if(!/^[\w.-]+\.js$/.test(name)){ send(res,400,{error:'bad name'}); return; }
    fs.readFile(path.join(TOOL_DIR, name),(e,d)=>{
      if(e){ send(res,404,{error:'tool not found: '+name}); return; }
      res.setHeader('Content-Type','application/javascript; charset=utf-8');
      res.end(d);
    });
    return;
  }

  /* ---------- 目录清单：虚拟仓 + 磁盘合并（虚拟优先） ---------- */
  if(p.startsWith('/__list/')){
    if(gate(res)) return;
    const dir = p.replace('/__list/','').replace(/^\/+/,'');
    const full = path.join(root, dir);
    const vFiles = new Map();
    const vpfx = dir + '/';
    for(const k of store.keys()){ if(k.startsWith(vpfx)){ vFiles.set(k.slice(vpfx.length), {name:k.slice(vpfx.length), isAudio:AUDIO_RE.test(k), virtual:true}); } }
    fs.readdir(full,{withFileTypes:true},(e,ents)=>{
      const dFiles = e ? [] : ents.filter(x=>x.isFile()).map(x=>({name:x.name, isAudio:AUDIO_RE.test(x.name)}));
      const merged = [...vFiles.values()];
      for(const f2 of dFiles){ if(!vFiles.has(f2.name)) merged.push(f2); }
      send(res,200,{dir, files:merged});
    });
    return;
  }

  /* ---------- 文件：虚拟仓优先 ---------- */
  const relP = p.replace(/^\//, '');
  if(gate(res)) return;
  if(store.has(relP)){
    const buf = store.get(relP);
    res.setHeader('Content-Type', mime[path.extname(relP).toLowerCase()]||'application/octet-stream');
    res.end(buf); return;
  }

  const f = path.join(root, p);
  if(!safe(f)){ send(res,403,{error:'forbidden'}); return; }
  fs.readFile(f,(e,d)=>{
    if(e){ send(res,404,{error:'not found'}); return; }
    res.setHeader('Content-Type', mime[path.extname(f).toLowerCase()]||'application/octet-stream');
    res.end(d);
  });
}).listen(8899, ()=>console.log('asset server v2.3 on http://localhost:8899'));
