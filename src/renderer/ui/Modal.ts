/**
 * Promise-based dialogs.
 *
 * Deliberately in-app rather than Electron's native dialogs: naming a preset is
 * a library operation, not a filesystem one. A native save dialog would let the
 * user wander off to Documents and write a file the library never sees, which
 * is exactly the confusion this avoids.
 */

export interface PromptOptions {
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Return an error string to block submission, or null when the value is fine. */
  validate?: (value: string) => string | null;
}

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  /** Styles the confirm button as destructive. */
  danger?: boolean;
}

let activeOverlay: HTMLElement | null = null;

function closeActive(): void {
  activeOverlay?.remove();
  activeOverlay = null;
}

function buildOverlay(): { overlay: HTMLElement; card: HTMLElement } {
  // Only one dialog at a time; a second replaces the first rather than stacking.
  closeActive();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const card = document.createElement('div');
  card.className = 'modal';
  overlay.appendChild(card);

  document.body.appendChild(overlay);
  activeOverlay = overlay;
  return { overlay, card };
}

export function promptText(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const { overlay, card } = buildOverlay();

    const title = document.createElement('div');
    title.className = 'modal-title';
    title.textContent = options.title;

    const label = document.createElement('label');
    label.className = 'modal-label';
    label.textContent = options.label ?? 'Name';

    const input = document.createElement('input');
    input.className = 'modal-input';
    input.type = 'text';
    input.value = options.value ?? '';
    input.placeholder = options.placeholder ?? '';
    input.spellcheck = false;
    label.appendChild(input);

    const error = document.createElement('div');
    error.className = 'modal-error';
    error.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const cancel = document.createElement('button');
    cancel.className = 'btn btn-ghost';
    cancel.textContent = 'Cancel';

    const confirm = document.createElement('button');
    confirm.className = 'btn btn-primary';
    confirm.textContent = options.confirmLabel ?? 'Save';

    actions.append(cancel, confirm);
    card.append(title, label, error, actions);

    const finish = (value: string | null): void => {
      document.removeEventListener('keydown', onKey, true);
      closeActive();
      resolve(value);
    };

    const submit = (): void => {
      const value = input.value.trim();
      const problem = options.validate ? options.validate(value) : value ? null : 'Enter a name.';
      if (problem) {
        error.textContent = problem;
        error.hidden = false;
        input.focus();
        input.select();
        return;
      }
      finish(value);
    };

    // Capture phase, so the app's global hotkeys never see these keys.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        submit();
      }
    };
    document.addEventListener('keydown', onKey, true);

    confirm.addEventListener('click', submit);
    cancel.addEventListener('click', () => finish(null));
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) finish(null);
    });
    input.addEventListener('input', () => {
      error.hidden = true;
    });

    input.focus();
    // Preselect the stem so typing replaces the name but keeps any extension.
    const dot = input.value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  });
}

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const { overlay, card } = buildOverlay();

    const title = document.createElement('div');
    title.className = 'modal-title';
    title.textContent = options.title;

    const body = document.createElement('div');
    body.className = 'modal-body';
    body.textContent = options.body ?? '';
    body.hidden = !options.body;

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const cancel = document.createElement('button');
    cancel.className = 'btn btn-ghost';
    cancel.textContent = 'Cancel';

    const confirm = document.createElement('button');
    confirm.className = options.danger ? 'btn btn-danger' : 'btn btn-primary';
    confirm.textContent = options.confirmLabel ?? 'OK';

    actions.append(cancel, confirm);
    card.append(title, body, actions);

    const finish = (value: boolean): void => {
      document.removeEventListener('keydown', onKey, true);
      closeActive();
      resolve(value);
    };

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      }
    };
    document.addEventListener('keydown', onKey, true);

    confirm.addEventListener('click', () => finish(true));
    cancel.addEventListener('click', () => finish(false));
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) finish(false);
    });

    confirm.focus();
  });
}

/** A right-click menu anchored at the pointer. */
export interface MenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export function showContextMenu(x: number, y: number, items: MenuItem[]): void {
  closeActive();

  const overlay = document.createElement('div');
  overlay.className = 'menu-overlay';

  const menu = document.createElement('div');
  menu.className = 'context-menu';

  for (const item of items) {
    const button = document.createElement('button');
    button.className = 'context-item';
    if (item.danger) button.classList.add('is-danger');
    button.textContent = item.label;
    button.disabled = Boolean(item.disabled);
    button.addEventListener('click', () => {
      closeActive();
      item.action();
    });
    menu.appendChild(button);
  }

  overlay.appendChild(menu);
  document.body.appendChild(overlay);
  activeOverlay = overlay;

  // Position after insertion so the measured size is real, then nudge the menu
  // back on screen if it would overflow the window.
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;

  const dismiss = (): void => {
    document.removeEventListener('keydown', onKey, true);
    closeActive();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) dismiss();
  });
  overlay.addEventListener('contextmenu', (event) => event.preventDefault());
}

/** Reject characters that are not safe in a filename on any platform. */
export function validateLibraryName(value: string): string | null {
  if (!value) return 'Enter a name.';
  if (value.length > 120) return 'That name is too long.';
  if (/[\\/:*?"<>|]/.test(value)) return 'Avoid \\ / : * ? " < > | in the name.';
  if (/^\.+$/.test(value)) return 'That name is not allowed.';
  return null;
}
