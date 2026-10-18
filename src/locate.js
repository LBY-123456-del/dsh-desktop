'use strict';
/**
 * 定位本机的 Node 运行时与 dsh 入口（`lib/bin.js`）。
 *
 * 桌面端不内置 dsh：它复用用户已经装好的那份，这样皮肤、插件与 `~/.dsh` 配置
 * 全部与命令行/浏览器用法共用一份。定位顺序为「显式配置 → 环境变量 → PATH 上
 * 的 shim → 各包管理器已知的全局根目录」。
 * @module dsh-desktop/locate
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** dsh 包相对任意全局根目录的位置。 */
const DSH_PACKAGE_REL = path.join('node_modules', '@deepseek-ai', 'dsh');
/** dsh 包内的 CLI 入口。 */
const DSH_BIN_REL = path.join('lib', 'bin.js');

/** 定位失败时抛出的错误，带面向用户的修复建议。 */
class LocateError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'LocateError';
    this.hint = hint;
  }
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

/**
 * 把一个用户给出的 dsh 路径归一成真正的 `lib/bin.js`。
 *
 * 接受的形式：`bin.js` 本身、dsh 包目录、`node_modules` 目录、npm/pnpm 生成的
 * shim（`dsh`、`dsh.cmd`、`dsh.ps1`）。任何无法归一成 `bin.js` 的输入返回 null。
 * @param input - 用户配置或环境变量里的路径。
 * @returns 归一后的绝对路径，或 null。
 */
function normalizeDshEntry(input) {
  if (typeof input !== 'string' || input.trim() === '') return null;
  let target = stripQuotes(input);
  try {
    target = fs.realpathSync(target);
  } catch {
    /* 路径不存在时保留原样，交给下面的候选逐一探测 */
  }
  const candidates = [target];
  if (isDirectory(target)) {
    candidates.push(path.join(target, DSH_BIN_REL));
    candidates.push(path.join(target, DSH_PACKAGE_REL, DSH_BIN_REL));
    // 全局 bin 目录：<root>/dsh.cmd → <root>/node_modules/@deepseek-ai/dsh/lib/bin.js
    candidates.push(path.join(target, DSH_PACKAGE_REL, DSH_BIN_REL));
  } else {
    const dir = path.dirname(target);
    // npm / pnpm / Volta 的 shim 与 node_modules 同级
    candidates.push(path.join(dir, DSH_PACKAGE_REL, DSH_BIN_REL));
    // 直接指向 <pkg>/lib/bin.js 的符号链接
    candidates.push(path.join(dir, '..', DSH_BIN_REL));
  }
  for (const candidate of candidates) {
    if (path.basename(candidate) === 'bin.js' && isFile(candidate)) return path.resolve(candidate);
  }
  return null;
}

/**
 * 用 `where`／`command -v` 找 PATH 上的可执行文件，返回全部命中项（未解析符号链接）。
 * @param name - 可执行文件名，例如 `dsh` 或 `node`。
 * @returns 绝对路径列表；查找失败时为空数组。
 */
function searchPath(name) {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('where.exe', [name], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }
    const output = execFileSync('sh', ['-lc', `command -v ${name} || true`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 各包管理器可能放置全局包的根目录（其下应有 `node_modules/@deepseek-ai/dsh`）。
 * @returns 候选根目录列表，已存在的排在前面。
 */
function globalRoots() {
  const roots = [];
  const home = os.homedir();
  if (process.platform === 'win32') {
    if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm'));
    if (process.env.LOCALAPPDATA) {
      roots.push(path.join(process.env.LOCALAPPDATA, 'pnpm', 'global', '5'));
      roots.push(path.join(process.env.LOCALAPPDATA, 'pnpm'));
    }
    if (process.env.ProgramFiles) roots.push(path.join(process.env.ProgramFiles, 'nodejs'));
    if (process.env['ProgramFiles(x86)']) roots.push(path.join(process.env['ProgramFiles(x86)'], 'nodejs'));
    // nvm-windows 把全局包放在版本目录里
    if (process.env.NVM_HOME) roots.push(process.env.NVM_HOME);
    if (process.env.APPDATA) {
      const nvmDir = path.join(process.env.APPDATA, 'nvm');
      if (isDirectory(nvmDir)) {
        for (const entry of safeReadDir(nvmDir)) {
          if (/^v\d/.test(entry)) roots.push(path.join(nvmDir, entry));
        }
      }
    }
  } else {
    roots.push('/usr/local', '/usr', '/opt/homebrew');
    const nvmVersions = path.join(home, '.nvm', 'versions', 'node');
    if (isDirectory(nvmVersions)) {
      for (const entry of safeReadDir(nvmVersions)) roots.push(path.join(nvmVersions, entry));
    }
    const fnmVersions = path.join(home, '.local', 'share', 'fnm', 'node-versions');
    if (isDirectory(fnmVersions)) {
      for (const entry of safeReadDir(fnmVersions)) roots.push(path.join(fnmVersions, entry, 'installation'));
    }
    roots.push(path.join(home, '.volta'));
  }
  return roots;
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * 解析 dsh 入口路径。
 * @param explicit - 配置或环境变量给出的路径（可为空）。
 * @returns `lib/bin.js` 的绝对路径。
 * @throws {LocateError} 全部候选都失败时。
 */
function resolveDshEntry(explicit) {
  if (explicit && String(explicit).trim() !== '') {
    const normalized = normalizeDshEntry(explicit);
    if (normalized) return normalized;
    throw new LocateError(`配置里指定的 dsh 路径无效：${explicit}`, `请指向 dsh 包目录、lib/bin.js，或 PATH 上的 dsh shim。也可以用 npm i -g @deepseek-ai/dsh 重装。`);
  }
  for (const hit of searchPath('dsh')) {
    const normalized = normalizeDshEntry(hit);
    if (normalized) return normalized;
  }
  for (const root of globalRoots()) {
    const candidate = path.join(root, DSH_PACKAGE_REL, DSH_BIN_REL);
    if (isFile(candidate)) return path.resolve(candidate);
  }
  throw new LocateError(
    '找不到本机的 dsh 安装。',
    '请先安装：npm i -g @deepseek-ai/dsh；或在桌面端配置文件里把 dshEntry 指向 dsh 的 lib/bin.js。',
  );
}

/**
 * 探测一个可执行文件是 Node 还是 Electron，并取回版本号。
 *
 * 用 `process.versions.electron` 分辨，而不是拿它跟 `process.execPath` 比：Electron
 * 自带的 node 也能报出 Node 版本，但 ABI 不同，跑不了 dsh 的原生模块。
 * @param binary - node 可执行文件路径。
 * @returns `{ version, isElectron }`，探测失败时为 null。
 */
function probeNodeRuntime(binary) {
  try {
    const output = execFileSync(binary, ['-e', 'process.stdout.write(process.versions.electron ? "electron " + process.versions.electron : process.version)'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
    });
    const text = output.trim();
    const electron = /^electron\s/.test(text);
    if (electron) return { version: text, isElectron: true };
    return /^v\d+\.\d+\.\d+/.test(text) ? { version: text, isElectron: false } : null;
  } catch {
    return null;
  }
}

function nodeBinaryCandidates() {
  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(...searchPath('node'));
    if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'));
    if (process.env['ProgramFiles(x86)']) candidates.push(path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node.exe'));
    if (process.env.NVM_SYMLINK) candidates.push(path.join(process.env.NVM_SYMLINK, 'node.exe'));
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Volta', 'bin', 'node.exe'));
  } else {
    candidates.push(...searchPath('node'));
    candidates.push('/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node');
    const nvmVersions = path.join(os.homedir(), '.nvm', 'versions', 'node');
    if (isDirectory(nvmVersions)) {
      for (const entry of safeReadDir(nvmVersions).reverse()) candidates.push(path.join(nvmVersions, entry, 'bin', 'node'));
    }
  }
  return candidates;
}

/**
 * 解析运行 dsh 的 Node 运行时。
 *
 * 刻意不复用 Electron 自带的 Node（`ELECTRON_RUN_AS_NODE`）：dsh 依赖 node-pty、
 * koffi、sharp 等原生模块，它们按 Node 的 ABI 预编译，而 Electron 的 ABI 不同。
 * @param explicit - 配置或环境变量给出的路径（可为空）。
 * @returns `{ path, version }`。
 * @throws {LocateError} 找不到可用的 Node 时。
 */
function resolveNodeBinary(explicit) {
  // 显式指定（配置或环境变量）就当作硬约束：写错了要当场说清楚，而不是静默换一个
  // 别的 Node 跑起来——那会让人以为配置生效了。
  const pinned = typeof explicit === 'string' && explicit.trim() !== '' ? explicit : process.env.DSH_DESKTOP_NODE;
  if (typeof pinned === 'string' && pinned.trim() !== '') {
    const resolved = path.resolve(stripQuotes(pinned));
    if (!isFile(resolved)) {
      throw new LocateError(`配置里指定的 Node 路径不存在：${resolved}`, '请检查 nodePath（或 DSH_DESKTOP_NODE）是否指向真正的 node 可执行文件。');
    }
    const probe = probeNodeRuntime(resolved);
    if (probe === null) {
      throw new LocateError(`配置里指定的 Node 无法运行：${resolved}`, '它可能不是可执行文件，或版本太旧而被系统拒绝执行。');
    }
    if (probe.isElectron) {
      throw new LocateError(`配置里指定的运行时是 Electron 自带的 Node（${probe.version}），不能用来跑 dsh。`, 'dsh 的原生模块按 Node 的 ABI 编译，请指向真正的 node 可执行文件。');
    }
    const pinnedMajor = Number(/^v(\d+)/.exec(probe.version)?.[1] ?? 0);
    if (pinnedMajor < 20) {
      throw new LocateError(`配置里指定的 Node 版本过低：${probe.version}（需要 v20 或更高）。`, '请升级 Node.js，或把 nodePath 指向更高版本。');
    }
    return { path: resolved, version: probe.version };
  }

  const seen = new Set();
  const candidates = [];
  const push = (candidate) => {
    if (typeof candidate !== 'string' || candidate.trim() === '') return;
    const resolved = path.resolve(stripQuotes(candidate));
    if (seen.has(resolved.toLowerCase())) return;
    seen.add(resolved.toLowerCase());
    candidates.push(resolved);
  };

  for (const candidate of nodeBinaryCandidates()) push(candidate);

  for (const candidate of candidates) {
    if (!isFile(candidate)) continue;
    const probe = probeNodeRuntime(candidate);
    if (probe === null) continue;
    // Electron 自带的 Node 能被当成 node 用，但原生模块的 ABI 不匹配，必须跳过。
    if (probe.isElectron) continue;
    const major = Number(/^v(\d+)/.exec(probe.version)?.[1] ?? 0);
    if (major < 20) continue;
    return { path: candidate, version: probe.version };
  }

  throw new LocateError(
    '找不到可用的 Node.js 运行时（需要 v20 或更高）。',
    '桌面端需要一个独立的 Node 来跑 dsh web。请安装 Node.js LTS：https://nodejs.org/，或在桌面端配置文件里设置 nodePath。',
  );
}

module.exports = {
  DSH_BIN_REL,
  LocateError,
  normalizeDshEntry,
  resolveDshEntry,
  resolveNodeBinary,
  searchPath,
};
