import { describe, expect, it, vi } from 'vitest';
import { createAccountCheck } from '../../server/account-check';
import netlifyAccountCheck from '../../netlify/functions/account-check';
import { createAccountPreflight } from '../../src/lib/sync/account-preflight';

const origin = 'tauri://localhost';
const request = (
  email = 'developer@example.invalid',
  extra: RequestInit = {},
) =>
  new Request('https://scratchtree.example.invalid/api/account-exists', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
    ...extra,
  });
const handler = () => createAccountCheck(['developer@example.invalid']);

describe('private server account preflight', () => {
  it('accepts a listed email without sending any code or returning the list', async () => {
    const response = await handler()(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ exists: true });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
  });
  it('rejects an unknown email before any Dexie interaction', async () => {
    const response = await handler()(request('unknown@example.invalid'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ exists: false });
  });
  it('matches trimmed email identities case-insensitively', async () => {
    expect(
      await (await handler()(request(' Developer@Example.Invalid '))).json(),
    ).toEqual({ exists: true });
  });
  it('fails closed when the private server list is missing or malformed', async () => {
    for (const emails of [[], ['not an email']]) {
      const response = await createAccountCheck(emails)(request());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: 'Account check is unavailable. Try again later.',
      });
    }
  });
  it('fails closed when the deployed private list contains an empty entry', async () => {
    vi.stubEnv('SCRATCHTREE_ALLOWED_EMAILS', 'developer@example.invalid,');
    try {
      expect((await netlifyAccountCheck(request())).status).toBe(503);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('allows an exact known-origin preflight without exposing credentials', async () => {
    const response = await handler()(
      new Request(request().url, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toBe(
      'POST, OPTIONS',
    );
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });
  it('rejects unlisted, missing, and opaque browser origins', async () => {
    for (const value of [
      'https://unrelated.example.invalid',
      'null',
      'tauri://localhost.evil.invalid',
      '',
    ]) {
      const response = await handler()(
        request(undefined, {
          headers: { Origin: value, 'Content-Type': 'application/json' },
        }),
      );
      expect(response.status).toBe(403);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
  });
  it('rejects methods, invalid JSON, extra fields, invalid emails, and wrong content types', async () => {
    const cases: [RequestInit, number][] = [
      [{ method: 'GET', body: undefined }, 405],
      [{ body: '{' }, 400],
      [
        {
          body: JSON.stringify({
            email: 'developer@example.invalid',
            another: true,
          }),
        },
        400,
      ],
      [{ body: JSON.stringify({ email: 'not an email' }) }, 400],
      [{ headers: { Origin: origin, 'Content-Type': 'text/plain' } }, 415],
    ];
    for (const [options, status] of cases)
      expect((await handler()(request(undefined, options))).status).toBe(
        status,
      );
  });
  it('rejects oversized and invalid UTF-8 bodies without parsing or truncating them', async () => {
    for (const body of [' '.repeat(1025), new Uint8Array([0xff, 0xfe])]) {
      const response = await handler()(request(undefined, { body }));
      expect([400, 413]).toContain(response.status);
    }
  });
});

describe('desktop account preflight client', () => {
  it('uses only the configured HTTPS endpoint and returns the exact boolean', async () => {
    let transmitted: {
      url: string;
      body: unknown;
      credentials: unknown;
    } | null = null;
    const check = createAccountPreflight(
      'https://scratchtree.example.invalid/api/account-exists',
      async (input, init) => {
        transmitted = {
          url: String(input),
          body: JSON.parse(String(init?.body)),
          credentials: init?.credentials,
        };
        return Response.json({ exists: true });
      },
    );
    expect(await check('developer@example.invalid')).toBe(true);
    expect(transmitted).toEqual({
      url: 'https://scratchtree.example.invalid/api/account-exists',
      body: { email: 'developer@example.invalid' },
      credentials: 'omit',
    });
  });
  it('returns false only for an explicit valid unknown-account response', async () => {
    expect(
      await createAccountPreflight(
        'https://scratchtree.example.invalid/api/account-exists',
        async () => Response.json({ exists: false }),
      )('unknown@example.invalid'),
    ).toBe(false);
  });
  it('does not treat transport, rate-limit, server, or malformed responses as unknown accounts', async () => {
    for (const response of [
      Response.json({ exists: false }, { status: 503 }),
      Response.json({}, { status: 429 }),
      Response.json({ exists: 'yes' }),
      Response.json({ exists: false, emails: ['private'] }),
      new Response('not JSON'),
    ]) {
      await expect(
        createAccountPreflight(
          'https://scratchtree.example.invalid/api/account-exists',
          async () => response,
        )('developer@example.invalid'),
      ).rejects.toThrow();
    }
  });
  it('fails before transmission if the endpoint is insecure or includes credentials', async () => {
    for (const endpoint of [
      'http://example.invalid/api/account-exists',
      'https://user:password@example.invalid/api/account-exists',
      'not a URL',
    ]) {
      let transmitted = false;
      await expect(async () =>
        createAccountPreflight(endpoint, async () => {
          transmitted = true;
          return Response.json({ exists: true });
        })('developer@example.invalid'),
      ).rejects.toThrow();
      expect(transmitted).toBe(false);
    }
  });
});
