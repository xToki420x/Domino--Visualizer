import './monaco-setup';
import * as monaco from 'monaco-editor';
import type { ShaderError } from '../gl/Program';

/**
 * The code editor: a Monaco instance with syntax highlighting for both GLSL and
 * MilkDrop's EEL, a tab strip for multi-document presets, and inline error
 * markers driven by the compiler.
 *
 * The editor keeps a model per document so undo history, cursor position and
 * scroll survive tab switches - essential when you are bouncing between a warp
 * shader and its per-frame equations while iterating on a look.
 */

export interface EditorDocument {
  id: string;
  label: string;
  language: 'glsl' | 'eel';
  value: string;
}

const GLSL_KEYWORDS = [
  'void', 'bool', 'int', 'uint', 'float', 'double',
  'vec2', 'vec3', 'vec4', 'bvec2', 'bvec3', 'bvec4',
  'ivec2', 'ivec3', 'ivec4', 'uvec2', 'uvec3', 'uvec4',
  'mat2', 'mat3', 'mat4', 'mat2x2', 'mat2x3', 'mat2x4',
  'mat3x2', 'mat3x3', 'mat3x4', 'mat4x2', 'mat4x3', 'mat4x4',
  'sampler2D', 'samplerCube', 'sampler3D', 'sampler2DArray',
  'if', 'else', 'for', 'while', 'do', 'break', 'continue', 'return', 'discard',
  'switch', 'case', 'default',
  'in', 'out', 'inout', 'uniform', 'varying', 'attribute', 'const',
  'struct', 'layout', 'precision', 'highp', 'mediump', 'lowp', 'flat', 'smooth',
  'true', 'false',
];

const GLSL_BUILTINS = [
  'abs', 'acos', 'all', 'any', 'asin', 'atan', 'ceil', 'clamp', 'cos', 'cosh',
  'cross', 'degrees', 'dFdx', 'dFdy', 'distance', 'dot', 'equal', 'exp', 'exp2',
  'faceforward', 'floor', 'fract', 'fwidth', 'greaterThan', 'inverse',
  'inversesqrt', 'length', 'lessThan', 'log', 'log2', 'matrixCompMult', 'max',
  'min', 'mix', 'mod', 'modf', 'normalize', 'not', 'pow', 'radians', 'reflect',
  'refract', 'round', 'sign', 'sin', 'sinh', 'smoothstep', 'sqrt', 'step',
  'tan', 'tanh', 'texture', 'textureLod', 'textureSize', 'transpose', 'trunc',
  'gl_FragCoord', 'gl_Position', 'gl_PointSize', 'gl_FrontFacing',
];

const MILKY_UNIFORMS = [
  'iResolution', 'iTime', 'iTimeDelta', 'iFrame', 'iFrameRate', 'iMouse',
  'iDate', 'iSampleRate', 'iChannel0', 'iChannel1', 'iChannel2', 'iChannel3',
  'iChannelTime', 'iChannelResolution', 'iAudioData', 'iBass', 'iMid', 'iTreb',
  'iBassAtt', 'iMidAtt', 'iTrebAtt', 'iVolume', 'iVolumeAtt', 'iBeat',
  'iBeatPulse', 'iBPM', 'iRMS', 'iPeak', 'iSensitivity', 'iAudioLevel',
  'dominoSpectrum', 'dominoWave', 'mainImage',
];

const EEL_FUNCTIONS = [
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sqrt', 'sqr', 'pow',
  'exp', 'log', 'log10', 'abs', 'sign', 'min', 'max', 'floor', 'ceil', 'int',
  'frac', 'invsqrt', 'rand', 'sigmoid', 'bnot', 'band', 'bor', 'above', 'below',
  'equal', 'if', 'loop', 'while', 'exec2', 'exec3', 'assign', 'megabuf',
  'gmegabuf',
];

const EEL_VARIABLES = [
  'time', 'fps', 'frame', 'progress', 'bass', 'mid', 'treb', 'bass_att',
  'mid_att', 'treb_att', 'vol', 'vol_att', 'meshx', 'meshy', 'aspectx',
  'aspecty', 'pixelsx', 'pixelsy', 'x', 'y', 'rad', 'ang', 'zoom', 'zoomexp',
  'rot', 'warp', 'cx', 'cy', 'dx', 'dy', 'sx', 'sy', 'decay', 'gamma',
  'echo_zoom', 'echo_alpha', 'echo_orient', 'wave_mode', 'wave_r', 'wave_g',
  'wave_b', 'wave_a', 'wave_x', 'wave_y', 'wave_mystery', 'wave_scale',
  'wave_smoothing', 'monitor', 'sample', 'value1', 'value2', 'instance',
];

let languagesRegistered = false;

function registerLanguages(): void {
  if (languagesRegistered) return;
  languagesRegistered = true;

  monaco.languages.register({ id: 'glsl' });
  monaco.languages.setMonarchTokensProvider('glsl', {
    keywords: GLSL_KEYWORDS,
    builtins: [...GLSL_BUILTINS, ...MILKY_UNIFORMS],
    tokenizer: {
      root: [
        [/#\s*\w+/, 'keyword.directive'],
        [
          /[a-zA-Z_]\w*/,
          {
            cases: {
              '@keywords': 'keyword',
              '@builtins': 'predefined',
              '@default': 'identifier',
            },
          },
        ],
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/\d*\.\d+([eE][-+]?\d+)?[fF]?/, 'number.float'],
        [/0[xX][0-9a-fA-F]+/, 'number.hex'],
        [/\d+[fFuU]?/, 'number'],
        [/[{}()[\]]/, '@brackets'],
        [/[<>=!+\-*/%&|^~?:]+/, 'operator'],
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
    },
  });

  monaco.languages.register({ id: 'eel' });
  monaco.languages.setMonarchTokensProvider('eel', {
    functions: EEL_FUNCTIONS,
    variables: EEL_VARIABLES,
    ignoreCase: true,
    tokenizer: {
      root: [
        [
          /[a-zA-Z_]\w*/,
          {
            cases: {
              '@functions': 'keyword',
              '@variables': 'predefined',
              '@default': 'identifier',
            },
          },
        ],
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/\$[xX][0-9a-fA-F]+/, 'number.hex'],
        [/\$\w+/, 'constant'],
        [/\d*\.\d+([eE][-+]?\d+)?/, 'number.float'],
        [/\d+/, 'number'],
        [/[()]/, '@brackets'],
        [/[<>=!+\-*/%&|^~?:;,]+/, 'operator'],
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
    },
  });

  monaco.editor.defineTheme('domino', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: 'b388ff' },
      { token: 'keyword.directive', foreground: 'ff9de2' },
      { token: 'predefined', foreground: '6ee7ff' },
      { token: 'constant', foreground: '6ee7ff' },
      { token: 'comment', foreground: '5a6178', fontStyle: 'italic' },
      { token: 'number', foreground: '5ee9a4' },
      { token: 'number.float', foreground: '5ee9a4' },
      { token: 'number.hex', foreground: '5ee9a4' },
      { token: 'operator', foreground: 'a8b0c8' },
      { token: 'identifier', foreground: 'e6e9f2' },
    ],
    colors: {
      'editor.background': '#080a11',
      'editor.lineHighlightBackground': '#10131d',
      'editorLineNumber.foreground': '#3a4159',
      'editorLineNumber.activeForeground': '#8a91a8',
      'editorCursor.foreground': '#6ee7ff',
      'editor.selectionBackground': '#1e3a4a',
      'editorIndentGuide.background1': '#161a26',
    },
  });
}

export class CodeEditor {
  private container: HTMLElement;
  private tabsHost: HTMLElement;
  private editor: monaco.editor.IStandaloneCodeEditor | null = null;
  private models = new Map<string, monaco.editor.ITextModel>();
  private documents: EditorDocument[] = [];
  private activeId: string | null = null;

  onChange: ((id: string, value: string) => void) | null = null;
  onApply: (() => void) | null = null;
  onSave: (() => void) | null = null;
  onSaveAs: (() => void) | null = null;
  /** Fires whenever the visible document changes, including programmatically. */
  onActivate: ((id: string) => void) | null = null;

  constructor(container: HTMLElement, tabsHost: HTMLElement) {
    this.container = container;
    this.tabsHost = tabsHost;
    registerLanguages();
  }

  private ensureEditor(): monaco.editor.IStandaloneCodeEditor {
    if (this.editor) return this.editor;

    this.editor = monaco.editor.create(this.container, {
      theme: 'domino',
      automaticLayout: true,
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'JetBrains Mono', 'Consolas', monospace",
      fontLigatures: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      smoothScrolling: true,
      tabSize: 2,
      wordWrap: 'off',
      bracketPairColorization: { enabled: true },
      padding: { top: 10, bottom: 10 },
    });

    // Ctrl+Enter recompiles without saving - the core live-coding gesture.
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      this.onApply?.();
    });
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      this.onSave?.();
    });
    this.editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS,
      () => {
        this.onSaveAs?.();
      },
    );

    return this.editor;
  }

  /** Replace the open document set. Models for documents that vanish are freed. */
  setDocuments(documents: EditorDocument[], activeId?: string): void {
    const editor = this.ensureEditor();
    this.documents = documents;

    const keep = new Set(documents.map((d) => d.id));
    for (const [id, model] of [...this.models]) {
      if (!keep.has(id)) {
        model.dispose();
        this.models.delete(id);
      }
    }

    for (const doc of documents) {
      const existing = this.models.get(doc.id);
      if (existing) {
        if (existing.getValue() !== doc.value) existing.setValue(doc.value);
        continue;
      }
      const model = monaco.editor.createModel(doc.value, doc.language);
      model.onDidChangeContent(() => {
        this.onChange?.(doc.id, model.getValue());
      });
      this.models.set(doc.id, model);
    }

    const next = activeId && keep.has(activeId) ? activeId : documents[0]?.id;
    if (next) this.activate(next);
    else editor.setModel(null);

    this.renderTabs();
  }

  activate(id: string): void {
    const model = this.models.get(id);
    if (!model) return;
    const changed = this.activeId !== id;
    this.activeId = id;
    this.ensureEditor().setModel(model);
    this.renderTabs();
    if (changed) this.onActivate?.(id);
  }

  get activeDocumentId(): string | null {
    return this.activeId;
  }

  getValue(id: string): string {
    return this.models.get(id)?.getValue() ?? '';
  }

  private renderTabs(): void {
    this.tabsHost.replaceChildren();
    for (const doc of this.documents) {
      const tab = document.createElement('button');
      tab.className = 'editor-tab';
      if (doc.id === this.activeId) tab.classList.add('is-active');
      tab.textContent = doc.label;
      tab.addEventListener('click', () => this.activate(doc.id));
      this.tabsHost.appendChild(tab);
    }
  }

  /** Show compiler errors as squiggles on the given document. */
  setErrors(id: string, errors: ShaderError[]): void {
    const model = this.models.get(id);
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      'domino',
      errors.map((err) => ({
        severity: monaco.MarkerSeverity.Error,
        message: err.message,
        startLineNumber: Math.max(1, err.line),
        startColumn: 1,
        endLineNumber: Math.max(1, err.line),
        endColumn: model.getLineMaxColumn(
          Math.min(Math.max(1, err.line), model.getLineCount()),
        ),
      })),
    );
  }

  clearErrors(id: string): void {
    this.setErrors(id, []);
  }

  markTabError(id: string, hasError: boolean): void {
    const index = this.documents.findIndex((d) => d.id === id);
    const tab = this.tabsHost.children[index] as HTMLElement | undefined;
    tab?.classList.toggle('has-error', hasError);
  }

  revealLine(id: string, line: number): void {
    this.activate(id);
    const editor = this.editor;
    if (!editor) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  }

  layout(): void {
    this.editor?.layout();
  }

  focus(): void {
    this.editor?.focus();
  }

  dispose(): void {
    for (const model of this.models.values()) model.dispose();
    this.models.clear();
    this.editor?.dispose();
    this.editor = null;
  }
}
