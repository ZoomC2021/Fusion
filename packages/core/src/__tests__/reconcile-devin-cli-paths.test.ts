import { expect, it } from "vitest";
import { reconcileDevinCliPaths } from "../plugins/pi-extensions.js";
it.each(["/opt/node_modules/devin-cli/index.ts", "C:\\tools\\devin-cli\\index.ts"])("prefers one vendored registration over %s", external => {
  const vendored = "/repo/packages/devin-cli/index.ts";
  expect(reconcileDevinCliPaths([external, vendored, vendored, "/other/index.ts"], vendored)).toEqual([vendored, "/other/index.ts"]);
  expect(reconcileDevinCliPaths([external, vendored, "/other/index.ts"], vendored, false)).toEqual(["/other/index.ts"]);
});
it("retains unrelated paths with no vendored install", () => { expect(reconcileDevinCliPaths(["/other"], null)).toEqual(["/other"]); });
