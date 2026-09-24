# Image Edit Transport Contract

## 1. Scope / Trigger

This contract applies to `plugins/image-tools/src/image-edit.ts` when the configured image endpoint is the deployed SSH2 `gpt-image-2` route (`NewAPI -> CLIProxyAPI`). It records the JSON boundary that was previously missing and caused production HTTP 400 responses.

This is a provider/endpoint-specific contract, not a claim that every OpenAI-compatible image editor uses the same wire format. A different provider or a standard multipart endpoint requires an explicit transport design and tests.

## 2. Signatures

The internal editor seam remains:

```ts
type ImageEditor = (options: {
  sourceDataUrl: string;
  prompt: string;
  abortSignal: AbortSignal;
}) => Promise<{
  images: readonly { uint8Array: Uint8Array }[];
  totalImages?: number;
}>;
```

The default editor posts to `${baseURL}/images/edits` with JSON and bearer authentication.

## 3. Contracts

For the SSH2 `gpt-image-2` route, the request body must contain:

```json
{
  "model": "<configured model>",
  "prompt": "<trimmed prompt>",
  "images": [
    { "image_url": "data:image/<supported-type>;base64,<pixels>" }
  ],
  "n": 1,
  "response_format": "b64_json"
}
```

The source URI must not be sent as a durable identifier or arbitrary remote URL. `image-edit.ts` resolves and validates the current-channel resource first, then creates the transient data URL. The response must contain a non-empty `data` array whose first item has `b64_json` or a supported data-image URL; output bytes are validated again before artifact persistence.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| JSON body uses singular `image` instead of `images` | Treat as a contract bug; regression must fail with the production-shaped `missing required parameter images` response. |
| `images` is missing or empty | Do not call the model in tests; map the provider response to bounded `provider_error`. |
| HTTP 429 or 5xx | Map to retryable `provider_error`. |
| Other non-2xx response | Map to non-retryable `provider_error`, unless content refusal is detectable. |
| Response has no image data | Map to `empty_result`. |
| Returned bytes are not supported image bytes | Map to `invalid_image`; do not write an artifact. |
| Source URI is not current-channel `asset://`/`artifact://` | Reject before transport. |

Never include API keys, authorization headers, data URLs, full prompts, or raw provider bodies in the tool result or logs.

## 5. Good / Base / Bad Cases

- **Good**: Resolve `asset://...`, validate pixels, send `images: [{ image_url: dataUrl }]`, parse `b64_json`, validate output, and save a new `artifact://edit_image/...`.
- **Base**: Use the configured model and endpoint with one image, preserving timeout, abort, shared budget, projection, and bounded errors.
- **Bad**: Copy the standard multipart/singular-`image` shape into this JSON route without checking the active upstream. The gateway rejects it before model execution with HTTP 400.

## 6. Tests Required

`plugins/image-tools/tests/image-edit.test.ts` must assert:

1. A fixture that returns `400 invalid_request_error / missing required parameter images` when `images` is absent; the old body must fail this test.
2. The successful request contains `images[0].image_url` with the transient data URL and does not contain the old singular `image` field.
3. Source URI is not serialized into the request body, and API keys/prompts/data URLs are not serialized into the durable tool result.
4. Existing output validation, timeout, abort, artifact persistence, and shared budget tests remain green.

## 7. Wrong vs Correct

### Wrong

```ts
body: JSON.stringify({
  model,
  prompt,
  image: { url: sourceDataUrl },
  n: 1,
  response_format: "b64_json",
});
```

### Correct

```ts
body: JSON.stringify({
  model,
  prompt,
  images: [{ image_url: sourceDataUrl }],
  n: 1,
  response_format: "b64_json",
});
```

The plural `images` field and `image_url` member are part of the active `gpt-image-2` JSON route contract; do not replace them based on a generic OpenAI multipart example.
