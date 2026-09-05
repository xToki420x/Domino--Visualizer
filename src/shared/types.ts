/**
 * Shared types crossing the main <-> renderer boundary.
 * Keep this file dependency-free so both sides can import it.
 */

export type LibraryKind = 'shader' | 'milk' | 'preset';

export interface LibraryEntry {
  /** Stable id: the path relative to the library root, using forward slashes. */
  id: string;
  /** Display name (basename without extension). */
  name: string;
  /** Absolute path on disk. */
  path: string;
  kind: LibraryKind;
  /** Folder path relative to the root, '' for top level. Used for grouping in the UI. */
  group: string;
  /** True when the file lives in the app's bundled resources rather than user data. */
  builtin: boolean;
  sizeBytes: number;
  modifiedMs: number;
}

export interface ReadResult {
  ok: boolean;
  content?: string;
  error?: string;
}

export interface WriteResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export interface ImportResult {
  ok: boolean;
  imported: number;
  skipped: number;
  error?: string;
}

export interface AudioDeviceInfo {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
}

/** Persisted user settings. */
export interface AppSettings {
  sensitivity: number;
  smoothing: number;
  fftSize: number;
  gain: number;
  beatSensitivity: number;

  /* Image / display stage */
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
  toneMap: boolean;
  vignette: number;

  renderScale: number;
  targetFps: number;
  meshX: number;
  meshY: number;
  autoPlay: boolean;
  autoPlaySeconds: number;
  blendSeconds: number;
  showFps: boolean;
  lastSource: 'loopback' | 'microphone' | 'device' | 'file' | 'none';
  lastVisual: { kind: LibraryKind; id: string } | null;
  /**
   * Free key from https://www.shadertoy.com/howto#q2, needed to import by link.
   * Stored locally in settings.json and only ever sent to shadertoy.com.
   */
  shadertoyApiKey: string;

  /* Camera input */
  cameraEnabled: boolean;
  cameraDeviceId: string;
  cameraMirror: boolean;

  /* Camera output: Domino published as a webcam */
  virtualCameraEnabled: boolean;
  /** "WIDTHxHEIGHT". Fixed for the session - consumers negotiate it once. */
  virtualCameraSize: string;
  virtualCameraFps: number;
  /** What the device is called in other applications. */
  virtualCameraName: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  sensitivity: 1.0,
  smoothing: 0.72,
  fftSize: 2048,
  gain: 1.0,
  beatSensitivity: 1.0,

  // Defaults chosen so a typical preset lands at a comfortable level rather
  // than clipping. See PostProcessor for why tone mapping is on by default.
  brightness: 0.85,
  contrast: 1.0,
  saturation: 1.0,
  gamma: 1.0,
  toneMap: true,
  vignette: 0.12,

  renderScale: 1.0,
  targetFps: 60,
  meshX: 48,
  meshY: 36,
  autoPlay: false,
  autoPlaySeconds: 30,
  blendSeconds: 2.7,
  showFps: true,
  lastSource: 'none',
  lastVisual: null,
  shadertoyApiKey: '',
  cameraEnabled: false,
  cameraDeviceId: '',
  cameraMirror: true,

  virtualCameraEnabled: false,
  virtualCameraSize: '1280x720',
  virtualCameraFps: 30,
  virtualCameraName: 'Domino Visualizer',
};

/** What the main process knows about the Windows virtual camera. */
export interface VirtualCameraStatus {
  /** The native module compiled and loaded on this machine. */
  available: boolean;
  /** The media source is registered machine-wide and its DLL still exists. */
  registered: boolean;
  running: boolean;
  width: number;
  height: number;
  fps: number;
  framesWritten: number;
  registeredPath: string;
  /** The DLL a user would hand to regsvr32; empty when this build has none. */
  sourcePath: string;
  error: string;
}

/** The API surface exposed on `window.domino` by the preload script. */
export interface DominoApi {
  platform: NodeJS.Platform;
  versions: { electron: string; chrome: string; node: string };

  library: {
    list(kind: LibraryKind): Promise<LibraryEntry[]>;
    read(kind: LibraryKind, id: string): Promise<ReadResult>;
    write(kind: LibraryKind, id: string, content: string): Promise<WriteResult>;
    delete(kind: LibraryKind, id: string): Promise<WriteResult>;
    /** Renames within the library. Renaming a builtin forks it into user space. */
    rename(kind: LibraryKind, fromId: string, toId: string): Promise<WriteResult>;
    /** True when the id is already taken by a user or builtin file. */
    exists(kind: LibraryKind, id: string): Promise<boolean>;
    /** Opens a folder picker and copies matching files into the user library. */
    import(kind: LibraryKind): Promise<ImportResult>;
    /** Reveals the user library folder in the OS file manager. */
    reveal(kind: LibraryKind): Promise<void>;
  };

  /** Fetches a shader from shadertoy.com by id, using the stored API key. */
  shadertoy: {
    fetch(id: string): Promise<{ ok: boolean; shader?: unknown; error?: string }>;
  };

  dialog: {
    openAudioFile(): Promise<string | null>;
    saveText(defaultName: string, content: string): Promise<WriteResult>;
  };

  settings: {
    get(): Promise<AppSettings>;
    set(patch: Partial<AppSettings>): Promise<AppSettings>;
  };

  window: {
    toggleFullscreen(): Promise<boolean>;
    setFullscreen(v: boolean): Promise<boolean>;
    isFullscreen(): Promise<boolean>;
    setAlwaysOnTop(v: boolean): Promise<boolean>;
    minimize(): Promise<void>;
    close(): Promise<void>;
  };

  /** Publishes the visualiser as a webcam other applications can select. */
  virtualCamera: {
    status(): Promise<VirtualCameraStatus>;
    start(width: number, height: number, fps: number, name: string): Promise<VirtualCameraStatus>;
    stop(): Promise<VirtualCameraStatus>;
    /** Prompts for administrator rights to register the camera driver. */
    register(unregister?: boolean): Promise<VirtualCameraStatus>;
    /** Every capture device Windows can see, for confirming ours appeared. */
    listCameras(): Promise<string[]>;
    /** Fire-and-forget: one NV12 frame, already packed by the GPU. */
    sendFrame(frame: Uint8Array): void;
  };

  /** Fires when the main process asks the renderer to do something (menu, hotkey). */
  onCommand(cb: (command: string, payload?: unknown) => void): () => void;
}
