import { Context, icons, redirectTo } from "@koishijs/client";

import Channels from "./Channels.vue";
import ConversationDetail from "./ConversationDetail.vue";
import Home from "./Home.vue";
import Xiaoheihe from "./Xiaoheihe.vue";
import YesImBotIcon from "./YesImBotIcon.vue";

icons.register("yesimbot", YesImBotIcon);

export default function (ctx: Context): void {
  ctx.on("activity", (activity) => activity.id === "home");

  const router = ctx.$router.router;
  const dispose = router.beforeEach((to) => {
    if (to.path === "/") return "/yesimbot";
  });
  ctx.on("dispose", dispose);

  // Keep a pending direct URL saved by the router while dynamic pages load.
  if (router.currentRoute.value.path === "/" && (!redirectTo.value || redirectTo.value === "/")) {
    redirectTo.value = "/yesimbot";
  }

  ctx.page({ id: "yesimbot", path: "/yesimbot", name: "主面板", icon: "yesimbot", order: 1000, component: Home });
  ctx.page({
    id: "yesimbot-channels",
    path: "/yesimbot/channels",
    name: "会话浏览",
    icon: "paper-plane",
    order: 950,
    authority: 4,
    component: Channels,
  });
  ctx.page({
    id: "yesimbot-xiaoheihe",
    path: "/yesimbot/xiaoheihe",
    name: "小黑盒活动",
    icon: "paper-plane",
    order: 940,
    authority: 4,
    component: Xiaoheihe,
  });
  ctx.page({
    id: "yesimbot-conversation",
    path: "/yesimbot/channels/:channel/sessions/:session",
    name: "会话详情",
    icon: "paper-plane",
    order: 950,
    disabled: () => true,
    authority: 4,
    component: ConversationDetail,
  });
}
