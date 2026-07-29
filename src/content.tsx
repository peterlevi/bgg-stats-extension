import { getRatingColor } from './utils';
import { wireTooltip } from './tooltip';
import { buildGameIndex, resolveProductTitle, GameIndex } from './matching';

interface GameData {
  id: string;
  name: string;
  rank: string;
  average: string;
  yearpublished: string;
  usersrated?: string;
}

// Minimum ratings for the free-text fallback path (grids use the full index).
const TEXT_SCAN_MIN_VOTES = 100;

// Global state for mutation observer and game data
let currentBggData: GameData[] | null = null;
let gameIndex: GameIndex | null = null;
let urlChangeObserver: MutationObserver | null = null;
let urlChangeTimeout: NodeJS.Timeout | null = null;
let currentUrl: string = window.location.href;
let useCaseInsensitive: boolean = true; // Default to true since we added the 'i' flag
let statsShown: boolean = false; // Track whether stats are currently shown

// Storage keys
const CASE_INSENSITIVE_DOMAINS_KEY = "bggCaseInsensitiveDomains";

// Helper function to notify popup/background of working state
function notifyWorkingState(working: boolean) {
  try {
    chrome.runtime.sendMessage({
      action: "setWorkingState",
      working: working
    }).catch((error) => {
      // Ignore errors if popup is not open
      console.log('Could not notify working state (popup may be closed):', error);
    });
  } catch (error) {
    console.error("Error notifying working state:", error);
  }
}

// Helper function to escape special regex characters
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A name is "distinctive" enough to match case-insensitively when it is either
// multi-word or a longish single word. Short, common single words (e.g. "War",
// "Go", "City", "RED") stay case-sensitive to avoid matching random prose.
function isDistinctiveName(name: string): boolean {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const alnumLen = name.replace(/[^A-Za-z0-9]/g, '').length;
  return words.length >= 2 || alnumLen >= 6;
}

// Build a regex body that matches the game name while tolerating the whitespace
// differences shops introduce around punctuation. For example the BGG name
// "World Order: Diplomacy & Dominance" must match a page that renders it as
// "World Order : Diplomacy & Dominance" (space before the colon). Without this,
// only the base game "World Order" would match, badging the prefix instead of
// the full expansion title.
function buildFlexibleNamePattern(name: string): string {
  // Split into alphanumeric tokens and separator runs (spaces + punctuation).
  const parts = name.match(/[A-Za-z0-9]+|[^A-Za-z0-9]+/g) || [];
  let pattern = '';
  for (const part of parts) {
    if (/^[A-Za-z0-9]+$/.test(part)) {
      pattern += escapeRegex(part);
    } else {
      const punct = part.replace(/\s+/g, ''); // punctuation only, spaces stripped
      if (punct === '') {
        // Separator was pure whitespace -> require at least one space.
        pattern += '\\s+';
      } else {
        // Punctuation with optional surrounding whitespace on both sides
        // and between consecutive punctuation characters.
        pattern += '\\s*' + Array.from(punct).map(escapeRegex).join('\\s*') + '\\s*';
      }
    }
  }
  return pattern;
}

// Helper function to create a regex pattern that handles punctuation in game names
function createGameNameRegex(gameName: string): RegExp {
  const body = buildFlexibleNamePattern(gameName);
  // Match the game name only when it is not glued to another alphanumeric
  // character (i.e. it is a whole "token", not part of a longer word). Any
  // whitespace, punctuation, dash, slash, symbol, or non-Latin letter counts as
  // a boundary, so titles surrounded by things like "–", "/", "™", digits, or
  // Cyrillic text on Bulgarian shops are matched correctly.
  // Distinctive (multi-word / long) names match case-insensitively so that
  // ALL-CAPS product titles like "CODENAMES DUET" are caught; short common
  // words stay case-sensitive unless the domain opted into case-insensitive.
  const flags = (useCaseInsensitive || isDistinctiveName(gameName)) ? 'gi' : 'g';
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, flags);
}

// Helper function to create hexagon badge
function createRatingBadge(
  rating: string,
  rank: string,
  year: string
): HTMLElement {
  const ratingNum = parseFloat(rating);
  const displayRating = isNaN(ratingNum) ? '0.0' : ratingNum.toFixed(1);
  const color = getRatingColor(rating);

  const badge = document.createElement('span');
  badge.style.cssText = `
    display: inline;
    background-color: ${color};
    color: white;
    font-weight: bold;
    padding: 1px 4px;
    margin-right: 4px;
    border-radius: 4px;
    font-size: inherit;
    line-height: inherit;
    vertical-align: baseline;
    white-space: nowrap;
  `;
  badge.setAttribute('data-bgg-rating-badge', 'true');
  badge.title = `BGG Rating: ${displayRating} | Rank: ${rank} | Year: ${year}`;
  badge.textContent = displayRating;

  return badge;
}

// ---------------------------------------------------------------------------
// Structural (product-grid) detection
// ---------------------------------------------------------------------------

interface ProductTile {
  tile: HTMLElement;
  titleEl: HTMLElement;
  titleText: string;
  slug: string;
}

// Signature of an element for grouping siblings: tag + stable class tokens
// (drop dynamic/state classes so grid items still group together).
function elementSignature(el: Element): string {
  const cls = Array.from(el.classList)
    .filter(c => !/^\d/.test(c) && !/(active|hover|selected|open|current|show|hidden|lazy|loaded|first|last|even|odd)/i.test(c))
    .sort()
    .join('.');
  return el.tagName + '|' + cls;
}

function slugFromHref(href: string): string {
  if (!href) return '';
  try {
    const path = href.split('?')[0].split('#')[0];
    const parts = path.split('/').filter(Boolean);
    return (parts.pop() || '').replace(/\.(html?|php|aspx)$/i, '');
  } catch {
    return '';
  }
}

// Pick the element within a tile most likely to hold the product title.
function findTitleElement(tile: HTMLElement): HTMLElement | null {
  const byClass = tile.querySelector<HTMLElement>('[class*="title" i], [class*="name" i]');
  if (byClass && (byClass.textContent || '').trim().length >= 2) return byClass;
  const heading = tile.querySelector<HTMLElement>('h1, h2, h3, h4, h5');
  if (heading && (heading.textContent || '').trim().length >= 2) return heading;
  // Longest-text anchor that links somewhere (product link)
  let best: HTMLElement | null = null;
  let bestLen = 0;
  tile.querySelectorAll<HTMLElement>('a[href]').forEach(a => {
    const len = (a.textContent || '').trim().length;
    if (len > bestLen && len <= 160) { best = a; bestLen = len; }
  });
  return best;
}

// Detect repeating product tiles across the page (all qualifying grids).
function findProductTiles(): ProductTile[] {
  const tiles: ProductTile[] = [];
  const seen = new Set<HTMLElement>();

  const parents = document.querySelectorAll('*');
  for (const parent of Array.from(parents)) {
    const kids = Array.from(parent.children) as HTMLElement[];
    if (kids.length < 5) continue;
    const bySig = new Map<string, HTMLElement[]>();
    for (const k of kids) {
      const s = elementSignature(k);
      const arr = bySig.get(s) || [];
      arr.push(k);
      bySig.set(s, arr);
    }
    for (const group of bySig.values()) {
      if (group.length < 5) continue;
      // Product tiles contain both a link and an image
      const productish = group.filter(e => e.querySelector('a[href]') && e.querySelector('img'));
      if (productish.length < 5) continue;
      for (const tile of productish) {
        if (seen.has(tile)) continue;
        seen.add(tile);
        const titleEl = findTitleElement(tile);
        if (!titleEl) continue;
        const linkEl =
          (titleEl.matches('a[href]') ? titleEl : titleEl.querySelector('a[href]')) ||
          tile.querySelector('a[href]');
        const slug = slugFromHref(linkEl ? (linkEl as HTMLAnchorElement).getAttribute('href') || '' : '');
        tiles.push({
          tile,
          titleEl,
          titleText: (titleEl.textContent || '').replace(/\s+/g, ' ').trim(),
          slug,
        });
      }
    }
  }
  return tiles;
}

// Prepend a rating badge to a resolved product-tile title (badge the record
// once, rather than surgically wrapping a substring).
function badgeTile(tile: ProductTile, game: GameData): boolean {
  const { titleEl } = tile;
  if (titleEl.closest('[data-bgg-tile]') || titleEl.querySelector('[data-bgg-rating-badge]')) {
    return false;
  }
  const badge = createRatingBadge(game.average, game.rank, game.yearpublished);
  titleEl.insertBefore(badge, titleEl.firstChild);
  titleEl.setAttribute('data-bgg-tile', 'true');
  try {
    wireTooltip(titleEl, game.id);
  } catch (e) {
    // tooltip is best-effort
  }
  return true;
}

// Structural pass: resolve each product tile to a game via the full index.
function runStructuralPass(): number {
  if (!gameIndex) return 0;
  const tiles = findProductTiles();
  if (tiles.length === 0) return 0;
  let badged = 0;
  for (const tile of tiles) {
    if (!tile.titleText && !tile.slug) continue;
    if (tile.titleEl.hasAttribute('data-bgg-tile')) continue;
    const res = resolveProductTitle(tile.titleText, tile.slug, gameIndex);
    if (!res) continue;
    if (badgeTile(tile, res.game as GameData)) badged++;
  }
  console.log(`Content: Structural pass badged ${badged}/${tiles.length} product tiles`);
  return badged;
}

// Process the entire page for game badges
async function processBadgesForPage(messageDiv?: HTMLElement) {
  const startTime = performance.now();
  console.log('Content: [TIMING] processBadgesForPage started');

  if (!currentBggData || currentBggData.length === 0) {
    return;
  }

  const providedMessageDiv = messageDiv;
  let msgDiv: HTMLElement;
  if (!providedMessageDiv) {
    let div = document.querySelector('[data-bgg-message]') as HTMLElement;
    if (!div) {
      div = document.createElement('div');
      div.setAttribute('data-bgg-message', 'true');
      div.style.cssText = `
        position: fixed;
        top: 10px;
        right: 10px;
        background-color: lightblue;
        z-index: 99999;
        padding: 8px 12px;
        border-radius: 4px;
        font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 13px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      `;
      document.body.prepend(div);
    }
    msgDiv = div;
  } else {
    msgDiv = providedMessageDiv;
  }

  msgDiv.style.display = 'block';
  msgDiv.textContent = 'Searching for board games...';

  try {
    // Build the game index once (shared by structural matching).
    if (!gameIndex && currentBggData) {
      const idxStart = performance.now();
      gameIndex = buildGameIndex(currentBggData as any);
      console.log(`Content: [TIMING] Built game index in ${(performance.now() - idxStart).toFixed(2)}ms`);
    }

    // 1) STRUCTURAL PASS: resolve product-grid tiles to full titles (high
    //    precision; allows niche/low-vote games because structure proves the
    //    tile is a product).
    let structuralBadges = 0;
    try {
      structuralBadges = runStructuralPass();
    } catch (e) {
      console.warn('Content: structural pass error', e);
    }

    // 2) GUARDED FREE-TEXT FALLBACK: scan remaining page text, but only for
    //    popular, distinctive names, and never inside product tiles already
    //    handled structurally.
    const searchStartTime = performance.now();
    const pageText = document.body.innerText;
    const pageTextTime = performance.now();
    console.log(`Content: [TIMING] Getting page text took ${(pageTextTime - searchStartTime).toFixed(2)}ms`);

    const foundGames: GameData[] = [];

    for (const gameData of currentBggData) {
      const votes = parseInt(gameData.usersrated || '0', 10) || 0;
      if (votes < TEXT_SCAN_MIN_VOTES) continue; // popularity gate on free text
      if (!isDistinctiveName(gameData.name)) continue; // avoid short common words
      try {
        const regex = createGameNameRegex(gameData.name);
        if (regex.test(pageText)) {
          foundGames.push(gameData);
        }
      } catch (error) {
        console.warn(`Content: Skipping game "${gameData.name}" due to regex error:`, error);
      }
    }

    const searchEndTime = performance.now();
    console.log(`Content: [TIMING] Searching for games took ${(searchEndTime - pageTextTime).toFixed(2)}ms`);
    console.log(`Content: Found ${foundGames.length} games mentioned on page (fallback)`);

    if (foundGames.length === 0) {
      if (structuralBadges > 0) {
        msgDiv.textContent = `Added ${structuralBadges} badge${structuralBadges !== 1 ? 's' : ''}`;
      } else {
        msgDiv.textContent = 'No board games found on this page.';
      }
      setTimeout(() => {
        msgDiv.style.display = 'none';
      }, 2000);
      console.log(`Content: [TIMING] Total processBadgesForPage took ${(performance.now() - startTime).toFixed(2)}ms`);
      return;
    }

    // Sort games by name length (longest first) to match longer titles before shorter ones
    const sortStartTime = performance.now();
    const sortedGames = [...foundGames].sort((a, b) => b.name.length - a.name.length);
    const sortEndTime = performance.now();
    console.log(`Content: [TIMING] Sorting games took ${(sortEndTime - sortStartTime).toFixed(2)}ms`);

    let gamesProcessed = 0;
    let totalBadgesAdded = 0;

    // Process games and add badges
    const badgeStartTime = performance.now();
    for (const game of sortedGames) {
      const gameStartTime = performance.now();
      try {
        const regex = createGameNameRegex(game.name);

        const walkerStartTime = performance.now();
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: function (node) {
              const parent = node.parentElement;
              if (
                !parent ||
                parent.closest('script, style, noscript') ||
                (msgDiv && (parent === msgDiv || msgDiv.contains(parent)))
              ) {
                return NodeFilter.FILTER_REJECT;
              }
              if (
                parent.querySelector('[data-bgg-rating-badge]') ||
                parent.closest('[data-bgg-wrapper]') ||
                parent.closest('[data-bgg-tile]')
              ) {
                return NodeFilter.FILTER_REJECT;
              }
              // NOTE: use String.search (stateless) instead of regex.test.
              // The regex is global ('g'), and regex.test() mutates lastIndex,
              // which would cause valid text nodes to be skipped intermittently.
              return (node.textContent || '').search(regex) !== -1
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_REJECT;
            },
          }
        );

        const nodesToProcess: { node: Text }[] = [];
        let currentNode: Node | null;

        while ((currentNode = walker.nextNode())) {
          const textNode = currentNode as Text;
          // String.match with a global regex is stateless (it ignores/resets
          // lastIndex), so this is safe to reuse the same regex object.
          if ((textNode.textContent || '').match(regex)) {
            nodesToProcess.push({ node: textNode });
          }
        }
        const walkerEndTime = performance.now();

        const replaceStartTime = performance.now();
        nodesToProcess.forEach(({ node }) => {
          const parent = node.parentElement;
          if (!parent) return;

          if (
            parent.querySelector('[data-bgg-rating-badge]') ||
            parent.closest('[data-bgg-wrapper]') ||
            parent.closest('[data-bgg-tile]')
          ) {
            return;
          }

          const text = node.textContent || '';
          // Badge every occurrence in this text node (not just the first).
          // matchAll requires a global regex and is stateless per call.
          const matches = Array.from(text.matchAll(regex));
          if (matches.length === 0) return;

          const fragment = document.createDocumentFragment();
          let lastIndex = 0;

          for (const match of matches) {
            const matchIndex = match.index ?? 0;
            const matchText = match[0];
            if (!matchText) continue;

            // Text between the previous match and this one
            if (matchIndex > lastIndex) {
              fragment.appendChild(
                document.createTextNode(text.substring(lastIndex, matchIndex))
              );
            }

            const badge = createRatingBadge(game.average, game.rank, game.yearpublished);
            const matchNode = document.createTextNode(matchText);

            const wrapper = document.createElement('span');
            wrapper.setAttribute('data-bgg-wrapper', 'true');
            wrapper.style.cssText = `
              background-color: #e6f2ff;
              padding: 1px 3px;
              border-radius: 2px;
              display: inline;
              line-height: inherit;
            `;
            wrapper.appendChild(badge);
            wrapper.appendChild(matchNode);

            wireTooltip(wrapper, game.id);

            fragment.appendChild(wrapper);
            lastIndex = matchIndex + matchText.length;
            totalBadgesAdded++;
          }

          // Trailing text after the last match
          if (lastIndex < text.length) {
            fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
          }

          // Replace the original text node with the badged fragment
          parent.insertBefore(fragment, node);
          parent.removeChild(node);
        });
        const replaceEndTime = performance.now();

        gamesProcessed++;
        const gameEndTime = performance.now();
        const gameTotalTime = gameEndTime - gameStartTime;
        if (gameTotalTime > 10) { // Only log slow games
          console.log(`Content: [TIMING] Game "${game.name}" took ${gameTotalTime.toFixed(2)}ms (walker: ${(walkerEndTime - walkerStartTime).toFixed(2)}ms, replace: ${(replaceEndTime - replaceStartTime).toFixed(2)}ms, nodes: ${nodesToProcess.length})`);
        }

        // Yield to the browser every 3 games to keep UI responsive
        if (gamesProcessed % 3 === 0) {
          msgDiv.textContent = `Adding badges... (${gamesProcessed}/${sortedGames.length})`;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      } catch (error) {
        console.warn(`Content: Error adding badge for "${game.name}":`, error);
      }
    }
    const badgeEndTime = performance.now();
    console.log(`Content: [TIMING] Adding badges took ${(badgeEndTime - badgeStartTime).toFixed(2)}ms`);

    console.log(`Content: Added ${totalBadgesAdded} fallback badges for ${foundGames.length} games to the page.`);

    const grandTotal = totalBadgesAdded + structuralBadges;
    if (grandTotal > 0) {
      msgDiv.textContent = `Added ${grandTotal} badge${grandTotal !== 1 ? 's' : ''}`;
      setTimeout(() => {
        msgDiv.style.display = 'none';
      }, 2000);
    } else {
      msgDiv.style.display = 'none';
    }

    const totalTime = performance.now() - startTime;
    console.log(`Content: [TIMING] Total processBadgesForPage took ${totalTime.toFixed(2)}ms`);
  } catch (error) {
    console.error('Content: Error processing page for badges:', error);
    msgDiv.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
    setTimeout(() => {
      msgDiv.style.display = 'none';
    }, 3000);
    console.log(`Content: [TIMING] Total processBadgesForPage (with error) took ${(performance.now() - startTime).toFixed(2)}ms`);
  }
}

// Setup URL change monitoring with temporary mutation observer
function setupUrlChangeMonitoring() {
  console.log('Content: Setting up URL change monitoring...');

  // Handle popstate (back/forward navigation)
  window.addEventListener('popstate', () => {
    const newUrl = window.location.href;
    if (newUrl !== currentUrl) {
      currentUrl = newUrl;
      console.log('Content: URL changed via popstate to:', currentUrl);
      waitForDOMToSettle();
    }
  });

  // Monitor for pushState/replaceState (SPA navigation)
  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = function(state: any, unused: string, url?: string | URL | null) {
    originalPushState(state, unused, url);
    const newUrl = window.location.href;
    if (newUrl !== currentUrl) {
      currentUrl = newUrl;
      console.log('Content: URL changed via pushState to:', currentUrl);
      waitForDOMToSettle();
    }
  };

  history.replaceState = function(state: any, unused: string, url?: string | URL | null) {
    originalReplaceState(state, unused, url);
    const newUrl = window.location.href;
    if (newUrl !== currentUrl) {
      currentUrl = newUrl;
      console.log('Content: URL changed via replaceState to:', currentUrl);
      waitForDOMToSettle();
    }
  };

  // Also use a setInterval as a fallback to catch any URL changes we might miss
  setInterval(() => {
    const newUrl = window.location.href;
    if (newUrl !== currentUrl) {
      currentUrl = newUrl;
      console.log('Content: URL changed (detected via polling) to:', currentUrl);
      waitForDOMToSettle();
    }
  }, 500);

  console.log('Content: URL change monitoring setup complete');
}

// Wait for DOM changes to settle after URL change, then process badges
function waitForDOMToSettle() {
  // Disconnect any existing observer
  if (urlChangeObserver) {
    urlChangeObserver.disconnect();
    urlChangeObserver = null;
  }

  // Clear any existing timeout
  if (urlChangeTimeout) {
    clearTimeout(urlChangeTimeout);
    urlChangeTimeout = null;
  }

  // Create a temporary mutation observer to detect when DOM changes stop
  urlChangeObserver = new MutationObserver(() => {
    // Reset the timeout every time a mutation occurs
    if (urlChangeTimeout) {
      clearTimeout(urlChangeTimeout);
    }

    // Wait 1000ms after the last mutation before processing
    urlChangeTimeout = setTimeout(() => {
      console.log('Content: DOM settled after URL change, processing badges...');

      // Disconnect the observer
      if (urlChangeObserver) {
        urlChangeObserver.disconnect();
        urlChangeObserver = null;
      }

      // Process badges for the new page content
      processBadgesForPage();
    }, 1000);
  });

  // Start observing
  urlChangeObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  console.log('Content: Waiting for DOM to settle...');
}

// Main function to run the extension
async function runExtension() {
  const extensionStartTime = performance.now();
  console.log('Content: [TIMING] runExtension started');
  console.log('Content script running extension.');
  const messageDiv = document.createElement('div');
  messageDiv.setAttribute('data-bgg-message', 'true');
  messageDiv.textContent = 'Working...';
  messageDiv.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    background-color: lightblue;
    z-index: 99999;
    padding: 8px 12px;
    border-radius: 4px;
    font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 13px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  `;
  document.body.prepend(messageDiv);

  try {
    messageDiv.textContent = 'Checking BGG data...';
    let responseFromBackground;
    const getBggDataStart = performance.now();
    try {
      responseFromBackground = await chrome.runtime.sendMessage({
        action: 'getBggData',
      });
    } catch (e) {
      console.error('Content: Error sending getBggData message:', e);
      messageDiv.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
      setTimeout(() => {
        messageDiv.style.display = 'none';
      }, 3000);
      return;
    }
    const getBggDataEnd = performance.now();
    console.log(`Content: [TIMING] Getting BGG data from background took ${(getBggDataEnd - getBggDataStart).toFixed(2)}ms`);

    const { bggData, isOld } = responseFromBackground;
    currentBggData = bggData || [];

    console.log('Content: Received bggData:', currentBggData ? `${currentBggData.length} games` : 'null', 'isOld:', isOld);

    if (!currentBggData || currentBggData.length === 0 || isOld) {
      if (isOld && currentBggData && currentBggData.length > 0) {
        messageDiv.textContent = 'BGG data is old. Using cached data and updating in background...';
        chrome.runtime.sendMessage({ action: 'fetchBggData' })
          .then((response) => {
            if (response.success) {
              console.log('Content: BGG data updated asynchronously in background.');
            } else {
              console.error('Content: Error during async update:', response.error);
            }
          })
          .catch((e) => console.error('Content: Error during async update:', e));
      } else {
        messageDiv.textContent = 'Fetching game data from BGG...';
        console.log('Content: Fetching BGG data from background...');
        const fetchStart = performance.now();
        const fetchResponse = await chrome.runtime.sendMessage({
          action: 'fetchBggData',
        });
        const fetchEnd = performance.now();
        console.log(`Content: [TIMING] Fetching BGG data took ${(fetchEnd - fetchStart).toFixed(2)}ms`);
        console.log('Content: Fetch response:', fetchResponse);
        if (!fetchResponse.success) {
          throw new Error(fetchResponse.error);
        }
        currentBggData = fetchResponse.bggData;
        console.log('Content: Fetched bggData:', currentBggData ? `${currentBggData.length} games` : 'null');
      }
    }

    if (!currentBggData || currentBggData.length === 0) {
      console.error('Content: currentBggData is still empty after fetch attempt');
      messageDiv.textContent = 'BGG data not available. Please try again later.';
      setTimeout(() => {
        messageDiv.style.display = 'none';
      }, 3000);
      return;
    }

    // Filter out games with numeric-only names and deduplicate by name, keeping highest rank (lowest number)
    const buildMapStart = performance.now();
    const gamesByName = new Map<string, GameData>();

    for (const game of currentBggData) {
      // Skip numeric-only names
      if (/^\d{1,3}$/.test(game.name)) {
        continue;
      }

      const existing = gamesByName.get(game.name);
      if (!existing) {
        gamesByName.set(game.name, game);
      } else {
        // Keep the game with the better (lower) rank
        const existingRank = parseInt(existing.rank) || Infinity;
        const newRank = parseInt(game.rank) || Infinity;
        if (newRank < existingRank) {
          gamesByName.set(game.name, game);
        }
      }
    }

    currentBggData = Array.from(gamesByName.values());
    const buildMapEnd = performance.now();
    console.log(`Content: [TIMING] Filtering and deduplicating games took ${(buildMapEnd - buildMapStart).toFixed(2)}ms`);
    console.log(`Content: Using ${currentBggData.length} games`);

    // Now use processBadgesForPage function to add badges
    await processBadgesForPage(messageDiv);

    const setupMonitorStart = performance.now();
    setupUrlChangeMonitoring();
    const setupMonitorEnd = performance.now();
    console.log(`Content: [TIMING] Setting up URL monitoring took ${(setupMonitorEnd - setupMonitorStart).toFixed(2)}ms`);

    const extensionEndTime = performance.now();
    console.log(`Content: [TIMING] Total runExtension took ${(extensionEndTime - extensionStartTime).toFixed(2)}ms`);
  } catch (error) {
    console.error('Content: Error in runExtension:', error);
    messageDiv.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
    setTimeout(() => {
      messageDiv.style.display = 'none';
    }, 3000);
    console.log(`Content: [TIMING] Total runExtension (with error) took ${(performance.now() - extensionStartTime).toFixed(2)}ms`);
  }
}

// Check if extension should auto-run on this domain
(async function checkAutoRun() {
  // Wait a bit for background script to be ready
  await new Promise(resolve => setTimeout(resolve, 100));

  try {
    const domain = window.location.hostname;

    // Load case-insensitive setting for this domain
    const result = await chrome.storage.local.get([CASE_INSENSITIVE_DOMAINS_KEY]);
    const caseInsensitiveDomains: string[] = result[CASE_INSENSITIVE_DOMAINS_KEY] || [];
    useCaseInsensitive = caseInsensitiveDomains.includes(domain);
    console.log('Content: Loaded case-insensitive setting for', domain, ':', useCaseInsensitive);

    const response = await chrome.runtime.sendMessage({ action: 'checkDomain', domain });
    if (response && response.enabled) {
      console.log('Content: Auto-running extension for domain:', domain);
      await notifyWorkingState(true);
      await runExtension();
      statsShown = true;
      await notifyWorkingState(false);
    }
  } catch (error) {
    // Silently ignore connection errors during auto-run check
    // This can happen if the page loads before the background script is ready
    if (error instanceof Error && error.message.includes('Could not establish connection')) {
      console.log('Content: Background script not ready yet, skipping auto-run check');
    } else {
      console.error('Content: Error checking auto-run:', error);
    }
  }
})();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'checkStatsShown') {
    sendResponse({ shown: statsShown });
  } else if (request.action === 'removeBadges') {
    console.log('Content script received removeBadges.');

    // Disconnect and clean up mutation observer
    if (urlChangeObserver) {
      urlChangeObserver.disconnect();
      urlChangeObserver = null;
    }

    // Clear state
    currentUrl = window.location.href;
    statsShown = false;

    // Remove all badges and wrappers
    const badges = document.querySelectorAll('[data-bgg-rating-badge]');
    const wrappers = document.querySelectorAll('[data-bgg-wrapper]');
    const tiles = document.querySelectorAll('[data-bgg-tile]');

    wrappers.forEach(wrapper => {
      // Get the text content (excluding badge) and replace wrapper with text node
      const badge = wrapper.querySelector('[data-bgg-rating-badge]');
      if (badge) {
        badge.remove();
      }
      const textContent = wrapper.textContent || '';
      const textNode = document.createTextNode(textContent);
      wrapper.parentNode?.replaceChild(textNode, wrapper);
    });

    // Clear structural tile markers so they can be re-badged next run
    tiles.forEach(tile => tile.removeAttribute('data-bgg-tile'));

    badges.forEach(badge => badge.remove());

    console.log(`Content: Removed ${wrappers.length} wrappers, ${tiles.length} tiles and ${badges.length} badges`);


    sendResponse({ success: true });
  } else if (request.action === 'displayMessage') {
    (async () => {
      await notifyWorkingState(true);
      await runExtension();
      statsShown = true;
      await notifyWorkingState(false);
      sendResponse({ success: true });
    })();
    return true; // Keep message channel open for async response
  } else if (request.action === 'updateCaseInsensitive') {
    useCaseInsensitive = request.value;
    console.log('Content: Updated case-insensitive setting to:', useCaseInsensitive);
    sendResponse({ success: true });
  }

  return true; // Keep message channel open for async responses
});
