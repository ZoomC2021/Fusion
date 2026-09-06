import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
const mocks = vi.hoisted(() => ({ status: vi.fn(), enable: vi.fn() }));
vi.mock("../../api", () => ({ fetchDevinCliStatus: mocks.status, setDevinCliEnabled: mocks.enable }));
import { DevinCliProviderCard } from "../DevinCliProviderCard";
const status = { enabled: true, ready: true, authenticated: true, binary: { available: true, version: "devin test" } };
beforeEach(() => { vi.clearAllMocks(); mocks.status.mockResolvedValue(status); });
it.each([false, true])("can disable and re-enable in compact=%s", async compact => {
  const user = userEvent.setup(); const toggled = vi.fn(); render(<DevinCliProviderCard compact={compact} authenticated onToggled={toggled}/>);
  await screen.findByText(/Ready/); mocks.enable.mockResolvedValue({ enabled: false }); mocks.status.mockResolvedValue({ ...status, enabled: false });
  await user.click(screen.getByRole("button", { name: "Disable" })); await waitFor(() => expect(toggled).toHaveBeenCalledWith(false));
  const button = await screen.findByRole("button", { name: "Enable" }); await waitFor(() => expect(button).not.toBeDisabled());
  mocks.enable.mockResolvedValue({ enabled: true }); mocks.status.mockResolvedValue(status); await user.click(button); await waitFor(() => expect(toggled).toHaveBeenCalledWith(true));
});
it.each([false, true])("shows missing installation and sign-in guidance in compact=%s", async compact => {
  mocks.status.mockResolvedValue({ ...status, enabled: false, authenticated: false, binary: { available: false } }); render(<DevinCliProviderCard compact={compact} authenticated={false}/>);
  await screen.findByText(/Install Devin/); expect(screen.getByRole("button", { name: "Enable" })).toBeDisabled();
  mocks.status.mockResolvedValue({ ...status, enabled: false, authenticated: false }); await userEvent.click(screen.getByRole("button", { name: "Check status" })); await screen.findByText(/devin auth login/);
});
it("shows probe failures without losing the retry action", async () => {
  mocks.status.mockRejectedValue(new Error("offline")); render(<DevinCliProviderCard authenticated={false}/>); expect(await screen.findByRole("alert")).toHaveTextContent("offline"); expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
});
