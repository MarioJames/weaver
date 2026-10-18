import { contextBridge, ipcRenderer } from 'electron';
import type { WeaverAPI, TaskInput } from '../shared/types';
const api: WeaverAPI = {
 command: request => ipcRenderer.invoke('weaver:command',request),
 getPolicy: () => ipcRenderer.invoke('policy:get'),
 validatePolicy: config => ipcRenderer.invoke('policy:validate',config),
 savePolicy: input => ipcRenderer.invoke('policy:save',input),
 previewRoute: input => ipcRenderer.invoke('policy:preview',input),
 listTasks: () => ipcRenderer.invoke('tasks:list'),
 createTask: (input: TaskInput) => ipcRenderer.invoke('tasks:create',input),
 importTask: () => ipcRenderer.invoke('tasks:import'),
 startTask: (id: string) => ipcRenderer.invoke('tasks:start',id),
 cancelTask: (id: string) => ipcRenderer.invoke('tasks:cancel',id),
 capabilities: () => ipcRenderer.invoke('app:capabilities'),
 onTasksChanged: callback => {
  const listener = () => callback(); ipcRenderer.on('tasks:changed',listener);
  return () => ipcRenderer.removeListener('tasks:changed',listener);
 }
};
contextBridge.exposeInMainWorld('weaver',api);
