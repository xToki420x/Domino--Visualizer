import type { AppSettings } from '@shared/types';

/**
 * The Display tab: image controls plus render quality.
 *
 * These are deliberately separate from the preset parameter panel. Preset
 * values belong to the preset and get saved with it; these belong to the user's
 * screen and persist across every visual. Mixing them would mean a preset could
 * silently change the user's brightness.
 */

interface ControlSpec {
  key: keyof AppSettings;
  label: string;
  group: string;
  min: number;
  max: number;
  step: number;
  decimals: number;
  help?: string;
  /** Present the value as a percentage rather than a raw number. */
  percent?: boolean;
}

interface ToggleSpec {
  key: keyof AppSettings;
  label: string;
  group: string;
  help?: string;
}

const CONTROLS: ControlSpec[] = [
  {
    key: 'brightness',
    label: 'Brightness',
    group: 'Image',
    min: 0.1,
    max: 2.5,
    step: 0.01,
    decimals: 2,
    help: 'Exposure applied before tone mapping. Lower this first if a preset is too hot.',
  },
  {
    key: 'contrast',
    label: 'Contrast',
    group: 'Image',
    min: 0.4,
    max: 2,
    step: 0.01,
    decimals: 2,
  },
  {
    key: 'saturation',
    label: 'Saturation',
    group: 'Image',
    min: 0,
    max: 2,
    step: 0.01,
    decimals: 2,
    help: '0 is black and white, 1 is unchanged.',
  },
  {
    key: 'gamma',
    label: 'Gamma',
    group: 'Image',
    min: 0.5,
    max: 2.2,
    step: 0.01,
    decimals: 2,
    help: 'Midtone trim applied after tone mapping.',
  },
  {
    key: 'vignette',
    label: 'Vignette',
    group: 'Image',
    min: 0,
    max: 1,
    step: 0.01,
    decimals: 2,
    help: 'Darkens the corners, which keeps attention on the centre.',
  },
  {
    key: 'renderScale',
    label: 'Render Scale',
    group: 'Quality',
    min: 0.5,
    max: 2,
    step: 0.05,
    decimals: 2,
    percent: true,
    help: 'Below 100% trades sharpness for frame rate. Above 100% supersamples.',
  },
  {
    key: 'meshX',
    label: 'Warp Mesh X',
    group: 'Quality',
    min: 8,
    max: 128,
    step: 1,
    decimals: 0,
    help: 'MilkDrop grid resolution. Higher is smoother motion but more CPU work in per-pixel equations.',
  },
  {
    key: 'meshY',
    label: 'Warp Mesh Y',
    group: 'Quality',
    min: 6,
    max: 96,
    step: 1,
    decimals: 0,
  },
  {
    key: 'blendSeconds',
    label: 'Preset Blend',
    group: 'Playback',
    min: 0,
    max: 10,
    step: 0.1,
    decimals: 1,
    help: 'Crossfade length when switching MilkDrop presets. 0 cuts instantly.',
  },
  {
    key: 'autoPlaySeconds',
    label: 'Auto Interval',
    group: 'Playback',
    min: 5,
    max: 300,
    step: 1,
    decimals: 0,
    help: 'Seconds between automatic preset changes when Auto is on.',
  },
];

const TOGGLES: ToggleSpec[] = [
  {
    key: 'toneMap',
    label: 'Filmic Tone Map',
    group: 'Image',
    help: 'Rolls bright areas off smoothly instead of clipping them to white. Turn off for the raw, harder MilkDrop look.',
  },
  {
    key: 'showFps',
    label: 'Show Stats',
    group: 'Playback',
    help: 'Frame rate, tempo and input readout in the corner.',
  },
];

const GROUP_ORDER = ['Image', 'Quality', 'Playback'];

export class DisplayPanel {
  private host: HTMLElement;
  private settings: AppSettings;
  private rows = new Map<string, { input: HTMLInputElement; value: HTMLElement }>();

  onChange: ((patch: Partial<AppSettings>) => void) | null = null;
  onReset: (() => void) | null = null;

  constructor(host: HTMLElement, settings: AppSettings) {
    this.host = host;
    this.settings = settings;
  }

  setSettings(settings: AppSettings): void {
    this.settings = settings;
    this.refresh();
  }

  render(): void {
    this.rows.clear();
    this.host.replaceChildren();
    const fragment = document.createDocumentFragment();

    for (const group of GROUP_ORDER) {
      const controls = CONTROLS.filter((c) => c.group === group);
      const toggles = TOGGLES.filter((t) => t.group === group);
      if (controls.length === 0 && toggles.length === 0) continue;

      const section = document.createElement('div');
      section.className = 'param-group';

      const title = document.createElement('div');
      title.className = 'param-group-title';
      title.textContent = group;
      section.appendChild(title);

      for (const spec of controls) section.appendChild(this.buildSlider(spec));
      for (const spec of toggles) section.appendChild(this.buildToggle(spec));

      fragment.appendChild(section);
    }

    const reset = document.createElement('button');
    reset.className = 'btn btn-ghost';
    reset.style.marginTop = '16px';
    reset.style.width = '100%';
    reset.textContent = 'Reset display settings';
    reset.addEventListener('click', () => this.onReset?.());
    fragment.appendChild(reset);

    this.host.appendChild(fragment);
  }

  private format(spec: ControlSpec, value: number): string {
    if (spec.percent) return `${Math.round(value * 100)}%`;
    return value.toFixed(spec.decimals);
  }

  private buildSlider(spec: ControlSpec): HTMLElement {
    const row = document.createElement('div');
    row.className = 'param';

    const value = Number(this.settings[spec.key] ?? spec.min);

    const label = document.createElement('span');
    label.className = 'param-label';
    label.textContent = spec.label;
    if (spec.help) label.title = spec.help;

    const readout = document.createElement('span');
    readout.className = 'param-value';
    readout.textContent = this.format(spec, value);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(value);

    input.addEventListener('input', () => {
      const next = spec.decimals === 0 ? Math.round(parseFloat(input.value)) : parseFloat(input.value);
      readout.textContent = this.format(spec, next);
      this.onChange?.({ [spec.key]: next } as Partial<AppSettings>);
    });

    row.append(label, readout, input);
    this.rows.set(spec.key as string, { input, value: readout });
    return row;
  }

  private buildToggle(spec: ToggleSpec): HTMLElement {
    const row = document.createElement('label');
    row.className = 'param param-toggle';
    if (spec.help) row.title = spec.help;

    const label = document.createElement('span');
    label.className = 'param-label';
    label.textContent = spec.label;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(this.settings[spec.key]);
    input.addEventListener('change', () => {
      this.onChange?.({ [spec.key]: input.checked } as Partial<AppSettings>);
    });

    row.append(label, input);
    this.rows.set(spec.key as string, { input, value: label });
    return row;
  }

  /** Push current settings back into the widgets, e.g. after a reset. */
  refresh(): void {
    for (const spec of CONTROLS) {
      const row = this.rows.get(spec.key as string);
      if (!row) continue;
      const value = Number(this.settings[spec.key] ?? spec.min);
      row.input.value = String(value);
      row.value.textContent = this.format(spec, value);
    }
    for (const spec of TOGGLES) {
      const row = this.rows.get(spec.key as string);
      if (!row) continue;
      row.input.checked = Boolean(this.settings[spec.key]);
    }
  }
}
