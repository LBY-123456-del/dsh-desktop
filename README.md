# dsh-desktop · DeepSeek Harness 桌面端

把 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 的 Web GUI 装进一个原生窗口：双击即用，不用记命令、不用管端口、不用留在浏览器标签页里。

**它不重新实现界面。** 界面就是 `dsh --profile web` 提供的那一份 Web GUI——皮肤、插件、会话、模型设置全部照旧，桌面端只做三件事：把本机已装的 dsh 服务拉起来、用一个原生窗口把它装进去、在退出时把服务收干净。

## 快速开始

```powershell
git clone https://github.com/LBY-123456-del/dsh-desktop.git
cd dsh-desktop
npm install
npm start           # 正常启动
npm run dev         # 启动并自动打开开发者工具
```

前提：本机已装 **Node.js ≥ 20** 与 **`@deepseek-ai/dsh`**（`npm i -g @deepseek-ai/dsh`）。桌面端不内置 dsh，它复用你现有的那份安装，所以 `~/.dsh` 下的 profile、插件、皮肤、凭据、会话记录与命令行用法完全共用。

## 打包成 exe

```powershell
npm run dist        # 产出 NSIS 安装包 + 免安装 portable exe，位于 dist/
npm run dist:dir    # 只出解包目录，调试打包问题用
```

打包产物仍然需要目标机器上有 Node.js 与 dsh——桌面端是外壳，不是自带一切的分发版。

### 免安装版的坑：它会复用 %TEMP% 里的旧解包

portable exe 运行时先把自己解包到 `%TEMP%\<随机名>\` 再启动，而 **electron-builder 不会在目标目录已存在时重新解包**。后果是：你重新构建出新版本后，双击 portable 仍然跑的是上一次的解包内容——图标、界面、逻辑全是旧的，且没有任何提示。

实测踩过一次：解包目录里文件时间戳停留在旧构建，而新 portable 里已经换好了图标，两者不一致才定位到。

处理方式任选：

```powershell
# 1) 关掉所有实例后删掉旧解包（名字每次构建可能不同，按修改时间找）
Get-ChildItem $env:TEMP -Directory | Where-Object { Test-Path "$($_.FullName)\DeepSeek Harness.exe" } | Remove-Item -Recurse -Force

# 2) 更省事：迭代测试直接用解包目录，它不自我解包，永远是你刚构建的那份
.\dist\win-unpacked\'DeepSeek Harness.exe'
```

要长期分发就用 NSIS 安装包（`*-setup.exe`），它装到固定目录，不存在这层复用。

### 不打断正在运行的版本：旁路构建 + 换入

打包产物默认写进 `dist\`，而 `dist\win-unpacked\` 里很可能正是你此刻开着的那一份——**运行中的 exe 无法被覆盖**，直接打包会失败。迭代时改成旁路构建，产物落到别处，确认没问题后再换进去：

```powershell
# 1) 旁路构建（不碰 dist）
.\node_modules\.bin\electron-builder.cmd --win --dir '-c.directories.output=..\.dsh-desktop-build'

# 2) 完全退出桌面版后，双击 apply-fix.cmd：完成换入并启动新版本
```

`apply-fix.cmd` 带安全闸：**检测到 `DeepSeek Harness.exe` 还在跑就拒绝执行**，并列出残留 PID，所以不会误操作把安装弄坏。换入过程先把新版本整份拷进 `win-unpacked.new`，再改名就位（同卷改名，瞬间完成），任何一步失败都不会留下半成品；旧版本留档为 `win-unpacked.previous`，确认新版本无误后可以删掉。

注意桌面版有单实例锁（`app.requestSingleInstanceLock()`），所以新旧两份**不能同时开着**做对比——换入前必须先关掉旧的。

## 它怎么找到 dsh

按优先级：

1. 配置文件里的 `dshEntry` / `nodePath`
2. 环境变量 `DSH_DESKTOP_DSH` / `DSH_DESKTOP_NODE`
3. `PATH` 上的 `dsh` / `node` shim（`where dsh`、`command -v dsh`）
4. 各包管理器的已知全局根目录：npm 全局、pnpm global、nvm / nvm-windows、Volta、`/usr/local`、Homebrew、fnm

Node 运行时**刻意不复用 Electron 自带的那个**：dsh 依赖 node-pty、koffi、sharp 等原生模块，它们按 Node 的 ABI 预编译，而 Electron 的 ABI 不同。

## 服务的三种归宿

启动时先探测配置的端口：

| 探测结果 | 行为 |
|---|---|
| 端口空闲 | **另起**：以 `--profile web --no-open --port <port>` 拉起，桌面端持有 token，退出时回收整棵进程树 |
| 端口上跑着旧版 dsh（无鉴权门） | **复用**：直接连上去，不另起进程，退出时也不动它 |
| 端口上跑着 dsh ≥ 0.1.5 | **接管不了，另起**：见下节 |
| 端口被别的程序占用 | **换端口**：退到系统分配的端口，并在状态页说明这件事 |

探测和真正 `listen` 之间永远有窗口：探测那一刻没人应答，不等于 dsh 随后 bind 得上——刚退出的进程可能把端口留在 TIME_WAIT 上，别的程序也可能恰好插进来。dsh 因此带着 `listen EADDRINUSE` 在就绪前退出时，桌面端会换一个空闲端口重试，**最多 3 次**；**非端口类错误一律原样上抛**，不会被误当成端口问题反复重试。

这条兜底来自一次真实故障（2026-09-17 22:50:56）：探测判定 3080 空闲，dsh 真正 listen 时却拿到 `EADDRINUSE` 并当场崩溃，用户看到的是一张说不清原因的致命错误页。

复用那条路顺带解决了一个隐性问题：Web GUI 的主题、皮肤定制项等设置存在浏览器 localStorage 里，而 localStorage 按 origin（也就是端口）隔离。默认端口固定为 3080，所以重启桌面端之后界面设置还在；只有端口被迫改变时才会与你之前的选择分家。

### dsh ≥ 0.1.5 的 token 鉴权门（重要）

从 0.1.5 起，dsh 给浏览器界面加了鉴权门：

```
GET /                 → 401  dsh web authentication required; reopen the URL printed by dsh web.
GET /?token=<token>   → 303  Location: /  +  Set-Cookie: dsh-auth-<hash>=v1...
```

`dsh web` 打印的 URL 因此变成 `http://127.0.0.1:3080/?token=...`，**必须先访问一次这个带 token 的地址换取 cookie，才能进界面**。

官方 README 写明：*Each process mints a random launch token.* —— **token 是每个 dsh 进程自己随机生成的**。这带来两个后果：

1. **桌面端无法复用别人启动的 dsh 服务**。它拿不到那个进程的 token，也就进不去那个界面。此时桌面端会另起一个自己的服务（因此端口通常不是 3080），并在状态页说明原因。
   - 想让桌面端回到 3080（并沿用你原来的界面设置），**先关掉那个 dsh 服务**，再启动桌面端。
2. 桌面端自己拉起的服务不受影响：它从 stdout 抓到带 token 的地址，窗口加载该地址换取 cookie 后正常进界面；「在浏览器中打开 / 复制服务地址」给出的也是带 token 的地址（这是新版本下唯一能进界面的地址）。

探测逻辑不能再看首页 HTML 认人（不带 token 永远拿不到首页），改为识别 401 鉴权文本与 303 + `dsh-auth-` cookie；就绪判定也必须接受 303，否则自己刚拉起来的服务会被误判为「探测未通过」。

## 配置

配置文件在 Electron 的 userData 目录：

```
%APPDATA%\dsh-desktop\config.json        # Windows
```

```jsonc
{
  "profile": "web",              // 要启动的 dsh profile
  "host": "127.0.0.1",           // dsh web 的绑定主机（仅回环）
  "port": 3080,                  // 0 = 让系统分配
  "nodePath": null,              // 显式指定 node 可执行文件
  "dshEntry": null,              // 显式指定 dsh 入口（lib/bin.js 或其包目录）
  "workingDirectory": null,      // dsh 服务的工作目录，null = 用户主目录
  "extraArgs": [],               // 追加给 dsh web 的参数
  "adoptExternalServer": true,   // 端口上的现成 dsh 直接复用
  "openDevTools": false,
  "window": { "width": 1440, "height": 920, "x": null, "y": null, "maximized": false }
}
```

配置文件损坏时会自动改名备份为 `config.json.corrupt` 并用默认值继续启动。「服务 → 选择工作目录…」会写回 `workingDirectory` 并重启服务。

本次运行的环境变量覆盖（不写回磁盘）：

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_PORT` | 覆盖端口 |
| `DSH_DESKTOP_HOST` | 覆盖绑定主机 |
| `DSH_DESKTOP_PROFILE` | 覆盖 profile |
| `DSH_DESKTOP_NODE` | 覆盖 Node 路径 |
| `DSH_DESKTOP_DSH` | 覆盖 dsh 入口 |
| `DSH_DESKTOP_CWD` | 覆盖工作目录 |
| `DSH_DESKTOP_ADOPT` | `0` 表示不复用端口上的现成服务 |
| `DSH_DESKTOP_USER_DATA` | 重定向配置目录（冒烟测试隔离用） |
| `DSH_HOME` | dsh 主目录（由 dsh 自己读取） |

## 菜单

- **文件**：在浏览器中打开（`Ctrl+Shift+O`）、复制服务地址、退出
- **服务**：重启 dsh 服务（`Ctrl+Shift+R`）、选择工作目录…、打开服务日志、打开配置目录、打开 DSH 主目录
- **视图**：重新加载、强制重新加载、开发者工具、缩放、全屏
- **帮助**：关于（含当前 Node / dsh / 服务地址等诊断信息）

界面里的外部链接一律交给系统默认浏览器打开；同源的新窗口（皮肤或插件的预览页）留在应用内。

## 冒烟测试

无人值守地验证「定位 → 拉起服务 → 加载界面 → 渲染完成」这条链路，并截图存档：

```powershell
$env:DSH_HOME="$env:TEMP\dsh-smoke-home"      # 用临时主目录，不碰真实会话数据
$env:DSH_DESKTOP_USER_DATA="$env:TEMP\dsh-desktop-smoke"
$env:DSH_DESKTOP_PORT="0"
$env:DSH_DESKTOP_ADOPT="0"
npm run smoke -- --smoke-shot=./.smoke/spawn.png --smoke-hold=6000
```

成功时输出 `SMOKE OK url=... screenshot=...` 并以退出码 0 结束；失败时打印失败原因与服务日志末尾，退出码 1，截图仍然留存。

截图之外还会打印一行 `SMOKE FACTS {...}`：DOM 节点数、`#root` 子节点数、`/plugins/` 脚本数、按钮与输入框数量，以及界面前 120 个字的文本。这是给「看不到窗口的自动化环境」用的证据——截图只能证明画出来了，facts 能证明画的是 dsh 界面而不是一张白页。

### 回归测试

端口重试逻辑有一条不依赖 Electron 的回归测试：

```powershell
npm test        # 等价于 node .smoke/port-retry-test.js
```

它把 `spawn` 换成桩，直接验证三条不变式：① 第一次占端口失败 → 换端口重试成功；② 非端口错误只调一次、原样上抛；③ 一直占端口 → 到上限 3 次就停。成功打印 `PORT RETRY TEST OK {...}` 并以退出码 0 结束。

## 目录结构

```
src/main.js       Electron 主进程：窗口、菜单、生命周期、启动编排、冒烟测试
src/server.js     dsh web 服务生命周期：探测 / 复用 / 拉起 / 就绪判定 / 进程树回收
src/locate.js     定位本机 Node 与 dsh 入口
src/config.js     配置默认值、环境变量覆盖与持久化
src/preload.js    桥接：只暴露状态查询、重试、打开日志/目录、退出
src/status.html   启动中与失败时的状态页
src/assets/icon.png   窗口图标与状态页图案（生成物）
tools/make-icon.js    图标生成器：从萌宠立绘裁剪，兜底程序化绘制
apply-fix.ps1         换入脚本：把旁路构建的版本换进 dist\win-unpacked（带安全闸）
apply-fix.cmd         上面那个脚本的双击外壳（会自己找 pwsh，找不到就用 powershell）
.smoke/port-retry-test.js  端口重试的回归测试（npm test）
build/icon.ico        打包用多尺寸图标（生成物）
NOTICE                图标素材的署名与许可
```

图标是算出来的，不是画出来的。默认素材是 Web 界面右下角那只可点击萌宠的本体立绘（来自 `dsh-whale-widget` 包的 `assets/DSniang1.png`，抠图透明底）：

```powershell
node tools\make-icon.js                          # 从萌宠立绘生成（默认）
node tools\make-icon.js --mode tile              # 萌宠放在深海底色圆角方块上
node tools\make-icon.js --source .\my-art.png    # 换一张素材
node tools\make-icon.js --candidates .\.smoke    # 额外产出候选图供挑选
```

找不到素材或找不到图像处理库（sharp）时会自动退回程序化绘制，克隆本项目的人不装任何东西也能生成可用图标。`build/icon.ico` 是**多尺寸**的（16/24/32/48/64/128/256），每个尺寸单独缩放——只放一张 256 交给 Windows 缩到任务栏尺寸，角色立绘会糊。

素材署名与许可见 [`NOTICE`](NOTICE)：萌宠立绘来自 MIT 许可的 `dsh-whale-widget`，但其角色形象的上游创作链（上善 → zipzip）该包未声明，对外分发前需确认。


## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 状态页提示「找不到本机的 dsh 安装」 | 先 `npm i -g @deepseek-ai/dsh`；或在 `config.json` 里把 `dshEntry` 指向 dsh 的 `lib/bin.js` |
| 状态页提示「找不到可用的 Node.js 运行时」 | 装 Node.js LTS（https://nodejs.org/），或在 `config.json` 里设置 `nodePath` |
| 提示端口被占用 | 桌面端会自动换端口并说明；想让固定端口恢复，先关掉占用它的程序 |
| 皮肤/插件不生效 | 桌面端用的是同一个 `~/.dsh`，先在浏览器里确认皮肤配置正常；新增或删除插件包需要重启服务（菜单「服务 → 重启 dsh 服务」） |
| 界面设置（主题、皮肤选项）重启后丢了 | 说明本次端口被迫变了，origin 因而不同 |
| 服务反复启动失败 | 菜单「服务 → 打开服务日志」，或直接看状态页底部的日志末尾 |
