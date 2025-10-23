import { getRatingColor } from './utils';
import { wireTooltip } from './tooltip';

interface GameData {
  id: string;
  name: string;
  rank: string;
  average: string;
  yearpublished: string;
}

// Global state for mutation observer and game data
let gameNameMap: Map<string, GameData> | null = null;
let mutationObserver: MutationObserver | null = null;
let isProcessing = false;
let isExtensionModifying = false; // New flag to ignore our own modifications
let mutationTimeout: NodeJS.Timeout | null = null;
let pendingElements: Element[] = [];
let useCaseInsensitive: boolean = true; // Default to true since we added the 'i' flag
let statsShown: boolean = false; // Track whether stats are currently shown

// Storage keys
const CASE_INSENSITIVE_DOMAINS_KEY = "bggCaseInsensitiveDomains";
const EXTENSION_WORKING_KEY = "bggExtensionWorking";

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

// Helper function to create a regex pattern that handles punctuation in game names
function createGameNameRegex(gameName: string): RegExp {
  const escapedName = escapeRegex(gameName);
  // Use a more flexible boundary that works with punctuation
  // Match if preceded by start of string, whitespace, or punctuation
  // and followed by end of string, whitespace, or punctuation
  // Use case-insensitive flag if enabled
  const flags = useCaseInsensitive ? 'gi' : 'g';
  return new RegExp(`(?:^|\\s|[.!?,:;'"()\\[\\]{}])${escapedName}(?=$|\\s|[.!?,:;'"()\\[\\]{}])`, flags);
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

// Process a specific element for game badges
async function processElementForGames(
  element: Element,
  messageDiv?: HTMLElement,
  showProgress: boolean = false
): Promise<number> {
  if (!gameNameMap || gameNameMap.size === 0) {
    return 0;
  }

  let badgesAdded = 0;
  const pageText = element.textContent || '';

  if (!pageText.trim()) {
    return 0;
  }

  // Find games that might be mentioned in this element
  const foundGames: GameData[] = [];
  for (const [gameName, gameData] of gameNameMap) {
    try {
      const regex = createGameNameRegex(gameName);
      if (regex.test(pageText)) {
        foundGames.push(gameData);
      }
    } catch (error) {
      console.warn(`Content: Skipping game "${gameName}" due to regex error:`, error);
    }
  }

  if (foundGames.length === 0) {
    return 0;
  }

  const sortedGames = [...foundGames].sort((a, b) => b.name.length - a.name.length);
  let gamesProcessed = 0;

  for (const game of sortedGames) {
    try {
      const regex = createGameNameRegex(game.name);

      const walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: function (node) {
            const parent = node.parentElement;
            if (
              !parent ||
              parent.closest('script, style, noscript') ||
              (messageDiv && (parent === messageDiv || messageDiv.contains(parent)))
            ) {
              return NodeFilter.FILTER_REJECT;
            }
            if (
              parent.querySelector('[data-bgg-rating-badge]') ||
              parent.closest('[data-bgg-wrapper]')
            ) {
              return NodeFilter.FILTER_REJECT;
            }
            return regex.test(node.textContent || '')
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT;
          },
        }
      );

      const nodesToProcess: { node: Text }[] = [];
      let currentNode: Node | null;

      while ((currentNode = walker.nextNode())) {
        const textNode = currentNode as Text;
        if (textNode.textContent?.match(regex)) {
          nodesToProcess.push({ node: textNode });
        }
      }

      nodesToProcess.forEach(({ node }) => {
        const parent = node.parentElement;
        if (!parent) return;

        if (
          parent.querySelector('[data-bgg-rating-badge]') ||
          parent.closest('[data-bgg-wrapper]')
        ) {
          return;
        }

        const text = node.textContent || '';
        const match = regex.exec(text);
        if (!match) return;

        const matchIndex = match.index;
        const matchText = match[0];

        const beforeText = text.substring(0, matchIndex);
        const afterText = text.substring(matchIndex + matchText.length);

        const beforeNode = document.createTextNode(beforeText);
        const badge = createRatingBadge(game.average, game.rank, game.yearpublished);
        const matchNode = document.createTextNode(matchText);
        const afterNode = document.createTextNode(afterText);

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

        const fragment = document.createDocumentFragment();
        if (beforeText) fragment.appendChild(beforeNode);
        fragment.appendChild(wrapper);
        if (afterText) fragment.appendChild(afterNode);

        parent.replaceChild(fragment, node);
        badgesAdded++;
      });

      gamesProcessed++;

      if (showProgress && gamesProcessed % 5 === 0 && messageDiv) {
        messageDiv.textContent = `Adding badges... (${gamesProcessed}/${sortedGames.length})`;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } catch (error) {
      console.warn(`Content: Error adding badge for "${game.name}":`, error);
    }
  }

  return badgesAdded;
}

// Process pending elements after DOM mutations have settled
async function processPendingElements() {
  if (isProcessing || pendingElements.length === 0 || !gameNameMap) {
    return;
  }

  isProcessing = true;
  isExtensionModifying = true; // Set flag before starting modifications
  const elementsToProcess = [...pendingElements];
  pendingElements = [];

  // Create or reuse message div
  let messageDiv = document.querySelector('[data-bgg-message]') as HTMLElement;
  if (!messageDiv) {
    messageDiv = document.createElement('div');
    messageDiv.setAttribute('data-bgg-message', 'true');
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
  }
  messageDiv.style.display = 'block';
  messageDiv.textContent = `Processing new content...`;

  try {
    let totalBadgesAdded = 0;

    // Don't disconnect observer, just let the flag handle ignoring mutations
    // This is more efficient than constantly disconnecting/reconnecting

    // Process elements with yielding to keep browser responsive
    for (let i = 0; i < elementsToProcess.length; i++) {
      const element = elementsToProcess[i];

      if (!document.body.contains(element)) {
        continue;
      }

      const badgesAdded = await processElementForGames(element);
      totalBadgesAdded += badgesAdded;

      // Yield to browser every element to prevent freezing
      if (i > 0) {
        messageDiv.textContent = `Processing new content... (${i + 1}/${elementsToProcess.length})`;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    if (totalBadgesAdded > 0) {
      console.log(`Content: Added ${totalBadgesAdded} badges to dynamically added content`);
      messageDiv.textContent = `Added ${totalBadgesAdded} badge${totalBadgesAdded !== 1 ? 's' : ''} to new content`;
      setTimeout(() => {
        messageDiv.style.display = 'none';
      }, 2000);
    } else {
      messageDiv.style.display = 'none';
    }
  } catch (error) {
    console.error('Content: Error processing pending elements:', error);
    messageDiv.textContent = `Error processing new content`;
    setTimeout(() => {
      messageDiv.style.display = 'none';
    }, 3000);
  } finally {
    isProcessing = false;
    // Wait a bit before clearing the flag to ensure all mutations from our changes are caught
    setTimeout(() => {
      isExtensionModifying = false;
    }, 100);
  }
}

// Setup mutation observer with throttling
function setupMutationObserver() {
  if (document.readyState !== 'complete') {
    console.log('Content: Waiting for page to finish loading before setting up observer...');
    window.addEventListener('load', () => {
      console.log('Content: Page loaded, setting up MutationObserver');
      setupMutationObserver();
    }, { once: true });
    return;
  }

  if (mutationObserver) {
    mutationObserver.disconnect();
  }

  mutationObserver = new MutationObserver((mutations) => {
    // Ignore all mutations while extension is actively modifying the DOM
    if (isExtensionModifying || !gameNameMap || gameNameMap.size === 0) {
      return;
    }

    let hasNewElements = false;

    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as Element;

            // Skip if it's one of our own elements
            if (
              element.hasAttribute('data-bgg-rating-badge') ||
              element.hasAttribute('data-bgg-wrapper') ||
              element.hasAttribute('data-bgg-message') ||
              element.hasAttribute('data-bgg-tooltip') ||
              element.closest('[data-bgg-wrapper]') ||
              element.closest('[data-bgg-tooltip]')
            ) {
              return;
            }

            // Skip if it contains our markers (this means we just modified it)
            if (
              element.querySelector('[data-bgg-rating-badge]') ||
              element.querySelector('[data-bgg-wrapper]')
            ) {
              return;
            }

            // Only add if it has text content that might contain game names
            if (element.textContent && element.textContent.trim().length > 0) {
              pendingElements.push(element);
              hasNewElements = true;
            }
          }
        });
      }
    }

    // Only set timeout if we actually found new elements
    if (!hasNewElements) {
      return;
    }

    // Throttle: wait 1000ms after last mutation (increased from 500ms)
    if (mutationTimeout) {
      clearTimeout(mutationTimeout);
    }

    mutationTimeout = setTimeout(() => {
      mutationTimeout = null;
      processPendingElements();
    }, 1000);
  });

  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  console.log('Content: MutationObserver setup complete');
}

// Main function to run the extension
async function runExtension() {
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

    const { bggData, isOld } = responseFromBackground;
    let currentBggData: GameData[] = bggData || [];

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
        const fetchResponse = await chrome.runtime.sendMessage({
          action: 'fetchBggData',
        });
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

    // Build game name map
    messageDiv.textContent = 'Building game index...';
    gameNameMap = new Map();
    for (const game of currentBggData) {
      if (/^\d{1,3}$/.test(game.name)) {
        continue;
      }
      gameNameMap.set(game.name, game);
    }
    console.log(`Content: Built game name map with ${gameNameMap.size} games`);

    messageDiv.textContent = 'Searching page for board games...';

    // Find games mentioned on the page ONCE (not per element)
    const pageText = document.body.innerText;
    const foundGames: GameData[] = [];

    for (const [gameName, gameData] of gameNameMap) {
      try {
        const regex = createGameNameRegex(gameName);
        if (regex.test(pageText)) {
          foundGames.push(gameData);
        }
      } catch (error) {
        console.warn(`Content: Skipping game "${gameName}" due to regex error:`, error);
      }
    }

    console.log(`Content: Found ${foundGames.length} games mentioned on page`);

    if (foundGames.length === 0) {
      messageDiv.textContent = 'No board games found on this page.';
      setTimeout(() => {
        messageDiv.style.display = 'none';
      }, 2000);
      return;
    }

    // Sort games by name length (longest first) to match longer titles before shorter ones
    const sortedGames = [...foundGames].sort((a, b) => b.name.length - a.name.length);
    let gamesProcessed = 0;

    // Process games and add badges
    for (const game of sortedGames) {
      try {
        const regex = createGameNameRegex(game.name);

        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: function (node) {
              const parent = node.parentElement;
              if (
                !parent ||
                parent.closest('script, style, noscript') ||
                parent === messageDiv ||
                messageDiv.contains(parent)
              ) {
                return NodeFilter.FILTER_REJECT;
              }
              if (
                parent.querySelector('[data-bgg-rating-badge]') ||
                parent.closest('[data-bgg-wrapper]')
              ) {
                return NodeFilter.FILTER_REJECT;
              }
              return regex.test(node.textContent || '')
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_REJECT;
            },
          }
        );

        const nodesToProcess: { node: Text }[] = [];
        let currentNode: Node | null;

        while ((currentNode = walker.nextNode())) {
          const textNode = currentNode as Text;
          if (textNode.textContent?.match(regex)) {
            nodesToProcess.push({ node: textNode });
          }
        }

        nodesToProcess.forEach(({ node }) => {
          const parent = node.parentElement;
          if (!parent) return;

          if (
            parent.querySelector('[data-bgg-rating-badge]') ||
            parent.closest('[data-bgg-wrapper]')
          ) {
            return;
          }

          const text = node.textContent || '';
          const match = regex.exec(text);
          if (!match) return;

          const matchIndex = match.index;
          const matchText = match[0];

          const beforeText = text.substring(0, matchIndex);
          const afterText = text.substring(matchIndex + matchText.length);

          const beforeNode = document.createTextNode(beforeText);
          const badge = createRatingBadge(game.average, game.rank, game.yearpublished);
          const matchNode = document.createTextNode(matchText);
          const afterNode = document.createTextNode(afterText);

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

          const fragment = document.createDocumentFragment();
          if (beforeText) fragment.appendChild(beforeNode);
          fragment.appendChild(wrapper);
          if (afterText) fragment.appendChild(afterNode);

          parent.replaceChild(fragment, node);
        });

        gamesProcessed++;

        // Yield to the browser every 3 games to keep UI responsive
        if (gamesProcessed % 3 === 0) {
          messageDiv.textContent = `Adding badges... (${gamesProcessed}/${sortedGames.length})`;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      } catch (error) {
        console.warn(`Content: Error adding badge for "${game.name}":`, error);
      }
    }

    console.log(`Content: Added badges for ${foundGames.length} games to the page.`);
    setupMutationObserver();
    messageDiv.style.display = 'none';
  } catch (error) {
    console.error('Content: Error in runExtension:', error);
    messageDiv.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
    setTimeout(() => {
      messageDiv.style.display = 'none';
    }, 3000);
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
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }

    if (mutationTimeout) {
      clearTimeout(mutationTimeout);
      mutationTimeout = null;
    }

    // Clear state
    gameNameMap = null;
    pendingElements = [];
    isProcessing = false;

    // Remove all badges and wrappers
    const badges = document.querySelectorAll('[data-bgg-rating-badge]');
    const wrappers = document.querySelectorAll('[data-bgg-wrapper]');

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

    badges.forEach(badge => badge.remove());

    console.log(`Content: Removed ${wrappers.length} wrappers and ${badges.length} badges`);

    // Update state
    statsShown = false;

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
