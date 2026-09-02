import { app, BrowserWindow, ipcMain, dialog, session, desktopCapturer, shell } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { LibraryKind, ReadResult, WriteResult, AppSettings } from '@shared/types';
import {
  listLibrary,
  readLibrary,
  writeLibrary,
  deleteLibrary,
  renameLibrary,
  libraryExists,
  importIntoLibrary,
  revealLibrary,
} from './library';
import { getSettings, setSettings, flushSettings } from './settings';

const isDev = !app.isPackaged;

/*
 * Chromium flags that make desktop-audio loopback available.
 *
 * The important one is `allow-loopback-in-peer-connection`: without it Chromium
 * refuses to hand out a loopback audio track. The rest widen the set of
 * capture paths Chromium is willing to consider on each platform.
 */
app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
app.commandLine.appendSwitch('enable-usermedia-screen-capturing');
app.commandLine.appendSwitch(
  'enable-features',
  'WebRTCAudioProcessing,AudioServiceOutOfProcess',
);
// The renderer does its own smoothing/AGC, so let Chromium hand us raw samples.
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

/*
 * Allow WebGL to fall back to software rendering.
 *
 * Chromium deprecated the automatic fallback, so without this flag a machine
 * with no usable GPU driver - a VM, an RDP session, a bare CI runner, or a
 * laptop whose driver Chromium has blocklisted - gets no WebGL2 context at all
 * and the app cannot start. With it, those machines run (slowly) instead of
 * showing an error.
 *
 * This does not force software rendering: hardware acceleration is still used
 * whenever it is available, so it costs nothing on a normal desktop.
 */
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#05060a',
    title: 'Domino',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The visualizer is the whole point; never let it be throttled offscreen.
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  /*
   * The user can leave fullscreen by ways we never hear about directly - the
   * OS chrome, a window-manager shortcut, macOS gestures. Telling the renderer
   * lets it bring its own UI back, instead of stranding the app with hidden
   * controls in a windowed frame.
   */
  mainWindow.on('leave-full-screen', () => {
    mainWindow?.webContents.send('app:command', 'fullscreen-changed', false);
  });
  mainWindow.on('enter-full-screen', () => {
    mainWindow?.webContents.send('app:command', 'fullscreen-changed', true);
  });

  // Keep navigation inside the app; open any external link in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  if (process.argv.includes('--devtools')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  if (process.argv.includes('--selftest')) {
    void runSelfTest(mainWindow);
  }
}

/**
 * `Domino.exe --selftest` - verify a packaged build actually works.
 *
 * Packaging changes `app.isPackaged`, which changes where the bundled preset
 * library is looked up, and an asar bundle can omit files a dev run had on
 * disk. Both failures look like an app that starts fine and then has an empty
 * library, so the only way to be sure a release is good is to run the shipped
 * binary and ask it what it found.
 */
async function runSelfTest(win: BrowserWindow): Promise<void> {
  const problems: string[] = [];
  win.webContents.on('console-message', (...args: unknown[]) => {
    const details = args[1] as { level?: string; message?: string } | undefined;
    if (details && typeof details === 'object' && details.level === 'error') {
      problems.push(String(details.message));
    }
  });

  await new Promise<void>((resolve) => {
    if (!win.webContents.isLoading()) return resolve();
    win.webContents.once('did-finish-load', () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 6000));

  try {
    const probe = (await win.webContents.executeJavaScript(`
      (() => {
        const canvas = document.getElementById('canvas');
        return {
          gl: Boolean(canvas && canvas.getContext('webgl2')),
          width: canvas ? canvas.width : 0,
          entries: document.querySelectorAll('.lib-item').length,
          title: document.getElementById('hud-title').textContent,
          fps: document.getElementById('stat-fps').textContent,
          fatal: document.body.innerHTML.includes('could not start'),
        };
      })()
    `)) as {
      gl: boolean;
      width: number;
      entries: number;
      title: string;
      fps: string;
      fatal: boolean;
    };

    if (probe.fatal) problems.push('renderer failed to start');
    if (!probe.gl) problems.push('no WebGL2 context');
    if (probe.width <= 0) problems.push('drawing buffer has no size');
    if (probe.entries <= 0) problems.push('bundled library is empty (resource path wrong?)');
    if (!probe.title || probe.title === 'No visual loaded') problems.push('no visual loaded');
    if (probe.fps.startsWith('--')) problems.push('render loop not running');

    console.log(
      `selftest: packaged=${app.isPackaged} resources=${process.resourcesPath} ` +
        `library=${probe.entries} visual="${probe.title}" fps=${probe.fps}`,
    );
  } catch (err) {
    problems.push(`probe failed: ${(err as Error).message}`);
  }

  if (problems.length > 0) {
    console.log(`SELFTEST FAILED:\n  ${problems.join('\n  ')}`);
  } else {
    console.log('SELFTEST PASSED');
  }
  app.exit(problems.length === 0 ? 0 : 1);
}

/**
 * Grant media capture without prompting.
 *
 * A visualizer that has to ask permission every launch is useless, and the app
 * is a local desktop binary the user launched deliberately - there is no remote
 * origin that could abuse this.
 */
function installPermissionHandlers(): void {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'audioCapture', 'videoCapture', 'display-capture', 'fullscreen'];
    callback(allowed.includes(permission));
  });

  ses.setPermissionCheckHandler((_wc, permission) =>
    ['media', 'audioCapture', 'display-capture', 'fullscreen'].includes(permission),
  );

  /*
   * This is what makes "hear everything the computer plays" work.
   *
   * When the renderer calls getDisplayMedia(), we answer with `audio: 'loopback'`,
   * which is Chromium's WASAPI render-endpoint loopback on Windows (and the
   * system audio tap on macOS 13+/Linux where available). The user never sees a
   * source picker, and we get the full output mix rather than one tab or window.
   *
   * A video source still has to be supplied because getDisplayMedia is defined
   * in terms of video; the renderer stops that track immediately, which leaves
   * the audio track running on its own.
   */
  ses.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          if (sources.length === 0) {
            callback({});
            return;
          }
          callback({ video: sources[0], audio: 'loopback' });
        })
        .catch(() => callback({}));
    },
    // We answer the request ourselves; don't raise the OS picker.
    { useSystemPicker: false },
  );
}

/* ----------------------------- IPC surface ----------------------------- */

function ok<T extends object>(extra: T): T & { ok: true } {
  return { ok: true, ...extra };
}
function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

const VALID_KINDS: LibraryKind[] = ['shader', 'milk', 'preset'];
function assertKind(kind: unknown): asserts kind is LibraryKind {
  if (typeof kind !== 'string' || !VALID_KINDS.includes(kind as LibraryKind)) {
    throw new Error(`Unknown library kind: ${String(kind)}`);
  }
}

function registerIpc(): void {
  ipcMain.handle('library:list', async (_e, kind: unknown) => {
    assertKind(kind);
    return await listLibrary(kind);
  });

  ipcMain.handle('library:read', async (_e, kind: unknown, id: unknown): Promise<ReadResult> => {
    try {
      assertKind(kind);
      const content = await readLibrary(kind, String(id));
      return ok({ content });
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(
    'library:write',
    async (_e, kind: unknown, id: unknown, content: unknown): Promise<WriteResult> => {
      try {
        assertKind(kind);
        if (typeof content !== 'string') throw new Error('content must be a string');
        if (content.length > 8 * 1024 * 1024) throw new Error('content too large');
        const written = await writeLibrary(kind, String(id), content);
        return ok({ path: written });
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle('library:delete', async (_e, kind: unknown, id: unknown): Promise<WriteResult> => {
    try {
      assertKind(kind);
      await deleteLibrary(kind, String(id));
      return ok({});
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(
    'library:rename',
    async (_e, kind: unknown, fromId: unknown, toId: unknown): Promise<WriteResult> => {
      try {
        assertKind(kind);
        const written = await renameLibrary(kind, String(fromId), String(toId));
        return ok({ path: written });
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle('library:exists', async (_e, kind: unknown, id: unknown): Promise<boolean> => {
    assertKind(kind);
    return await libraryExists(kind, String(id));
  });

  ipcMain.handle('library:import', async (_e, kind: unknown) => {
    try {
      assertKind(kind);
      return await importIntoLibrary(kind);
    } catch (err) {
      return { imported: 0, skipped: 0, ...fail(err) };
    }
  });

  ipcMain.handle('library:reveal', async (_e, kind: unknown) => {
    assertKind(kind);
    await revealLibrary(kind);
  });

  ipcMain.handle('dialog:openAudioFile', async (): Promise<string | null> => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Audio File',
      properties: ['openFile'],
      filters: [
        { name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'webm'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle(
    'dialog:saveText',
    async (_e, defaultName: unknown, content: unknown): Promise<WriteResult> => {
      try {
        if (!mainWindow) throw new Error('no window');
        if (typeof content !== 'string') throw new Error('content must be a string');
        const result = await dialog.showSaveDialog(mainWindow, {
          title: 'Save',
          defaultPath: String(defaultName ?? 'untitled.txt'),
        });
        if (result.canceled || !result.filePath) return { ok: false, error: 'canceled' };
        await fs.writeFile(result.filePath, content, 'utf8');
        return ok({ path: result.filePath });
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle('settings:get', async (): Promise<AppSettings> => await getSettings());
  ipcMain.handle(
    'settings:set',
    async (_e, patch: unknown): Promise<AppSettings> =>
      await setSettings((patch ?? {}) as Partial<AppSettings>),
  );

  ipcMain.handle('window:toggleFullscreen', () => {
    if (!mainWindow) return false;
    const next = !mainWindow.isFullScreen();
    mainWindow.setFullScreen(next);
    return next;
  });
  ipcMain.handle('window:setFullscreen', (_e, v: unknown) => {
    if (!mainWindow) return false;
    const next = Boolean(v);
    if (mainWindow.isFullScreen() !== next) mainWindow.setFullScreen(next);
    return next;
  });
  ipcMain.handle('window:isFullscreen', () => mainWindow?.isFullScreen() ?? false);
  ipcMain.handle('window:setAlwaysOnTop', (_e, v: unknown) => {
    if (!mainWindow) return false;
    const next = Boolean(v);
    mainWindow.setAlwaysOnTop(next);
    return next;
  });
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:close', () => mainWindow?.close());
}

/* ------------------------------ lifecycle ------------------------------ */

// One instance only: two copies fighting over the loopback tap is never useful.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    installPermissionHandlers();
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    void flushSettings();
  });
}
