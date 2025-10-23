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
1. Fetches the board games with at least 50 user ratings from BoardGameGeek's API
2. Caches the data locally (refreshes every 7 days)
3. Searches the webpage for game name mentions using regex matching
4. Injects inline rating badges and interactive tooltips
5. Uses URL change detection to handle dynamic content and SPAs

## Technical Stack

- **TypeScript** - Type-safe development
- **Webpack** - Module bundling
- **Chrome Extension APIs** - Browser integration
- **BoardGameGeek XML API** - Game data source

## Project Structure

```
bgg-stats-extension/
├── src/
│   ├── background.ts      # Service worker, data fetching
│   ├── content.tsx        # Content script, badge injection
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
- **Flexible Matching**: Configurable case-sensitive/insensitive matching per domain

## Known Limitations

- Only limits the logic to games with a certain number of user ratings on BGG, for better performance
- Requires a fairly quick periodic data refresh (every 7 days), handled automatically
- Game name matching may not be perfect for all edge cases
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
