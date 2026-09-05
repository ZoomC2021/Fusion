import { describe, expect, it } from "vitest";
import plugin from "../index.js";

describe("agy plugin export", () => {
  it("declares agy-cli provider contribution", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-agy-runtime");
    expect(plugin.cliProviders?.[0]?.providerId).toBe("agy-cli");
    expect(plugin.cliProviders?.[0]?.statusRoute).toBe("/providers/agy-cli/status");
    expect(plugin.cliProviders?.[0]?.authRoute).toBe("/auth/agy-cli");
    expect(plugin.cliProviders?.[0]?.binaryName).toBe("agy");
  });
});
