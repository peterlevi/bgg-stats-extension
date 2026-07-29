import {BlobReader, BlobWriter, TextReader, TextWriter, ZipReader, ZipWriter} from "@zip.js/zip.js";
import Papa from "papaparse";

const CACHE_KEY = "bggGameData";
const LAST_FETCH_TIMESTAMP_KEY = "lastBggFetchTimestamp";
const CACHE_VERSION_KEY = "bggCacheVersion";
const ENABLED_DOMAINS_KEY = "bggEnabledDomains";
const CURRENT_CACHE_VERSION = 5; // Increment this when changing data structure or filtering logic
const ONE_WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000;
// Low floor so structural (product-grid) matching can resolve niche/new titles
// and expansions. The content script applies a higher threshold only on the
// free-text fallback path, where precision matters more.
const MIN_VOTES_THRESHOLD = 5; // Minimum number of user ratings required to include a game
const BGG_DATA_PAGE_URL = "https://boardgamegeek.com/data_dumps/bg_ranks";

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

// Extracts the .zip data-dump download URL from the BGG data dumps page HTML.
// The page renders an anchor like:
//   <a href="https://geek-export-stats.s3.amazonaws.com/.../boardgames_ranks_YYYY-MM-DD.zip?..." download="...">Click to Download</a>
// We look for any anchor href that points to a .zip file, preferring the S3
// export bucket, and fall back to the "Click to Download" link text. This keeps
// working even if BGG tweaks the link wording or attribute order.
function extractZipDownloadUrl(html: string): string | null {
  const hrefRegex = /<a\b[^>]*?href=["']([^"']+?\.zip(?:\?[^"']*)?)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  let firstZipUrl: string | null = null;

  while ((match = hrefRegex.exec(html)) !== null) {
    const rawHref = match[1];
    // Ignore protocol-relative/relative hrefs that aren't real downloads
    if (!/^https?:\/\//i.test(rawHref)) {
      continue;
    }
    const url = decodeHtmlEntities(rawHref);
    if (firstZipUrl === null) {
      firstZipUrl = url;
    }
    // Prefer the known BGG export bucket if present
    if (/geek-export-stats|boardgames?_ranks|boardgames?_export/i.test(url)) {
      return url;
    }
  }

  return firstZipUrl;
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
  usersrated: string;
}

function compactGameData(games: GameData[]): CompactGameData[] {
  console.log(`Background: Compacting ${games.length} games...`);
  const filtered = games
    .filter(game => {
      // Include games and expansions that have a name and at least the minimum
      // number of user ratings. We no longer require a main "rank" (expansions
      // have none), so full expansion/edition titles are matchable.
      const usersRated = parseInt(game.usersrated, 10);
      return game.name &&
             game.name.trim() !== '' &&
             !isNaN(usersRated) &&
             usersRated >= MIN_VOTES_THRESHOLD;
    })
    .map(game => ({
      id: game.id,
      name: game.name,
      rank: game.rank && game.rank.trim() !== '' ? game.rank : '',
      average: game.average,
      yearpublished: game.yearpublished,
      usersrated: game.usersrated,
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
    // Step 1: Fetch the HTML page to find the actual download link.
    // IMPORTANT: The download link is only present in the HTML when the user is
    // logged in to BoardGameGeek. Since this request is issued cross-origin from
    // the extension service worker, we must pass credentials: 'include' so that
    // the user's BGG session cookies are sent (otherwise BGG returns the
    // logged-out page, which does not contain the link).
    const pageResponse = await fetch(BGG_DATA_PAGE_URL, {
      credentials: "include",
      cache: "no-store",
    });
    if (!pageResponse.ok) {
      throw new Error(`HTTP error fetching BGG data page! status: ${pageResponse.status}`);
    }
    const pageText = await pageResponse.text();

    // Step 2: Parse the HTML to find the .zip download link.
    // Match any anchor whose href points to a .zip file (the download button on
    // the BGG data dumps page). We do NOT rely on the exact "Click to Download"
    // link text, so the extension keeps working if BGG tweaks the wording.
    const zipFileUrl = extractZipDownloadUrl(pageText);

    if (!zipFileUrl) {
      throw new Error(
        "Could not find the .zip download link on the BGG data page. " +
        "Make sure you are logged in to BoardGameGeek (boardgamegeek.com) in this browser, " +
        "then try again."
      );
    }
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
    return compactGameData(parsedData);
  } catch (error) {
    console.error("Background: Error fetching or parsing BGG data:", error);
    throw error;
  }
}

console.log('Background script STARTING.');

// Update icon based on domain status
async function updateIcon(tabId: number, url: string) {
  try {
    const domain = new URL(url).hostname;
    const result = await chrome.storage.local.get([ENABLED_DOMAINS_KEY]);
    const enabledDomains: string[] = result[ENABLED_DOMAINS_KEY] || [];
    
    const isEnabled = enabledDomains.includes(domain);
    
    await chrome.action.setIcon({
      tabId: tabId,
      path: {
        "16": isEnabled ? "icon16_active.png" : "icon16.png",
        "48": isEnabled ? "icon48_active.png" : "icon48.png",
        "128": isEnabled ? "icon128_active.png" : "icon128.png"
      }
    });
  } catch (error) {
    console.error("Background: Error updating icon:", error);
  }
}

// Listen for tab updates to update icon
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    updateIcon(tabId, tab.url);
  }
});

// Listen for tab activation to update icon
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await chrome.tabs.get(activeInfo.tabId);
  if (tab.url) {
    updateIcon(activeInfo.tabId, tab.url);
  }
});

// Listener for content.tsx to request data or trigger fetch
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "checkDomain") {
    console.log("Background: Received checkDomain request.");
    const domain = request.domain;
    chrome.storage.local.get([ENABLED_DOMAINS_KEY]).then((result) => {
      const enabledDomains: string[] = result[ENABLED_DOMAINS_KEY] || [];
      sendResponse({ enabled: enabledDomains.includes(domain) });
    });
    return true;
  } else if (request.action === "getBggData") {
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
