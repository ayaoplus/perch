// X adapter — 从登录态 Chrome 的 DOM 抽 home / search / profile / list / status / longform。
//   - Timeline / status 内容来自真实 DOM
//   - Search pagination 走 X 内部 GraphQL runtime(如果能注入)
//   - 视频 stream URL 从 CDP Network 事件恢复(DOM 只有 blob:)
//   - Longform 文章从渲染后的 Draft.js 富文本树转成 Markdown

import { sleep } from './_utils.mjs';

const TIMELINE_WAIT_SELECTOR = 'main [data-testid="primaryColumn"] article[data-testid="tweet"]';
const SEARCH_WAIT_SELECTOR = 'main [data-testid="SearchBox_Search_Input"], main [role="tab"], main [data-testid="primaryColumn"] article[data-testid="tweet"], main [data-testid="primaryColumn"] [data-testid="UserCell"]';
const PROFILE_WAIT_SELECTOR = 'main [data-testid="primaryColumn"] [data-testid="UserName"], main [data-testid="primaryColumn"] article[data-testid="tweet"]';
const STATUS_WAIT_SELECTOR = 'main [data-testid="primaryColumn"] article[data-testid="tweet"], [data-testid="twitterArticleReadView"]';
const PROFILE_TAB_PATHS = new Set(['with_replies', 'articles', 'media']);
const RESERVED_PROFILE_SEGMENTS = new Set([
  'home',
  'explore',
  'notifications',
  'messages',
  'search',
  'settings',
  'compose',
  'login',
  'signup',
  'tos',
  'privacy',
  'i',
  'intent',
  'share',
  'download',
  'account',
  'about',
  'hashtag',
  'topics',
  'communities',
  'premium',
  'jobs',
  'help',
  'logout',
]);

function detectProfilePath(pathname) {
  const match = String(pathname || '').match(/^\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (!match) return null;

  const handle = match[1];
  const subpath = match[2] || '';
  if (!handle || RESERVED_PROFILE_SEGMENTS.has(handle.toLowerCase())) return null;
  if (!subpath) return { handle, tab: 'posts' };
  if (PROFILE_TAB_PATHS.has(subpath)) return { handle, tab: subpath };
  return null;
}

const BROWSER_COMMON_JS = String.raw`
const X_HOST_RE = /(^|\.)((x|twitter)\.com)$/i;

function textOrEmpty(node) {
  return node?.innerText?.trim() || '';
}

function absoluteUrl(url) {
  if (!url) return null;
  try {
    return new URL(url, location.origin).href;
  } catch {
    return null;
  }
}

function cleanUrl(url) {
  const full = absoluteUrl(url);
  if (!full) return null;
  try {
    const parsed = new URL(full);
    if (X_HOST_RE.test(parsed.hostname)) {
      const statusMatch = parsed.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
      if (statusMatch) {
        return parsed.origin + '/' + statusMatch[1] + '/status/' + statusMatch[2];
      }
      if (parsed.pathname === '/home') return parsed.origin + '/home';
      const listMatch = parsed.pathname.match(/^\/i\/lists\/(\d+)/);
      if (listMatch) return parsed.origin + '/i/lists/' + listMatch[1];
    }
    return parsed.href;
  } catch {
    return full;
  }
}

function isContentUrl(url) {
  if (!url) return false;
  if (url.startsWith('blob:')) return false;
  if (url.startsWith('chrome-extension:')) return false;
  return /^https?:/i.test(url);
}

function isImageUrl(url) {
  return isContentUrl(url) && !/emoji\/v2\//i.test(url) && !/profile_images/i.test(url);
}

function isExternalLink(url) {
  const full = absoluteUrl(url);
  if (!full) return false;
  try {
    const parsed = new URL(full);
    return !X_HOST_RE.test(parsed.hostname);
  } catch {
    return false;
  }
}

function parseUserBlock(blockText) {
  const lines = String(blockText || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  const handle = lines.find(line => line.startsWith('@')) || '';
  const name = lines.find(line => line && line !== handle) || '';
  return { name, handle, raw: blockText || '' };
}

function dedupe(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function urlPathname(url) {
  const full = absoluteUrl(url);
  if (!full) return '';
  try {
    return new URL(full).pathname;
  } catch {
    return '';
  }
}

function styleUrl(value) {
  const match = String(value || '').match(/url\\((['"]?)(.*?)\\1\\)/i);
  return absoluteUrl(match?.[2] || '');
}

function getTabs(root) {
  return Array.from(root.querySelectorAll('[role="tab"]'))
    .map(tab => {
      const anchor = tab.matches('a[href]') ? tab : tab.querySelector('a[href]');
      return {
        label: textOrEmpty(tab),
        selected: tab.getAttribute('aria-selected') === 'true',
        url: absoluteUrl(anchor?.href || anchor?.getAttribute('href') || ''),
      };
    })
    .filter(tab => tab.label);
}

function normalizeSearchMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'top') return 'top';
  if (raw === 'live') return 'latest';
  if (raw === 'user') return 'users';
  if (raw === 'media') return 'media';
  if (raw === 'list') return 'lists';
  return raw;
}

function getStatusLinks(article) {
  const links = Array.from(article.querySelectorAll('a[href]'))
    .map(a => absoluteUrl(a.href))
    .filter(Boolean);
  return dedupe(
    links
      .filter(url => /\/status\/\d+/i.test(url))
      .map(cleanUrl)
      .filter(url => url && !/\/status\/\d+\/(photo|video|analytics)/i.test(url))
  );
}

function getMetrics(article) {
  return Array.from(article.querySelectorAll('[data-testid="reply"], [data-testid="retweet"], [data-testid="unretweet"], [data-testid="like"], [data-testid="unlike"], [data-testid="bookmark"], [data-testid="removeBookmark"]'))
    .map(el => ({
      name: el.getAttribute('data-testid') || '',
      display: textOrEmpty(el),
      ariaLabel: el.getAttribute('aria-label') || '',
    }));
}

function getViewMetric(article) {
  const link = Array.from(article.querySelectorAll('a[href]'))
    .find(a => /\/status\/\d+\/analytics$/i.test(a.href));
  if (!link) return null;
  return {
    display: textOrEmpty(link),
    ariaLabel: link.getAttribute('aria-label') || '',
    url: absoluteUrl(link.href),
  };
}

function getMedia(article) {
  const images = dedupe(
    Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img'))
      .map(img => absoluteUrl(img.currentSrc || img.src))
      .filter(isImageUrl)
  );

  const videos = Array.from(article.querySelectorAll('video')).map(video => ({
    currentSrc: absoluteUrl(video.currentSrc || ''),
    src: absoluteUrl(video.getAttribute('src') || ''),
    poster: absoluteUrl(video.getAttribute('poster') || ''),
    sources: dedupe(
      Array.from(video.querySelectorAll('source'))
        .map(source => absoluteUrl(source.src || source.getAttribute('src') || ''))
        .filter(Boolean)
    ),
  }));

  const articleCoverImages = dedupe(
    Array.from(article.querySelectorAll('[data-testid="article-cover-image"] img'))
      .map(img => absoluteUrl(img.currentSrc || img.src))
      .filter(isImageUrl)
  );

  return {
    images,
    videos,
    articleCoverImages,
    hasVideo: videos.length > 0,
  };
}

function getExternalCard(article) {
  const wrapper = article.querySelector('[data-testid="card.wrapper"]');
  if (!wrapper) return null;

  const links = dedupe(
    Array.from(wrapper.querySelectorAll('a[href]'))
      .map(a => absoluteUrl(a.href))
      .filter(Boolean)
  );

  const externalUrl = links.find(isExternalLink) || links[0] || null;
  const labels = Array.from(wrapper.querySelectorAll('a[href], span, div'))
    .map(node => textOrEmpty(node))
    .filter(Boolean);

  return {
    url: externalUrl,
    links,
    text: textOrEmpty(wrapper),
    labels: dedupe(labels).slice(0, 12),
  };
}

function getQuotedPreview(article, primaryStatusUrl) {
  const userBlocks = Array.from(article.querySelectorAll('[data-testid="User-Name"]'))
    .map(node => parseUserBlock(textOrEmpty(node)))
    .filter(user => user.name || user.handle);

  const textBlocks = Array.from(article.querySelectorAll('[data-testid="tweetText"]'))
    .map(node => textOrEmpty(node))
    .filter(Boolean);

  const statusLinks = getStatusLinks(article).filter(url => url !== primaryStatusUrl);

  if (userBlocks.length <= 1 && textBlocks.length <= 1 && statusLinks.length === 0) {
    return null;
  }

  return {
    authors: userBlocks.slice(1),
    texts: textBlocks.slice(1),
    statusUrls: statusLinks,
  };
}

function detectEntryType(item) {
  if (item.longformPreview) return 'article_preview';
  if (item.media.hasVideo) return 'video_tweet';
  if (item.media.images.length > 0) return 'photo_tweet';
  if (item.externalCard?.url) return 'link_card';
  return 'tweet';
}

function extractTweetText(article) {
  const blocks = Array.from(article.querySelectorAll('[data-testid="tweetText"]'))
    .map(node => textOrEmpty(node))
    .filter(Boolean);
  return {
    text: blocks[0] || '',
    blocks,
  };
}

function extractLongformPreview(article) {
  if (article.querySelector('[data-testid="twitterArticleReadView"]')) return null;
  if (!article.querySelector('[data-testid="article-cover-image"]')) return null;
  const text = textOrEmpty(article);
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const markerIndex = lines.findIndex(line => ['文章', 'Article'].includes(line));
  const previewLines = lines.slice(markerIndex >= 0 ? markerIndex + 1 : 4, markerIndex >= 0 ? markerIndex + 8 : 12);
  return {
    title: previewLines[0] || '',
    excerpt: previewLines.slice(1).join('\n'),
  };
}

// 识别 article 顶部的 "xxx reposted" social context(纯 RT)。
// X 的 socialContext 也用于"关注推荐 / 点赞推荐"等场景,所以按文本关键词过滤只保留 repost。
// Quote tweet 不会有 reposted 的 socialContext(它的评论层本身就是外层推文)。
function extractSocialContext(article) {
  const sc = article.querySelector('[data-testid="socialContext"]');
  if (!sc) return null;
  const raw = textOrEmpty(sc);
  if (!/reposted|转推|转帖|转发了?/i.test(raw)) return null;
  const anchor = sc.querySelector('a[href]');
  let handle = null;
  if (anchor) {
    const href = anchor.getAttribute('href') || '';
    const m = href.match(/^\/([^\/\?#]+)/);
    if (m) handle = '@' + m[1];
  }
  const nameMatch = raw.match(/^(.+?)\s*(?:reposted|转推|转帖|转发了?)/i);
  const name = nameMatch ? nameMatch[1].trim() : '';
  return { type: 'repost', handle, name, rawText: raw };
}

function extractTimelineItem(article, index) {
  const statusLinks = getStatusLinks(article);
  const primaryStatusUrl = statusLinks[0] || null;
  const userBlocks = Array.from(article.querySelectorAll('[data-testid="User-Name"]'))
    .map(node => parseUserBlock(textOrEmpty(node)))
    .filter(user => user.name || user.handle);
  const author = userBlocks[0] || { name: '', handle: '', raw: '' };
  const timeNode = article.querySelector('time');
  const tweetText = extractTweetText(article);
  const metrics = getMetrics(article);
  const viewMetric = getViewMetric(article);
  const media = getMedia(article);
  const externalCard = getExternalCard(article);
  const longformPreview = extractLongformPreview(article);
  const socialContext = extractSocialContext(article);

  return {
    index,
    statusUrl: primaryStatusUrl,
    statusId: primaryStatusUrl?.match(/\/status\/(\d+)/)?.[1] || null,
    author,
    authoredAt: {
      text: timeNode?.innerText?.trim() || '',
      dateTime: timeNode?.dateTime || '',
    },
    text: tweetText.text,
    textBlocks: tweetText.blocks,
    isTruncated: !!article.querySelector('[data-testid="tweet-text-show-more-link"]'),
    metrics,
    viewMetric,
    media,
    externalCard,
    longformPreview,
    socialContext,
    quotedTweet: getQuotedPreview(article, primaryStatusUrl),
    entryType: 'tweet',
  };
}

function extractTimelineItems(limit) {
  const primary = document.querySelector('main [data-testid="primaryColumn"]') || document.querySelector('main') || document.body;
  const articles = Array.from(primary.querySelectorAll('article[data-testid="tweet"]'));
  const items = [];
  const seen = new Set();

  for (const article of articles) {
    const item = extractTimelineItem(article, items.length);
    const key = item.statusId || item.statusUrl || (item.author.handle + ':' + item.text.slice(0, 80));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    item.entryType = detectEntryType(item);
    items.push(item);
    if (items.length >= limit) break;
  }

  return items;
}

function extractHomeMeta() {
  const primary = document.querySelector('main [data-testid="primaryColumn"]') || document.querySelector('main') || document.body;
  const tabs = getTabs(primary);
  return {
    tabs,
    selectedTab: tabs.find(tab => tab.selected)?.label || null,
  };
}

function extractSearchMeta() {
  const primary = document.querySelector('main [data-testid="primaryColumn"]') || document.querySelector('main') || document.body;
  const params = new URLSearchParams(location.search);
  const tabs = getTabs(primary);
  const queryInput = document.querySelector('[data-testid="SearchBox_Search_Input"]');
  const rawMode = params.get('f') || 'top';

  return {
    query: queryInput?.value || params.get('q') || '',
    rawQuery: params.get('q') || '',
    mode: normalizeSearchMode(rawMode),
    rawMode,
    url: location.href,
    tabs,
    selectedTab: tabs.find(tab => tab.selected)?.label || null,
    selectedTabUrl: tabs.find(tab => tab.selected)?.url || null,
  };
}

function extractListMeta() {
  const primary = document.querySelector('main [data-testid="primaryColumn"]') || document.querySelector('main') || document.body;

  const anchors = Array.from(primary.querySelectorAll('a[href]'));
  const membersLink = anchors.find(anchor => /\/i\/lists\/\d+\/members$/i.test(anchor.href));
  const followersLink = anchors.find(anchor => /\/i\/lists\/\d+\/followers$/i.test(anchor.href));

  // 首选:直接从 DOM 抽 list name 和 owner — 比 innerText 启发式稳定得多。
  // X list header 里 list name 用 <h2 role="heading" aria-level="2">,
  // owner 链接是 header 区(非 article 内)指向 /<handle> 的 a[href]。
  const headerHeading = Array.from(primary.querySelectorAll('h2[role="heading"][aria-level="2"], h2'))
    .find(h => !h.closest('article[data-testid="tweet"]'));
  let listName = (headerHeading?.innerText || '').trim();

  const profileAnchors = Array.from(primary.querySelectorAll('a[href]'))
    .filter(a => !a.closest('article[data-testid="tweet"]'))
    .filter(a => /^\/[^\/?#]+$/.test(a.getAttribute('href') || ''));
  const handleAnchor = profileAnchors.find(a => /^@/.test((a.innerText || '').trim()));
  const nameAnchor = handleAnchor
    ? profileAnchors.find(a => a.getAttribute('href') === handleAnchor.getAttribute('href') && !/^@/.test((a.innerText || '').trim()))
    : null;
  let ownerHandle = (handleAnchor?.innerText || '').trim();
  let ownerName = (nameAnchor?.innerText || '').trim();

  // Fallback:innerText 启发式(只在 DOM 抽失败时用),兼容 X 未来可能的 DOM 变动。
  if (!listName || !ownerHandle) {
    const lines = textOrEmpty(primary)
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .slice(0, 20);
    const isGeneric = (line) => /^(列表|List|Posts|查看新帖子|See new posts|关注|Following|Follow|成员|Members|关注者|Followers)$/i.test(line);
    const membersIndex = lines.findIndex(line => /(成员|Members)/i.test(line));
    if (!ownerHandle) {
      ownerHandle = membersIndex >= 0
        ? [...lines.slice(0, membersIndex)].reverse().find(line => line.startsWith('@')) || ''
        : lines.find(line => line.startsWith('@')) || '';
    }
    if (!listName) {
      const handleIndex = ownerHandle ? lines.lastIndexOf(ownerHandle) : -1;
      if (handleIndex > 0 && !ownerName) {
        ownerName = [...lines.slice(0, handleIndex)].reverse().find(line => !line.startsWith('@') && !isGeneric(line) && !/(成员|Members|关注者|Followers)/i.test(line)) || '';
      }
      // 取 ownerName 之前那一行作为 listName;找不到 ownerName 就退回最前的非 @ 非 generic 行
      const nameIndex = ownerName ? lines.indexOf(ownerName) : -1;
      listName = nameIndex > 0
        ? [...lines.slice(0, nameIndex)].reverse().find(line => !line.startsWith('@') && !isGeneric(line)) || ''
        : lines.find(line => !line.startsWith('@') && !isGeneric(line)) || '';
    }
  }

  const ownerProfileAnchor = anchors.find(anchor => cleanUrl(anchor.href) === ('https://x.com/' + ownerHandle.replace(/^@/, '')));

  return {
    name: listName,
    ownerName,
    ownerHandle,
    ownerUrl: cleanUrl(ownerProfileAnchor?.href || ''),
    members: {
      text: textOrEmpty(membersLink),
      url: absoluteUrl(membersLink?.href || ''),
    },
    followers: {
      text: textOrEmpty(followersLink),
      url: absoluteUrl(followersLink?.href || ''),
    },
  };
}

function extractProfileMeta() {
  const primary = document.querySelector('main [data-testid="primaryColumn"]') || document.querySelector('main') || document.body;
  const anchors = Array.from(primary.querySelectorAll('a[href]'));
  const nameBlock = primary.querySelector('[data-testid="UserName"]');
  const owner = parseUserBlock(textOrEmpty(nameBlock));
  const tabs = getTabs(primary);
  const findAnchor = (pattern) => anchors.find(anchor => pattern.test(urlPathname(anchor.href || anchor.getAttribute('href') || '')));
  const followAction = primary.querySelector('[data-testid="placementTracking"] button')
    || primary.querySelector('[data-testid$="-unfollow"], [data-testid$="-follow"]');
  const avatarImage = primary.querySelector('a[href$="/photo"] img')
    || primary.querySelector('[data-testid^="UserAvatar-Container-"] img');
  const headerPhotoLink = findAnchor(/\/[^/]+\/header_photo$/i);
  const headerMediaNode = headerPhotoLink
    ? Array.from(headerPhotoLink.querySelectorAll('[style]')).find(node => /background-image/i.test(node.getAttribute('style') || ''))
    : null;
  const websiteNode = primary.querySelector('[data-testid="UserUrl"]');
  const joinedNode = primary.querySelector('[data-testid="UserJoinDate"]');
  const primaryText = textOrEmpty(primary);
  const postCountMatch = primaryText.match(/([\d,.]+(?:\.\d+)?\s*[kKmMbB万亿]?)\s*(帖子|Posts)/i);
  const actionTestId = followAction?.getAttribute('data-testid') || '';
  const followingLink = findAnchor(/\/[^/]+\/following$/i);
  const followersLink = findAnchor(/\/[^/]+\/(?:followers|verified_followers)$/i);
  const followersYouKnowLink = findAnchor(/\/[^/]+\/followers_you_follow$/i);

  return {
    name: owner.name,
    handle: owner.handle,
    url: location.origin + location.pathname,
    bio: textOrEmpty(primary.querySelector('[data-testid="UserDescription"]')),
    professionalCategory: textOrEmpty(primary.querySelector('[data-testid="UserProfessionalCategory"]')),
    location: textOrEmpty(primary.querySelector('[data-testid="UserLocation"]')),
    website: {
      text: textOrEmpty(websiteNode),
      url: absoluteUrl(websiteNode?.href || websiteNode?.getAttribute('href') || ''),
    },
    joined: {
      text: textOrEmpty(joinedNode),
      url: absoluteUrl(joinedNode?.href || joinedNode?.getAttribute('href') || ''),
    },
    avatarUrl: absoluteUrl(avatarImage?.currentSrc || avatarImage?.src || avatarImage?.getAttribute('src') || ''),
    headerImageUrl: styleUrl(headerMediaNode?.style?.backgroundImage || headerMediaNode?.getAttribute('style') || ''),
    postCountText: postCountMatch ? postCountMatch[0] : '',
    following: {
      text: textOrEmpty(followingLink),
      url: absoluteUrl(followingLink?.href || ''),
    },
    followers: {
      text: textOrEmpty(followersLink),
      url: absoluteUrl(followersLink?.href || ''),
    },
    followersYouKnow: {
      text: textOrEmpty(followersYouKnowLink),
      url: absoluteUrl(followersYouKnowLink?.href || ''),
    },
    isVerified: !!nameBlock?.querySelector('[data-testid="icon-verified"]'),
    isProtected: !!nameBlock?.querySelector('[data-testid="icon-lock"]'),
    relationship: {
      following: actionTestId
        ? /-unfollow$/i.test(actionTestId)
        : (textOrEmpty(followAction) ? /正在关注|Following/i.test(textOrEmpty(followAction)) : null),
      actionLabel: textOrEmpty(followAction),
    },
    tabs,
    selectedTab: tabs.find(tab => tab.selected)?.label || null,
  };
}

function escapeMarkdown(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/([*_\`[\]])/g, '\\$1');
}

function inlineMarkdown(node) {
  if (!node) return '';

  if (node.nodeType === Node.TEXT_NODE) {
    return escapeMarkdown(node.textContent || '');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  if (node.tagName === 'BR') return '\n';

  if (node.tagName === 'IMG') {
    const src = absoluteUrl(node.currentSrc || node.src || node.getAttribute('src') || '');
    return src ? '![' + escapeMarkdown(node.alt || 'image') + '](' + src + ')' : '';
  }

  let text = Array.from(node.childNodes).map(inlineMarkdown).join('');
  const tag = node.tagName;
  const weight = String(node.style?.fontWeight || '').toLowerCase();
  const isBold = tag === 'B' || tag === 'STRONG' || weight === 'bold' || Number(weight) >= 600;
  const isItalic = tag === 'I' || tag === 'EM';

  if (tag === 'A') {
    const href = absoluteUrl(node.href || node.getAttribute('href') || '');
    const label = text.trim() || href || '';
    return href ? '[' + label + '](' + href + ')' : label;
  }

  if (tag === 'CODE' && !node.closest('[data-testid="markdown-code-block"]')) {
    return '\`' + text.replace(/\`/g, '\\\`') + '\`';
  }

  text = text.replace(/\u00a0/g, ' ');

  if (isBold && text.trim()) text = '**' + text.trim() + '**';
  if (isItalic && text.trim()) text = '*' + text.trim() + '*';

  return text;
}

function prefixLines(text, prefix) {
  return String(text || '')
    .split('\n')
    .map(line => line ? prefix + line : prefix.trimEnd())
    .join('\n');
}

function codeBlockMarkdown(node) {
  const raw = textOrEmpty(node);
  if (!raw) return '';

  const lines = raw.split('\n');
  let language = '';
  let bodyLines = lines;

  if (lines[0] && /^[a-z0-9_+-]{1,24}$/i.test(lines[0].trim())) {
    language = lines[0].trim();
    bodyLines = lines.slice(1);
  }

  const body = bodyLines.join('\n').replace(/\n+$/, '');
  return '\`\`\`' + language + '\n' + body + '\n\`\`\`';
}

function listMarkdown(node, ordered) {
  const items = Array.from(node.children)
    .filter(child => child.tagName === 'LI')
    .map((child, index) => {
      const content = inlineMarkdown(child).trim();
      if (!content) return '';
      const marker = ordered ? String(index + 1) + '. ' : '- ';
      return prefixLines(content, marker);
    })
    .filter(Boolean);
  return items.join('\n');
}

function childMarkdown(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return '';

  if (node.matches('[data-testid="markdown-code-block"]')) {
    return codeBlockMarkdown(node);
  }

  const tag = node.tagName;

  if (/^H[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    return '#'.repeat(level) + ' ' + inlineMarkdown(node).trim();
  }

  if (tag === 'UL') return listMarkdown(node, false);
  if (tag === 'OL') return listMarkdown(node, true);
  if (tag === 'BLOCKQUOTE') {
    const inner = Array.from(node.children).map(childMarkdown).filter(Boolean).join('\n\n') || inlineMarkdown(node).trim();
    return inner ? prefixLines(inner, '> ') : '';
  }
  if (tag === 'IMG') return inlineMarkdown(node);
  if (tag === 'HR') return '---';
  if (tag === 'PRE') return '\`\`\`\n' + textOrEmpty(node) + '\n\`\`\`';

  const nestedCodeBlock = node.matches('[data-testid="markdown-code-block"]')
    ? node
    : node.querySelector('[data-testid="markdown-code-block"]');
  if (nestedCodeBlock) {
    return codeBlockMarkdown(nestedCodeBlock);
  }

  const directText = inlineMarkdown(node).trim();
  const children = Array.from(node.children);
  const hasSemanticChildren = children.some(child => child.matches && child.matches('h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, hr, [data-testid="markdown-code-block"]'));
  if (!hasSemanticChildren) return directText;

  const blockChildren = children.map(childMarkdown).filter(Boolean);
  if (blockChildren.length > 0) return blockChildren.join('\n\n');

  return directText;
}

function extractLongformArticle(article) {
  const readView = article.querySelector('[data-testid="twitterArticleReadView"]');
  if (!readView) return null;

  const title = textOrEmpty(article.querySelector('[data-testid="twitter-article-title"]'));
  const rich = article.querySelector('[data-testid="twitterArticleRichTextView"]');
  const contents = rich?.querySelector('[data-contents="true"]') || rich;

  const blocks = Array.from(contents?.children || []).map(childMarkdown).filter(Boolean);
  const markdown = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();

  const headings = Array.from(article.querySelectorAll('[data-testid="twitterArticleRichTextView"] h1, [data-testid="twitterArticleRichTextView"] h2, [data-testid="twitterArticleRichTextView"] h3, [data-testid="twitterArticleRichTextView"] h4, [data-testid="twitterArticleRichTextView"] h5, [data-testid="twitterArticleRichTextView"] h6'))
    .map(node => ({
      level: Number(node.tagName.slice(1)),
      text: textOrEmpty(node),
    }))
    .filter(item => item.text);

  const images = dedupe(
    Array.from(article.querySelectorAll('[data-testid="twitterArticleRichTextView"] img'))
      .map(img => absoluteUrl(img.currentSrc || img.src || img.getAttribute('src') || ''))
      .filter(isImageUrl)
  );

  const links = dedupe(
    Array.from(article.querySelectorAll('[data-testid="twitterArticleRichTextView"] a[href]'))
      .map(anchor => absoluteUrl(anchor.href || anchor.getAttribute('href') || ''))
      .filter(Boolean)
  );

  return {
    title,
    markdown,
    headings,
    images,
    links,
    codeBlockCount: article.querySelectorAll('[data-testid="markdown-code-block"]').length,
    textLength: markdown.length,
  };
}
`;

const BROWSER_SEARCH_API_JS = String.raw`
function firstTruthy(...values) {
  for (const value of values) {
    if (value) return value;
  }
  return null;
}

function getReactRootFiber() {
  const candidates = [document.querySelector('#react-root'), document.body, document.documentElement].filter(Boolean);
  for (const node of candidates) {
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object' && ('memoizedProps' in value || 'child' in value || 'memoizedState' in value)) {
        return value;
      }
    }
  }
  return null;
}

function getRuntimePropsFiber() {
  const root = getReactRootFiber();
  if (!root) return null;

  let match = null;
  const seen = new Set();

  const walk = (fiber) => {
    if (!fiber || seen.has(fiber) || match) return;
    seen.add(fiber);
    const props = fiber.memoizedProps;
    if (props && props.store && props.featureSwitches) {
      match = fiber;
      return;
    }
    walk(fiber.child);
    walk(fiber.sibling);
  };

  walk(root);
  return match;
}

function getRuntimeContext() {
  const fiber = getRuntimePropsFiber();
  const store = fiber?.memoizedProps?.store || null;
  const featureSwitches = fiber?.memoizedProps?.featureSwitches || null;
  const state = store?.getState?.() || null;
  if (!store || !state) return null;

  let req = null;
  if (typeof webpackChunk_twitter_responsive_web === 'undefined') {
    return { store, featureSwitches, state, req: null, runtime: null, endpoint: null };
  }

  webpackChunk_twitter_responsive_web.push([[Symbol('probe')], {}, r => { req = r; }]);

  const runtimeFactory = req?.(82953)?.T;
  const endpointFactory = req?.(796205)?.Z;
  if (typeof runtimeFactory !== 'function') {
    return { store, featureSwitches, state, req, runtime: null, endpoint: null };
  }

  const loggedInUserId = firstTruthy(
    state?.session?.user_id,
    state?.session?.userId,
    state?.session?.user?.id_str,
    state?.session?.loggedInUserId
  );

  const runtime = runtimeFactory({
    initialState: state,
    originalStore: store,
    loggedInUserId,
  });

  return {
    store,
    state,
    req,
    runtime,
    featureSwitches: runtime?.featureSwitches || featureSwitches,
    endpoint: runtime?.api?.withEndpoint && typeof endpointFactory === 'function'
      ? runtime.api.withEndpoint(endpointFactory)
      : null,
  };
}

function searchProductFromMode(mode) {
  const normalized = normalizeSearchMode(mode);
  if (normalized === 'latest') return 'Latest';
  if (normalized === 'media') return 'Media';
  if (normalized === 'users') return 'People';
  if (normalized === 'lists') return 'Lists';
  return 'Top';
}

function normalizeSearchQuerySource(value) {
  const raw = String(value || '').trim();
  return raw || 'typed_query';
}

function unwrapTweetResult(result) {
  if (!result) return null;
  if (result.result) return unwrapTweetResult(result.result);
  if (result.tweet) return unwrapTweetResult(result.tweet);
  if (result.__typename === 'TweetWithVisibilityResults') return unwrapTweetResult(result.tweet);
  if (/Tombstone|Unavailable/i.test(String(result.__typename || ''))) return null;
  return result;
}

function unwrapUserResult(result) {
  if (!result) return null;
  if (result.result) return unwrapUserResult(result.result);
  if (/Unavailable/i.test(String(result.__typename || ''))) return null;
  return result;
}

function sliceDisplayText(text, range) {
  if (!text) return '';
  if (!Array.isArray(range) || range.length < 2) return text;
  const chars = Array.from(String(text));
  return chars.slice(range[0], range[1]).join('');
}

function extractSearchTweetText(tweet) {
  const noteText = tweet?.note_tweet?.note_tweet_results?.result?.text
    || tweet?.note_tweet?.note_tweet_results?.result?.note_tweet?.text
    || '';
  if (noteText) return noteText.trim();

  const legacy = tweet?.legacy || {};
  const ranged = sliceDisplayText(legacy.full_text || '', legacy.display_text_range);
  return String(ranged || legacy.full_text || '').trim();
}

function normalizeSearchAuthor(user) {
  const name = firstTruthy(user?.core?.name, user?.legacy?.name, '') || '';
  const screenName = firstTruthy(user?.core?.screen_name, user?.legacy?.screen_name, '') || '';
  const handle = screenName ? '@' + screenName.replace(/^@/, '') : '';
  return {
    name,
    handle,
    raw: [name, handle].filter(Boolean).join('\n'),
  };
}

function buildSearchMetric(key, numeric) {
  const value = Number(numeric || 0);
  return {
    key,
    display: String(value),
    numeric: value,
    ariaLabel: '',
  };
}

function normalizeSearchMedia(tweet) {
  const mediaEntities = tweet?.legacy?.extended_entities?.media
    || tweet?.legacy?.entities?.media
    || [];

  const images = dedupe(
    mediaEntities
      .filter(media => media?.type === 'photo')
      .map(media => absoluteUrl(media.media_url_https || media.media_url || ''))
      .filter(isImageUrl)
  );

  const videos = mediaEntities
    .filter(media => media?.type === 'video' || media?.type === 'animated_gif')
    .map(media => {
      const variants = dedupe(
        (media?.video_info?.variants || [])
          .map(variant => absoluteUrl(variant?.url || ''))
          .filter(Boolean)
      );
      const playable = dedupe(variants.filter(url => /m3u8|mp4/i.test(url)));
      return {
        poster: absoluteUrl(media.media_url_https || media.media_url || ''),
        blobUrl: null,
        sources: variants,
        streamUrls: playable,
      };
    });

  return {
    images,
    articleCoverImages: [],
    hasVideo: videos.length > 0,
    videos,
  };
}

function normalizeSearchExternalCard(tweet, primaryStatusUrl) {
  const urls = dedupe(
    (tweet?.legacy?.entities?.urls || [])
      .map(entity => absoluteUrl(entity?.expanded_url || entity?.expanded_url_https || entity?.url || ''))
      .filter(Boolean)
      .filter(url => url !== primaryStatusUrl)
  );

  const externalUrl = urls.find(isExternalLink) || null;
  if (!externalUrl) return null;

  return {
    url: externalUrl,
    links: urls,
    text: '',
    labels: dedupe(
      (tweet?.legacy?.entities?.urls || [])
        .flatMap(entity => [entity?.display_url, entity?.expanded_url])
        .filter(Boolean)
    ).slice(0, 12),
  };
}

function normalizeSearchQuotedTweet(tweet, primaryStatusUrl) {
  const quoted = unwrapTweetResult(tweet?.quoted_status_result?.result);
  if (!quoted) return null;

  const author = normalizeSearchAuthor(unwrapUserResult(quoted?.core?.user_results?.result));
  const text = extractSearchTweetText(quoted);
  const statusUrl = author.handle && quoted?.rest_id
    ? cleanUrl(location.origin + '/' + author.handle.replace(/^@/, '') + '/status/' + quoted.rest_id)
    : null;

  return {
    authors: (author.name || author.handle) ? [{ name: author.name, handle: author.handle, raw: author.raw }] : [],
    texts: text ? [text] : [],
    statusUrls: dedupe(statusUrl && statusUrl !== primaryStatusUrl ? [statusUrl] : []),
  };
}

function normalizeSearchTweetItem(tweet) {
  const normalizedTweet = unwrapTweetResult(tweet);
  if (!normalizedTweet?.rest_id) return null;

  const legacy = normalizedTweet.legacy || {};
  const author = normalizeSearchAuthor(unwrapUserResult(normalizedTweet?.core?.user_results?.result));
  const statusUrl = author.handle
    ? cleanUrl(location.origin + '/' + author.handle.replace(/^@/, '') + '/status/' + normalizedTweet.rest_id)
    : null;
  const text = extractSearchTweetText(normalizedTweet);
  const media = normalizeSearchMedia(normalizedTweet);
  const externalCard = normalizeSearchExternalCard(normalizedTweet, statusUrl);
  const createdAt = legacy.created_at ? new Date(legacy.created_at) : null;

  const item = {
    statusUrl,
    statusId: normalizedTweet.rest_id || legacy.id_str || null,
    author: {
      name: author.name,
      handle: author.handle,
      raw: author.raw,
    },
    authoredAt: {
      text: legacy.created_at || '',
      dateTime: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toISOString() : '',
    },
    text,
    textBlocks: text ? [text] : [],
    isTruncated: !!normalizedTweet?.note_tweet,
    metrics: {
      reply: buildSearchMetric('reply', legacy.reply_count),
      retweet: buildSearchMetric('retweet', legacy.retweet_count),
      like: buildSearchMetric('like', legacy.favorite_count),
      bookmark: buildSearchMetric('bookmark', legacy.bookmark_count),
      quote: buildSearchMetric('quote', legacy.quote_count),
    },
    views: normalizedTweet?.views?.count
      ? {
          display: String(Number(normalizedTweet.views.count || 0)),
          numeric: Number(normalizedTweet.views.count || 0),
          url: statusUrl ? statusUrl + '/analytics' : null,
        }
      : null,
    media,
    externalCard,
    quotedTweet: normalizeSearchQuotedTweet(normalizedTweet, statusUrl),
    longformPreview: null,
    entryType: 'tweet',
  };

  if (item.media.hasVideo) item.entryType = 'video_tweet';
  else if (item.media.images.length > 0) item.entryType = 'photo_tweet';
  else if (item.externalCard?.url) item.entryType = 'link_card';

  return item;
}

function extractBottomCursorFromEntries(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.content?.cursorType === 'Bottom' && entry.content.value) {
      return entry.content.value;
    }
  }
  return null;
}

function parseTimelineInstructions(instructions) {
  const entries = [];
  let bottomCursor = null;

  for (const instruction of instructions || []) {
    if (Array.isArray(instruction?.entries)) {
      entries.push(...instruction.entries);
      if (!bottomCursor) bottomCursor = extractBottomCursorFromEntries(instruction.entries);
    }

    if (instruction?.entry?.content?.cursorType === 'Bottom' && instruction.entry.content.value) {
      bottomCursor = instruction.entry.content.value;
    }
  }

  return { entries, bottomCursor };
}

function getCurrentSearchTimeline(store) {
  const state = store?.getState?.();
  const timelines = Object.entries(state?.urt || {})
    .filter(([, timeline]) => timeline?.timelineType === 'search' && Array.isArray(timeline?.entries))
    .sort((left, right) => (right[1]?.lastFetchTimestamp || 0) - (left[1]?.lastFetchTimestamp || 0));

  if (!timelines.length) return null;

  const [timelineId, timeline] = timelines[0];
  return {
    timelineId,
    entries: timeline.entries || [],
    bottomCursor: extractBottomCursorFromEntries(timeline.entries || []),
  };
}

async function fetchSearchTimelineItems(options) {
  const query = String(options?.query || '').trim();
  const mode = normalizeSearchMode(options?.mode || 'top');
  const querySource = normalizeSearchQuerySource(options?.querySource);
  const limit = Math.max(1, Math.min(Number(options?.limit || 10), 200));

  const context = getRuntimeContext();
  if (!context?.store) {
    return { items: [], error: 'search_runtime_unavailable', strategy: 'none', pageCount: 0 };
  }

  const items = [];
  const seen = new Set();
  const pushTweet = (tweet) => {
    const item = normalizeSearchTweetItem(tweet);
    const key = item?.statusId || item?.statusUrl || ((item?.author?.handle || '') + ':' + String(item?.text || '').slice(0, 80));
    if (!item || !key || seen.has(key)) return false;
    seen.add(key);
    items.push(item);
    return true;
  };

  let pageCount = 0;
  let cursor = null;

  const initialTimeline = getCurrentSearchTimeline(context.store);
  if (initialTimeline?.entries?.length) {
    for (const entry of initialTimeline.entries) {
      const tweet = unwrapTweetResult(entry?.content?.itemContent?.tweet_results?.result);
      if (!tweet) continue;
      pushTweet(tweet);
      if (items.length >= limit) break;
    }
    cursor = initialTimeline.bottomCursor;
    pageCount += 1;
  }

  const endpoint = context.endpoint;
  const maxPages = Math.max(2, Math.ceil(limit / 20) + 2);
  let apiPages = 0;

  while (items.length < limit && endpoint && apiPages < maxPages) {
    const response = await endpoint.fetchSearchGraphQL({
      rawQuery: query,
      count: 20,
      product: searchProductFromMode(mode),
      querySource,
      cursor: cursor || undefined,
    });

    apiPages += 1;
    pageCount += 1;

    const parsed = parseTimelineInstructions(response?.instructions || []);
    let added = 0;

    for (const entry of parsed.entries) {
      const tweet = unwrapTweetResult(entry?.content?.itemContent?.tweet_results?.result);
      if (!tweet) continue;
      if (pushTweet(tweet)) added += 1;
      if (items.length >= limit) break;
    }

    if (!parsed.bottomCursor || parsed.bottomCursor === cursor) break;
    if (added === 0 && !parsed.bottomCursor) break;
    cursor = parsed.bottomCursor;
  }

  return {
    items: items.slice(0, limit),
    strategy: endpoint ? 'graphql_internal' : 'store_only',
    pageCount,
    bottomCursor: cursor,
  };
}
`;

function buildTimelineExtractJS(limit) {
  return `(() => {
    ${BROWSER_COMMON_JS}
    return extractTimelineItems(${limit});
  })()`;
}

function buildHomeMetaJS() {
  return `(() => {
    ${BROWSER_COMMON_JS}
    return JSON.stringify(extractHomeMeta());
  })()`;
}

function buildSearchMetaJS() {
  return `(() => {
    ${BROWSER_COMMON_JS}
    return JSON.stringify(extractSearchMeta());
  })()`;
}

function buildListMetaJS() {
  return `(() => {
    ${BROWSER_COMMON_JS}
    return JSON.stringify(extractListMeta());
  })()`;
}

function buildProfileMetaJS() {
  return `(() => {
    ${BROWSER_COMMON_JS}
    return JSON.stringify(extractProfileMeta());
  })()`;
}

function buildStatusExtractJS() {
  return `(() => {
    ${BROWSER_COMMON_JS}
    const primary = document.querySelector('main [data-testid="primaryColumn"]') || document.querySelector('main') || document.body;
    const articles = Array.from(primary.querySelectorAll('article[data-testid="tweet"]'));
    const main = articles[0] ? extractTimelineItem(articles[0], 0) : null;
    if (main) main.entryType = detectEntryType(main);

    const supporting = articles.slice(1, 4).map((article, index) => {
      const item = extractTimelineItem(article, index + 1);
      item.entryType = detectEntryType(item);
      return item;
    });

    const longform = articles[0] ? extractLongformArticle(articles[0]) : null;
    return JSON.stringify({
      main,
      supporting,
      longform,
    });
  })()`;
}

function buildSearchApiExtractJS(query, mode, querySource, limit) {
  return `(() => {
    ${BROWSER_COMMON_JS}
    ${BROWSER_SEARCH_API_JS}
    return (async () => {
      const result = await fetchSearchTimelineItems(${JSON.stringify({
        query,
        mode,
        querySource,
        limit,
      })});
      return JSON.stringify(result);
    })();
  })()`;
}

async function evalJson(proxy, targetId, js) {
  const raw = await proxy.eval(targetId, js);
  if (!raw) return null;
  return JSON.parse(raw);
}

export function parseCountText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return 0;

  const raw = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!raw) return 0;

  const number = Number(raw[0]);
  if (Number.isNaN(number)) return 0;

  if (/亿/.test(text)) return Math.round(number * 100000000);
  if (/万/.test(text)) return Math.round(number * 10000);
  if (/[kK]\b/.test(text)) return Math.round(number * 1000);
  if (/[mM]\b/.test(text)) return Math.round(number * 1000000);
  if (/[bB]\b/.test(text)) return Math.round(number * 1000000000);
  return Math.round(number);
}

function normalizeMetric(metric) {
  const key = metric.name?.replace(/^un/, '') || 'metric';
  const display = metric.display || '';
  const numeric = parseCountText(metric.ariaLabel || display);
  return {
    key,
    display,
    numeric,
    ariaLabel: metric.ariaLabel || '',
  };
}

function normalizeCard(raw) {
  const metrics = {};
  for (const metric of raw.metrics || []) {
    const normalized = normalizeMetric(metric);
    metrics[normalized.key] = normalized;
  }

  const views = raw.viewMetric
    ? {
        display: raw.viewMetric.display,
        numeric: parseCountText(raw.viewMetric.ariaLabel || raw.viewMetric.display),
        url: raw.viewMetric.url || null,
      }
    : null;

  const media = {
    images: (raw.media?.images || []).filter(Boolean),
    articleCoverImages: (raw.media?.articleCoverImages || []).filter(Boolean),
    hasVideo: !!raw.media?.hasVideo,
    videos: (raw.media?.videos || []).map(video => ({
      poster: video.poster || null,
      blobUrl: video.currentSrc || video.src || null,
      sources: (video.sources || []).filter(Boolean),
      streamUrls: [],
    })),
  };

  // socialContext.type === 'repost' 时派生 repostedBy:标示这条在 timeline 里是被谁纯转发出来的。
  // 注意纯 RT 的外层 statusUrl 等于原推 statusUrl(X 不为 RT 生成新 ID),所以跨 source / 跨时段
  // 多人 RT 同一条会被 dedupTweets 合并到同一 block,repostedBy 被聚合成数组。
  const repostedBy = raw.socialContext?.type === 'repost'
    ? { handle: raw.socialContext.handle || '', name: raw.socialContext.name || '' }
    : null;

  return {
    statusUrl: raw.statusUrl || null,
    statusId: raw.statusId || null,
    author: raw.author || { name: '', handle: '', raw: '' },
    authoredAt: raw.authoredAt || { text: '', dateTime: '' },
    text: raw.text || '',
    textBlocks: raw.textBlocks || [],
    isTruncated: !!raw.isTruncated,
    metrics,
    views,
    media,
    externalCard: raw.externalCard || null,
    quotedTweet: raw.quotedTweet || null,
    longformPreview: raw.longformPreview || null,
    repostedBy,
    entryType: raw.entryType || 'tweet',
  };
}

function normalizeLongformArticle(raw) {
  if (!raw) return null;
  return {
    title: raw.title || '',
    markdown: raw.markdown || '',
    headings: raw.headings || [],
    images: raw.images || [],
    links: raw.links || [],
    codeBlockCount: raw.codeBlockCount || 0,
    textLength: raw.textLength || 0,
  };
}

function inferHandleFromUrl(url) {
  try {
    const profile = detectProfilePath(new URL(url).pathname);
    return profile ? '@' + profile.handle : '';
  } catch {
    return '';
  }
}

function normalizeProfile(raw, url) {
  const handle = raw?.handle || inferHandleFromUrl(url);
  const currentUrl = (() => {
    try {
      const parsed = new URL(raw?.url || url);
      return parsed.origin + parsed.pathname;
    } catch {
      return raw?.url || url || null;
    }
  })();
  const baseUrl = handle
    ? (() => {
        try {
          const parsed = new URL(url || raw?.url || 'https://x.com');
          return `${parsed.origin}/${handle.replace(/^@/, '')}`;
        } catch {
          return `https://x.com/${handle.replace(/^@/, '')}`;
        }
      })()
    : currentUrl;

  return {
    name: raw?.name || '',
    handle,
    url: currentUrl,
    baseUrl,
    bio: raw?.bio || '',
    professionalCategory: raw?.professionalCategory || '',
    location: raw?.location || '',
    website: {
      text: raw?.website?.text || '',
      url: raw?.website?.url || null,
    },
    joined: {
      text: raw?.joined?.text || '',
      url: raw?.joined?.url || null,
    },
    avatarUrl: raw?.avatarUrl || null,
    headerImageUrl: raw?.headerImageUrl || null,
    postCount: parseCountText(raw?.postCountText || ''),
    postCountText: raw?.postCountText || '',
    following: {
      text: raw?.following?.text || '',
      count: parseCountText(raw?.following?.text || ''),
      url: raw?.following?.url || null,
    },
    followers: {
      text: raw?.followers?.text || '',
      count: parseCountText(raw?.followers?.text || ''),
      url: raw?.followers?.url || null,
    },
    followersYouKnow: {
      text: raw?.followersYouKnow?.text || '',
      url: raw?.followersYouKnow?.url || null,
    },
    isVerified: !!raw?.isVerified,
    isProtected: !!raw?.isProtected,
    relationship: {
      following: raw?.relationship?.following ?? null,
      actionLabel: raw?.relationship?.actionLabel || '',
    },
    selectedTab: raw?.selectedTab || null,
    tabs: raw?.tabs || [],
  };
}

function normalizeSearch(raw, url) {
  let currentUrl = raw?.url || url || null;
  try {
    currentUrl = new URL(currentUrl).href;
  } catch {}

  return {
    query: raw?.query || '',
    rawQuery: raw?.rawQuery || raw?.query || '',
    mode: raw?.mode || 'top',
    rawMode: raw?.rawMode || 'top',
    url: currentUrl,
    selectedTab: raw?.selectedTab || null,
    selectedTabUrl: raw?.selectedTabUrl || null,
    tabs: raw?.tabs || [],
  };
}

function getSearchQuerySource(url) {
  try {
    return new URL(url).searchParams.get('src') || 'typed_query';
  } catch {
    return 'typed_query';
  }
}

function mergeVideoStreams(card, streams) {
  if (!card?.media?.hasVideo || !Array.isArray(card.media.videos)) return card;

  const deduped = Array.from(new Set((streams || []).filter(url => /m3u8|mp4/i.test(url))));
  card.media.videos = card.media.videos.map(video => ({
    ...video,
    streamUrls: deduped,
  }));
  return card;
}

// X 在分批加载失败时(网络抖动 / 限流)会显示"出错了。请尝试重新加载"+ 蓝色"重试"按钮,
// 之后**不再自动重试**,等用户点击。timeline 抓取必须自动点掉这个按钮,否则前几条之后就卡死。
// 返回是否点了按钮(true 表示发现并点了)。
async function clickTimelineRetry(proxy, targetId) {
  return await proxy.eval(targetId, `(() => {
    const primary = document.querySelector('main [data-testid="primaryColumn"]');
    if (!primary) return false;
    const buttons = Array.from(primary.querySelectorAll('[role="button"], button'));
    const retry = buttons.find(b => /^(重试|Retry|再试一次|Try again)$/i.test((b.innerText || '').trim()));
    if (!retry) return false;
    retry.click();
    return true;
  })()`).catch(() => false);
}

// 等 X timeline 第一批加载到位 — 不依赖固定 sleep。
// X 的 list/profile/home 都是分批加载:进入页面后先显示 loading spinner,然后第一批
// 20-30 条 article 一起 mount。固定 sleep(原来 2.2s)在网络慢时根本不够,会让 collect
// 误以为 list 只有 3 条就退出。
//
// 退出条件(任一满足):
//   1) progressbar / loading indicator 消失,且至少有 minArticles 条 article 已 mount
//   2) 累计已等待 maxWait ms
//
// 即便超时也继续往下走 — collect 自身还会再 scroll + 等待几轮,不让等待自身成为失败源。
async function waitForTimelineSettled(proxy, targetId, { maxWait = 20000, minArticles = 5, pollInterval = 500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const probe = await proxy.eval(targetId, `(() => {
      const primary = document.querySelector('main [data-testid="primaryColumn"]');
      if (!primary) return { ready: false, articles: 0, loading: true };
      const articles = primary.querySelectorAll('article[data-testid="tweet"]').length;
      const loading = !!primary.querySelector('[role="progressbar"], svg[aria-label*="加载"], svg[aria-label*="Loading"], [data-testid="LoadingIndicator"]');
      return { ready: !loading && articles >= ${minArticles}, articles, loading };
    })()`).catch(() => null);

    if (probe?.ready) return probe;

    // 网络抖动时 X 会停下来弹"重试"按钮,点掉它继续 lazy load
    const clicked = await clickTimelineRetry(proxy, targetId);
    if (clicked) await sleep(pollInterval * 2);  // 点完给加载一点时间
    else await sleep(pollInterval);
  }
  return null;
}

// X 的 timeline 是虚拟列表:滚动后顶部 article 会被 React unmount,新 article 从底部 mount。
// 所以单次 eval 只能看到"当前一屏"的 article(通常 5-10 条),必须跨轮按 statusId 累加。
// 之前用 `current.length > items.length` 替换语义会把累积冻结在第一屏 — 这就是 limit=80
// 实际只拿到一屏的 root cause。
async function collectTimelineItems(proxy, targetId, limit, {
  maxScrollAttempts = 10,
  scrollDelay = 1800,
  initialDelay = 1500,
  maxStagnantRounds = 3,
} = {}) {
  const items = [];
  const seen = new Set();

  if (initialDelay > 0) await sleep(initialDelay);

  let stagnant = 0;
  for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
    // 浏览器端 limit 给一个明显大于一屏的数,让 extractTimelineItems 不要内部截断 —
    // DOM 里实际挂着的 article 总是远小于这个数,只是去掉 break 上限的副作用。
    const current = await proxy.eval(targetId, buildTimelineExtractJS(200)).catch(() => []);
    let added = 0;
    for (const it of Array.isArray(current) ? current : []) {
      const key = it?.statusId || it?.statusUrl;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(it);
      added += 1;
    }

    if (items.length >= limit) break;

    if (added === 0 && items.length > 0) {
      // 在判定 stagnant 前先排除两种"暂时性"原因:
      //   1) X 还在 lazy 加载下一批 (progressbar / LoadingIndicator 还在转)
      //   2) X 因为网络抖动停下来弹了"重试"按钮 — 主动点掉它续命
      const loading = await proxy.eval(targetId, `(() => {
        const primary = document.querySelector('main [data-testid="primaryColumn"]');
        if (!primary) return false;
        return !!primary.querySelector('[role="progressbar"], svg[aria-label*="加载"], svg[aria-label*="Loading"], [data-testid="LoadingIndicator"]');
      })()`).catch(() => false);

      if (loading) {
        await sleep(scrollDelay);
        continue;
      }

      const clickedRetry = await clickTimelineRetry(proxy, targetId);
      if (clickedRetry) {
        stagnant = 0;
        await sleep(scrollDelay);
        continue;
      }

      // 已加载完、没 retry、没新增 → 大概率到底/X 不再返回更多,累积 stagnant 轮数
      stagnant += 1;
      if (stagnant >= maxStagnantRounds) break;
    } else {
      stagnant = 0;
    }

    // 首两轮如果连一条都没拿到,先纯等(给页面初始化时间),不立即 scroll
    if (items.length === 0 && attempt < 2) {
      await sleep(scrollDelay);
      continue;
    }

    await proxy.scroll(targetId, { direction: 'bottom' }).catch(() => {});
    await sleep(scrollDelay);
  }

  return items.slice(0, limit);
}

async function startEventCollector(proxy, targetId, filter = 'Network', maxEvents = 800) {
  const response = await fetch(`${proxy.base}/events/start?target=${encodeURIComponent(targetId)}`, {
    method: 'POST',
    body: JSON.stringify({ filter, maxEvents }),
  });
  return response.json();
}

async function getCollectedEvents(proxy, collectorId, clear = false) {
  const response = await fetch(`${proxy.base}/events/get?id=${encodeURIComponent(collectorId)}&clear=${clear ? 'true' : 'false'}`);
  return response.json();
}

async function stopEventCollector(proxy, collectorId) {
  await fetch(`${proxy.base}/events/stop?id=${encodeURIComponent(collectorId)}`).catch(() => {});
}

async function cdp(proxy, targetId, method, params = {}) {
  const response = await fetch(`${proxy.base}/cdp?target=${encodeURIComponent(targetId)}`, {
    method: 'POST',
    body: JSON.stringify({ method, params }),
  });
  return response.json();
}

async function collectVideoStreams(proxy, targetId, url) {
  let collectorId = null;

  try {
    await cdp(proxy, targetId, 'Network.enable', {});
    const started = await startEventCollector(proxy, targetId, 'Network', 1200);
    collectorId = started.collectorId;

    await proxy.navigate(targetId, url);
    await proxy.waitFor(targetId, STATUS_WAIT_SELECTOR, 20000).catch(() => {});
    await sleep(2500);

    await proxy.eval(targetId, `new Promise((resolve) => {
      const video = document.querySelector('video');
      if (!video) return resolve(false);
      try {
        video.muted = true;
        const played = video.play();
        if (played && typeof played.catch === 'function') played.catch(() => {});
      } catch {}
      setTimeout(() => resolve(true), 3500);
    })`).catch(() => {});

    await sleep(1500);

    const events = await getCollectedEvents(proxy, collectorId);
    const urls = new Set();

    for (const event of events.events || []) {
      const requestUrl = event.params?.request?.url || event.params?.response?.url || '';
      if (!requestUrl) continue;
      if (!/video\.twimg|twimg\.com\/ext_tw_video|amplify_video|m3u8|mp4/i.test(requestUrl)) continue;
      urls.add(requestUrl);
    }

    return Array.from(urls);
  } catch {
    return [];
  } finally {
    if (collectorId) await stopEventCollector(proxy, collectorId);
  }
}

async function ensureLoggedInContent(proxy, targetId, selector, timeout = 20000) {
  const waited = await proxy.waitFor(targetId, selector, timeout).catch(() => null);
  if (waited?.found) return true;

  const state = await proxy.eval(targetId, `(() => ({
    loginTexts: Array.from(document.querySelectorAll('a, button'))
      .map(node => node.innerText?.trim())
      .filter(Boolean)
      .filter(text => /log in|sign up|登录|注册/i.test(text))
      .slice(0, 10),
    body: document.body?.innerText?.slice(0, 600) || ''
  }))()`).catch(() => null);

  if (state?.loginTexts?.length) {
    return { error: 'login_required', hint: 'log in to X in your Chrome profile, then retry' };
  }

  return false;
}

export default {
  name: 'x',
  domains: ['x.com', 'twitter.com'],
  description: 'X home/search/profile/list/status/article extraction with DOM timelines, internal search pagination, and video stream recovery',

  detect(url) {
    const parsed = new URL(url);
    if (parsed.pathname === '/home') return 'home';
    if (parsed.pathname === '/search') return 'search';
    if (/^\/i\/lists\/\d+/.test(parsed.pathname)) return 'list';
    if (/\/status\/\d+/.test(parsed.pathname)) return 'status';
    if (detectProfilePath(parsed.pathname)) return 'profile';
    return 'unknown';
  },

  async extract(proxy, targetId, ctx) {
    const { pageType, url } = ctx;
    const limit = Math.max(1, Math.min(Number(ctx.limit || 10), 200));

    switch (pageType) {
      case 'home':
        return this._extractHome(proxy, targetId, limit);
      case 'search':
        return this._extractSearch(proxy, targetId, limit, url);
      case 'list':
        return this._extractList(proxy, targetId, limit, url);
      case 'profile':
        return this._extractProfile(proxy, targetId, limit, url);
      case 'status':
        return this._extractStatus(proxy, targetId, url);
      default:
        return {
          error: `unsupported page type: ${pageType}`,
          hint: 'supported URL types: /home, /search?q=...&src=typed_query[&f=live|media|user|list], /i/lists/:id, /:user, /:user/(with_replies|articles|media), /:user/status/:id',
        };
    }
  },

  async _extractHome(proxy, targetId, limit) {
    const ready = await ensureLoggedInContent(proxy, targetId, TIMELINE_WAIT_SELECTOR);
    if (ready && ready.error) return ready;

    const meta = await evalJson(proxy, targetId, buildHomeMetaJS());
    const cards = await collectTimelineItems(proxy, targetId, limit, {
      initialDelay: 1200,
      maxScrollAttempts: 10,
      scrollDelay: 1800,
    });

    const items = cards.map(normalizeCard);

    return {
      contentType: 'timeline',
      timelineType: 'home',
      selectedTab: meta?.selectedTab || null,
      tabs: meta?.tabs || [],
      items,
      itemCount: items.length,
      format: 'json',
    };
  },

  async _extractSearch(proxy, targetId, limit, url) {
    const ready = await ensureLoggedInContent(proxy, targetId, SEARCH_WAIT_SELECTOR);
    if (ready && ready.error) return ready;
    await sleep(1800);

    let meta = await evalJson(proxy, targetId, buildSearchMetaJS());

    if (!meta?.query && !meta?.selectedTab) {
      await proxy.navigate(targetId, url).catch(() => {});
      await sleep(2500);
      meta = await evalJson(proxy, targetId, buildSearchMetaJS());
    }

    let search = normalizeSearch(meta, url);
    const querySource = getSearchQuerySource(search.url || url);
    const apiEligible = !!(search.rawQuery || search.query) && !['users', 'lists'].includes(search.mode);

    let items = [];
    let fetchStrategy = 'dom';
    let pageCount = null;

    if (apiEligible) {
      const apiResult = await evalJson(
        proxy,
        targetId,
        buildSearchApiExtractJS(search.rawQuery || search.query, search.mode, querySource, limit)
      ).catch(() => null);

      if (Array.isArray(apiResult?.items) && apiResult.items.length > 0) {
        items = apiResult.items;
        fetchStrategy = apiResult.strategy || 'graphql_internal';
        pageCount = Number(apiResult.pageCount || 0) || null;
      }
    }

    if (!items.length) {
      let cards = await collectTimelineItems(proxy, targetId, limit, {
        initialDelay: 1200,
        maxScrollAttempts: Math.max(12, Math.ceil(limit / 8) + 4),
        scrollDelay: 1700,
      });

      if (!cards.length && search.mode !== 'users' && search.mode !== 'lists') {
        await proxy.navigate(targetId, url).catch(() => {});
        await sleep(2500);
        meta = await evalJson(proxy, targetId, buildSearchMetaJS());
        search = normalizeSearch(meta, url);
        cards = await collectTimelineItems(proxy, targetId, limit, {
          initialDelay: 1500,
          maxScrollAttempts: Math.max(14, Math.ceil(limit / 8) + 5),
          scrollDelay: 1900,
        });
      }

      items = cards.map(normalizeCard);
    }

    return {
      contentType: 'timeline',
      timelineType: 'search',
      search,
      items,
      itemCount: items.length,
      fetchStrategy,
      pageCount,
      format: 'json',
    };
  },

  async _extractList(proxy, targetId, limit, url) {
    const ready = await ensureLoggedInContent(proxy, targetId, TIMELINE_WAIT_SELECTOR);
    if (ready && ready.error) return ready;
    await waitForTimelineSettled(proxy, targetId);

    let meta = await evalJson(proxy, targetId, buildListMetaJS());
    let cards = await collectTimelineItems(proxy, targetId, limit, {
      initialDelay: 0,  // settled wait 已经吃掉了等待时间
      maxScrollAttempts: 10,
      scrollDelay: 1800,
    });

    if ((!cards.length && !meta?.name) || (!cards.length && !meta?.ownerHandle)) {
      await proxy.navigate(targetId, url).catch(() => {});
      await waitForTimelineSettled(proxy, targetId);
      meta = await evalJson(proxy, targetId, buildListMetaJS());
      cards = await collectTimelineItems(proxy, targetId, limit, {
        initialDelay: 0,
        maxScrollAttempts: 12,
        scrollDelay: 2000,
      });
    }

    const items = cards.map(normalizeCard);

    return {
      contentType: 'timeline',
      timelineType: 'list',
      list: {
        ...meta,
        memberCount: parseCountText(meta?.members?.text),
        followerCount: parseCountText(meta?.followers?.text),
      },
      items,
      itemCount: items.length,
      format: 'json',
    };
  },

  async _extractProfile(proxy, targetId, limit, url) {
    const ready = await ensureLoggedInContent(proxy, targetId, PROFILE_WAIT_SELECTOR);
    if (ready && ready.error) return ready;
    await sleep(1800);

    let meta = await evalJson(proxy, targetId, buildProfileMetaJS());
    let cards = await collectTimelineItems(proxy, targetId, limit, {
      initialDelay: 1200,
      maxScrollAttempts: 10,
      scrollDelay: 1800,
    });

    if ((!meta?.handle && !meta?.name) || (!cards.length && !meta?.selectedTab)) {
      await proxy.navigate(targetId, url).catch(() => {});
      await sleep(2500);
      meta = await evalJson(proxy, targetId, buildProfileMetaJS());
      cards = await collectTimelineItems(proxy, targetId, limit, {
        initialDelay: 1500,
        maxScrollAttempts: 12,
        scrollDelay: 2000,
      });
    }

    const items = cards.map(normalizeCard);
    const profile = normalizeProfile(meta, url);

    return {
      contentType: 'timeline',
      timelineType: 'profile',
      profile,
      items,
      itemCount: items.length,
      format: 'json',
    };
  },

  async _extractStatus(proxy, targetId, url) {
    const ready = await ensureLoggedInContent(proxy, targetId, STATUS_WAIT_SELECTOR);
    if (ready && ready.error) return ready;
    await sleep(1500);

    const initial = await evalJson(proxy, targetId, buildStatusExtractJS());
    const hasVideo = !!initial?.main?.media?.hasVideo;

    let videoStreams = [];
    if (hasVideo) {
      videoStreams = await collectVideoStreams(proxy, targetId, url);
    }

    const extracted = hasVideo
      ? await evalJson(proxy, targetId, buildStatusExtractJS())
      : initial;

    if (!extracted?.main) {
      return {
        error: 'failed_to_extract_status',
        hint: 'the status may be unavailable, protected, or require a different login state',
      };
    }

    const tweet = mergeVideoStreams(normalizeCard(extracted.main), videoStreams);
    const supporting = (extracted.supporting || []).map(normalizeCard);
    const article = normalizeLongformArticle(extracted.longform);
    const contentType = article?.markdown ? 'article' : 'tweet';

    if (contentType === 'article') {
      tweet.entryType = 'article';
      tweet.longformPreview = null;
      if (!tweet.text) tweet.text = article.title || '';
    }

    return {
      contentType,
      tweet,
      supporting,
      article,
      format: 'json',
    };
  },
};
