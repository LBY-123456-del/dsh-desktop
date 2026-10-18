'use strict';
/**
 * 状态页的预加载脚本：只暴露状态页真正需要的四件事，不向 Web GUI 泄漏任何能力。
 *
 * 注意作用域——这个 preload 也挂在加载 dsh 界面的同一个窗口上，所以它暴露的
 * 接口对 Web GUI 同样可见。因此这里**不含任何文件系统或进程能力**，只有状态查询、
 * 重试、打开日志与退出。
 * @module dsh-desktop/preload
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  /** 读取当前状态快照（状态页每次加载时调一次）。 */
  getState: () => ipcRenderer.invoke('desktop:state'),
  /** 订阅状态变化。 */
  onState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('desktop:state', listener);
    return () => ipcRenderer.removeListener('desktop:state', listener);
  },
  /** 重启 dsh 服务并重新加载界面。 */
  retry: () => ipcRenderer.invoke('desktop:retry'),
  /** 用系统默认程序打开服务日志。 */
  openLog: () => ipcRenderer.invoke('desktop:open-log'),
  /** 打开桌面端配置目录。 */
  openConfigDir: () => ipcRenderer.invoke('desktop:open-config-dir'),
  /** 用系统浏览器打开一个链接。 */
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
  /** 退出桌面端。 */
  quit: () => ipcRenderer.invoke('desktop:quit'),
});
