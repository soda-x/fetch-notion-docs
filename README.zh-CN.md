# fetch-notion-docs

[English](./README.md) | **简体中文**

把**公开**的 Notion 站点整站下载成 Markdown —— 包含内部引用链接（改写为本地相对链接）和图片（下载到本地）。

适用于**别人发布的公开站点**（非自有 workspace、拿不到官方 token）的场景。基于 [`notion-client`](https://github.com/NotionX/react-notion-x)（公开页 `getPage(pageId)` 免 token）+ [`notion-utils`](https://github.com/NotionX/react-notion-x) 自写抓取与序列化。

## 特性

- 支持 Notion **vanity 短链**（`notion.site/<slug>`，URL 里没有 page id）—— 自动从页面 HTML 解析出真实 page id
- 从根页 **BFS 递归抓全**：跟进子页 / 数据库行 / 同 host 的 `a`-链接。**只在单个站点内**，不会窜进同一 workspace 下的其它站点
- 每页转 **Markdown**：粗体、斜体、删除线、行内代码、链接、标题、列表、待办、引用、callout、代码块、公式、图片
  - `toggle` → `<details>`
  - 数据库视图 → Markdown 表格（取第一个视图）
  - 未知块类型兜底输出纯文本
- **内部页面引用**改写成指向本地 `.md` 的相对链接
- **图片**走 signed URL 即时下载到 `assets/`（按 URL 哈希去重）
- 输出 `_index.md` 站点总览
- **限流稳健**：指数退避 + 失败重新入队 + 连续失败整体冷却；永久错误（404 / 未发布）即时跳过

## 安装

需要 **Node.js 18+**（用到内建 `fetch`）。

```bash
npm install
```

装成全局命令（开发期用 `npm link`；或发布后 `npm i -g fetch-notion-docs`）：

```bash
npm link
```

## 用法

### 1. 命令行

```bash
# 全局命令
fetch-notion-docs "<根页URL>" ./docs

# 或不装全局，直接跑
node cli.mjs "<根页URL>" ./docs

# 或用 npm script（-- 后面才是脚本参数）
npm run crawl -- "<根页URL>" ./docs
```

例：

```bash
fetch-notion-docs "https://your-site.notion.site/Xxxx-00d28b31..." ./docs
```

### 2. 作为库被第三方引用

```js
import { crawlNotionSite } from 'fetch-notion-docs';

const result = await crawlNotionSite(
  'https://your-site.notion.site/Xxxx-00d28b31...',
  './docs',
  {
    maxPages: 500,
    requestDelayMs: 700,
    maxRequeue: 5,
    log: () => {},        // 传空函数可静默普通日志
    warn: console.warn,
  }
);
// result: { pages, images, failed: string[], outDir, indexFile }
```

也可单独引用更底层的渲染函数：`renderBlocks(blockIds, recordMap, ctx)`、`renderInline(richText, ctx)`、错误类型 `PermanentError`。

产出：

```
docs/
├── _index.md            # 站点总览（所有页面链接）
├── <页面标题>-<短id>.md  # 每页一个 Markdown
└── assets/              # 下载的图片
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MAX_PAGES` | `500` | 抓取页数上限 |
| `REQUEST_DELAY_MS` | `700` | 每页之间的基础节流间隔（毫秒），限流严重时调大 |
| `MAX_REQUEUE` | `5` | 单页因限流失败后最多重新入队次数 |

例（降速防限流）：

```bash
REQUEST_DELAY_MS=1200 MAX_PAGES=1000 fetch-notion-docs "<根页URL>" ./docs
```

## 前提与限制

- **站点必须是 Publish 公开状态**，否则 `loadPageChunk` 返回未授权，整页抓不到。
- 抓不到的页面（404 / 未发布 / 别的 workspace）会**保留为原始 Notion 远程链接**，不做本地化。
- 爬取边界是**页面子树 + 同站链接**。指向同一 workspace 下其它站点的页面提及 / link-to-page 引用只渲染成链接、**不会被爬进来**（避免误把整个共享 workspace 拖下来）。
- 数据库只取**第一个视图**的行；嵌套数据库、`synced_block`（同步块）、特殊 embed（Figma / Drive 等）目前是兜底渲染，未必理想。
- 下载的是**第三方内容**，请自行确认版权与使用授权；本仓库默认 `.gitignore` 掉 `docs/`，不建议把抓取产出提交进版本库。

## 实现要点

- `getPage(id, { fetchCollections: true, signFileUrls: true })` 返回 `ExtendedRecordMap`（`block` / `collection` / `collection_view` / `collection_query` / `signed_urls`）。
- ⚠️ `notion-client` 7.x 返回的记录是带 role 的**双层包裹**格式，真实值在 `entry.value.value`（代码里用 `rval()` helper 统一解包）。
- 子页 = recordMap 里 `type === 'page' | 'collection_view_page'` 的块，每页需单独 `getPage` 才有正文。
- 图片优先取 `signed_urls[blockId]`，回退 `defaultMapImageUrl`。
- 富文本是 decoration 数组（`b`/`i`/`s`/`c`/`a`/`p`/`e`…），由 `renderInline` 转 Markdown。

## License

[MIT](./LICENSE)
