import { invoke, isTauri } from '@tauri-apps/api/core';
import { externalUrl } from '../domain/markdown';
export async function copyMarkdown(source: string): Promise<void> {
  if (isTauri()) await invoke('clipboard_write_text', { text: source });
  else await navigator.clipboard.writeText(source);
}
export async function openExternal(source: string): Promise<void> {
  const url = externalUrl(source);
  if (!url)
    throw new Error(
      'This link cannot be opened. Only HTTP, HTTPS, and mailto links are supported.',
    );
  if (isTauri()) await invoke('external_open_url', { url });
  // noopener can return null on success, so do not infer success from the handle.
  else window.open(url, '_blank', 'noopener,noreferrer');
}
