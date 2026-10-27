<template>
  <k-layout class="yib-xiaoheihe" main="darker">
    <div class="yib-xiaoheihe__body">
      <header class="yib-page-head">
        <div>
          <p class="yib-eyebrow">YesImBot · Xiaoheihe</p>
          <h1>小黑盒活动</h1>
          <p>只读查看账号状态、最近活动和独立会话；本页不会发帖、评论或改变运行状态。</p>
        </div>
        <time v-if="payload">快照 {{ formatDate(payload.generatedAt) }}</time>
      </header>

      <section v-if="!socket" class="yib-notice is-warning" role="alert">Console 连接已断开，无法取得实时状态；现有内容仅为上次快照。</section>
      <section v-else-if="payload === null" class="yib-notice is-warning" role="alert">活动数据不可访问，需要管理员权限 authority 4。</section>
      <section v-else-if="!payload" class="yib-notice" role="status">
        {{ clock - openedAt < 15_000 ? "正在读取小黑盒活动…" : "未收到活动数据：服务可能未启用、读取失败或权限不足（需要 authority 4），不代表零记录。" }}
      </section>
      <section v-else-if="stale" class="yib-notice is-warning" role="alert">活动快照超过 30 秒未更新，当前状态可能已过期。</section>

      <template v-if="payload">
        <section v-if="payload.status === 'partial' || payload.status === 'unavailable'" class="yib-notice is-warning" role="alert">
          <strong>{{ payload.status === "partial" ? "部分数据不可读" : "活动数据不可用" }}</strong>
          <span>请查看各账号的状态；不能将缺失数据解释为没有活动。</span>
          <span v-for="issue in payload.issues" :key="issue"
            >{{ issueLabel(issue) }} <code>{{ issue }}</code></span
          >
        </section>
        <section v-else-if="payload.status === 'empty'" class="yib-notice">未发现小黑盒账号配置或状态目录，尚不能展示活动记录。</section>

        <section class="yib-account-grid" aria-label="小黑盒账号状态">
          <article v-for="account in payload.accounts" :key="account.accountId" class="yib-card">
            <div class="yib-card__head">
              <h2>账号 {{ account.accountId }}</h2>
              <span class="yib-badge" :class="account.connection === 'online' ? 'is-success' : 'is-warning'">{{ connectionLabel(account.connection) }}</span>
            </div>
            <p v-if="account.connection === 'failed'" class="yib-warning">连接失败 <code>xiaoheihe_connection_failed</code>；不会显示原始连接异常。</p>
            <p v-if="account.stateStatus !== 'ready'" class="yib-warning" role="alert">
              {{ stateLabel(account.stateStatus) }} <code>{{ account.errorCode }}</code
              >；额度和暂停状态未知。
            </p>
            <p v-else-if="account.activityStatus === 'partial'" class="yib-warning" role="alert">
              部分活动记录格式无效，仅显示可读部分。<code>invalid_activity</code>
            </p>
            <p v-else-if="account.activityStatus === 'legacy'" class="yib-muted">旧版状态未记录活动流水；发布账本不会代替浏览记录。</p>
            <dl class="yib-status-list">
              <dt>运行模式</dt>
              <dd>
                {{
                  account.config.readOnly === true
                    ? "只读（禁止发帖、评论）"
                    : account.config.readOnly === false
                      ? "非只读配置（本页仍仅查看）"
                      : "只读配置未知"
                }}
              </dd>
              <dt>暂停</dt>
              <dd>
                {{ account.stateStatus !== "ready" ? "未知（状态不可读）" : account.paused ? "已暂停" : "未暂停" }}
                <code v-if="account.paused">{{ account.paused }}</code>
              </dd>
              <dt>最后浏览</dt>
              <dd>
                {{ account.lastBrowseAt === null ? "未知（状态不可读）" : account.lastBrowseAt === 0 ? "尚无浏览记录" : formatDate(account.lastBrowseAt) }}
              </dd>
              <dt>今日发帖 quota</dt>
              <dd>{{ quotaLabel(account, "post") }}</dd>
              <dt>今日互动 quota</dt>
              <dd>{{ quotaLabel(account, "interaction") }}</dd>
              <dt>统计日期</dt>
              <dd>{{ account.quota ? `${account.quota.day} · Asia/Shanghai` : "未知" }}</dd>
              <dt>跟进 / 待访问</dt>
              <dd>{{ account.watchedPosts ?? "未知" }} / {{ account.pendingVisits ?? "未知" }}</dd>
              <dt>浏览社区</dt>
              <dd>{{ listLabel(account.config.browseCommunities) }}</dd>
              <dt>候选话题</dt>
              <dd>{{ listLabel(account.config.candidateTopics) }}</dd>
              <dt>发帖社区</dt>
              <dd>{{ listLabel(account.config.communities, "空数组（使用上游默认社区）") }}</dd>
            </dl>
            <p v-if="account.quota && (account.quota.pending || account.quota.uncertain)" class="yib-warning">
              发布账本有 {{ account.quota.pending }} 条待确认、{{ account.quota.uncertain }} 条结果不确定；已占用额度，不代表送达。
            </p>
          </article>
        </section>

        <section class="yib-card">
          <div class="yib-card__head">
            <h2>活动流水</h2>
            <span class="yib-muted">{{ filteredActivities.length }} / {{ payload.activities.length }} 条 · 全部账号合计最近 300 条</span>
          </div>
          <p class="yib-muted">活动“完成”只表示该步骤成功，不是发帖或评论的送达凭证。quota 来自发布账本，待确认和结果不确定的尝试同样占用额度。</p>
          <div class="yib-toolbar">
            <label
              >账号
              <select v-model="accountFilter">
                <option value="">全部账号</option>
                <option v-for="account in payload.accounts" :key="account.accountId" :value="account.accountId">{{ account.accountId }}</option>
              </select>
            </label>
            <label
              >类型
              <select v-model="kindFilter">
                <option value="">全部类型</option>
                <option v-for="kind in activityKinds" :key="kind" :value="kind">{{ kindLabel(kind) }}</option>
              </select>
            </label>
            <label
              >结果
              <select v-model="outcomeFilter">
                <option value="">全部结果</option>
                <option value="ok">完成</option>
                <option value="failed">失败</option>
                <option value="blocked">已阻止</option>
              </select>
            </label>
            <label class="yib-search-box"
              ><k-icon name="search"></k-icon><input v-model="query" aria-label="搜索活动" placeholder="筛选标题、来源、帖子 ID 或错误码"
            /></label>
          </div>
          <p v-if="selectedAccounts.some((account) => account.stateStatus !== 'ready' || account.activityStatus === 'partial')" class="yib-warning">
            所选范围含不可读数据，以下仅为可读部分，不能据此判断账号没有活动。
          </p>
          <div v-if="filteredActivities.length" class="yib-table-scroll">
            <table class="yib-activity-table">
              <thead>
                <tr>
                  <th>时间 / 账号</th>
                  <th>类型</th>
                  <th>来源</th>
                  <th>数量 / 帖子</th>
                  <th>结果 / 安全错误码</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(activity, index) in filteredActivities" :key="`${activity.accountId}:${activity.id}:${index}`">
                  <td>
                    <time>{{ formatDate(activity.at) }}</time
                    ><small>{{ activity.accountId }}</small>
                  </td>
                  <td :title="activity.kind">{{ kindLabel(activity.kind) }}</td>
                  <td>{{ activity.source || "未记录来源" }}</td>
                  <td>
                    <span v-if="activity.count !== undefined">{{ activity.count }} 条</span>
                    <a v-if="postUrl(activity.postId)" :href="postUrl(activity.postId)" target="_blank" rel="noopener noreferrer">{{
                      activity.title || `帖子 ${activity.postId}`
                    }}</a>
                    <span v-else-if="activity.title">{{ activity.title }}</span>
                    <span v-else-if="activity.count === undefined">—</span>
                  </td>
                  <td>
                    <span class="yib-badge" :class="activity.outcome === 'ok' ? 'is-success' : 'is-warning'">{{ outcomeLabel(activity.outcome) }}</span>
                    <code v-if="activity.errorCode">{{ activity.errorCode }}</code>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else class="yib-empty-state">{{ activityEmptyLabel }}</div>
        </section>

        <section class="yib-card">
          <div class="yib-card__head">
            <h2>小黑盒会话</h2>
            <span class="yib-muted">复用现有受保护的会话详情</span>
          </div>
          <p class="yib-muted">这里只接收服务端核对平台、账号和频道格式后的小黑盒会话，不加载其他平台的会话索引。</p>
          <div v-if="!payload.conversations" class="yib-warning">会话索引不可读 <code>conversation_index_unavailable</code></div>
          <div v-else-if="!filteredChannels.length" class="yib-empty-state">当前账号范围尚无匹配的小黑盒会话记录。</div>
          <article v-for="channel in filteredChannels" :key="channel.key" class="yib-conversation">
            <h3>{{ channel.channelId }}</h3>
            <p class="yib-muted">账号 {{ channel.selfId }} · {{ channel.sessions.length }} 个会话</p>
            <div v-if="!channel.sessions.length" class="yib-muted">该频道尚无会话文件。</div>
            <router-link
              v-for="session in [...channel.sessions].reverse()"
              :key="session.filename"
              class="yib-session-item"
              :to="sessionPath(channel.key, session.filename)"
            >
              <span>{{ session.filename }}</span
              ><span>{{ session.isActive ? "活动会话" : "历史会话" }}</span
              ><k-icon name="chevron-right"></k-icon>
            </router-link>
          </article>
        </section>
      </template>
    </div>
  </k-layout>
</template>

<script lang="ts" setup>
import { socket, store } from "@koishijs/client";
import { computed, onMounted, onUnmounted, ref } from "vue";

import type { XiaoheiheAccountView, XiaoheiheActivity, XiaoheihePayload } from "./types";

const payload = computed(() => (store as { yesimbotXiaoheihe?: XiaoheihePayload | null }).yesimbotXiaoheihe);
const accountFilter = ref("");
const kindFilter = ref("");
const outcomeFilter = ref("");
const query = ref("");
const openedAt = Date.now();
const clock = ref(openedAt);
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => {
    clock.value = Date.now();
  }, 5_000);
});
onUnmounted(() => {
  clearInterval(timer);
});

const stale = computed(() => payload.value && clock.value - Date.parse(payload.value.generatedAt) > 30_000);
const selectedAccounts = computed(() => (payload.value?.accounts ?? []).filter((account) => !accountFilter.value || account.accountId === accountFilter.value));
const activityKinds = computed(() => [...new Set((payload.value?.activities ?? []).map((activity) => activity.kind))].sort());
const filteredActivities = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  return (payload.value?.activities ?? []).filter((activity) => {
    if (accountFilter.value && activity.accountId !== accountFilter.value) return false;
    if (kindFilter.value && activity.kind !== kindFilter.value) return false;
    if (outcomeFilter.value && activity.outcome !== outcomeFilter.value) return false;
    return (
      !keyword ||
      [activity.accountId, activity.kind, activity.source, activity.title, activity.postId, activity.errorCode].join(" ").toLowerCase().includes(keyword)
    );
  });
});
const filteredChannels = computed(() =>
  (payload.value?.conversations?.channels ?? []).filter((channel) => !accountFilter.value || channel.selfId === accountFilter.value),
);
const activityEmptyLabel = computed(() => {
  if (!selectedAccounts.value.length) return "尚无可展示的账号活动数据。";
  if (selectedAccounts.value.some((account) => account.stateStatus !== "ready" || account.activityStatus === "partial"))
    return "可读部分暂无活动记录，仍有数据不可读，不能判定为零活动。";
  if (payload.value?.activities.length) return "当前筛选条件下没有活动记录。";
  if (selectedAccounts.value.some((account) => account.activityStatus === "legacy")) return "尚无活动流水：部分状态为旧版格式，未记录浏览活动。";
  return "尚无活动记录；本页只展示已持久化的活动，不会主动触发浏览。";
});

function formatDate(value: number | string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "时间不可读";
}

function listLabel(value: string[] | null, empty = "未设置（空数组）"): string {
  return value === null ? "配置未提供（不推测默认值）" : value.length ? value.join("、") : empty;
}

function quotaLabel(account: XiaoheiheAccountView, kind: "post" | "interaction"): string {
  if (!account.quota) return "未知（状态不可读）";
  const used = kind === "post" ? account.quota.postsUsed : account.quota.interactionsUsed;
  const limit = kind === "post" ? account.config.dailyPostLimit : account.config.dailyInteractionLimit;
  const remaining = kind === "post" ? account.quota.postsRemaining : account.quota.interactionsRemaining;
  return `已用 ${used} / ${limit ?? "上限未知"} · 剩余 ${remaining ?? "未知"}`;
}

function connectionLabel(value: XiaoheiheAccountView["connection"]): string {
  return {
    online: "已连接",
    connecting: "连接中",
    offline: "未连接 / 连接未成功",
    failed: "连接失败",
    disabled: "适配器已禁用",
    unknown: "仅发现历史状态，连接未知",
  }[value];
}

function stateLabel(value: XiaoheiheAccountView["stateStatus"]): string {
  return {
    ready: "状态可读",
    missing: "尚无状态文件",
    invalid: "状态格式损坏或账号不匹配",
    unreadable: "状态读取失败",
    unsafe: "状态路径不安全，已拒绝读取",
    too_large: "状态文件超过 2 MiB，已拒绝读取",
  }[value];
}

function issueLabel(value: string): string {
  const labels: Record<string, string> = {
    invalid_account_id: "存在非法账号 ID，已跳过",
    duplicate_account_config: "存在重复账号配置",
    unsafe_state_path: "状态目录包含不安全路径",
    state_directory_unreadable: "账号状态目录不可读",
    conversation_index_unavailable: "会话索引不可读",
  };
  return labels[value] ?? "数据读取异常";
}

function kindLabel(value: string): string {
  const labels: Record<string, string> = {
    connect: "连接账号",
    finish: "静默结束",
    send: "发布尝试",
    login: "身份检查",
    feed: "浏览首页",
    browse: "浏览",
    profile: "读取个人主页",
    search: "搜索",
    read_post: "读取帖子",
    post_detail: "读取帖子",
    visit_post: "访问帖子",
    visit: "访问帖子",
    watch: "跟进帖子",
    thread: "帖子会话",
    post: "发布帖子",
    publish: "发布帖子",
    comment: "评论",
    reply: "回复",
    pause: "暂停",
    resume: "恢复",
  };
  const label = labels[value];
  return typeof label === "string" ? label : value;
}

function outcomeLabel(value: XiaoheiheActivity["outcome"]): string {
  return { ok: "完成", failed: "失败", blocked: "已阻止" }[value];
}

function postUrl(postId?: string): string | undefined {
  return postId && /^[A-Za-z0-9_-]{1,80}$/.test(postId) ? `https://www.xiaoheihe.cn/app/bbs/link/${encodeURIComponent(postId)}` : undefined;
}

function sessionPath(channel: string, session: string): string {
  return `/yesimbot/channels/${encodeURIComponent(channel)}/sessions/${encodeURIComponent(session)}`;
}
</script>

<style lang="scss" scoped>
.yib-xiaoheihe__body {
  box-sizing: border-box;
  height: 100%;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  overflow: auto;
  color: var(--k-text-dark, #1c1f23);
}

.yib-page-head,
.yib-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

h1 {
  margin: 4px 0 6px;
  font-size: 24px;
}
h2 {
  margin: 0;
  font-size: 16px;
}
h3 {
  margin: 0;
  font-size: 14px;
}
p {
  margin: 8px 0;
  line-height: 1.6;
}
.yib-page-head > div > p:not(.yib-eyebrow),
.yib-muted,
time {
  color: var(--k-text-normal, #666);
  font-size: 12px;
}
.yib-eyebrow {
  margin: 0;
  color: var(--k-color-primary, #409eff);
  font-size: 12px;
  font-weight: 700;
}
.yib-account-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr));
  gap: 14px;
}
.yib-card {
  min-width: 0;
  padding: 18px;
  border: 1px solid var(--k-color-divider);
  border-radius: 8px;
}
.yib-notice {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  border: 1px solid var(--k-color-divider);
  border-radius: 8px;
  font-size: 13px;
}
.yib-warning,
.is-warning {
  color: var(--k-color-warning, #e6a23c);
}
.is-success {
  color: var(--k-color-success, #67c23a);
}
.yib-badge {
  display: inline-block;
  font-size: 12px;
  font-weight: 600;
}
code {
  margin-left: 6px;
  overflow-wrap: anywhere;
}
.yib-status-list {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 10px 12px;
  font-size: 13px;
  line-height: 1.6;
}
.yib-status-list dt {
  color: var(--k-text-normal, #666);
}
.yib-status-list dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.yib-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin: 16px 0;
}
.yib-toolbar label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
select,
input {
  box-sizing: border-box;
  min-height: 36px;
  max-width: 100%;
  border: 1px solid var(--k-color-divider);
  border-radius: 6px;
  background: var(--k-card-bg);
  color: var(--k-text-dark, #1c1f23);
  padding: 6px 10px;
  font: inherit;
}
.yib-search-box {
  flex: 1 1 260px;
}
.yib-search-box input {
  width: 100%;
  min-width: 0;
}
.yib-table-scroll {
  overflow-x: auto;
}
.yib-activity-table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  font-size: 13px;
}
.yib-activity-table th,
.yib-activity-table td {
  padding: 12px 10px;
  border-bottom: 1px solid var(--k-color-divider);
  vertical-align: top;
  min-width: 90px;
  max-width: 360px;
  overflow-wrap: anywhere;
}
.yib-activity-table th {
  color: var(--k-text-normal, #666);
  font-size: 12px;
}
.yib-activity-table small,
.yib-activity-table td > a,
.yib-activity-table td > code {
  display: block;
  margin: 5px 0 0;
}
.yib-activity-table small {
  color: var(--k-text-normal, #666);
}
a {
  color: var(--k-color-primary, #409eff);
}
.yib-empty-state {
  padding: 24px;
  border: 1px dashed var(--k-color-divider);
  border-radius: 8px;
  color: var(--k-text-normal, #666);
  font-size: 13px;
}
.yib-conversation {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--k-color-divider);
  overflow-wrap: anywhere;
}
.yib-session-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px;
  border-radius: 6px;
  text-decoration: none;
  font-size: 13px;
}
.yib-session-item:hover {
  background: var(--k-hover-bg);
}
.yib-session-item span:first-child {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

@media screen and (max-width: 640px) {
  .yib-xiaoheihe__body {
    padding: 12px;
  }
  .yib-card {
    padding: 14px;
  }
  .yib-status-list {
    grid-template-columns: 90px minmax(0, 1fr);
  }
  .yib-toolbar {
    align-items: stretch;
    flex-direction: column;
  }
  .yib-toolbar label {
    justify-content: space-between;
  }
  .yib-search-box {
    flex-basis: auto;
  }
}
</style>
