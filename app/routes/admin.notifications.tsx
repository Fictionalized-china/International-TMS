import type { Route } from "./+types/admin.notifications";
import { InternalNotificationHistory } from "../components/InternalNotificationHistory";
import { requireSessionUser } from "../lib/auth.server";
import { valueOf } from "../lib/validation";
import {
  listInternalNotificationPage,
  markAllOrdinaryInternalNotificationsRead,
  markInternalNotification,
} from "../lib/internal-notifications.server";

export async function loader({request}:Route.LoaderArgs) {
  const current=await requireSessionUser(request);
  const requestedPage=Number.parseInt(new URL(request.url).searchParams.get("page")||"1",10);
  return listInternalNotificationPage(current.organizationId,current.userId,requestedPage);
}

export async function action({request}:Route.ActionArgs) {
  const current=await requireSessionUser(request);
  const form=await request.formData();
  const intent=valueOf(form,"intent");
  if(intent==="read_all") {
    await markAllOrdinaryInternalNotificationsRead(current.organizationId,current.userId);
    return {success:"普通通知已全部标记为已读；重要通知仍需逐条确认"};
  }
  if(intent==="read"||intent==="acknowledge") {
    const notificationId=valueOf(form,"notificationId");
    const result=await markInternalNotification({
      organizationId:current.organizationId,
      userId:current.userId,
      notificationId,
      intent,
    });
    return result.ok?result:{formError:result.error};
  }
  return {formError:"无效的通知操作"};
}

export default function AdminNotifications({loaderData,actionData}:Route.ComponentProps) {
  return <InternalNotificationHistory {...loaderData} actionData={actionData}/>;
}
