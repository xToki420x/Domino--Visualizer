import {
  defaultChannels,
  type ShaderPassDoc,
  type ShaderProjectDoc,
} from './ShaderDocument';
import type { ChannelSource, PassId } from './ShadertoyRuntime';

/**
 * Converts a shader fetched from shadertoy.com into Domino's pass model.
 *
 * Shadertoy's structure maps onto ours almost one for one - Common, Buffer A-D
 * and Image are the same idea in both - so the work here is mostly resolving
 * the parts Shadertoy keeps outside the code: which buffer a pass writes to,
 * and what each iChannel is bound to.
 *
 * Buffer identity is the fiddly bit. A pass declares a numeric output id, and
 * an input that reads that buffer references the same number. Neither is the
 * letter shown in the UI, so we build an id -> letter map from the passes
 * first and resolve inputs against it, falling back to the pass name.
 */

/* ------------------------- Shadertoy API shapes ------------------------- */

export interface ShadertoySampler {
  filter?: string;
  wrap?: string;
  vflip?: string;
  srgb?: string;
  internal?: string;
}

export interface ShadertoyInput {
  id?: number | string;
  src?: string;
  ctype?: string;
  channel?: number;
  sampler?: ShadertoySampler;
}

export interface ShadertoyOutput {
  id?: number | string;
  channel?: number;
}

export interface ShadertoyRenderPass {
  inputs?: ShadertoyInput[];
  outputs?: ShadertoyOutput[];
  code?: string;
  name?: string;
  description?: string;
  type?: string;
}

export interface ShadertoyInfo {
  id?: string;
  name?: string;
  username?: string;
  description?: string;
  date?: string;
  tags?: string[];
}

export interface ShadertoyShader {
  ver?: string;
  info?: ShadertoyInfo;
  renderpass?: ShadertoyRenderPass[];
}

export interface ShadertoyResponse {
  Shader?: ShadertoyShader;
  Error?: string;
}

/* ------------------------------ URL parsing ----------------------------- */

/**
 * Pull the shader id out of whatever the user pasted.
 *
 * Accepts full view/embed URLs with or without protocol or query string, and a
 * bare id. Shadertoy ids are 6 alphanumeric characters in practice, but the
 * length is not guaranteed, so the pattern stays loose rather than rejecting a
 * valid id on a technicality.
 */
export function parseShadertoyId(input: string): string | null {
  const text = input.trim();
  if (!text) return null;

  const urlMatch = /shadertoy\.com\/(?:view|embed)\/([A-Za-z0-9]{3,12})/i.exec(text);
  if (urlMatch) return urlMatch[1];

  // A bare id, possibly pasted on its own.
  if (/^[A-Za-z0-9]{3,12}$/.test(text)) return text;

  return null;
}

/* ---------------------------- pass resolution --------------------------- */

const BUFFER_LETTERS: Array<'A' | 'B' | 'C' | 'D'> = ['A', 'B', 'C', 'D'];

/** Read a buffer letter out of a Shadertoy pass name like "Buffer A"/"Buf B". */
function letterFromName(name: string | undefined): 'A' | 'B' | 'C' | 'D' | null {
  if (!name) return null;
  const match = /\b(?:buffer|buf)\s*([abcd])\b/i.exec(name);
  return match ? (match[1].toUpperCase() as 'A' | 'B' | 'C' | 'D') : null;
}

export interface ImportResultDoc {
  doc: ShaderProjectDoc;
  name: string;
  /** Problems the user should know about, in the order they were found. */
  warnings: string[];
  /** Passes we could not represent at all. */
  skipped: string[];
  info: ShadertoyInfo;
}

export function convertShadertoy(shader: ShadertoyShader): ImportResultDoc {
  const warnings: string[] = [];
  const skipped: string[] = [];
  const info = shader.info ?? {};
  const passes = shader.renderpass ?? [];

  /*
   * First pass: work out which buffer letter each render pass owns, so inputs
   * can be resolved to it afterwards. Prefer the declared name; fall back to
   * allocating letters in declaration order for shaders whose names are
   * non-standard.
   */
  const idToLetter = new Map<string, 'A' | 'B' | 'C' | 'D'>();
  const passLetters = new Map<ShadertoyRenderPass, 'A' | 'B' | 'C' | 'D'>();
  let nextLetter = 0;

  for (const pass of passes) {
    if ((pass.type ?? '').toLowerCase() !== 'buffer') continue;

    let letter = letterFromName(pass.name);
    if (!letter || [...passLetters.values()].includes(letter)) {
      letter = BUFFER_LETTERS[nextLetter] ?? null;
    }
    if (!letter) {
      skipped.push(`${pass.name ?? 'buffer'} - Domino supports four buffers (A-D)`);
      continue;
    }
    nextLetter = Math.max(nextLetter, BUFFER_LETTERS.indexOf(letter) + 1);

    passLetters.set(pass, letter);
    const outputId = pass.outputs?.[0]?.id;
    if (outputId !== undefined) idToLetter.set(String(outputId), letter);
  }

  /* Second pass: build the document. */
  let common = '';
  const docPasses: ShaderPassDoc[] = [];

  for (const pass of passes) {
    const type = (pass.type ?? '').toLowerCase();
    const code = pass.code ?? '';

    if (type === 'common') {
      common = code;
      continue;
    }

    if (type === 'sound') {
      skipped.push('Sound pass - Domino visualizes audio, it does not synthesize it');
      continue;
    }
    if (type === 'cubemap') {
      skipped.push('Cubemap pass - not supported');
      continue;
    }

    let id: PassId | null = null;
    if (type === 'image') {
      id = 'Image';
    } else if (type === 'buffer') {
      id = passLetters.get(pass) ?? null;
    }
    if (!id) {
      if (type) skipped.push(`${pass.name ?? type} pass - unrecognised type "${type}"`);
      continue;
    }

    const channels = resolveChannels(pass, id, idToLetter, warnings);
    docPasses.push({ id, source: code, channels });
  }

  if (!docPasses.some((p) => p.id === 'Image')) {
    warnings.push('This shader has no Image pass, so nothing will reach the screen.');
  }

  // Audio is the whole point of the app, so it is worth saying plainly when an
  // imported shader has no audio input rather than letting it sit there inert.
  const usesAudio = docPasses.some((p) => p.channels.some((c) => c.type === 'audio'));
  if (!usesAudio) {
    warnings.push(
      'This shader does not use an audio input, so it will not react to music. ' +
        'Set an iChannel to Audio in the editor to make it reactive.',
    );
  }

  return {
    doc: { common, passes: docPasses },
    name: info.name?.trim() || 'Imported Shader',
    warnings,
    skipped,
    info,
  };
}

/**
 * Map a pass's Shadertoy inputs onto our four channels.
 *
 * Anything we cannot provide becomes an explicit `none` with a warning rather
 * than a silent default, because a shader sampling a channel it thinks is a
 * texture will render wrong in a way that is hard to diagnose otherwise.
 */
function resolveChannels(
  pass: ShadertoyRenderPass,
  id: PassId,
  idToLetter: Map<string, 'A' | 'B' | 'C' | 'D'>,
  warnings: string[],
): ChannelSource[] {
  // Start from all-none: Shadertoy states every binding explicitly, so guessing
  // here would fight the data we already have.
  const channels: ChannelSource[] = [
    { type: 'none' },
    { type: 'none' },
    { type: 'none' },
    { type: 'none' },
  ];
  const label = pass.name || id;

  for (const input of pass.inputs ?? []) {
    const channel = input.channel ?? 0;
    if (channel < 0 || channel > 3) continue;
    const ctype = (input.ctype ?? '').toLowerCase();

    switch (ctype) {
      case 'music':
      case 'musicstream':
      case 'mic':
        // All three become live system audio, which is strictly better than the
        // fixed track the shader was authored against.
        channels[channel] = { type: 'audio' };
        break;

      case 'buffer': {
        const letter = idToLetter.get(String(input.id));
        if (letter) {
          channels[channel] = { type: 'buffer', buffer: letter };
        } else {
          channels[channel] = { type: 'none' };
          warnings.push(`${label}: iChannel${channel} reads a buffer that was not imported.`);
        }
        break;
      }

      case 'texture':
        // Domino has no texture library; noise is the closest stand-in and at
        // least keeps the shader producing something.
        channels[channel] = { type: 'noise' };
        warnings.push(
          `${label}: iChannel${channel} used a Shadertoy texture. Substituted noise - ` +
            'this shader may look different from the original.',
        );
        break;

      case 'keyboard':
        warnings.push(`${label}: iChannel${channel} used keyboard input, which is unsupported.`);
        break;

      case 'webcam':
        // Domino has a real camera input, so this one maps across directly.
        channels[channel] = { type: 'webcam' };
        break;

      case 'cubemap':
      case 'volume':
      case 'video':
        warnings.push(
          `${label}: iChannel${channel} used ${ctype}, which is unsupported. Left unbound.`,
        );
        break;

      default:
        if (ctype) {
          warnings.push(`${label}: iChannel${channel} used unknown input type "${ctype}".`);
        }
        break;
    }
  }

  return channels;
}

/**
 * Attribution header written into the saved file.
 *
 * Shadertoy shaders are the work of their authors and are licensed CC BY-NC-SA
 * 3.0 by default unless the author says otherwise, so a saved import carries
 * where it came from and who made it. Costs nothing and means a shader passed
 * around later still credits its author.
 */
export function attributionHeader(info: ShadertoyInfo): string {
  const lines = ['// Imported from Shadertoy.'];
  if (info.name) lines.push(`// Title:  ${info.name}`);
  if (info.username) lines.push(`// Author: ${info.username}`);
  if (info.id) lines.push(`// Source: https://www.shadertoy.com/view/${info.id}`);
  lines.push(
    '//',
    '// Shadertoy shaders are CC BY-NC-SA 3.0 by default unless their author',
    '// states otherwise. Keep this credit if you share it on.',
  );
  return lines.join('\n');
}

/** Fold the attribution into the document so it survives a save. */
export function withAttribution(result: ImportResultDoc): ShaderProjectDoc {
  const header = attributionHeader(result.info);
  const doc = result.doc;
  const image = doc.passes.find((p) => p.id === 'Image');
  if (image) {
    image.source = `${header}\n\n${image.source}`;
  } else if (doc.passes.length > 0) {
    doc.passes[0].source = `${header}\n\n${doc.passes[0].source}`;
  }
  return doc;
}

/** A blank document, used when an import yields nothing usable. */
export function emptyImportedDoc(): ShaderProjectDoc {
  return { common: '', passes: [{ id: 'Image', source: '', channels: defaultChannels('Image') }] };
}
