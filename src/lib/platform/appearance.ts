export type AppearancePreference = 'system' | 'light' | 'dark';
export type ResolvedAppearance = 'light' | 'dark';
export const appearanceStorageKey = 'scratchtree.appearance';

type AppearanceOptions = {
  read: () => string | null;
  write: (preference: AppearancePreference) => void;
  media: {
    readonly matches: boolean;
    addEventListener: (type: 'change', listener: () => void) => void;
    removeEventListener: (type: 'change', listener: () => void) => void;
  };
  apply: (theme: ResolvedAppearance, preference: AppearancePreference) => void;
  nativeTheme?: (theme: ResolvedAppearance | null) => Promise<void>;
};

export function createAppearanceController(options: AppearanceOptions) {
  let preference: AppearancePreference = 'system';
  try {
    const saved = options.read();
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch {
    // Device UI preferences must never prevent the library from opening.
  }
  let disposed = false;
  let running = false;
  let pending: { theme: ResolvedAppearance | null } | undefined;
  async function updateNative() {
    if (running || !options.nativeTheme) return;
    running = true;
    try {
      while (pending && !disposed) {
        const captured = pending;
        pending = undefined;
        try {
          await options.nativeTheme(captured.theme);
        } catch {
          // Native chrome is independent of note persistence and web appearance.
        }
      }
    } finally {
      running = false;
    }
  }
  function apply() {
    options.apply(
      preference === 'system'
        ? options.media.matches
          ? 'dark'
          : 'light'
        : preference,
      preference,
    );
  }
  function requestNative() {
    pending = { theme: preference === 'system' ? null : preference };
    void updateNative();
  }
  function systemChanged() {
    if (preference === 'system') apply();
  }
  options.media.addEventListener('change', systemChanged);
  apply();
  requestNative();
  return {
    get preference() {
      return preference;
    },
    setPreference(next: AppearancePreference) {
      if (disposed || !['system', 'light', 'dark'].includes(next)) return;
      preference = next;
      try {
        options.write(preference);
      } catch {
        /* Keep session choice usable. */
      }
      apply();
      requestNative();
    },
    dispose() {
      disposed = true;
      pending = undefined;
      options.media.removeEventListener('change', systemChanged);
    },
  };
}
