// 续订提醒事件走独立回调。这些测试守住两个混淆点：地址不能回流到浏览器，也不能被误填进
// 汇总渠道的字段，那个字段的下游消费方读取的是 title/content。
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appSettingsSecretStatus } from "@renewlet/shared/schemas/settings";
import { DEFAULT_SETTINGS } from "@/types/subscription";
import {
  createControllerState,
  createUploadedAssetsManagerState,
  mocks,
  renderSettingsScreen,
} from "./settings-screen.test-utils";

function withController(patch: (controller: ReturnType<typeof createControllerState>) => void) {
  const controller = createControllerState();
  patch(controller);
  mocks.useSettingsFormController.mockReturnValue(controller);
}

describe("renewal reminder webhook setting", () => {
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
    mocks.useUploadedAssetsManager.mockReturnValue(createUploadedAssetsManagerState());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a field of its own, outside the generic webhook channel panel", async () => {
    renderSettingsScreen();
    const section = await screen.findByTestId("renewal-webhook-section");
    const input = within(section).getByTestId("renewal-webhook-input");

    expect(input).toHaveAttribute("name", "renewalWebhookUrl");
    // 汇总渠道的输入框是另一个字段，且不在这一节里。
    expect(within(section).queryByRole("textbox", { name: /webhookUrl$/ })).toBeNull();
  });

  it("says in the copy that it is a separate endpoint and what it sends", async () => {
    renderSettingsScreen();
    const section = await screen.findByTestId("renewal-webhook-section");

    expect(section).toHaveTextContent("独立通道");
    expect(section).toHaveTextContent("与上方 Webhook 渠道无关的另一个地址");
    expect(section).toHaveTextContent("每条订阅在临近续订时单独发送一次 POST");
    expect(section).toHaveTextContent("请勿把同一个地址填到两处");
  });

  it("masks the value and keeps it out of autofill", async () => {
    renderSettingsScreen();
    const input = await screen.findByTestId("renewal-webhook-input");

    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "off");
  });

  it("starts empty even when one is stored, and shows it as configured", async () => {
    withController((controller) => {
      controller.secretStatus = appSettingsSecretStatus({
        ...DEFAULT_SETTINGS,
        renewalWebhookUrl: "https://hooks.example.com/renewal",
      });
    });
    renderSettingsScreen();

    // 已保存的地址永远不回到浏览器，只回来一个 configured 标记。
    expect(await screen.findByTestId("renewal-webhook-input")).toHaveValue("");
    expect(await screen.findByTestId("renewal-webhook-configured")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("hooks.example.com");
  });

  it("offers no clear control when nothing is stored", async () => {
    renderSettingsScreen();
    await screen.findByTestId("renewal-webhook-section");

    expect(screen.queryByTestId("renewal-webhook-configured")).not.toBeInTheDocument();
  });

  it("clears only the renewal endpoint, never the summary one", async () => {
    const clearSecret = vi.fn();
    withController((controller) => {
      controller.secretStatus = appSettingsSecretStatus({
        ...DEFAULT_SETTINGS,
        renewalWebhookUrl: "https://hooks.example.com/renewal",
        webhookUrl: "https://hooks.example.com/summary",
      });
      controller.clearSecret = clearSecret;
    });
    renderSettingsScreen();

    const configured = await screen.findByTestId("renewal-webhook-configured");
    await userEvent.click(within(configured).getByRole("button"));

    expect(clearSecret).toHaveBeenCalledWith("renewalWebhookUrl");
    expect(clearSecret).not.toHaveBeenCalledWith("webhookUrl");
  });

  it("stages typing as a settings update instead of sending it anywhere", async () => {
    const updateSetting = vi.fn();
    withController((controller) => {
      controller.updateSetting = updateSetting;
    });
    renderSettingsScreen();

    await userEvent.type(await screen.findByTestId("renewal-webhook-input"), "h");

    expect(updateSetting).toHaveBeenCalledWith("renewalWebhookUrl", "h");
  });
});
