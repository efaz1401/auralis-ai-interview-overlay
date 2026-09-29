// Type declarations for the Electron preload bridge (window.electronOverlay).
// Available only when running inside the packaged Electron app.

interface ElectronOverlayState {
  clickThrough?: boolean;
  contentProtected?: boolean;
  isCompact?: boolean;
  /** True when the OS provides real frosted glass (Windows 11 acrylic). */
  glassSupported?: boolean;
}

interface ElectronScreenCapture {
  image?: string;
  mimeType?: string;
  error?: string;
}

interface ElectronOverlayBridge {
  isElectron: true;
  getState(): Promise<Required<ElectronOverlayState>>;
  setClickThrough(value: boolean): void;
  setContentProtection(value: boolean): void;
  hide(): void;
  minimize(): void;
  quit(): void;
  move(dx: number, dy: number): void;
  resize(w: number, h: number): void;
  setCompact(compact: boolean): void;
  getSources(): Promise<Array<{ id: string; name: string }>>;
  captureScreen(): Promise<ElectronScreenCapture>;
  onState(callback: (state: ElectronOverlayState) => void): () => void;
  onAlphaStep(callback: (payload: { kind: "glass" | "text"; delta: number }) => void): () => void;
  onAnalyzeScreen(callback: () => void): () => void;
}

declare global {
  interface Window {
    electronOverlay?: ElectronOverlayBridge;
  }
}

export {};
