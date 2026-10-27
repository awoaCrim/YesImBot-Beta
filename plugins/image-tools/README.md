# koishi-plugin-yesimbot-image-tools

OpenAI-compatible image generation and editing tools for YesImBot.

## Configuration

The console groups settings as enable/connection, models, and request limits. These are display sections only: existing keys remain flat, with no migration or new wrapper objects.

| Key         | Default / requirement                        | Applies to                                                                                                                                                                                                                                         |
| ----------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`   | `true`                                       | Register generation and editing tools; does not enable/disable the separate search service.                                                                                                                                                        |
| `apiKey`    | Required by the schema                       | Shared credentials for text generation, reference generation, and editing.                                                                                                                                                                         |
| `baseURL`   | Unset: SDK default                           | Shared Images API root, not an individual `/images/...` URL. Reference generation/editing require the supported JSON `images` protocol; the default address does not guarantee that compatibility.                                                 |
| `model`     | No default; required at startup when enabled | Text-only generation and the fallback model for reference generation/editing.                                                                                                                                                                      |
| `editModel` | Unset/blank: use `model`                     | Both reference-backed generation and image editing, using `/images/edits`.                                                                                                                                                                         |
| `timeout`   | `120` seconds; range `1–600`                 | Generation requests including their reference reads, and edit provider requests. It does not control search, public-reference downloads, artifact writes, or Core vision inspection. Existing edit-source reads retain the Core resource deadline. |

A single model serving all image operations only needs:

```yaml
apiKey: "<image-api-key>"
baseURL: "https://images.example/v1"
model: "shared-image-model"
timeout: 120
```

Only set `editModel` when reference generation/editing need a different model. All operations still use the same `apiKey` and `baseURL`; this is not a second provider connection.

`subjectType`, `referenceUris`, `prompt`, and `orientation` are per-call tool arguments, not plugin settings. Output quota, input-reference count/byte/pixel bounds, source safety, and orientation mismatch reporting remain fixed behavior rather than extra configuration switches.

## Tools

- `generate_image`: create a new image from text and, for specific subjects, explicit reference pixels; save it as an immutable `artifact://` resource.
- `edit_image`: edit an existing current-channel `asset://` or `artifact://` image and save the result as a new artifact.

## Edit a user-uploaded image

Images received during a live Koishi `Session` are persisted as current-channel `asset://<32-hex-id>` resources. The model sees the URI in the message representation as `[图片：asset://...]`.

When a user asks to modify the attached image, call `edit_image` with that complete `asset://` URI and the requested change. The original upload remains unchanged; the tool creates a new `artifact://edit_image/<uuid>` result. Send the returned image through the existing `send_message` tool.

The editor accepts only current-channel `asset://` and `artifact://` sources. Arbitrary remote URLs, workspace paths, cross-channel resources, and read-only `artifact://sticker/...` projections are rejected.

## Generation and references

`generate_image` requires `prompt` and `subjectType` (`generic` or `specific`), and supports optional `orientation` (`square`, `landscape`, or `portrait`; default `square`).

Use `specific` for an identifiable person, named character, product/model, or particular object whose appearance must be preserved. It requires `referenceUris`: one to four inspected current-channel `asset://` or `artifact://` images, within the aggregate resource byte limit. Missing or invalid references stop the request; there is no text-only fallback. Do not label a specific subject `generic` to bypass this check. Generic scenes without a particular identity can still use text-only generation.

Prefer a suitable existing channel image. For public subjects without one, use the configured search-service image search and `import_image_reference`, then inspect the source context and actual image content before passing its returned artifact URI. For private/custom subjects or unreliable public matches, request an image or clarification. Search or visual-inspection unavailability is not permission to guess.

```json
{
  "prompt": "The same character taking a selfie in a new outfit; preserve the reference hair length and facial features",
  "subjectType": "specific",
  "referenceUris": ["asset://0123456789abcdef0123456789abcdef"],
  "orientation": "portrait"
}
```

Stable identity features must be preserved; clothing, pose, and background may change as requested. No automatic persona-image injection is used.

Reference-backed generation sends resolved image pixels through the active JSON `/images/edits` route using `editModel` (or `model` if unset), while generic text-only generation keeps `/images/generations` and `model`. Both create `artifact://generate_image/...`. The reference route uses `images: [{ "image_url": "data:..." }]`, not standard OpenAI multipart; other endpoint contracts are not automatically supported. A provider rejection never retries without references.

## Results and orientation

Each output image reports `width`, `height`, and actual `orientation`. Generation also returns `requestedOrientation`, `orientationMatches`, and `referenceInput: { includedInRequest, uris }`. Reference inclusion records the request input, not proof of identity fidelity or that the provider followed the reference.

If the requested direction does not match the returned pixels, generation still returns its artifact with `ok: true`, `orientationMatches: false`, and an explicit warning. Inspect and either regenerate or explain the deviation before sending. No automatic crop, stretch, or retry is applied.

Both tools expose generated pixels for review but do not send messages; already projected pixels do not require an extra `read`. They share a three-generated-image-per-turn budget, validate PNG/JPEG/WebP headers and dimensions (up to 40 million pixels), and keep cancellation, timeout, and artifact persistence inside this plugin. Header validation does not guarantee complete decodability or visual correctness. Reference downloads do not consume the generated-output budget. Core resource-reading tools remain owned by YesImBot Core, while chat/embedding provider plugins remain responsible for model registration and image tool-result capabilities.

Image editing currently uses the configured OpenAI-compatible `/images/edits` endpoint.
