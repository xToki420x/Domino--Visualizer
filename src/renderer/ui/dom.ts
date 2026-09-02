/** Small DOM helpers, so the app file isn't half type assertions. */

export function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

export function on<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
): void {
  target.addEventListener(type, handler as EventListener);
}

/** Transient status message over the stage. */
export class Toast {
  private node: HTMLElement;
  private timer: number | null = null;

  constructor(node: HTMLElement) {
    this.node = node;
  }

  show(message: string, kind: 'info' | 'error' = 'info', durationMs = 3200): void {
    this.node.textContent = message;
    this.node.classList.toggle('is-error', kind === 'error');
    this.node.hidden = false;
    if (this.timer !== null) window.clearTimeout(this.timer);
    // Errors linger; routine confirmations get out of the way quickly.
    this.timer = window.setTimeout(
      () => {
        this.node.hidden = true;
        this.timer = null;
      },
      kind === 'error' ? Math.max(durationMs, 6000) : durationMs,
    );
  }

  hide(): void {
    this.node.hidden = true;
  }
}

/** Rolling frame-rate estimate that doesn't jitter on screen. */
export class FpsCounter {
  private lastTime = performance.now();
  private smoothed = 60;

  tick(): number {
    const now = performance.now();
    const delta = now - this.lastTime;
    this.lastTime = now;
    if (delta > 0 && delta < 500) {
      const instant = 1000 / delta;
      this.smoothed += (instant - this.smoothed) * 0.08;
    }
    return this.smoothed;
  }

  get value(): number {
    return this.smoothed;
  }
}
