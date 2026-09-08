import { contextBridge, ipcRenderer } from 'electron';

/** Baked in by the build; see electron.vite.config.ts. */
declare const __APP_VERSION__: string;

/**
 * The splash window's only contact with the outside.
 *
 * Kept separate from the main preload, and deliberately tiny: this loads
 * before anything else in the app, and pulling in the full API surface would
 * make the one window whose whole job is to appear instantly the slowest to
 * appear.
 */
contextBridge.exposeInMainWorld('dominoSplash', {
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '',

  /** Called as the app reports what it is doing, with an optional 0..1 hint. */
  onStage: (cb: (stage: string, fraction?: number) => void): void => {
    ipcRenderer.on('splash:stage', (_e, stage: string, fraction?: number) =>
      cb(stage, fraction),
    );
  },

  /** Called once the app is genuinely usable, so the panel can fade out. */
  onDone: (cb: () => void): void => {
    ipcRenderer.on('splash:done', () => cb());
  },
});
