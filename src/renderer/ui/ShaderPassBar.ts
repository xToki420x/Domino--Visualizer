import type { ChannelSource, PassId } from '../shadertoy/ShadertoyRuntime';
import {
  BUFFER_PASSES,
  channelToName,
  passLabel,
  type ShaderProjectDoc,
} from '../shadertoy/ShaderDocument';

/**
 * The iChannel binding row shown under the editor tabs.
 *
 * On Shadertoy the channel bindings live in the site's UI, not in the shader
 * code, which is exactly why pasting a multi-tab shader into a plain text
 * editor loses half the information. Reproducing the same four dropdowns here
 * means a Shadertoy shader can be transcribed tab-for-tab with nothing left
 * implicit.
 */

export interface ShaderPassBarCallbacks {
  onChannelChange(passId: PassId, index: number, source: ChannelSource): void;
  onAddPass(id: PassId): void;
  onRemovePass(id: PassId): void;
  onToggleCommon(enabled: boolean): void;
}

interface Option {
  value: string;
  label: string;
}

function channelOptions(doc: ShaderProjectDoc): Option[] {
  const options: Option[] = [
    { value: 'none', label: '— none —' },
    { value: 'audio', label: 'Audio (FFT + wave)' },
    { value: 'noise', label: 'Noise texture' },
    { value: 'webcam', label: 'Webcam' },
  ];
  // Only offer buffers that actually exist, so a binding can't dangle.
  for (const pass of doc.passes) {
    if (pass.id === 'Image') continue;
    options.push({ value: `buffer${pass.id}`, label: `Buffer ${pass.id}` });
  }
  return options;
}

function nameToChannel(value: string): ChannelSource {
  if (value === 'audio') return { type: 'audio' };
  if (value === 'noise') return { type: 'noise' };
  if (value === 'webcam') return { type: 'webcam' };
  const match = /^buffer([ABCD])$/.exec(value);
  if (match) return { type: 'buffer', buffer: match[1] as 'A' | 'B' | 'C' | 'D' };
  return { type: 'none' };
}

export class ShaderPassBar {
  private host: HTMLElement;
  private callbacks: ShaderPassBarCallbacks;

  constructor(host: HTMLElement, callbacks: ShaderPassBarCallbacks) {
    this.host = host;
    this.callbacks = callbacks;
  }

  hide(): void {
    this.host.hidden = true;
    this.host.replaceChildren();
  }

  /**
   * Render the bar for `activePassId`. Passing 'common' shows only the pass
   * management controls, since the Common tab has no channels of its own.
   */
  render(doc: ShaderProjectDoc, activePassId: PassId | 'common' | null): void {
    this.host.hidden = false;
    this.host.replaceChildren();

    const pass = activePassId && activePassId !== 'common'
      ? doc.passes.find((p) => p.id === activePassId)
      : undefined;

    if (pass) {
      const options = channelOptions(doc);
      for (let i = 0; i < 4; i++) {
        this.host.appendChild(this.buildChannel(pass.id, i, pass.channels[i], options));
      }
    } else {
      const note = document.createElement('span');
      note.className = 'chan-note';
      note.textContent = 'Common code is prepended to every pass.';
      this.host.appendChild(note);
    }

    this.host.appendChild(this.buildActions(doc, activePassId));
  }

  private buildChannel(
    passId: PassId,
    index: number,
    channel: ChannelSource,
    options: Option[],
  ): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'chan';

    const label = document.createElement('span');
    label.className = 'chan-label';
    label.textContent = `iChannel${index}`;

    const select = document.createElement('select');
    select.className = 'chan-select';
    const current = channelToName(channel);

    for (const option of options) {
      const node = document.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      select.appendChild(node);
    }

    // A binding can point at a buffer that was since removed; keep it visible
    // rather than silently snapping the value to "none".
    if (!options.some((o) => o.value === current)) {
      const orphan = document.createElement('option');
      orphan.value = current;
      orphan.textContent = `${current} (missing)`;
      select.appendChild(orphan);
    }
    select.value = current;

    select.addEventListener('change', () => {
      this.callbacks.onChannelChange(passId, index, nameToChannel(select.value));
    });

    wrap.append(label, select);
    return wrap;
  }

  private buildActions(doc: ShaderProjectDoc, activePassId: PassId | 'common' | null): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'chan-actions';

    const existing = new Set(doc.passes.map((p) => p.id));
    const nextBuffer = BUFFER_PASSES.find((id) => !existing.has(id));

    const add = document.createElement('button');
    add.className = 'btn btn-ghost btn-tiny';
    add.textContent = nextBuffer ? `+ ${passLabel(nextBuffer)}` : '+ Buffer';
    add.disabled = !nextBuffer;
    add.title = nextBuffer
      ? `Add ${passLabel(nextBuffer)} - a feedback buffer that can read its own previous frame`
      : 'All four buffers are in use';
    if (nextBuffer) {
      add.addEventListener('click', () => this.callbacks.onAddPass(nextBuffer));
    }
    actions.appendChild(add);

    const hasCommon = doc.common.trim().length > 0;
    const common = document.createElement('button');
    common.className = 'btn btn-ghost btn-tiny';
    common.textContent = hasCommon ? 'Drop Common' : '+ Common';
    common.title = hasCommon
      ? 'Remove the Common tab (its code is discarded)'
      : 'Add a Common tab, prepended to every pass';
    common.addEventListener('click', () => this.callbacks.onToggleCommon(!hasCommon));
    actions.appendChild(common);

    // The Image pass is the output; removing it would leave nothing on screen.
    if (activePassId && activePassId !== 'common' && activePassId !== 'Image') {
      const remove = document.createElement('button');
      remove.className = 'btn btn-ghost btn-tiny';
      remove.textContent = `Remove ${passLabel(activePassId)}`;
      remove.addEventListener('click', () => this.callbacks.onRemovePass(activePassId));
      actions.appendChild(remove);
    }

    return actions;
  }
}
