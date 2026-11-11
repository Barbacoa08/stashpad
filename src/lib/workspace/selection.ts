import type { Location } from '../domain/notes';
/** View-only keyboard memory, keyed by exact location and entry identities. */
export class LocationSelection {
  private entries = new Map<string | null, string>();
  private key(location: Location | string | null) {
    return typeof location === 'object' && location !== null
      ? (location.itemId ??
          (location.scope === 'trash' ? 'compose:trash' : null))
      : location;
  }
  remember(location: Location | string | null, entry: string) {
    if (entry) this.entries.set(this.key(location), entry);
  }
  open(
    location: Location | string | null,
    valid: string[],
    preferred?: string,
  ) {
    const candidate = preferred ?? this.entries.get(this.key(location));
    return candidate && valid.includes(candidate)
      ? candidate
      : (valid[0] ?? '');
  }
  clear() {
    this.entries.clear();
  }
}
