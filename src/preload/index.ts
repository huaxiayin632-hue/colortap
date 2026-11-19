import { contextBridge, ipcRenderer } from 'electron';
import { channels, type DesktopAPI } from '../shared/ipc';

const api: DesktopAPI = {
  newProject: (project) => ipcRenderer.invoke(channels.newProject, project),
  openProject: () => ipcRenderer.invoke(channels.openProject),
  saveProject: (request) => ipcRenderer.invoke(channels.saveProject, request),
  importMusic: (handle) => ipcRenderer.invoke(channels.importMusic, handle),
  importSound: (handle) => ipcRenderer.invoke(channels.importSound, handle),
  importImage: (request) => ipcRenderer.invoke(channels.importImage, request),
  cancelImageImport: () => ipcRenderer.invoke(channels.cancelImageImport),
  onImageProgress: (listener) => {
    const callback = (
      _event: Electron.IpcRendererEvent,
      progress: Parameters<typeof listener>[0],
    ) => listener(progress);
    ipcRenderer.on(channels.imageProgress, callback);
    return () => {
      ipcRenderer.removeListener(channels.imageProgress, callback);
    };
  },
  readAsset: (request) => ipcRenderer.invoke(channels.readAsset, request),
  discardImport: (request) => ipcRenderer.invoke(channels.discardImport, request),
  closeSession: (handle) => ipcRenderer.invoke(channels.closeSession, handle),
  setDirty: (request) => ipcRenderer.invoke(channels.setDirty, request),
  processSample: () => ipcRenderer.invoke(channels.processSample),
  exportPerformance: (report) => ipcRenderer.invoke(channels.exportPerformance, report),
};
contextBridge.exposeInMainWorld('desktop', api);
