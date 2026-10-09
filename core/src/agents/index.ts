import type { AgentPlugin, EphemeralImageProjectionStore } from "@yesimbot/agent-runtime";
import type { Awaitable, Bot, Context, Logger, Session } from "koishi";

import type { ChannelContext } from "../channels/index.js";
import type { ImagePreviewCapability } from "./image-preview.js";
import { defaultWillEngine, type WillEngine, type WillPlugin } from "./will.js";

type Disposer = () => void;

/** Stable character material for the main Agent; independent of send-message polishing. */
export interface MainAgentRoleProfile {
  readonly characterDefinition?: string;
  readonly roleInstructions?: string;
}

export interface MainAgentRoleProvider {
  resolve(context: ChannelContext): Awaitable<MainAgentRoleProfile | undefined>;
}

export interface ChannelPluginSetupContext {
  readonly imageProjection: EphemeralImageProjectionStore;
  /**
   * Core-owned read-before-send seam: reuse of the active image capability without duplicating
   * provider credentials or the ephemeral byte-retention policy. Absent means the channel has no
   * working image route, so a plugin must not claim it displayed any content.
   */
  readonly imagePreview?: ImagePreviewCapability;
  /** True when an active polisher owns style rendering, so role prompts must not reach the main Agent. */
  readonly polisherActive: boolean;
  /** Core assembles this opted-in provider's role material in its frozen role section. */
  readonly rolePromptsManaged?: boolean;
}

export interface ChannelPlugin {
  readonly roleProfile?: MainAgentRoleProvider;
  setup(context: ChannelContext, bot: Bot, runtime?: ChannelPluginSetupContext): Awaitable<AgentPlugin | null>;
}

export class Agents {
  private readonly ctx: Context;
  private readonly logger: Logger;

  private readonly plugins = new Set<ChannelPlugin>();
  private readonly willPlugins = new Set<WillPlugin>();
  private revisionValue = 0;

  public constructor(ctx: Context, config: { logLevel?: number } = {}) {
    this.ctx = ctx;
    this.logger = ctx.logger("yesimbot.agents");
    this.logger.level = config.logLevel ?? 2;
  }

  public get revision(): number {
    return this.revisionValue;
  }

  public use(plugin: ChannelPlugin): Disposer {
    if (!this.plugins.has(plugin)) {
      this.plugins.add(plugin);
      this.revisionValue += 1;
    }
    return () => {
      if (this.plugins.delete(plugin)) this.revisionValue += 1;
    };
  }

  public will(plugin: WillPlugin): Disposer {
    if (!this.willPlugins.has(plugin)) {
      this.willPlugins.add(plugin);
      this.revisionValue += 1;
    }
    return () => {
      if (this.willPlugins.delete(plugin)) this.revisionValue += 1;
    };
  }

  /** Resolve before setup so shared placeholder choices also reach greetings. Never blend identities. */
  public async resolveRoleProfile(context: ChannelContext): Promise<MainAgentRoleProfile | undefined> {
    let selected: MainAgentRoleProfile | undefined;
    // Registration changes belong to the next snapshot, not the middle of an async resolution.
    for (const plugin of [...this.plugins]) {
      const profile = await plugin.roleProfile?.resolve(context);
      if (!profile?.characterDefinition?.trim() && !profile?.roleInstructions?.trim()) continue;
      if (selected) throw new Error("Multiple main-Agent role providers resolved non-empty profiles for this channel");
      selected = profile;
    }
    return selected;
  }

  public async setup(context: ChannelContext, bot: Bot, runtime?: ChannelPluginSetupContext): Promise<AgentPlugin[]> {
    const initialized: AgentPlugin[] = [];
    try {
      for (const plugin of [...this.plugins]) {
        const result = await plugin.setup(
          context,
          bot,
          runtime ? { ...runtime, rolePromptsManaged: runtime.rolePromptsManaged === true && plugin.roleProfile !== undefined } : undefined,
        );
        if (result) initialized.push(result);
      }
      return initialized;
    } catch (cause) {
      for (const plugin of initialized.reverse()) {
        try {
          await plugin.stop?.();
        } catch {}
      }
      throw cause;
    }
  }

  public async setupWill(context: ChannelContext, session?: Session): Promise<WillEngine> {
    const plugins = [...this.willPlugins].map((plugin, index) => ({ plugin, index }));
    plugins.sort((left, right) => left.plugin.priority - right.plugin.priority || left.index - right.index);
    this.logger.debug("agents.setup_will", {
      hasSession: session !== undefined,
      pluginCount: plugins.length,
      platform: context.platform,
      channelId: context.channelId,
    });
    for (const { plugin } of plugins) {
      if ((session && plugin.match(session)) || plugin.matchContext?.(context)) {
        const engine = await plugin.setup(context);
        this.logger.debug("agents.will_selected", { engine: engine.constructor?.name ?? "plugin", plugin: plugin.constructor?.name ?? "will-plugin" });
        return engine;
      }
    }
    this.logger.debug("agents.will_selected", { engine: "default" });
    return defaultWillEngine;
  }
}

export type { WillBatchDecision, WillDebug, WillEngine, WillPlugin, WillReservationOutcome, WillState } from "./will.js";

export {
  createSendMessagePolisher,
  extractProtectedTokens,
  PolisherRegistry,
  validatePolishedMessages,
  validateComposedMessages,
  MAX_COMPOSE_MESSAGES,
  MAX_COMPOSE_BYTES,
  type PolisherMode,
  type MessagePolisherCapability,
  type PolisherPromptProfile,
  type PolisherRequest,
  type PolisherTurnContext,
  type PolisherTurnEntry,
  type RolePromptProfileProvider,
} from "./polisher.js";

export {
  createImagePreviewCapability,
  type ImageDescribeRequest,
  type ImagePreviewCapability,
  type ImagePreviewFrame,
  type ImagePreviewRequest,
} from "./image-preview.js";
