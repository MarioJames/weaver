import { app, BrowserWindow, dialog, ipcMain, session, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { CommandHandler } from './commands';
import { startLocalIPC } from './local-ipc';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { TaskStore } from './store';
import { TaskManager } from './manager';
import { AdapterRegistry, MockWorkerProviderAdapter } from './adapters/logical';
import { MockWorkerAdapter } from './adapters/worker';
import { parseId, parseTaskInput } from '../shared/validation';
import { PolicyStore } from './policy/store';
import { validateConfig } from './policy/routing';
let window: BrowserWindow | null = null;
let manager: TaskManager;
let quitting = false;
let commands:CommandHandler;
let localIPC: {close():Promise<void>} | undefined;
const rendererPath=join(__dirname,'../renderer/index.html');
const rendererUrl=pathToFileURL(rendererPath).href;
const lock=app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
 app.on('second-instance',() => { window?.show(); window?.focus(); });
 app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // No remote resources, HTTP bridge, or renderer network access in this MVP.
  session.defaultSession.webRequest.onBeforeRequest((details,callback) => callback({cancel:!details.url.startsWith('file://')}));
  const store=new TaskStore(join(app.getPath('userData'),'tasks.v1.json')); store.recover();
  const providers=new AdapterRegistry<MockWorkerProviderAdapter>().register(new MockWorkerProviderAdapter(new MockWorkerAdapter(process.execPath,join(__dirname,'../workers/mock-worker.mjs'))));
  manager=new TaskManager(store,providers.resolve('mock-jsonl',['start']),() => window?.webContents.send('tasks:changed',{revision:store.revision}),60000,error => {
   console.error(error); dialog.showErrorBox('Weaver storage error',`Task history could not be saved. Restart after checking disk access. ${String(error)}`);
  });
  const secure = (handler: (...args: unknown[]) => unknown) => (event: IpcMainInvokeEvent, ...args: unknown[]) => {
   if (!window || event.sender!==window.webContents || event.senderFrame!==window.webContents.mainFrame || event.senderFrame.url!==rendererUrl) throw new Error('Untrusted IPC sender');
   return handler(...args);
  };
  const policy=new PolicyStore(join(app.getPath('userData'),'policy.v1.json'));
  commands=new CommandHandler(manager,policy);
  try{localIPC=await startLocalIPC(app.getPath('userData'),request=>commands.handle(request));commands.transportStatus='ready';}catch(error){commands.transportStatus='unavailable';console.error('Local CLI transport unavailable:',error instanceof Error?error.message:'unknown transport error');}
  ipcMain.handle('weaver:command',secure(request=>commands.handle(request)));
  const invoke=(command:string,args:Record<string,unknown>)=>{const response=commands.handle({apiVersion:'weaver.v1',commandId:randomUUID(),command,args});if(!response.ok)throw new Error(response.error!.message);return response.data as {id:string};};
  ipcMain.handle('policy:get',secure(() => policy.snapshot()));
  ipcMain.handle('policy:validate',secure(config => {
   if (Buffer.byteLength(JSON.stringify(config))>256*1024) throw new Error('Policy exceeds 256 KiB');
   return validateConfig(config);
  }));
  ipcMain.handle('policy:save',secure(input => {const snapshot=policy.save(input);commands.pump();return snapshot;}));
  ipcMain.handle('policy:preview',secure(input => policy.preview(input)));
  ipcMain.handle('tasks:list',secure(() => store.list()));
  ipcMain.handle('tasks:create',secure(input => store.get(invoke('tasks.create',parseTaskInput(input) as unknown as Record<string,unknown>).id)));
  ipcMain.handle('tasks:start',secure(id => store.get(invoke('workers.spawn',{taskId:parseId(id)}).id)));
  ipcMain.handle('tasks:cancel',secure(id => (invoke('tasks.cancel',{taskId:parseId(id)}),store.get(parseId(id)))));
  ipcMain.handle('app:capabilities',secure(() => ({worker:'Bundled mock JSONL worker only',owner:'Visible Herdr owner reference; manual handoff only',maxParallel:manager.maxParallel,storePath:store.path})));
  ipcMain.handle('tasks:import',secure(async () => {
   const selection=await dialog.showOpenDialog(window!,{title:'Import owner task handoff',properties:['openFile'],filters:[{name:'Weaver task JSON',extensions:['json']}]});
   if (selection.canceled || !selection.filePaths[0]) return null;
   const path=selection.filePaths[0]; const info=await stat(path);
   if (!info.isFile() || info.size>65536) throw new Error('Task handoff must be a JSON file under 64 KiB');
   return store.get(invoke('tasks.create',parseTaskInput(JSON.parse(await readFile(path,'utf8'))) as unknown as Record<string,unknown>).id);
  }));
  createWindow();
 }).catch(error => { console.error(error); dialog.showErrorBox('Weaver could not start',String(error)); app.exit(1); });
 app.on('activate',() => { if (manager && !window) createWindow(); });
 app.on('window-all-closed',() => { app.quit(); });
 app.on('before-quit',event => {
  if (quitting || !manager) return;
  event.preventDefault(); quitting=true;
  commands.draining=true;
  void Promise.all([manager.shutdown(),localIPC?.close()]).finally(() => app.quit());
 });
}
function createWindow(): void {
 window=new BrowserWindow({width:1240,height:840,minWidth:900,minHeight:650,backgroundColor:'#10141b',title:'Weaver',webPreferences:{preload:join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
 window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
 window.webContents.on('will-navigate',event => event.preventDefault());
 window.webContents.on('will-attach-webview',event => event.preventDefault());
 window.on('closed',() => { window=null; });
 void window.loadFile(rendererPath);
}
