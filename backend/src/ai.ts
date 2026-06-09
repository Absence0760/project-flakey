import Anthropic from "@anthropic-ai/sdk";
import { safeLog } from "./log.js";

/**
 * AI provider configuration.
 *
 * Option 1 — Anthropic (Claude):
 *   AI_PROVIDER=anthropic
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   AI_MODEL=claude-haiku-4-5-20251001  (optional, defaults to haiku)
 *
 * Option 2 — OpenAI-compatible (Ollama, llama.cpp, vLLM, LM Studio, etc.):
 *   AI_PROVIDER=openai
 *   AI_BASE_URL=http://localhost:11434/v1   (Ollama default)
 *   AI_API_KEY=ollama                       (some servers require any non-empty value)
 *   AI_MODEL=llama3.2                       (model name as configured in your server)
 */

const AI_PROVIDER = process.env.AI_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "");
const AI_BASE_URL = process.env.AI_BASE_URL ?? "";
const AI_API_KEY = process.env.AI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "";
const AI_MODEL = process.env.AI_MODEL ?? (AI_PROVIDER === "anthropic" ? "claude-haiku-4-5-20251001" : "llama3.2");

export function isAIEnabled(): boolean {
  if (AI_PROVIDER === "anthropic") return !!AI_API_KEY;
  if (AI_PROVIDER === "openai") return !!AI_BASE_URL;
  return false;
}

/**
 * Test connectivity to the configured AI provider.
 */
export async function testConnection(): Promise<{ ok: boolean; provider: string; model: string; error?: string }> {
  try {
    const response = await chat("Reply with exactly: ok");
    return {
      ok: response.toLowerCase().includes("ok"),
      provider: AI_PROVIDER,
      model: AI_MODEL,
    };
  } catch (err) {
    // chat() already logs the upstream detail server-side and throws a generic
    // message, so this `error` field is safe to surface — but keep it fixed
    // rather than echoing err.message, which could still carry provider-
    // specific text from an unexpected throw path.
    console.error("AI test-connection failed:", safeLog(err));
    return {
      ok: false,
      provider: AI_PROVIDER,
      model: AI_MODEL,
      error: "AI provider connection failed",
    };
  }
}

/**
 * Send a prompt and get a text response from whichever AI provider is configured.
 *
 * Pass `{ json: true }` for the OpenAI-compatible path to set
 * `response_format: { type: "json_object" }`, which constrains the server to
 * emit a complete, valid JSON object. This matters for small local models
 * (llama3.2 et al), which otherwise stop early and drop the closing brace —
 * producing unparseable output that falls back to a useless placeholder. The
 * Anthropic path ignores it (structured output there goes via `chatJSON`'s
 * forced tool-use).
 */
async function chat(prompt: string, opts: { json?: boolean } = {}): Promise<string> {
  if (AI_PROVIDER === "anthropic") {
    const client = new Anthropic({ apiKey: AI_API_KEY });
    try {
      const response = await client.messages.create({
        model: AI_MODEL,
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      });
      return response.content[0].type === "text" ? response.content[0].text : "";
    } catch (err) {
      // The SDK throws an APIError whose message can carry provider account/
      // tier identifiers; log it server-side but throw a generic message so it
      // never reaches the client (mirrors the OpenAI path below).
      console.error("AI request failed (anthropic):", safeLog(err));
      throw new Error("AI request failed");
    }
  }

  if (AI_PROVIDER === "openai") {
    const url = `${AI_BASE_URL.replace(/\/+$/, "")}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(AI_API_KEY ? { Authorization: `Bearer ${AI_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 500,
        temperature: 0.3,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Log the upstream body server-side for diagnostics, but keep it out of
      // the thrown message — it can carry provider account/tier identifiers and
      // is surfaced to the client via testConnection()'s `error` field. The
      // status code is enough signal for an admin debugging connectivity.
      console.error(`AI request failed (${res.status}):`, body.slice(0, 500));
      throw new Error(`AI request failed (${res.status})`);
    }

    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? "";
  }

  throw new Error("No AI provider configured. Set AI_PROVIDER to 'anthropic' or 'openai'.");
}

/**
 * Get a structured JSON object from the configured AI provider.
 *
 * Anthropic path: forced tool-use. The desired shape is handed to the model
 * as a single tool's `input_schema` and `tool_choice` forces the model to
 * call it, so the API returns a schema-shaped object directly — no string
 * parsing and none of the prose-wrapping failure mode that bites small local
 * models (see `parseJSON` for that path).
 *
 * OpenAI-compatible path (Ollama, llama.cpp, vLLM, LM Studio): tool-use
 * support is inconsistent across servers, so we keep the lenient
 * text + `parseJSON` path there.
 */
async function chatJSON<T>(prompt: string, tool: Anthropic.Tool, fallback: T): Promise<T> {
  if (AI_PROVIDER === "anthropic") {
    const client = new Anthropic({ apiKey: AI_API_KEY });
    try {
      const response = await client.messages.create({
        model: AI_MODEL,
        max_tokens: 500,
        tools: [tool],
        tool_choice: { type: "tool", name: tool.name },
        messages: [{ role: "user", content: prompt }],
      });
      const block = response.content.find((b) => b.type === "tool_use");
      return block && block.type === "tool_use" ? (block.input as T) : fallback;
    } catch (err) {
      // Same leak path as chat(): an SDK APIError message can carry account/
      // tier identifiers. Log server-side and throw a generic message — the
      // route catch turns it into a fixed "Analysis failed" response.
      console.error("AI request failed (anthropic):", safeLog(err));
      throw new Error("AI request failed");
    }
  }

  // OpenAI-compatible: ask the server to constrain output to a JSON object,
  // then keep parseJSON as the safety net for servers that ignore the hint.
  const text = await chat(prompt, { json: true });
  return parseJSON(text, fallback);
}

/**
 * Parse a JSON response from the AI, stripping any markdown fences.
 */
export function parseJSON<T>(text: string, fallback: T): T {
  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Local models routinely ignore the "JSON only" instruction and wrap the
    // object in prose ("Here's the analysis: {…}. Hope this helps!") or trail
    // commentary after the closing brace, which makes JSON.parse choke on the
    // whole string even though a valid object is sitting right there. Recover
    // it by parsing the span from the first '{' to the last '}'.
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fall through to the fallback below */
      }
    }
    return fallback;
  }
}

/**
 * Classify a test failure into a category and generate a summary.
 */
export async function analyzeFailure(params: {
  errorMessage: string;
  errorStack?: string;
  testTitle: string;
  filePath: string;
  testCode?: string;
  suiteName: string;
}): Promise<{
  classification: string;
  summary: string;
  suggestedFix: string;
  confidence: number;
}> {
  const prompt = `You are analyzing a test failure from an automated test suite.

**Test:** ${params.testTitle}
**File:** ${params.filePath}
**Suite:** ${params.suiteName}

**Error message:**
${params.errorMessage}

${params.errorStack ? `**Stack trace:**\n${params.errorStack.slice(0, 2000)}` : ""}

${params.testCode ? `**Test code:**\n\`\`\`\n${params.testCode.slice(0, 1500)}\n\`\`\`` : ""}

Respond with ONLY a JSON object (no markdown fences):
{
  "classification": "<one of: product_bug, automation_bug, environment_issue, flaky_test, data_issue, timeout>",
  "summary": "<1-2 sentence plain-English summary of what went wrong and why>",
  "suggestedFix": "<1-2 sentence actionable suggestion to fix or investigate>",
  "confidence": <0.0-1.0 how confident you are in the classification>
}`;

  return chatJSON(prompt, {
    name: "report_failure_analysis",
    description: "Report the classification and analysis of a single test failure.",
    input_schema: {
      type: "object",
      properties: {
        classification: {
          type: "string",
          enum: ["product_bug", "automation_bug", "environment_issue", "flaky_test", "data_issue", "timeout"],
          description: "The single best-fitting failure category.",
        },
        summary: { type: "string", description: "1-2 sentence plain-English summary of what went wrong and why." },
        suggestedFix: { type: "string", description: "1-2 sentence actionable suggestion to fix or investigate." },
        confidence: { type: "number", description: "Confidence in the classification, 0.0-1.0." },
      },
      required: ["classification", "summary", "suggestedFix", "confidence"],
    },
  }, {
    classification: "unknown",
    // When even the fallback fires (no usable response from the model), don't
    // surface raw model output — say plainly that analysis didn't come back.
    summary: "The AI model did not return a usable analysis for this failure. Try analyzing again, or review the error manually.",
    suggestedFix: "Review the error manually.",
    confidence: 0,
  });
}

/**
 * Find similar historical failures by comparing error messages.
 * Uses text similarity rather than AI to keep it fast and cheap.
 */
export function computeSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean));
  const tokensB = new Set(b.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  return intersection / Math.max(tokensA.size, tokensB.size);
}

/**
 * Group items into root-cause clusters by deterministic text similarity.
 *
 * Pure, single-pass greedy clustering — NO model calls, so it works cost-free
 * and air-gapped (AI off). For each item, join it to the FIRST existing cluster
 * whose representative (the cluster's seed / first member) scores
 * `computeSimilarity(text, repText) >= threshold`; otherwise start a new
 * cluster with this item as its representative. The result is deterministic for
 * a given input order — callers that need stable output across calls must feed
 * a deterministically-ordered `items`.
 */
export function clusterBySimilarity<T>(items: T[], getText: (t: T) => string, threshold: number): T[][] {
  const clusters: T[][] = [];
  for (const item of items) {
    const text = getText(item);
    let placed = false;
    for (const cluster of clusters) {
      // The representative is the cluster's seed (first) member — comparing
      // against it (not every member) keeps this O(n·clusters) and makes the
      // grouping deterministic and independent of cluster growth order.
      const repText = getText(cluster[0]);
      if (computeSimilarity(text, repText) >= threshold) {
        cluster.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([item]);
  }
  return clusters;
}

/**
 * Generate a short human "theme" label + one-sentence summary for a cluster of
 * related failures. Mirrors analyzeFlakyTest's provider handling exactly via
 * chatJSON (Anthropic forced tool-use; OpenAI-compatible JSON mode + parseJSON
 * fallback) so it works air-gapped against a local Ollama. Prompt is kept small
 * and bounded — at most 5 sample messages, each sliced to ~300 chars.
 */
export async function analyzeCluster(params: {
  representativeMessage: string;
  sampleMessages: string[];
}): Promise<{ theme: string; summary: string }> {
  const samples = params.sampleMessages.slice(0, 5).map((m) => `- ${m.slice(0, 300)}`).join("\n");

  const prompt = `You are grouping automated-test failures by root cause. Below is one cluster of error messages that a similarity pass judged to share a cause.

**Representative error message:**
${params.representativeMessage.slice(0, 300)}

${samples ? `**Sample error messages in this cluster:**\n${samples}` : ""}

Respond with ONLY a JSON object (no markdown fences):
{
  "theme": "<a SHORT label of a few words naming the shared root cause, e.g. 'Timeout waiting for network idle'>",
  "summary": "<one sentence describing what these failures have in common>"
}`;

  return chatJSON(prompt, {
    name: "report_cluster_theme",
    description: "Report a short theme label and one-sentence summary for a cluster of related test failures.",
    input_schema: {
      type: "object",
      properties: {
        theme: { type: "string", description: "A short label of a few words naming the shared root cause." },
        summary: { type: "string", description: "One sentence describing what the failures have in common." },
      },
      required: ["theme", "summary"],
    },
  }, {
    theme: "Unlabeled cluster",
    summary: "The AI model did not return a usable theme for this cluster.",
  });
}

/**
 * Analyze a flaky test and suggest stabilization strategies.
 */
export async function analyzeFlakyTest(params: {
  testTitle: string;
  filePath: string;
  flakyRate: number;
  flipCount: number;
  totalRuns: number;
  timeline: string[];
  testCode?: string;
  recentErrors: string[];
}): Promise<{
  rootCause: string;
  stabilizationSuggestion: string;
  shouldQuarantine: boolean;
  severity: "low" | "medium" | "high";
}> {
  const timelineStr = params.timeline.slice(-20).map(s => s === "passed" ? "P" : "F").join("");

  const prompt = `You are analyzing a flaky test (one that intermittently passes and fails).

**Test:** ${params.testTitle}
**File:** ${params.filePath}
**Flaky rate:** ${params.flakyRate}% (${params.flipCount} flips across ${params.totalRuns} runs)
**Recent timeline:** ${timelineStr} (P=pass, F=fail, left=oldest)

${params.testCode ? `**Test code:**\n\`\`\`\n${params.testCode.slice(0, 1500)}\n\`\`\`` : ""}

${params.recentErrors.length > 0 ? `**Recent error messages:**\n${params.recentErrors.slice(0, 5).map(e => `- ${e.slice(0, 200)}`).join("\n")}` : ""}

Respond with ONLY a JSON object (no markdown fences):
{
  "rootCause": "<1-2 sentence analysis of likely root cause: timing issue, race condition, test isolation, external dependency, etc.>",
  "stabilizationSuggestion": "<1-2 sentence actionable suggestion to stabilize this test>",
  "shouldQuarantine": <true if flaky rate is high enough to warrant quarantine (>30% or >5 flips)>,
  "severity": "<low, medium, or high based on impact>"
}`;

  return chatJSON(prompt, {
    name: "report_flaky_analysis",
    description: "Report the root-cause analysis and stabilization plan for a flaky test.",
    input_schema: {
      type: "object",
      properties: {
        rootCause: { type: "string", description: "1-2 sentence analysis of the likely root cause (timing, race, isolation, external dependency, etc.)." },
        stabilizationSuggestion: { type: "string", description: "1-2 sentence actionable suggestion to stabilize the test." },
        shouldQuarantine: { type: "boolean", description: "True if the flaky rate warrants quarantine (>30% or >5 flips)." },
        severity: { type: "string", enum: ["low", "medium", "high"], description: "Severity based on impact." },
      },
      required: ["rootCause", "stabilizationSuggestion", "shouldQuarantine", "severity"],
    },
  }, {
    rootCause: "Unable to determine root cause automatically.",
    stabilizationSuggestion: "Review the test manually for timing or isolation issues.",
    shouldQuarantine: params.flakyRate > 30,
    severity: params.flakyRate > 50 ? "high" : params.flakyRate > 20 ? "medium" : "low",
  });
}
