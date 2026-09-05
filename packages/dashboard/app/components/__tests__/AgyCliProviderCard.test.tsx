import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AgyCliProviderCard } from "../AgyCliProviderCard";

const fetchAgyCliStatus = vi.fn();
const setAgyCliBinaryPath = vi.fn();
const setAgyCliEnabled = vi.fn();

vi.mock("../../api", () => ({
  fetchAgyCliStatus: (...args: unknown[]) => fetchAgyCliStatus(...args),
  setAgyCliBinaryPath: (...args: unknown[]) => setAgyCliBinaryPath(...args),
  setAgyCliEnabled: (...args: unknown[]) => setAgyCliEnabled(...args),
}));

const baseStatus = {
  binary: { available: true, version: "agy 1.1.27", binaryPath: "/usr/local/bin/agy", probeDurationMs: 5 },
  enabled: true,
  binaryPath: "/usr/local/bin/agy",
  extension: null,
  ready: true,
};

/*
FNXC:AgyCli 2026-09-06-00:00:
Regression coverage mirroring CursorCliProviderCard.test.tsx (FN-7695): the compact card's
below-header content (status line + binary-path control) must be nested inside
`.agy-cli-provider-card__body` (data-testid="agy-cli-provider-card-body") rather than being a
bare direct child of `.auth-provider-card`, so it inherits the same horizontal/bottom inset as
the header. The non-compact onboarding layout must NOT render this wrapper (its content already
lives in the padded `.onboarding-provider-card__body`).
*/
describe("AgyCliProviderCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchAgyCliStatus.mockResolvedValue(baseStatus);
    setAgyCliEnabled.mockResolvedValue({ enabled: true, binaryPath: baseStatus.binaryPath, restartRequired: false });
    setAgyCliBinaryPath.mockResolvedValue({ enabled: true, binaryPath: baseStatus.binaryPath, restartRequired: false });
  });

  it("wraps compact status line + binary-path control in the padded body wrapper", async () => {
    render(<AgyCliProviderCard authenticated compact />);

    const body = await screen.findByTestId("agy-cli-provider-card-body");
    expect(body).toHaveClass("agy-cli-provider-card__body");

    // Status line must be inside the body wrapper.
    const status = await screen.findByText(/Connected/i);
    expect(body).toContainElement(status);

    // Binary-path control (label + input) must be inside the body wrapper too.
    const label = screen.getByText("Antigravity CLI binary path");
    expect(body).toContainElement(label);
    const input = screen.getByLabelText("Antigravity CLI binary path");
    expect(body).toContainElement(input);

    // The wrapper must be a child of the card root, not a sibling bare child alongside it.
    const card = screen.getByTestId("agy-cli-provider-card");
    expect(card).toContainElement(body);
  });

  it("renders the Antigravity CLI provider name and description in compact mode", async () => {
    render(<AgyCliProviderCard authenticated compact />);
    expect(await screen.findByText("Antigravity CLI")).toBeInTheDocument();
  });

  it("keeps the body wrapper present before the status probe resolves (Probing…)", async () => {
    fetchAgyCliStatus.mockReturnValue(new Promise(() => {}));
    render(<AgyCliProviderCard authenticated={false} compact />);

    const body = await screen.findByTestId("agy-cli-provider-card-body");
    const status = await screen.findByText(/Probing local CLI/i);
    expect(body).toContainElement(status);
  });

  it("keeps the body wrapper present when a pathMessage is shown after a failed save", async () => {
    setAgyCliBinaryPath.mockRejectedValueOnce(new Error("binary not found"));
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();

    render(<AgyCliProviderCard authenticated compact />);
    const input = await screen.findByLabelText("Antigravity CLI binary path");
    await user.clear(input);
    await user.type(input, "/tmp/does-not-exist");

    const saveButton = screen.getByRole("button", { name: /Save & Test/i });
    await user.click(saveButton);

    const errorText = await screen.findByText("binary not found");
    const body = screen.getByTestId("agy-cli-provider-card-body");
    expect(body).toContainElement(errorText);
  });

  it("renders the binary-not-found status text when the binary is unavailable", async () => {
    fetchAgyCliStatus.mockResolvedValue({
      binary: { available: false, reason: "`agy` not found on PATH", probeDurationMs: 0 },
      enabled: false,
      binaryPath: undefined,
      extension: null,
      ready: false,
    });
    render(<AgyCliProviderCard authenticated={false} compact />);

    const body = await screen.findByTestId("agy-cli-provider-card-body");
    const status = await screen.findByText(/`agy` not found on PATH/i);
    expect(body).toContainElement(status);
  });

  it("shows the Enable button as disabled when binary is unavailable and not enabled", async () => {
    fetchAgyCliStatus.mockResolvedValue({
      binary: { available: false, reason: "unavailable", probeDurationMs: 0 },
      enabled: false,
      binaryPath: undefined,
      extension: null,
      ready: false,
    });
    render(<AgyCliProviderCard authenticated={false} compact />);

    const enableButton = await screen.findByRole("button", { name: /Enable/i });
    expect(enableButton).toBeDisabled();
  });

  it("renders the onboarding (non-compact) layout with description and does not render the body wrapper", async () => {
    render(<AgyCliProviderCard authenticated />);

    const card = await screen.findByTestId("agy-cli-provider-card");
    expect(card).toHaveClass("onboarding-provider-card");
    expect(screen.getByText("Runs Gemini models through the locally installed `agy` binary")).toBeInTheDocument();
    await waitFor(() => expect(fetchAgyCliStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("agy-cli-provider-card-body")).not.toBeInTheDocument();
  });

  it("calls setAgyCliEnabled when the Enable button is clicked", async () => {
    fetchAgyCliStatus.mockResolvedValue({
      binary: { available: true, version: "agy 1.1.27", probeDurationMs: 5 },
      enabled: false,
      binaryPath: undefined,
      extension: null,
      ready: false,
    });
    setAgyCliEnabled.mockResolvedValue({ enabled: true, binaryPath: undefined, restartRequired: false });
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();

    render(<AgyCliProviderCard authenticated={false} compact />);
    const enableButton = await screen.findByRole("button", { name: /Enable/i });
    await user.click(enableButton);

    await waitFor(() => expect(setAgyCliEnabled).toHaveBeenCalledWith(true));
  });
});
