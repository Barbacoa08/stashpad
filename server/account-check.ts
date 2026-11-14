const origins = new Set(['tauri://localhost', 'http://127.0.0.1:4511']);
const validEmail = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

async function readBody(request: Request) {
  if (!request.body) throw new Error('Missing body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1024) {
        await reader.cancel();
        throw Object.assign(new Error('Request too large'), { status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  ) as unknown;
}

/** Eligibility only: Dexie still authenticates and authorizes every actual session. */
export function createAccountCheck(emails: string[]) {
  const configured =
    emails.length > 0 && emails.length <= 1000 && emails.every(validEmail);
  const allowed = new Set(
    configured ? emails.map((email) => email.trim().toLowerCase()) : [],
  );
  return async (request: Request) => {
    const origin = request.headers.get('origin') ?? '';
    const headers = new Headers({
      'Cache-Control': 'no-store',
      Vary: 'Origin',
    });
    const json = (value: unknown, status = 200) =>
      Response.json(value, { status, headers });
    if (!origins.has(origin))
      return json({ error: 'Origin is not allowed.' }, 403);
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') {
      headers.set('Allow', 'POST, OPTIONS');
      return json({ error: 'Method is not allowed.' }, 405);
    }
    if (!configured)
      return json(
        { error: 'Account check is unavailable. Try again later.' },
        503,
      );
    if (
      request.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase() !== 'application/json'
    )
      return json({ error: 'Use application/json.' }, 415);
    try {
      const value = await readBody(request);
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        !('email' in value) ||
        !validEmail(value.email)
      )
        return json({ error: 'Enter a valid email.' }, 400);
      return json({ exists: allowed.has(value.email.trim().toLowerCase()) });
    } catch (error) {
      return json(
        { error: 'Invalid request.' },
        error &&
          typeof error === 'object' &&
          'status' in error &&
          error.status === 413
          ? 413
          : 400,
      );
    }
  };
}
