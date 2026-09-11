import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { assertSendableRenewalEvent, type RenewalUpcomingEvent } from "./notification-renewal-webhook";
import { sendNotificationJson } from "./notification-http";
import {
  providerMessageFromResponse,
  redactUpstreamSecrets,
  upstreamProviderResponseFromFetchResponse,
} from "./upstream-response";
import type { Env } from "./types";
import type { AppLocale } from "./http";

/**
 * Sends the renewal event straight to the WhatsApp Cloud API, with no relay in between.
 *
 * Like the generic renewal webhook, this stays out of notificationSenders and out of the
 * enabledChannels fan-out: that path builds one message per user, this is one per subscription.
 */

const SERVICE = "WhatsApp";
const DEFAULT_API_BASE_URL = "https://graph.facebook.com/v23.0";

/**
 * Both templates were created in Meta as Spanish (`es`), not Spanish SPA (`es_ES`).
 * They are separate entries in Meta's language list and the name plus language pair is fixed at
 * creation and can never be edited, so picking the wrong one fails with a template-not-found error
 * that does not say why.
 */
const TEMPLATE_LANGUAGE_CODE = "es";
const TEMPLATE_NAMES = {
  annual: "renewlet_renovacion_anual",
  monthly: "renewlet_renovacion_mensual",
} as const;

const MAX_RECORDED_ERROR_LENGTH = 300;

/**
 * Error codes for which repeating the identical request can never succeed.
 *
 * The test is narrow on purpose: permanent means the request itself is wrong, not merely that
 * something has to be fixed before it works. Anything a human can put right without altering the
 * request stays retryable, because the two mistakes cost wildly different amounts. A wrong
 * "retryable" costs one attempt a day; a wrong "permanent" destroys the reminder window outright.
 *
 * Descriptions are quoted from Meta's Cloud API error reference.
 */
const PERMANENT_ERROR_CODES = new Set([
  100,    // "The request included one or more unsupported or misspelled parameters"
  131008, // "The request is missing a required parameter"
  131009, // "One or more parameter values are invalid"
  132000, // parameter count "did not match the number of variable parameters defined in the template"
  132001, // "The template does not exist in the specified language or the template has not been approved"
  132005, // "Translated text is too long"
  132007, // "Template content violates a WhatsApp policy"
  132012, // "Variable parameter values formatted incorrectly"
]);

/**
 * Fallback only, used when the body carries no parseable error code.
 *
 * Meta answers 400 for causes with nothing in common: a malformed body, a recipient that is not on
 * the allow list, a rate limit. The status alone is not the signal, so it decides nothing while a
 * code is available.
 */
const PERMANENT_STATUSES = new Set([400, 404, 422]);

/** Reads Meta's numeric error code out of an error body, if there is one to read. */
export function metaErrorCode(body: string | null | undefined): number | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    const code = parsed.error?.code;
    return typeof code === "number" && Number.isInteger(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * Whether a rejection is final for this cycle.
 *
 * An unrecognised code is retryable. That default is the whole point: 131030, the recipient not
 * being on the allow list, is not even in Meta's published reference, and treating it as final
 * consumed two windows on their first attempt for a problem that a single allow-list entry fixes.
 */
export function isPermanentMetaFailure(status: number, body: string | null | undefined): boolean {
  const code = metaErrorCode(body);
  if (code !== null) return PERMANENT_ERROR_CODES.has(code);
  return PERMANENT_STATUSES.has(status);
}

export interface MetaWhatsAppConfig {
  token: string;
  phoneNumberId: string;
  baseUrl: string;
}

/** A rejection we cannot fix by trying again with the same input. */
export class RenewalSendError extends Error {
  readonly permanent: boolean;

  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = "RenewalSendError";
    this.permanent = permanent;
  }
}

export function isPermanentRenewalSendFailure(error: unknown): boolean {
  return error instanceof RenewalSendError && error.permanent;
}

export function metaWhatsAppConfig(env: Env): MetaWhatsAppConfig | null {
  const token = env.WHATSAPP_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneNumberId) return null;
  // The override exists so the exact request body can be inspected against a throwaway endpoint
  // before it is ever pointed at Meta. Absent, the destination is the real one.
  const baseUrl = env.WHATSAPP_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;
  return { token, phoneNumberId, baseUrl: baseUrl.replace(/\/+$/, "") };
}

/**
 * Collapses every run of whitespace to a single space and trims the ends.
 *
 * Verified against the live API: a template parameter containing a newline is rejected with
 * "Bad request - please check your parameters", which names neither the parameter nor the
 * character. Tabs and runs of four or more spaces fail the same way. Normalising here means a
 * value that would be rejected is repaired rather than sent and lost.
 */
export function normalizeTemplateParameter(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Keeps only digits, because the recipient field is free text.
 *
 * A number typed as `+34 600 000 000` would otherwise travel with its spaces and be refused with an
 * error that never mentions the number's format.
 */
export function normalizeRecipientPhone(value: string): string {
  return value.replace(/\D/g, "");
}

/** Templates were approved with samples like `15/10/2026`, so the ISO date is rendered for display. */
export function formatTemplateDate(dateOnly: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (!match) return dateOnly;
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

/**
 * Positional parameters, in the order the approved template bodies declare them.
 *
 * Monthly: service, date, amount, days. Annual inserts the price change before the days, which is
 * the variable the monthly template does not have.
 */
export function templateParametersFor(event: RenewalUpcomingEvent): string[] {
  const service = event.service;
  const date = formatTemplateDate(event.next_billing_date);
  const days = String(event.days_remaining);
  const values = event.billing_cycle === "annual"
    ? [service, date, event.amount, event.price_note, days]
    : [service, date, event.amount, days];
  return values.map((value) => normalizeTemplateParameter(value));
}

export function templateNameFor(event: RenewalUpcomingEvent): string {
  return TEMPLATE_NAMES[event.billing_cycle];
}

/**
 * Normalises every text field, then hands the result to the shared guard.
 *
 * Order matters. The guard rejects newlines outright, which is right for the generic webhook where
 * the receiver decides what to do. Here a repairable value is worth repairing: losing a 240 euro
 * warning because a service name carries a stray newline is a worse outcome than a collapsed space.
 * Anything still empty after normalising is refused, because an empty parameter fails the whole
 * delivery rather than leaving a gap in the text.
 */
export function normalizeRenewalEventForTemplate(event: RenewalUpcomingEvent): RenewalUpcomingEvent {
  return {
    ...event,
    service: normalizeTemplateParameter(event.service),
    next_billing_date: normalizeTemplateParameter(event.next_billing_date),
    amount: normalizeTemplateParameter(event.amount),
    price_note: normalizeTemplateParameter(event.price_note),
  };
}

export function buildMetaTemplateMessage(event: RenewalUpcomingEvent, to: string): Record<string, unknown> {
  const parameters = templateParametersFor(event);
  const empty = parameters.findIndex((value) => value.length === 0);
  // An empty parameter does not leave a blank in the text, it fails the whole delivery, so it is
  // caught here with a message that names the position rather than downstream with a generic one.
  if (empty >= 0) throw new RenewalSendError(`WHATSAPP_EMPTY_TEMPLATE_PARAMETER:${empty + 1}`, true);
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: templateNameFor(event),
      language: { code: TEMPLATE_LANGUAGE_CODE },
      // Only the body carries variables. The annual header is static text and both buttons use a
      // static URL, so neither needs a component entry of its own.
      components: [{
        type: "body",
        parameters: parameters.map((text) => ({ type: "text", text })),
      }],
    },
  };
}

export async function sendMetaWhatsApp(
  config: MetaWhatsAppConfig,
  settings: Pick<ApiAppSettings, "testPhone">,
  event: RenewalUpcomingEvent,
  locale: AppLocale,
): Promise<void> {
  const to = normalizeRecipientPhone(settings.testPhone);
  // Unreachable through the reminder job, and that is the point rather than a reason to delete it.
  // selectRenewalDelivery now asks this same question before it picks this sender. While it did
  // not, this line was quietly absorbing a selection bug: a user with no number was given WhatsApp
  // anyway, threw here on every subscription, and burned the retry budget on a failure no retry
  // could fix, all without ever falling through to their own webhook. It stays because this
  // function is exported and callable on its own, but it is a backstop, not the thing protecting
  // anyone.
  if (!to) throw new RenewalSendError("WHATSAPP_RECIPIENT_NOT_CONFIGURED", true);
  const body = buildMetaTemplateMessage(assertSendableRenewalEvent(normalizeRenewalEventForTemplate(event)), to);
  const secrets = [config.token];
  const url = `${config.baseUrl}/${encodeURIComponent(config.phoneNumberId)}/messages`;

  let response: Response;
  try {
    response = await sendNotificationJson(url, body, SERVICE, locale, {
      headers: { authorization: `Bearer ${config.token}` },
      secrets,
    });
  } catch (error) {
    // A transport failure says nothing about the request, so the next scheduled pass may retry.
    throw new RenewalSendError(safeErrorText(error, secrets), false);
  }

  if (response.ok) {
    if (response.body) await response.body.cancel().catch(() => undefined);
    return;
  }

  const providerResponse = await upstreamProviderResponseFromFetchResponse(response, { secrets });
  const detail = providerMessageFromResponse(providerResponse) ?? response.statusText;
  const permanent = isPermanentMetaFailure(response.status, providerResponse.body);
  throw new RenewalSendError(
    `${SERVICE} ${response.status}: ${redactUpstreamSecrets(detail, secrets).trim().slice(0, MAX_RECORDED_ERROR_LENGTH)}`,
    permanent,
  );
}

/** The token can come back inside a provider error body, so nothing reaches a log unredacted. */
function safeErrorText(error: unknown, secrets: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactUpstreamSecrets(message, secrets).slice(0, MAX_RECORDED_ERROR_LENGTH);
}
