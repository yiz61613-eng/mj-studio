# 编译自包含安装器（embed 全部文件 → 单个 EXE）
# 用法：在 installer 目录 powershell -File build-installer.ps1
$ErrorActionPreference='Stop'
$root = $env:MJ_ROOT; if(-not $root){ $root = Split-Path -Parent $PSScriptRoot }   # 仓库根目录，本机绝对路径不入库
$ins=Join-Path $root 'installer'
$csc='C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

# 1) 加密 payload（server.dat / index.enc / mapping.enc）
node (Join-Path $ins 'enc.js')
if($LASTEXITCODE -ne 0){ throw 'enc.js failed' }

$res=@()
$res += "/resource:`"$root\node\node.exe`",MjStudio.node.exe"
$res += "/resource:`"$ins\payload\server.dat`",MjStudio.server.dat"
$res += "/resource:`"$ins\boot.js`",MjStudio.boot.js"
$res += "/resource:`"$ins\payload\index.enc`",MjStudio.workbench.index.enc"
$res += "/resource:`"$ins\payload\mapping.enc`",MjStudio.workbench.mapping.enc"
foreach($f in @('extension.crx','updates.xml','manifest.json','background.js','rb-core.js','rb-adapter-runroll.js','rb-adapter-updream.js','rb-content-bridge.js')){
  $res += "/resource:`"$root\extension\$f`",MjStudio.ext.$f"
}

# node.exe 先拷到 root\node 供嵌入
New-Item -ItemType Directory -Force (Join-Path $root 'node') | Out-Null
Copy-Item 'C:\Program Files\nodejs\node.exe' (Join-Path $root 'node\node.exe') -Force

& $csc /nologo /target:winexe /out:"$ins\漫剧直出工作台-安装程序.exe" /win32manifest:"$ins\app.manifest" /r:System.Windows.Forms.dll $res "$ins\install.cs"
if($LASTEXITCODE -eq 0){ Get-Item "$ins\漫剧直出工作台-安装程序.exe" | Select-Object Name,Length } else { 'COMPILE FAILED' }
