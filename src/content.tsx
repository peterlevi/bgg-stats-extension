interface GameData {
  name: string;
  rank: string;
  average: string;
  yearpublished: string;
}


console.log('Content script STARTING.');

chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
  if (request.action === "displayMessage") {
    console.log('Content script received displayMessage.');
    const messageDiv = document.createElement('div');
    messageDiv.textContent = "Working...";
    messageDiv.style.cssText = 'position: fixed; top: 0; left: 0; background-color: lightblue; z-index: 99999; padding: 5px;';
    document.body.prepend(messageDiv);

    try {
      messageDiv.textContent = "Checking BGG data...";
      let responseFromBackground;
      try {
        responseFromBackground = await chrome.runtime.sendMessage({ action: "getBggData" });
      } catch (e) {
        console.error("Content: Error sending getBggData message or receiving response:", e);
        messageDiv.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
        return;
      }

      const { bggData, isOld } = responseFromBackground;
      let currentBggData: GameData[] = bggData || [];

      console.log('Content: Received bggData:', currentBggData ? `${currentBggData.length} games` : 'null', 'isOld:', isOld);

      if (!currentBggData || currentBggData.length === 0 || isOld) {
        if (isOld && currentBggData && currentBggData.length > 0) {
          messageDiv.textContent = "BGG data is old. Using cached data and updating in background...";
          // Asynchronously update the cache via background script
          chrome.runtime.sendMessage({ action: "fetchBggData" })
            .then((response) => {
              if (response.success) {
                console.log("Content: BGG data updated asynchronously in background.");
              } else {
                console.error("Content: Error during async update:", response.error);
              }
            })
            .catch(e => console.error("Content: Error during async update:", e));
          // Continue with the old cached data
        } else {
          // No data or empty data - fetch it now and wait
          messageDiv.textContent = "BGG data not found. Fetching now...";
          console.log("Content: Fetching BGG data from background...");
          const fetchResponse = await chrome.runtime.sendMessage({ action: "fetchBggData" });
          console.log("Content: Fetch response:", fetchResponse);
          if (!fetchResponse.success) {
            throw new Error(fetchResponse.error);
          }
          currentBggData = fetchResponse.bggData;
          console.log('Content: Fetched bggData:', currentBggData ? `${currentBggData.length} games` : 'null');
        }
      }

      if (!currentBggData || currentBggData.length === 0) {
        console.error("Content: currentBggData is still empty after fetch attempt");
        messageDiv.textContent = "BGG data not available. Please try again later.";
        return;
      }

      messageDiv.textContent = "Searching page for board games...";
      const pageText = document.body.innerText;
      const foundGames: GameData[] = [];

      // Helper function to escape special regex characters
      function escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }

      // Helper function to get BGG rating color
      function getRatingColor(rating: string): string {
        const ratingNum = parseFloat(rating);
        if (isNaN(ratingNum) || ratingNum === 0) return '#666e75';
        if (ratingNum < 3) return '#b2151f';
        if (ratingNum < 5) return '#d71925';
        if (ratingNum < 7) return '#5369a2';
        if (ratingNum < 8) return '#1978b3';
        if (ratingNum < 9) return '#1d804c';
        return '#186b40';
      }

      // Helper function to create hexagon badge
      function createRatingBadge(rating: string, rank: string, year: string): HTMLElement {
        const ratingNum = parseFloat(rating);
        const displayRating = isNaN(ratingNum) ? '0.0' : ratingNum.toFixed(1);
        const color = getRatingColor(rating);

        // Create a container for the hexagon (perfectly square for regular hexagon)
        const container = document.createElement('span');
        container.style.cssText = `
          display: inline-block;
          position: relative;
          margin-right: 0.4em;
          margin-left: 0.1em;
          vertical-align: middle;
          width: 2.16em;
          height: 2.16em;
          line-height: 1;
        `;
        container.setAttribute('data-bgg-rating-badge', 'true');
        container.title = `BGG Rating: ${displayRating} | Rank: ${rank} | Year: ${year}`;

        // Create SVG hexagon with square viewBox for perfect regular hexagon
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.style.cssText = 'display: block;';

        // Create hexagon path (regular hexagon centered in square)
        const hexagon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        hexagon.setAttribute('points', '50,5 90,30 90,70 50,95 10,70 10,30');
        hexagon.setAttribute('fill', color);

        // Create text element for rating (adjusted y position for better vertical centering)
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', '50');
        text.setAttribute('y', '54');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('dominant-baseline', 'middle');
        text.setAttribute('fill', 'white');
        text.setAttribute('font-weight', 'bold');
        text.setAttribute('font-size', '38');
        text.setAttribute('font-family', 'Arial, sans-serif');
        text.textContent = displayRating;

        svg.appendChild(hexagon);
        svg.appendChild(text);
        container.appendChild(svg);

        return container;
      }

      currentBggData.forEach(game => {
        try {
          // Skip games with names that are just 2 or 3 digits (likely false positives)
          if (/^\d{2,3}$/.test(game.name)) {
            return;
          }

          const escapedName = escapeRegex(game.name);
          const regex = new RegExp(`\\b${escapedName}\\b`, 'gi');
          if (regex.test(pageText)) {
            foundGames.push(game);
          }
        } catch (error) {
          // Skip games that cause regex errors (shouldn't happen with proper escaping, but just in case)
          console.warn(`Content: Skipping game "${game.name}" due to regex error:`, error);
        }
      });

      if (foundGames.length > 0) {
        let logMessage = "Identified Board Games:\n";
        foundGames.forEach(game => {
          logMessage += `  - ${game.name} (Rank: ${game.rank}, Avg Rating: ${game.average}, Year: ${game.yearpublished})\n`;
        });
        console.log(logMessage);

        // Add rating badges to the page
        messageDiv.textContent = "Adding rating badges...";

        foundGames.forEach(game => {
          try {
            const escapedName = escapeRegex(game.name);
            const regex = new RegExp(`\\b${escapedName}\\b`, 'gi');

            // Find all text nodes in the document
            const walker = document.createTreeWalker(
              document.body,
              NodeFilter.SHOW_TEXT,
              {
                acceptNode: function(node) {
                  // Skip script, style tags and our message div
                  const parent = node.parentElement;
                  if (!parent || parent.closest('script, style, noscript') || parent === messageDiv || messageDiv.contains(parent)) {
                    return NodeFilter.FILTER_REJECT;
                  }
                  // Skip if already has a badge
                  if (parent.querySelector('[data-bgg-rating-badge]')) {
                    return NodeFilter.FILTER_REJECT;
                  }
                  return regex.test(node.textContent || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
                }
              }
            );

            const nodesToProcess: { node: Text; matches: RegExpMatchArray }[] = [];
            let currentNode: Node | null;

            while (currentNode = walker.nextNode()) {
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
              const badge = createRatingBadge(game.average, game.rank, game.yearpublished);
              const matchNode = document.createTextNode(matchText);
              const afterNode = document.createTextNode(afterText);

              // Wrap badge and game name in a container with light blue background
              const wrapper = document.createElement('span');
              wrapper.style.cssText = `
                background-color: #e6f2ff;
                padding: 2px 4px;
                border-radius: 3px;
                display: inline-block;
              `;
              wrapper.appendChild(badge);
              wrapper.appendChild(matchNode);

              // Replace the original node
              const fragment = document.createDocumentFragment();
              if (beforeText) fragment.appendChild(beforeNode);
              fragment.appendChild(wrapper);
              if (afterText) fragment.appendChild(afterNode);

              parent.replaceChild(fragment, node);
            });
          } catch (error) {
            console.warn(`Content: Error adding badge for "${game.name}":`, error);
          }
        });

        // Hide the message div after adding badges
        messageDiv.style.display = 'none';
        console.log(`Added rating badges for ${foundGames.length} game(s).`);
      } else {
        console.log("No board games found on this page.");
        messageDiv.textContent = "No games found here";
      }

    } catch (error: unknown) {
      console.error("Error in content script (outer catch):", error);
      messageDiv.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
});

console.log('Content script FINISHED initialization.');
