'use strict';
/**
 * DeepSeek Harness 桌面端主进程。
 *
 * 职责边界很清楚：**它不实现任何界面**。界面仍然是 `dsh --profile web` 提供的
 * 那份 Web GUI（皮肤、插件、会话全部照旧），桌面端只负责把本机的 dsh 服务拉
 * 起来、用一个原生窗口把它装进去，并在两者之间补上桌面该有的东西：单实例、
 * 退出回收、外链外部浏览器打开、窗口几何记忆、启动/失败状态页。
 * @module dsh-desktop/main
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, shell } = require('electron');

// userData 重定向必须发生在 app ready 之前，冒烟测试靠它隔离配置。
if (process.env.DSH_DESKTOP_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.DSH_DESKTOP_USER_DATA));
}

const { ConfigStore } = require('./config');
const { DshServer } = require('./server');
const { LocateError } = require('./locate');

const argv = process.argv.slice(1);
const DEV = argv.includes('--dev');
const smokeArg = argv.find((arg) => arg === '--smoke' || arg.startsWith('--smoke='));
const SMOKE = smokeArg !== undefined;
const SMOKE_SHOT = argv.find((arg) => arg.startsWith('--smoke-shot='))?.slice('--smoke-shot='.length);
const SMOKE_HOLD = Number(argv.find((arg) => arg.startsWith('--smoke-hold='))?.slice('--smoke-hold='.length) ?? 3000);
const SMOKE_EXIT_DELAY = Number(process.env.DSH_DESKTOP_SMOKE_EXIT_DELAY ?? 0);

/** 应用运行状态，单一事实来源；状态页靠它渲染。 */
const state = {
  store: null,
  server: null,
  window: null,
  logFile: null,
  url: null,
  status: { phase: 'boot', text: '准备启动…', detail: null },
  fatal: null,
  booting: false,
  quitReady: false,
};

function snapshot() {
  return {
    phase: state.status.phase,
    text: state.status.text,
    detail: state.status.detail,
    url: state.url,
    fatal: state.fatal,
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    paths: { logFile: state.logFile, configFile: state.store?.file ?? null, dshHome: dshHomePath() },
  };
}

function broadcast() {
  const win = state.window;
  if (win && !win.isDestroyed()) win.webContents.send('desktop:state', snapshot());
}

function setStatus(phase, text, detail = null) {
  state.status = { phase, text, detail };
  broadcast();
}

/** dsh 的主目录（与 dsh-home-paths 的解析规则一致：`$DSH_HOME` 优先，其次 `~/.dsh`）。 */
function dshHomePath() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), '.dsh');
}

/**
 * 把退出码转成给人看的形式。
 *
 * Windows 上被强杀的进程报的是无符号的 4294967295 这类值，直接显示只会让人困惑；
 * 转回有符号（-1）更贴近「被外部结束了」这个事实。
 * @param code - Node 给出的退出码。
 * @returns 可显示的字符串。
 */
function formatExitCode(code) {
  if (typeof code !== 'number') return '未知';
  return String(code > 0x7fffffff ? code - 0x100000000 : code);
}

/** 判断一个地址是否仍属于当前的 dsh 服务 origin。 */
function isAppUrl(target) {
  if (state.url === null) return false;
  try {
    return new URL(target).origin === new URL(state.url).origin;
  } catch {
    return false;
  }
}

function createWindow() {
  const geometry = state.store.data.window;
  const win = new BrowserWindow({
    width: geometry.width,
    height: geometry.height,
    x: geometry.x ?? undefined,
    y: geometry.y ?? undefined,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#10131c',
    title: 'DeepSeek Harness',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  state.window = win;

  if (geometry.maximized) win.maximize();

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });

  // 窗口标题交给 Web GUI 自己的文档标题，但要带上产品名前缀。dsh 的界面标题本身
  // 已经可能带 "— DeepSeek Harness"（例如「<会话名> — DeepSeek Harness」），
  // 所以先判重再拼，否则会出现后缀叠后缀。
  win.on('page-title-updated', (event) => {
    event.preventDefault();
    const title = win.webContents.getTitle();
    if (!title) {
      win.setTitle('DeepSeek Harness');
      return;
    }
    win.setTitle(title.includes('DeepSeek Harness') ? title : `${title} — DeepSeek Harness`);
  });

  // 同源开新窗口（例如皮肤/插件的预览页）留在应用内；外部链接交给系统浏览器。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1200,
          height: 820,
          backgroundColor: '#10131c',
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // 页面内的整页跳转若离开服务 origin，同样外抛，避免窗口被导航到别处。
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    state.fatal = { message: `界面渲染进程异常退出（${details.reason}）。`, hint: '点击「重启服务」重新加载界面。', log: state.server ? state.server.tail(15) : [] };
    showStatusPage();
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 是我们自己打断的导航
    state.fatal = {
      message: `界面加载失败：${errorDescription}（${String(errorCode)}）`,
      hint: `目标地址：${validatedURL}\n请确认 dsh 服务仍在运行。`,
      log: state.server ? state.server.tail(15) : [],
    };
    showStatusPage();
  });

  const rememberGeometry = () => {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const bounds = maximized ? win.getNormalBounds() : win.getBounds();
    state.store.update({ window: { ...bounds, maximized } });
  };
  win.on('close', rememberGeometry);

  win.on('closed', () => {
    state.window = null;
  });

  void win.loadFile(path.join(__dirname, 'status.html'));
  return win;
}

/** 把窗口切回状态页（启动中或出错的画面）。 */
function showStatusPage() {
  const win = state.window;
  if (!win || win.isDestroyed()) return;
  if (win.webContents.getURL().startsWith('file:')) {
    broadcast();
    return;
  }
  win.webContents.once('did-finish-load', broadcast);
  void win.loadFile(path.join(__dirname, 'status.html'));
}

/**
 * 启动服务并把界面切过去。失败时留在状态页并展示诊断。
 * @param options - `{ restart }` 用于区分首次启动与手动重启。
 */
async function boot({ restart = false } = {}) {
  if (state.booting) return;
  state.booting = true;
  state.fatal = null;
  try {
    if (restart) {
      setStatus('restart', '正在重启 dsh 服务…');
      await state.server.restart();
    } else {
      await state.server.start();
    }
    const url = state.server.url;
    state.url = url;
    setStatus('load', '正在加载界面…', url);
    const win = state.window;
    if (!win || win.isDestroyed()) return;
    await win.loadURL(url);
    setStatus('ready', '就绪', url);
    if (state.store.data.openDevTools) win.webContents.openDevTools({ mode: 'detach' });
  } catch (error) {
    reportFailure(error);
  } finally {
    state.booting = false;
  }
}

/** 把一次启动失败翻译成状态页能展示的结构。 */
function reportFailure(error) {
  const isLocate = error instanceof LocateError;
  const message = error instanceof Error ? error.message : String(error);
  const hint = (error && typeof error === 'object' && 'hint' in error && error.hint) || null;
  const log = state.server ? state.server.tail(25) : [];
  state.fatal = { message, hint, log, kind: isLocate ? 'locate' : 'server' };
  console.error(`[dsh-desktop] 启动失败：${message}`);
  setStatus('error', message, hint);
  showStatusPage();
}

async function restartServer() {
  if (state.booting) return;
  state.fatal = null;
  await boot({ restart: true });
}

async function chooseWorkingDirectory() {
  const win = state.window;
  if (!win || win.isDestroyed()) return;
  const current = state.store.resolvedWorkingDirectory();
  const result = await dialog.showOpenDialog(win, {
    title: '选择 dsh 服务的工作目录',
    defaultPath: current,
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '使用此目录并重启',
  });
  if (result.canceled || result.filePaths.length === 0) return;
  state.store.update({ workingDirectory: result.filePaths[0] });
  await restartServer();
}

function openInBrowser() {
  if (state.url) void shell.openExternal(state.url);
}

function copyUrl() {
  if (state.url) clipboard.writeText(state.url);
}

function openLogFile() {
  if (state.logFile && fs.existsSync(state.logFile)) void shell.openPath(state.logFile);
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '在浏览器中打开', accelerator: 'CmdOrCtrl+Shift+O', click: openInBrowser },
        { label: '复制服务地址', click: copyUrl },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '服务',
      submenu: [
        { label: '重启 dsh 服务', accelerator: 'CmdOrCtrl+Shift+R', click: () => void restartServer() },
        { label: '选择工作目录…', click: () => void chooseWorkingDirectory() },
        { type: 'separator' },
        { label: '打开服务日志', click: openLogFile },
        { label: '打开配置目录', click: () => void shell.openPath(app.getPath('userData')) },
        { label: '打开 DSH 主目录', click: () => void shell.openPath(dshHomePath()) },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载界面', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于 DeepSeek Harness 桌面端', click: () => void showAbout() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function showAbout() {
  const info = snapshot();
  const runtime = state.server?.runtime;
  const lines = [
    `桌面端 ${info.versions.app}`,
    `Electron ${info.versions.electron} · Chromium ${info.versions.chrome} · Node ${info.versions.node}`,
    '',
    `服务地址：${state.url ?? '（未运行）'}`,
    runtime ? `Node 运行时：${runtime.node.path}（${runtime.node.version}）` : 'Node 运行时：（未解析）',
    runtime ? `dsh 入口：${runtime.entry}` : 'dsh 入口：（未解析）',
    state.server?.adopted ? '服务来源：复用已在运行的 dsh' : '服务来源：桌面端拉起',
    '',
    `DSH 主目录：${dshHomePath()}`,
    `配置文件：${info.paths.configFile ?? ''}`,
  ];
  // 配置损坏被备份掉这件事必须让用户看见，否则「我的设置怎么没了」无从解释。
  if (state.store.loadError) {
    lines.push('', `注意：配置文件无法解析，已备份为 config.json.corrupt 并使用默认值。原因：${state.store.loadError}`);
  }
  await dialog.showMessageBox(state.window ?? undefined, {
    type: 'info',
    title: '关于',
    message: 'DeepSeek Harness 桌面端',
    detail: lines.join('\n'),
    buttons: ['好'],
    noLink: true,
  });
}

function registerIpc() {
  ipcMain.handle('desktop:state', () => snapshot());
  ipcMain.handle('desktop:retry', async () => {
    await restartServer();
    return snapshot();
  });
  ipcMain.handle('desktop:open-log', () => {
    openLogFile();
  });
  ipcMain.handle('desktop:open-config-dir', () => {
    void shell.openPath(app.getPath('userData'));
  });
  ipcMain.handle('desktop:open-external', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  ipcMain.handle('desktop:quit', () => {
    app.quit();
  });
}

/**
 * 冒烟测试：真启动一次完整链路，等界面渲染完成后截图并退出。
 * 这是唯一能在无人值守下验证「服务拉起 + 界面加载」的方式。
 * @returns 退出码。
 */
async function runSmoke() {
  const shotPath = path.resolve(SMOKE_SHOT ?? path.join(process.cwd(), '.smoke', 'desktop.png'));
  const failures = [];
  createWindow();
  const win = state.window;
  win.show();
  // Electron 新旧两版 console-message 签名不同：新版给一个 details 对象且 level
  // 是字符串，旧版是 (event, level, message, ...)。两种都归一成数字等级。
  const LEVELS = { debug: 0, info: 1, warning: 2, warn: 2, error: 3 };
  win.webContents.on('console-message', (...args) => {
    const details = typeof args[0] === 'object' && args[0] !== null && 'message' in args[0] ? args[0] : { level: args[1], message: args[2] };
    const raw = details.level;
    const level = typeof raw === 'number' ? raw : (LEVELS[String(raw).toLowerCase()] ?? 0);
    const message = String(details.message);
    // Electron 在未打包时会往渲染器控制台塞一条 CSP 安全警告；它说的是 dsh 前端
    // 自己的策略，不是桌面端引入的问题，打包后也不再出现，因此不计入失败。
    if (message.includes('Electron Security Warning')) return;
    if (level >= 2) failures.push(`renderer console: ${message}`);
  });
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    failures.push(`did-fail-load ${String(code)} ${description} ${url}`);
  });

  await boot();
  if (state.fatal) {
    // 失败路径正是状态页真正露脸的场合，顺手验证它的图案素材确实加载了——CSP 或
    // 路径写错时图片会静默变成破图，不专门看一眼就发现不了。
    const statusPage = await win.webContents
      .executeJavaScript(
        `(() => { const img = document.querySelector('.mark img'); return { markSrc: img ? img.getAttribute('src') : null, markLoaded: Boolean(img && img.naturalWidth > 0), markWidth: img ? img.naturalWidth : 0 }; })()`,
      )
      .catch(() => ({ markSrc: null, markLoaded: false, markWidth: 0 }));
    console.error(`SMOKE STATUS-PAGE ${JSON.stringify(statusPage)}`);
    console.error(`SMOKE FAIL: ${state.fatal.message}`);
    if (state.fatal.hint) console.error(state.fatal.hint);
    for (const line of state.fatal.log ?? []) console.error(`  ${line}`);
    return finishSmoke(1);
  }

  await new Promise((resolve) => setTimeout(resolve, Math.max(0, SMOKE_HOLD)));

  // 图像证据之外再取一份可核对的 DOM 事实：截图能证明「画出来了」，facts 能证明
  // 「画的是 dsh 界面而不是一张白页」。
  const facts = await win.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('#root');
    const scripts = [...document.querySelectorAll('script[src]')].map((node) => node.getAttribute('src') || '');
    return {
      title: document.title,
      rootChildren: root ? root.childElementCount : -1,
      nodes: document.querySelectorAll('*').length,
      pluginScripts: scripts.filter((src) => src.includes('/plugins/')).length,
      buttons: document.querySelectorAll('button').length,
      textareas: document.querySelectorAll('textarea,[contenteditable="true"]').length,
      heading: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
      url: location.href,
    };
  })()`);

  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  const image = await win.webContents.capturePage();
  fs.writeFileSync(shotPath, image.toPNG());
  console.log(`SMOKE FACTS ${JSON.stringify(facts)}`);

  if (facts.rootChildren <= 0) failures.push('#root 没有渲染出任何子节点');
  if (facts.nodes < 50) failures.push(`DOM 节点过少（${String(facts.nodes)}），界面可能没渲染出来`);
  if (failures.length > 0) {
    console.error(`SMOKE FAIL: ${failures.join(' | ')}`);
    console.error(`screenshot: ${shotPath}`);
    return finishSmoke(1);
  }
  console.log(`SMOKE OK url=${state.url} adopted=${String(state.server.adopted)} windowTitle=${JSON.stringify(win.getTitle())} screenshot=${shotPath}`);
  if (SMOKE_EXIT_DELAY > 0) await new Promise((resolve) => setTimeout(resolve, SMOKE_EXIT_DELAY));
  return finishSmoke(0);
}

/**
 * 冒烟测试的收尾：先回收自己拉起的服务再退出。
 *
 * `app.exit()` 不会触发 `before-quit`，直接调它会把自己拉起的 dsh 子进程留成孤儿
 * ——测试脚本随后就会在机器上留下一个没人管的监听端口。
 * @param code - 退出码。
 * @returns 该退出码（调用方 return 它，保证返回类型一致）。
 */
async function finishSmoke(code) {
  try {
    await state.server?.stop();
  } catch (error) {
    console.error(`SMOKE: 回收服务失败：${error instanceof Error ? error.message : String(error)}`);
  }
  app.exit(code);
  return code;
}

// ---- 单实例：第二次启动只把已有窗口叫到前面来 ----
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = state.window;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.setAppUserModelId('dev.deepseekharness.dsh.desktop');

  app.whenReady().then(async () => {
    // 注意：load() 返回的是配置对象本身，store 实例要留着（其余代码读 store.data / store.update）。
    state.store = new ConfigStore(path.join(app.getPath('userData'), 'config.json'));
    state.store.load();
    if (DEV) state.store.data.openDevTools = true;
    state.logFile = path.join(app.getPath('userData'), 'dsh-server.log');
    state.server = new DshServer({ store: state.store, logFile: state.logFile });
    state.server.on('status', (payload) => setStatus(payload.phase, payload.text, payload.detail));
    state.server.on('crashed', (payload) => {
      console.error(`[dsh-desktop] 服务意外退出：code=${formatExitCode(payload.exitCode)}, signal=${String(payload.signal)}`);
      state.fatal = {
        message: `dsh 服务已退出（退出码 ${formatExitCode(payload.exitCode)}${payload.signal ? `, signal=${String(payload.signal)}` : ''}）。`,
        hint: '点击「重启服务」重新拉起；若反复失败，请查看服务日志。',
        log: payload.tail,
      };
      showStatusPage();
    });

    registerIpc();
    buildMenu();

    if (SMOKE) {
      await runSmoke();
      return;
    }
    createWindow();
    await boot();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && !SMOKE) createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  // 退出前回收自己拉起的服务；复用的外部服务不动。
  app.on('before-quit', (event) => {
    if (state.quitReady || !state.server) return;
    event.preventDefault();
    state.quitReady = true;
    void state.server.stop().finally(() => app.quit());
  });
}
