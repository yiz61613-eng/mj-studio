// 构建期加密：server.js / 工作台 → XOR 加密 payload（与 boot.js、asset-server 内 xorBuf 同 key）
const fs=require('fs'), path=require('path');
const ROOT = process.env.MJ_ROOT || require('path').resolve(__dirname, '..');   // 本机路径不入库，需要时用环境变量指定
const KEY=Buffer.from('7d3a9f1ce8b24056a1d4f73b09e6c285','hex');
function enc(src,dst){
  const b=fs.readFileSync(src); const o=Buffer.alloc(b.length);
  for(let i=0;i<b.length;i++) o[i]=b[i]^KEY[i%KEY.length];
  fs.mkdirSync(path.dirname(dst),{recursive:true}); fs.writeFileSync(dst,o);
  console.log('enc →',dst,o.length,'bytes');
}
enc(path.join(ROOT,'asset-server.js'), path.join(ROOT,'installer','payload','server.dat'));
enc(path.join(ROOT,'index.html'),      path.join(ROOT,'installer','payload','index.enc'));
enc(path.join(ROOT,'mapping-data.js'), path.join(ROOT,'installer','payload','mapping.enc'));
