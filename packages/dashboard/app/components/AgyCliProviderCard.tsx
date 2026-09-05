import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { fetchAgyCliStatus, setAgyCliBinaryPath, setAgyCliEnabled, type AgyCliStatus } from "../api";
import { ProviderIcon } from "./ProviderIcon";
import "./AgyCliProviderCard.css";

interface AgyCliProviderCardProps {
  authenticated: boolean;
  compact?: boolean;
  onToggled?: (nextEnabled: boolean) => void;
}

export function AgyCliProviderCard({ authenticated, compact = false, onToggled }: AgyCliProviderCardProps) {
  const { t } = useTranslation("app");
  const [status, setStatus] = useState<AgyCliStatus | null>(null);
  const [busy, setBusy] = useState<"enabling" | "disabling" | "testing" | "saving-path" | null>(null);
  const [binaryPathInput, setBinaryPathInput] = useState("");
  const [pathMessage, setPathMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const pathDirtyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchAgyCliStatus();
      if (mountedRef.current) {
        setStatus(next);
        setBinaryPathInput((current) => (pathDirtyRef.current ? current : (next.binaryPath ?? "")));
      }
      return next;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      setBusy(next ? "enabling" : "disabling");
      try {
        const result = await setAgyCliEnabled(next);
        onToggled?.(result.enabled);
        await refresh();
      } finally {
        if (mountedRef.current) setBusy(null);
      }
    },
    [onToggled, refresh],
  );

  const currentlyEnabled = status?.enabled ?? authenticated;
  const binaryAvailable = status?.binary.available ?? false;
  const trimmedBinaryPath = binaryPathInput.trim();
  const savedBinaryPath = status?.binaryPath ?? "";
  const binaryPathChanged = trimmedBinaryPath !== savedBinaryPath;

  const handleBinaryPathChange = useCallback((value: string) => {
    setBinaryPathInput(value);
    pathDirtyRef.current = true;
    setPathMessage(null);
  }, []);

  const handleSaveBinaryPath = useCallback(async () => {
    setBusy("saving-path");
    setPathMessage(null);
    try {
      await setAgyCliBinaryPath(trimmedBinaryPath || null);
      if (!mountedRef.current) return;
      pathDirtyRef.current = false;
      const refreshed = await fetchAgyCliStatus();
      if (mountedRef.current) {
        setStatus(refreshed);
        setBinaryPathInput(refreshed.binaryPath ?? "");
        setPathMessage({
          tone: "success",
          text: trimmedBinaryPath
            ? t("setup.agyCli.pathSaved", "Binary path saved and tested.")
            : t("setup.agyCli.pathCleared", "Binary path cleared; PATH auto-detection is active."),
        });
      }
    } catch (error) {
      if (mountedRef.current) {
        const message = error instanceof Error ? error.message : String(error);
        setPathMessage({ tone: "error", text: message });
      }
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [t, trimmedBinaryPath]);

  /*
  FNXC:AgyCli 2026-09-06-00:00:
  Settings Authentication owns the manual binary override because onboarding should stay a compact enable/test surface. Send the trimmed value as one string so Windows paths with spaces and .cmd/.bat shims are not quoted or split in the browser. Mirrors CursorCliProviderCard (FN-7695).
  */
  const binaryPathControl = compact ? (
    <div className="agy-cli-binary-path-control">
      <label className="agy-cli-binary-path-label" htmlFor="agy-cli-binary-path">
        {t("setup.agyCli.binaryPathLabel", "Antigravity CLI binary path")}
      </label>
      <div className="agy-cli-binary-path-row">
        <input
          id="agy-cli-binary-path"
          className="agy-cli-binary-path-input"
          type="text"
          value={binaryPathInput}
          onChange={(event) => handleBinaryPathChange(event.target.value)}
          placeholder={t("setup.agyCli.binaryPathPlaceholder", "/usr/local/bin/agy")}
          disabled={busy !== null}
        />
        <button type="button" className="btn btn-sm" onClick={() => void handleSaveBinaryPath()} disabled={busy !== null || !binaryPathChanged}>
          {busy === "saving-path" ? t("setup.agyCli.savingPath", "Saving…") : t("setup.agyCli.saveAndTestPath", "Save & Test")}
        </button>
      </div>
      <small className="settings-muted">{t("setup.agyCli.binaryPathHelp", "Leave blank to use PATH auto-detection (`agy`).")}</small>
      {pathMessage ? <small className={pathMessage.tone === "error" ? "form-error" : "text-muted"}>{pathMessage.text}</small> : null}
    </div>
  ) : null;

  const actions = (
    <>
      <button type="button" className="btn btn-sm" onClick={() => {
        setBusy("testing");
        void refresh().finally(() => {
          if (mountedRef.current) setBusy(null);
        });
      }} disabled={busy !== null}>
        {busy === "testing" ? <><Loader2 size={12} className="animate-spin" /> {t("setup.agyCli.testing", "Testing…")}</> : t("setup.agyCli.test", "Test")}
      </button>
      {currentlyEnabled ? (
        <button type="button" className="btn btn-sm" onClick={() => void handleToggle(false)} disabled={busy !== null}>
          {busy === "disabling" ? t("setup.agyCli.disabling", "Disabling…") : t("setup.agyCli.disable", "Disable")}
        </button>
      ) : (
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleToggle(true)} disabled={busy !== null || !binaryAvailable}>
          {busy === "enabling" ? t("setup.agyCli.enabling", "Enabling…") : t("setup.agyCli.enable", "Enable")}
        </button>
      )}
    </>
  );

  const statusText = !status
    ? t("setup.agyCli.probing", "Probing local CLI…")
    : !status.binary.available
      ? status.binary.reason ?? t("setup.agyCli.binaryNotFound", "`agy` not found on PATH")
      : currentlyEnabled
        ? t("setup.agyCli.connected", "Connected{{version}}", { version: status.binary.version ? ` — ${status.binary.version}` : "" })
        : t("setup.agyCli.detectedPrompt", "Detected. Click Enable to route calls through Antigravity CLI.");

  if (compact) {
    return (
      <div className={`agy-cli-provider-card auth-provider-card auth-provider-card--cli${authenticated ? " auth-provider-card--authenticated" : ""}`} data-testid="agy-cli-provider-card">
        <div className="auth-provider-header">
          <div className="auth-provider-info">
            <ProviderIcon provider="agy-cli" size="sm" />
            <strong>{t("setup.agyCli.providerName", "Antigravity CLI")}</strong>
            <span className={`auth-status-badge ${currentlyEnabled ? "authenticated" : "not-authenticated"}`}>{currentlyEnabled ? t("setup.agyCli.active", "✓ Active") : t("setup.agyCli.notConnected", "✗ Not connected")}</span>
          </div>
          <div className="auth-provider-cli-actions">{actions}</div>
        </div>
        {/*
        FNXC:AgyCli 2026-09-06-00:00:
        `.auth-provider-card` has no padding of its own (padding:0; overflow:hidden) — only
        `.auth-provider-header` supplies the horizontal inset via `padding: var(--space-sm) var(--space-md)`.
        The status line and binary-path control below the header must be wrapped in a padded body
        so they line up with the header instead of rendering flush against the card edges,
        mirroring `.auth-provider-cli-details-body` on the Claude CLI card and `.cursor-cli-provider-card__body`
        (FN-7695).
        */}
        <div className="agy-cli-provider-card__body" data-testid="agy-cli-provider-card-body">
          <small className="settings-muted">{statusText}</small>
          {binaryPathControl}
        </div>
      </div>
    );
  }

  return (
    <div className={`agy-cli-provider-card onboarding-provider-card${authenticated ? " onboarding-provider-card--connected" : ""}`} data-testid="agy-cli-provider-card">
      <div className="onboarding-provider-card__icon">
        <ProviderIcon provider="agy-cli" size="md" />
      </div>
      <div className="onboarding-provider-card__body">
        <strong className="onboarding-provider-card__name">{t("setup.agyCli.providerName", "Antigravity CLI")}</strong>
        <span className="onboarding-provider-card__description">{t("setup.agyCli.description", "Runs Gemini models through the locally installed `agy` binary")}</span>
        <small className="settings-muted">{statusText}</small>
      </div>
      <div className="onboarding-provider-card__actions">{actions}</div>
    </div>
  );
}
