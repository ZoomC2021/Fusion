import { describe, expect, it } from "vitest";
import type { GlobalSettings } from "../types.js";
import {
  DEFAULT_GLOBAL_SETTINGS,
  GLOBAL_SETTINGS_KEYS,
  isGlobalSettingsKey,
} from "../config/settings-schema.js";

describe("Antigravity CLI global settings", () => {
  it("includes the enable toggle and binary path in GLOBAL_SETTINGS_KEYS", () => {
    expect(GLOBAL_SETTINGS_KEYS).toContain("agyCliEnabled");
    expect(GLOBAL_SETTINGS_KEYS).toContain("agyCliBinaryPath");
  });

  it("defaults both Antigravity CLI settings to undefined", () => {
    expect(DEFAULT_GLOBAL_SETTINGS.agyCliEnabled).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.agyCliBinaryPath).toBeUndefined();
  });

  it("recognizes agyCliBinaryPath as a global settings key", () => {
    expect(isGlobalSettingsKey("agyCliBinaryPath")).toBe(true);
    expect(isGlobalSettingsKey("agyCliEnabled")).toBe(true);
  });

  it("accepts a string binary override distinct from the enable toggle", () => {
    const configured: GlobalSettings = {
      agyCliEnabled: false,
      agyCliBinaryPath: "/usr/local/bin/agy",
    };

    expect(configured.agyCliEnabled).toBe(false);
    expect(configured.agyCliBinaryPath).toBe("/usr/local/bin/agy");
  });
});
