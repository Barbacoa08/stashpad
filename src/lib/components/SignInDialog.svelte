<script lang="ts">
  import { tick, untrack } from 'svelte';
  import type { AuthPort, AuthState } from '../sync/service-types';
  let { auth, value }: { auth: AuthPort; value: AuthState } = $props();
  let email = $state(untrack(() => value.email));
  let code = $state('');
  let dialog: HTMLDialogElement;
  let emailInput: HTMLInputElement;
  let codeInput: HTMLInputElement;
  let verificationStatus = $state<HTMLElement>();
  let emailValid = $state(false);
  let submitting = false;
  let priorPhase = untrack(() => value.phase);
  function mount(node: HTMLDialogElement) {
    dialog = node;
    node.showModal();
    void tick().then(() => {
      emailValid = emailInput.validity.valid;
      emailInput.focus();
    });
    return { destroy: () => node.close() };
  }
  $effect(() => {
    const phase = value.phase;
    if (phase === 'code' && priorPhase !== 'code')
      void tick().then(() => codeInput?.focus());
    if (phase === 'verifying' && priorPhase !== 'verifying')
      void tick().then(() => verificationStatus?.focus());
    if (phase === 'email' && priorPhase !== 'email')
      void tick().then(() => {
        emailValid = emailInput.validity.valid;
        emailInput.focus();
      });
    priorPhase = phase;
  });
  function dismiss() {
    if (value.canCancel) auth.dismiss();
  }
  function keydown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'input:not(:disabled),button:not(:disabled)',
      ),
    );
    if (!controls.length) {
      event.preventDefault();
      return;
    }
    const i = controls.indexOf(document.activeElement as HTMLElement);
    if (
      i < 0 ||
      (event.shiftKey && i === 0) ||
      (!event.shiftKey && i === controls.length - 1)
    ) {
      event.preventDefault();
      controls[event.shiftKey ? controls.length - 1 : 0].focus();
    }
  }
  async function submit() {
    if (submitting) return;
    submitting = true;
    try {
      if (value.phase === 'email' && emailValid) {
        code = '';
        await auth.submitEmail(email.trim());
      } else if (value.phase === 'code' && code.trim())
        await auth.submitCode(code);
    } finally {
      submitting = false;
    }
  }
</script>

<dialog
  class="auth-dialog"
  use:mount
  aria-labelledby="auth-title"
  onkeydown={keydown}
  oncancel={(e) => {
    e.preventDefault();
    dismiss();
  }}
  onclick={(e) => {
    const rect = dialog.getBoundingClientRect();
    if (
      e.target === dialog &&
      (e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom)
    )
      dismiss();
  }}
>
  <form
    onsubmit={(e) => {
      e.preventDefault();
      void submit();
    }}
  >
    <h2 id="auth-title">Sign in / sign up</h2>
    <label for="auth-email">Email</label>
    <input
      id="auth-email"
      bind:this={emailInput}
      type="email"
      required
      autocomplete="email"
      bind:value={email}
      disabled={value.phase !== 'email'}
      oninput={(e) => (emailValid = e.currentTarget.validity.valid)}
    />
    <label for="auth-code">Code</label>
    {#if value.phase === 'email' || value.phase === 'sending-code'}<p
        class="auth-instruction"
      >
        Send a code to enable this field.
      </p>{/if}
    <input
      id="auth-code"
      bind:this={codeInput}
      autocomplete="one-time-code"
      bind:value={code}
      disabled={value.phase !== 'code'}
    />
    {#if value.error}<p role="alert">{value.error}</p>{/if}
    {#if value.phase === 'verifying'}<p
        role="status"
        tabindex="-1"
        bind:this={verificationStatus}
      >
        Finishing sign in. Please wait.
      </p>{/if}
    {#if value.phase === 'syncing' && !value.join}<p role="status">
        Signed in. Initial sync is pending.
      </p>{/if}
    {#if value.phase === 'sending-code'}<p role="status">Sending code…</p>{/if}
    {#if value.join}
      <p>
        This Mac has {value.join.localNotes} notes. Synced notes: {value.join
          .cloudNotes}.
      </p>
      <p>This Mac’s notes will be kept in recovery.</p>
    {/if}
    <div class="auth-actions">
      {#if value.canCancel}<button type="button" onclick={dismiss}>Close</button
        >{/if}
      {#if value.join}
        <button
          type="button"
          disabled={!auth.acceptCloud}
          onclick={() => void auth.acceptCloud?.()}>Use synced notes</button
        >
      {:else if value.phase === 'syncing' && value.error}<button
          type="button"
          onclick={() => void auth.retrySync()}>Retry sync</button
        >
      {:else if value.phase === 'email' || value.phase === 'sending-code'}<button
          type="submit"
          disabled={value.phase !== 'email' || !emailValid}>Send code</button
        >
      {:else if value.phase === 'code' || value.phase === 'verifying'}
        {#if value.phase === 'code' && auth.restartSignIn}<button
            type="button"
            onclick={() => auth.restartSignIn?.()}>Start over</button
          >{/if}
        <button type="submit" disabled={value.phase !== 'code' || !code.trim()}
          >Sign in</button
        >{/if}
    </div>
  </form>
</dialog>
