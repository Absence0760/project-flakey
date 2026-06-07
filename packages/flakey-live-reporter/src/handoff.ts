/**
 * Cross-process run-id handoff files (written by the Mocha/Cypress live
 * reporter in setupNodeEvents, read by the Mocha reporter in a different
 * process-tree branch). The path is predictable by design — both sides must
 * independently derive it — so these helpers defend the write against a
 * symlink an attacker may have planted, and pick a collision policy for the
 * concurrent-`cypress run` case.
 */

import { writeFileSync, unlinkSync, lstatSync, readFileSync } from "fs";

/**
 * Exclusive-create a handoff file.
 *
 * Symlink defence (both modes): the `wx` flag refuses any pre-existing entry.
 * If that entry is a symlink (a planted-symlink attack on the predictable
 * path), we `unlinkSync` it — which removes the link, not its target — and
 * recreate a fresh regular file. We never write *through* the symlink.
 *
 * Collision policy when a REGULAR file already exists at `path`:
 *  - `claim = true` (per-ancestor `live-run-id-<pid>` files): FIRST-writer-wins.
 *    Two simultaneous `cypress run` invocations launched from a shared parent
 *    share higher ancestor pids; a sibling must NOT overwrite the mapping the
 *    first run established there, or a reporter resolving via that shared pid
 *    would read the sibling's run id. Leave the existing file untouched. Each
 *    run still owns its own distinct cypress-CLI pid file, which is the
 *    authoritative resolution path.
 *  - `claim = false` (the singleton `latest-run-id` fallback): last-writer-wins,
 *    the historical behaviour for the single global pointer.
 */
export function writeHandoff(path: string, data: string, claim: boolean): void {
  try {
    writeFileSync(path, data, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if (!(err && (err as NodeJS.ErrnoException).code === "EEXIST")) throw err;
    let symlink = false;
    try { symlink = lstatSync(path).isSymbolicLink(); } catch { /* vanished between calls */ }
    if (symlink) {
      unlinkSync(path);
      writeFileSync(path, data, { flag: "wx", mode: 0o600 });
      return;
    }
    // A regular file is already here.
    if (claim) return;            // first-writer-wins: don't clobber a sibling
    unlinkSync(path);             // singleton: last-writer-wins
    writeFileSync(path, data, { flag: "wx", mode: 0o600 });
  }
}

/**
 * Remove a handoff file ONLY if it still holds our run id. A shared-ancestor
 * pid's file may belong to a still-running sibling — an unconditional unlink
 * in our after:run would strip that sibling's mapping mid-run. Reading + matching
 * before unlink keeps cleanup scoped to files this run actually owns.
 */
export function releaseHandoff(path: string, runId: number | string): void {
  try {
    if (readFileSync(path, "utf8").trim() === String(runId)) unlinkSync(path);
  } catch { /* gone, unreadable, or not ours — nothing to do */ }
}
