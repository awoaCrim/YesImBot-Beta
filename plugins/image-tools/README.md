# koishi-plugin-yesimbot-image-tools

OpenAI-compatible image generation and editing tools for YesImBot.

## Tools

- `generate_image`: create a new image directly from a text prompt and save it as an immutable `artifact://` resource.
- `edit_image`: edit an existing current-channel `asset://` or `artifact://` image and save the result as a new artifact.

## Edit a user-uploaded image

Images received during a live Koishi `Session` are persisted as current-channel `asset://<32-hex-id>` resources. The model sees the URI in the message representation as `[图片：asset://...]`.

When a user asks to modify the attached image, call `edit_image` with that complete `asset://` URI and the requested change. The original upload remains unchanged; the tool creates a new `artifact://edit_image/<uuid>` result. Send the returned image through the existing `send_message` tool.

The editor accepts only current-channel `asset://` and `artifact://` sources. Arbitrary remote URLs, workspace paths, and cross-channel resources are rejected.

## Text generation

`generate_image` is an independent text-to-image tool. It does not search for, require, or accept prototype/reference images. It supports a text `prompt` and the `square`, `landscape`, or `portrait` orientation.

Both tools expose the generated pixels to the model for result review, share a three-image-per-turn output budget, validate PNG/JPEG/WebP data, and keep cancellation, timeout, and artifact persistence inside this plugin. Core resource-reading tools remain owned by YesImBot Core, while chat/embedding provider plugins remain responsible for model registration and image tool-result capabilities.

Image editing currently uses the configured OpenAI-compatible `/images/edits` endpoint.
