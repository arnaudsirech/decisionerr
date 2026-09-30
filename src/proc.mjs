import { spawn } from "node:child_process";

/** Resolves `{ code, stdout, stderr, timedOut, spawnError }`; never rejects. */
export function runProcess(bin, args, { cwd, stdin = "", timeoutMs, env }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.on("error", () => {});
    child.on("error", (error) => (spawnError = error.message));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, spawnError });
    });
    child.stdin.end(stdin);
  });
}

/** Last NDJSON line matching `predicate`, or null. */
export function findEvent(stdout, predicate) {
  let found = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (predicate(event)) found = event;
    } catch {
      // CLIs print warnings between events
    }
  }
  return found;
}
