const STORAGE_KEY = 'processedPostFingerprints';

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
  const articlePosts = Array.from(document.querySelectorAll('[role="article"]'));
  const fallbackPosts = articlePosts.length
    ? []
    : Array.from(document.querySelectorAll('[data-pagelet*="FeedUnit"], [data-pagelet*="Story"]'));
  const rawPosts = articlePosts.length ? articlePosts : fallbackPosts;
  const unique = [];
  const seen = new Set();

  for (const post of rawPosts) {
    if (!isVisible(post)) continue;
    if (seen.has(post)) continue;
    seen.add(post);
    unique.push(post);
  }

  return unique;
}

function getPostFingerprint(post) {
  if (!post) return null;

  const pagelet = post.getAttribute('data-pagelet') || '';
  const dataFt = post.getAttribute('data-ft') || '';
  const firstLink = post.querySelector('a[href]')?.getAttribute('href') || '';
  const permalink = post.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid="], a[href*="fbid="]')?.getAttribute('href') || '';
  const domSignature = getDomPathSignature(post);
  const textPreview = (post.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const rawFingerprint = [pagelet, dataFt, permalink, firstLink, domSignature, textPreview].join('|');

  if (!rawFingerprint.replace(/\|/g, '').trim()) return null;
  return createSimpleHash(rawFingerprint);
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
    if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') continue;

    unique.push(node);
  }

  return unique;
}

function getComposerHintText(composer) {
  if (!composer) return '';
  return `${composer.getAttribute('aria-label') || ''} ${composer.getAttribute('aria-placeholder') || ''} ${composer.getAttribute('data-placeholder') || ''}`.toLowerCase().trim();
}

function hasUnderNameHint(composer) {
  const hint = getComposerHintText(composer);
  return hint.includes('bình luận dưới tên') || hint.includes('binh luan duoi ten') || hint.includes('comment as');
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

  for (const post of posts) {
    const fingerprint = getPostFingerprint(post);

    if (fingerprint && processedSet.has(fingerprint)) {
      blockedByHistory += 1;
      continue;
    }

    totalCandidates += 1;

    const inlineComposer = findComposerInPost(post);
    const hasInlineComposer = Boolean(inlineComposer && isVisible(inlineComposer));
    const hasTrigger = Boolean(findCommentTriggerInPost(post));

    if (hasInlineComposer || hasTrigger) {
      availableCount += 1;
    } else {
      noComposerCount += 1;
    }
  }

  const externalComposer = findAnyVisibleComposer(null, null);
  const externalComposerAvailable = Boolean(externalComposer);

  return {
    loadedPostCount: posts.length,
    containerCount: posts.length,
    totalCandidates,
    blockedByHistory,
    availableCount,
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
  let composer = findComposerInPost(post);
  if (composer && isVisible(composer)) {
    return composer;
  }

  // Handle case where comment box is already opened outside the post container.
  composer = findAnyVisibleComposer(post, post);
  if (composer) {
    return composer;
  }

  if (!autoOpenComposer) {
    return findAnyVisibleComposer(post, post);
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

    composer = findComposerInPost(post);
    if (composer && isVisible(composer)) {
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

      // If a valid external composer is already open, use it immediately.
      const externalComposer = findAnyVisibleComposer(post, post);
      if (externalComposer) {
        return {
          box: externalComposer,
          post,
          fingerprint,
          processedSet,
          totalCandidates,
          blockedByHistory,
          scrollRounds: round
        };
      }

      const box = await ensureComposerReady(post, autoOpenComposer);
      if (!box) {
        noComposerCount += 1;
        continue;
      }

      return {
        box,
        post,
        fingerprint,
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
      const liveCommentBoxes = Array.from(document.querySelectorAll('div[contenteditable="true"]')).filter((box) => {
        const post = getPostContainer(box);
        return Boolean(post) && isVisible(box);
      }).length;

      sendResponse({
        status: 'ready',
        pageUrl: window.location.href,
        commentBoxCount: liveCommentBoxes,
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
    let submitSucceeded = false;
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

    // Treat as success only when composer content changes from original full text.
    const currentText = (target.box.textContent || '').replace(/\u200b/g, '').trim();
    const expectedText = (request.comment || '').trim();
    if (currentText !== expectedText) {
      submitSucceeded = true;
    }

    if (!submitSucceeded) {
      sendResponse({ status: 'SubmitFailed', scrollRounds: target.scrollRounds });
      return;
    }

    target.post.setAttribute('data-processed', 'true');

    if (target.fingerprint) {
      target.processedSet.add(target.fingerprint);
      await saveProcessedSet(target.processedSet);
    }

    target.post.scrollIntoView({ behavior: 'smooth', block: 'center' });
    sendResponse({ status: 'Filled', scrollRounds: target.scrollRounds });
  })();

  return true;
});
