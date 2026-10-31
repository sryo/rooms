// A room's event log: append-only JSON lines {at, event, ...}. Past maxBytes the file moves to
// <file>.1 (replacing the one before), so the log keeps between one and two caps of history.
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";

export function appendEvent(file, event, fields = {}, { maxBytes = 1048576, now = () => new Date() } = {}) {
  try { if (statSync(file).size >= maxBytes) renameSync(file, `${file}.1`); } catch {}
  appendFileSync(file, JSON.stringify({ at: now().toISOString(), event, ...fields }) + "\n", { mode: 0o600 });
}

const parse = (path) => {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
};
export const readEvents = (file) => [...parse(`${file}.1`), ...parse(file)];
