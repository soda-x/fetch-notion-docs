#!/usr/bin/env node
// CLI 入口 —— 解析命令行参数/环境变量后调用 crawlNotionSite。
// 用法: fetch-notion-docs "<根页URL>" [输出目录]
//   或: node cli.mjs "<根页URL>" ./docs
// 环境变量: MAX_PAGES  REQUEST_DELAY_MS  MAX_REQUEUE
import { readFileSync } from 'node:fs';
import { crawlNotionSite } from './index.mjs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));

const rootUrl = process.argv[2];
const outDir = process.argv[3] || './docs';

if (rootUrl === '-v' || rootUrl === '--version') {
  console.log(pkg.version);
  process.exit(0);
}

if (!rootUrl || rootUrl === '-h' || rootUrl === '--help') {
  console.error(`用法: fetch-notion-docs "<根页URL>" [输出目录=./docs]

选项:
  -h, --help       显示帮助
  -v, --version    显示版本号

环境变量:
  MAX_PAGES          抓取页数上限（默认 500）
  REQUEST_DELAY_MS   每页基础节流间隔(ms)（默认 700，限流严重时调大）
  MAX_REQUEUE        单页限流失败后最多重新入队次数（默认 5）

示例:
  fetch-notion-docs "https://xxx.notion.site/Page-00d28b31..." ./docs
  REQUEST_DELAY_MS=1200 fetch-notion-docs "<URL>" ./docs`);
  process.exit(rootUrl ? 0 : 1);
}

const num = (v) => (v != null && v !== '' ? Number(v) : undefined);

crawlNotionSite(rootUrl, outDir, {
  maxPages: num(process.env.MAX_PAGES),
  requestDelayMs: num(process.env.REQUEST_DELAY_MS),
  maxRequeue: num(process.env.MAX_REQUEUE),
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
