import { Context, Schema } from "koishi";

import * as anthropic from "./anthropic.js";
import * as deepseek from "./deepseek.js";
import * as google from "./google.js";
import * as openai from "./openai.js";

export const name = "yesimbot-model-provider";

export const usage = "统一模型接入；每个克隆实例配置一个独立连接，保留所选协议的原生能力。";

export const inject = ["yesimbot"];

export const reusable = true;

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    type: Schema.union([
      Schema.const("openai").description("OpenAI / OpenAI-compatible"),
      Schema.const("anthropic").description("Anthropic"),
      Schema.const("google").description("Google"),
      Schema.const("deepseek").description("DeepSeek"),
    ])
      .default("openai")
      .description("API 协议；与提供商标识独立，同一协议可克隆配置多个连接"),
  }).description("协议选择"),
  Schema.union([
    Schema.intersect([Schema.object({ type: Schema.const("openai").default("openai") }), openai.Config]),
    Schema.intersect([Schema.object({ type: Schema.const("anthropic").required() }), anthropic.Config]),
    Schema.intersect([Schema.object({ type: Schema.const("google").required() }), google.Config]),
    Schema.intersect([Schema.object({ type: Schema.const("deepseek").required() }), deepseek.Config]),
  ]).description("连接与模型"),
]);

export type Config =
  | ({ type: "openai" } & openai.Config)
  | ({ type: "anthropic" } & anthropic.Config)
  | ({ type: "google" } & google.Config)
  | ({ type: "deepseek" } & deepseek.Config);

export function apply(ctx: Context, config: Config) {
  switch (config.type) {
    case "openai":
      return openai.apply(ctx, config);
    case "anthropic":
      return anthropic.apply(ctx, config);
    case "google":
      return google.apply(ctx, config);
    case "deepseek":
      return deepseek.apply(ctx, config);
  }
}
