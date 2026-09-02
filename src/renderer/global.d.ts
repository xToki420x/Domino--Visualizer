import type { DominoApi } from '@shared/types';

declare global {
  interface Window {
    /** Exposed by the preload script. */
    domino: DominoApi;
  }
}

export {};
