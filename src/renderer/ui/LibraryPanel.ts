import type { LibraryEntry, LibraryKind } from '@shared/types';

/**
 * The preset/shader browser.
 *
 * Entries are grouped by their source folder, which matters once someone
 * imports a MilkDrop pack containing a few thousand .milk files - the grouping
 * is the only thing that keeps such a list navigable. Filtering is substring,
 * case-insensitive, and matches against both the name and the group so
 * searching for an author's folder name works.
 */
export class LibraryPanel {
  private host: HTMLElement;
  private searchInput: HTMLInputElement;

  private entries: LibraryEntry[] = [];
  private filtered: LibraryEntry[] = [];
  private activeId: string | null = null;
  private query = '';

  onSelect: ((entry: LibraryEntry) => void) | null = null;
  onContextMenu: ((entry: LibraryEntry, x: number, y: number) => void) | null = null;

  constructor(host: HTMLElement, searchInput: HTMLInputElement) {
    this.host = host;
    this.searchInput = searchInput;

    searchInput.addEventListener('input', () => {
      this.query = searchInput.value.trim().toLowerCase();
      this.render();
    });

    // Arrow keys move through the visible list; Enter re-selects the current
    // entry, which is a quick way to restart a preset.
    host.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        this.step(event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Enter' && this.activeId) {
        const entry = this.filtered.find((e) => e.id === this.activeId);
        if (entry) this.onSelect?.(entry);
      }
    });
  }

  setEntries(entries: LibraryEntry[]): void {
    this.entries = entries;
    this.render();
  }

  get items(): LibraryEntry[] {
    return this.filtered;
  }

  setActive(id: string | null): void {
    this.activeId = id;
    for (const child of this.host.querySelectorAll<HTMLElement>('.lib-item')) {
      child.classList.toggle('is-active', child.dataset.id === id);
    }
    const active = this.host.querySelector<HTMLElement>('.lib-item.is-active');
    active?.scrollIntoView({ block: 'nearest' });
  }

  /** Move the selection by `delta` within the filtered list and load it. */
  step(delta: number): void {
    if (this.filtered.length === 0) return;
    const index = this.filtered.findIndex((e) => e.id === this.activeId);
    const next = index < 0 ? 0 : (index + delta + this.filtered.length) % this.filtered.length;
    const entry = this.filtered[next];
    this.setActive(entry.id);
    this.onSelect?.(entry);
  }

  /** Pick a random entry other than the current one. */
  random(): LibraryEntry | null {
    if (this.filtered.length === 0) return null;
    if (this.filtered.length === 1) return this.filtered[0];
    let entry: LibraryEntry;
    do {
      entry = this.filtered[(Math.random() * this.filtered.length) | 0];
    } while (entry.id === this.activeId);
    return entry;
  }

  private render(): void {
    const query = this.query;
    this.filtered = query
      ? this.entries.filter(
          (entry) =>
            entry.name.toLowerCase().includes(query) ||
            entry.group.toLowerCase().includes(query),
        )
      : this.entries;

    this.host.replaceChildren();

    if (this.filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'lib-empty';
      empty.textContent = this.entries.length === 0
        ? 'Nothing here yet. Use Import to add presets.'
        : 'No matches.';
      this.host.appendChild(empty);
      return;
    }

    // Building thousands of nodes one at a time thrashes layout; a fragment
    // keeps it to a single insertion.
    const fragment = document.createDocumentFragment();
    let lastGroup: string | null = null;

    for (const entry of this.filtered) {
      if (entry.group !== lastGroup) {
        lastGroup = entry.group;
        const heading = document.createElement('div');
        heading.className = 'lib-group';
        heading.textContent = entry.group || 'Library';
        fragment.appendChild(heading);
      }

      const item = document.createElement('button');
      item.className = 'lib-item';
      item.dataset.id = entry.id;
      if (entry.id === this.activeId) item.classList.add('is-active');

      const name = document.createElement('span');
      name.className = 'lib-name';
      name.textContent = entry.name;
      name.title = entry.name;
      item.appendChild(name);

      if (!entry.builtin) {
        const badge = document.createElement('span');
        badge.className = 'lib-badge';
        badge.textContent = 'MINE';
        item.appendChild(badge);
      }

      item.addEventListener('click', () => {
        this.setActive(entry.id);
        this.onSelect?.(entry);
      });

      item.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        // Deliberately does not call setActive: the highlight means "currently
        // playing", and right-clicking to rename must not imply a preset change.
        this.onContextMenu?.(entry, event.clientX, event.clientY);
      });

      fragment.appendChild(item);
    }

    this.host.appendChild(fragment);
  }
}

export interface LibraryTabsCallbacks {
  onChange: (kind: LibraryKind) => void;
}

/** The MilkDrop / Shaders tab strip above the library. */
export class LibraryTabs {
  private buttons: HTMLButtonElement[];
  kind: LibraryKind = 'milk';

  constructor(host: HTMLElement, callbacks: LibraryTabsCallbacks) {
    this.buttons = [...host.querySelectorAll<HTMLButtonElement>('.tab')];
    for (const button of this.buttons) {
      button.addEventListener('click', () => {
        const kind = button.dataset.kind as LibraryKind;
        if (kind === this.kind) return;
        this.select(kind);
        callbacks.onChange(kind);
      });
    }
  }

  select(kind: LibraryKind): void {
    this.kind = kind;
    for (const button of this.buttons) {
      button.classList.toggle('is-active', button.dataset.kind === kind);
    }
  }
}
