export function createAccountPreflight(
  endpoint: string,
  fetcher: typeof fetch = fetch,
) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('Account checking is not configured.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new Error('Account checking needs a secure endpoint.');
  return async (email: string): Promise<boolean> => {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 8000);
    try {
      const response = await fetcher(url.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({ email }),
        signal: abort.signal,
      });
      if (!response.ok)
        throw new Error('Account check failed. Try again later.');
      const value: unknown = await response.json();
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        !('exists' in value) ||
        typeof value.exists !== 'boolean'
      )
        throw new Error(
          'Account check returned an invalid response. Try again later.',
        );
      return value.exists;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Account check'))
        throw error;
      throw new Error('Account check failed. Try again later.');
    } finally {
      clearTimeout(timeout);
    }
  };
}
