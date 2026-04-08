import Anthropic from "@anthropic-ai/sdk";

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
 * Send a prompt and get a text response from whichever AI provider is configured.
 */
async function chat(prompt: string): Promise<string> {
  if (AI_PROVIDER === "anthropic") {
    const client = new Anthropic({ apiKey: AI_API_KEY });
    const response = await client.messages.create({
      model: AI_MODEL,
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });
    return response.content[0].type === "text" ? response.content[0].text : "";
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
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`AI request failed (${res.status}): ${body.slice(0, 200)}`);
    }

    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? "";
  }

  throw new Error("No AI provider configured. Set AI_PROVIDER to 'anthropic' or 'openai'.");
}

/**
 * Parse a JSON response from the AI, stripping any markdown fences.
 */
function parseJSON<T>(text: string, fallback: T): T {
  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
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

  const text = await chat(prompt);
  return parseJSON(text, {
    classification: "unknown",
    summary: text.slice(0, 300),
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

  const text = await chat(prompt);
  return parseJSON(text, {
    rootCause: "Unable to determine root cause automatically.",
    stabilizationSuggestion: "Review the test manually for timing or isolation issues.",
    shouldQuarantine: params.flakyRate > 30,
    severity: params.flakyRate > 50 ? "high" : params.flakyRate > 20 ? "medium" : "low",
  });
}
