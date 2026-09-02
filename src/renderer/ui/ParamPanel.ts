import {
  PRESET_VARS,
  type MilkPreset,
  type VarGroup,
  type VarSpec,
} from '../milkdrop/PresetModel';

/**
 * Live parameter editor for the loaded MilkDrop preset.
 *
 * Every scalar in PRESET_VARS gets a slider, grouped the way MilkDrop groups
 * them. Editing one writes straight into the preset's baseVals and reloads the
 * preset, so the change is audible-visible immediately and survives a save.
 *
 * Parameters the preset's own per-frame equations overwrite each frame will
 * appear to snap back - that is correct behaviour, not a bug, and the panel
 * marks such rows so it is obvious why a slider "doesn't work".
 */

const GROUP_LABELS: Record<VarGroup, string> = {
  motion: 'Motion & Warp',
  colour: 'Colour & Decay',
  wave: 'Waveform',
  border: 'Borders',
  motionVectors: 'Motion Vectors',
  blur: 'Blur',
  post: 'Post Effects',
  meta: 'Metadata',
};

const GROUP_ORDER: VarGroup[] = [
  'motion',
  'colour',
  'wave',
  'post',
  'border',
  'motionVectors',
  'blur',
  'meta',
];

export class ParamPanel {
  private host: HTMLElement;
  private preset: MilkPreset | null = null;
  /** Variables this preset's equations assign, so we can flag them. */
  private drivenByEquations = new Set<string>();
  private rows = new Map<string, { input: HTMLInputElement; value: HTMLElement }>();

  onChange: ((key: string, value: number) => void) | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  showMessage(text: string): void {
    this.preset = null;
    this.rows.clear();
    this.host.replaceChildren();
    const note = document.createElement('div');
    note.className = 'inspector-note';
    note.textContent = text;
    this.host.appendChild(note);
  }

  setPreset(
    preset: MilkPreset,
    diagnostics?: { equationErrors: string[]; shaderErrors: string[]; warnings: string[] },
  ): void {
    this.preset = preset;
    this.rows.clear();
    this.host.replaceChildren();
    this.computeDrivenVariables(preset);

    const fragment = document.createDocumentFragment();

    for (const group of GROUP_ORDER) {
      const specs = PRESET_VARS.filter((spec) => spec.group === group);
      if (specs.length === 0) continue;

      const section = document.createElement('div');
      section.className = 'param-group';

      const title = document.createElement('div');
      title.className = 'param-group-title';
      title.textContent = GROUP_LABELS[group];
      section.appendChild(title);

      for (const spec of specs) {
        section.appendChild(this.buildRow(spec, preset));
      }
      fragment.appendChild(section);
    }

    if (diagnostics) {
      const problems = [...diagnostics.shaderErrors, ...diagnostics.equationErrors];
      if (problems.length > 0) {
        fragment.appendChild(this.buildDiagnostics('Preset problems', problems, true));
      }
      if (diagnostics.warnings.length > 0) {
        fragment.appendChild(this.buildDiagnostics('Notes', diagnostics.warnings, false));
      }
    }

    this.host.appendChild(fragment);
  }

  /**
   * Find which variables the preset's equations write to.
   *
   * A crude scan for `name =` is enough: we only need to know whether a slider
   * will be overwritten each frame so the UI can say so, and a false positive
   * here costs nothing worse than an extra hint.
   */
  private computeDrivenVariables(preset: MilkPreset): void {
    this.drivenByEquations.clear();
    const code = `${preset.perFrame}\n${preset.perPixel}`.toLowerCase();
    for (const spec of PRESET_VARS) {
      const name = (spec.eq ?? spec.key).toLowerCase();
      const pattern = new RegExp(`(^|[^\\w.])${escapeRegex(name)}\\s*[-+*/%]?=[^=]`, 'm');
      if (pattern.test(code)) this.drivenByEquations.add(spec.key);
    }
  }

  private buildRow(spec: VarSpec, preset: MilkPreset): HTMLElement {
    const row = document.createElement('div');
    row.className = 'param';

    const value = preset.baseVals[spec.key] ?? spec.default;
    const driven = this.drivenByEquations.has(spec.key);

    const label = document.createElement('span');
    label.className = 'param-label';
    label.textContent = spec.label;
    label.title = driven
      ? `${spec.help ?? spec.label}\n\nThis preset's equations set ${spec.eq ?? spec.key} every frame, so changes here are overwritten while it runs.`
      : (spec.help ?? spec.label);
    if (driven) {
      label.textContent = `${spec.label} *`;
      row.classList.add('is-dirty');
    }

    const readout = document.createElement('span');
    readout.className = 'param-value';
    readout.textContent = formatValue(value, spec);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step ?? (spec.type === 'float' ? (spec.max - spec.min) / 1000 : 1));
    input.value = String(value);

    input.addEventListener('input', () => {
      const next = spec.type === 'float' ? parseFloat(input.value) : Math.round(parseFloat(input.value));
      readout.textContent = formatValue(next, spec);
      if (this.preset) this.preset.baseVals[spec.key] = next;
      this.onChange?.(spec.key, next);
    });

    row.append(label, readout, input);
    this.rows.set(spec.key, { input, value: readout });
    return row;
  }

  private buildDiagnostics(title: string, lines: string[], isError: boolean): HTMLElement {
    const box = document.createElement('div');
    box.className = 'diag';
    if (!isError) box.style.borderColor = '#2a3149';

    const heading = document.createElement('div');
    heading.className = 'diag-title';
    heading.textContent = title;
    if (!isError) heading.style.color = 'var(--text-dim)';
    box.appendChild(heading);

    for (const line of lines.slice(0, 12)) {
      const row = document.createElement('div');
      row.textContent = line;
      box.appendChild(row);
    }
    if (lines.length > 12) {
      const more = document.createElement('div');
      more.textContent = `…and ${lines.length - 12} more`;
      box.appendChild(more);
    }
    return box;
  }

  /** Push values back into the sliders, e.g. after a Reset. */
  refresh(): void {
    if (!this.preset) return;
    for (const spec of PRESET_VARS) {
      const row = this.rows.get(spec.key);
      if (!row) continue;
      const value = this.preset.baseVals[spec.key] ?? spec.default;
      row.input.value = String(value);
      row.value.textContent = formatValue(value, spec);
    }
  }
}

function formatValue(value: number, spec: VarSpec): string {
  if (spec.type === 'bool') return value > 0.5 ? 'on' : 'off';
  if (spec.type === 'int') return String(Math.round(value));
  return Math.abs(value) >= 100 ? value.toFixed(1) : value.toFixed(3);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
