import type { AppSettings, VirtualCameraStatus } from '@shared/types';

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
    key: 'cameraEnabled',
    label: 'Webcam Input',
    group: 'Camera',
    help: 'Turns the camera on so shaders can sample it. Bind an iChannel to Webcam in the editor.',
  },
  {
    key: 'cameraMirror',
    label: 'Mirror',
    group: 'Camera',
    help: 'Selfie view. Shaders read this as iCameraMirror; the dominoCamera() helper applies it for you.',
  },
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

const GROUP_ORDER = ['Image', 'Camera', 'Virtual Camera', 'Quality', 'Playback'];

const VCAM_SIZES = ['640x480', '1280x720', '1920x1080'];
const VCAM_RATES = [24, 30, 60];

export class DisplayPanel {
  private host: HTMLElement;
  private settings: AppSettings;
  private rows = new Map<string, { input: HTMLInputElement; value: HTMLElement }>();

  onChange: ((patch: Partial<AppSettings>) => void) | null = null;
  onReset: (() => void) | null = null;
  /** Devices offered in the camera picker. Empty until permission is granted. */
  cameraDevices: Array<{ deviceId: string; label: string }> = [];
  /** Latest word from the main process; null until the first status query. */
  virtualCameraStatus: VirtualCameraStatus | null = null;
  onVirtualCamera: ((on: boolean) => void) | null = null;
  onVirtualCameraRegister: ((unregister: boolean) => void) | null = null;

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
      if (group === 'Camera') section.appendChild(this.buildCameraPicker());
      if (group === 'Virtual Camera') this.buildVirtualCamera(section);

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

  /**
   * Publishing Domino as a webcam.
   *
   * Built by hand rather than from the toggle table because most of what
   * matters here is live state - whether the driver is registered, whether
   * anything is actually being sent - and a plain settings checkbox would hide
   * the one thing a user needs to know when it does not work.
   */
  private buildVirtualCamera(section: HTMLElement): void {
    const status = this.virtualCameraStatus;

    const row = document.createElement('label');
    row.className = 'param param-toggle';

    const label = document.createElement('span');
    label.className = 'param-label';
    label.textContent = 'Publish as Webcam';
    label.title =
      'Makes Domino selectable as a camera in Zoom, Discord, Meet and anything ' +
      'else that takes a webcam.';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(this.settings.virtualCameraEnabled);
    input.disabled = !status?.available || !status?.registered;
    input.addEventListener('change', () => this.onVirtualCamera?.(input.checked));

    row.append(label, input);
    section.appendChild(row);

    section.appendChild(
      this.buildChoice('Size', VCAM_SIZES, String(this.settings.virtualCameraSize), (v) =>
        this.onChange?.({ virtualCameraSize: v }),
      ),
    );
    section.appendChild(
      this.buildChoice(
        'Frame Rate',
        VCAM_RATES.map((r) => String(r)),
        String(this.settings.virtualCameraFps),
        (v) => this.onChange?.({ virtualCameraFps: Number(v) }),
      ),
    );

    // Registration is a one-time administrator step, so the button only shows
    // when it is actually the thing standing in the way.
    if (status?.available && !status.registered) {
      const register = document.createElement('button');
      register.className = 'btn btn-ghost';
      register.style.width = '100%';
      register.textContent = 'Register camera driver';
      register.title =
        'Runs regsvr32 as administrator. Windows will show its usual prompt.';
      register.addEventListener('click', () => this.onVirtualCameraRegister?.(false));
      section.appendChild(register);
    }

    // Offered while it is registered so the machine can be left clean. The
    // uninstaller cannot do this itself: it does not run elevated.
    if (status?.registered && !status.running) {
      const remove = document.createElement('button');
      remove.className = 'btn btn-ghost';
      remove.style.width = '100%';
      remove.textContent = 'Unregister camera driver';
      remove.title = 'Removes the machine-wide registration. Also needs administrator rights.';
      remove.addEventListener('click', () => this.onVirtualCameraRegister?.(true));
      section.appendChild(remove);
    }

    const note = document.createElement('div');
    note.className = 'param-help';
    note.textContent = this.virtualCameraNote(status);
    section.appendChild(note);
  }

  /** One line telling the user exactly where this stands, good or bad. */
  private virtualCameraNote(status: VirtualCameraStatus | null): string {
    if (!status) return 'Checking for the camera driver...';
    if (!status.available) {
      return status.error || 'This build of Domino has no virtual camera module.';
    }
    if (!status.registered) {
      return (
        status.error ||
        'Windows loads the camera driver in its own process, which needs a ' +
          'one-time machine-wide registration. This asks for administrator ' +
          'rights once and never again.'
      );
    }
    if (status.error) return status.error;
    if (status.running) {
      return `Live at ${status.width}x${status.height}, ${status.fps}fps. ${status.framesWritten} frames sent. Pick "${this.settings.virtualCameraName}" in your video app.`;
    }
    return 'Ready. Turn this on, then choose Domino as your camera.';
  }

  /** A labelled dropdown, matching the shape of the sliders above it. */
  private buildChoice(
    labelText: string,
    options: string[],
    value: string,
    onPick: (value: string) => void,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'param';

    const label = document.createElement('span');
    label.className = 'param-label';
    label.textContent = labelText;

    const select = document.createElement('select');
    select.className = 'select';
    for (const option of options) {
      const element = document.createElement('option');
      element.value = option;
      element.textContent = option;
      select.appendChild(element);
    }
    select.value = value;
    select.addEventListener('change', () => onPick(select.value));

    row.append(label, select);
    return row;
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

  /**
   * Camera device picker.
   *
   * Device labels are blank until camera permission has been granted once, so
   * before that the list shows generic names. Turning the camera on populates
   * it properly on the next render.
   */
  private buildCameraPicker(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'param';

    const label = document.createElement('span');
    label.className = 'param-label';
    label.textContent = 'Device';

    const select = document.createElement('select');
    select.className = 'chan-select';
    select.style.gridColumn = '1 / -1';
    select.style.width = '100%';

    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = this.cameraDevices.length ? 'Default camera' : 'Default camera (turn on to list)';
    select.appendChild(auto);

    this.cameraDevices.forEach((device, i) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Camera ${i + 1}`;
      select.appendChild(option);
    });

    select.value = String(this.settings.cameraDeviceId ?? '');
    select.addEventListener('change', () => {
      this.onChange?.({ cameraDeviceId: select.value });
    });

    row.append(label, document.createElement('span'), select);
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
