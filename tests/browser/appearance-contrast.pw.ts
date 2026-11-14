import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark']) {
  test(`${theme} shortcut keycaps meet normal text contrast`, async ({
    page,
  }) => {
    await page.goto('/?fixture');
    await page
      .getByRole('radio', {
        name: theme === 'light' ? 'Light' : 'Dark',
        exact: true,
      })
      .check();
    const contrasts = await page
      .locator('.shortcut-list kbd, .composer kbd')
      .evaluateAll((keys) => {
        function luminance(color: string) {
          const channels = color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((n) => {
              n /= 255;
              return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
            });
          return (
            channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
          );
        }
        return keys.map((key) => {
          const style = getComputedStyle(key);
          const foreground = luminance(style.color);
          const background = luminance(style.backgroundColor);
          return {
            key: key.textContent,
            ratio:
              (Math.max(foreground, background) + 0.05) /
              (Math.min(foreground, background) + 0.05),
          };
        });
      });
    expect(contrasts.length).toBeGreaterThan(0);
    for (const key of contrasts)
      expect(key.ratio, `${key.key} keycap`).toBeGreaterThanOrEqual(4.5);
  });
}
