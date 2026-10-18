'use strict';
/**
 * 桌面端配置：默认值、环境变量覆盖与磁盘持久化。
 *
 * 配置文件位于 Electron 的 userData 目录（`config.json`）。环境变量只覆盖本次
 * 运行，不写回磁盘——自动化冒烟测试靠它注入隔离的端口与 `DSH_HOME`。
 * @module dsh-desktop/config
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 出厂默认值。 */
const DEFAULTS = Object.freeze({
  /** dsh 的 profile 名，桌面端固定跑 web profile。 */
  profile: 'web',
  /** dsh web 的绑定主机，只支持回环地址。 */
  host: '127.0.0.1',
  /** 监听端口；固定端口让界面设置（localStorage 按 origin 隔离）在重启后保留。 */
  port: 3080,
  /** 显式指定的 node 可执行文件；null 表示自动探测。 */
  nodePath: null,
  /** 显式指定的 dsh 入口（lib/bin.js 或其包目录）；null 表示自动探测。 */
  dshEntry: null,
  /** dsh 服务的工作目录；null 表示用户主目录。 */
  workingDirectory: null,
  /** 传给 dsh web 的额外参数。 */
  extraArgs: [],
  /** 目标端口上已有 dsh 服务时，直接连接而不是另起一个。 */
  adoptExternalServer: true,
  /** 启动后自动打开开发者工具（调试用）。 */
  openDevTools: false,
  /** 窗口几何，退出时回写。 */
  window: { width: 1440, height: 920, x: null, y: null, maximized: false },
});

function readEnvFlag(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

function readEnvInt(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : undefined;
}

function readEnvString(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw.trim();
}

/**
 * 把任意来源的 patch 合并进一份完整配置，做类型收敛，未知字段一律丢弃。
 * @param base - 基础配置。
 * @param patch - 要合并的字段。
 * @returns 合并后的配置对象。
 */
function mergeConfig(base, patch) {
  const merged = { ...base };
  if (!patch || typeof patch !== 'object') return merged;
  for (const key of ['profile', 'host']) {
    if (typeof patch[key] === 'string' && patch[key].trim() !== '') merged[key] = patch[key].trim();
  }
  const port = Number(patch.port);
  if (Number.isInteger(port) && port >= 0 && port <= 65535) merged.port = port;
  for (const key of ['nodePath', 'dshEntry', 'workingDirectory']) {
    if (patch[key] === null) merged[key] = null;
    else if (typeof patch[key] === 'string' && patch[key].trim() !== '') merged[key] = patch[key].trim();
  }
  if (Array.isArray(patch.extraArgs)) merged.extraArgs = patch.extraArgs.filter((arg) => typeof arg === 'string');
  for (const key of ['adoptExternalServer', 'openDevTools']) {
    if (typeof patch[key] === 'boolean') merged[key] = patch[key];
  }
  if (patch.window && typeof patch.window === 'object') {
    const w = { ...merged.window };
    for (const key of ['width', 'height']) {
      const value = Number(patch.window[key]);
      if (Number.isInteger(value) && value >= 640) w[key] = value;
    }
    for (const key of ['x', 'y']) {
      const value = Number(patch.window[key]);
      if (Number.isInteger(value)) w[key] = value;
      else if (patch.window[key] === null) w[key] = null;
    }
    if (typeof patch.window.maximized === 'boolean') w.maximized = patch.window.maximized;
    merged.window = w;
  }
  return merged;
}

/** 环境变量覆盖层（只影响本次运行）。 */
function envOverrides() {
  const overrides = {};
  const profile = readEnvString('DSH_DESKTOP_PROFILE');
  if (profile !== undefined) overrides.profile = profile;
  const host = readEnvString('DSH_DESKTOP_HOST');
  if (host !== undefined) overrides.host = host;
  const port = readEnvInt('DSH_DESKTOP_PORT');
  if (port !== undefined) overrides.port = port;
  const node = readEnvString('DSH_DESKTOP_NODE');
  if (node !== undefined) overrides.nodePath = node;
  const entry = readEnvString('DSH_DESKTOP_DSH');
  if (entry !== undefined) overrides.dshEntry = entry;
  const cwd = readEnvString('DSH_DESKTOP_CWD');
  if (cwd !== undefined) overrides.workingDirectory = cwd;
  const adopt = readEnvFlag('DSH_DESKTOP_ADOPT');
  if (adopt !== undefined) overrides.adoptExternalServer = adopt;
  return overrides;
}

/** 配置存储：读一次、改内存、写回磁盘。 */
class ConfigStore {
  /**
   * @param file - 配置文件路径。
   */
  constructor(file) {
    this.file = file;
    this.data = mergeConfig({ ...DEFAULTS }, envOverrides());
    this.loadError = null;
  }

  /**
   * 从磁盘读配置。文件缺失或损坏都不致命：损坏时改名备份，然后用默认值继续。
   * @returns 当前配置。
   */
  load() {
    if (!fs.existsSync(this.file)) return this.data;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = mergeConfig(mergeConfig({ ...DEFAULTS }, parsed), envOverrides());
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
      try {
        fs.renameSync(this.file, `${this.file}.corrupt`);
      } catch {
        /* 备份失败不影响继续启动 */
      }
    }
    return this.data;
  }

  /**
   * 合并一个 patch 并写回磁盘。
   * @param patch - 要更新的字段。
   * @returns 更新后的配置。
   */
  update(patch) {
    this.data = mergeConfig(this.data, patch);
    this.save();
    return this.data;
  }

  /** 把当前配置写回磁盘；失败只记录，不打断应用。 */
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    } catch (error) {
      console.error(`[dsh-desktop] 写入配置失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 实际使用的工作目录。 */
  resolvedWorkingDirectory() {
    const configured = this.data.workingDirectory;
    if (typeof configured === 'string' && configured.trim() !== '' && fs.existsSync(configured)) return configured;
    return os.homedir();
  }
}

module.exports = { ConfigStore, DEFAULTS, mergeConfig };
