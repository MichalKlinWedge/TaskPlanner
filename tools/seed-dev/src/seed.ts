/**
 * `npm run seed:dev [-- --today 2026-11-18 --seed 1 --out plik.json]`
 *
 * Zapisuje zestaw danych do `tools/seed-dev/out/dataset.json` i wypisuje podsumowanie;
 * z `--load` wysyła go też do lokalnego Supabase (`load.ts`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { generateDataset } from './generate.ts';
import { loadDataset } from './load.ts';

const { values } = parseArgs({
  options: {
    today: { type: 'string', default: new Date().toISOString().slice(0, 10) },
    seed: { type: 'string', default: '1' },
    load: { type: 'boolean', default: false },
    out: { type: 'string', default: fileURLToPath(new URL('../out/dataset.json', import.meta.url)) },
  },
});

const dataset = generateDataset({ today: values.today, seed: Number(values.seed) });
mkdirSync(dirname(values.out), { recursive: true });
writeFileSync(values.out, JSON.stringify(dataset, null, 2));

const subtasks = dataset.tasks.filter((t) => t.parentId).length;
const habits = dataset.tasks.filter((t) => t.kind === 'habit').length;
console.log(
  `${dataset.workspaces.length} przestrzeni, ${dataset.lists.length} list, ${dataset.tasks.length - habits} zadań (w tym ${subtasks} podzadań), ` +
    `${habits} nawyków, ${dataset.completions.length} ukończeń → ${values.out}`,
);

if (values.load) await loadDataset(dataset);
