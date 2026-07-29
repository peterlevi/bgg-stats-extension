// Pure (DOM-free) matching utilities shared by the content script.
//
// Store product titles look like:
//   "[boilerplate] <Game Name> [edition / condition / price]"
//   e.g. "Настолна игра Mage Knight: Emergence - The Portal to Power"
// We resolve them to a BoardGameGeek game in two stages:
//   1. EXACT: the longest contiguous run of title tokens that is a known game
//      name (so "Clash of Clans: The Epic Raid" beats the short game "Clans",
//      and "World Order: Diplomacy & Dominance" beats base "World Order").
//   2. FUZZY: when the store omits/reorders a word (e.g. drops "Arena" from
//      "Disney Sorcerer's Arena: Epic Alliances – Leading the Charge"), pick the
//      game with the best idf-weighted in-order token coverage of the title.

export interface Game {
  id: string;
  name: string;
  rank: string;
  average: string;
  yearpublished: string;
  usersrated?: string;
}

// Remove combining diacritical marks (Cyrillic itself is preserved).
export function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Normalize to comparable tokens: punctuation/symbols/whitespace are separators.
export function normalizeTokens(s: string): string[] {
  return stripDiacritics((s || '').toLowerCase())
    .replace(/[^a-z0-9\u0400-\u04ff]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function normKey(s: string): string {
  return normalizeTokens(s).join(' ');
}

export interface GameIndex {
  games: Game[];
  tokensOf: string[][];
  byName: Map<string, number>;
  inverted: Map<string, number[]>;
  idf: Map<string, number>;
  maxTokens: number;
}

function votes(g: Game): number {
  return parseInt(g.usersrated || '0', 10) || 0;
}

export function buildGameIndex(games: Game[]): GameIndex {
  const tokensOf: string[][] = [];
  const byName = new Map<string, number>();
  const inverted = new Map<string, number[]>();
  const df = new Map<string, number>();
  let maxTokens = 1;

  for (let i = 0; i < games.length; i++) {
    const toks = normalizeTokens(games[i].name);
    tokensOf.push(toks);
    if (toks.length === 0) continue;
    if (toks.length > maxTokens) maxTokens = toks.length;

    const key = toks.join(' ');
    const prev = byName.get(key);
    if (prev === undefined || votes(games[i]) > votes(games[prev])) {
      byName.set(key, i);
    }
    const seen = new Set<string>();
    for (const t of toks) {
      if (seen.has(t)) continue;
      seen.add(t);
      let post = inverted.get(t);
      if (!post) { post = []; inverted.set(t, post); }
      post.push(i);
      df.set(t, (df.get(t) || 0) + 1);
    }
  }

  const N = games.length || 1;
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log((N + 1) / (d + 1)) + 1);

  return { games, tokensOf, byName, inverted, idf, maxTokens };
}

export interface TokenMatch {
  gameIndex: number;
  start: number;
  end: number;
  length: number;
}

// Longest contiguous token run that is an exact game name.
export function resolveExact(tokens: string[], index: GameIndex): TokenMatch | null {
  const n = tokens.length;
  if (n === 0) return null;
  const lim = Math.min(n, index.maxTokens);
  for (let len = lim; len >= 1; len--) {
    for (let start = 0; start + len <= n; start++) {
      const key = tokens.slice(start, start + len).join(' ');
      const gi = index.byName.get(key);
      if (gi !== undefined) return { gameIndex: gi, start, end: start + len, length: len };
    }
  }
  return null;
}

function idfOf(index: GameIndex, tok: string): number {
  return index.idf.get(tok) || 1;
}

// Count game tokens present in the title as an in-order subsequence.
function orderedCoverage(
  gameToks: string[],
  titleSet: Set<string>,
  titleOrder: Map<string, number>,
  index: GameIndex
) {
  let matchedIdf = 0;
  let matchedCount = 0;
  let lastPos = -1;
  let inOrder = 0;
  for (const gt of gameToks) {
    if (titleSet.has(gt)) {
      matchedIdf += idfOf(index, gt);
      matchedCount++;
      const pos = titleOrder.get(gt)!;
      if (pos > lastPos) { inOrder++; lastPos = pos; }
    }
  }
  return { matchedIdf, matchedCount, inOrder };
}

// Fuzzy resolution: best idf-weighted coverage among candidate games that share
// the title's rarer tokens.
export function resolveFuzzy(tokens: string[], index: GameIndex): { gameIndex: number; score: number } | null {
  if (tokens.length === 0) return null;
  const titleSet = new Set(tokens);
  const titleOrder = new Map<string, number>();
  tokens.forEach((t, i) => { if (!titleOrder.has(t)) titleOrder.set(t, i); });

  const uniq = Array.from(titleSet);
  uniq.sort((a, b) => idfOf(index, b) - idfOf(index, a));
  const candidates = new Set<number>();
  let used = 0;
  for (const t of uniq) {
    const post = index.inverted.get(t);
    if (!post) continue;
    if (post.length > 4000) continue; // token too common to be useful
    for (const gi of post) candidates.add(gi);
    if (++used >= 6) break;
    if (candidates.size > 6000) break;
  }

  let best: { gameIndex: number; score: number } | null = null;
  for (const gi of candidates) {
    const gToks = index.tokensOf[gi];
    if (gToks.length === 0) continue;
    const totalIdf = gToks.reduce((s, t) => s + idfOf(index, t), 0);
    if (totalIdf <= 0) continue;
    const { matchedCount, inOrder, matchedIdf } = orderedCoverage(gToks, titleSet, titleOrder, index);
    if (matchedCount < 2) continue;
    if (inOrder < Math.min(gToks.length, 2)) continue; // require order
    const score = matchedIdf / totalIdf;
    if (score < 0.6) continue;
    if (!best || score > best.score ||
        (score === best.score && votes(index.games[gi]) > votes(index.games[best.gameIndex]))) {
      best = { gameIndex: gi, score };
    }
  }
  return best;
}

// Common store / edition / condition filler words (Bulgarian + English). Used
// only to compute the "core" of a title, so a weak single-word match is
// accepted only when that word is essentially the whole product name.
const BOILERPLATE = new Set([
  'nastolna', 'nastolni', 'igra', 'igri', 'za', 'dvama', 'deca', 'detska',
  'razshirenie', 'razsirenie', 'dopalnenie', 'komplekt', 'novo', 'nov', 'promo',
  'izdanie', 'balgarsko', 'bulgarsko', 'english', 'edition', 'editsiya',
  'expansion', 'pack', 'set', 'version', 'retail', 'preotsenena', 'preocenena',
  'povreda', 'na', 'kutiyata', 'kutiata', 's', 'with', 'the', 'of', 'and',
  'core', 'igrata', 'board', 'game', 'card',
  // Bulgarian (Cyrillic) store / edition / condition filler
  'настолна', 'настолни', 'игра', 'игри', 'играта', 'за', 'двама', 'деца',
  'детска', 'разширение', 'допълнение', 'комплект', 'ново', 'нов', 'промо',
  'издание', 'българско', 'българска', 'версия', 'карти', 'на', 'промоция',
  'оригинална', 'преоценена', 'повреда', 'кутията', 'кутия', 'лека', 'средна',
  'тежка',
]);

function coreTokens(tokens: string[]): string[] {
  return tokens.filter(t => t.length >= 2 && !BOILERPLATE.has(t));
}

export interface ResolveResult {
  game: Game;
  source: 'title' | 'slug';
  method: 'exact' | 'fuzzy';
  matchedTokens: string[];
}

// Resolve a product tile to a game from its visible title, falling back to its
// URL slug (romanized English, survives translation).
export function resolveProductTitle(
  title: string,
  slug: string,
  index: GameIndex,
  minSingleTokenLen = 3
): ResolveResult | null {
  const attempts: Array<{ source: 'title' | 'slug'; tokens: string[] }> = [];
  if (title) attempts.push({ source: 'title', tokens: normalizeTokens(title) });
  if (slug) attempts.push({ source: 'slug', tokens: normalizeTokens(slug) });

  let best: (ResolveResult & { score: number }) | null = null;

  for (const a of attempts) {
    const core = coreTokens(a.tokens);
    // 1. exact longest window
    const ex = resolveExact(a.tokens, index);
    if (ex) {
      const nameTokens = index.tokensOf[ex.gameIndex];
      const singleWord = nameTokens.length === 1;
      const longEnough = a.tokens[ex.start] && a.tokens[ex.start].length >= minSingleTokenLen;
      // A single-word game is only accepted when it covers most of the core
      // title (guards "MIND" from matching "MIND READER").
      const coverageOk = !singleWord ||
        (core.length > 0 && ex.length / core.length >= 0.6);
      const accept = ex.length >= 2 || (singleWord && longEnough && coverageOk);
      if (accept) {
        const score = ex.length >= 2 ? 100 + ex.length : 1;
        if (!best || score > best.score) {
          best = {
            game: index.games[ex.gameIndex], source: a.source, method: 'exact',
            matchedTokens: a.tokens.slice(ex.start, ex.end), score,
          };
        }
        if (ex.length >= 2) continue; // strong match; done with this attempt
      }
    }
    // 2. fuzzy fallback
    const fz = resolveFuzzy(a.tokens, index);
    if (fz) {
      const score = 10 + fz.score;
      if (!best || score > best.score) {
        best = {
          game: index.games[fz.gameIndex], source: a.source, method: 'fuzzy',
          matchedTokens: normalizeTokens(index.games[fz.gameIndex].name), score,
        };
      }
    }
  }

  if (!best) return null;
  const { score: _score, ...res } = best;
  return res;
}
