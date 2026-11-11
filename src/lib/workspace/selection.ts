/** View-only keyboard memory, keyed by exact location and entry identities. */
export class LocationSelection {
  private entries = new Map<string | null, string>();
  remember(location: string | null, entry: string) {
    if (entry) this.entries.set(location, entry);
  }
  open(location: string | null, valid: string[], preferred?: string) {
    const candidate = preferred ?? this.entries.get(location);
    return candidate && valid.includes(candidate)
      ? candidate
      : (valid[0] ?? '');
  }
  clear() {
    this.entries.clear();
  }
}
