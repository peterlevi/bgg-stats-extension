import { BlobReader, BlobWriter, TextReader, TextWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";
import Papa from "papaparse";

const CACHE_KEY = "bggGameData";
const LAST_FETCH_TIMESTAMP_KEY = "lastBggFetchTimestamp";
const CACHE_VERSION_KEY = "bggCacheVersion";
const CURRENT_CACHE_VERSION = 3; // Increment this when changing data structure or filtering logic
const ONE_WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_VOTES_THRESHOLD = 50; // Minimum number of user ratings required to include a game
const BGG_DATA_PAGE_URL = "https://boardgamegeek.com/data_dumps/bg_ranks";

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

interface GameData {
  id: string;
  name: string;
  yearpublished: string;
  rank: string;
  bayesaverage: string;
  average: string;
  usersrated: string;
  is_expansion: string;
  abstracts_rank: string;
  cgs_rank: string;
  childrensgames_rank: string;
  familygames_rank: string;
  partygames_rank: string;
  strategygames_rank: string;
  thematic_rank: string;
  wargames_rank: string;
}

// Compact version with only essential fields
interface CompactGameData {
  id: string;
  name: string;
  rank: string;
  average: string;
  yearpublished: string;
}

function compactGameData(games: GameData[]): CompactGameData[] {
  console.log(`Background: Compacting ${games.length} games...`);
  const filtered = games
    .filter(game => {
      // Include both games and expansions, but only if they have a valid rank and at least MIN_VOTES_THRESHOLD votes
      const usersRated = parseInt(game.usersrated, 10);
      return game.rank &&
             game.rank !== 'Not Ranked' &&
             game.rank.trim() !== '' &&
             !isNaN(usersRated) &&
             usersRated >= MIN_VOTES_THRESHOLD;
    })
    .map(game => ({
      id: game.id,
      name: game.name,
      rank: game.rank,
      average: game.average,
      yearpublished: game.yearpublished,
    }));
  console.log(`Background: Reduced to ${filtered.length} games with ${MIN_VOTES_THRESHOLD}+ votes (including expansions)`);
  return filtered;
}

async function compressDataToCsv(games: CompactGameData[]): Promise<string> {
  // Convert to CSV
  const csv = Papa.unparse(games, {
    header: true,
  });

  console.log(`Background: CSV size: ${csv.length} characters (${(csv.length / (1024 * 1024)).toFixed(2)} MB)`);

  // Zip the CSV
  const zipWriter = new ZipWriter(new BlobWriter());
  await zipWriter.add("games.csv", new TextReader(csv));
  const zipBlob = await zipWriter.close();

  const zipSizeBytes = zipBlob.size;
  const zipSizeMB = (zipSizeBytes / (1024 * 1024)).toFixed(2);
  console.log(`Background: Zipped CSV size: ${zipSizeBytes} bytes (${zipSizeMB} MB)`);

  // Convert blob to base64 string for storage
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = (reader.result as string).split(',')[1];
      console.log(`Background: Base64 string length: ${base64.length} characters (${(base64.length / (1024 * 1024)).toFixed(2)} MB)`);
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(zipBlob);
  });
}

async function decompressDataFromCsv(base64Zip: string): Promise<CompactGameData[]> {
  // Convert base64 back to blob
  const binaryString = atob(base64Zip);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const blob = new Blob([bytes]);

  // Unzip the CSV
  const zipReader = new ZipReader(new BlobReader(blob));
  const entries = await zipReader.getEntries();

  if (entries.length === 0) {
    throw new Error("No entries found in cached zip.");
  }

  const csvEntry = entries.find(entry => !entry.directory);
  if (!csvEntry || !csvEntry.getData) {
    throw new Error("Invalid zip entry.");
  }

  const csvText = await csvEntry.getData(new TextWriter());
  await zipReader.close();

  // Parse CSV back to objects
  return new Promise((resolve, reject) => {
    Papa.parse<CompactGameData>(csvText, {
      header: true,
      complete: (results) => {
        resolve(results.data);
      },
      error: reject,
    });
  });
}

async function getCachedBggData(): Promise<{ data: CompactGameData[] | null; isOld: boolean }> {
  const result = await chrome.storage.local.get([CACHE_KEY, LAST_FETCH_TIMESTAMP_KEY, CACHE_VERSION_KEY]);
  const cachedZip = result[CACHE_KEY] || null;
  const lastFetchTimestamp = result[LAST_FETCH_TIMESTAMP_KEY];
  const cachedVersion = result[CACHE_VERSION_KEY] || 0;

  // Check if cache is old or version is outdated
  const isOld = !lastFetchTimestamp ||
                (Date.now() - lastFetchTimestamp > ONE_WEEK_IN_MS) ||
                cachedVersion < CURRENT_CACHE_VERSION;

  let cachedData: CompactGameData[] | null = null;
  if (cachedZip && cachedVersion === CURRENT_CACHE_VERSION) {
    try {
      cachedData = await decompressDataFromCsv(cachedZip);
    } catch (error) {
      console.error("Background: Error decompressing cached data:", error);
      cachedData = null;
    }
  }

  console.log(`Background: getCachedBggData - found ${cachedData ? cachedData.length : 0} games, isOld: ${isOld}, version: ${cachedVersion}/${CURRENT_CACHE_VERSION}`);

  return { data: cachedData, isOld };
}

async function fetchAndParseBggData(): Promise<CompactGameData[]> {
  console.log("Background: Fetching and parsing BGG data...");
  try {
    // Step 1: Fetch the HTML page to find the actual download link
    const pageResponse = await fetch(BGG_DATA_PAGE_URL);
    if (!pageResponse.ok) {
      throw new Error(`HTTP error fetching BGG data page! status: ${pageResponse.status}`);
    }
    const pageText = await pageResponse.text();

    // Step 2: Parse the HTML to find the .zip download link using a more robust regex
    const zipLinkRegex = /<a[^>]*href=["'](https?:\/\/[^"']+\.zip[^"']*)["'][^>]*>\s*Click to Download\s*<\/a>/i;
    const match = pageText.match(zipLinkRegex);

    if (!match || !match[1]) {
      throw new Error("Could not find the \"Click to Download\" .zip link on the BGG data page.");
    }

    // Decode HTML entities (e.g., &amp; -> &) before using the URL
    const zipFileUrl = decodeHtmlEntities(match[1]);
    console.log("Background: Found BGG zip file URL:", zipFileUrl);

    // Step 3: Fetch the actual zipped CSV file
    const zipResponse = await fetch(zipFileUrl, {
      referrerPolicy: 'no-referrer-when-downgrade',
      headers: {
        'Referer': BGG_DATA_PAGE_URL,
      },
    });
    if (!zipResponse.ok) {
      throw new Error(`HTTP error fetching BGG zip file! status: ${zipResponse.status}`);
    }

    const blob = await zipResponse.blob();
    const reader = new ZipReader(new BlobReader(blob));
    const entries = await reader.getEntries();

    if (entries.length === 0) {
      throw new Error("No entries found in the zip file.");
    }

    const csvEntry = entries.find(entry => !entry.directory);

    if (!csvEntry || !csvEntry.getData) {
      throw new Error("No CSV file found in the zip archive.");
    }

    const csvText = await csvEntry.getData(new TextWriter());

    const parsedData = await new Promise<GameData[]>((resolve, reject) => {
      Papa.parse<GameData>(csvText, {
        header: true,
        worker: true,
        complete: (results) => {
          resolve(results.data);
        },
        error: (error: Error) => {
          reject(error);
        },
      });
    });

    console.log(`Background: BGG data parsed successfully. ${parsedData.length} games found.`);

    // Compact the data to reduce storage size
    const compactData = compactGameData(parsedData);

    return compactData;
  } catch (error) {
    console.error("Background: Error fetching or parsing BGG data:", error);
    throw error;
  }
}

console.log('Background script STARTING.');

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.tabs.sendMessage(tab.id, { action: "displayMessage" });
  }
});

// Listener for content.tsx to request data or trigger fetch
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getBggData") {
    console.log("Background: Received getBggData request.");
    getCachedBggData().then(({ data, isOld }) => {
      sendResponse({ bggData: data, isOld: isOld });
    });
    return true; // Indicates that sendResponse will be called asynchronously
  } else if (request.action === "saveBggData") {
    console.log("Background: Received saveBggData request.");
    const { bggData, timestamp } = request;
    chrome.storage.local.set({
      [CACHE_KEY]: bggData,
      [LAST_FETCH_TIMESTAMP_KEY]: timestamp,
    }).then(() => {
      sendResponse({ success: true });
    });
    return true; // Indicates that sendResponse will be called asynchronously
  } else if (request.action === "fetchBggData") {
    console.log("Background: Received fetchBggData request.");
    fetchAndParseBggData()
      .then(async (newData) => {
        console.log(`Background: Parsed and compacted to ${newData.length} games, compressing to CSV...`);

        // Compress the data to CSV and zip it
        const compressedData = await compressDataToCsv(newData);

        // Save the compressed data to storage with version
        return chrome.storage.local.set({
          [CACHE_KEY]: compressedData,
          [LAST_FETCH_TIMESTAMP_KEY]: Date.now(),
          [CACHE_VERSION_KEY]: CURRENT_CACHE_VERSION,
        }).then(() => {
          console.log(`Background: Compressed data saved successfully (v${CURRENT_CACHE_VERSION}), sending response with ${newData.length} games`);
          sendResponse({ success: true, bggData: newData });
        });
      })
      .catch((error) => {
        console.error("Background: Error in fetchBggData:", error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Indicates that sendResponse will be called asynchronously
  }
});

console.log('Background script FINISHED initialization.');

