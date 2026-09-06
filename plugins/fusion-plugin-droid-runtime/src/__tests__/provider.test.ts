// Legacy print-mode transport cases are replaced by sdk-provider behavioral coverage.
import { expect, it } from "vitest";
import { streamViaCli } from "../provider.js";
import { streamViaSdk } from "../sdk-provider.js";
it("routes the public provider through the official SDK", () => { expect(streamViaCli).toBe(streamViaSdk); });
