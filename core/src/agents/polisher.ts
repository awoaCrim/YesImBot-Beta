import type { Awaitable, Logger } from "koishi";

import type { ChannelContext } from "../channels/index.js";

// Structural element tags, resource URIs, @ mentions, and numeric expressions must survive a
// rewrite exactly. This is a conservative token check, not a proof of semantic equivalence.
const PROTECTED_TOKEN_PATTERN =
  /<\/?[a-z][a-z0-9-]*\b[^<>]*>|[a-z][a-z0-9+.-]*:\/\/[^\s<>"'()[\]{}，。！？；：、]+|@[\p{L}\p{N}\p{M}_.-]+|[+\-−]?\d+(?:[.,，．/／]\d+)*(?:[%％])?/giu;

/** The complete bounded current-turn reference passed to the independent polisher. */
export type PolisherTurnContext = readonly PolisherTurnEntry[];

type Disposer = () => void;

type RevisionListener = (revision: number) => void;

/**
 * Role/expression material handed to an active send-message polisher. It is the same live
 * `PERSONA.md` and character-card content the main Agent would otherwise receive, so the polisher
 * never needs a second editable style configuration.
 */
export interface PolisherPromptProfile {
  /** Current `PERSONA.md` content, or Core's default persona when the file is absent. */
  readonly persona: string;
  /** Character-card instructions/examples, when a role provider supplies them. */
  readonly roleInstructions?: string;
  /** Character-card definition (name/description/personality/scenario), when supplied. */
  readonly characterDefinition?: string;
}

/** A bounded, read-only reference entry from the current turn. It is never historical context. */
export interface PolisherTurnEntry {
  readonly kind: "user" | "tool-result";
  readonly content: string;
  readonly toolName?: string;
}

/** Explicit facts, current-turn reference data, and the main Agent's draft. */
export interface PolisherRequest {
  readonly facts: readonly string[];
  readonly messages: readonly string[];
  readonly profile: PolisherPromptProfile;
  readonly turnContext: PolisherTurnContext;
}

/**
 * Optional pre-send rewrite capability. Core keeps the delivery path: a polisher only returns
 * replacement `messages` strings, and only after Core's own validation passes.
 */
export interface MessagePolisherCapability {
  readonly name: string;
  polish(request: PolisherRequest, context: ChannelContext, signal?: AbortSignal): Awaitable<readonly string[] | undefined>;
}

/** Supplies the current role/character prompt without injecting it into the main Agent. */
export interface RolePromptProfileProvider {
  readonly name: string;
  resolve(context: ChannelContext): Awaitable<Omit<PolisherPromptProfile, "persona"> | undefined>;
}

export interface PolisherRegistryOptions {
  readonly logger?: Logger;
}

/**
 * Core-owned capability registry. "Polisher active" means a registered capability reports itself
 * registered for the channel; auxiliary model availability is checked only when rewriting.
 */
export class PolisherRegistry {
  private readonly capabilities = new Set<MessagePolisherCapability>();
  private readonly providers = new Set<RolePromptProfileProvider>();
  private readonly revisionListeners = new Set<RevisionListener>();
  private readonly logger: Logger | undefined;
  private revisionValue = 0;

  public constructor(options: PolisherRegistryOptions = {}) {
    this.logger = options.logger;
  }

  public get revision(): number {
    return this.revisionValue;
  }

  public use(capability: MessagePolisherCapability): Disposer {
    if (!this.capabilities.has(capability)) {
      this.capabilities.add(capability);
      this.bumpRevision();
    }
    return () => {
      if (this.capabilities.delete(capability)) this.bumpRevision();
    };
  }

  public profile(provider: RolePromptProfileProvider): Disposer {
    if (!this.providers.has(provider)) {
      this.providers.add(provider);
      this.bumpRevision();
    }
    return () => {
      if (this.providers.delete(provider)) this.bumpRevision();
    };
  }

  public onRevision(listener: RevisionListener): Disposer {
    this.revisionListeners.add(listener);
    return () => {
      this.revisionListeners.delete(listener);
    };
  }

  /** Registration alone activates delegated mode; model failures cannot switch persona routing. */
  public resolve(): MessagePolisherCapability | undefined {
    return this.capabilities.values().next().value;
  }

  public async resolveProfile(context: ChannelContext): Promise<Omit<PolisherPromptProfile, "persona"> | undefined> {
    for (const provider of this.providers) {
      try {
        const profile = await provider.resolve(context);
        if (profile && (profile.roleInstructions || profile.characterDefinition)) return profile;
      } catch (cause) {
        this.logger?.warn("yesimbot.polisher.profile_failed", { name: provider.name, cause });
      }
    }
    return undefined;
  }

  private bumpRevision(): void {
    this.revisionValue += 1;
    for (const listener of this.revisionListeners) {
      try {
        listener(this.revisionValue);
      } catch {}
    }
  }
}

export function extractProtectedTokens(text: string): string[] {
  return text.match(PROTECTED_TOKEN_PATTERN) ?? [];
}

/**
 * Accepts a polisher result only when it is a same-length array of non-empty strings whose
 * protected tokens match the draft exactly. Any deviation returns undefined, which makes the
 * caller send the original draft once.
 */
export function validatePolishedMessages(original: readonly string[], candidate: unknown): string[] | undefined {
  if (!Array.isArray(candidate) || candidate.length !== original.length || original.length === 0) return undefined;

  const result: string[] = [];
  for (const [index, value] of candidate.entries()) {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    if (!hasSameProtectedTokens(original[index]!, value)) return undefined;
    result.push(value);
  }
  return result;
}

/** Resolves the active capability and current prompt profile; validation belongs to the sender. */
export function createSendMessagePolisher(input: {
  readonly registry: PolisherRegistry;
  readonly resolveProfile: () => Promise<PolisherPromptProfile>;
  readonly context: ChannelContext;
}): (request: {
  readonly facts: readonly string[];
  readonly messages: readonly string[];
  readonly turnContext: PolisherTurnContext;
  readonly signal?: AbortSignal;
}) => Promise<readonly string[] | undefined> {
  return async ({ facts, messages, turnContext, signal }) => {
    const revision = input.registry.revision;
    const polisher = input.registry.resolve();
    if (!polisher) return undefined;

    const profile = await input.resolveProfile();
    if (input.registry.revision !== revision || input.registry.resolve() !== polisher) return undefined;

    const result = await polisher.polish({ facts, messages, profile, turnContext }, input.context, signal);
    return input.registry.revision === revision && input.registry.resolve() === polisher ? result : undefined;
  };
}

function hasSameProtectedTokens(original: string, candidate: string): boolean {
  const before = extractProtectedTokens(original);
  const after = extractProtectedTokens(candidate);
  if (before.length !== after.length) return false;
  return before.every((token, index) => token === after[index]);
}

export { buildPolisherTurnContext } from "./polisher-context.js";
