import type { Item } from '../../src/lib/domain/notes';
/** Public, deterministic development examples. Never loaded into native profiles. */
const sources = [
  '# Capture ideas without losing the source\nMarkdown stays **bold**, *expressive*, and ***editable***. Keep `small details` close to the work.',
  '## Today\n- Review the keyboard workflow\n  - Capture a note\n  - Edit it in place\n- Keep the next idea ready in the composer',
  '```js\n// A small local example\nconst notes = ["idea", "question"];\nfunction capture(text) {\n  return { text, saved: true };\n}\n```',
  'A note can hold several paragraphs. Saved cards show the full text so a thought does not disappear behind a title.\n\nSelect the card, press E, and work directly with its Markdown.',
  '```ts\ninterface Capture {\n  source: string;\n  saved: boolean;\n}\nconst next: Capture = { source: "Try it", saved: false };\n```',
  '```json\n{\n  "workspace": "local",\n  "next": ["write", "review", "save"]\n}\n```',
  '## A longer source line\n```text\nGET /local/example?view=notes&sort=created&source=synthetic&purpose=horizontal-overflow-check-without-moving-the-page\n```',
  'Fresh capture goes here.\n\nShift+Enter adds another line. Enter saves the exact Markdown and makes room for the next note.',
];
export const visualNotes: Item[] = sources.map((markdown, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  markdown,
  createdAt: 1794351600000 + index * 60000,
  updatedAt: 1794351600000 + index * 60000,
  parentId: null,
  kind: 'note',
  color: null,
  position: index,
  restoreParentId: null,
  restoreIndex: null,
  done: false,
  deletedAt: null,
}));
