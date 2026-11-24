# Deepsleep

English | [简体中文](README.zh-CN.md)

A static chat demo with pluggable model providers, four wire protocols, and optional self-hosted conversation sync. No application backend is required for chatting: the browser connects directly to the configured provider. Sync is optional and talks to the small server bundled in [`server/`](server/sync-server.mjs).

You can [try the app online](https://deepseek-ai.github.io/chat-demo/) or download the archive from [Releases](https://github.com/deepseek-ai/deepseek-chat-demo/releases), extract it, and double-click `index.html` to use it locally without installation or a build. Add a provider in Settings before your first chat.

## Getting started

Install Node.js 22.12+ and pnpm, then run:

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

Open http://localhost:8090.

To build the static site:

```sh
pnpm build
```

The output is written to `dist/`. Deploy it to a static web server or open `dist/index.html` directly. Opening the file directly requires browser support for storage on `file://` pages and an API service that permits their cross-origin requests.

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, reasoning output, web search, link reading, and source citations; stop generation or continue eligible replies.
- Multiple providers with per-provider keys, models, and protocols; switch provider or model from the composer.
- Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, and Google Gemini protocols, including streaming reasoning and usage.
- Four reasoning effort levels from minimal to max, mapped to each protocol (`reasoning_effort`, `budget_tokens`, `thinkingBudget`).
- A separate tools service for search, fetch, OCR, speech recognition, and read-aloud, using the official DeepSeek `/v1/tools/*` APIs; it keeps working when the chat provider is not DeepSeek.
- Upload, paste, or drag and drop attachments; use voice input and read replies aloud.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Optional conversation sync with two transports: a self-hosted server that identifies users by their tools service API key, or direct S3-compatible object storage with credentials you enter yourself. Compressed state plus per-file objects, per-session merge, and deletion propagation.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.

## Providers and protocols

Settings → Models holds any number of providers. Each provider stores a name, a protocol, a base URL, an API key, and its model list; the composer lists every model of every provider, and picking one makes that provider active.

Presets are included for DeepSeek (Messages, Chat Completions, and Responses), OpenAI, Anthropic, Google Gemini, OpenRouter, Moonshot, Zhipu, Alibaba Qwen, SiliconFlow, Ollama and LM Studio; **Custom** covers any other OpenAI-compatible gateway. Everything can be edited after adding a provider, and the model list can be fetched from the server (`GET /models`) or typed in manually.

| Protocol                | Endpoint used                                 | Typical services                                                                    |
| ----------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| Anthropic Messages      | `{base}/messages` (+ `{base}/files`)          | DeepSeek, Anthropic, Anthropic-compatible gateways                                  |
| OpenAI Chat Completions | `{base}/chat/completions`                     | OpenAI, DeepSeek, OpenRouter, Moonshot, Zhipu, Qwen, SiliconFlow, Ollama, LM Studio |
| OpenAI Responses        | `{base}/responses`                            | OpenAI GPT-5 / o-series, DeepSeek                                                   |
| Google Gemini           | `{base}/models/{model}:streamGenerateContent` | Google AI Studio                                                                    |

- **Reasoning**: reasoning deltas are parsed for all four protocols (`reasoning_content`, `reasoning`, `response.reasoning_*`, `parts[].thought`). Settings → General → Reasoning effort offers minimal, low, medium, high, extra high, and maximum; adapters translate it into `reasoning_effort` (OpenAI), `thinking.budget_tokens` (Anthropic-compatible), or `thinkingConfig.thinkingBudget` (Gemini). DeepSeek only exposes an on/off switch.
- **Search**: DeepSeek providers get server-side `deepseek_web_search` / `deepseek_read_url` on all three DeepSeek protocols. Other chat providers can still search: the app calls the official Search and Fetch APIs from the tools service and sends the results with the question. Gemini's own `googleSearch` is intentionally not injected.
- **Attachments**: when the provider exposes a Files API (Anthropic protocol) attachments are uploaded and referenced by file ID. Otherwise images and PDFs up to 8 MB are inlined into the request; other documents are read with OCR from the tools service when it is configured, otherwise they keep their metadata and are not sent.
- **Titles**: DeepSeek returns a server-generated title; other providers get a title derived from the first question.

### Tools service

Settings → Tools configures one endpoint and key for the official DeepSeek tool APIs: `POST /v1/tools/search`, `/v1/tools/fetch`, `/v1/tools/ocr`, `/v1/tools/asr`, and `/v1/tools/tts`. It is separate from chat providers, so speech, OCR, and client-side web access keep working when the chat model is OpenAI, Gemini, or a local model. The default base URL is `https://api.deepseek.com`; point it at a proxy if you use one.

## Session sync

Settings → Sync keeps conversations in sync across devices with two interchangeable transports: a self-hosted server keyed by your tools service API key, or direct S3-compatible object storage with credentials you enter yourself. Both share the same merge engine and conflict detection.

### Storage layout

Sync no longer uploads one ZIP per run. It stores:

- `state.json.gz` — gzipped JSON with sessions, deletion tombstones, and the list of image originals already on the remote;
- `files/{attachment id}` — image originals, uploaded one by one.

A sync downloads only the small state file, merges it per session id (newest `updatedAt` wins, deletions propagate through tombstones), and writes the state back only when something changed. Images are downloaded or uploaded individually and only when missing. This makes repeated syncs small and incremental; a typical state file is a few kilobytes.

### Self-hosted server

```sh
SYNC_MAX_USERS=20 pnpm sync
```

The browser validates the tools service API key against the provider (`GET /models`) and then sends only its SHA-256 to the sync server. The server never sees the raw key: it uses the hash as the user id, keeps each user in their own directory, and rejects new users once `SYNC_MAX_USERS` is reached. In Settings → Sync choose the server transport, enter the URL, and turn on **Enable sync**: the key is validated, a sync runs immediately, then every five minutes.

| Variable           | Default        | Purpose                                                                                |
| ------------------ | -------------- | -------------------------------------------------------------------------------------- |
| `PORT`             | `8080`         | Listen port                                                                            |
| `SYNC_DATA_DIR`    | `./.sync-data` | Users, state files and image originals                                                 |
| `SYNC_MAX_USERS`   | `20`           | Maximum number of users; `0` means unlimited                                           |
| `SYNC_ADMIN_TOKEN` | unset          | Enables `GET /api/admin/users` and `DELETE /api/admin/users/{id}` with `X-Admin-Token` |

The server exposes `GET/PUT /api/sync/state` (ETag preconditions), `GET/PUT /api/sync/files/{id}` and `GET /api/sync/me`, enables CORS for browser clients, and stores plain files that can be backed up or put behind HTTPS with a reverse proxy. The client accepts `host:port` as well as a full `http(s)://` URL.

### Direct S3

Fill in endpoint, region, bucket, prefix, Access Key ID and Secret Access Key. Requests are signed in the browser with SigV4 (WebCrypto), so no backend is required. For each bucket used this way, configure CORS:

- Allowed methods: `GET`, `PUT`, `HEAD`
- Allowed headers: `Authorization`, `Content-Type`, `If-Match`, `If-None-Match`, `x-amz-*`
- Exposed headers: `ETag`

Conditional writes use `If-None-Match: *` for the first upload and `If-Match` afterwards. AWS S3 supports both; R2 and MinIO support varies by version — if a backend ignores the precondition, a concurrent write may win instead of being detected. Credentials are stored in localStorage on this device.

### S3-only build

`pnpm build:s3` produces a pure frontend build that keeps only the S3 transport: the self-hosted server option and its client code paths are removed from the UI, and `server/` is not needed at all. `pnpm build` keeps both transports.

### Merge behaviour

- Sessions merge by id; the newer `updatedAt` wins, and deletions are carried by tombstones so a session deleted on one device is removed on the others.
- The state write is conditional on the remote ETag/revision; if another device wrote first the client re-reads, merges again, and retries once instead of overwriting.
- Models, branches, citations, and reasoning timings survive a round trip. Image originals are synced; non-image attachments keep metadata only.
- Auto sync runs every five minutes, when the window becomes visible again, and shortly after a local deletion.

## Data and storage

Provider keys, settings, the tools service key or S3 credentials, and sync bookkeeping live in the browser's localStorage. Conversations and original attachments are stored in IndexedDB. Local data is isolated by browser profile and site origin. Sending messages, uploading attachments, and using speech features sends the relevant content to the configured provider; syncing sends conversations to your sync server or bucket.

History import and export in Settings use ZIP archives in the DeepSeek export format. After confirmation and successful validation, importing replaces all local conversations and attachments. Exports include conversations and locally available original images, but exclude API keys, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

Settings → Data → Delete all chats clears all local conversations, original attachments, and unsent drafts after confirmation. It stops ongoing replies and returns to a new chat. Your provider keys and settings are preserved; files already uploaded to a provider are not deleted.

## Deploy

The app is a static bundle: chat requests go straight from the browser to the configured provider, so there is no application backend to run.

1. Build with `pnpm build`; the output is `dist/`. Asset URLs resolve relative to the page, so the same build works at a domain root, under a subpath, or opened from disk. `pnpm build:s3` builds the S3-only variant.
2. Upload `dist/` to any static host: nginx/Caddy, GitHub Pages, Vercel, Netlify, Cloudflare Pages, or S3 + CloudFront. No rewrite rules are needed because the app does not use client-side routing.
3. If your provider does not send CORS headers for browser requests, put a reverse proxy in front of it and build with `API_ORIGIN=https://api.example.com pnpm build`. The proxy must forward streaming responses without buffering and pass CORS headers through.

Conversation sync is optional:

- **S3 mode** needs no server. Configure bucket CORS as described in [Session sync](#direct-s3), then enter the credentials in Settings → Sync on each device.
- **Self-hosted server**: run the bundled zero-dependency server with Node.js 18 or newer:

  ```sh
  SYNC_DATA_DIR=/var/lib/deepsleep PORT=8080 SYNC_MAX_USERS=20 SYNC_ADMIN_TOKEN='admin-secret' node server/sync-server.mjs
  ```

  Put it behind HTTPS (Caddy or nginx) and keep `SYNC_DATA_DIR` on a persistent volume. The browser verifies the tools service key and sends its SHA-256; the server stores that hash and caps new users with `SYNC_MAX_USERS`. Back up `users/` (each user has `state.json.gz` and `files/`). If `SYNC_ADMIN_TOKEN` is set, `GET /api/admin/users` lists users with size and revision, and `DELETE /api/admin/users/{id}` removes one.

| Variable           | Default        | Purpose                                      |
| ------------------ | -------------- | -------------------------------------------- |
| `PORT`             | `8080`         | Listen port                                  |
| `SYNC_DATA_DIR`    | `./.sync-data` | Users, state files and image originals       |
| `SYNC_MAX_USERS`   | `20`           | Maximum number of users; `0` means unlimited |
| `SYNC_ADMIN_TOKEN` | unset          | Admin token for the user management routes   |

## Development

| Command         | Description                                         |
| --------------- | --------------------------------------------------- |
| `pnpm dev`      | Start the development server                        |
| `pnpm build`    | Build into `dist/`                                  |
| `pnpm build:s3` | Pure frontend build with only the S3 sync transport |
| `pnpm sync`     | Start the local sync server                         |
| `pnpm type`     | Run TypeScript type checks                          |
| `pnpm lint`     | Lint with oxlint                                    |
| `pnpm format`   | Format with oxfmt                                   |

[rspack.config.ts](rspack.config.ts) uses `https://api.deepseek.com` as the default DeepSeek preset origin. Use `createConfig({ apiOrigin, devServer, syncServer })` to customize it, the development server proxy, and whether the self-hosted sync transport is built in.

Each protocol adapter lives in `src/services/api/protocols/` and translates between the app's canonical request and stream events and the provider wire format. Provider presets and persistence are in `src/services/providers/`. The sync client and merge engine live in `src/services/sync/`; `src/services/chat/history/` still handles the DeepSeek import/export format.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               Transport, SSE, and protocol adapters
    chat/              Conversations, message branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    providers/         Provider presets, capabilities, and settings
    speech/            Audio recording and read-aloud playback
    sync/              Sync state format, merge engine, server and S3 transports
  utils/               Shared utilities
server/
  sync-server.mjs      Optional zero-dependency sync server
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
