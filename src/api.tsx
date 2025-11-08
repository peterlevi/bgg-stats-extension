// Pure API functions for BoardGameGeek XML API calls
// These functions do not access or modify any global state

// Custom error for missing API token
export class NoApiTokenError extends Error {
  constructor() {
    super('BGG API token is required but not configured');
    this.name = 'NoApiTokenError';
  }
}

export interface BggApiGameDetail {
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

/**
 * Fetch detailed game information from BGG XML API
 * @param gameId The BGG game ID
 * @param apiToken Optional BGG API token for authentication
 * @returns Game details or null if not found/error
 * @throws NoApiTokenError if API token is not provided
 */
export async function fetchBggGameDetails(
  gameId: string,
  apiToken?: string
): Promise<BggApiGameDetail | null> {
  // Throw error if no token provided
  if (!apiToken) {
    throw new NoApiTokenError();
  }

  try {
    // Fetch detailed game info including stats using the game ID directly
    const detailUrl = `https://boardgamegeek.com/xmlapi2/thing?id=${gameId}&stats=1`;

    // Prepare fetch options with Bearer token
    const fetchOptions: RequestInit = {
      headers: {
        'Authorization': `Bearer ${apiToken}`
      }
    };

    const detailResponse = await fetch(detailUrl, fetchOptions);

    // Check for 401 Unauthorized
    if (detailResponse.status === 401) {
      console.warn(`BGG API: 401 Unauthorized for game ID ${gameId} - invalid or missing token`);
      return null;
    }

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

    return gameDetail;
  } catch (error) {
    console.error(
      `BGG API: Error fetching details for game ID ${gameId}:`,
      error
    );
    return null;
  }
}

