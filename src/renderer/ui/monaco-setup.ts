import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

/**
 * Monaco resolves its workers through this global, and it has to be set before
 * the editor is first created. Importing this module ahead of `monaco-editor`
 * guarantees that ordering.
 *
 * Domino only edits GLSL and EEL, both of which are registered as custom
 * Monarch languages with no language service, so the base editor worker covers
 * every label Monaco might ask for.
 */
declare global {
  interface Window {
    MonacoEnvironment?: { getWorker: (moduleId: string, label: string) => Worker };
  }
}

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

export {};
