// Everything here runs against a stubbed fetch. Nothing leaves the machine.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildMetaTemplateMessage,
  formatTemplateDate,
  isPermanentRenewalSendFailure,
  metaWhatsAppConfig,
  normalizeRecipientPhone,
  normalizeTemplateParameter,
  sendMetaWhatsApp,
  templateParametersFor,
  type MetaWhatsAppConfig,
} from "./notification-meta-whatsapp";
import type { RenewalUpcomingEvent } from "./notification-renewal-webhook";
import type { Env } from "./types";

vi.mock("./smtp", () => ({ notificationSmtpConfig: vi.fn(), sendSmtpEmail: vi.fn() }));

const TOKEN = "EAAG-super-secret-token-value";
const CONFIG: MetaWhatsAppConfig = {
  token: TOKEN,
  phoneNumberId: "123456789",
  baseUrl: "https://graph.example.test/v23.0",
};
const RECIPIENT = { testPhone: "34600000000" };

function annual(overrides: Partial<RenewalUpcomingEvent> = {}): RenewalUpcomingEvent {
  return {
    event: "renewal_upcoming",
    billing_cycle: "annual",
    reminder_window: 30,
    days_remaining: 30,
    service: "Adobe Creative Cloud",
    next_billing_date: "2026-10-15",
    amount: "239,88 EUR",
    price_note: "sube desde 199,00 EUR",
    ...overrides,
  };
}

function monthly(overrides: Partial<RenewalUpcomingEvent> = {}): RenewalUpcomingEvent {
  return annual({
    billing_cycle: "monthly",
    reminder_window: 7,
    days_remaining: 7,
    service: "Netflix",
    next_billing_date: "2026-09-15",
    amount: "8,99 EUR (sube desde 7,99 EUR)",
    price_note: "sube desde 7,99 EUR",
    ...overrides,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function lastRequestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("template routing", () => {
  it("sends an annual subscription to the annual template with five parameters", () => {
    const body = buildMetaTemplateMessage(annual(), "34600000000");
    const template = body["template"] as Record<string, unknown>;
    expect(template["name"]).toBe("renewlet_renovacion_anual");
    expect(template["language"]).toEqual({ code: "es" });
    const components = template["components"] as Array<{ type: string; parameters: Array<{ type: string; text: string }> }>;
    expect(components).toHaveLength(1);
    expect(components[0]?.type).toBe("body");
    // servicio, fecha, importe, cambio de precio, días
    expect(components[0]?.parameters.map((p) => p.text)).toEqual([
      "Adobe Creative Cloud", "15/10/2026", "239,88 EUR", "sube desde 199,00 EUR", "30",
    ]);
  });

  it("sends anything else to the monthly template with four parameters", () => {
    const body = buildMetaTemplateMessage(monthly(), "34600000000");
    const template = body["template"] as Record<string, unknown>;
    expect(template["name"]).toBe("renewlet_renovacion_mensual");
    const components = template["components"] as Array<{ parameters: Array<{ text: string }> }>;
    // servicio, fecha, importe, días. The monthly template has no price-change variable.
    expect(components[0]?.parameters.map((p) => p.text)).toEqual([
      "Netflix", "15/09/2026", "8,99 EUR (sube desde 7,99 EUR)", "7",
    ]);
  });

  it("declares no component for the static header or the static URL button", () => {
    const template = buildMetaTemplateMessage(annual(), "34600000000")["template"] as Record<string, unknown>;
    const types = (template["components"] as Array<{ type: string }>).map((component) => component.type);
    expect(types).toEqual(["body"]);
  });

  it("renders the ISO date the way the approved samples show it", () => {
    expect(formatTemplateDate("2026-10-15")).toBe("15/10/2026");
    expect(formatTemplateDate("2026-01-02")).toBe("02/01/2026");
  });
});

describe("parameter normalization", () => {
  it("collapses the whitespace the API rejects", () => {
    // A newline comes back as "Bad request - please check your parameters", naming nothing.
    expect(normalizeTemplateParameter("Adobe\nCreative Cloud")).toBe("Adobe Creative Cloud");
    expect(normalizeTemplateParameter("Adobe\tCC")).toBe("Adobe CC");
    expect(normalizeTemplateParameter("239,88    EUR")).toBe("239,88 EUR");
    expect(normalizeTemplateParameter("  spaced  out  ")).toBe("spaced out");
    expect(normalizeTemplateParameter("Adobe\r\nCC")).toBe("Adobe CC");
  });

  it("leaves an already clean value untouched", () => {
    expect(normalizeTemplateParameter("sube desde 199,00 EUR")).toBe("sube desde 199,00 EUR");
  });

  it("normalizes every parameter on the way into the payload", () => {
    const parameters = templateParametersFor(annual({ service: "Adobe\nCreative   Cloud" }));
    expect(parameters[0]).toBe("Adobe Creative Cloud");
    for (const value of parameters) expect(value).not.toMatch(/[\n\r\t]|\s{4,}/);
  });
});

describe("sendMetaWhatsApp", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to the phone number's messages endpoint with a bearer token", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { messages: [{ id: "wamid.1" }] }));
    await sendMetaWhatsApp(CONFIG, RECIPIENT, annual(), "en-US");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("https://graph.example.test/v23.0/123456789/messages");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    const body = lastRequestBody(fetchMock);
    expect(body["messaging_product"]).toBe("whatsapp");
    expect(body["recipient_type"]).toBe("individual");
    expect(body["to"]).toBe("34600000000");
    expect(body["type"]).toBe("template");
  });

  it("never lets a newline reach the API", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { messages: [{ id: "wamid.1" }] }));
    await sendMetaWhatsApp(CONFIG, RECIPIENT, annual({ service: "Adobe\nCreative Cloud" }), "en-US");

    expect(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)).not.toContain("\\n");
    const parameters = ((lastRequestBody(fetchMock)["template"] as Record<string, unknown>)["components"] as Array<{ parameters: Array<{ text: string }> }>)[0]?.parameters ?? [];
    expect(parameters[0]?.text).toBe("Adobe Creative Cloud");
  });

  it("refuses an empty parameter before calling the API", async () => {
    await expect(sendMetaWhatsApp(CONFIG, RECIPIENT, annual({ price_note: "   " }), "en-US")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to send when no recipient is configured", async () => {
    await expect(sendMetaWhatsApp(CONFIG, { testPhone: "" }, annual(), "en-US")).rejects.toThrow("WHATSAPP_RECIPIENT_NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the token out of the message on a rejection", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, {
      error: { message: `Bad request - please check your parameters (token ${TOKEN})` },
    }));

    const error = await sendMetaWhatsApp(CONFIG, RECIPIENT, annual(), "en-US").catch((caught: unknown) => caught);
    expect(String(error)).toContain("400");
    expect(String(error)).not.toContain(TOKEN);
  });

  it.each([
    [400, "a malformed request"],
    [404, "a template that does not exist"],
    [422, "an unprocessable request"],
  ])("treats %i as final, because repeating it unchanged cannot work", async (status) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { error: { message: "refused" } }));
    const error = await sendMetaWhatsApp(CONFIG, RECIPIENT, annual(), "en-US").catch((caught: unknown) => caught);
    expect(isPermanentRenewalSendFailure(error)).toBe(true);
  });

  it.each([
    [401, "an expired or revoked token"],
    [403, "a permission that can be granted"],
    [408, "a timeout"],
    [429, "rate limiting"],
    [500, "a server error"],
    [503, "an outage"],
  ])("treats %i as retryable, so a fixable problem does not lose the warning", async (status) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { error: { message: "not now" } }));
    const error = await sendMetaWhatsApp(CONFIG, RECIPIENT, annual(), "en-US").catch((caught: unknown) => caught);
    // 401 is the one that matters: a new token ten minutes later must still send the warning.
    expect(isPermanentRenewalSendFailure(error)).toBe(false);
    expect(String(error)).toContain(String(status));
  });

  it("treats a transport failure as retryable and redacted", async () => {
    fetchMock.mockRejectedValue(new Error(`connect ECONNREFUSED with Bearer ${TOKEN}`));

    const error = await sendMetaWhatsApp(CONFIG, RECIPIENT, annual(), "en-US").catch((caught: unknown) => caught);
    expect(isPermanentRenewalSendFailure(error)).toBe(false);
    expect(String(error)).not.toContain(TOKEN);
  });
});

describe("recipient normalization", () => {
  it("strips everything that is not a digit, however the number was typed", () => {
    expect(normalizeRecipientPhone("+34 600 000 000")).toBe("34600000000");
    expect(normalizeRecipientPhone("34-600-000-000")).toBe("34600000000");
    expect(normalizeRecipientPhone("(34) 600 000 000")).toBe("34600000000");
  });

  it("sends the cleaned number, not the typed one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { messages: [{ id: "wamid.1" }] }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await sendMetaWhatsApp(CONFIG, { testPhone: "+34 600 000 000" }, annual(), "en-US");
      expect(lastRequestBody(fetchMock)["to"]).toBe("34600000000");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses a recipient with no digits at all", async () => {
    await expect(sendMetaWhatsApp(CONFIG, { testPhone: "not a number" }, annual(), "en-US"))
      .rejects.toThrow("WHATSAPP_RECIPIENT_NOT_CONFIGURED");
  });
});

describe("metaWhatsAppConfig", () => {
  it("is absent unless both secrets are present, so the rest of the job keeps running", () => {
    expect(metaWhatsAppConfig({} as Env)).toBeNull();
    expect(metaWhatsAppConfig({ WHATSAPP_TOKEN: "t" } as Env)).toBeNull();
    expect(metaWhatsAppConfig({ WHATSAPP_PHONE_NUMBER_ID: "1" } as Env)).toBeNull();
    expect(metaWhatsAppConfig({ WHATSAPP_TOKEN: "  ", WHATSAPP_PHONE_NUMBER_ID: "1" } as Env)).toBeNull();
  });

  it("defaults to the real API and accepts an override for inspecting the body first", () => {
    expect(metaWhatsAppConfig({ WHATSAPP_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "1" } as Env)?.baseUrl)
      .toBe("https://graph.facebook.com/v23.0");
    expect(metaWhatsAppConfig({
      WHATSAPP_TOKEN: "t",
      WHATSAPP_PHONE_NUMBER_ID: "1",
      WHATSAPP_API_BASE_URL: "https://inspector.example.test/v1/",
    } as Env)?.baseUrl).toBe("https://inspector.example.test/v1");
  });
});
