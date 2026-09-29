// Preload: safe bridge exposing overlay controls to the React renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronOverlay", {
  isElectron: true,
  getState: () => ipcRenderer.invoke("overlay:getState"),
  setClickThrough: (v) => ipcRenderer.send("overlay:setClickThrough", v),
  setContentProtection: (v) => ipcRenderer.send("overlay:setContentProtection", v),
  hide: () => ipcRenderer.send("overlay:hide"),
  minimize: () => ipcRenderer.send("overlay:minimize"),
  quit: () => ipcRenderer.send("overlay:quit"),
  move: (dx, dy) => ipcRenderer.send("overlay:move", dx, dy),
  resize: (w, h) => ipcRenderer.send("overlay:resize", w, h),
  setCompact: (compact) => ipcRenderer.send("overlay:setCompact", compact),
  // System-audio capture sources (screens only)
  getSources: () => ipcRenderer.invoke("overlay:getSources"),
  // Analyze Screen: downscaled PNG of the primary screen as base64
  captureScreen: () => ipcRenderer.invoke("overlay:captureScreen"),
  onState: (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on("overlay:state", listener);
    return () => ipcRenderer.removeListener("overlay:state", listener);
  },
  // Alpha hotkeys: { kind: "glass" | "text", delta: ±0.1 }
  onAlphaStep: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on("overlay:alphaStep", listener);
    return () => ipcRenderer.removeListener("overlay:alphaStep", listener);
  },
  // Global Ctrl+Shift+A hotkey
  onAnalyzeScreen: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("overlay:analyzeScreen", listener);
    return () => ipcRenderer.removeListener("overlay:analyzeScreen", listener);
  },
});
