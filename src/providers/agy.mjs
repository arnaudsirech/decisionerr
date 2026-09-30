import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findEvent, runProcess } from "../proc.mjs";

/**
 * Antigravity headless (`agy`). Headless mode auto-denies every tool that
 * needs a permission (commands, reads and writes outside the workspace), but
 * it may still write inside its workspace, so each call gets a fresh empty
 * directory that is deleted afterwards. The prompt goes over stdin because a
 * single argument is capped at 128 KiB.
 */
export function agyProvider({ bin = "agy", timeoutMs = 120_000, model = null } = {}) {
  return {
    name: "agy",
    supportsImages: false,
    modelFor: () => model ?? "agy-default",

    async run({ system, prompt, schema }) {
      const dir = mkdtempSync(join(tmpdir(), "decisionerr-agy-"));
      try {
        const schemaFile = join(dir, "schema.json");
        writeFileSync(schemaFile, JSON.stringify(schema));
        const args = [
          "-p=",
          "--input-format", "stream-json",
          "--output-format", "stream-json",
          "--json-schema", schemaFile,
          "--sandbox",
          "--print-timeout", `${Math.floor(timeoutMs / 1000) - 5}s`,
        ];
        if (model) args.push("--model", model);
        const message = { event: "user", message: { content: `${system}\n\n${prompt}` } };
        const proc = await runProcess(bin, args, {
          cwd: dir,
          timeoutMs,
          stdin: `${JSON.stringify(message)}\n`,
        });
        return parseAgy(proc, model ?? "agy-default");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

export function parseAgy({ stdout, stderr, timedOut, spawnError }, model) {
  if (spawnError) return { ok: false, kind: "transient", error: `spawn: ${spawnError}`, model };
  if (timedOut) return { ok: false, kind: "transient", error: "timeout", model };

  const event = findEvent(stdout, (e) => e?.event === "result");
  const result = event?.result;
  if (!result) {
    return { ok: false, kind: "transient", error: `no result: ${stderr.slice(0, 300)}`, model };
  }
  const usage = {
    tokensIn: result.usage?.input_tokens ?? null,
    tokensOut: result.usage?.output_tokens ?? null,
  };
  if (result.denied_actions?.length) {
    const actions = result.denied_actions.map((a) => a.action).join(",");
    return { ok: false, kind: "bad_output", error: `tried tools: ${actions}`, model, ...usage };
  }
  if (result.status !== "SUCCESS" || !result.structured_output) {
    const text = String(result.error ?? result.status ?? "");
    let kind = "transient";
    if (/auth|sign ?in|login/i.test(text)) kind = "auth";
    else if (/quota|rate|limit|credit|429/i.test(text)) kind = "limit";
    else if (result.status === "SUCCESS") kind = "bad_output";
    return { ok: false, kind, error: text.slice(0, 300) || "no structured_output", model, ...usage };
  }
  return { ok: true, output: result.structured_output, model, ...usage };
}
