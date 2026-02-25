import electronPkg from 'electron';
const { ipcRenderer, contextBridge } = electronPkg;

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('electronAPI', {
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
    scanDirectory: (dirPath: string) => ipcRenderer.invoke('app:scanDirectory', dirPath),
    copyFiles: (filePaths: string[], targetDir: string) => ipcRenderer.invoke('app:copyFiles', filePaths, targetDir),
    getDirectoryStats: (dirPath: string) => ipcRenderer.invoke('app:getDirectoryStats', dirPath),
    getThumbnail: (filePath: string) => ipcRenderer.invoke('app:getThumbnail', filePath),
    minimize: () => ipcRenderer.send('app:minimize'),
    maximize: () => ipcRenderer.send('app:maximize'),
    close: () => ipcRenderer.send('app:close'),
});
