import { writeFileSync } from 'node:fs';
const output = process.argv[2];
if (!output)
  throw new Error('Supply an output path for a synthetic BackupV1 file.');
const notes = Array.from({ length: 1000 }, (_, i) => {
  const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
  const head = `Synthetic note ${String(i + 1).padStart(4, '0')} **visible**\n`;
  return {
    id,
    markdown: head + 'x'.repeat((i === 999 ? 128 * 1024 : 1024) - head.length),
    createdAt: i,
    updatedAt: i,
    deletedAt: null,
  };
});
writeFileSync(
  output,
  JSON.stringify({
    format: 'stashpad-alpha',
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace: { notes, drafts: [], undoDeleteId: null },
  }),
);
console.log(`Wrote 999 × 1 KiB notes and one 128 KiB note to ${output}`);
