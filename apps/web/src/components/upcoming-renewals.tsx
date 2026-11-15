/**
 * 即将续费/到期列表（侧边栏卡片）。
 *
 * 规则：
 * - 展示所有有效订阅的下一项未来事件，提醒关闭不影响可见性
 * - 试用结束日早于正式续费日时展示试用事件
 * - 展示续费或一次性固定服务期到期
 * - 最多展示 5 条
 */

import { useMemo } from 'react';
import type { SubscriptionCollectionItem } from '@/types/subscription';
import { cn } from '@/lib/utils';
import { formatDateOnlyMonthDay, type DateOnly } from '@/lib/time/date-only';
import { useI18n } from '@/i18n/I18nProvider';
import { buildUpcomingSubscriptionEvents } from '@/modules/subscriptions/domain/upcoming-reminders';
import { Badge } from '@/components/ui/badge';
import { Bell } from 'lucide-react';

interface UpcomingRenewalsProps {
  /** 订阅列表（前端 domain 类型）。 */
  subscriptions: SubscriptionCollectionItem[];
  /** Dashboard 页面级账号业务日期。 */
  today: DateOnly | string;
}

/** 即将续费列表组件。 */
export function UpcomingRenewals({ subscriptions, today }: UpcomingRenewalsProps) {
  const { t, formatCurrency, locale } = useI18n();
  const upcoming = useMemo(
    () => buildUpcomingSubscriptionEvents({ subscriptions, today }).slice(0, 5),
    [subscriptions, today],
  );

  if (upcoming.length === 0) {
    return (
      <p className="py-4 text-center text-sm leading-6 text-muted-foreground">{t("upcoming.noneNextTwoWeeks")}</p>
    );
  }

  return (
    <ul className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)_max-content] gap-3">
      {upcoming.map((item) => (
        <li
          key={item.subscriptionId}
          className={cn(
            "col-span-3 grid min-w-0 grid-cols-subgrid items-center rounded-lg border border-border bg-secondary/50 p-4 transition-colors hover:bg-secondary",
            item.daysUntil <= 3 && "border-warning/30 bg-warning/5"
          )}
        >
          <div className={cn(
            "flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold",
            item.daysUntil <= 3
              ? "bg-warning/20 text-warning"
              : "bg-muted text-muted-foreground"
          )}>
            {item.daysUntil === 0 ? t("upcoming.todayShort") : t("upcoming.daysShort", { days: item.daysUntil })}
          </div>
          <div className="min-w-0">
            <p className="min-w-0 wrap-break-word font-medium text-foreground">{item.subscription.name}</p>
            <p className="text-xs text-muted-foreground">
              {item.kind === "trial"
                ? t("subscription.card.trialEnds", { date: formatDateOnlyMonthDay(item.dueDate, locale) })
                : item.kind === "expiry"
                  ? t("upcoming.expiresOn", { date: formatDateOnlyMonthDay(item.dueDate, locale) })
                  : t("upcoming.renewsOn", { date: formatDateOnlyMonthDay(item.dueDate, locale) })}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge
                variant={(item.kind === "renewal" || item.kind === "trial") && item.subscription.autoRenew ? "outline" : "secondary"}
                className="px-1.5 py-0 text-[11px]"
              >
                {item.kind === "expiry"
                  ? t("subscription.oneTimeMode.term")
                  : item.subscription.autoRenew
                    ? t("subscription.renewal.auto")
                    : t("subscription.renewal.manual")}
              </Badge>
              {item.reminderEnabled ? (
                <span
                  role="img"
                  aria-label={t("subscription.reminderEnabledHelp")}
                  title={t("subscription.reminderEnabledHelp")}
                  className="inline-flex items-center text-muted-foreground"
                >
                  <Bell className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              ) : null}
            </div>
          </div>
          <p className="whitespace-nowrap text-right font-semibold tabular-nums text-foreground">
            {formatCurrency(item.subscription.price, item.subscription.currency)}
          </p>
        </li>
      ))}
    </ul>
  );
}
