import type { Context } from "hono";
import type { NotificationService } from "../notifications";
import type { UpdateNotificationsBody } from "../schema";

export function createNotificationRoutes({ notifications }: { notifications: NotificationService }) {
  return {
    /** 保存済み URL は返さない (configured と末尾 4 文字だけ) */
    get: (c: Context) => c.json(notifications.settings()),

    update: (c: Context, body: UpdateNotificationsBody) => c.json(notifications.save(body)),

    /** 保存済み設定で 1 通。失敗も結果として 200 で返す (アプリ側のエラーだけ 4xx) */
    test: async (c: Context) => c.json(await notifications.test()),
  };
}
