import { resolve } from "node:path";

import type { CharacterCardV3 } from "@risuai/ccardlib";
import type { AgentPlugin } from "@yesimbot/agent-runtime";
import { Context, Logger, Schema, type Bot } from "koishi";
import type { ChannelContext, ChannelPluginSetupContext, MainAgentRoleProfile, MainAgentRoleProvider } from "koishi-plugin-yesimbot";

import { loadCharacterCard } from "./card.js";
import type { CBSContext } from "./cbs.js";
import { selectGreeting } from "./greeting.js";
import { assembleRoleProfile } from "./prompt.js";
import { createRoleplayPlugin } from "./roleplay.js";

export interface RoleplayPluginConfig {
  characterCard: string;
  useRandomGreeting?: boolean;
  enableGreeting?: boolean;
}

export default class RoleplayPlugin {
  public static readonly name = "yesimbot-roleplay";
  public static readonly usage = "从 PNG 角色卡加载角色扮演提示词。";
  public static readonly inject = ["yesimbot"];
  public static readonly Config: Schema<RoleplayPluginConfig> = Schema.object({
    characterCard: Schema.path({ filters: ["file"] }).description("PNG 角色卡文件路径"),
    useRandomGreeting: Schema.boolean().default(false).description("随机选择角色卡开场白"),
    enableGreeting: Schema.boolean().default(true).description("新建空会话时注入角色卡开场白"),
  });

  public readonly ctx: Context;
  public readonly config: RoleplayPluginConfig;
  public readonly logger: Logger;
  public readonly name = RoleplayPlugin.name;
  public readonly roleProfile: MainAgentRoleProvider = { resolve: (scope) => this.resolve(scope) };

  private loadGeneration = 0;
  private card?: CharacterCardV3;
  private greeting?: string;
  private disposeAgentPlugin: (() => void) | undefined;
  private readonly promptContexts = new Map<string, CBSContext>();
  private readonly promptProfiles = new Map<string, MainAgentRoleProfile>();

  public constructor(ctx: Context, config: RoleplayPluginConfig) {
    this.ctx = ctx;
    this.config = config;
    this.logger = ctx.logger("yesimbot.roleplay");
    ctx.on("ready", this.start.bind(this));
    ctx.on("dispose", this.stop.bind(this));
  }

  public async start(): Promise<void> {
    const generation = ++this.loadGeneration;
    this.disposeAgentPlugin?.();
    this.disposeAgentPlugin = undefined;

    const card = await loadCharacterCard(resolve(this.ctx.baseDir, this.config.characterCard));
    if (generation !== this.loadGeneration) return;
    const greeting = selectGreeting(card, this.config.useRandomGreeting ?? false);
    this.card = card;
    this.greeting = greeting;
    this.promptContexts.clear();
    this.promptProfiles.clear();
    this.disposeAgentPlugin = this.ctx.yesimbot.agent.use(this);
  }

  /** Card resolution for the main Agent; Core places it once in its continuous role section. */
  public resolve(scope: ChannelContext): MainAgentRoleProfile | undefined {
    const card = this.card;
    if (!card) return undefined;
    const key = roleplayContextKey(scope);
    const cached = this.promptProfiles.get(key);
    if (cached) return cached;

    // Preserve per-channel random/roll choices across setup retries and runtime replacements.
    const profile = assembleRoleProfile(card, this.promptContext(scope));
    this.promptProfiles.set(key, profile);
    return profile;
  }

  public setup(scope: ChannelContext, _bot: Bot, runtime?: ChannelPluginSetupContext): AgentPlugin {
    if (!this.card || this.greeting === undefined) throw new Error("Roleplay plugin has not been started");
    return createRoleplayPlugin({
      card: this.card,
      greeting: scope.type === "direct" && this.config.enableGreeting !== false ? this.greeting : "",
      userName: scope.type === "direct" ? scope.channelId : "User",
      context: this.promptContext(scope),
      managedPrompts: runtime?.rolePromptsManaged === true,
    });
  }

  public async stop(): Promise<void> {
    this.loadGeneration += 1;
    this.disposeAgentPlugin?.();
    this.disposeAgentPlugin = undefined;
    this.promptContexts.clear();
    this.promptProfiles.clear();
  }

  private promptContext(scope: ChannelContext): CBSContext {
    const card = this.card;
    if (!card) throw new Error("Roleplay plugin has not been started");

    const key = roleplayContextKey(scope);
    let context = this.promptContexts.get(key);
    if (!context) {
      context = {
        charName: card.data.nickname ?? card.data.name,
        pickCache: new Map<string, string>(),
        userName: scope.type === "direct" ? scope.channelId : "User",
      };
      this.promptContexts.set(key, context);
    }
    return context;
  }
}

function roleplayContextKey(scope: ChannelContext): string {
  return JSON.stringify([scope.platform, scope.type, scope.channelId, scope.type === "direct" ? scope.selfId : scope.guildId]);
}
