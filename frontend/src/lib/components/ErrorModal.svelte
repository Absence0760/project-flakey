<script lang="ts">
  import { fetchTest, UPLOADS_URL, type TestDetail } from "$lib/api";
  import Lightbox from "./Lightbox.svelte";

  interface Props {
    testId: number | null;
    onclose: () => void;
  }

  let { testId, onclose }: Props = $props();

  let test = $state<TestDetail | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  // Left panel state
  let leftTab = $state<"screenshot" | "video">("screenshot");
  let currentScreenshot = $state(0);
  let lightboxOpen = $state(false);
  let lightboxIndex = $state(0);

  // Right panel state
  let rightTab = $state<"error" | "commands" | "code">("error");
  let stackExpanded = $state(false);

  $effect(() => {
    if (testId) {
      loadTest(testId);
    }
  });

  async function loadTest(id: number) {
    loading = true;
    error = null;
    leftTab = "screenshot";
    rightTab = "error";
    currentScreenshot = 0;
    stackExpanded = false;
    try {
      test = await fetchTest(id);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load test";
    } finally {
      loading = false;
    }
  }

  function navigate(id: number | null) {
    if (id) loadTest(id);
  }

  function onKeydown(e: KeyboardEvent) {
    if (lightboxOpen) return;
    if (!testId) return;
    if (e.key === "Escape") onclose();
    if (e.key === "ArrowLeft" && test?.prev_failed_id) navigate(test.prev_failed_id);
    if (e.key === "ArrowRight" && test?.next_failed_id) navigate(test.next_failed_id);
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  let screenshotUrls = $derived(
    (test?.screenshot_paths ?? []).map((p) => `${UPLOADS_URL}/${p}`)
  );

  let hasScreenshots = $derived(screenshotUrls.length > 0);
  let hasVideo = $derived(!!test?.video_path);
  let hasCode = $derived(!!test?.test_code);
  let hasCommands = $derived((test?.command_log?.length ?? 0) > 0);
</script>

<svelte:window onkeydown={onKeydown} />

{#if testId}
  <div class="backdrop" onclick={onclose} role="dialog" aria-modal="true">
    <div class="debugger" onclick={(e) => e.stopPropagation()}>
      {#if loading}
        <div class="debugger-loading">Loading...</div>
      {:else if error}
        <div class="debugger-error">{error}</div>
      {:else if test}
        <!-- Top bar -->
        <header class="topbar">
          <div class="topbar-left">
            <span class="badge failed">FAILED</span>
            <h2>{test.title}</h2>
          </div>
          <div class="topbar-right">
            <div class="nav-group">
              <button
                class="nav-arrow"
                disabled={!test.prev_failed_id}
                onclick={() => navigate(test?.prev_failed_id ?? null)}
                title="Previous failure"
              >&#8249;</button>
              <span class="nav-label">{test.failed_index}/{test.failed_total}</span>
              <button
                class="nav-arrow"
                disabled={!test.next_failed_id}
                onclick={() => navigate(test?.next_failed_id ?? null)}
                title="Next failure"
              >&#8250;</button>
            </div>
            <button class="close-btn" onclick={onclose}>&#10005;</button>
          </div>
        </header>

        <!-- Info strip -->
        <div class="info-strip">
          <span class="info-item mono">{test.file_path}</span>
          <span class="info-sep">|</span>
          <span class="info-item">{formatDuration(test.duration_ms)}</span>
          <span class="info-sep">|</span>
          <a href="/runs/{test.run_id}" class="info-link" onclick={onclose}>Run #{test.run_id}</a>
        </div>

        <!-- Split panes -->
        <div class="split">
          <!-- LEFT: Visual evidence -->
          <div class="pane pane-left">
            <div class="pane-tabs">
              {#if hasScreenshots}
                <button class="pane-tab" class:active={leftTab === "screenshot"} onclick={() => leftTab = "screenshot"}>
                  Screenshots ({screenshotUrls.length})
                </button>
              {/if}
              {#if hasVideo}
                <button class="pane-tab" class:active={leftTab === "video"} onclick={() => leftTab = "video"}>
                  Video
                </button>
              {/if}
              {#if !hasScreenshots && !hasVideo}
                <span class="pane-tab active">Visual</span>
              {/if}
            </div>

            <div class="pane-content">
              {#if leftTab === "screenshot" && hasScreenshots}
                <div class="screenshot-viewer">
                  <button class="screenshot-main" onclick={() => { lightboxIndex = currentScreenshot; lightboxOpen = true; }}>
                    <img src={screenshotUrls[currentScreenshot]} alt="Screenshot {currentScreenshot + 1}" />
                    <span class="zoom-hint">Click to zoom</span>
                  </button>
                  {#if screenshotUrls.length > 1}
                    <div class="screenshot-strip">
                      {#each screenshotUrls as url, i}
                        <button
                          class="strip-thumb"
                          class:active={currentScreenshot === i}
                          onclick={() => currentScreenshot = i}
                        >
                          <img src={url} alt="Thumb {i + 1}" />
                        </button>
                      {/each}
                    </div>
                  {/if}
                </div>

              {:else if leftTab === "video" && hasVideo}
                <div class="video-viewer">
                  <video controls src="{UPLOADS_URL}/{test.video_path}">
                    <track kind="captions" />
                  </video>
                </div>

              {:else}
                <div class="empty-visual">
                  <div class="empty-icon">&#128247;</div>
                  <p>No visual evidence captured.</p>
                  <p class="empty-hint">Screenshots are captured on failure by default.<br/>Enable video recording in cypress.config.ts.</p>
                </div>
              {/if}
            </div>
          </div>

          <!-- RIGHT: Debug tools -->
          <div class="pane pane-right">
            <div class="pane-tabs">
              <button class="pane-tab" class:active={rightTab === "error"} onclick={() => rightTab = "error"}>
                Error
              </button>
              <button class="pane-tab" class:active={rightTab === "commands"} onclick={() => rightTab = "commands"}>
                Commands {hasCommands ? `(${test.command_log?.length})` : ""}
              </button>
              {#if hasCode}
                <button class="pane-tab" class:active={rightTab === "code"} onclick={() => rightTab = "code"}>
                  Source
                </button>
              {/if}
            </div>

            <div class="pane-content">
              {#if rightTab === "error"}
                <div class="error-panel">
                  <div class="error-label">Error Message</div>
                  <pre class="error-msg">{test.error_message}</pre>

                  {#if test.error_stack}
                    <button class="stack-toggle" onclick={() => stackExpanded = !stackExpanded}>
                      <span class="toggle-icon">{stackExpanded ? "&#9660;" : "&#9654;"}</span>
                      Stack Trace
                    </button>
                    {#if stackExpanded}
                      <pre class="stack-trace">{test.error_stack}</pre>
                    {/if}
                  {/if}

                  <div class="error-details">
                    <div class="detail-row">
                      <span class="detail-key">Test</span>
                      <span class="detail-val">{test.full_title}</span>
                    </div>
                    <div class="detail-row">
                      <span class="detail-key">Spec</span>
                      <span class="detail-val mono">{test.file_path}</span>
                    </div>
                    <div class="detail-row">
                      <span class="detail-key">Duration</span>
                      <span class="detail-val mono">{formatDuration(test.duration_ms)}</span>
                    </div>
                    <div class="detail-row">
                      <span class="detail-key">Run</span>
                      <a href="/runs/{test.run_id}" class="detail-link" onclick={onclose}>#{test.run_id}</a>
                    </div>
                  </div>
                </div>

              {:else if rightTab === "commands"}
                {#if hasCommands}
                  <div class="commands-panel">
                    <div class="commands-header">
                      <span class="commands-title">Cypress Command Log</span>
                      <span class="commands-count">{test.command_log?.length} steps</span>
                    </div>
                    <ol class="command-list">
                      {#each test.command_log ?? [] as cmd, i}
                        <li class="cmd" class:cmd-failed={cmd.state === "failed"}>
                          <span class="cmd-num">{i + 1}</span>
                          <span class="cmd-icon">{cmd.state === "failed" ? "&#10007;" : "&#10003;"}</span>
                          <span class="cmd-name">cy.{cmd.name}</span>
                          {#if cmd.message}
                            <span class="cmd-arg">{cmd.message}</span>
                          {/if}
                        </li>
                      {/each}
                    </ol>
                  </div>
                {:else}
                  <div class="empty-panel">
                    <p>No command log available.</p>
                    <p class="empty-hint">Add a custom Cypress plugin to capture<br/>cy.state('commands') on failure.</p>
                  </div>
                {/if}

              {:else if rightTab === "code"}
                <div class="code-panel">
                  <div class="code-header">
                    <span class="code-title">Test Source</span>
                    <span class="code-lang">JavaScript</span>
                  </div>
                  <pre class="code-block"><code>{test.test_code}</code></pre>
                </div>
              {/if}
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>

  <Lightbox
    images={screenshotUrls}
    bind:index={lightboxIndex}
    open={lightboxOpen}
    onclose={() => lightboxOpen = false}
  />
{/if}

<style>
  /* Backdrop & container */
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
  }

  .debugger {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    width: 100%;
    max-width: 1200px;
    height: 85vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 25px 60px rgba(0, 0, 0, 0.3);
  }

  .debugger-loading, .debugger-error {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    color: var(--text-secondary);
    font-size: 0.9rem;
  }

  .debugger-error {
    color: var(--color-fail);
  }

  /* Top bar */
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1.25rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-secondary);
    flex-shrink: 0;
  }

  .topbar-left {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-width: 0;
  }

  .topbar-left h2 {
    margin: 0;
    font-size: 0.95rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .topbar-right {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-shrink: 0;
  }

  .badge.failed {
    background: var(--color-fail);
    color: white;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    flex-shrink: 0;
  }

  .nav-group {
    display: flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }

  .nav-arrow {
    background: none;
    border: none;
    padding: 0.3rem 0.6rem;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
    transition: background 0.1s;
  }

  .nav-arrow:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text);
  }

  .nav-arrow:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .nav-label {
    padding: 0 0.4rem;
    font-size: 0.75rem;
    color: var(--text-muted);
    border-left: 1px solid var(--border);
    border-right: 1px solid var(--border);
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1.2rem;
    cursor: pointer;
    padding: 0.2rem;
    line-height: 1;
    transition: color 0.1s;
  }

  .close-btn:hover {
    color: var(--text);
  }

  /* Info strip */
  .info-strip {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 1.25rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.75rem;
    color: var(--text-muted);
    background: var(--bg);
    flex-shrink: 0;
  }

  .info-item { white-space: nowrap; }
  .info-sep { opacity: 0.4; }
  .info-link {
    color: var(--link);
    text-decoration: none;
  }
  .info-link:hover { text-decoration: underline; }
  .mono { font-family: monospace; }

  /* Split layout */
  .split {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .pane-left {
    flex: 1;
    border-right: 1px solid var(--border);
  }

  .pane-right {
    flex: 1;
  }

  .pane-tabs {
    display: flex;
    padding: 0 0.75rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-secondary);
    flex-shrink: 0;
  }

  .pane-tab {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 0.5rem 0.75rem;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.8rem;
    transition: color 0.1s;
    white-space: nowrap;
  }

  .pane-tab:hover { color: var(--text); }

  .pane-tab.active {
    color: var(--text);
    border-bottom-color: var(--link);
    font-weight: 600;
  }

  .pane-content {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  /* LEFT: Screenshot viewer */
  .screenshot-viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .screenshot-main {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-secondary);
    cursor: zoom-in;
    border: none;
    padding: 1rem;
    position: relative;
    min-height: 0;
  }

  .screenshot-main img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: 4px;
    border: 1px solid var(--border);
  }

  .zoom-hint {
    position: absolute;
    bottom: 0.75rem;
    right: 0.75rem;
    background: rgba(0, 0, 0, 0.6);
    color: white;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    font-size: 0.7rem;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .screenshot-main:hover .zoom-hint {
    opacity: 1;
  }

  .screenshot-strip {
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-top: 1px solid var(--border);
    overflow-x: auto;
    flex-shrink: 0;
  }

  .strip-thumb {
    width: 60px;
    height: 40px;
    border: 2px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
    cursor: pointer;
    padding: 0;
    background: none;
    flex-shrink: 0;
    transition: border-color 0.1s;
  }

  .strip-thumb.active {
    border-color: var(--link);
  }

  .strip-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* LEFT: Video viewer */
  .video-viewer {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 1rem;
    background: var(--bg-secondary);
  }

  .video-viewer video {
    max-width: 100%;
    max-height: 100%;
    border-radius: 6px;
    border: 1px solid var(--border);
  }

  /* LEFT: Empty state */
  .empty-visual {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
    text-align: center;
    padding: 2rem;
  }

  .empty-icon {
    font-size: 2.5rem;
    opacity: 0.3;
    margin-bottom: 0.75rem;
  }

  .empty-visual p {
    margin: 0;
    font-size: 0.85rem;
  }

  .empty-hint {
    font-size: 0.75rem;
    margin-top: 0.5rem;
    opacity: 0.7;
    line-height: 1.5;
  }

  /* RIGHT: Error panel */
  .error-panel {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .error-label {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--text-muted);
    letter-spacing: 0.05em;
  }

  .error-msg {
    margin: 0;
    padding: 0.85rem;
    background: var(--error-bg);
    border: 1px solid var(--error-border);
    border-radius: 6px;
    color: var(--error-text);
    font-size: 0.82rem;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
  }

  .stack-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0.25rem 0;
    font-weight: 500;
  }

  .stack-toggle:hover { color: var(--text); }

  .toggle-icon {
    font-size: 0.6rem;
  }

  .stack-trace {
    margin: 0;
    padding: 0.75rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-secondary);
    font-size: 0.78rem;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.6;
  }

  .error-details {
    border-top: 1px solid var(--border);
    padding-top: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .detail-row {
    display: flex;
    gap: 0.75rem;
    font-size: 0.8rem;
  }

  .detail-key {
    color: var(--text-muted);
    min-width: 4.5rem;
    font-weight: 500;
  }

  .detail-val {
    color: var(--text-secondary);
    word-break: break-all;
  }

  .detail-link {
    color: var(--link);
    text-decoration: none;
  }

  .detail-link:hover { text-decoration: underline; }

  /* RIGHT: Commands panel */
  .commands-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .commands-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .commands-title {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--text-muted);
    letter-spacing: 0.05em;
  }

  .commands-count {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .command-list {
    list-style: none;
    padding: 0;
    margin: 0;
    flex: 1;
    overflow-y: auto;
  }

  .cmd {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 1rem;
    font-size: 0.82rem;
    border-bottom: 1px solid var(--border-light);
    transition: background 0.1s;
  }

  .cmd:hover {
    background: var(--bg-hover);
  }

  .cmd-failed {
    background: var(--error-bg);
  }

  .cmd-failed:hover {
    background: var(--error-bg);
  }

  .cmd-num {
    color: var(--text-muted);
    font-size: 0.7rem;
    min-width: 1.5rem;
    text-align: right;
    font-family: monospace;
  }

  .cmd-icon {
    font-size: 0.7rem;
    width: 1rem;
    text-align: center;
    color: var(--color-pass);
  }

  .cmd-failed .cmd-icon {
    color: var(--color-fail);
  }

  .cmd-name {
    font-family: monospace;
    font-weight: 600;
    font-size: 0.8rem;
    color: var(--text);
    white-space: nowrap;
  }

  .cmd-arg {
    font-family: monospace;
    font-size: 0.78rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cmd-failed .cmd-name,
  .cmd-failed .cmd-arg {
    color: var(--error-text);
  }

  /* RIGHT: Code panel */
  .code-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .code-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .code-title {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--text-muted);
    letter-spacing: 0.05em;
  }

  .code-lang {
    font-size: 0.7rem;
    color: var(--text-muted);
    padding: 0.1rem 0.4rem;
    background: var(--bg-hover);
    border-radius: 3px;
  }

  .code-block {
    margin: 0;
    padding: 1rem;
    flex: 1;
    overflow: auto;
    background: var(--bg-secondary);
    font-size: 0.82rem;
    line-height: 1.6;
  }

  .code-block code {
    color: var(--text);
  }

  /* RIGHT: Empty state */
  .empty-panel {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 2rem;
    text-align: center;
    color: var(--text-muted);
  }

  .empty-panel p {
    margin: 0;
    font-size: 0.85rem;
  }
</style>
