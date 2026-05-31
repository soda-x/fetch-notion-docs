// fetch-notion-docs — 把公开 Notion 站点下载成 Markdown（含内部引用链接与图片）
//
// 库用法:
//   import { crawlNotionSite } from 'fetch-notion-docs';
//   const result = await crawlNotionSite(rootUrl, './docs', { maxPages: 500 });
//
// CLI 用法见 cli.mjs。
import { NotionAPI } from 'notion-client';
import {
  parsePageId,
  getPageTitle,
  defaultMapImageUrl,
  getTextContent,
  uuidToId,
} from 'notion-utils';
import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const notion = new NotionAPI();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// notion-client 7.x 返回带 role 的指针格式，真实记录在 entry.value.value
const rval = (entry) => entry?.value?.value ?? entry?.value;
const getBlock = (rm, id) => rval(rm?.block?.[id]);

// 永久性错误：页面不存在/未发布/无权限，重试无意义
export class PermanentError extends Error {}
const isPermanent = (msg) => /not found|unauthorized|403|404|restricted|has been deleted/i.test(msg || '');

// ---------- 带重试的网络封装 ----------
async function getPageWithRetry(pageId, { requestDelayMs, warn, tries = 6 }) {
  for (let i = 0; i < tries; i++) {
    try {
      return await notion.getPage(pageId, {
        fetchCollections: true,
        signFileUrls: true,
      });
    } catch (err) {
      if (isPermanent(err.message)) {
        throw new PermanentError(err.message);
      }
      const is429 = /429/.test(err.message || '');
      // 429 走更激进退避（最长约 32s），其余错误温和退避
      const base = is429 ? 2000 : requestDelayMs;
      const wait = Math.min(base * Math.pow(2, i) + Math.random() * 500, 32000);
      warn(`  getPage(${uuidToId(pageId)}) 失败(${i + 1}/${tries}): ${err.message} — 等 ${Math.round(wait)}ms`);
      if (i === tries - 1) throw err;
      await sleep(wait);
    }
  }
}

// ---------- 工具 ----------
function slugify(s, fallback) {
  const base = (s || '').trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}\-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || fallback;
}

// 富文本 decoration 数组 -> markdown 内联
export function renderInline(richText, ctx) {
  if (!Array.isArray(richText)) return '';
  let out = '';
  for (const seg of richText) {
    let text = seg[0] ?? '';
    const decos = seg[1] || [];

    // 特殊 token: 行内公式 / 页面提及 / 日期
    let mention = null;
    for (const d of decos) {
      if (d[0] === 'e') { out += `$${d[1]}$`; mention = 'eq'; break; }
      if (d[0] === 'p') { // page mention
        const ref = ctx.linkForPage(d[1]);
        out += `[${ctx.titleForPage(d[1]) || '页面'}](${ref})`;
        mention = 'page';
        break;
      }
      if (d[0] === 'd') { // date
        const dd = d[1];
        out += dd?.start_date ? dd.start_date + (dd.end_date ? `→${dd.end_date}` : '') : (text || '日期');
        mention = 'date';
        break;
      }
    }
    if (mention) continue;

    // 转义 markdown 敏感字符（保守处理）
    text = text.replace(/([\\`*_\[\]])/g, '\\$1');

    let link = null;
    for (const d of decos) {
      switch (d[0]) {
        case 'b': text = `**${text}**`; break;
        case 'i': text = `*${text}*`; break;
        case 's': text = `~~${text}~~`; break;
        case 'c': text = `\`${seg[0]}\``; break; // 行内代码用原文不转义
        case 'a': link = d[1]; break;
        default: break;
      }
    }
    if (link) {
      const href = ctx.rewriteHref(link);
      text = `[${text}](${href})`;
    }
    out += text;
  }
  return out;
}

function titleOf(props) {
  return props?.title ? getTextContent(props.title) : '';
}

// collection_query 取行 blockIds（兼容多种结构）
function getCollectionRowIds(recordMap, collectionId, viewId) {
  const q = recordMap.collection_query?.[collectionId]?.[viewId];
  if (!q) return [];
  if (Array.isArray(q.blockIds)) return q.blockIds;
  const ids = [];
  if (q.collection_group_results?.blockIds) ids.push(...q.collection_group_results.blockIds);
  for (const k of Object.keys(q)) {
    const v = q[k];
    if (v && Array.isArray(v.blockIds)) ids.push(...v.blockIds);
  }
  return [...new Set(ids)];
}

// 从一个 recordMap 收集子页/数据库行/页面提及的 pageId
function collectChildPageIds(recordMap, selfId, siteHost) {
  const found = new Set();
  const selfClean = uuidToId(selfId);

  for (const [id, entry] of Object.entries(recordMap.block || {})) {
    const b = rval(entry);
    if (!b) continue;
    if ((b.type === 'page' || b.type === 'collection_view_page') && uuidToId(id) !== selfClean) {
      found.add(id);
    }
    // alias（link-to-page 引用块）指向的目标页
    if (b.type === 'alias') {
      const tgt = b.format?.alias_pointer?.id;
      if (tgt) found.add(tgt);
    }
    // 行内数据库：抓行
    if (b.type === 'collection_view' || b.type === 'collection_view_page') {
      const collId = b.collection_id || b.format?.collection_pointer?.id;
      for (const viewId of b.view_ids || []) {
        if (collId) for (const rid of getCollectionRowIds(recordMap, collId, viewId)) found.add(rid);
      }
    }
    // 页面提及 / 站内 a 链接
    const scanProps = (props) => {
      for (const v of Object.values(props || {})) {
        if (!Array.isArray(v)) continue;
        for (const seg of v) {
          for (const d of seg[1] || []) {
            if (d[0] === 'p' && d[1]) found.add(d[1]);
            if (d[0] === 'a' && d[1]) {
              const href = d[1];
              const isInternal = href.startsWith('/') ||
                (siteHost && href.includes(siteHost)) || href.includes('notion.so');
              if (isInternal) {
                const m = href.match(/([0-9a-f]{32})/i);
                if (m) found.add(m[1]);
              }
            }
          }
        }
      }
    };
    scanProps(b.properties);
  }
  return [...found];
}

function resolveImageUrl(block, recordMap) {
  const signed = recordMap.signed_urls?.[block.id];
  const rawSrc = block.properties?.source?.[0]?.[0] || block.format?.display_source;
  if (signed) return signed;
  if (rawSrc) {
    try {
      return defaultMapImageUrl(rawSrc, block);
    } catch {
      return rawSrc;
    }
  }
  return null;
}

// ---------- 块渲染 ----------
// ctx 需提供: titleForPage, linkForPage, rewriteHref, downloadAsset
export async function renderBlocks(blockIds, recordMap, ctx, depth = 0) {
  const lines = [];
  let numCounter = 0;
  for (let i = 0; i < (blockIds || []).length; i++) {
    const id = blockIds[i];
    const block = getBlock(recordMap, id);
    if (!block || !block.type) continue;
    const t = block.type;
    if (t === 'numbered_list') numCounter++; else numCounter = 0;
    const pad = '  '.repeat(depth);
    const inline = (rt) => renderInline(rt, ctx);
    const title = block.properties?.title;

    switch (t) {
      case 'text': {
        const md = inline(title);
        lines.push(pad + (md || ''));
        break;
      }
      case 'header': lines.push(pad + '# ' + inline(title)); break;
      case 'sub_header': lines.push(pad + '## ' + inline(title)); break;
      case 'sub_sub_header': lines.push(pad + '### ' + inline(title)); break;
      case 'quote': lines.push(pad + '> ' + inline(title)); break;
      case 'callout': {
        const emoji = block.format?.page_icon || '💡';
        lines.push(pad + `> ${emoji} ${inline(title)}`);
        break;
      }
      case 'bulleted_list': lines.push(pad + '- ' + inline(title)); break;
      case 'numbered_list': lines.push(pad + `${numCounter}. ` + inline(title)); break;
      case 'to_do': {
        const checked = block.properties?.checked?.[0]?.[0] === 'Yes';
        lines.push(pad + `- [${checked ? 'x' : ' '}] ` + inline(title));
        break;
      }
      case 'toggle': {
        lines.push(pad + '<details>');
        lines.push(pad + `<summary>${inline(title)}</summary>`);
        lines.push('');
        if (block.content?.length) {
          lines.push(...(await renderBlocks(block.content, recordMap, ctx, depth)));
        }
        lines.push('');
        lines.push(pad + '</details>');
        break;
      }
      case 'code': {
        const lang = (block.properties?.language?.[0]?.[0] || '').toLowerCase();
        const codeText = title ? getTextContent(title) : '';
        lines.push(pad + '```' + lang);
        lines.push(codeText);
        lines.push(pad + '```');
        break;
      }
      case 'equation': {
        const expr = title ? getTextContent(title) : '';
        lines.push(pad + '$$');
        lines.push(expr);
        lines.push(pad + '$$');
        break;
      }
      case 'divider': lines.push(pad + '---'); break;
      case 'image': {
        const url = resolveImageUrl(block, recordMap);
        const local = url ? await ctx.downloadAsset(url, block.id) : null;
        const caption = block.properties?.caption ? inline(block.properties.caption) : '';
        lines.push(pad + `![${caption}](${local || url || ''})`);
        if (caption) lines.push(pad + `*${caption}*`);
        break;
      }
      case 'video': case 'file': case 'pdf': case 'audio': {
        const url = recordMap.signed_urls?.[block.id] || block.properties?.source?.[0]?.[0] || '';
        const name = block.properties?.title ? getTextContent(block.properties.title) : t;
        lines.push(pad + `[📎 ${name || t}](${url})`);
        break;
      }
      case 'bookmark': {
        const url = block.properties?.link?.[0]?.[0] || '';
        const cap = block.properties?.title ? inline(block.properties.title) : url;
        lines.push(pad + `[🔖 ${cap}](${url})`);
        break;
      }
      case 'page':
      case 'collection_view_page': {
        const ref = ctx.linkForPage(id);
        const ttl = ctx.titleForPage(id) || titleOf(block.properties) || '子页面';
        lines.push(pad + `- 📄 [${ttl}](${ref})`);
        break;
      }
      case 'collection_view': {
        lines.push(...renderCollection(block, recordMap, ctx, pad));
        break;
      }
      case 'alias': {
        const tgt = block.format?.alias_pointer?.id;
        if (tgt) {
          const ref = ctx.linkForPage(tgt);
          const ttl = ctx.titleForPage(tgt) || '页面';
          lines.push(pad + `- 🔗 [${ttl}](${ref})`);
        }
        break;
      }
      case 'column_list': {
        if (block.content?.length) {
          for (const colId of block.content) {
            const col = getBlock(recordMap, colId);
            if (col?.content?.length) {
              lines.push(...(await renderBlocks(col.content, recordMap, ctx, depth)));
            }
          }
        }
        break;
      }
      case 'column': {
        if (block.content?.length) lines.push(...(await renderBlocks(block.content, recordMap, ctx, depth)));
        break;
      }
      case 'table': {
        lines.push(...renderSimpleTable(block, recordMap, ctx, pad));
        break;
      }
      case 'transclusion_container': // synced block 容器
      case 'transclusion_reference': {
        const src = block.format?.transclusion_reference_pointer?.id || block.format?.copied_from_pointer?.id;
        const content = block.content || (src && getBlock(recordMap, src)?.content);
        if (content?.length) lines.push(...(await renderBlocks(content, recordMap, ctx, depth)));
        break;
      }
      case 'embed': case 'figma': case 'drive': case 'tweet': case 'codepen':
      case 'gist': case 'maps': case 'pdf_embed': {
        const url = block.properties?.source?.[0]?.[0] || block.format?.display_source || '';
        lines.push(pad + `[🔗 ${t}: ${url}](${url})`);
        break;
      }
      case 'table_of_contents': lines.push(pad + '<!-- 目录 -->'); break;
      case 'breadcrumb': break;
      default: {
        // 兜底：尽量输出纯文本
        const md = inline(title);
        if (md) lines.push(pad + md);
        else if (title) lines.push(pad + getTextContent(title));
        else lines.push(pad + `<!-- 未处理块类型: ${t} -->`);
        break;
      }
    }

    // 递归子块（列表/待办/toggle 之外的容器型已在上面处理）
    const handledChildren = ['toggle', 'column', 'column_list', 'transclusion_container', 'transclusion_reference', 'page', 'collection_view_page', 'collection_view', 'table', 'alias'];
    if (!handledChildren.includes(t) && block.content?.length) {
      const childDepth = ['bulleted_list', 'numbered_list', 'to_do'].includes(t) ? depth + 1 : depth;
      lines.push(...(await renderBlocks(block.content, recordMap, ctx, childDepth)));
    }

    // 块之间留空行（块级元素）
    if (['text', 'header', 'sub_header', 'sub_sub_header', 'quote', 'callout', 'code', 'equation', 'image', 'divider', 'toggle', 'collection_view', 'table'].includes(t)) {
      lines.push('');
    }
  }
  return lines;
}

// 数据库视图 -> markdown 表格（取第一个视图）
function renderCollection(block, recordMap, ctx, pad) {
  const lines = [];
  const collId = block.collection_id || block.format?.collection_pointer?.id;
  const coll = collId ? rval(recordMap.collection?.[collId]) : null;
  const viewId = (block.view_ids || [])[0];
  if (!coll || !viewId) { lines.push(pad + '<!-- 空数据库 -->'); return lines; }

  const collName = coll.name ? getTextContent(coll.name) : '';
  if (collName) { lines.push(pad + `**${collName}**`); lines.push(''); }

  const view = rval(recordMap.collection_view?.[viewId]);
  const schema = coll.schema || {};
  // 列顺序
  let propOrder = view?.format?.table_properties?.filter((p) => p.visible !== false).map((p) => p.property)
    || Object.keys(schema);
  // 确保 title 列在最前
  const titleKey = Object.keys(schema).find((k) => schema[k].type === 'title') || 'title';
  propOrder = [titleKey, ...propOrder.filter((p) => p !== titleKey)];
  propOrder = [...new Set(propOrder)].filter((p) => schema[p]);

  const headers = propOrder.map((p) => schema[p].name || p);
  lines.push(pad + '| ' + headers.join(' | ') + ' |');
  lines.push(pad + '| ' + headers.map(() => '---').join(' | ') + ' |');

  const rowIds = getCollectionRowIds(recordMap, collId, viewId);
  for (const rid of rowIds) {
    const row = getBlock(recordMap, rid);
    if (!row) continue;
    const cells = propOrder.map((p) => {
      const sch = schema[p];
      const raw = row.properties?.[p];
      if (sch.type === 'title') {
        const ref = ctx.linkForPage(rid);
        const ttl = (raw ? getTextContent(raw) : '') || '(无标题)';
        return `[${ttl.replace(/\|/g, '\\|')}](${ref})`;
      }
      if (!raw) return '';
      return renderInline(raw, ctx).replace(/\n/g, ' ').replace(/\|/g, '\\|');
    });
    lines.push(pad + '| ' + cells.join(' | ') + ' |');
  }
  lines.push('');
  return lines;
}

// 简单表格块
function renderSimpleTable(block, recordMap, ctx, pad) {
  const lines = [];
  const rowIds = block.content || [];
  const colOrder = block.format?.table_block_column_order || [];
  let first = true;
  for (const rid of rowIds) {
    const row = getBlock(recordMap, rid);
    if (!row || row.type !== 'table_row') continue;
    const cellsObj = row.properties || {};
    const cols = colOrder.length ? colOrder : Object.keys(cellsObj);
    const cells = cols.map((c) => renderInline(cellsObj[c], ctx).replace(/\|/g, '\\|') || '');
    lines.push(pad + '| ' + cells.join(' | ') + ' |');
    if (first) {
      lines.push(pad + '| ' + cells.map(() => '---').join(' | ') + ' |');
      first = false;
    }
  }
  lines.push('');
  return lines;
}

/**
 * 把一个公开 Notion 站点整站下载成 Markdown。
 *
 * @param {string} rootUrl  根页 URL（须为 Publish 公开状态）
 * @param {string} outDir   输出目录
 * @param {object} [options]
 * @param {number} [options.maxPages=500]        抓取页数上限
 * @param {number} [options.requestDelayMs=700]  每页之间的基础节流间隔(ms)
 * @param {number} [options.maxRequeue=5]        单页限流失败后最多重新入队次数
 * @param {(msg:string)=>void} [options.log]     普通日志回调（默认 console.log，传 () => {} 可静默）
 * @param {(msg:string)=>void} [options.warn]    警告日志回调（默认 console.warn）
 * @returns {Promise<{pages:number, images:number, failed:string[], outDir:string, indexFile:string}>}
 */
export async function crawlNotionSite(rootUrl, outDir, options = {}) {
  const {
    maxPages = 500,
    requestDelayMs = 700,
    maxRequeue = 5,
    log = console.log,
    warn = console.warn,
  } = options;

  if (!rootUrl) throw new Error('crawlNotionSite: rootUrl 必填');
  outDir = path.resolve(outDir || './docs');
  const assetsDir = path.join(outDir, 'assets');
  let siteHost = '';
  try { siteHost = new URL(rootUrl).host; } catch {}

  const rootId = parsePageId(rootUrl);
  if (!rootId) throw new Error(`无法从 URL 解析 pageId: ${rootUrl}`);

  await mkdir(assetsDir, { recursive: true });

  // 每次调用独立的图片去重表（可重入）
  const downloaded = new Map(); // url -> 本地相对路径
  const downloadAsset = async (url) => {
    if (!url) return null;
    if (downloaded.has(url)) return downloaded.get(url);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get('content-type') || '';
      let ext = '.bin';
      if (ct.includes('png')) ext = '.png';
      else if (ct.includes('jpeg') || ct.includes('jpg')) ext = '.jpg';
      else if (ct.includes('gif')) ext = '.gif';
      else if (ct.includes('webp')) ext = '.webp';
      else if (ct.includes('svg')) ext = '.svg';
      else {
        const m = url.split('?')[0].match(/\.(png|jpe?g|gif|webp|svg)$/i);
        if (m) ext = '.' + m[1].toLowerCase().replace('jpeg', 'jpg');
      }
      const name = createHash('md5').update(url).digest('hex').slice(0, 16) + ext;
      await writeFile(path.join(assetsDir, name), buf);
      const rel = `assets/${name}`;
      downloaded.set(url, rel);
      log(`  ↓ 图片 ${name} (${(buf.length / 1024).toFixed(0)}KB)`);
      return rel;
    } catch (err) {
      warn(`  图片下载失败 ${url}: ${err.message}`);
      return url; // 回退保留远程地址
    }
  };

  log(`根页 pageId: ${rootId}`);
  log(`输出目录: ${outDir}\n`);

  // 第一遍：BFS 抓取所有页面 recordMap
  const pages = new Map(); // pageId(clean) -> { recordMap, title, pageId }
  const queue = [rootId];
  const queued = new Set([uuidToId(rootId)]); // 已入队（避免重复 push）
  const seen = new Set();      // 已成功抓取
  const attempts = new Map();  // clean -> 已尝试次数
  const failed = new Set();    // 彻底放弃的页
  let coolStreak = 0;          // 连续失败计数，用于整体冷却

  while (queue.length && pages.size < maxPages) {
    const pid = queue.shift();
    const clean = uuidToId(pid);
    if (seen.has(clean) || failed.has(clean)) continue;

    log(`[${pages.size + 1}] 抓取 ${clean} ...`);
    let recordMap;
    try {
      recordMap = await getPageWithRetry(pid, { requestDelayMs, warn });
      coolStreak = 0;
    } catch (err) {
      if (err instanceof PermanentError) {
        warn(`  跳过 ${clean}（页面不存在/未发布）`);
        failed.add(clean);
        continue;
      }
      const n = (attempts.get(clean) || 0) + 1;
      attempts.set(clean, n);
      coolStreak++;
      if (n <= maxRequeue) {
        const cool = Math.min(3000 * coolStreak, 30000);
        warn(`  重新入队 ${clean}（第 ${n}/${maxRequeue} 次），整体冷却 ${cool}ms`);
        queue.push(pid);
        await sleep(cool);
      } else {
        warn(`  放弃 ${clean}（已重试 ${maxRequeue} 次）: ${err.message}`);
        failed.add(clean);
      }
      continue;
    }
    seen.add(clean);
    await sleep(requestDelayMs);

    // 标题
    let title = '';
    try { title = getPageTitle(recordMap); } catch {}
    if (!title) {
      const b = getBlock(recordMap, Object.keys(recordMap.block)[0]);
      title = b?.properties ? titleOf(b.properties) : '';
    }
    pages.set(clean, { recordMap, title: title || '未命名', pageId: pid });

    // 收集子页
    for (const childId of collectChildPageIds(recordMap, pid, siteHost)) {
      const cclean = uuidToId(childId);
      if (!seen.has(cclean) && !failed.has(cclean) && !queued.has(cclean)) {
        queued.add(cclean);
        queue.push(childId);
      }
    }
  }

  if (failed.size) warn(`\n⚠ 最终放弃 ${failed.size} 页: ${[...failed].join(', ')}`);
  log(`\n共发现 ${pages.size} 个页面，开始生成 Markdown...\n`);

  // 文件名分配（标题 slug + 短 id 保唯一）
  const fileFor = new Map(); // clean id -> 文件名
  for (const [clean, info] of pages) {
    const slug = slugify(info.title, clean);
    fileFor.set(clean, `${slug}-${clean.slice(0, 8)}.md`);
  }

  const titleFor = (rawId) => pages.get(uuidToId(rawId))?.title;
  const linkFor = (rawId) => {
    const clean = uuidToId(rawId);
    if (fileFor.has(clean)) return './' + fileFor.get(clean);
    return `https://www.notion.so/${clean}`; // 未抓到的页面 -> 指向原 notion 站点
  };
  const rewriteHref = (href) => {
    if (!href) return href;
    const m = href.match(/([0-9a-f]{32})/i);
    if (m) {
      const clean = uuidToId(m[1]);
      if (fileFor.has(clean)) return './' + fileFor.get(clean);
    }
    if (href.startsWith('/')) {
      const pm = parsePageId(href);
      if (pm && fileFor.has(uuidToId(pm))) return './' + fileFor.get(uuidToId(pm));
    }
    return href;
  };

  // 第二遍：渲染
  const ctx = { titleForPage: titleFor, linkForPage: linkFor, rewriteHref, downloadAsset };
  for (const [clean, info] of pages) {
    const rm = info.recordMap;
    const rootBlockId = Object.keys(rm.block).find((id) => uuidToId(id) === clean) || info.pageId;
    const rootBlock = getBlock(rm, rootBlockId);

    const body = [`# ${info.title}`, ''];
    if (rootBlock?.content?.length) {
      body.push(...(await renderBlocks(rootBlock.content, rm, ctx, 0)));
    } else if (rootBlock?.type === 'collection_view_page') {
      body.push(...renderCollection(rootBlock, rm, ctx, ''));
    }
    const md = body.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    await writeFile(path.join(outDir, fileFor.get(clean)), md);
    log(`✓ ${fileFor.get(clean)}  (${info.title})`);
  }

  // 总览索引
  const idxLines = ['# 站点总览', '', `> 根页: [${pages.get(uuidToId(rootId))?.title}](./${fileFor.get(uuidToId(rootId))})`, ''];
  for (const [clean, info] of pages) {
    idxLines.push(`- [${info.title}](./${fileFor.get(clean)})`);
  }
  const indexFile = path.join(outDir, '_index.md');
  await writeFile(indexFile, idxLines.join('\n') + '\n');

  log(`\n完成。共 ${pages.size} 页 -> ${outDir}`);
  log(`图片 ${downloaded.size} 张 -> ${assetsDir}`);
  log(`索引: ${indexFile}`);

  return {
    pages: pages.size,
    images: downloaded.size,
    failed: [...failed],
    outDir,
    indexFile,
  };
}

export default crawlNotionSite;
