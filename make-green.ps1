# 打包绿色版（显式白名单 + 每份拷贝嵌入溯源水印）
# 用法：powershell -File make-green.ps1 [-For "同事名"]
# 产物：dist\MjStudio-绿色版-<tag>.zip；台账见 installer\dist-ledger.json（不入库）
param([string]$For = '未登记')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = $PSScriptRoot   # make-green.ps1 在仓库根目录；不用 MJ_ROOT（环境残留会带偏）
$ins = Join-Path $root 'installer'
$tag = 'G' + (Get-Date -Format 'yyyyMMdd-HHmm') + '-' + (-join (1..4 | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) }))
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'

$name='mj-green-stage-'+[guid]::NewGuid().ToString('N')
$stage=Join-Path $env:TEMP $name
New-Item -ItemType Directory -Path (Join-Path $stage 'extension') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage 'node') -Force | Out-Null
'index.html','mapping-data.js','asset-server.js','start-server-hidden.vbs','start.bat','start-local.bat' | ForEach-Object { Copy-Item (Join-Path $root $_) (Join-Path $stage $_) -Force }
Copy-Item (Join-Path $root 'node\node.exe') (Join-Path $stage 'node\node.exe') -Force
Get-ChildItem (Join-Path $root 'extension') -File | Where-Object { $_.Name -ne 'extension.pem' } | Copy-Item -Destination (Join-Path $stage 'extension') -Force

# 绿色版 vbs 便携化：不带走机器的写死路径——工作目录/素材根 = vbs 所在目录，node = 包内 node\
$vbsText = @'
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Environment("PROCESS")("MJ_ASSET_ROOT") = dir & "\"
sh.Run "cmd /c """ & dir & "\node\node.exe"" asset-server.js >> server-log.txt 2>&1", 0, False
'@
[IO.File]::WriteAllText((Join-Path $stage 'start-server-hidden.vbs'), $vbsText, [Text.Encoding]::ASCII)

# 溯源水印：内嵌在 mapping-data.js 末尾的无注释 base64 常量（平时不可见；需要溯源时解开即得 tag/接收人/时间）
$wm=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("MJWM|$tag|$For|$stamp"))
Add-Content -Path (Join-Path $stage 'mapping-data.js') -Value "`n;window.MJ_MAPPING_WM='$wm';" -Encoding UTF8

# 敏感文件防线
$bad = Get-ChildItem $stage -Recurse -File | Where-Object { $_.Name -match '\.pem$|^lic-secret\.key$|^license\.json$' }
if($bad){ throw 'staging 出现敏感文件：' + ($bad.FullName -join ',') }

$zipTmp=Join-Path $env:TEMP ('MjStudio-green-'+[guid]::NewGuid().ToString('N')+'.zip')
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipTmp -Force
$final = Join-Path $root ('dist\MjStudio-绿色版-'+$tag+'.zip')
New-Item -ItemType Directory -Force (Join-Path $root 'dist') | Out-Null
Move-Item $zipTmp $final -Force

# 台账
$ledgerFile = Join-Path $ins 'dist-ledger.json'
$entry=[ordered]@{ tag=$tag; for=$For; artifact=('dist\MjStudio-绿色版-'+$tag+'.zip'); date=$stamp }
$ledger=@()
if(Test-Path $ledgerFile){ try { $ledger = @(Get-Content $ledgerFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { $ledger=@() } }
$ledger += [pscustomobject]$entry
$ledger | ConvertTo-Json -Depth 4 | Out-File -FilePath $ledgerFile -Encoding UTF8

"tag: $tag (for: $For)"
Get-Item $final | Select-Object FullName,Length
