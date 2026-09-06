import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchDevinCliStatus, setDevinCliEnabled, type DevinCliStatus } from "../api";
import { ProviderIcon } from "./ProviderIcon";

/* FNXC:DevinCli 2026-09-06-04:47:
 * Settings and onboarding share one provider card and the existing responsive
 * auth/onboarding primitives. Enabled and authenticated are separate states.
 */
export function DevinCliProviderCard({ authenticated, compact = false, onToggled }: {
  authenticated: boolean; compact?: boolean; onToggled?: (enabled: boolean) => void;
}) {
  const { t } = useTranslation("app");
  const [status, setStatus] = useState<DevinCliStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void fetchDevinCliStatus().then(value => { if (mounted.current) setStatus(value); }).catch(error => { if (mounted.current) setError(String(error)); });
    return () => { mounted.current = false; };
  }, []);
  const act = async (enabled?: boolean) => {
    setBusy(true); setError("");
    try {
      if (enabled !== undefined) { const result = await setDevinCliEnabled(enabled); onToggled?.(result.enabled); }
      const next = await fetchDevinCliStatus(true);
      if (mounted.current) setStatus(next);
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const enabled = status?.enabled ?? authenticated;
  const message = !status ? t("devinCli.checking", "Checking Devin CLI…")
    : !status.binary.available ? t("devinCli.missing", "Install Devin CLI on the Fusion server and make it available on PATH.")
    : !status.authenticated ? t("devinCli.login", "Run devin auth login on the Fusion server, then check again.")
    : !enabled ? t("devinCli.disabled", "Devin is signed in. Enable it to show its models in Fusion.")
    : t("devinCli.ready", "Ready. Uses your existing Devin CLI sign-in.");
  const actions = <>
    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act()}>{t("devinCli.check", "Check status")}</button>
    <button type="button" className={`btn btn-sm${enabled ? "" : " btn-primary"}`} disabled={busy || !status || (!enabled && !status.binary.available)} onClick={() => void act(!enabled)}>
      {enabled ? t("devinCli.disable", "Disable") : t("devinCli.enable", "Enable")}
    </button>
  </>;
  const details = <>
    <p className="settings-muted" role="status">{message}</p>
    {status?.binary.version && <small className="settings-muted">{status.binary.version}</small>}
    {error && <p className="onboarding-helper-text onboarding-helper-text--error" role="alert">{error}</p>}
  </>;
  return compact ? <div className="auth-provider-card auth-provider-card--cli" data-testid="devin-cli-provider-card">
    <div className="auth-provider-header"><div className="auth-provider-info"><ProviderIcon provider="devin-cli" size="sm"/><strong>Devin CLI</strong></div><div className="auth-provider-cli-actions">{actions}</div></div>
    <div className="auth-provider-cli-details-body">{details}</div>
  </div> : <div className="onboarding-provider-card" data-testid="devin-cli-provider-card">
    <div className="onboarding-provider-card__icon"><ProviderIcon provider="devin-cli" size="md"/></div>
    <div className="onboarding-provider-card__body"><strong className="onboarding-provider-card__name">Devin CLI</strong>{details}</div>
    <div className="onboarding-provider-card__actions">{actions}</div>
  </div>;
}
