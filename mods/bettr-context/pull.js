// Local addition: context for agents with no hooks (Pi, opencode). Nothing is installed in them;
// bettr-reporter/pull.py reads what they already wrote and prints the `bettr.context` label's JSON.
// The result is kept here, in module scope, so the main block and the Cache block share it.
import { appHome, exec } from "herdr";
import { HOOKLESS } from "./model.js";

const results = new Map(); // terminal address -> { key, cwd, text }
let running = false;

// A terminal that runs one of those agents. They write no label, and one left by an earlier
// agent in the same terminal does not matter (contextState ignores it).
export const wants = terminal => Boolean(terminal) && HOOKLESS.has(terminal.program?.key)
  && !terminal.address.includes("/"); // pull.py reads this computer's files only

export function pulledText(terminal) {
  const found = results.get(terminal?.address);
  return found && found.key === terminal.program?.key ? found.text : null;
}

// Runs pull.py once at a time. Resolves true when the text changed, so the caller redraws.
export async function pull(terminal, cwd) {
  if (running || !wants(terminal) || !cwd) return false;
  running = true;
  try {
    const key = terminal.program.key;
    const script = `${appHome()}/mods/bettr-reporter/pull.py`;
    const result = await exec("python3", ["-I", script, key, cwd], { timeout: 8000 });
    const text = result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
    const before = results.get(terminal.address);
    if (before && before.key === key && before.text === text) return false;
    results.set(terminal.address, { key, cwd, text });
    return true;
  } catch {
    return false; // python3 missing or timed out: the panel just shows nothing
  } finally {
    running = false;
  }
}
