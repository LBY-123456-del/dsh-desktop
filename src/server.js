'use strict';
/**
 * dsh web 服务的生命周期管理。
 *
 * 三种归宿，按优先级：
 * 1. **复用**——目标端口上已经跑着一个 dsh（比如用户自己开着的浏览器实例），
 *    直接连上去，不另起进程，也不在退出时动它。
 * 2. **另起**——端口空闲时以 `--profile web --no-open --port <port>` 拉起一个，
 *    由桌面端持有并在退出时回收整棵进程树。
 * 3. **换端口**——端口被非 dsh 程序占用时退到系统分配的端口，并把这件事讲清楚。
 *
 * 就绪信号以 dsh 自己打印的 `dsh web: <url>` 行为准（它出现在 Loader 树稳定
 * 之后），辅以 HTTP 探测兜底。
 * @module dsh-desktop/server
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { resolveDshEntry, resolveNodeBinary } = require('./locate');

/** dsh 打印的就绪行：`dsh web: http://127.0.0.1:3080`，0.1.5 起尾巴带 `/?token=...`。 */
const READY_PATTERN = /dsh web:\s*(https?:\/\/[^\s)]+)/;
/** 0.1.5 起未鉴权请求的应答文本，用来认出「这是 dsh，但要 token」。 */
const AUTH_CHALLENGE = 'dsh web authentication required';
/** 0.1.5 起的鉴权 cookie 前缀。 */
const AUTH_COOKIE_PREFIX = 'dsh-auth-';
/** 日志环形缓冲保留的行数，出错时展示给用户。 */
const LOG_LIMIT = 400;
/** 从进程启动到就绪的上限。 */
const READY_TIMEOUT_MS = Number(process.env.DSH_DESKTOP_READY_TIMEOUT ?? 180000);
/** HTTP 探测单次超时。 */
const PROBE_TIMEOUT_MS = 1500;
/**
 * 端口被抢占后的换端口重试上限。
 *
 * 探测和 bind 之间永远有窗口：刚退出的进程可能把端口留在 TIME_WAIT 上，或者别的
 * 程序恰好插进来。这种窗口只能靠重试兜住；上限只是防止无限换端口。
 */
const PORT_RETRY_LIMIT = 3;

class DshServerError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'DshServerError';
    this.hint = hint;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 探测一个端口上是否有 dsh 在服务。
 * @param host - 绑定的主机。
 * @param port - 端口。
 * @returns `'dsh'`（是 dsh）、`'other'`（有别的程序）、`'free'`（无人应答）。
 */
async function probePort(host, port) {
  const indexUrl = `http://${host}:${String(port)}/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(indexUrl, { signal: controller.signal, redirect: 'manual' });
    const body = await response.text();
    return classifyResponse(response, body);
  } catch (error) {
    // 连接被拒 = 端口空闲；超时/中断则保守当作有东西占着。
    if (error && typeof error === 'object' && 'cause' in error) {
      const code = error.cause?.code;
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return 'free';
    }
    return 'other';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 判定一段 HTML 是不是 dsh 的启动页。
 * @param body - `GET /` 的响应体。
 * @returns 是 dsh 启动页时为 true。
 */
function isDshIndex(body) {
  return /__DSH_BOOT__|\/plugins\/|dsh-web|DeepSeek Harness/i.test(body);
}

/**
 * 给一次探测响应定性。
 *
 * dsh 0.1.5 起给浏览器界面加了 token 鉴权门：**每个服务进程自己随机生成一个
 * launch token**，不带 token 请求 `/` 会得到 401 文本，带有效 token 则 303 换
 * cookie。所以「靠首页 HTML 认人」不再成立——不带 token 永远拿不到首页。
 *
 * @param response - 探测响应。
 * @param body - 响应体。
 * @returns `'dsh'`（开放首页，可复用）、`'dsh-fenced'`（是 dsh 但需要 token，
 *          桌面端拿不到别人的 token，无法复用）、`'other'`（不是 dsh）。
 */
function classifyResponse(response, body) {
  if (isDshIndex(body)) return 'dsh';
  if (response.status === 401 && body.includes(AUTH_CHALLENGE)) return 'dsh-fenced';
  if (response.status === 303 && String(response.headers.get('location') ?? '') === '/') {
    if (String(response.headers.get('set-cookie') ?? '').includes(AUTH_COOKIE_PREFIX)) return 'dsh-fenced';
  }
  return 'other';
}

/**
 * 让操作系统分配一个空闲端口。
 * @param host - 绑定的主机。
 * @returns 空闲端口号，或 null。
 */
async function findFreePort(host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', () => resolve(null));
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : null;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * 判断一次启动失败是不是「端口被抢占」。
 *
 * 判据取 dsh 自己的报错（`listen EADDRINUSE`）；它既可能落在错误消息里，也可能
 * 只在随错误带回的日志尾巴里。只认这一种，别的失败一律原样上抛。
 * @param error - spawn 抛出的错误。
 * @returns 属于端口占用时为 true。
 */
function isPortInUse(error) {
  if (!(error instanceof DshServerError)) return false;
  return /EADDRINUSE/.test(`${error.message}\n${error.hint ?? ''}`);
}

/** dsh web 进程的持有者与状态机。 */
class DshServer extends EventEmitter {
  /**
   * @param options - 运行参数。
   * @param options.store - 配置存储。
   * @param options.logFile - 服务日志落盘路径。
   */
  constructor({ store, logFile }) {
    super();
    this.store = store;
    this.logFile = logFile;
    this.child = null;
    this.url = null;
    this.port = null;
    this.adopted = false;
    this.lines = [];
    this.stopping = false;
    this.runtime = null;
  }

  /** 向界面播报一条阶段状态；同时留一行进程轨迹，便于无人值守时定位卡在哪一步。 */
  report(phase, text, detail) {
    this.emit('status', { phase, text, detail: detail ?? null });
    process.stdout.write(`[dsh-desktop] ${phase}: ${text}${detail == null ? '' : ` (${detail})`}\n`);
  }

  /**
   * 记录一行服务日志：进环形缓冲、进日志文件、进主进程控制台。
   * @param stream - 来源流（stdout/stderr）。
   * @param line - 日志行。
   */
  recordLine(stream, line) {
    const text = line.replace(/\r?\n$/, '');
    if (text === '') return;
    this.lines.push(`[${stream}] ${text}`);
    if (this.lines.length > LOG_LIMIT) this.lines.splice(0, this.lines.length - LOG_LIMIT);
    this.emit('log', text);
    try {
      fs.appendFileSync(this.logFile, `${new Date().toISOString()} [${stream}] ${text}\n`, 'utf8');
    } catch {
      /* 日志落盘失败不影响服务 */
    }
    process.stdout.write(`[dsh ${stream}] ${text}\n`);
  }

  /** 最近的服务日志，用于错误页展示。 */
  tail(count = 40) {
    return this.lines.slice(-count);
  }

  /**
   * 启动或复用一个 dsh web 服务。
   * @returns `{ url, port, adopted, runtime }`。
   */
  async start() {
    const config = this.store.data;
    const { host } = config;

    this.report('locate', '定位本机的 Node 与 dsh…');
    const node = resolveNodeBinary(config.nodePath);
    const entry = resolveDshEntry(config.dshEntry);
    this.runtime = { node, entry };
    this.report('locate', `Node ${node.version} · dsh ${path.basename(path.dirname(path.dirname(entry)))}`, entry);

    // 端口 0 表示「让系统分配」：没有可探测的目标，也没有可复用的服务，直接交给 dsh。
    const wantedPort = config.port;
    if (wantedPort !== 0) {
      this.report('probe', `检查端口 ${host}:${String(wantedPort)}…`);
      const occupancy = await probePort(host, wantedPort);
      if (occupancy === 'dsh' && config.adoptExternalServer) {
        this.adopted = true;
        this.port = wantedPort;
        this.url = `http://${host}:${String(wantedPort)}/`;
        this.report('ready', '已连接到正在运行的 dsh 服务', this.url);
        return { url: this.url, port: this.port, adopted: true, runtime: this.runtime };
      }

      if (occupancy !== 'free') {
        const alternative = await findFreePort(host);
        if (alternative === null) {
          throw new DshServerError(`端口 ${String(wantedPort)} 已被占用，且找不到可用的替代端口。`, '请关闭占用该端口的程序，或在桌面端配置文件里把 port 改成别的值。');
        }
        let notice;
        if (occupancy === 'dsh-fenced') {
          // token 是每个 dsh 进程自己随机生成的，桌面端拿不到别人那个进程的 token，
          // 也就无法接管它的界面。唯一诚实的做法是另起一个，并把原因讲清楚。
          notice =
            `端口 ${String(wantedPort)} 上已有一个 dsh 服务在运行，但 dsh 0.1.5 起界面需要 token 鉴权，` +
            `而 token 是那个进程随机生成的，桌面端无法接管它。已另起一个服务，端口 ${String(alternative)}。` +
            `想让桌面端独占 ${String(wantedPort)}（并沿用你原来的界面设置），请先关掉那个服务。`;
        } else if (occupancy === 'dsh') {
          notice = `端口 ${String(wantedPort)} 上的 dsh 已存在，但桌面端被配置为不复用它；改用端口 ${String(alternative)}。`;
        } else {
          notice = `端口 ${String(wantedPort)} 被其他程序占用，改用端口 ${String(alternative)}（界面设置按地址隔离，可能与之前不同）。`;
        }
        this.report('probe', notice);
        this.report('spawn', `启动 dsh web（${host}:${String(alternative)}）…`);
        await this.spawnOnFreePort(node.path, entry, host, alternative);
        const moved =
          this.port === alternative
            ? ''
            : `（端口 ${String(alternative)} 随后也被抢占，最终落在 ${String(this.port)}）`;
        return { url: this.url, port: this.port, adopted: false, runtime: this.runtime, notice: notice + moved };
      }
    }

    this.report('spawn', `启动 dsh web（${host}:${String(wantedPort)}）…`);
    await this.spawnOnFreePort(node.path, entry, host, wantedPort);
    return { url: this.url, port: this.port, adopted: false, runtime: this.runtime };
  }

  /**
   * 拉起服务，并在端口被抢占时换端口重试。
   *
   * {@link probePort} 用的是 HTTP 探测，只能说明「那一刻没人应答」，说明不了
   * 「我 bind 得上」：探测通过之后、dsh 真正 listen 之前，端口仍可能被别的程序
   * 拿走，或还挂在上一任的 TIME_WAIT 上。此时 dsh 会带着 EADDRINUSE 直接退出，
   * 桌面端若不兜底，用户看到的就是一个说不清原因的致命错误页。
   * @param nodePath - node 可执行文件。
   * @param entry - dsh 的 lib/bin.js。
   * @param host - 绑定主机。
   * @param port - 首次尝试的端口。
   * @returns 实际就绪的端口（同时写入 `this.port`）。
   */
  async spawnOnFreePort(nodePath, entry, host, port) {
    let current = port;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.spawn(nodePath, entry, host, current);
        return current;
      } catch (error) {
        if (attempt >= PORT_RETRY_LIMIT || !isPortInUse(error)) throw error;
        const alternative = await findFreePort(host);
        if (alternative === null) throw error;
        this.report(
          'probe',
          `端口 ${String(current)} 在探测之后被占用（dsh 报 EADDRINUSE），` +
            `第 ${String(attempt)} 次换端口重试：改用 ${String(alternative)}。`,
        );
        this.report('spawn', `启动 dsh web（${host}:${String(alternative)}）…`);
        current = alternative;
      }
    }
  }

  /**
   * 拉起子进程并等待就绪。
   * @param nodePath - node 可执行文件。
   * @param entry - dsh 的 lib/bin.js。
   * @param host - 绑定主机。
   * @param port - 监听端口。
   */
  async spawn(nodePath, entry, host, port) {
    const config = this.store.data;
    const cwd = this.store.resolvedWorkingDirectory();
    const args = [entry, '--profile', config.profile, '--no-open', '--host', host, '--port', String(port), ...config.extraArgs];

    this.report('spawn', `工作目录：${cwd}`);
    const child = spawn(nodePath, args, {
      cwd,
      env: { ...process.env, DSH_DESKTOP: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    let readyUrl = null;
    let settleReady;
    const ready = new Promise((resolve) => {
      settleReady = resolve;
    });

    const consume = (stream) => (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        this.recordLine(stream, line);
        const match = READY_PATTERN.exec(line);
        if (match && readyUrl === null) {
          readyUrl = match[1];
          settleReady({ ok: true, url: readyUrl });
        }
      }
    };
    child.stdout.on('data', consume('stdout'));
    child.stderr.on('data', consume('stderr'));

    const exited = new Promise((resolve) => {
      child.once('error', (error) => {
        settleReady({ ok: false, error });
        resolve({ code: null, error });
      });
      child.once('exit', (code, signal) => {
        settleReady({ ok: false, exitCode: code, signal });
        resolve({ code, signal });
      });
    });

    const timeout = delay(READY_TIMEOUT_MS).then(() => ({ ok: false, timeout: true }));
    const outcome = await Promise.race([ready, timeout]);

    if (!outcome.ok) {
      const tail = this.tail(20).join('\n');
      await this.killChild();
      if (outcome.timeout) {
        throw new DshServerError(`dsh 服务在 ${String(Math.round(READY_TIMEOUT_MS / 1000))} 秒内没有就绪。`, `最近的输出：\n${tail}\n\n可尝试在「服务 → 重启服务」重试，或检查 ~/.dsh 下的 profile 配置。`);
      }
      const reason = outcome.error ? outcome.error.message : `进程退出（code=${String(outcome.exitCode)}, signal=${String(outcome.signal)}）`;
      throw new DshServerError(`dsh 服务启动失败：${reason}`, `最近的输出：\n${tail}\n\n可在「服务 → 打开服务日志」查看完整日志。`);
    }

    // URL 行出现即视为就绪；再做一次 HTTP 复核，避免读到残留行。
    const url = outcome.url;
    if (!(await this.waitForHttp(url))) {
      throw new DshServerError(`dsh 已打印就绪地址 ${url}，但 HTTP 探测未通过。`, '这通常意味着服务在启动后立刻崩溃，请查看服务日志。');
    }

    this.url = url;
    this.port = port;
    this.report('ready', 'dsh 服务已就绪', url);

    // 子进程意外退出时通知上层（正常停止由 stop() 置位 stopping）。
    void exited.then((result) => {
      if (this.stopping) return;
      this.child = null;
      this.emit('crashed', {
        exitCode: result.code,
        signal: result.signal ?? null,
        tail: this.tail(20),
      });
    });
  }

  /**
   * 轮询直到 HTTP 可服务。
   *
   * 传进来的 url 是 dsh 打印的那个（0.1.5 起带 `?token=`）。它的应答是 **303**
   * 而不是 200：服务端用 token 换 cookie 后重定向到 `/`。所以这里不能只认 2xx，
   * 否则自己刚拉起来的服务会被判成「探测未通过」。
   *
   * token 可重复使用（实测连续多次都是 303），所以这一次预检不会把 token 烧掉，
   * 窗口随后仍能用同一个地址换取 cookie。
   * @param url - 就绪地址。
   * @returns 通过时为 true。
   */
  async waitForHttp(url) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'manual' });
        // 200/304：旧版本直接给首页；303：新版本 token 换取成功。
        if (response.ok || response.status === 304 || response.status === 303) return true;
      } catch {
        /* 还没起来，继续等 */
      }
      await delay(300);
    }
    return false;
  }

  /** 结束子进程（连同它的整棵进程树）。 */
  async killChild() {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = null;
      return;
    }
    const { pid } = child;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      child.kill();
    } catch {
      /* 已经死了 */
    }
    if (process.platform === 'win32' && typeof pid === 'number') {
      // Windows 上 kill 只结束直接子进程，工具子进程要靠 taskkill /T 收尾。
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
    }
    await Promise.race([exited, delay(5000)]);
    this.child = null;
  }

  /** 停止服务；复用的外部服务不会被停掉。 */
  async stop() {
    this.stopping = true;
    if (!this.adopted) await this.killChild();
    this.url = null;
    this.port = null;
    this.stopping = false;
  }

  /**
   * 重启：先停掉自己拉起的服务，再重新启动。
   * @returns 与 {@link start} 相同。
   */
  async restart() {
    await this.stop();
    this.lines = [];
    return this.start();
  }
}

module.exports = { DshServer, DshServerError, findFreePort, isDshIndex, probePort };
