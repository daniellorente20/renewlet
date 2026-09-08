import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings } from "@/types/subscription";
import { useSettingsSecretDrafts } from "./use-settings-secret-drafts";

describe("useSettingsSecretDrafts", () => {
  it("keeps write-only drafts separate from a refreshed public settings baseline", () => {
    const first: AppSettings = { ...DEFAULT_SETTINGS, themeVariant: "ocean" };
    const { result, rerender } = renderHook(
      ({ settings }) => useSettingsSecretDrafts(settings, false),
      { initialProps: { settings: first } },
    );

    act(() => {
      result.current.stageSetting("telegramBotToken", "draft-token");
    });
    rerender({ settings: { ...first, themeVariant: "rose" as const } });

    expect(result.current.settingsWithDrafts.themeVariant).toBe("rose");
    expect(result.current.settingsWithDrafts.telegramBotToken).toBe("draft-token");
    expect(result.current.updates()).toEqual({
      telegramBotToken: { action: "set", value: "draft-token" },
    });
  });

  it("distinguishes reverting a local set draft from explicitly clearing a stored secret", () => {
    const { result } = renderHook(() => useSettingsSecretDrafts(DEFAULT_SETTINGS, false));

    act(() => {
      result.current.stageSetting("telegramBotToken", "draft-token");
      result.current.stageSetting("telegramBotToken", "");
    });
    expect(result.current.dirty).toBe(false);
    expect(result.current.updates()).toEqual({});

    act(() => {
      result.current.clear("telegramBotToken");
    });
    expect(result.current.updates()).toEqual({ telegramBotToken: { action: "clear" } });
  });

  it("stages the nested AI key without placing it in public settings", () => {
    const { result } = renderHook(() => useSettingsSecretDrafts(DEFAULT_SETTINGS, false));

    act(() => {
      result.current.stageSetting("aiRecognition", {
        ...DEFAULT_SETTINGS.aiRecognition,
        apiKey: "draft-ai-key",
      });
    });

    expect(result.current.settingsWithDrafts.aiRecognition.apiKey).toBe("draft-ai-key");
    expect(result.current.updates()).toEqual({
      "aiRecognition.apiKey": { action: "set", value: "draft-ai-key" },
    });
  });

  it("treats the renewal webhook as a write-only secret, not a plain setting", () => {
    const { result } = renderHook(() => useSettingsSecretDrafts(DEFAULT_SETTINGS, false));

    act(() => {
      result.current.stageSetting("renewalWebhookUrl", "https://example.com/renewal");
    });
    // The draft drives the input, and the value leaves the browser only as a set intent.
    expect(result.current.settingsWithDrafts.renewalWebhookUrl).toBe("https://example.com/renewal");
    expect(result.current.updates()).toEqual({
      renewalWebhookUrl: { action: "set", value: "https://example.com/renewal" },
    });
  });

  it("clears a stored renewal webhook without touching the summary webhook", () => {
    const { result } = renderHook(() => useSettingsSecretDrafts(DEFAULT_SETTINGS, false));

    act(() => {
      result.current.clear("renewalWebhookUrl");
    });
    // Confusing the two endpoints is the failure this separation exists to prevent, so clearing one
    // must never emit an intent for the other.
    expect(result.current.updates()).toEqual({ renewalWebhookUrl: { action: "clear" } });
  });

  it("blocks secret changes while external integrations are disabled", () => {
    const { result } = renderHook(() => useSettingsSecretDrafts(DEFAULT_SETTINGS, true));

    act(() => {
      expect(result.current.stageSetting("smtpPassword", "password")).toBe("blocked");
      result.current.clear("smtpPassword");
    });

    expect(result.current.dirty).toBe(false);
    expect(result.current.updates()).toEqual({});
  });
});
