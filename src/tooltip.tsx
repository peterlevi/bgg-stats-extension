import { getRatingColor } from './utils';

interface BggApiGameDetail {
  id: string;
  name: string;
  yearpublished: string;
  image: string;
  thumbnail: string;
  averageRating: string;
  rank: string;
  weight: string;
  minplaytime: string;
  maxplaytime: string;
  minplayers: string;
  maxplayers: string;
  numRatings: string;
  playerCountData: {
    [playerCount: string]: {
      best: number;
      recommended: number;
      notRecommended: number;
      total: number;
    };
  };
}

// Cache for BGG API responses to avoid repeated requests
const bggApiCache: Map<string, BggApiGameDetail> = new Map();

// Global tooltip element
let tooltipElement: HTMLElement | null = null;
let currentTooltipTarget: HTMLElement | null = null;
let tooltipTimeout: number | null = null;

// Helper function to fetch game details from BGG API
async function fetchBggGameDetails(
  gameId: string
): Promise<BggApiGameDetail | null> {
  // Check cache first
  if (bggApiCache.has(gameId)) {
    return bggApiCache.get(gameId)!;
  }

  try {
    // Fetch detailed game info including stats using the game ID directly
    const detailUrl = `https://boardgamegeek.com/xmlapi2/thing?id=${gameId}&stats=1`;
    const detailResponse = await fetch(detailUrl);
    const detailXml = await detailResponse.text();
    const searchParser = new DOMParser();
    const detailDoc = searchParser.parseFromString(detailXml, 'text/xml');

    const item = detailDoc.querySelector('item');
    if (!item) {
      console.warn(`BGG API: No details found for game ID ${gameId}`);
      return null;
    }

    // Extract game data
    const primaryName =
      item.querySelector('name[type="primary"]')?.getAttribute('value') || '';
    const yearPublished =
      item.querySelector('yearpublished')?.getAttribute('value') || '';
    const image = item.querySelector('image')?.textContent || '';
    const thumbnail = item.querySelector('thumbnail')?.textContent || '';
    const avgRating =
      item.querySelector('average')?.getAttribute('value') || '0';
    const rankElement = item.querySelector('rank[name="boardgame"]');
    const rank = rankElement?.getAttribute('value') || 'N/A';
    const weight =
      item.querySelector('averageweight')?.getAttribute('value') || '0';
    const minplaytime =
      item.querySelector('minplaytime')?.getAttribute('value') || '0';
    const maxplaytime =
      item.querySelector('maxplaytime')?.getAttribute('value') || '0';
    const minplayers =
      item.querySelector('minplayers')?.getAttribute('value') || '1';
    const maxplayers =
      item.querySelector('maxplayers')?.getAttribute('value') || '1';
    const numRatings =
      item.querySelector('usersrated')?.getAttribute('value') || '0';

    // Extract player count poll data
    const playerCountData: BggApiGameDetail['playerCountData'] = {};
    const suggestedPlayersPoll = Array.from(
      item.querySelectorAll('poll[name="suggested_numplayers"] results')
    );

    suggestedPlayersPoll.forEach((results) => {
      const numPlayers = results.getAttribute('numplayers') || '';
      const best = parseInt(
        results
          .querySelector('result[value="Best"]')
          ?.getAttribute('numvotes') || '0'
      );
      const recommended = parseInt(
        results
          .querySelector('result[value="Recommended"]')
          ?.getAttribute('numvotes') || '0'
      );
      const notRecommended = parseInt(
        results
          .querySelector('result[value="Not Recommended"]')
          ?.getAttribute('numvotes') || '0'
      );
      const total = best + recommended + notRecommended;

      if (total > 0) {
        playerCountData[numPlayers] = {
          best,
          recommended,
          notRecommended,
          total,
        };
      }
    });

    const gameDetail: BggApiGameDetail = {
      id: gameId,
      name: primaryName,
      yearpublished: yearPublished,
      image,
      thumbnail,
      averageRating: avgRating,
      rank,
      weight,
      minplaytime,
      maxplaytime,
      minplayers,
      maxplayers,
      numRatings,
      playerCountData,
    };

    // Cache the result
    bggApiCache.set(gameId, gameDetail);
    return gameDetail;
  } catch (error) {
    console.error(
      `BGG API: Error fetching details for game ID ${gameId}:`,
      error
    );
    return null;
  }
}

export function wireTooltip(wrapper: HTMLElement, gameId: string) {
  // Add hover event listeners for tooltip
  wrapper.addEventListener('mouseenter', () => {
    if (tooltipTimeout) {
      clearTimeout(tooltipTimeout);
      tooltipTimeout = null;
    }
    createTooltip(wrapper, gameId);
  });

  wrapper.addEventListener('mouseleave', () => {
    tooltipTimeout = window.setTimeout(() => {
      hideTooltip();
    }, 300); // Small delay before hiding
  });

  // Keep tooltip visible when hovering over it
  wrapper.addEventListener('mouseenter', () => {
    if (tooltipElement) {
      tooltipElement.addEventListener('mouseenter', () => {
        if (tooltipTimeout) {
          clearTimeout(tooltipTimeout);
          tooltipTimeout = null;
        }
      });
      tooltipElement.addEventListener('mouseleave', () => {
        hideTooltip();
      });
    }
  });
}

// Helper function to create and show tooltip
function createTooltip(wrapper: HTMLElement, gameId: string): void {
  // Remove existing tooltip if any
  if (tooltipElement) {
    tooltipElement.remove();
    tooltipElement = null;
  }

  // Create tooltip container
  const tooltip = document.createElement('div');
  tooltip.style.cssText = `
          position: absolute;
          background: white;
          border: 2px solid #ccc;
          border-radius: 8px;
          padding: 12px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
          z-index: 100000;
          min-width: 250px;
          max-width: 350px;
          font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          font-size: 13px;
          line-height: 1.4;
          color: #333;
          pointer-events: auto;
        `;
  tooltip.setAttribute('data-bgg-tooltip', 'true');

  // Show loading state
  tooltip.innerHTML = `
          <div style="text-align: center; padding: 20px;">
            <div style="font-weight: bold; margin-bottom: 8px;">Loading...</div>
            <div style="color: #666;">Fetching BGG data</div>
          </div>
        `;

  // Position tooltip above the wrapper
  document.body.appendChild(tooltip);
  const rect = wrapper.getBoundingClientRect();
  tooltip.style.left = `${rect.left + window.scrollX}px`;
  tooltip.style.top = `${rect.top + window.scrollY - tooltip.offsetHeight - 10}px`;

  // Adjust if tooltip goes off-screen
  if (tooltip.offsetLeft + tooltip.offsetWidth > window.innerWidth) {
    tooltip.style.left = `${window.innerWidth - tooltip.offsetWidth - 10}px`;
  }
  if (tooltip.offsetLeft < 0) {
    tooltip.style.left = '10px';
  }
  if (tooltip.offsetTop < window.scrollY) {
    tooltip.style.top = `${rect.bottom + window.scrollY + 10}px`;
  }

  tooltipElement = tooltip;
  currentTooltipTarget = wrapper;

  // Fetch and display game details
  fetchBggGameDetails(gameId).then((details) => {
    if (!tooltipElement || tooltipElement !== tooltip) return; // Tooltip was removed

    if (!details) {
      tooltip.innerHTML = `
              <div style="text-align: center; padding: 20px; color: #666;">
                Failed to load game details
              </div>
            `;
      return;
    }

    // Build the tooltip content
    const ratingColor = getRatingColor(details.averageRating);
    const ratingNum = parseFloat(details.averageRating);
    const displayRating = isNaN(ratingNum) ? '0.0' : ratingNum.toFixed(1);
    const weightNum = parseFloat(details.weight);
    const displayWeight = isNaN(weightNum) ? '0.00' : weightNum.toFixed(2);
    const bggUrl = `https://boardgamegeek.com/boardgame/${details.id}`;
    const numRatingsFormatted = parseInt(details.numRatings).toLocaleString();

    let durationText = '';
    if (details.minplaytime === details.maxplaytime) {
      durationText = `${details.minplaytime} min`;
    } else {
      durationText = `${details.minplaytime}-${details.maxplaytime} min`;
    }

    // Create player count text
    let playerCountText = '';
    if (details.minplayers === details.maxplayers) {
      playerCountText = `${details.minplayers}`;
    } else {
      playerCountText = `${details.minplayers}-${details.maxplayers}`;
    }

    // Create player count heatmap
    let playerCountHtml = '';
    const playerCounts = Object.keys(details.playerCountData).sort((a, b) => {
      const aNum = a.includes('+') ? parseInt(a) + 100 : parseInt(a);
      const bNum = b.includes('+') ? parseInt(b) + 100 : parseInt(b);
      return aNum - bNum;
    });

    if (playerCounts.length > 0) {
      const playerCountItems = playerCounts
        .map((count) => {
          const data = details.playerCountData[count];
          const bestPercent = (data.best / data.total) * 100;
          const recommendedPercent = (data.recommended / data.total) * 100;

          let bgColor = '#d3d3d3'; // gray (not recommended)
          if (bestPercent >= 45) {
            bgColor = '#186b40'; // dark green (best)
          } else if (bestPercent + recommendedPercent >= 70) {
            bgColor = '#90EE90'; // light green (recommended)
          }

          return `
                <span style="
                  display: inline;
                  background-color: ${bgColor};
                  color: ${bgColor === '#90EE90' ? '#000' : '#fff'};
                  padding: 4px 8px;
                  margin: 0;
                  border-radius: 0;
                  font-weight: bold;
                  cursor: pointer;
                  font-size: 12px;
                " data-player-count="${count}" data-best="${data.best}" data-recommended="${data.recommended}" data-not-recommended="${data.notRecommended}" data-total="${data.total}">
                  ${count}
                </span>
              `;
        })
        .join('');

      playerCountHtml = `
              <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #ddd;">
                <div style="font-weight: bold; margin-bottom: 6px; font-size: 12px; color: #666;">Player Count Poll:</div>
                <div id="player-count-summary" style="line-height: 1; display: inline-block;">
                  ${playerCountItems}
                </div>
                <div id="player-count-details" style="display: none; margin-top: 12px;">
                </div>
              </div>
            `;
    }

    tooltip.innerHTML = `
            <a href="${bggUrl}" target="_blank" rel="noopener noreferrer" style="text-decoration: none; color: inherit;">
              <div style="font-weight: bold; font-size: 15px; margin-bottom: 8px; color: #111; cursor: pointer;">
                ${details.name} (${details.yearpublished})
              </div>
            </a>
            ${
              details.thumbnail
                ? `
              <div style="display: flex; justify-content: center; margin-bottom: 10px;">
                <a href="${bggUrl}" target="_blank" rel="noopener noreferrer">
                  <img src="${details.thumbnail}" alt="${details.name}" style="max-width: 100%; border-radius: 4px; cursor: pointer;" />
                </a>
              </div>
            `
                : ''
            }
            <div style="display: grid; grid-template-columns: auto 1fr; gap: 8px 12px; font-size: 13px;">
              <div style="font-weight: bold;">Rating:</div>
              <div>
                <span style="
                  background-color: ${ratingColor};
                  color: white;
                  padding: 2px 6px;
                  border-radius: 4px;
                  font-weight: bold;
                  margin-right: 4px;
                ">${displayRating}</span>
                <span style="color: #666;">from ${numRatingsFormatted} ratings</span>
              </div>
              <div style="font-weight: bold;">Rank:</div>
              <div>${details.rank === 'Not Ranked' ? 'Unranked' : '#' + details.rank}</div>
              <div style="font-weight: bold;">Weight:</div>
              <div>${displayWeight} / 5.00</div>
              <div style="font-weight: bold;">Duration:</div>
              <div>${durationText}</div>
              <div style="font-weight: bold;">Players:</div>
              <div>${playerCountText}</div>
            </div>
            ${playerCountHtml}
          `;

    // Reposition after content is loaded
    tooltip.style.left = `${rect.left + window.scrollX}px`;
    tooltip.style.top = `${rect.top + window.scrollY - tooltip.offsetHeight - 10}px`;

    if (tooltip.offsetLeft + tooltip.offsetWidth > window.innerWidth) {
      tooltip.style.left = `${window.innerWidth - tooltip.offsetWidth - 10}px`;
    }
    if (tooltip.offsetLeft < 0) {
      tooltip.style.left = '10px';
    }
    if (tooltip.offsetTop < window.scrollY) {
      tooltip.style.top = `${rect.bottom + window.scrollY + 10}px`;
    }

    // Add click handlers for player count expansion
    const playerCountSummary = tooltip.querySelector('#player-count-summary');
    const playerCountDetails = tooltip.querySelector(
      '#player-count-details'
    ) as HTMLElement;

    if (playerCountSummary && playerCountDetails) {
      let isExpanded = false;

      playerCountSummary.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.hasAttribute('data-player-count')) {
          // Toggle the table display
          if (isExpanded) {
            playerCountDetails.style.display = 'none';
            isExpanded = false;
          } else {
            // Helper function to get green color for Best column based on percentage
            const getBestColor = (percent: number): string => {
              if (percent < 5) return '#f5f5f5'; // very light gray
              if (percent < 15) return '#e8f5e9'; // very light green
              if (percent < 30) return '#a5d6a7'; // light green
              if (percent < 50) return '#66bb6a'; // medium green
              if (percent < 75) return '#43a047'; // darker green
              return '#2e7d32'; // dark green
            };

            // Helper function to get yellow color for Recommended column based on percentage
            const getRecommendedColor = (percent: number): string => {
              if (percent < 5) return '#f5f5f5'; // very light gray
              if (percent < 15) return '#fff9c4'; // very light yellow
              if (percent < 30) return '#fff59d'; // light yellow
              if (percent < 50) return '#ffee58'; // medium yellow
              if (percent < 75) return '#fdd835'; // darker yellow
              return '#f9a825'; // dark yellow/gold
            };

            // Helper function to get red color for Not Recommended column based on percentage
            const getNotRecommendedColor = (percent: number): string => {
              if (percent < 5) return '#f5f5f5'; // very light gray
              if (percent < 15) return '#ffebee'; // very light red
              if (percent < 30) return '#ef9a9a'; // light red
              if (percent < 50) return '#e57373'; // medium red
              if (percent < 75) return '#e53935'; // darker red
              return '#c62828'; // dark red
            };

            // Helper function to get text color based on background
            const getTextColor = (bgColor: string): string => {
              // Use white text for dark backgrounds
              const darkColors = [
                '#2e7d32',
                '#43a047',
                '#f9a825',
                '#e53935',
                '#c62828',
              ];
              if (darkColors.includes(bgColor)) {
                return '#ffffff';
              }
              return '#000000';
            };

            // Calculate total votes across all player counts
            let totalVotes = 0;
            playerCounts.forEach((count) => {
              const data = details.playerCountData[count];
              totalVotes += data.total;
            });

            // Build full table with all player counts
            let tableRows = '';
            playerCounts.forEach((count) => {
              const data = details.playerCountData[count];
              const bestPercent = (data.best / data.total) * 100;
              const recommendedPercent = (data.recommended / data.total) * 100;
              const notRecommendedPercent =
                (data.notRecommended / data.total) * 100;

              const bestColor = getBestColor(bestPercent);
              const recommendedColor = getRecommendedColor(recommendedPercent);
              const notRecommendedColor = getNotRecommendedColor(
                notRecommendedPercent
              );

              const bestTextColor = getTextColor(bestColor);
              const recommendedTextColor = getTextColor(recommendedColor);
              const notRecommendedTextColor = getTextColor(notRecommendedColor);

              tableRows += `
                      <tr>
                        <td style="padding: 6px 10px; border: 1px solid #ddd; font-weight: bold; text-align: center;">${count}</td>
                        <td style="padding: 6px 10px; border: 1px solid #ddd; text-align: center; background-color: ${bestColor}; color: ${bestTextColor};">${bestPercent.toFixed(0)}%</td>
                        <td style="padding: 6px 10px; border: 1px solid #ddd; text-align: center; background-color: ${recommendedColor}; color: ${recommendedTextColor};">${recommendedPercent.toFixed(0)}%</td>
                        <td style="padding: 6px 10px; border: 1px solid #ddd; text-align: center; background-color: ${notRecommendedColor}; color: ${notRecommendedTextColor};">${notRecommendedPercent.toFixed(0)}%</td>
                      </tr>
                    `;
            });

            playerCountDetails.innerHTML = `
                    <div style="font-size: 11px; color: #666; margin-bottom: 6px; text-align: center;">
                      Total votes: ${totalVotes.toLocaleString()}
                    </div>
                    <table style="width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 8px;">
                      <thead>
                        <tr style="background-color: #f0f0f0;">
                          <th style="padding: 6px 10px; border: 1px solid #ddd; text-align: center; font-weight: bold;">#</th>
                          <th style="padding: 6px 10px; border: 1px solid #ddd; text-align: center; font-weight: bold;">Best</th>
                          <th style="padding: 6px 10px; border: 1px solid #ddd; text-align: center; font-weight: bold;">Rec.</th>
                          <th style="padding: 6px 10px; border: 1px solid #ddd; text-align: center; font-weight: bold;">Not Rec.</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${tableRows}
                      </tbody>
                    </table>
                  `;
            playerCountDetails.style.display = 'block';
            isExpanded = true;
          }
        }
      });
    }
  });
}

// Helper function to hide tooltip
function hideTooltip(): void {
  if (tooltipTimeout) {
    clearTimeout(tooltipTimeout);
    tooltipTimeout = null;
  }
  if (tooltipElement) {
    tooltipElement.remove();
    tooltipElement = null;
  }
  currentTooltipTarget = null;
}
