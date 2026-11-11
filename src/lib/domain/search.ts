import type { Note } from './notes';
export function filterNotes(notes: Note[], query: string): Note[] {
  const q = query.trim().toLowerCase();
  return notes
    .filter((n) => n.deletedAt === null && n.markdown.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}
