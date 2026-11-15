import { effectiveReminderDays } from "@renewlet/shared/runtime";
import { compareDateOnly, daysBetweenDateOnly, type DateOnly } from "@/lib/time/date-only";
import { isOneTimeBuyout } from "@/lib/subscription-billing";
import { DISABLED_REMINDER_DAYS, type SubscriptionCollectionItem } from "@/types/subscription";
import { isEffectivelyActiveSubscription } from "./subscription-status";

export type UpcomingReminderKind = "renewal" | "expiry";

export interface UpcomingReminderItem {
  subscription: SubscriptionCollectionItem;
  kind: UpcomingReminderKind;
  daysUntil: number;
  reminderDays: number;
}

export type UpcomingSubscriptionEventKind = "renewal" | "trial" | "expiry";

export interface UpcomingSubscriptionEvent {
  subscriptionId: string;
  subscription: SubscriptionCollectionItem;
  kind: UpcomingSubscriptionEventKind;
  dueDate: DateOnly;
  daysUntil: number;
  reminderEnabled: boolean;
}

interface BuildUpcomingReminderItemsInput {
  subscriptions: readonly SubscriptionCollectionItem[];
  notificationReminderDays: number;
  today: DateOnly | string;
}

/** 构建首页“即将续费/到期”提醒窗口条目。 */
export function buildUpcomingReminderItems({
  subscriptions,
  notificationReminderDays,
  today,
}: BuildUpcomingReminderItemsInput): UpcomingReminderItem[] {
  const items: UpcomingReminderItem[] = [];

  for (const subscription of subscriptions) {
    if (!isEffectivelyActiveSubscription(subscription, today)) continue;
    if (isOneTimeBuyout(subscription)) continue;

    // 首页可视窗口复用 reminderDays 的哨兵契约，但这里只决定是否展示，不代表 Cron 发送时刻。
    const reminderDays = effectiveReminderDays(subscription.reminderDays, notificationReminderDays);
    if (reminderDays === undefined) continue;

    const daysUntil = daysBetweenDateOnly(today, subscription.nextBillingDate);
    if (daysUntil < 0 || daysUntil > reminderDays) continue;

    items.push({
      subscription,
      kind: subscription.billingCycle === "one-time" ? "expiry" : "renewal",
      daysUntil,
      reminderDays,
    });
  }

  return items.sort((a, b) => {
    if (a.daysUntil !== b.daysUntil) return a.daysUntil - b.daysUntil;
    return a.subscription.name.localeCompare(b.subscription.name);
  });
}

interface BuildUpcomingSubscriptionEventsInput {
  subscriptions: readonly SubscriptionCollectionItem[];
  today: DateOnly | string;
}

/**
 * 解析订阅对用户可见的下一项未来事件。
 *
 * 提醒窗口是通知业务的筛选条件，不能决定 Dashboard 是否展示未来日期；这里保留独立的事件模型，
 * 让关闭提醒的订阅仍可见，同时继续复用有效状态和买断排除规则。
 */
export function buildUpcomingSubscriptionEvents({
  subscriptions,
  today,
}: BuildUpcomingSubscriptionEventsInput): UpcomingSubscriptionEvent[] {
  return subscriptions
    .map((subscription) => resolveUpcomingSubscriptionEvent(subscription, today))
    .filter((event): event is UpcomingSubscriptionEvent => event !== null)
    .sort((left, right) => {
      const dueDateOrder = compareDateOnly(left.dueDate, right.dueDate);
      if (dueDateOrder !== 0) return dueDateOrder;
      const nameOrder = left.subscription.name.localeCompare(right.subscription.name);
      return nameOrder !== 0 ? nameOrder : left.subscription.id.localeCompare(right.subscription.id);
    });
}

/** 返回单个订阅最近的未来客户事件；试用结束日优先于较晚的正式扣费日。 */
export function resolveUpcomingSubscriptionEvent(
  subscription: SubscriptionCollectionItem,
  today: DateOnly | string,
): UpcomingSubscriptionEvent | null {
  if (!isEffectivelyActiveSubscription(subscription, today)) return null;
  if (isOneTimeBuyout(subscription)) return null;

  let dueDate = subscription.nextBillingDate;
  let kind: UpcomingSubscriptionEventKind = subscription.billingCycle === "one-time" ? "expiry" : "renewal";

  if (
    subscription.status === "trial"
    && subscription.trialEndDate
    && compareDateOnly(subscription.trialEndDate, today) >= 0
    && compareDateOnly(subscription.trialEndDate, dueDate) <= 0
  ) {
    dueDate = subscription.trialEndDate;
    kind = "trial";
  }

  if (compareDateOnly(dueDate, today) < 0) return null;

  return {
    subscriptionId: subscription.id,
    subscription,
    kind,
    dueDate,
    daysUntil: daysBetweenDateOnly(today, dueDate),
    reminderEnabled: subscription.reminderDays !== DISABLED_REMINDER_DAYS,
  };
}
