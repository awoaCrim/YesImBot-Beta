import { Schema } from "koishi";

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    basePath: Schema.path({ filters: ["directory"], allowCreate: true })
      .default("data/yesimbot")
      .description("数据存储目录"),
    chatModel: Schema.dynamic("registry.chatModels").description("默认对话模型"),
    auxiliaryModel: Schema.dynamic("registry.chatModels").description("所有非主对话用途的辅助模型；缺失或不可用时辅助任务失败，不回退到主模型"),
    visionModel: Schema.dynamic("registry.chatModels").description("识图工具使用的独立模型；必须声明支持图片输入；留空则不注册 describe_image"),
    logLevel: Schema.union([
      Schema.const(0).description("None"),
      Schema.const(1).description("Error"),
      Schema.const(2).description("Info"),
      Schema.const(3).description("Debug"),
    ])
      .default(2)
      .description("日志级别") as Schema<number>,
    allowedChannels: Schema.array(
      Schema.object({
        platform: Schema.string().description("平台名称；* 匹配任意平台"),
        channelId: Schema.string().description("频道 ID；* 匹配任意频道"),
        isDirect: Schema.boolean().description("是否仅匹配私聊；留空则不限制"),
      }),
    )
      .role("table")
      .default([])
      .description("允许接收消息的频道；默认拒绝全部频道"),
  }).description("基础配置"),
  Schema.object({
    imageInput: Schema.boolean().default(true).description("允许支持图片输入的模型通过 read 工具读取图片"),
    modelRetries: Schema.number().min(0).max(5).default(3).description("主聊天模型遇到可重试 HTTP 429 时的最大重试次数"),
    resourceReadTimeout: Schema.number().min(1).default(30).description("资源读取超时时间（秒）"),
  }).description("模型输入与资源读取"),
  Schema.object({
    pacing: Schema.object({
      charactersPerSecond: Schema.number().min(1).default(8).description("send_message 相邻消息之间的发送速度（字符/秒）"),
      maxTotalDelayMs: Schema.number().min(1).default(60_000).description("单次 send_message 调用的最大累计延迟（毫秒）"),
    }).description("消息发送节奏"),
    customInnerThought: Schema.boolean().default(true).description("为 send_message 提供 inner_thought 字段，记录不发送的内心独白"),
  }),
  Schema.object({
    session: Schema.object({
      compact: Schema.object({
        responseIdleMinutes: finiteNumber(0).default(0).description("已弃用：不再使用响应空闲压缩；保留用于兼容旧配置"),
        checkIntervalMinutes: finiteNumber(1, 2_147_483_647 / 60_000)
          .default(30)
          .description("已弃用：仅兼容旧配置解析；自动压缩不再做周期检查"),
        turnThreshold: finiteInteger(1).default(50).description("已弃用：仅兼容旧配置解析；自动压缩不再按用户轮数触发"),
        minMessages: finiteNumber(1).default(15).description("手动/兼容压缩所需的最少消息数"),
        maxFailures: finiteNumber(1).default(3).description("自动压缩连续失败上限"),
        inlineFragments: finiteInteger(1).default(3).description("请求上下文中常驻的最近压缩片段数量；更旧的片段写入持久存储并按需召回"),
        model: Schema.dynamic("registry.chatModels").description("压缩模型；留空则使用默认对话模型"),
      }).description("自动压缩"),
      archive: Schema.object({
        maxKB: Schema.number()
          .min(0)
          .default(5 * 1024)
          .description("单个会话文件归档上限（KB）；0 = 禁用"),
      }).description("自动归档"),
    }).description("会话管理"),
  }),
]) as Schema<Config>;

export interface ChannelAllowRule {
  readonly platform: string;
  readonly channelId: string;
  readonly isDirect?: boolean;
}

export interface PacingConfig {
  charactersPerSecond: number;
  maxTotalDelayMs: number;
}

export interface SessionCompactConfig {
  responseIdleMinutes: number;
  checkIntervalMinutes: number;
  turnThreshold: number;
  minMessages: number;
  maxFailures: number;
  inlineFragments: number;
  model: string | undefined;
}

export interface SessionArchiveConfig {
  maxKB: number;
}

export interface SessionConfig {
  compact: SessionCompactConfig;
  archive: SessionArchiveConfig;
}

export interface Config {
  basePath: string;
  chatModel: string;
  auxiliaryModel: string | undefined;
  visionModel: string | undefined;
  logLevel: number;
  allowedChannels: ChannelAllowRule[];
  imageInput: boolean;
  modelRetries: number;
  resourceReadTimeout: number;
  pacing: PacingConfig;
  customInnerThought: boolean;
  session: SessionConfig;
}

function finiteNumber(minimum: number, maximum = Number.MAX_VALUE): Schema<number> {
  return Schema.transform(Schema.number().min(minimum).max(maximum), (value) => {
    if (!Number.isFinite(value)) throw new TypeError("expected a finite number");
    return value;
  });
}

function finiteInteger(minimum: number, maximum = Number.MAX_VALUE): Schema<number> {
  return Schema.transform(Schema.number().min(minimum).max(maximum), (value) => {
    if (!Number.isFinite(value) || !Number.isInteger(value)) throw new TypeError("expected a finite integer");
    return value;
  });
}
