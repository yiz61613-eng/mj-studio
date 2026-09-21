# 漫剧直出工作台（AI Comic Studio Workbench）

面向 AI 漫剧生产流水线的本地工作台：**导入分镜 Markdown → 资产自动分类挂载 → 画布（Runroll / UpDream）批量建节点并自动挂参考**。生成按钮永远由人自己点，工具只负责把素材和节点摆好。

> 适用场景：你有一条「分镜 → 参考图 → 视频生成」的内容流水线，手动在画布网站上逐个建节点、传素材、连参考太慢——本工具把这一步压缩成一次点击。

## 功能

- **分镜解析**：识别 `【本段时长：N秒】【段号】` 格式的 Markdown，一段 = 一个视频节点
- **资产库**：拖入素材包自动按人物/场景/道具/音频分类，支持同一角色多套服装（变体）
- **自动挂载**：按分镜号、出场角色、场景映射表自动把参考图/音频挂到节点
- **画布直通**：通过浏览器扩展桥接 Runroll / UpDream 画布页，批量创建视频节点、上传素材、连参考线（2980+ 连线实测）
- **多画布 / 多模型**：自动识别在线画布与平台支持的模型列表（能力×模式），按分镜时长选档
- **授权体系**：机器码绑定 + 签名授权码（可选），管理员离线签发，防拆解分发

## 架构

```
工作台 index.html（纯前端，IndexedDB 存资产）
   │  HTTP (localhost:8899)
   ▼
asset-server.js（Node 本地服务：任务队列 / 虚拟素材仓 / 授权闸门）
   │  /__jobs 任务队列
   ▼
浏览器扩展（MV3，注入 Runroll / UpDream 画布页）
   └─ rb-core.js + 平台适配器 → 调用画布页面 API 建节点/连线/上传
```

- `asset-server.js`：本地素材服务 + 任务队列 + 授权。素材优先从工作台直传的虚拟仓读取，其次读磁盘素材目录
- `rb-core.js`：平台无关核心（解析/规划/上传/建节点）
- `rb-adapter-runroll.js` / `rb-adapter-updream.js`：平台适配器；`rb-adapter-generic.js` 为兜底
- `rb-any.user.js`：油猴脚本版桥（不想装扩展时的替代方案）
- `installer/`：自包含安装器工程（C#，内嵌 Node + 服务 + 工作台 + 扩展，见 `installer/build-installer.ps1`）

## 快速开始（开发方式）

1. 安装 Node.js ≥ 18
2. 启动服务：`node asset-server.js`（或双击 `start.bat`）
3. 浏览器（Edge/Chrome）打开工作台 `index.html`
4. `edge://extensions` → 开发人员模式 → **加载解压缩的扩展** → 选 `extension/` 文件夹
5. 在浏览器打开 Runroll / UpDream 画布页并登录
6. 工作台右上角「🌉 画布直通」→ 选画布 → 模型自动识别 → ⚡ 一键直通

分镜格式（一段一个节点）：

```markdown
【本段时长：15秒】【12-1-1】
[镜头1] 角色A走进房间……
```

映射表（可选，用于精确匹配场景与角色服装资产）：参考 `mapping-data.sample.js`，把自己的数据存为 `mapping-data.js` 放在工作台目录。

## 快速开始（打包安装器，给同事用）

```powershell
cd installer
powershell -ExecutionPolicy Bypass -File build-installer.ps1
```

产出单个自包含 EXE（内嵌 Node 运行时 + 服务 + 工作台 + 扩展）。安装后：

- 服务开机自启（静默）
- Edge/Chrome 重启后扩展自动出现（开发者模式加载，详见下方授权一节）
- 桌面出现工作台快捷方式

## 授权体系（可选）

每个部署首次运行时自动生成独立密钥 `lic-secret.key`（不进仓库）。启用授权后：

1. 未授权机器的核心接口全部 403，入口只显示激活页
2. 用户把屏幕上的**机器码**（`XXXX-XXXX-XXXX`）发给管理员
3. 管理员打开 `installer/授权签发工具-仅管理员.html`，粘贴对方 `lic-secret.key` 内容 + 机器码，生成授权码（可设到期日）
4. 用户粘贴授权码激活

不需要授权控制的话，删掉 `asset-server.js` 里的 `gate()` 调用即可。

## 注意事项

- **生成按钮永远由你自己点**：工具只建节点和参考，不碰任何会产生费用的按钮
- 素材与分镜数据（`mapping-data.js`）各自维护，不入库；`mapping-data.sample.js` 是格式样例
- 浏览器扩展只注入 `runroll.cn` / `updream.cn`，其他页面不运行
- MV3 环境禁止 `eval`，核心代码已全部改用 JSON.parse

## License

[MIT](LICENSE)
