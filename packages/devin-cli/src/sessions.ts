import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { lock } from "proper-lockfile";

export interface SavedSession { acpSessionId: string; cwd: string; model: string; updatedAt: number }
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const SESSION_LIMIT = 1000;
const defaultRoot = () => join(homedir(), ".fusion", "agent", "devin-cli-sessions");

/* FNXC:DevinCli 2026-09-06-04:47:
 * Independent lanes must never rewrite a shared session map. Atomic per-session
 * files and heartbeat locks protect writers and refuse overlapping turns for
 * the same pi session. Old JSON-map data is read-only migration input.
 */
export async function acquireSession(id: string, root = defaultRoot(), onCompromised?: () => void) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, createHash("sha256").update(id).digest("hex") + ".json");
  let compromised = false;
  const release = await lock(path, { realpath: false, retries: 0, onCompromised: () => { compromised = true; onCompromised?.(); } });
  // proper-lockfile maintains the lease while the owning ACP turn runs.
  const read = async (): Promise<SavedSession | undefined> => {
    if (compromised) throw new Error("Devin session lease lost");
    let entry: Partial<SavedSession> | undefined;
    try { entry = JSON.parse(await readFile(path, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      try { if (Date.now() - (await stat(root + ".json")).mtimeMs <= SESSION_TTL_MS) entry = JSON.parse(await readFile(root + ".json", "utf8"))[id]; } catch { /* no legacy entry */ }
    }
    if (!entry || typeof entry.acpSessionId !== "string" || !entry.acpSessionId || typeof entry.cwd !== "string" || typeof entry.model !== "string") return;
    if (typeof entry.updatedAt === "number" && Date.now() - entry.updatedAt > SESSION_TTL_MS) return;
    return { ...entry, updatedAt: entry.updatedAt ?? Date.now() } as SavedSession;
  };
  return {
    read,
    async save(entry: Omit<SavedSession, "updatedAt"> | undefined) {
      if (compromised) throw new Error("Devin session lease released");
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        // A tombstone suppresses legacy-map resurrection after a failed resume.
        await writeFile(temp, JSON.stringify(entry ? { ...entry, updatedAt: Date.now() } : null), { mode: 0o600 });
        await rename(temp, path);
      } finally { await unlink(temp).catch(() => undefined); }
    },
    async release() { if (!compromised) { compromised = true; await release(); } },
  };
}

export async function pruneSessions(root = defaultRoot(), now = Date.now(), limit = SESSION_LIMIT): Promise<void> {
  const names = await readdir(root).catch(() => []);
  const entries = await Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async name => {
    const path = join(root, name);
    return { path, modified: (await stat(path).catch(() => undefined))?.mtimeMs ?? now };
  }));
  entries.sort((a, b) => b.modified - a.modified);
  for (const [index, entry] of entries.entries()) {
    if (index < limit && now - entry.modified <= SESSION_TTL_MS) continue;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lock(entry.path, { realpath: false, retries: 0 });
      // Never remove a record refreshed between enumeration and lock acquisition.
      if ((await stat(entry.path)).mtimeMs === entry.modified) await unlink(entry.path);
    } catch { /* active turns and concurrent pruning retain their records */ }
    finally { await release?.().catch(() => undefined); }
  }
}
