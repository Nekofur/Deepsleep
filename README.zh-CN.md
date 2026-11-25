# Deepsleep

[English](README.md) | 简体中文

支持多家供应商、四种接口协议，并可选用自建服务器做会话同步的静态聊天示例。聊天无需应用后端，浏览器直接请求配置的供应商；同步是可选项，连接仓库自带的 [`server/`](server/sync-server.mjs)。

点击 [在线体验](https://deepseek-ai.github.io/chat-demo/) 即可使用，也可以前往 [Releases](https://github.com/deepseek-ai/deepseek-chat-demo/releases) 下载压缩包，解压后双击 `index.html` 在本地使用，无需安装或构建。首次使用时，请在设置中添加一个供应商。

## 运行

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

打开 http://localhost:8090 。

生成静态产物：

```sh
pnpm build
```

产物位于 `dist/`，可部署到静态服务器，也可直接打开 `dist/index.html`。直接打开时，浏览器和 API 服务需允许 `file://` 页面的存储与跨域请求。

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、思考内容、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 多家供应商：Key、模型与协议按供应商分别保存，可在输入框直接切换供应商和模型。
- 四种协议：Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、Google Gemini，均支持流式思考与用量。
- 思考等级（极简 / 低 / 中 / 高 / 极高 / 最大）按协议换算成 reasoning_effort、budget_tokens 或 thinkingBudget。
- 独立的工具服务：搜索、抓取、OCR、语音识别与朗读统一调用官方 DeepSeek 的 /v1/tools/\* 接口，换用其他对话模型时仍然可用。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 可选会话同步，两种通道：用工具服务 API Key 识别用户的同步服务器，或自己填凭据的 S3 兼容对象存储。gzip 状态 + 按文件增量、按会话合并、删除跨设备生效。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。

## 供应商与协议

设置 → 模型服务 中可添加任意数量的供应商。每个供应商保存名称、协议、API 地址、API Key 与模型列表；输入框的模型菜单会列出所有供应商的模型，选中即切换。

内置 DeepSeek（Messages、Chat Completions、Responses 三种协议）、OpenAI、Anthropic、Google Gemini、OpenRouter、Moonshot、智谱、通义千问、硅基流动、Ollama、LM Studio 的模板，**自定义** 可用于其他 OpenAI 兼容网关。添加后所有字段都可修改，模型列表既可从服务端拉取（`GET /models`），也可手动填写。

| 协议                    | 使用的接口                                    | 典型服务                                                                            |
| ----------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| Anthropic Messages      | `{base}/messages`（附件走 `{base}/files`）    | DeepSeek、Anthropic 及兼容网关                                                      |
| OpenAI Chat Completions | `{base}/chat/completions`                     | OpenAI、DeepSeek、OpenRouter、Moonshot、智谱、通义千问、硅基流动、Ollama、LM Studio |
| OpenAI Responses        | `{base}/responses`                            | OpenAI GPT-5 / o 系列、DeepSeek                                                     |
| Google Gemini           | `{base}/models/{model}:streamGenerateContent` | Google AI Studio                                                                    |

- **思考**：四种协议都会解析思考增量（`reasoning_content`、`reasoning`、`response.reasoning_*`、`parts[].thought`）。设置 → 通用设置 → 思考等级 提供极简、低、中、高、极高、最大六档，适配器换算成 `reasoning_effort`（OpenAI）、`thinking.budget_tokens`（Anthropic 兼容）或 `thinkingConfig.thinkingBudget`（Gemini）。DeepSeek 只有开/关。
- **搜索**：DeepSeek 供应商在三种协议下都使用服务端的 `deepseek_web_search` / `deepseek_read_url`。其他对话供应商借助工具服务调用官方 Search / Fetch 接口取回资料，再随提问一起发送；不会把搜索改写成 Gemini 的 `googleSearch`。
- **附件**：供应商提供 Files API（Anthropic 协议）时先上传再按文件 ID 引用；其余协议把 8MB 以内的图片与 PDF 内联。非图片文档在配置了工具服务时用 OCR 转成文字，否则只保留元数据、不发送。
- **标题**：DeepSeek 由服务端生成；其他供应商用首条提问的摘要作为标题。

### 工具服务

设置 → 工具服务 为官方 DeepSeek 的工具接口单独配置地址与 Key：`POST /v1/tools/search`、`/fetch`、`/ocr`、`/asr`、`/tts`。它与对话供应商分离，所以换成 OpenAI、Gemini 或本地模型后，语音、OCR 与客户端搜索仍然可用。默认地址为 `https://api.deepseek.com`，也可指向自建代理。

## 会话同步

设置 → 会话同步 有两种可以互换的通道：用工具服务 API Key 识别用户的同步服务器，或自己填写凭据的 S3 兼容对象存储。两者共用同一套合并与冲突检测逻辑。

### 存储结构

同步不再每次上传一个 ZIP，而是：

- `state.json.gz`：gzip 压缩的会话、删除记录与「远端已有图片」清单；
- `files/{附件 id}`：图片原件，按需逐个上传。

一次同步只下载体积很小的状态文件，按会话 id 合并（`updatedAt` 较新者胜出，删除通过墓碑传播），只有内容变化时才写回状态；图片也只在缺失时单独上传或下载。因此重复同步是增量的，典型状态文件只有几 KB。

### 自建服务器

```sh
SYNC_MAX_USERS=20 pnpm sync
```

浏览器先拿「工具服务」里的 API Key 向供应商 `GET /models` 校验，通过后只把它的 SHA-256 发给同步服务器。服务器全程接触不到原始 Key：哈希就是用户 id，每个用户一个独立目录；新用户数量达到 `SYNC_MAX_USERS` 后拒绝继续创建。设置 → 会话同步 选「自建服务器」，填地址后打开「启用同步」：先校验 Key，再立即同步一次，之后每次回答结束和页面刷新时同步。

| 变量               | 默认值         | 用途                                                                                   |
| ------------------ | -------------- | -------------------------------------------------------------------------------------- |
| `PORT`             | `8080`         | 监听端口                                                                               |
| `SYNC_DATA_DIR`    | `./.sync-data` | 用户目录、状态文件与图片原件                                                           |
| `SYNC_MAX_USERS`   | `20`           | 用户数上限，`0` 表示不限制                                                             |
| `SYNC_ADMIN_TOKEN` | 未设置         | 设置后可用 `X-Admin-Token` 调用 `GET /api/admin/users`、`DELETE /api/admin/users/{id}` |

服务端提供 `GET/PUT /api/sync/state`（ETag 条件写入）、`GET/PUT /api/sync/files/{id}` 与 `GET /api/sync/me`，已开启浏览器所需的 CORS，按普通文件保存，便于备份或放在 HTTPS 反向代理之后。客户端填 `host:port` 或完整的 `http(s)://` 地址都可以。

### 直连 S3

填写 endpoint、region、bucket、prefix、Access Key ID 与 Secret Access Key 即可，请求在浏览器内用 SigV4（WebCrypto）签名，不需要任何后端。使用前给存储桶配置 CORS：

- 允许方法：`GET`、`PUT`、`HEAD`
- 允许请求头：`Authorization`、`Content-Type`、`If-Match`、`If-None-Match`、`x-amz-*`
- 暴露响应头：`ETag`

首次写入用 `If-None-Match: *`，之后用 `If-Match` 做条件写入。AWS S3 完整支持；R2、MinIO 视版本而定，如果后端忽略条件头，并发写入可能以最后写入为准。凭据只保存在本机 localStorage。

### 纯前端 S3 构建

`pnpm build:s3` 生成只保留 S3 通道的纯前端版本：界面上不再出现自建服务器选项，也完全不需要 `server/`。`pnpm build` 同时保留两种通道。

### 合并规则

- 按会话 id 合并，`updatedAt` 较新者胜出；删除通过墓碑传播，一台设备删掉的会话不会在另一台设备上复活。
- 状态写入带 ETag / 版本条件；其他设备先写入时重新拉取合并，再重试一次，不会静默覆盖。
- 模型、分支、引用与思考耗时都能往返保留；同步图片原件，非图片附件只保留元数据。
- 同步在打开页面时执行一次，之后每次回答结束都会同步；本机删除会话后也会尽快推送删除记录。

## 数据

供应商 Key、设置、工具服务 Key 或 S3 凭据与同步状态保存在浏览器 localStorage，会话及附件原件保存在 IndexedDB，本地数据按浏览器用户配置和站点源（origin）隔离。发送对话、上传附件和使用语音功能时，相应内容会提交给配置的供应商；执行同步时，会话会发送到你的同步服务器或存储桶。

设置中的历史导入导出使用 DeepSeek 导出格式的 ZIP。导入会在确认并校验成功后替换全部本地会话和附件；导出包含会话与本地可用的图片原件，不包含 API Key、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空全部本地会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。供应商 Key 和其他设置保留，已上传到供应商的文件不受影响。

## 部署

应用是纯静态包：对话请求由浏览器直接发往配置的供应商，不需要运行应用后端。

1. `pnpm build` 构建，产物在 `dist/`。资源路径相对页面解析，所以同一份构建可以放在域名根目录、子路径，甚至直接用文件打开。`pnpm build:s3` 构建只保留 S3 同步的版本。
2. 把 `dist/` 上传到任意静态托管：nginx/Caddy、GitHub Pages、Vercel、Netlify、Cloudflare Pages 或 S3 + CloudFront。应用没有前端路由，不需要额外的重写规则。
3. 如果供应商不允许浏览器跨域请求，在它前面加一层反向代理，然后 `API_ORIGIN=https://api.example.com pnpm build` 重新构建。代理需要原样转发流式响应（关闭缓冲）并透传 CORS 头。

会话同步是可选的：

- **S3 模式**不需要服务器。按 [会话同步](#直连-s3) 配好存储桶 CORS，然后在每台设备的 设置 → 会话同步 里填凭据。
- **自建服务器**：用 Node.js 18+ 运行仓库自带的零依赖服务：

  ```sh
  SYNC_DATA_DIR=/var/lib/deepsleep PORT=8080 SYNC_MAX_USERS=20 SYNC_ADMIN_TOKEN='管理密钥' node server/sync-server.mjs
  ```

  放在 HTTPS 反向代理（Caddy 或 nginx）之后，`SYNC_DATA_DIR` 挂持久卷。浏览器校验工具服务 Key 后只发送它的 SHA-256，服务器只保存哈希并用 `SYNC_MAX_USERS` 限制新用户数量；备份 `users/` 即可（每个用户一个目录，含 `state.json.gz` 与 `files/`）。设置 `SYNC_ADMIN_TOKEN` 后，`GET /api/admin/users` 可列出用户及占用大小、版本，`DELETE /api/admin/users/{id}` 可删除某个用户。

| 变量               | 默认值         | 用途                       |
| ------------------ | -------------- | -------------------------- |
| `PORT`             | `8080`         | 监听端口                   |
| `SYNC_DATA_DIR`    | `./.sync-data` | 用户、状态文件与图片原件   |
| `SYNC_MAX_USERS`   | `20`           | 用户数上限，`0` 表示不限制 |
| `SYNC_ADMIN_TOKEN` | 未设置         | 用户管理接口的管理密钥     |

## 开发

| 命令            | 用途                           |
| --------------- | ------------------------------ |
| `pnpm dev`      | 启动开发服务器                 |
| `pnpm build`    | 构建到 `dist/`                 |
| `pnpm build:s3` | 纯前端构建，只保留 S3 同步通道 |
| `pnpm sync`     | 启动本地同步服务器             |
| `pnpm type`     | TypeScript 类型检查            |
| `pnpm lint`     | oxlint 检查                    |
| `pnpm format`   | oxfmt 格式化                   |

[rspack.config.ts](rspack.config.ts) 默认以 `https://api.deepseek.com` 作为 DeepSeek 模板地址。`createConfig({ apiOrigin, devServer, syncServer })` 支持自定义该地址、开发服务器代理，以及是否内置自建服务器同步通道。

协议适配器位于 `src/services/api/protocols/`，负责在应用的规范请求 / 流事件与各家的接口格式之间互转；供应商模板与持久化在 `src/services/providers/`；同步客户端与合并逻辑在 `src/services/sync/`；`src/services/chat/history/` 仍负责 DeepSeek 导入导出格式。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               请求、SSE 与协议适配器
    chat/              会话、消息分支、本地存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    providers/         供应商模板、能力与设置
    speech/            录音与朗读
    sync/              同步状态格式、合并、服务器与 S3 通道
  utils/               通用工具
server/
  sync-server.mjs      可选的零依赖同步服务器
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
