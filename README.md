# BoardGameGeek Stats Browser Extension

A Chrome browser extension that automatically displays BoardGameGeek (BGG) ratings, ranks, and statistics directly on any webpage that mentions board game titles. 

Vibe-coded using PyCharm and Claude Sonnet 4.5. Code style is terrible, but functionality is solid!

## Features

- **Automatic Game Detection**: Scans webpages for board game titles and adds inline rating badges. Useful for board game stores, forums, etc.
- **Interactive Tooltips**: Hover over game names to see detailed statistics in a popup tooltip. Instant info about the recommended player counts, playtime, game weight, etc.
- **Domain Whitelisting**: Choose which websites should automatically show stats as you navigate
- **Non-Intrusive Design**: Clean, minimal badges that integrate seamlessly with existing page layouts

## Installation

1. Clone or download this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the extension:
   ```bash
   nvm use --lts
   npm run build
   ```
4. Load the extension in Chrome:
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top right)
   - Click "Load unpacked"
   - Select the `dist` folder from this project

## Usage

1. Click the extension icon in your browser toolbar
2. Click "Show game stats" for a one-off run or enable automatic stats on the whole domain
3. Tweak other settings from the popup as desired

## How It Works

The extension:
1. Downloads BoardGameGeek's game/expansion data dump (a zipped CSV) from the logged-in BGG data-dumps page, and caches it locally (refreshes every 7 days)
2. On product-listing pages, detects the repeating product grid structurally, then resolves each product's full title (and URL slug) to the correct BGG game — including expansions and newer, low-rated titles
3. Elsewhere, falls back to a guarded text scan for popular, distinctive game names
4. Injects inline rating badges and interactive tooltips
5. Uses URL change detection to handle dynamic content and SPAs

> **Note:** The data-dump download requires you to be signed in to BoardGameGeek in the same browser (the extension reuses your session).

## Technical Stack

- **TypeScript** - Type-safe development
- **Webpack** - Module bundling
- **Chrome Extension APIs** - Browser integration
- **BoardGameGeek data dump** - Primary game data source (zipped CSV)
- **BoardGameGeek XML API** - On-demand details for tooltips

## Project Structure

```
bgg-stats-extension/
├── src/
│   ├── background.ts      # Service worker, data dump download & caching
│   ├── content.tsx        # Content script, structural detection & badge injection
│   ├── matching.ts        # Title normalization & game-resolution logic
│   ├── popup.ts           # Extension popup UI
│   ├── tooltip.tsx        # Game info tooltip component
│   └── utils.tsx          # Shared utilities
├── assets/               # Icons and manifest
├── dist/                 # Built extension (generated)
└── boardgames_ranks.csv  # BGG data cache
```

## Development

This project was approximately 90% "vibe-coded" using PyCharm and Claude Sonnet 4.5 - demonstrating the power of AI-assisted development for rapid prototyping and implementation.

### Build Commands

```bash
# Development build with watch mode
npm run watch

# Production build
npm run build
```

### Key Implementation Details

- **URL Change Detection**: Monitors `pushState`, `replaceState`, and `popstate` events plus polling fallback
- **Performance Optimization**: Temporary mutation observers that disconnect after processing to prevent page freezing
- **Smart Caching**: 7-day cache with automatic background refresh
- **Structural Matching**: Detects repeating product-grid records and resolves each full title to a BGG game via exact + idf-weighted fuzzy token matching (using the visible title and the URL slug); a guarded, popularity-gated text scan handles non-grid pages

## Known Limitations

- The data-dump download requires being signed in to BoardGameGeek in the browser
- Requires a periodic data refresh (every 7 days), handled automatically
- Titles that appear only in a local translation with no English text or slug (e.g. some purely Bulgarian editions) may not resolve, or may match a same-named game
- Performance depends on page complexity and number of games found

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## Donations

Donations are welcome, sent then over PayPal to https://www.paypal.com/donate/?business=DHQUELMQRQW46&no_recurring=0&item_name=BGG+stats+extension&currency_code=EUR 

## License

MIT License - feel free to use and modify as needed.

## Acknowledgments

- BoardGameGeek for providing the XML API
- The board gaming community for making this data available
- Claude Sonnet 4.5 for AI-assisted development
