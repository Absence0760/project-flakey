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
  <div class="ai-card" class:has-result={!!analysis}>
    <div class="ai-card-head">
      <span class="ai-title">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z"/>
          <path d="M19 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z"/>
        </svg>
        AI Analysis
      </span>
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
{/if}

<style>
  /* An inline insight card, sibling to the error block it sits beneath.
     Link-accent tinted so it reads as a distinct AI surface — the now-
     conventional "✦ = AI here" cue — without competing with the error. */
  .ai-card {
    margin-top: 0.6rem;
    padding: 0.6rem 0.7rem;
    background: color-mix(in srgb, var(--link) 5%, transparent);
    border: 1px solid color-mix(in srgb, var(--link) 20%, transparent);
    border-radius: 8px;
  }

  .ai-card-head {
    display: flex; align-items: center; gap: 0.5rem;
    margin-bottom: 0.4rem; flex-wrap: wrap;
  }
  .ai-title {
    display: inline-flex; align-items: center; gap: 0.3rem;
    font-size: 0.7rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--link);
  }
  .ai-badge {
    padding: 0.12rem 0.5rem; border-radius: 10px;
    font-size: 0.68rem; font-weight: 600;
    background: var(--link); color: #fff;
  }
  /* Confidence trails to the right edge of the header. */
  .ai-confidence { margin-left: auto; font-size: 0.68rem; color: var(--text-muted); }

  .ai-summary {
    margin: 0 0 0.3rem; font-size: 0.82rem; color: var(--text);
    line-height: 1.45; word-break: break-word;
  }
  .ai-fix {
    margin: 0 0 0.5rem; font-size: 0.78rem; color: var(--text-secondary);
    line-height: 1.45; word-break: break-word;
  }
  .ai-prompt { margin: 0 0 0.5rem; font-size: 0.78rem; color: var(--text-muted); line-height: 1.4; }
  .ai-error { margin: 0 0 0.5rem; font-size: 0.76rem; color: var(--error, #ef4444); }

  .ai-analyze, .ai-rerun {
    border: none; border-radius: 6px; cursor: pointer;
    font-weight: 600; transition: opacity 0.15s, background 0.15s;
  }
  .ai-analyze {
    padding: 0.4rem 0.8rem; font-size: 0.76rem;
    background: var(--link); color: #fff;
  }
  .ai-analyze:hover:not(:disabled) { background: color-mix(in srgb, var(--link) 88%, #000); }
  .ai-rerun {
    padding: 0.28rem 0.6rem; font-size: 0.72rem;
    background: transparent; color: var(--text-muted); border: 1px solid var(--border);
  }
  .ai-rerun:hover:not(:disabled) { color: var(--text-secondary); border-color: var(--text-muted); }
  .ai-analyze:disabled, .ai-rerun:disabled { opacity: 0.55; cursor: wait; }
  .ai-analyze:focus-visible, .ai-rerun:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
</style>
