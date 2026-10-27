# koishi-plugin-yesimbot-search-service

Web search, page extraction, and public reference-image acquisition for YesImBot using the configured Tavily or SearXNG backend.

## Configuration

Display sections separate provider choice, provider options, and request/result limits. Existing keys are unchanged: common options remain at the root and provider options stay under `tavily` or `searxng`. Fill only the selected provider.

### Common settings

| Key            | Default                           | Applies to                                                                                                                                                                       |
| -------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`     | `tavily`                          | Shared backend for webpage and image search.                                                                                                                                     |
| `defaultLimit` | `5`                               | Default result count for webpage/image search.                                                                                                                                   |
| `maxLimit`     | `10`                              | Result-count limit; image candidates additionally have a fixed cap of eight, so increasing this does not raise that cap.                                                         |
| `timeoutMs`    | `10000` milliseconds (10 seconds) | Search/extraction HTTP requests and the complete reference download across DNS, redirects, headers and body. It does not set image-generation or Core vision deadlines.          |
| `blacklist`    | `[]`                              | URL-filter regular expressions for search results, including image URLs and known source pages. This is not an importer network allowlist or a way to disable its safety checks. |

### Tavily settings

| Key under `tavily` | Default / requirement            | Applies to                                                          |
| ------------------ | -------------------------------- | ------------------------------------------------------------------- |
| `apiKey`           | Required                         | Tavily search and page extraction; never forwarded to image hosts.  |
| `searchEndpoint`   | `https://api.tavily.com/search`  | Full endpoint for webpage and image search.                         |
| `extractEndpoint`  | `https://api.tavily.com/extract` | Full page-extraction endpoint, not image downloads.                 |
| `searchDepth`      | `basic`                          | Default depth for both search tools; webpage calls can override it. |
| `topic`            | Unset: provider default          | Webpage search only; individual calls can override it.              |
| `timeRange`        | Unset: no configured default     | Webpage search only; individual calls can override it.              |

```yaml
provider: tavily
tavily:
  apiKey: "<tavily-api-key>"
defaultLimit: 5
maxLimit: 10
timeoutMs: 10000
```

### SearXNG settings

| Key under `searxng`    | Default / requirement   | Applies to                                                                                                                        |
| ---------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`             | Required                | Instance root or `/search` URL, shared by webpage/image search.                                                                   |
| `username`, `password` | Unset                   | Optional HTTP Basic authentication to the search instance; both must be supplied to send authentication. Not sent to image hosts. |
| `language`             | Unset: instance default | Default for webpage and image search; webpage calls can override it.                                                              |
| `safeSearch`           | Unset: instance default | Webpage/image filtering preference (`0`, `1`, or `2`); actual filtering depends on the instance.                                  |
| `engines`              | `[]`: instance default  | Webpage search only. Image search uses the instance's enabled image engines, not this list.                                       |
| `categories`           | `[]`: instance default  | Webpage search only. Dedicated image search always requests `images`.                                                             |

```yaml
provider: searxng
searxng:
  endpoint: "https://search.example"
  language: "zh-CN"
  engines: []
  categories: []
timeoutMs: 10000
```

Search `query`/`limit`, import `imageUrl`/`subject`/`sourcePageUrl`, and generation `orientation`/`referenceUris` are per-call tool inputs, not new operator settings. Download/redirect/pixel limits, private-network rejection and generated-output quota are not bypassable configuration switches.

## Tools

- Tavily: `tavily_web_search`, `tavily_web_scrape`, `tavily_image_search`.
- SearXNG: `searxng_web_search`, `searxng_image_search`.
- `import_image_reference`: download a selected public candidate, persist it as a current-channel artifact, and expose its actual content using Core native image input or the configured vision capability.

Image-search results contain `imageUrl` and known `sourcePageUrl`, `title`, and `description`. These are candidate clues, not verified identity. Tavily requests image descriptions and retains actual per-page attribution; top-level images without a known source page do not receive invented attribution. SearXNG uses the images category and original `img_src`, not thumbnails or inherited web-only engine restrictions. A deployment must enable working image search in its configured backend.

## Reference workflow

1. Prefer a suitable image already supplied in the current channel.
2. For an identifiable public person, character, or named product without a reference, search using its unambiguous name. For a private/custom subject, ask for an image instead of searching for a substitute.
3. Select a candidate and call `import_image_reference` with `imageUrl`, the intended `subject`, and `sourcePageUrl` when actually known. Inspect source context and the returned native pixels or vision description. Treat uncertainty as uncertainty.
4. Only use a reliably matched reference URI in `generate_image.referenceUris` with `subjectType: "specific"`. A generic scene does not require an unrelated reference. Failed/ambiguous search or unavailable inspection should lead to asking for an image or clarification, never silently switching to text-only generation.

```json
{
  "imageUrl": "https://images.example/character.png",
  "subject": "An unambiguously identified public character",
  "sourcePageUrl": "https://official.example/character"
}
```

Successful import returns an `artifact://import_image_reference/...` URI, source metadata, actual dimensions, and `inspection.mode` (`native` or `vision`). Native mode projects the actual image; vision mode includes only the configured capability description. Neither mode certifies identity. Images unavailable to both routes return `image_input_unavailable` without a successful import. Artifacts stay channel-scoped. Imports neither generate/send images nor consume the three-generated-output budget.

## Download boundary

Imports accept only public HTTP(S) destinations without URL credentials. Every DNS answer and redirect target must be public, with a connection pinned to a validated address and the original HTTPS certificate identity preserved. Downloads do not forward search-provider credentials or cookies, do not use implicit HTTP proxies, and do not fetch local files or internal-network URLs. TLS certificate verification stays enabled for these requests.

The configured `timeoutMs` bounds DNS, headers, all redirect hops (at most three), and body reads. Actual streamed bytes must fit the channel resource limit, currently 5 MiB. PNG/JPEG/WebP headers and positive dimensions (at most 40 million pixels) are required; GIF and other formats are not accepted. Header measurement is not a full image decoder. Slow/late/invalid responses are canceled and do not become successful references. Errors are bounded codes, not raw network exceptions.

Core owns image-model routing, native/vision capabilities, and transient pixel cleanup. Search service does not select a second vision model or restore automatic persona-image injection. Generation success, visual acceptance, and final `send_message` delivery remain separate steps.
