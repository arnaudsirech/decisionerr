import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { findEvent, runProcess } from "../proc.mjs";

const MODELS = {
  fast: "claude-haiku-4-5-20251001",
  thorough: "claude-sonnet-5-5",
  best: "claude-opus-5-5",
};

const TIMEOUT_MS = { fast: 90_000, thorough: 300_000, best: 600_000 };

/**
 * Claude through the subscription (`claude -p`), never the metered API.
 * Locked down: no tools, no MCP, no settings, no session,
 * so text inside an input can only shape the JSON that comes back.
 */
export function claudeProvider({ bin = "claude", workdir } = {}) {
  const cwd = workdir ?? join(process.env.HOME ?? "/tmp", ".cache", "decisionerr", "claude");
  mkdirSync(cwd, { recursive: true });

  return {
    name: "claude",
    supportsImages: true,
    modelFor: (tier) => MODELS[tier] ?? MODELS.fast,

    async run({ system, prompt, images, schema, tier }) {
      const model = MODELS[tier] ?? MODELS.fast;
      const content = [
        ...images.map((image) => ({
          type: "image",
          source: { type: "base64", media_type: image.media_type, data: image.data },
        })),
        { type: "text", text: prompt },
      ];
      const proc = await runProcess(
        bin,
        [
          "-p",
          "--verbose",
          "--input-format", "stream-json",
          "--output-format", "stream-json",
          "--model", model,
          "--tools", "",
          "--strict-mcp-config",
          "--setting-sources", "",
          "--no-session-persistence",
          "--system-prompt", system,
          "--json-schema", JSON.stringify(schema),
        ],
        {
          cwd,
          timeoutMs: TIMEOUT_MS[tier] ?? TIMEOUT_MS.fast,
          stdin: `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`,
        },
      );
      return parseClaude(proc, model);
    },
  };
}

export function parseClaude({ stdout, stderr, timedOut, spawnError }, model) {
  if (spawnError) return { ok: false, kind: "transient", error: `spawn: ${spawnError}`, model };
  if (timedOut) return { ok: false, kind: "transient", error: "timeout", model };

  const result = findEvent(stdout, (event) => event?.type === "result");
  if (!result) {
    return { ok: false, kind: "transient", error: `no result: ${stderr.slice(0, 300)}`, model };
  }
  const usage = {
    tokensIn: result.usage?.input_tokens ?? null,
    tokensOut: result.usage?.output_tokens ?? null,
  };
  if (result.is_error || !result.structured_output) {
    const status = result.api_error_status == null ? null : Number(result.api_error_status);
    const text = String(result.result ?? result.subtype ?? "");
    const reset = /\|(\d{10})\b/.exec(text);
    let kind = "transient";
    if (status === 401 || /login|oauth|authenticat/i.test(text)) kind = "auth";
    else if (status === 429 || /usage limit|rate limit/i.test(text)) kind = "limit";
    else if (!result.is_error) kind = "bad_output";
    return {
      ok: false,
      kind,
      error: text.slice(0, 300) || "no structured_output",
      retryAt: reset ? Number(reset[1]) * 1000 : null,
      model,
      ...usage,
    };
  }
  return { ok: true, output: result.structured_output, model, ...usage };
}
