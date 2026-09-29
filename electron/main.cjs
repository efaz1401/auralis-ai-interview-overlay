// Electron main process — transparent, frameless, always-on-top interview
// overlay. All visible opacity is CSS-driven in the renderer (Glacier two-
// slider system); the window itself stays fully transparent and frameless.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { app, BrowserWindow, globalShortcut, ipcMain, screen, desktopCapturer, session } = require("electron");
const path = require("path");

// In dev we point at the running Vite/Express server (ELECTRON_START_URL).
// In production we start the bundled Express server in-process.
const START_URL = process.env.ELECTRON_START_URL || "http://localhost:3000";
const isDev = !!process.env.ELECTRON_START_URL;
const SERVER_PORT = Number(process.env.PORT) || 3000;

let mainWindow = null;
let clickThrough = false;
let contentProtected = true; // stealth: hide overlay from screen capture / screen sharing
let isCompact = false;
let glassSupported = false;  // true when real OS blur (acrylic) is active

async function ensureServer() {
  if (isDev) return; // dev server is started separately via `npm run dev`
  process.env.ELECTRON_RUN = "1";
  process.env.NODE_ENV = "production";
  const serverPath = path.join(__dirname, "..", "dist", "server.cjs");
  const { startServer } = require(serverPath);
  await startServer({
    port: SERVER_PORT,
    mode: "production",
    distPath: path.join(__dirname, "..", "dist"),
  });
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const winWidth = Math.min(760, width - 40);
  const winHeight = Math.min(880, height - 80);

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: width - winWidth - 24,
    y: 40,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: "Auralis Interview Copilot",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // Real frosted glass: Windows 11 acrylic blurs the actual screen behind the
  // overlay. Feature-detected — any failure just means the renderer's
  // simulated-glass fallback stays active.
  try {
    if (process.platform === "win32" && typeof mainWindow.setBackgroundMaterial === "function") {
      mainWindow.setBackgroundMaterial("acrylic");
      glassSupported = true;
    }
  } catch (e) {
    glassSupported = false;
  }

  // Float above everything, including other full-screen apps / spaces.
  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Stealth: keep the overlay out of screen recordings and shared screens.
  try {
    mainWindow.setContentProtection(contentProtected);
  } catch (e) {
    /* not supported on this platform */
  }

  mainWindow.loadURL(START_URL);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function toggleVisibility() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) mainWindow.hide();
  else mainWindow.show();
}

function setClickThrough(value) {
  if (!mainWindow) return;
  clickThrough = value;
  // forward:true lets hover/scroll pass through while the window stays visible.
  mainWindow.setIgnoreMouseEvents(value, { forward: true });
  mainWindow.webContents.send("overlay:state", { clickThrough });
}

function setContentProtection(value) {
  if (!mainWindow) return;
  contentProtected = value;
  try {
    mainWindow.setContentProtection(value);
  } catch (e) {
    /* noop */
  }
  mainWindow.webContents.send("overlay:state", { contentProtected });
}

function moveWindow(dx, dy) {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  mainWindow.setPosition(x + dx, y + dy);
}

function resizeWindow(w, h) {
  if (!mainWindow) return;
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const newW = Math.min(Math.max(320, w), width);
  const newH = Math.min(Math.max(80, h), height);
  mainWindow.setSize(newW, newH);
}

function setCompactMode(compact) {
  if (!mainWindow) return;
  isCompact = compact;
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const winWidth = Math.min(760, width - 40);
  if (compact) {
    // Top bar (36px) + latest-answer strip (96px)
    mainWindow.setSize(winWidth, 140);
  } else {
    mainWindow.setSize(winWidth, Math.min(880, height - 80));
  }
  mainWindow.webContents.send("overlay:state", { isCompact: compact });
}

// Ask the renderer to step one of the two CSS alpha channels (glass / text).
function stepAlpha(kind, delta) {
  if (mainWindow) mainWindow.webContents.send("overlay:alphaStep", { kind, delta });
}

function triggerAnalyzeScreen() {
  if (mainWindow) {
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.webContents.send("overlay:analyzeScreen");
  }
}

function registerShortcuts() {
  globalShortcut.register("CommandOrControl+Shift+H", toggleVisibility);
  globalShortcut.register("CommandOrControl+Shift+Space", () => setClickThrough(!clickThrough));
  // Glass alpha (panel opacity)
  globalShortcut.register("CommandOrControl+Shift+Up", () => stepAlpha("glass", 0.1));
  globalShortcut.register("CommandOrControl+Shift+Down", () => stepAlpha("glass", -0.1));
  // Text alpha (chat/transcript opacity)
  globalShortcut.register("CommandOrControl+Alt+Up", () => stepAlpha("text", 0.1));
  globalShortcut.register("CommandOrControl+Alt+Down", () => stepAlpha("text", -0.1));
  globalShortcut.register("CommandOrControl+Shift+Left", () => moveWindow(-40, 0));
  globalShortcut.register("CommandOrControl+Shift+Right", () => moveWindow(40, 0));
  globalShortcut.register("CommandOrControl+Shift+C", () => setCompactMode(!isCompact));
  // Analyze Screen
  globalShortcut.register("CommandOrControl+Shift+A", triggerAnalyzeScreen);
}

// ----- IPC from the renderer (preload bridge) -----
ipcMain.handle("overlay:getState", () => ({
  clickThrough,
  contentProtected,
  isCompact,
  glassSupported,
}));
ipcMain.on("overlay:setClickThrough", (_e, v) => setClickThrough(!!v));
ipcMain.on("overlay:setContentProtection", (_e, v) => setContentProtection(!!v));
ipcMain.on("overlay:hide", () => mainWindow && mainWindow.hide());
ipcMain.on("overlay:minimize", () => mainWindow && mainWindow.minimize());
ipcMain.on("overlay:quit", () => app.quit());
ipcMain.on("overlay:move", (_e, dx, dy) => moveWindow(Number(dx), Number(dy)));
ipcMain.on("overlay:resize", (_e, w, h) => resizeWindow(Number(w), Number(h)));
ipcMain.on("overlay:setCompact", (_e, compact) => setCompactMode(!!compact));

// Screen/audio sources for system-audio capture. Only screens are returned —
// window sources cannot carry system audio.
ipcMain.handle("overlay:getSources", async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      fetchWindowIcons: false,
    });
    return sources.map((s) => ({ id: s.id, name: s.name }));
  } catch (e) {
    console.warn("[Auralis] desktopCapturer unavailable:", e);
    return [];
  }
});

// Analyze Screen: capture the primary screen as a downscaled PNG (max 1600px)
// and hand it to the renderer as base64 for the vision model.
ipcMain.handle("overlay:captureScreen", async () => {
  try {
    const primary = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1600, height: 1600 },
    });
    if (!sources.length) return { error: "No screen source available." };

    // Prefer the source that corresponds to the primary display.
    const source =
      sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];

    let image = source.thumbnail;
    if (image.isEmpty()) return { error: "Screen capture returned an empty image." };

    const size = image.getSize();
    const scale = Math.min(1, 1600 / Math.max(size.width, size.height));
    if (scale < 1) {
      image = image.resize({
        width: Math.round(size.width * scale),
        height: Math.round(size.height * scale),
        quality: "good",
      });
    }
    return { image: image.toPNG().toString("base64"), mimeType: "image/png" };
  } catch (e) {
    console.warn("[Auralis] screen capture failed:", e);
    return { error: e?.message || "Screen capture failed." };
  }
});

app.whenReady().then(async () => {
  // Allow media (mic, screen capture) requests from the renderer.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ["media", "audioCapture", "videoCapture", "desktopCapture", "screen"];
    callback(allowed.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return ["media", "audioCapture", "videoCapture", "desktopCapture", "screen"].includes(permission);
  });

  // Make navigator.mediaDevices.getDisplayMedia() work inside the overlay and
  // grant it SYSTEM AUDIO (loopback) with no picker.
  try {
    session.defaultSession.setDisplayMediaRequestHandler(
      async (_request, callback) => {
        try {
          const sources = await desktopCapturer.getSources({ types: ["screen"] });
          if (!sources.length) return callback({});
          callback({ video: sources[0], audio: "loopback" });
        } catch (e) {
          console.warn("[Auralis] display media request failed:", e);
          callback({});
        }
      },
      { useSystemPicker: false }
    );
  } catch (e) {
    console.warn("[Auralis] setDisplayMediaRequestHandler unavailable:", e);
  }

  await ensureServer();
  createWindow();
  registerShortcuts();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
