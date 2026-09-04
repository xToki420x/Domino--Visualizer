import {
  singlePassProject,
  type ChannelSource,
  type PassDef,
  type PassId,
  type ShadertoyProject,
} from './ShadertoyRuntime';

/**
 * The editable model of a multipass shader, and its on-disk format.
 *
 * Shadertoy splits a shader across tabs - Common, Buffer A-D, Image - with the
 * iChannel bindings held in its UI rather than the code. Domino keeps the
 * same structure in memory so the editor can present the same tabs, and
 * flattens it to a single annotated .glsl file on disk:
 *
 *     //! common
 *     float helper() { ... }              // prepended to every pass
 *
 *     //! pass BufferA
 *     //! channel0 = bufferA              // reads its own previous frame
 *     //! channel1 = audio
 *     void mainImage(out vec4 o, in vec2 u) { ... }
 *
 *     //! pass Image
 *     //! channel0 = bufferA
 *     void mainImage(out vec4 o, in vec2 u) { ... }
 *
 * One file rather than a folder, because a shader you can copy, paste and mail
 * as a single file is worth more than a tidier directory layout. A file with no
 * directives is a plain single-pass shader, so anything pasted straight from
 * Shadertoy's Image tab still works untouched.
 */

export const PASS_ORDER: PassId[] = ['A', 'B', 'C', 'D', 'Image'];
export const BUFFER_PASSES: PassId[] = ['A', 'B', 'C', 'D'];

export interface ShaderPassDoc {
  id: PassId;
  source: string;
  /** Always length 4. */
  channels: ChannelSource[];
}

export interface ShaderProjectDoc {
  /** Code prepended to every pass. Shadertoy calls this the Common tab. */
  common: string;
  passes: ShaderPassDoc[];
}

export interface ParsedShaderProject {
  doc: ShaderProjectDoc;
  warnings: string[];
  /** True when the file used directives rather than being a plain shader. */
  multipass: boolean;
}

const PASS_DIRECTIVE = /^\s*\/\/!\s*pass\s+(\w+)\s*$/i;
const COMMON_DIRECTIVE = /^\s*\/\/!\s*common\s*$/i;
const CHANNEL_DIRECTIVE = /^\s*\/\/!\s*channel\s*([0-3])\s*=\s*(\w+)\s*$/i;

export function normalizePassId(raw: string): PassId | null {
  const value = raw.trim().toLowerCase();
  if (value === 'image' || value === 'main') return 'Image';
  // Accept BufferA, bufferA, A, buf_a - people write these inconsistently.
  const match = /^(?:buffer|buf)?_?([abcd])$/.exec(value);
  return match ? (match[1].toUpperCase() as PassId) : null;
}

export function passLabel(id: PassId): string {
  return id === 'Image' ? 'Image' : `Buffer ${id}`;
}

function parseChannel(raw: string, warnings: string[]): ChannelSource {
  const value = raw.trim().toLowerCase();
  if (value === 'audio' || value === 'fft' || value === 'sound') return { type: 'audio' };
  if (value === 'noise' || value === 'rand') return { type: 'noise' };
  if (value === 'webcam' || value === 'camera' || value === 'cam') return { type: 'webcam' };
  if (value === 'none' || value === 'off') return { type: 'none' };

  const match = /^(?:buffer|buf)?_?([abcd])$/.exec(value);
  if (match) {
    return { type: 'buffer', buffer: match[1].toUpperCase() as 'A' | 'B' | 'C' | 'D' };
  }

  warnings.push(`Unknown channel source "${raw.trim()}" - treated as unused.`);
  return { type: 'none' };
}

export function channelToName(channel: ChannelSource): string {
  switch (channel.type) {
    case 'audio':
      return 'audio';
    case 'noise':
      return 'noise';
    case 'webcam':
      return 'webcam';
    case 'buffer':
      return `buffer${channel.buffer}`;
    default:
      return 'none';
  }
}

/**
 * What a channel binds to when the file says nothing.
 *
 * A buffer pass almost always wants to read its own previous frame - that is
 * what makes it a feedback buffer - while an image pass wants audio. Guessing
 * these removes boilerplate without preventing an explicit `channel0 = none`.
 */
export function defaultChannel(index: number, passId: PassId): ChannelSource {
  if (index !== 0) return { type: 'none' };
  if (passId === 'Image') return { type: 'audio' };
  return { type: 'buffer', buffer: passId as 'A' | 'B' | 'C' | 'D' };
}

export function defaultChannels(passId: PassId): ChannelSource[] {
  return [0, 1, 2, 3].map((i) => defaultChannel(i, passId));
}

function sameChannel(a: ChannelSource, b: ChannelSource): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'buffer' && b.type === 'buffer') return a.buffer === b.buffer;
  return true;
}

/* ------------------------------- parsing -------------------------------- */

export function parseShaderProject(source: string): ParsedShaderProject {
  const warnings: string[] = [];

  // Fast path: no directives at all, so this is a plain Image pass.
  if (!/^\s*\/\/!\s*(pass|common)\b/im.test(source)) {
    return {
      doc: {
        common: '',
        passes: [{ id: 'Image', source, channels: defaultChannels('Image') }],
      },
      warnings,
      multipass: false,
    };
  }

  const lines = source.split('\n');
  const sections: Array<{ id: PassId; channels: (ChannelSource | undefined)[]; body: string[] }> = [];
  const commonLines: string[] = [];

  type Target = { kind: 'common' } | { kind: 'pass'; index: number } | null;
  let target: Target = null;

  for (const line of lines) {
    const passMatch = PASS_DIRECTIVE.exec(line);
    if (passMatch) {
      const id = normalizePassId(passMatch[1]);
      if (!id) {
        warnings.push(`Unknown pass "${passMatch[1]}" - expected Image or BufferA..BufferD.`);
        target = null;
        continue;
      }
      if (sections.some((s) => s.id === id)) {
        warnings.push(`Pass ${id} declared more than once; the later one is ignored.`);
        target = null;
        continue;
      }
      sections.push({ id, channels: [], body: [] });
      target = { kind: 'pass', index: sections.length - 1 };
      continue;
    }

    if (COMMON_DIRECTIVE.test(line)) {
      target = { kind: 'common' };
      continue;
    }

    const channelMatch = CHANNEL_DIRECTIVE.exec(line);
    if (channelMatch) {
      if (target?.kind !== 'pass') {
        warnings.push('A channel directive appeared before any //! pass - ignored.');
        continue;
      }
      const index = parseInt(channelMatch[1], 10);
      sections[target.index].channels[index] = parseChannel(channelMatch[2], warnings);
      continue;
    }

    if (target?.kind === 'common') {
      commonLines.push(line);
    } else if (target?.kind === 'pass') {
      sections[target.index].body.push(line);
    }
    // Text before the first directive is dropped: it is nearly always a header
    // comment, and silently folding it into the first pass would shift that
    // pass's reported error lines for no benefit.
  }

  if (sections.length === 0) {
    warnings.push('No passes found - treating the whole file as one image pass.');
    return {
      doc: {
        common: '',
        passes: [{ id: 'Image', source, channels: defaultChannels('Image') }],
      },
      warnings,
      multipass: false,
    };
  }

  if (!sections.some((s) => s.id === 'Image')) {
    warnings.push('No Image pass declared; nothing would reach the screen.');
  }

  const passes: ShaderPassDoc[] = sections.map((section) => ({
    id: section.id,
    source: trimEdgeBlankLines(section.body).join('\n'),
    channels: [0, 1, 2, 3].map(
      (i) => section.channels[i] ?? defaultChannel(i, section.id),
    ),
  }));

  passes.sort((a, b) => PASS_ORDER.indexOf(a.id) - PASS_ORDER.indexOf(b.id));

  return {
    doc: { common: trimEdgeBlankLines(commonLines).join('\n'), passes },
    warnings,
    multipass: true,
  };
}

/** Drop leading and trailing blank lines left behind by the directives. */
function trimEdgeBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}

/* ----------------------------- serialising ------------------------------ */

/**
 * Write the document back out.
 *
 * A single Image pass with default bindings and no common code is emitted as a
 * bare shader, so simple shaders stay simple files and round-trip byte-for-byte
 * through an edit that did not add passes.
 */
export function serializeShaderProject(doc: ShaderProjectDoc): string {
  const isPlain =
    doc.passes.length === 1 &&
    doc.passes[0].id === 'Image' &&
    !doc.common.trim() &&
    doc.passes[0].channels.every((channel, i) => sameChannel(channel, defaultChannel(i, 'Image')));

  if (isPlain) return doc.passes[0].source;

  const out: string[] = [];

  if (doc.common.trim()) {
    out.push('//! common', doc.common, '');
  }

  const ordered = [...doc.passes].sort(
    (a, b) => PASS_ORDER.indexOf(a.id) - PASS_ORDER.indexOf(b.id),
  );

  for (const pass of ordered) {
    out.push(`//! pass ${pass.id === 'Image' ? 'Image' : `Buffer${pass.id}`}`);
    pass.channels.forEach((channel, i) => {
      // Only write bindings that differ from what parsing would assume, so the
      // file stays readable instead of carrying four lines per pass.
      if (!sameChannel(channel, defaultChannel(i, pass.id))) {
        out.push(`//! channel${i} = ${channelToName(channel)}`);
      }
    });
    out.push(pass.source, '');
  }

  return `${out.join('\n').trimEnd()}\n`;
}

/* ------------------------------ compiling ------------------------------- */

export interface BuiltProject {
  project: ShadertoyProject;
  /**
   * Lines the common block contributes to each pass. Compile errors below this
   * belong to the Common tab; above it, subtract to get the pass's own line.
   */
  commonLineCount: number;
}

export function buildProject(doc: ShaderProjectDoc, name: string): BuiltProject {
  const hasCommon = doc.common.trim().length > 0;
  // The +1 accounts for the newline joining common to the pass body.
  const commonLineCount = hasCommon ? doc.common.split('\n').length : 0;

  const passes: PassDef[] = doc.passes.map((pass) => ({
    id: pass.id,
    source: hasCommon ? `${doc.common}\n${pass.source}` : pass.source,
    channels: pass.channels,
  }));

  return { project: { name, passes }, commonLineCount };
}

export function createEmptyPassDoc(id: PassId, source = ''): ShaderPassDoc {
  return { id, source, channels: defaultChannels(id) };
}

/* --------------------------- legacy convenience -------------------------- */

export interface ShaderDocumentResult {
  project: ShadertoyProject;
  warnings: string[];
  multipass: boolean;
}

/** One-shot parse straight to a runtime project. */
export function parseShaderDocument(source: string, name: string): ShaderDocumentResult {
  const parsed = parseShaderProject(source);
  if (!parsed.multipass) {
    return {
      project: singlePassProject(name, parsed.doc.passes[0].source),
      warnings: parsed.warnings,
      multipass: false,
    };
  }
  return {
    project: buildProject(parsed.doc, name).project,
    warnings: parsed.warnings,
    multipass: true,
  };
}
