import type { ColorToken } from '../domain/notes';
/** Marker colors only: Markdown and editor foregrounds retain their own contrast. */
export const markerColors: Record<ColorToken, string> = {
  red: '#e57f84',
  orange: '#e5a05f',
  yellow: '#d7bb64',
  green: '#8dbe8a',
  teal: '#62bdc4',
  blue: '#78ace0',
  purple: '#ad95d9',
  pink: '#d894bd',
  gray: '#a0a0a0',
};
