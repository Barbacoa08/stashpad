<script lang="ts">
  import type { Note } from '../domain/notes';
  let {
    notes,
    selected,
    onselect,
    disabled = false,
  }: {
    notes: Note[];
    selected: string;
    onselect: (id: string) => void;
    disabled?: boolean;
  } = $props();
  const label = (n: Note) =>
    n.markdown
      .split('\n')
      .find((line) => line.trim())
      ?.slice(0, 120) ?? 'Untitled';
</script>

<ul aria-label="Saved notes" class="note-list">
  {#each notes as note (note.id)}<li>
      <button
        class:selected={selected === note.id}
        aria-current={selected === note.id ? 'true' : undefined}
        onclick={() => onselect(note.id)}
        {disabled}>{label(note)}</button
      >
    </li>{/each}
</ul>
{#if notes.length === 0}<p class="empty-list">No matching saved notes.</p>{/if}
