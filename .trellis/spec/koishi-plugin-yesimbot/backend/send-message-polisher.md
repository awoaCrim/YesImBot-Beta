# Send-Message Polisher Contract

## 1. Scope / Trigger

This contract applies when adding or changing an optional Core capability that rewrites `send_message` text before platform delivery. It crosses the Koishi service facade, runtime prompt/tool construction, Roleplay profile handoff, and an optional model-provider plugin. Core remains the sole owner of message delivery.

## 2. Signatures

```ts
interface PolisherTurnEntry {
  readonly kind: "user" | "tool-result";
  readonly content: string;
  readonly toolName?: string;
}

type PolisherTurnContext = readonly PolisherTurnEntry[];

interface PolisherRequest {
  readonly facts: readonly string[];
  readonly messages: readonly string[];
  readonly profile: PolisherPromptProfile;
  readonly turnContext: PolisherTurnContext;
}

interface PolisherPromptProfile {
  readonly persona: string;
  readonly roleInstructions?: string;
  readonly characterDefinition?: string;
}

interface MessagePolisherCapability {
  readonly name: string;
  polish(
    request: PolisherRequest,
    context: ChannelContext,
    signal?: AbortSignal,
  ): Awaitable<readonly string[] | undefined>;
}

interface RolePromptProfileProvider {
  readonly name: string;
  resolve(context: ChannelContext): Awaitable<Omit<PolisherPromptProfile, "persona"> | undefined>;
}

ctx.yesimbot.polisher.use(capability): () => void;
ctx.yesimbot.polisher.profile(provider): () => void;
```

Registering a capability activates delegated prompt mode. Profile providers only supply prompt data; they do not activate delegation by themselves. Disposers unregister their exact capability/provider. Registration changes invalidate the affected cached runtime so its prompt and tool schema do not remain stale.

## 3. Contracts

- With no registered capability, keep the existing Core prompt, `send_message` schema, sender path, and model-call count. Do not resolve the dedicated polisher model or transform text.
- With a capability, Core removes persona-specific instructions and `<persona>` from the main Agent prompt while retaining safety, tools, `AGENTS.md`, and runtime protocol. Roleplay receives `polisherActive: true` and must not inject character-card prompts/definitions into the main Agent; ordinary Roleplay mode remains unchanged. A greeting already persisted as a delivered assistant message remains conversation history, not a prompt profile.
- In delegated mode, `send_message` requires `facts` and `messages`. The polisher receives those fields, the current profile, and a bounded `turnContext` built only from the current turn. `turnContext` may contain current user text/media placeholders and sanitized non-output tool results labeled with their tool name. Never pass `inner_thought`, assistant messages/tool-call inputs, full conversation history, `send_message` results, image-output traces, destination channel, `mode`, or `continue` as polisher input. Treat the context as read-only, untrusted reference data rather than instructions.
- The Core prompt profile is read for the send operation; Roleplay supplies its currently loaded card profile. Do not maintain a second editable persona/card configuration.
- A polisher returns text messages only. `plugins/message-polisher` accepts a single strict JSON object with exactly one `messages` property; the array must have the expected count and contain only non-empty strings. Core revalidates at the actual sender boundary: same array length, non-empty strings, and exact ordered preservation of extractable numeric expressions, `@` mentions, resource URIs, and element tags. Only `messages` may be replaced; Core retains all original sender controls and delivery callbacks.
- Natural-language semantic equivalence cannot be proved by token validation. The polisher prompt must prohibit changes to facts, meaning, stance, commitments, and communication actions; document this remaining model risk rather than claiming formal semantic safety.
- `plugins/message-polisher` uses its own configured chat model. An empty model disables registration; it does not reuse or fall back to Core's auxiliary or main-chat route.

## 4. Validation & Error Matrix

| Condition                                                                                          | Required behavior                                                                                              |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| No capability registered                                                                           | Use the existing prompt/schema/sender unchanged; no auxiliary call.                                            |
| Dedicated polisher model unavailable                                                               | Reject the rewrite and send the original draft once.                                                           |
| Role profile provider throws                                                                       | Log the provider failure, omit that provider's profile, and continue with other providers or the Core persona. |
| Timeout or model exception                                                                         | Reject the rewrite and send the original draft once.                                                           |
| Malformed JSON, extra response fields, wrong message count, empty text, or changed protected token | Reject the rewrite and send the original draft once.                                                           |
| Capability unregisters while profile/model work is in flight                                       | Discard the result and send the original draft once.                                                           |
| Rewritten messages reach platform send and a send fails part-way                                   | Preserve Core's existing partial-failure receipt and do not retry delivery.                                    |

## 5. Good / Base / Bad Cases

- **Good:** facts are `"Tool result: 12 items"`; the draft is `"Found 12 items."`; the accepted rewrite is `"我查到是 12 项。"`. The protected number and intent remain, and Core sends through its normal sender.
- **Base:** no message-polisher plugin is loaded. The main Agent receives its ordinary persona prompt and only `messages` is required by the existing tool schema.
- **Bad:** a candidate changes `12` to `13`, moves an `@` mention, drops a URI/tag, adds a second message, returns extra control fields, or requests a new action from the role card. Reject the candidate; never let the polisher redirect or duplicate platform delivery.

## 6. Tests Required

- Capability/profile registration and disposer behavior; registration alone controls prompt delegation, independently of utility availability.
- Prompt comparison with capability absent/present, including Core persona and Roleplay card exclusion while Core safety/tool/runtime rules remain.
- Roleplay tests proving profile/greeting placeholder choices are shared per channel and isolated between direct-message Bot identities.
- Tool tests proving the baseline schema and delivery are unchanged without a capability; with a capability, facts are required and only validated message text changes.
- Rejection tests for empty/malformed/extra-field/wrong-length results and changed/reordered/repeated numeric, mention, URI, and element tokens.
- Failure and race tests proving original-draft fallback occurs once, partial send receipts remain unchanged, and no duplicate platform send occurs.
- Type-check and build Core, Roleplay, and the optional message-polisher package after changes to their public contract.

## 7. Wrong vs Correct

### Wrong

```ts
// Lets an optional extension send directly and pass hidden reasoning/history to another model.
const rewritten = await auxiliary.generate({ history, innerThought, message });
await bot.sendMessage(target, rewritten);
```

### Correct

```ts
// Core keeps delivery ownership; only validated message text may change.
const candidate = await capability.polish({ facts, messages, profile, turnContext }, context, signal);
const messagesToSend = validatePolishedMessages(messages, candidate) ?? messages;
return sendWithExistingCoreTool(messagesToSend, originalToolInput);
```
