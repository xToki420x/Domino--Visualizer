import { existsSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * Main-process side of the virtual camera.
 *
 * The native addon lives here rather than in the renderer because loading a
 * .node module in a renderer would mean turning off the sandbox for the sake
 * of one feature. Frames arrive over IPC instead, already packed as NV12 by
 * the GPU, so the main process only forwards a buffer.
 */

export interface VirtualCameraStatus {
  /** The addon compiled and loaded on this machine. */
  available: boolean;
  /** The media source is registered machine-wide and its DLL still exists. */
  registered: boolean;
  running: boolean;
  width: number;
  height: number;
  fps: number;
  framesWritten: number;
  registeredPath: string;
  /** Path a user would hand to regsvr32; empty when the DLL is missing. */
  sourcePath: string;
  error: string;
}

interface NativeResult {
  ok: boolean;
  error?: string;
}

interface NativeAddon {
  registerSource(dllPath: string): NativeResult;
  registerSourceElevated(dllPath: string, unregister: boolean): NativeResult;
  unregisterSource(): NativeResult;
  isRegistered(): { registered: boolean; path: string };
  start(width: number, height: number, fps: number, name: string): NativeResult;
  stop(): NativeResult;
  isRunning(): boolean;
  writeFrame(frame: Buffer): NativeResult;
  listCameras(): string[];
}

let addon: NativeAddon | null = null;
let loadError = '';
let loadAttempted = false;

let running = false;
let width = 1280;
let height = 720;
let fps = 30;
let framesWritten = 0;
let lastError = '';

/**
 * Candidate locations for a native file, covering dev runs and the packaged
 * app. Same reasoning as the preset library: guessing one path wrong shows up
 * as a feature that silently does nothing.
 */
function nativeCandidates(fileName: string): string[] {
  return app.isPackaged
    ? [
        path.join(process.resourcesPath, 'native', fileName),
        path.join(process.resourcesPath, fileName),
      ]
    : [
        path.resolve(__dirname, '../../native/build/Release', fileName),
        path.resolve(process.cwd(), 'native/build/Release', fileName),
        path.join(app.getAppPath(), 'native/build/Release', fileName),
      ];
}

function findNative(fileName: string): string {
  for (const candidate of nativeCandidates(fileName)) {
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

/** The media source DLL, or an empty string when this build has none. */
export function sourceDllPath(): string {
  return findNative('domino_vcam_source.dll');
}

function load(): NativeAddon | null {
  if (loadAttempted) return addon;
  loadAttempted = true;

  if (process.platform !== 'win32') {
    loadError = 'The virtual camera is only available on Windows.';
    return null;
  }

  const modulePath = findNative('domino_vcam.node');
  if (!modulePath) {
    loadError = 'The virtual camera module was not built into this copy of Domino.';
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    addon = require(modulePath) as NativeAddon;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    addon = null;
  }
  return addon;
}

export function getStatus(): VirtualCameraStatus {
  const native = load();
  const registration = native?.isRegistered() ?? { registered: false, path: '' };
  return {
    available: native !== null,
    registered: registration.registered,
    running,
    width,
    height,
    fps,
    framesWritten,
    registeredPath: registration.path,
    sourcePath: sourceDllPath(),
    error: lastError || loadError,
  };
}

export function start(
  requestedWidth: number,
  requestedHeight: number,
  requestedFps: number,
  name: string,
): VirtualCameraStatus {
  const native = load();
  lastError = '';
  if (!native) return getStatus();

  if (!native.isRegistered().registered) {
    // Say what has to happen rather than only that it failed. Registration is
    // a one-time administrator step, and without this the user has no way to
    // know that from the app.
    lastError =
      'The camera driver is not registered yet. Use "Register camera driver" ' +
      'first - it needs administrator rights once.';
    return getStatus();
  }

  width = Math.max(2, Math.floor(requestedWidth / 2) * 2);
  height = Math.max(2, Math.floor(requestedHeight / 2) * 2);
  fps = Math.max(1, Math.min(60, Math.round(requestedFps)));

  const result = native.start(width, height, fps, name || 'Domino');
  running = result.ok;
  framesWritten = 0;
  if (!result.ok) lastError = result.error ?? 'The virtual camera would not start.';
  return getStatus();
}

export function stop(): VirtualCameraStatus {
  const native = load();
  if (native) native.stop();
  running = false;
  return getStatus();
}

/**
 * Forward one NV12 frame.
 *
 * Deliberately quiet on failure: this runs thirty times a second, and a
 * per-frame error dialog would be unusable. The first failure is kept for the
 * status panel and the rest are dropped.
 */
export function writeFrame(frame: Buffer): void {
  const native = load();
  if (!native || !running) return;

  const result = native.writeFrame(frame);
  if (result.ok) {
    framesWritten++;
  } else if (!lastError) {
    lastError = result.error ?? 'A frame could not be published.';
  }
}

/**
 * Register the media source with Windows, prompting for administrator rights.
 *
 * This is a deliberate, user-initiated step rather than something the app does
 * at startup: it writes a machine-wide COM registration, and an app that
 * quietly asks for elevation the first time it runs has earned suspicion.
 */
export function register(unregister = false): VirtualCameraStatus {
  const native = load();
  lastError = '';
  if (!native) return getStatus();

  const dll = sourceDllPath();
  if (!dll) {
    lastError = 'The camera driver was not included in this copy of Domino.';
    return getStatus();
  }

  const result = native.registerSourceElevated(dll, unregister);
  if (!result.ok) lastError = result.error ?? 'Registration did not complete.';
  return getStatus();
}

export function listCameras(): string[] {
  const native = load();
  return native ? native.listCameras() : [];
}

/** Stop publishing when the app quits, so no camera is left behind. */
export function shutdown(): void {
  if (running) stop();
}
