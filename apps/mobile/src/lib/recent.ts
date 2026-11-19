/** Ostatnio otwierane w wyszukiwarce (id → ISO) — wyżej w wynikach `core/search.ts`, jak na webie. */
import { readJson, writeJson } from './config';

const KEY = 'search.recent';

export const readRecent = (): Map<string, string> => new Map(Object.entries(readJson<Record<string, string>>(KEY, {})));

export function rememberRecent(id: string) {
  const recent = [...readRecent()].filter(([k]) => k !== id);
  recent.unshift([id, new Date().toISOString()]);
  writeJson(KEY, Object.fromEntries(recent.slice(0, 30)));
}
