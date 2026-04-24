// X adapter — 从登录态 Chrome 的 DOM 抽 home / search / profile / list / status / longform。
//   - Timeline / status 内容来自真实 DOM
//   - Search pagination 走 X 内部 GraphQL runtime(如果能注入)
//   - 视频 stream URL 从 CDP Network 事件恢复(DOM 只有 blob:)
//   - Longform 文章从渲染后的 Draft.js 富文本树转成 Markdown

import { sleep } from './_utils.mjs';

const TIMELINE_WAIT_SELECTOR = 'main [data-testid="primaryColumn"] article[data-testid="tweet"]';
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


// Timeline 从 X redux store 直接读 —— X 页面自己调 ListLatestTweetsTimeline / UserTweets /
// UserMedia / UserArticles / UserWithReplies GraphQL 把结果塞到 state.urt[timelineKey],
// entries 通常首轮就几十条,scroll 触发 X 自己 fetch 下一页。比 DOM 爬虫完整 + idempotent +
// 不受虚拟列表 / tab throttle 影响。
//
// 注意 X store 做了深度 normalization:entries 里只剩 content.id(tweet id),推文实体在
// state.entities.tweets.entities[id](legacy 字段已拍平到顶层),作者在 state.entities.users.entities[userId]。
// 所以 normalize 必须自己写,不能复用 search 的 GraphQL-shape normalizer。
const BROWSER_TIMELINE_STORE_JS = String.raw`
// 从 React fiber 树里挖 X 的 redux store:#react-root / body / html 有 React 内部引用,
// 深度遍历 fiber.memoizedProps 找到带 store.getState 的那层。
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

function getReduxStore() {
  const root = getReactRootFiber();
  if (!root) return null;
  const seen = new Set();
  let match = null;
  const walk = (fiber) => {
    if (!fiber || seen.has(fiber) || match) return;
    seen.add(fiber);
    const props = fiber.memoizedProps;
    if (props && props.store && typeof props.store.getState === 'function') {
      match = props.store;
      return;
    }
    walk(fiber.child);
    walk(fiber.sibling);
  };
  walk(root);
  return match;
}

function getCurrentListTimeline(store, listId) {
  const state = store && store.getState ? store.getState() : null;
  const urt = state && state.urt;
  if (!urt) return null;
  const direct = urt['listTweets-GraphQL-' + listId + '-latest']
    || urt['listTweets-GraphQL-' + listId]
    || urt['ListLatestTweetsTimeline-' + listId];
  if (direct && Array.isArray(direct.entries) && direct.entries.length > 0) return direct;
  for (const [key, timeline] of Object.entries(urt)) {
    if (key.includes(listId) && timeline && Array.isArray(timeline.entries) && timeline.entries.length > 0) {
      return timeline;
    }
  }
  return null;
}

// profile timeline:X 用 userTweets-graphql-<userId>-<tab> / userMedia-graphql-... / userArticles-... /
// userWithReplies-... 之类的 key,每个 tab 一份。进入 profile 页时只加载当前 tab 的那条 timeline,
// 所以直接找第一个前缀匹配的非空 timeline 即可(不需要 userId)。
function getCurrentProfileTimeline(store) {
  const state = store && store.getState ? store.getState() : null;
  const urt = state && state.urt;
  if (!urt) return null;
  const prefixes = ['userTweets-graphql-', 'userMedia-graphql-', 'userArticles-graphql-', 'userWithReplies-graphql-'];
  for (const [key, timeline] of Object.entries(urt)) {
    if (!timeline || !Array.isArray(timeline.entries) || timeline.entries.length === 0) continue;
    for (const prefix of prefixes) {
      if (key.startsWith(prefix)) return timeline;
    }
  }
  return null;
}

// 从一条 entry 提取所有 tweet id —— 单推 / conversation thread 都覆盖
function collectTweetIdsFromEntry(entry) {
  const ids = [];
  const content = entry && entry.content;
  if (!content) return ids;
  // 单推:entryId="tweet-<id>",content.id = tweet id
  if (typeof content.id === 'string' && /^\d+$/.test(content.id)) {
    ids.push(content.id);
    return ids;
  }
  // conversation thread:content.items[].item.content.id
  if (Array.isArray(content.items)) {
    for (const wrap of content.items) {
      const inner = wrap && wrap.item && wrap.item.content;
      if (inner && typeof inner.id === 'string' && /^\d+$/.test(inner.id)) ids.push(inner.id);
    }
  }
  return ids;
}

function buildStoreMetric(count) {
  const n = Number(count || 0);
  return { key: '', display: String(n), numeric: n, ariaLabel: '' };
}

// store tweet 实体是扁平 legacy(字段直接在顶层,无 .legacy 包装)
// 关键 shape(见 probe-list-entities.mjs 输出):
//   { id_str, full_text, display_text_range, created_at, user /* user id */,
//     entities:{urls,media}, extended_entities:{media}, retweeted_status,
//     is_quote_status, quoted_status_id_str, conversation_id_str,
//     favorite_count, retweet_count, reply_count, bookmark_count, quote_count, views:{count} }
function normalizeStoreTweet(tweet, users, tweets) {
  if (!tweet || !tweet.id_str) return null;

  // 处理 retweet:外层 tweet 只是 marker,真正内容在 retweeted_status
  let source = tweet;
  let repostedByUserId = null;
  if (tweet.retweeted_status) {
    // retweeted_status 可能是完整 tweet 对象,也可能是 id 引用
    const rtInner = typeof tweet.retweeted_status === 'string'
      ? (tweets && tweets[tweet.retweeted_status])
      : tweet.retweeted_status;
    if (rtInner && rtInner.id_str) {
      source = rtInner;
      repostedByUserId = tweet.user || null;
    }
  }

  const user = source.user && users && users[source.user] ? users[source.user] : null;
  const screen = user && user.screen_name ? user.screen_name : '';
  const handle = screen ? '@' + screen : '';
  const statusUrl = handle && source.id_str
    ? location.origin + '/' + screen + '/status/' + source.id_str
    : null;

  // text:full_text 基本就是展示文;display_text_range 在短推时用来去掉 t.co 链接,
  // 长推(note_tweet)的 full_text 已经是全文、range 覆盖不了完整长度 → 直接取 full_text
  const full = String(source.full_text || source.text || '');
  const range = source.display_text_range;
  let text = full;
  if (Array.isArray(range) && range.length >= 2) {
    const chars = Array.from(full);
    if (range[1] <= chars.length) {
      const sliced = chars.slice(range[0], range[1]).join('');
      // 长推整段合并到 full_text 后 range 只会覆盖前 280 字 — 用 sliced 就截断了。
      // 保险:取较长者作为展示文
      if (sliced && sliced.length >= full.length * 0.9) text = sliced;
    }
  }

  // media
  const mediaEntities = (source.extended_entities && source.extended_entities.media) || (source.entities && source.entities.media) || [];
  const images = dedupe(
    mediaEntities.filter(m => m && m.type === 'photo')
      .map(m => absoluteUrl(m.media_url_https || m.media_url || ''))
      .filter(isImageUrl)
  );
  const videos = mediaEntities.filter(m => m && (m.type === 'video' || m.type === 'animated_gif')).map(m => {
    const variants = dedupe(((m.video_info && m.video_info.variants) || []).map(v => absoluteUrl(v && v.url || '')).filter(Boolean));
    const playable = dedupe(variants.filter(u => /m3u8|mp4/i.test(u)));
    return { poster: absoluteUrl(m.media_url_https || m.media_url || ''), blobUrl: null, sources: variants, streamUrls: playable };
  });

  // external card:entities.urls 里非 X 自身的链接
  const urls = dedupe(((source.entities && source.entities.urls) || [])
    .map(u => absoluteUrl(u && (u.expanded_url || u.url) || '')).filter(Boolean).filter(u => u !== statusUrl));
  const externalUrl = urls.find(isExternalLink) || null;
  const externalCard = externalUrl ? {
    url: externalUrl,
    links: urls,
    text: '',
    labels: dedupe(((source.entities && source.entities.urls) || []).flatMap(u => [u && u.display_url, u && u.expanded_url]).filter(Boolean)).slice(0, 12),
  } : null;

  // quoted tweet
  let quotedTweet = null;
  if (source.is_quote_status && source.quoted_status_id_str) {
    const q = tweets && tweets[source.quoted_status_id_str];
    if (q) {
      const qUser = q.user && users && users[q.user] ? users[q.user] : null;
      const qHandle = qUser && qUser.screen_name ? '@' + qUser.screen_name : '';
      const qUrl = qHandle ? location.origin + '/' + qUser.screen_name + '/status/' + q.id_str : null;
      quotedTweet = {
        authors: qUser ? [{ name: qUser.name || '', handle: qHandle, raw: [qUser.name, qHandle].filter(Boolean).join('\n') }] : [],
        texts: q.full_text ? [String(q.full_text)] : [],
        statusUrls: qUrl && qUrl !== statusUrl ? [qUrl] : [],
      };
    }
  }

  const createdAt = source.created_at ? new Date(source.created_at) : null;
  const viewsCount = source.views && source.views.count;

  // repostedBy:社交层标记,DOM 路径那边由 socialContext 产生
  let socialContext = null;
  if (repostedByUserId) {
    const rpUser = users && users[repostedByUserId];
    if (rpUser) {
      socialContext = {
        type: 'repost',
        name: rpUser.name || '',
        handle: rpUser.screen_name ? '@' + rpUser.screen_name : '',
        raw: [rpUser.name, rpUser.screen_name && '@' + rpUser.screen_name].filter(Boolean).join(' '),
      };
    }
  }

  const item = {
    statusUrl,
    statusId: source.id_str,
    author: {
      name: user && user.name || '',
      handle,
      raw: [(user && user.name) || '', handle].filter(Boolean).join('\n'),
    },
    authoredAt: {
      text: source.created_at || '',
      dateTime: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toISOString() : '',
    },
    text,
    textBlocks: text ? [text] : [],
    isTruncated: false,
    hydrated: true,
    metrics: {
      reply: Object.assign(buildStoreMetric(source.reply_count), { key: 'reply' }),
      retweet: Object.assign(buildStoreMetric(source.retweet_count), { key: 'retweet' }),
      like: Object.assign(buildStoreMetric(source.favorite_count), { key: 'like' }),
      bookmark: Object.assign(buildStoreMetric(source.bookmark_count), { key: 'bookmark' }),
      quote: Object.assign(buildStoreMetric(source.quote_count), { key: 'quote' }),
    },
    views: viewsCount != null ? {
      display: String(Number(viewsCount) || 0),
      numeric: Number(viewsCount) || 0,
      url: statusUrl ? statusUrl + '/analytics' : null,
    } : null,
    media: { images, articleCoverImages: [], hasVideo: videos.length > 0, videos },
    externalCard,
    quotedTweet,
    longformPreview: null,
    entryType: 'tweet',
  };
  if (socialContext) item.socialContext = socialContext;
  if (item.media.hasVideo) item.entryType = 'video_tweet';
  else if (item.media.images.length > 0) item.entryType = 'photo_tweet';
  else if (item.externalCard && item.externalCard.url) item.entryType = 'link_card';
  return item;
}

// 等 entries 达到 limit 或 stagnant,期间用 window.scroll 触发 X 自己 fetch 下一 cursor 页。
// 然后 normalize store entries 成 tweet items。list / profile 共用(只是 findTimeline 不同)。
async function extractStoreTimelineItems(findTimeline, limit) {
  const store = getReduxStore();
  if (!store) return { items: [], error: 'store_unavailable' };

  const MAX_WAIT_MS = 20000;
  const POLL_INTERVAL = 1500;
  const MAX_STAGNANT_ROUNDS = 3;
  const start = Date.now();
  let lastCount = -1;
  let stagnant = 0;

  while (Date.now() - start < MAX_WAIT_MS) {
    const tl = findTimeline(store);
    const count = tl && tl.entries ? tl.entries.length : 0;
    if (count >= limit) break;
    if (count === lastCount) {
      stagnant += 1;
      if (stagnant > MAX_STAGNANT_ROUNDS) break;
      try { window.scrollTo(0, document.body.scrollHeight); } catch (_) {}
    } else {
      stagnant = 0;
      lastCount = count;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  const timeline = findTimeline(store);
  if (!timeline) return { items: [], error: 'timeline_not_in_store' };

  const state = store.getState();
  const tweetsMap = state && state.entities && state.entities.tweets && state.entities.tweets.entities || {};
  const usersMap = state && state.entities && state.entities.users && state.entities.users.entities || {};

  const items = [];
  const seen = new Set();
  const missingIds = [];
  for (const entry of timeline.entries || []) {
    const ids = collectTweetIdsFromEntry(entry);
    for (const id of ids) {
      const tweet = tweetsMap[id];
      if (!tweet) { missingIds.push(id); continue; }
      const item = normalizeStoreTweet(tweet, usersMap, tweetsMap);
      if (!item) continue;
      const key = item.statusId || item.statusUrl;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(item);
      if (items.length >= limit) break;
    }
    if (items.length >= limit) break;
  }

  return {
    items: items.slice(0, limit),
    entriesInStore: timeline.entries.length,
    missingIdCount: missingIds.length,
  };
}

async function fetchListTimelineItems(options) {
  const listId = String(options && options.listId || '').trim();
  const limit = Math.max(1, Math.min(Number(options && options.limit || 10), 200));
  if (!listId) return { items: [], error: 'no_list_id' };
  return await extractStoreTimelineItems((store) => getCurrentListTimeline(store, listId), limit);
}

async function fetchProfileTimelineItems(options) {
  const limit = Math.max(1, Math.min(Number(options && options.limit || 10), 200));
  return await extractStoreTimelineItems(getCurrentProfileTimeline, limit);
}
`;

function buildListApiExtractJS(listId, limit) {
  return `(() => {
    ${BROWSER_COMMON_JS}
    ${BROWSER_TIMELINE_STORE_JS}
    return (async () => {
      const result = await fetchListTimelineItems(${JSON.stringify({ listId, limit })});
      return JSON.stringify(result);
    })();
  })()`;
}

function buildProfileApiExtractJS(limit) {
  return `(() => {
    ${BROWSER_COMMON_JS}
    ${BROWSER_TIMELINE_STORE_JS}
    return (async () => {
      const result = await fetchProfileTimelineItems(${JSON.stringify({ limit })});
      return JSON.stringify(result);
    })();
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

function mergeVideoStreams(card, streams) {
  if (!card?.media?.hasVideo || !Array.isArray(card.media.videos)) return card;

  const deduped = Array.from(new Set((streams || []).filter(url => /m3u8|mp4/i.test(url))));
  card.media.videos = card.media.videos.map(video => ({
    ...video,
    streamUrls: deduped,
  }));
  return card;
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
    if (/^\/i\/lists\/\d+/.test(parsed.pathname)) return 'list';
    if (/\/status\/\d+/.test(parsed.pathname)) return 'status';
    if (detectProfilePath(parsed.pathname)) return 'profile';
    return 'unknown';
  },

  async extract(proxy, targetId, ctx) {
    const { pageType, url } = ctx;
    const limit = Math.max(1, Math.min(Number(ctx.limit || 10), 200));

    switch (pageType) {
      case 'list':
        return this._extractList(proxy, targetId, limit, url);
      case 'profile':
        return this._extractProfile(proxy, targetId, limit, url);
      case 'status':
        return this._extractStatus(proxy, targetId, url);
      default:
        return {
          error: `unsupported page type: ${pageType}`,
          hint: 'supported URL types: /i/lists/:id, /:user, /:user/(with_replies|articles|media), /:user/status/:id',
        };
    }
  },

  async _extractList(proxy, targetId, limit, url) {
    const ready = await ensureLoggedInContent(proxy, targetId, TIMELINE_WAIT_SELECTOR);
    if (ready && ready.error) return ready;

    const meta = await evalJson(proxy, targetId, buildListMetaJS());
    const listId = (url && url.match(/\/i\/lists\/(\d+)/) || [])[1] || null;
    if (!listId) {
      return { error: 'invalid_list_url', hint: 'expected https://x.com/i/lists/<id>' };
    }

    // 从 X redux store 读 timeline(state.urt + state.entities)—— 详见 DESIGN §2.1 和
    // BROWSER_TIMELINE_STORE_JS。X 进入 list 页面后自己会通过 ListLatestTweetsTimeline
    // GraphQL 把 80+ 条塞进 store,fetchListTimelineItems 内部有 20s 等待 + scroll 触发下一页。
    const api = await evalJson(proxy, targetId, buildListApiExtractJS(listId, limit))
      .catch(e => ({ items: [], error: 'eval_throw: ' + (e?.message || String(e)) }));

    return {
      contentType: 'timeline',
      timelineType: 'list',
      list: {
        ...meta,
        memberCount: parseCountText(meta?.members?.text),
        followerCount: parseCountText(meta?.followers?.text),
      },
      items: api?.items || [],
      itemCount: api?.items?.length || 0,
      entriesInStore: api?.entriesInStore ?? null,
      missingIdCount: api?.missingIdCount ?? null,
      error: api?.error || null,
      format: 'json',
    };
  },

  async _extractProfile(proxy, targetId, limit, url) {
    const ready = await ensureLoggedInContent(proxy, targetId, PROFILE_WAIT_SELECTOR);
    if (ready && ready.error) return ready;
    await sleep(1800);

    const meta = await evalJson(proxy, targetId, buildProfileMetaJS());
    const profile = normalizeProfile(meta, url);

    // 从 X redux store 读 timeline —— 同 _extractList,profile 用 userTweets-graphql- 前缀匹配
    const api = await evalJson(proxy, targetId, buildProfileApiExtractJS(limit))
      .catch(e => ({ items: [], error: 'eval_throw: ' + (e?.message || String(e)) }));

    return {
      contentType: 'timeline',
      timelineType: 'profile',
      profile,
      items: api?.items || [],
      itemCount: api?.items?.length || 0,
      entriesInStore: api?.entriesInStore ?? null,
      missingIdCount: api?.missingIdCount ?? null,
      error: api?.error || null,
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
