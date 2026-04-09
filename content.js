const STORAGE_KEY = 'processedPostFingerprints';
const sessionProcessedKeys = new Set();

function getStorageValue(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      resolve(result[key]);
    });
  });
}

function setStorageValue(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, () => {
      resolve();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSimpleHash(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return String(hash);
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  return rect.width > 24 && rect.height > 8;
}

function isLikelyPostFrame(node) {
  if (!node || !isVisible(node)) return false;

  const rect = node.getBoundingClientRect();
  if (rect.width < 260 || rect.height < 140) return false;

  const hintText = (node.textContent || '').toLowerCase();
  if (hintText.includes('bình luận') || hintText.includes('binh luan') || hintText.includes('comment')) {
    return true;
  }

  const hasInteractiveCommentNode = Boolean(node.querySelector('[role="button"][aria-label*="bình luận" i], [role="button"][aria-label*="comment" i], [placeholder*="bình luận" i], [placeholder*="comment" i], div[contenteditable="true"]'));
  return hasInteractiveCommentNode;
}

function getPostCandidateFromNode(node) {
  if (!node) return null;

  const candidate = node.closest('[role="article"], [data-pagelet*="FeedUnit"], [data-pagelet*="Story"], [data-pagelet*="ProfileTimeline"], [data-pagelet*="Timeline"], [aria-posinset]');
  if (candidate && isLikelyPostFrame(candidate)) {
    return candidate;
  }

  let current = node.parentElement;
  while (current && current !== document.body) {
    if (isLikelyPostFrame(current)) {
      return current;
    }
    current = current.parentElement;
  }

  return null;
}

function collectPostCandidatesFromCommentUI() {
  const nodes = Array.from(document.querySelectorAll([
    'div[contenteditable="true"]',
    'span[role="textbox"]',
    '[placeholder*="bình luận" i]',
    '[placeholder*="binh luan" i]',
    '[placeholder*="comment" i]',
    '[aria-label*="bình luận dưới tên" i]',
    '[aria-label*="binh luan duoi ten" i]',
    '[aria-label*="comment as" i]',
    '[role="button"][aria-label*="bình luận" i]',
    '[role="button"][aria-label*="comment" i]'
  ].join(', ')));

  const found = [];
  const seen = new Set();

  for (const node of nodes) {
    const candidate = getPostCandidateFromNode(node);
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    found.push(candidate);
  }

  return found;
}

function getPostContainer(box) {
  return box.closest('[role="article"], [data-pagelet]');
}

function getDomPathSignature(node, maxDepth = 6) {
  if (!node) return '';

  const parts = [];
  let current = node;
  let depth = 0;

  while (current && current.parentElement && depth < maxDepth) {
    const parent = current.parentElement;
    const sameTagSiblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
    const siblingIndex = sameTagSiblings.indexOf(current);
    parts.push(`${current.tagName}:${siblingIndex}`);
    current = parent;
    depth += 1;
  }

  return parts.join('>');
}

function getPostContainers() {
  const articlePosts = Array.from(document.querySelectorAll('[role="article"]')).filter(isLikelyPostFrame);
  const pageletPosts = Array.from(document.querySelectorAll('[data-pagelet*="FeedUnit"], [data-pagelet*="Story"], [data-pagelet*="ProfileTimeline"], [data-pagelet*="Timeline"]')).filter(isLikelyPostFrame);
  const interactionDerivedPosts = collectPostCandidatesFromCommentUI();

  const rawPosts = [];
  if (articlePosts.length) {
    rawPosts.push(...articlePosts);
  }
  if (pageletPosts.length) {
    rawPosts.push(...pageletPosts);
  }
  if (!rawPosts.length && interactionDerivedPosts.length) {
    rawPosts.push(...interactionDerivedPosts);
  }

  const uniqueByKey = new Map();

  for (const post of rawPosts) {
    if (!isVisible(post)) continue;

    const key = getPostFingerprint(post) || getSessionPostKey(post) || getDomPathSignature(post, 8);
    if (!key) continue;

    const rect = post.getBoundingClientRect();
    const area = rect.width * rect.height;
    const existing = uniqueByKey.get(key);

    if (!existing || area > existing.area) {
      uniqueByKey.set(key, { post, area });
    }
  }

  return Array.from(uniqueByKey.values()).map((entry) => entry.post);
}

function findNextPostInFeed(currentPost, posts = getPostContainers()) {
  if (!currentPost || !Array.isArray(posts) || !posts.length) {
    return null;
  }

  const currentIndex = posts.indexOf(currentPost);
  if (currentIndex >= 0) {
    return posts[currentIndex + 1] || null;
  }

  const currentRect = currentPost.getBoundingClientRect();
  let nextPost = null;
  let bestTop = Number.POSITIVE_INFINITY;

  for (const post of posts) {
    if (post === currentPost) continue;

    const rect = post.getBoundingClientRect();
    if (rect.top >= (currentRect.bottom - 16) && rect.top < bestTop) {
      bestTop = rect.top;
      nextPost = post;
    }
  }

  return nextPost || null;
}

function scrollPostIntoView(post) {
  if (!post) return;
  post.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function getPostFingerprint(post) {
  if (!post) return null;

  const pagelet = post.getAttribute('data-pagelet') || '';
  const dataFt = post.getAttribute('data-ft') || '';
  const postId = post.getAttribute('id') || '';
  const firstLink = post.querySelector('a[href]')?.getAttribute('href') || '';
  const permalink = post.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid="], a[href*="fbid="]')?.getAttribute('href') || '';
  const domSignature = getDomPathSignature(post);

  const normalizeUrl = (url) => {
    if (!url) return '';
    return url
      .replace(/^https?:\/\/(www\.)?facebook\.com/i, '')
      .replace(/[?#].*$/, '')
      .trim();
  };

  const storyIdFromDataFt = (() => {
    if (!dataFt) return '';
    const match = dataFt.match(/(?:top_level_post_id|mf_story_key|content_owner_id_new)\\?"?\\s*[:=]\\s*"?(\d{6,})/i);
    return match ? match[1] : '';
  })();

  const storyIdFromUrl = (() => {
    const source = `${permalink} ${firstLink}`;
    const match = source.match(/(?:story_fbid|fbid|posts\/)=(\d{6,})|\/posts\/(\d{6,})|\/permalink\/(\d{6,})/i);
    if (!match) return '';
    return match[1] || match[2] || match[3] || '';
  })();

  const stableTokens = [
    storyIdFromDataFt,
    storyIdFromUrl,
    normalizeUrl(permalink),
    normalizeUrl(firstLink),
    pagelet,
    dataFt,
    postId
  ].filter((token) => Boolean(token && token.trim()));

  // Important: avoid post.innerText so fingerprint does not change after posting a comment.
  const rawFingerprint = stableTokens.length
    ? stableTokens.join('|')
    : [domSignature, normalizeUrl(firstLink), pagelet].join('|');

  if (!rawFingerprint.replace(/\|/g, '').trim()) return null;
  return createSimpleHash(rawFingerprint);
}

function getSessionPostKey(post) {
  if (!post) return null;

  const pagelet = post.getAttribute('data-pagelet') || '';
  const postId = post.getAttribute('id') || '';
  const permalink = post.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid="], a[href*="fbid="]')?.getAttribute('href') || '';
  const firstLink = post.querySelector('a[href]')?.getAttribute('href') || '';
  const domSignature = getDomPathSignature(post, 8);

  const normalizeUrl = (url) => (url || '')
    .replace(/^https?:\/\/(www\.)?facebook\.com/i, '')
    .replace(/[?#].*$/, '')
    .trim();

  const token = [
    normalizeUrl(permalink),
    normalizeUrl(firstLink),
    pagelet,
    postId,
    domSignature
  ].filter((part) => Boolean(part && part.trim())).join('|');

  if (!token) return null;
  return createSimpleHash(`session:${token}`);
}

function findComposerInPost(post) {
  return post.querySelector('div[contenteditable="true"]');
}

function getVisibleComposers() {
  const nodes = Array.from(document.querySelectorAll('div[contenteditable="true"][role="textbox"], div[data-lexical-editor="true"][contenteditable="true"], div[contenteditable="true"]'));
  const unique = [];
  const seen = new Set();

  for (const node of nodes) {
    if (seen.has(node)) continue;
    seen.add(node);

    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    unique.push(node);
  }

  return unique;
}

function getVisibleCommentSurfaces() {
  const selector = [
    'div[contenteditable="true"]',
    'div[role="textbox"]',
    'div[data-lexical-editor="true"]',
    'span[role="textbox"]',
    'span[data-lexical-editor="true"]',
    '[placeholder*="bình luận" i]',
    '[placeholder*="binh luan" i]',
    '[placeholder*="comment" i]',
    'div[role="button"][aria-label*="bình luận dưới tên" i]',
    'div[role="button"][aria-label*="binh luan duoi ten" i]',
    'div[role="button"][aria-label*="comment as" i]',
    'div[aria-label*="bình luận dưới tên" i]',
    'div[aria-label*="binh luan duoi ten" i]',
    'div[aria-label*="comment as" i]',
    '[aria-label*="bình luận dưới tên" i]',
    '[aria-label*="binh luan duoi ten" i]',
    '[aria-label*="comment as" i]'
  ].join(', ');

  const nodes = Array.from(document.querySelectorAll(selector));
  const unique = [];
  const seen = new Set();

  for (const node of nodes) {
    if (seen.has(node)) continue;
    seen.add(node);

    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    unique.push(node);
  }

  return unique;
}

function getComposerHintText(composer) {
  if (!composer) return '';
  const text = (composer.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
  return `${composer.getAttribute('aria-label') || ''} ${composer.getAttribute('aria-placeholder') || ''} ${composer.getAttribute('data-placeholder') || ''} ${composer.getAttribute('placeholder') || ''} ${text}`.toLowerCase().trim();
}

function hasCommentPromptHint(text) {
  if (!text) return false;
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return normalized.includes('bình luận dưới tên')
    || normalized.includes('binh luan duoi ten')
    || normalized.includes('comment as');
}

function hasUnderNameHint(composer) {
  const hint = getComposerHintText(composer);
  return hasCommentPromptHint(hint);
}

function isLikelyCommentSurface(node) {
  if (!node) return false;

  if (isLikelyCommentComposer(node)) {
    return true;
  }

  const hint = getComposerHintText(node);
  if (hasCommentPromptHint(hint)) {
    return true;
  }

  const role = (node.getAttribute('role') || '').toLowerCase();
  return role === 'textbox' || role === 'combobox';
}

function findInlinePromptSurfaceInPost(post) {
  if (!post) return null;

  const candidates = Array.from(post.querySelectorAll('div, span'));
  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  const postRect = post.getBoundingClientRect();

  for (const node of candidates) {
    const rawText = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (!rawText || rawText.length > 120) continue;
    if (!hasCommentPromptHint(rawText)) continue;
    if (!isVisible(node)) continue;

    const rect = node.getBoundingClientRect();
    const inBottomZone = rect.top >= (postRect.top - 80) && rect.top <= (postRect.bottom + 220);
    const sizeScore = Math.min(rect.width / 20, 18) + Math.min(rect.height * 2, 12);
    let score = sizeScore;
    if (inBottomZone) score += 28;
    if (node.getAttribute('role') === 'textbox') score += 12;

    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }

  return best;
}

function isLikelyCommentComposer(composer) {
  if (!composer) return false;

  const text = getComposerHintText(composer);
  if (text.includes('bình luận') || text.includes('binh luan') || text.includes('comment') || text.includes('trả lời') || text.includes('reply')) {
    return true;
  }

  return composer.getAttribute('data-lexical-editor') === 'true';
}

function pickBestCommentComposer(composers, anchorElement, post) {
  if (!composers.length) return null;

  const anchorRect = anchorElement?.getBoundingClientRect?.() || null;
  const ax = anchorRect ? (anchorRect.left + (anchorRect.width / 2)) : 0;
  const ay = anchorRect ? (anchorRect.top + (anchorRect.height / 2)) : 0;

  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const composer of composers) {
    let score = 0;
    const hint = getComposerHintText(composer);

    if (hasUnderNameHint(composer)) score += 80;
    if (hint.includes('bình luận') || hint.includes('comment')) score += 30;
    if (composer.getAttribute('data-lexical-editor') === 'true') score += 15;
    if (post && post.contains(composer)) score += 20;

    if (anchorRect) {
      const rect = composer.getBoundingClientRect();
      const cx = rect.left + (rect.width / 2);
      const cy = rect.top + (rect.height / 2);
      const dist = Math.hypot(cx - ax, cy - ay);
      score -= Math.min(dist / 40, 30);
    }

    if (score > bestScore) {
      bestScore = score;
      best = composer;
    }
  }

  return best;
}

function pickClosestComposer(composers, anchorElement) {
  if (!composers.length) return null;
  if (!anchorElement) return composers[0];

  const anchorRect = anchorElement.getBoundingClientRect();
  const ax = anchorRect.left + (anchorRect.width / 2);
  const ay = anchorRect.top + (anchorRect.height / 2);

  let best = null;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const composer of composers) {
    const rect = composer.getBoundingClientRect();
    const cx = rect.left + (rect.width / 2);
    const cy = rect.top + (rect.height / 2);
    const dist = Math.hypot(cx - ax, cy - ay);

    if (dist < bestDist) {
      bestDist = dist;
      best = composer;
    }
  }

  return best;
}

function isComposerAssociatedWithAnchor(composer, anchorElement) {
  if (!composer || !anchorElement) return false;

  const composerRect = composer.getBoundingClientRect();
  const anchorRect = anchorElement.getBoundingClientRect();

  const cx = composerRect.left + (composerRect.width / 2);
  const cy = composerRect.top + (composerRect.height / 2);
  const ax = anchorRect.left + (anchorRect.width / 2);
  const ay = anchorRect.top + (anchorRect.height / 2);

  const dist = Math.hypot(cx - ax, cy - ay);
  const horizontalOffset = Math.abs(cx - ax);
  const verticalInRange = cy >= (anchorRect.top - 140) && cy <= (anchorRect.bottom + 500);

  // Facebook can render composer outside post DOM. Keep a permissive but bounded proximity check.
  return dist <= 420 || (horizontalOffset <= Math.max(anchorRect.width, 280) && verticalInRange);
}

function getPostMatchScore(node, post) {
  if (!node || !post) return Number.NEGATIVE_INFINITY;

  const nodeRect = node.getBoundingClientRect();
  const postRect = post.getBoundingClientRect();

  const nx = nodeRect.left + (nodeRect.width / 2);
  const ny = nodeRect.top + (nodeRect.height / 2);
  const px = postRect.left + (postRect.width / 2);
  const py = postRect.bottom - Math.min(postRect.height * 0.2, 160);

  const overlapX = Math.max(0, Math.min(nodeRect.right, postRect.right) - Math.max(nodeRect.left, postRect.left));
  const overlapRatio = overlapX / Math.max(1, Math.min(nodeRect.width, postRect.width));
  const dyToBottom = Math.abs(ny - postRect.bottom);
  const dist = Math.hypot(nx - px, ny - py);

  let score = 0;
  if (post.contains(node)) score += 80;
  score += overlapRatio * 60;
  if (ny >= (postRect.top - 120) && ny <= (postRect.bottom + 280)) score += 22;
  score -= Math.min(dyToBottom / 14, 35);
  score -= Math.min(dist / 28, 42);

  return score;
}

function isNodeBestMatchedToPost(node, post, allPosts) {
  if (!node || !post) return false;

  const posts = Array.isArray(allPosts) && allPosts.length ? allPosts : getPostContainers();
  let bestPost = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of posts) {
    const score = getPostMatchScore(node, candidate);
    if (score > bestScore) {
      bestScore = score;
      bestPost = candidate;
    }
  }

  return bestPost === post && bestScore > -25;
}

function findBestMatchedPostForNode(node, posts) {
  if (!node || !Array.isArray(posts) || !posts.length) {
    return null;
  }

  let bestPost = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of posts) {
    const score = getPostMatchScore(node, candidate);
    if (score > bestScore) {
      bestScore = score;
      bestPost = candidate;
    }
  }

  return bestScore > -25 ? bestPost : null;
}

function findComposerForPost(post) {
  if (!post) return null;

  const inlineComposer = findComposerInPost(post);
  if (inlineComposer && isVisible(inlineComposer)) {
    return inlineComposer;
  }

  const trigger = findCommentTriggerInPost(post);
  const visibleComposers = getVisibleComposers().filter(isLikelyCommentComposer);
  if (!visibleComposers.length) {
    return null;
  }

  const anchor = trigger || post;
  const picked = pickBestCommentComposer(visibleComposers, anchor, post) || pickClosestComposer(visibleComposers, anchor);

  if (!picked) {
    return null;
  }

  if (post.contains(picked)) {
    return picked;
  }

  // Avoid mapping one open composer to many posts; only accept if this post is best match.
  if (!isNodeBestMatchedToPost(picked, post, getPostContainers())) {
    return null;
  }

  return isComposerAssociatedWithAnchor(picked, anchor) ? picked : null;
}

function findCommentSurfaceForPost(post, allPosts) {
  if (!post) return null;

  const inlinePromptSurface = findInlinePromptSurfaceInPost(post);
  if (inlinePromptSurface) {
    return inlinePromptSurface;
  }

  const composer = findComposerForPost(post);
  if (composer) {
    return composer;
  }

  const trigger = findCommentTriggerInPost(post);
  const anchor = trigger || post;
  const surfaces = getVisibleCommentSurfaces().filter(isLikelyCommentSurface);
  if (!surfaces.length) {
    return null;
  }

  const picked = pickBestCommentComposer(surfaces, anchor, post) || pickClosestComposer(surfaces, anchor);
  if (!picked) {
    return null;
  }

  if (post.contains(picked)) {
    return picked;
  }

  if (isNodeBestMatchedToPost(picked, post, allPosts)) {
    return picked;
  }

  return isComposerAssociatedWithAnchor(picked, anchor) ? picked : null;
}

async function openComposerFromVisibleSurface(post) {
  const surface = findCommentSurfaceForPost(post, getPostContainers());
  if (!surface) return null;

  if (surface.isContentEditable && isVisible(surface)) {
    return surface;
  }

  surface.scrollIntoView({ behavior: 'auto', block: 'center' });
  surface.click();

  for (const waitMs of [180, 280, 420, 620]) {
    await sleep(waitMs);
    const composer = findComposerForPost(post);
    if (composer) {
      return composer;
    }
  }

  return null;
}

function findSubmitButtonNearComposer(composer) {
  if (!composer) return null;

  // Only search very near composer to avoid clicking avatar/sticker tools.
  const searchContainers = [
    composer.closest('form'),
    composer.closest('[role="dialog"]'),
    composer.parentElement,
    composer.parentElement?.parentElement,
    composer.closest('div[class*="compose"]')
  ].filter(Boolean);

  const strongTokens = ['đăng', 'post', 'gửi', 'gui', 'send', 'submit', 'publish'];
  const weakTokens = ['bình luận', 'comment'];
  const bannedTokens = ['nhãn dán', 'sticker', 'avatar', 'gif', 'biểu tượng cảm xúc', 'emoji', 'ảnh', 'photo', 'video', 'camera', 'reel', 'thích', 'like', 'reaction', 'chia sẻ', 'share'];

  const composerRect = composer.getBoundingClientRect();
  const cx = composerRect.left + (composerRect.width / 2);
  const cy = composerRect.top + (composerRect.height / 2);
  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  // Search in each container
  for (const container of searchContainers) {
    if (!container) continue;
    
    const candidates = Array.from(container.querySelectorAll('button, div[role="button"], span[role="button"]'));
    
    for (const btn of candidates) {
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      
      const computedStyle = window.getComputedStyle(btn);
      if (computedStyle.display === 'none' || computedStyle.visibility === 'hidden') continue;

      const textContent = (btn.textContent || '').toLowerCase().trim();
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase().trim();
      const title = (btn.title || '').toLowerCase().trim();
      const text = `${textContent} ${ariaLabel} ${title}`.trim();
      if (!text) continue;

      if (bannedTokens.some((token) => text.includes(token))) continue;

      let score = 0;
      if (strongTokens.some((token) => text.includes(token))) score += 6;

      const isExactWeak = weakTokens.includes(ariaLabel) || weakTokens.includes(textContent);
      if (isExactWeak) score += 3;

      if (ariaLabel === 'bình luận bằng nhãn dán avatar' || ariaLabel.includes('bình luận bằng')) score -= 10;

      const bcx = rect.left + (rect.width / 2);
      const bcy = rect.top + (rect.height / 2);
      const dist = Math.hypot(bcx - cx, bcy - cy);
      score -= Math.min(dist / 50, 10);

      if (score > bestScore && score > 1) {
        bestScore = score;
        best = btn;
      }
    }
  }

  return best;
}

async function getStatusSnapshot() {
  const posts = getPostContainers();
  const processedSet = await getProcessedSet();

  let totalCandidates = 0;
  let blockedByHistory = 0;
  let availableCount = 0;
  let noComposerCount = 0;
  let commentBoxCount = 0;

  for (const post of posts) {
    const fingerprint = getPostFingerprint(post);

    if (fingerprint && processedSet.has(fingerprint)) {
      blockedByHistory += 1;
      continue;
    }

    totalCandidates += 1;

    const commentSurfaceForPost = findCommentSurfaceForPost(post, posts);
    const hasComposer = Boolean(commentSurfaceForPost);
    const hasTrigger = Boolean(findCommentTriggerInPost(post));

    if (hasComposer) {
      commentBoxCount += 1;
    }

    if (hasComposer || hasTrigger) {
      availableCount += 1;
    }
  }

  // Keep counters consistent even when Facebook mutates DOM during traversal.
  noComposerCount = Math.max(totalCandidates - availableCount, 0);

  const externalComposer = findAnyVisibleComposer(null, null);
  const externalComposerAvailable = Boolean(externalComposer);

  return {
    loadedPostCount: posts.length,
    containerCount: posts.length,
    totalCandidates,
    blockedByHistory,
    availableCount,
    commentBoxCount,
    noComposerCount,
    externalComposerAvailable
  };
}

function findCommentTriggerInPost(post) {
  const candidates = Array.from(post.querySelectorAll('[role="button"], button, a[role="button"]'));
  // Only look for comment-related buttons, not like/reaction/share.
  const tokens = ['comment', 'bình luận', 'binh luan', 'viết bình luận', 'viet binh luan'];
  const bannedTokens = ['thích', 'yêu thích', 'like', 'reaction', 'cảm xúc', 'share', 'chia sẻ'];
  let best = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    if (!isVisible(candidate)) continue;

    const textContent = (candidate.textContent || '').trim();
    const ariaLabel = (candidate.getAttribute('aria-label') || '').trim();
    const title = (candidate.title || '').trim();
    const text = `${textContent} ${ariaLabel} ${title}`.toLowerCase().trim();
    if (!text) continue;

    if (bannedTokens.some((token) => text.includes(token))) {
      continue;
    }

    // Ignore pure counters like "2" or noisy count-only labels.
    if (/^\d+$/.test(textContent)) {
      continue;
    }

    if (!tokens.some((token) => text.includes(token))) {
      continue;
    }

    // Prefer explicit aria-label/comment CTA over generic text nodes.
    let score = 1;
    if (/bình luận|binh luan|comment/.test(ariaLabel.toLowerCase())) score += 3;
    if (/viết bình luận|viet binh luan/.test(text)) score += 2;

    const rect = candidate.getBoundingClientRect();
    score += Math.max(0, Math.floor(rect.top / 300));

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

function findAnyVisibleComposer(anchorElement, post) {
  const visible = getVisibleComposers().filter(isLikelyCommentComposer);
  return pickBestCommentComposer(visible, anchorElement, post) || pickClosestComposer(visible, anchorElement);
}

async function ensureComposerReady(post, autoOpenComposer) {
  let composer = findComposerForPost(post);
  if (composer) {
    return composer;
  }

  // If Facebook shows "Binh luan duoi ten ..." surface, click it to open real composer.
  composer = await openComposerFromVisibleSurface(post);
  if (composer) {
    return composer;
  }

  // Handle case where comment box is already opened outside the post container.
  composer = findComposerForPost(post);
  if (composer) {
    return composer;
  }

  if (!autoOpenComposer) {
    return findComposerForPost(post);
  }

  const trigger = findCommentTriggerInPost(post);
  if (!trigger) {
    return null;
  }

  const beforeSet = new Set(getVisibleComposers());

  trigger.click();
  // Wait and poll because Facebook may render composer in a detached/modal container.
  for (const waitMs of [250, 450, 700, 950]) {
    await sleep(waitMs);

    composer = findComposerForPost(post);
    if (composer) {
      return composer;
    }

    const nowVisible = getVisibleComposers().filter(isLikelyCommentComposer);
    const newComposer = nowVisible.find((node) => !beforeSet.has(node));
    if (newComposer && isLikelyCommentComposer(newComposer)) {
      return newComposer;
    }

    const picked = pickBestCommentComposer(nowVisible, trigger, post) || pickClosestComposer(nowVisible, trigger);
    if (picked) {
      return picked;
    }
  }

  return null;
}

async function getProcessedSet() {
  const stored = await getStorageValue(STORAGE_KEY);
  return new Set(Array.isArray(stored) ? stored : []);
}

async function saveProcessedSet(processedSet) {
  const values = Array.from(processedSet);
  const recent = values.slice(Math.max(values.length - 2000, 0));
  await setStorageValue(STORAGE_KEY, recent);
}

async function markPostAsProcessed(target) {
  if (!target) return;

  target.post?.setAttribute('data-processed', 'true');
  if (target.scannedPost && target.scannedPost !== target.post) {
    target.scannedPost.setAttribute('data-processed', 'true');
  }

  if (target.ownerSessionKey) {
    sessionProcessedKeys.add(target.ownerSessionKey);
  }
  if (target.scannedSessionKey) {
    sessionProcessedKeys.add(target.scannedSessionKey);
  }

  if (target.fingerprint) {
    target.processedSet.add(target.fingerprint);
    if (target.scannedFingerprint) {
      target.processedSet.add(target.scannedFingerprint);
    }
    await saveProcessedSet(target.processedSet);
  }
}

function scrollFeedForNextBatch() {
  const amount = Math.max(Math.floor(window.innerHeight * 0.92), 680);
  window.scrollBy({ top: amount, left: 0, behavior: 'auto' });
}

async function findNextAvailableCommentBox(options = {}) {
  const {
    ignoreHistory = false,
    autoOpenComposer = true,
    allowScroll = true,
    maxScrollRounds = 8,
    mutateHistoryMarks = true,
    updateStatus = false
  } = options;

  const processedSet = await getProcessedSet();
  let blockedByHistory = 0;
  let totalCandidates = 0;
  let noComposerCount = 0;

  for (let round = 0; round <= maxScrollRounds; round++) {
    const posts = getPostContainers();
    const startCandidates = totalCandidates;
    const startNoComposer = noComposerCount;

    for (const post of posts) {
      const postSessionKey = getSessionPostKey(post);
      if (postSessionKey && sessionProcessedKeys.has(postSessionKey)) {
        continue;
      }

      if (post.hasAttribute('data-processed')) {
        continue;
      }

      const fingerprint = getPostFingerprint(post);

      if (!ignoreHistory && fingerprint && processedSet.has(fingerprint)) {
        blockedByHistory += 1;
        continue;
      }

      // Only increment totalCandidates after passing history check
      totalCandidates += 1;

      const box = await ensureComposerReady(post, autoOpenComposer);
      if (!box) {
        noComposerCount += 1;
        continue;
      }

      // Re-bind selected composer to the most likely owner post to avoid marking wrong post as processed.
      const ownerPost = findBestMatchedPostForNode(box, posts) || post;
      const ownerFingerprint = getPostFingerprint(ownerPost);
      const ownerSessionKey = getSessionPostKey(ownerPost);

      if (ownerSessionKey && sessionProcessedKeys.has(ownerSessionKey)) {
        continue;
      }

      if (!ignoreHistory && ownerFingerprint && processedSet.has(ownerFingerprint)) {
        blockedByHistory += 1;
        continue;
      }

      if (ownerPost.hasAttribute('data-processed')) {
        continue;
      }

      if (ownerSessionKey) {
        sessionProcessedKeys.add(ownerSessionKey);
      }
      if (scannedSessionKey && scannedSessionKey !== ownerSessionKey) {
        sessionProcessedKeys.add(scannedSessionKey);
      }

      return {
        box,
        scannedPost: post,
        post: ownerPost,
        fingerprint: ownerFingerprint || fingerprint,
        scannedFingerprint: fingerprint,
        ownerSessionKey,
        scannedSessionKey: postSessionKey,
        processedSet,
        totalCandidates,
        blockedByHistory,
        scrollRounds: round
      };
    }

    const roundCandidates = totalCandidates - startCandidates;
    const roundNoComposer = noComposerCount - startNoComposer;

    // Stop early to avoid endless scroll loops when visible posts exist but none can open comment box.
    if (roundCandidates > 0 && roundNoComposer >= roundCandidates) {
      return {
        none: true,
        processedSet,
        totalCandidates,
        blockedByHistory,
        noComposerCount,
        scrollRounds: round,
        noComposerInViewport: true
      };
    }

    if (!allowScroll || round >= maxScrollRounds) {
      continue;
    }

    scrollFeedForNextBatch();
    await sleep(900);
  }

  return { none: true, processedSet, totalCandidates, blockedByHistory, noComposerCount, scrollRounds: maxScrollRounds };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'pingStatus') {
    (async () => {
      const snapshot = await getStatusSnapshot();

      sendResponse({
        status: 'ready',
        pageUrl: window.location.href,
        commentBoxCount: snapshot.commentBoxCount,
        loadedPostCount: snapshot.loadedPostCount,
        availableCount: snapshot.availableCount,
        externalComposerAvailable: snapshot.externalComposerAvailable,
        historyBlockedCount: snapshot.blockedByHistory,
        containerCount: snapshot.containerCount,
        noComposerCount: snapshot.noComposerCount
      });
    })();
    return true;
  }

  if (request.action === 'resetProcessedHistory') {
    (async () => {
      await setStorageValue(STORAGE_KEY, []);
      sessionProcessedKeys.clear();
      document.querySelectorAll('[data-processed="true"]').forEach((node) => {
        node.removeAttribute('data-processed');
      });
      sendResponse({ status: 'ResetDone' });
    })();
    return true;
  }

  if (request.action !== 'fillNext') {
    return;
  }

  (async () => {
    if (!request.comment) {
      sendResponse({ status: 'Missing comment content' });
      return;
    }

    const target = await findNextAvailableCommentBox({
      ignoreHistory: Boolean(request.ignoreHistory),
      autoOpenComposer: true,
      allowScroll: true,
      maxScrollRounds: 4,
      mutateHistoryMarks: true
    });

    if (target.none) {
      if (target.totalCandidates > 0 && target.blockedByHistory >= target.totalCandidates) {
        sendResponse({
          status: 'HistoryBlocked',
          totalCandidates: target.totalCandidates,
          blockedByHistory: target.blockedByHistory
        });
        return;
      }

      sendResponse({
        status: 'No more posts',
        totalCandidates: target.totalCandidates,
        blockedByHistory: target.blockedByHistory,
        scrollRounds: target.scrollRounds
      });
      return;
    }

    target.box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.box.focus();
    // Click vào contenteditable để active nó (quan trọng cho trường hợp 2)
    target.box.click();
    await sleep(100);

    // Clear existing text and set new comment
    target.box.textContent = '';
    await sleep(50);
    
    target.box.textContent = request.comment;
    target.box.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: request.comment
    }));

    // Wait a bit for button to enable/appear
    await sleep(300);

    // Find and click submit button
    const submitBtn = findSubmitButtonNearComposer(target.box);
    if (submitBtn) {
      submitBtn.click();
      // Wait for comment to be posted
      await sleep(1200);
    } else {
      // Fallback: many Facebook comment boxes submit on Enter.
      target.box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      target.box.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      await sleep(900);
    }

    // Mark only after submit so the next run skips posts that were actually handled.
    await markPostAsProcessed(target);

    const nextPost = findNextPostInFeed(target.post, getPostContainers());
    if (nextPost) {
      scrollPostIntoView(nextPost);
    } else {
      scrollFeedForNextBatch();
    }
    sendResponse({ status: 'Filled', scrollRounds: target.scrollRounds });
  })();

  return true;
});
