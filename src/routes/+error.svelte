<script lang="ts">
  import { diagnosticText } from '../lib/platform/diagnostics';
  const details = diagnosticText();
</script>

<svelte:head><title>Scratchtree — View error</title></svelte:head>
<main class="error-page">
  <section aria-labelledby="error-heading">
    <h1 id="error-heading">The notes view encountered an error</h1>
    <p>
      Submitted notes may already be saved. Unsaved input may not have been
      checkpointed and may be lost when you reload.
    </p>
    <button onclick={() => location.reload()}>Reload view</button>
    {#if details}
      <label for="diagnostic-details">Diagnostic details</label>
      <p class="explanation">
        Select these details to copy them when reporting the issue. They exclude
        note contents and error messages.
      </p>
      <textarea id="diagnostic-details" readonly value={details} rows="12"
      ></textarea>
    {:else}
      <p>Diagnostic details are unavailable.</p>
    {/if}
  </section>
</main>

<style>
  .error-page {
    min-height: 0;
    height: 100dvh;
    overflow: auto;
    padding: 2rem 1rem;
    background: var(--canvas, #000);
    color: var(--foreground, #ededed);
    font:
      1rem/1.5 -apple-system,
      BlinkMacSystemFont,
      'Segoe UI',
      sans-serif;
  }
  section {
    width: min(100%, 42rem);
    margin: auto;
    padding: 1.5rem;
    border: 1px solid var(--border, #777);
    border-radius: 0.5rem;
    background: var(--panel, #141414);
  }
  h1 {
    font-size: 1.3rem;
    margin: 0 0 1rem;
  }
  p {
    margin: 0 0 1rem;
  }
  button {
    padding: 0.6rem 1rem;
    margin-bottom: 1.5rem;
    color: var(--foreground, #ededed);
    background: var(--control, #222);
    border: 1px solid var(--border, #777);
    border-radius: 0.25rem;
    font: inherit;
    cursor: pointer;
  }
  button:focus-visible,
  textarea:focus-visible {
    outline: 3px solid var(--focus, #9bcaff);
    outline-offset: 3px;
  }
  label {
    display: block;
    font-weight: 600;
  }
  .explanation {
    font-size: 0.9rem;
    color: var(--muted, #bbb);
    margin: 0.5rem 0;
  }
  textarea {
    display: block;
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    padding: 0.75rem;
    color: var(--foreground, #ededed);
    background: var(--canvas, #000);
    border: 1px solid var(--border, #777);
    font:
      0.8rem/1.5 ui-monospace,
      monospace;
  }
</style>
