import { writeFileSync } from 'node:fs';
const output = process.argv[2];
if (!output)
  throw new Error('Supply an output path for a synthetic BackupV7 file.');
const items = Array.from({ length: 1000 }, (_, i) => {
  const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
  const head = `Synthetic note ${String(i + 1).padStart(4, '0')} **visible**\n`;
  return {
    id,
    parentId: null,
    kind: 'note',
    done: false,
    color: null,
    position: i,
    restoreParentId: null,
    restoreIndex: null,
    markdown: head + 'x'.repeat((i === 999 ? 128 * 1024 : 1024) - head.length),
    createdAt: i,
    updatedAt: i,
    deletedAt: null,
  };
});
writeFileSync(
  output,
  JSON.stringify({
    format: 'scratchtree-alpha',
    version: 7,
    exportedAt: new Date().toISOString(),
    library: { items, drafts: [], undoDeleteIds: [] },
  }),
);
console.log(`Wrote 999 × 1 KiB notes and one 128 KiB note to ${output}`);
