import { getRatingColor } from './utils';
import { wireTooltip } from './tooltip';

interface GameData {
  id: string;
  name: string;
  rank: string;
  average: string;
  yearpublished: string;
}

chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
  if (request.action === 'displayMessage') {
    console.log('Content script received displayMessage.');
    const messageDiv = document.createElement('div');
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
        console.error(
          'Content: Error sending getBggData message or receiving response:',
          e
        );
        messageDiv.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
        return;
      }

      const { bggData, isOld } = responseFromBackground;
      let currentBggData: GameData[] = bggData || [];

      console.log(
        'Content: Received bggData:',
        currentBggData ? `${currentBggData.length} games` : 'null',
        'isOld:',
        isOld
      );

      if (!currentBggData || currentBggData.length === 0 || isOld) {
        if (isOld && currentBggData && currentBggData.length > 0) {
          messageDiv.textContent =
            'BGG data is old. Using cached data and updating in background...';
          // Asynchronously update the cache via background script
          chrome.runtime
            .sendMessage({ action: 'fetchBggData' })
            .then((response) => {
              if (response.success) {
                console.log(
                  'Content: BGG data updated asynchronously in background.'
                );
              } else {
                console.error(
                  'Content: Error during async update:',
                  response.error
                );
              }
            })
            .catch((e) =>
              console.error('Content: Error during async update:', e)
            );
          // Continue with the old cached data
        } else {
          // No data or empty data - fetch it now and wait
          messageDiv.textContent = 'BGG data not found. Fetching now...';
          console.log('Content: Fetching BGG data from background...');
          const fetchResponse = await chrome.runtime.sendMessage({
            action: 'fetchBggData',
          });
          console.log('Content: Fetch response:', fetchResponse);
          if (!fetchResponse.success) {
            throw new Error(fetchResponse.error);
          }
          currentBggData = fetchResponse.bggData;
          console.log(
            'Content: Fetched bggData:',
            currentBggData ? `${currentBggData.length} games` : 'null'
          );
        }
      }

      if (!currentBggData || currentBggData.length === 0) {
        console.error(
          'Content: currentBggData is still empty after fetch attempt'
        );
        messageDiv.textContent =
          'BGG data not available. Please try again later.';
        return;
      }

      messageDiv.textContent = 'Searching page for board games...';
      const pageText = document.body.innerText;
      const foundGames: GameData[] = [];

      // Helper function to escape special regex characters
      function escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

        // Create a simple span badge with BGG color
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

      currentBggData.forEach((game) => {
        try {
          // Skip games with names that are just 2 or 3 digits (likely false positives)
          if (/^\d{1,3}$/.test(game.name)) {
            return;
          }

          const escapedName = escapeRegex(game.name);
          const regex = new RegExp(`\\b${escapedName}\\b`, 'g'); // Case-sensitive matching
          if (regex.test(pageText)) {
            foundGames.push(game);
          }
        } catch (error) {
          // Skip games that cause regex errors (shouldn't happen with proper escaping, but just in case)
          console.warn(
            `Content: Skipping game "${game.name}" due to regex error:`,
            error
          );
        }
      });

      if (foundGames.length > 0) {
        let logMessage = 'Identified Board Games:\n';
        foundGames.forEach((game) => {
          logMessage += `  - ${game.name} (Rank: ${game.rank}, Avg Rating: ${game.average}, Year: ${game.yearpublished})\n`;
        });
        console.log(logMessage);

        // Add rating badges to the page
        messageDiv.textContent = 'Adding rating badges...';

        // Sort games by name length (longest first) to match longer titles before shorter ones
        // This prevents substring matches and ensures expansions are matched before base games
        const sortedGames = [...foundGames].sort(
          (a, b) => b.name.length - a.name.length
        );
        console.log(
          `Content: Processing ${sortedGames.length} games in order of title length (longest first)`
        );

        sortedGames.forEach((game) => {
          try {
            const escapedName = escapeRegex(game.name);
            const regex = new RegExp(`\\b${escapedName}\\b`, 'g'); // Case-sensitive matching

            // Find all text nodes in the document
            const walker = document.createTreeWalker(
              document.body,
              NodeFilter.SHOW_TEXT,
              {
                acceptNode: function (node) {
                  // Skip script, style tags and our message div
                  const parent = node.parentElement;
                  if (
                    !parent ||
                    parent.closest('script, style, noscript') ||
                    parent === messageDiv ||
                    messageDiv.contains(parent)
                  ) {
                    return NodeFilter.FILTER_REJECT;
                  }
                  // Skip if already has a badge or is inside a wrapper with a badge
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

            const nodesToProcess: { node: Text; matches: RegExpMatchArray }[] =
              [];
            let currentNode: Node | null;

            while ((currentNode = walker.nextNode())) {
              const textNode = currentNode as Text;
              const matches = textNode.textContent?.match(regex);
              if (matches) {
                nodesToProcess.push({ node: textNode, matches });
              }
            }

            // Process nodes (we collected them first to avoid modifying while walking)
            nodesToProcess.forEach(({ node, matches }) => {
              const parent = node.parentElement;
              if (!parent) return;

              // Double-check this node hasn't been processed (in case of multiple games with overlapping names)
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

              // Split the text node
              const beforeText = text.substring(0, matchIndex);
              const afterText = text.substring(matchIndex + matchText.length);

              // Create new nodes
              const beforeNode = document.createTextNode(beforeText);
              const badge = createRatingBadge(
                game.average,
                game.rank,
                game.yearpublished
              );
              const matchNode = document.createTextNode(matchText);
              const afterNode = document.createTextNode(afterText);

              // Wrap badge and game name in a container with light blue background
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

              // Replace the original node
              const fragment = document.createDocumentFragment();
              if (beforeText) fragment.appendChild(beforeNode);
              fragment.appendChild(wrapper);
              if (afterText) fragment.appendChild(afterNode);

              parent.replaceChild(fragment, node);
            });
          } catch (error) {
            console.warn(
              `Content: Error adding badge for "${game.name}":`,
              error
            );
          }
        });

        // Hide the message div after adding badges
        messageDiv.style.display = 'none';
        console.log(`Added rating badges for ${foundGames.length} game(s).`);
      } else {
        console.log('No board games found on this page.');
        messageDiv.textContent = 'No games found here';
      }
    } catch (error: unknown) {
      console.error('Error in content script (outer catch):', error);
      messageDiv.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
});
