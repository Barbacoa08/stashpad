import { expect, it } from 'vitest';

async function setup(saved: string | null = null, dark = false) {
  // Import within the test so missing appearance support is a RED test failure.
  const { createAppearanceController } =
    await import('../../src/lib/platform/appearance');
  let preference = saved;
  let listener: (() => void) | undefined;
  const themes: string[] = [];
  const media = {
    matches: dark,
    addEventListener: (_: 'change', handler: () => void) => {
      listener = handler;
    },
    removeEventListener: (_: 'change', handler: () => void) => {
      if (listener === handler) listener = undefined;
    },
  };
  const controller = createAppearanceController({
    read: () => preference,
    write: (value) => {
      preference = value;
    },
    media,
    apply: (theme) => themes.push(theme),
  });
  return {
    controller,
    themes,
    saved: () => preference,
    system: (value: boolean) => {
      media.matches = value;
      listener?.();
    },
  };
}

it('defaults invalid preference to system and follows live system changes', async () => {
  const state = await setup('not-an-appearance');
  expect(state.controller.preference).toBe('system');
  expect(state.themes).toEqual(['light']);
  state.system(true);
  expect(state.themes).toEqual(['light', 'dark']);
  state.controller.dispose();
  state.system(false);
  expect(state.themes).toEqual(['light', 'dark']);
});

it('persists explicit choice, ignores OS changes, and resumes system when selected', async () => {
  const state = await setup('light', true);
  expect(state.themes).toEqual(['light']);
  state.system(false);
  state.system(true);
  expect(state.themes).toEqual(['light']);
  state.controller.setPreference('dark');
  expect(state.saved()).toBe('dark');
  state.controller.setPreference('system');
  expect(state.saved()).toBe('system');
  state.system(false);
  expect(state.themes).toEqual(['light', 'dark', 'dark', 'light']);
});

it('keeps preference usable when storage is unavailable', async () => {
  const { createAppearanceController } =
    await import('../../src/lib/platform/appearance');
  const themes: string[] = [];
  const controller = createAppearanceController({
    read: () => {
      throw new Error('storage unavailable');
    },
    write: () => {
      throw new Error('storage unavailable');
    },
    media: { matches: true, addEventListener() {}, removeEventListener() {} },
    apply: (theme) => themes.push(theme),
  });
  expect(controller.preference).toBe('system');
  expect(() => controller.setPreference('light')).not.toThrow();
  expect(controller.preference).toBe('light');
  expect(themes).toEqual(['dark', 'light']);
});

it('serializes native changes, coalesces pending choices, and recovers from rejection', async () => {
  const { createAppearanceController } =
    await import('../../src/lib/platform/appearance');
  const pending: Array<{
    theme: string | null;
    resolve: () => void;
    reject: () => void;
  }> = [];
  const controller = createAppearanceController({
    read: () => null,
    write() {},
    media: { matches: false, addEventListener() {}, removeEventListener() {} },
    apply() {},
    nativeTheme: (theme) =>
      new Promise<void>((resolve, reject) =>
        pending.push({
          theme,
          resolve,
          reject: () => reject(new Error('native unavailable')),
        }),
      ),
  });
  expect(pending.map((p) => p.theme)).toEqual([null]);
  controller.setPreference('dark');
  controller.setPreference('light');
  expect(pending).toHaveLength(1);
  pending[0].reject();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(pending.map((p) => p.theme)).toEqual([null, 'light']);
  pending[1].resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.setPreference('system');
  expect(pending.map((p) => p.theme)).toEqual([null, 'light', null]);
  pending[2].resolve();
  controller.dispose();
});
