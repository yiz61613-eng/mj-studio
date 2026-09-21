// 安装版启动器：把加密的 server.dat 解密到内存执行（磁盘上无明文服务代码）
const fs = require('fs'), path = require('path'), vm = require('vm'), Module = require('module');
const KEY = Buffer.from('7d3a9f1ce8b24056a1d4f73b09e6c285', 'hex');
function dec(f) {
  const b = fs.readFileSync(path.join(__dirname, f));
  const o = Buffer.alloc(b.length);
  for (let i = 0; i < b.length; i++) o[i] = b[i] ^ KEY[i % KEY.length];
  return o;
}
const m = new Module('asset-server');
m.filename = path.join(__dirname, 'asset-server.js');
m.paths = Module._nodeModulePaths(__dirname);
m._compile(dec('server.dat').toString('utf8'), m.filename);
