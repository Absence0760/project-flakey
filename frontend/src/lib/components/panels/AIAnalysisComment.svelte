<script lang="ts">
  import { analyzeTest, type AIAnalysis } from "$lib/api";
  import { classificationLabel } from "$lib/utils/ai";

  interface Props {
    // The failed test to analyze. The backend resolves this to the shared
    // error fingerprint, so the result is cached alongside the /errors view.
    testId: number;
    // Whether an AI provider is configured instance-wide. When false we render
    // nothing, rather than teasing a disabled feature.
    enabled: boolean;
  }

  let { testId, enabled }: Props = $props();

  let analysis = $state<AIAnalysis | null>(null);
  let loading = $state(false);
  let failed = $state(false);

  // Button-triggered (not on mount) to match the /errors view and avoid a
  // surprise model call every time the modal opens. A cache hit returns
  // instantly; only a genuine miss (or refresh) spends a model call.
  async function run(refresh = false) {
    if (loading) return;
    loading = true;
    failed = false;
    try {
      analysis = await analyzeTest(testId, refresh);
    } catch {
      failed = true;
    }
    loading = false;
  }
</script>

{#if enabled}
  <div class="ai-comment" class:has-result={!!analysis}>
    <span class="ai-chip" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z"/>
        <path d="M19 14l.8 2 .2.8 2 .2-2 .8-.2 2-.8-2-2-.2 2-.8.2-2z"/>
      </svg>
    </span>
    <div class="ai-main">
      <div class="ai-comment-header">
        <span class="ai-author">Flakey AI</span>
        {#if analysis}
          <span class="ai-badge">{classificationLabel(analysis.classification)}</span>
          <span class="ai-confidence">{Math.round(analysis.confidence * 100)}% confidence</span>
        {/if}
      </div>

      {#if analysis}
        <p class="ai-summary">{analysis.summary}</p>
        <p class="ai-fix"><strong>Suggested fix:</strong> {analysis.suggested_fix}</p>
        <button class="ai-rerun" onclick={() => run(true)} disabled={loading}>
          {loading ? "Re-analyzing…" : "Re-analyze"}
        </button>
      {:else}
        <p class="ai-prompt">Get an AI read on why this test failed and how to fix it.</p>
        {#if failed}
          <p class="ai-error" role="alert">Analysis failed — try again.</p>
        {/if}
        <button class="ai-analyze" onclick={() => run()} disabled={loading}>
          {loading ? "Analyzing…" : "Analyze with AI"}
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* A comment-styled card matching NotesPanel's .note grid, tinted with the
     link accent so it reads as a distinct AI-authored entry in the thread. */
  .ai-comment {
    display: grid; grid-template-columns: auto 1fr; gap: 0.55rem;
    padding: 0.5rem 0.6rem; margin-bottom: 0.55rem;
    background: color-mix(in srgb, var(--link) 5%, transparent);
    border: 1px solid color-mix(in srgb, var(--link) 22%, transparent);
    border-radius: 6px;
  }

  .ai-chip {
    flex: 0 0 auto;
    display: inline-flex; align-items: center; justify-content: center;
    width: 1.5rem; height: 1.5rem; margin-top: 0.05rem;
    border-radius: 999px;
    background: linear-gradient(135deg, var(--link), #8b5cf6);
    color: #fff;
  }

  .ai-main { min-width: 0; }
  .ai-comment-header {
    display: flex; align-items: center; gap: 0.45rem;
    margin-bottom: 0.2rem; flex-wrap: wrap;
  }
  .ai-author { font-size: 0.72rem; font-weight: 600; color: var(--text); }
  .ai-badge {
    padding: 0.1rem 0.45rem; border-radius: 10px;
    font-size: 0.65rem; font-weight: 600;
    background: var(--link); color: #fff;
  }
  .ai-confidence { font-size: 0.66rem; color: var(--text-muted); }

  .ai-summary {
    margin: 0 0 0.25rem; font-size: 0.8rem; color: var(--text);
    line-height: 1.45; word-break: break-word;
  }
  .ai-fix {
    margin: 0 0 0.4rem; font-size: 0.76rem; color: var(--text-secondary);
    line-height: 1.45; word-break: break-word;
  }
  .ai-prompt { margin: 0 0 0.4rem; font-size: 0.76rem; color: var(--text-muted); line-height: 1.4; }
  .ai-error { margin: 0 0 0.4rem; font-size: 0.74rem; color: var(--error, #ef4444); }

  .ai-analyze, .ai-rerun {
    border: none; border-radius: 6px; cursor: pointer;
    font-size: 0.72rem; font-weight: 600;
    transition: opacity 0.15s, background 0.15s;
  }
  .ai-analyze {
    padding: 0.35rem 0.75rem; background: var(--link); color: #fff;
  }
  .ai-analyze:hover:not(:disabled) { background: color-mix(in srgb, var(--link) 88%, #000); }
  .ai-rerun {
    padding: 0.25rem 0.55rem; background: transparent;
    color: var(--text-muted); border: 1px solid var(--border);
  }
  .ai-rerun:hover:not(:disabled) { color: var(--text-secondary); border-color: var(--text-muted); }
  .ai-analyze:disabled, .ai-rerun:disabled { opacity: 0.55; cursor: wait; }
  .ai-analyze:focus-visible, .ai-rerun:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
</style>
