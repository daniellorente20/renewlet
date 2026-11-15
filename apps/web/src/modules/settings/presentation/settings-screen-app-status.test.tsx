import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCalendarFeedControllerState,
  createControllerState,
  createUploadedAssetsManagerState,
  mocks,
  renderSettingsScreen,
} from "./settings-screen.test-utils";

describe("SettingsScreen app status", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    mocks.useSettingsFormController.mockReturnValue(createControllerState());
    mocks.useCalendarFeedSettingsController.mockReturnValue(createCalendarFeedControllerState());
    mocks.useUploadedAssetsManager.mockReturnValue(createUploadedAssetsManagerState());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("keeps cached settings visible and marks an app status refresh failure", async () => {
    const retryAppStatus = vi.fn().mockResolvedValue(undefined);
    mocks.useSettingsFormController.mockReturnValue(createControllerState({
      appStatusHasError: true,
      appStatusHasData: true,
      retryAppStatus,
    }));

    renderSettingsScreen();

    expect(screen.getByRole("alert")).toHaveTextContent("未更新");
    await userEvent.setup().click(screen.getByRole("button", { name: "重试" }));
    expect(retryAppStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("SMTP 服务器")).toBeInTheDocument();
  });
});
