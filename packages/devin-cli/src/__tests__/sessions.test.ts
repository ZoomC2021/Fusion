import { mkdtemp, rm, writeFile, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { acquireSession, pruneSessions, SESSION_TTL_MS } from "../sessions.js";
let root: string;
const entry = { acpSessionId: "saved", cwd: "/workspace", model: "glm-5-2" };
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "fusion-devin-sessions-test-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); await rm(root + ".json", { force: true }); });
it("preserves independent concurrent lane writes and refuses duplicate owners", async () => {
  const [one, two] = await Promise.all([acquireSession("one", root), acquireSession("two", root)]);
  try {
    await Promise.all([one.save(entry), two.save({ ...entry, acpSessionId: "other" })]);
    expect((await one.read())?.acpSessionId).toBe("saved"); expect((await two.read())?.acpSessionId).toBe("other");
    await expect(acquireSession("one", root)).rejects.toMatchObject({ code: "ELOCKED" });
  } finally { await one.release(); await two.release(); }
  const again = await acquireSession("one", root); expect((await again.read())?.acpSessionId).toBe("saved"); await again.release();
});
it("migrates compatible legacy data and tombstones rejected resumes", async () => {
  await writeFile(root + ".json", JSON.stringify({ old: entry }));
  const lease = await acquireSession("old", root);
  try { expect(await lease.read()).toMatchObject(entry); await lease.save(undefined); expect(await lease.read()).toBeUndefined(); } finally { await lease.release(); }
});
it("bounds retention by age and count while retaining active sessions", async () => {
  for (const id of ["old", "recent", "active"]) { const lease = await acquireSession(id, root); await lease.save(entry); await lease.release(); }
  const paths = (await readdir(root)).filter(name => name.endsWith(".json"));
  for (const path of paths) await utimes(join(root, path), new Date(0), new Date(0));
  const active = await acquireSession("active", root);
  try { await pruneSessions(root); expect((await readdir(root)).filter(name => name.endsWith(".json"))).toHaveLength(1); }
  finally { await active.release(); }
  await pruneSessions(root, Date.now() + SESSION_TTL_MS); expect((await readdir(root)).filter(name => name.endsWith(".json"))).toHaveLength(0);
  for (const id of ["one", "two", "three"]) { const lease = await acquireSession(id, root); await lease.save(entry); await lease.release(); }
  await pruneSessions(root, Date.now(), 2); expect((await readdir(root)).filter(name => name.endsWith(".json"))).toHaveLength(2);
});
it("ignores malformed and expired legacy data", async () => {
  await writeFile(root + ".json", JSON.stringify({ old: { acpSessionId: "missing-fields" } }));
  const lease = await acquireSession("old", root);
  try { expect(await lease.read()).toBeUndefined(); } finally { await lease.release(); }
  await writeFile(root + ".json", JSON.stringify({ old: entry })); await utimes(root + ".json", new Date(0), new Date(0));
  const expired = await acquireSession("old", root); try { expect(await expired.read()).toBeUndefined(); } finally { await expired.release(); }
});
