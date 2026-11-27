import { describe, expect, it } from 'vitest';

import { apiTaskId, tagId, taskTagId } from '../ids.ts';
import {
  API_TOKEN_RE,
  ApiTokenCreate,
  apiTokenHash,
  apiTokenHint,
  bearerApiToken,
  generateApiToken,
  InboundTaskInput,
  inboundIssue,
  inboundIssues,
  inboundSource,
  inboundTags,
  inboundTaskResult,
  inboundTaskRow,
  inboundUpsertOutcome,
  parseApiToken,
  parseExternalKey,
} from '../inbound-api.ts';
import { pluginPayload, SAMPLE_TASK } from '../plugins/payload.ts';
import { TaskSource } from '../schemas/model.ts';

/** Przychodzące API (v1.x, kontrakt `docs/INTEGRACJA_TP.md` w EP): token, klucz, treść `PUT`, tagi po nazwie, odpowiedź. */

const USER = '019a0000-0000-7000-8000-000000000001';
const KEY = 'ep:0b9d6c2e-1111-4222-8333-444455556666:t-12';

describe('token', () => {
  it('ma przedrostek, 43 znaki base64url i jest losowy', () => {
    const a = generateApiToken();
    expect(a).toMatch(API_TOKEN_RE);
    expect(generateApiToken()).not.toBe(a);
    expect(apiTokenHint(a)).toBe(`…${a.slice(-4)}`);
  });

  it('skrót SHA-256 szesnastkowo (wektor testowy)', async () => {
    expect(await apiTokenHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('czyta tylko „Bearer tpk_…” o poprawnym formacie', () => {
    const t = generateApiToken();
    expect(bearerApiToken(`Bearer ${t}`)).toBe(t);
    expect(bearerApiToken(`bearer   ${t} `)).toBe(t);
    expect(bearerApiToken(t)).toBeNull();
    expect(bearerApiToken('Bearer eyJhbGciOi.jwt.token')).toBeNull();
    expect(bearerApiToken(null)).toBeNull();
  });

  it('utworzenie wymaga nazwy i listy', () => {
    expect(ApiTokenCreate.parse({ label: '  EP ', listId: USER })).toEqual({ label: 'EP', listId: USER });
    expect(ApiTokenCreate.safeParse({ label: ' ', listId: USER }).success).toBe(false);
    expect(ApiTokenCreate.safeParse({ label: 'EP', listId: 'x' }).success).toBe(false);
  });

  it('wiersz u klienta: odwołany = brak', () => {
    const row = { id: USER, label: 'EP', list_id: USER, token_hint: '…abcd', created_at: '2026-11-27T10:00:00Z', last_used_at: null };
    expect(parseApiToken(row)).toEqual({ id: USER, label: 'EP', listId: USER, tokenHint: '…abcd', createdAt: '2026-11-27T10:00:00Z', lastUsedAt: null });
    expect(parseApiToken({ ...row, deleted_at: '2026-11-27T11:00:00Z' })).toBeNull();
  });
});

describe('klucz zewnętrzny', () => {
  it('rozbiera ep:<tripId>:<ref>, także zakodowany w adresie', () => {
    expect(parseExternalKey(KEY)).toEqual({ key: KEY, app: 'expeditionplan', tripId: '0b9d6c2e-1111-4222-8333-444455556666', ref: 't-12' });
    expect(parseExternalKey(encodeURIComponent(KEY))?.key).toBe(KEY);
  });

  it('odrzuca inne aplikacje i znaki spoza wzorca', () => {
    for (const bad of ['gl:1:2', 'ep:trip', 'ep::x', 'ep:a:b/c', 'ep:a:b c', `ep:a:${'x'.repeat(129)}`, '%E0%A4%A']) expect(parseExternalKey(bad)).toBeNull();
  });

  it('id zadania zależy od konta i klucza (powtórka = ten sam wiersz)', () => {
    expect(apiTaskId(USER, KEY)).toBe(apiTaskId(USER, KEY));
    expect(apiTaskId(USER, KEY)).not.toBe(apiTaskId('019a0000-0000-7000-8000-000000000002', KEY));
    expect(apiTaskId(USER, KEY)).not.toBe(apiTaskId(USER, `${KEY}x`));
  });
});

describe('treść PUT', () => {
  const source = { kind: 'expeditionplan', tripId: '0b9d6c2e-1111-4222-8333-444455556666', ref: 't-12', url: 'https://ep.example/trips/1' } as const;

  it('pole nieobecne nie trafia do zapisu, null czyści', () => {
    expect(inboundTaskRow(InboundTaskInput.parse({ title: ' Kupić bilety ', source }))).toEqual({ title: 'Kupić bilety' });
    expect(inboundTaskRow(InboundTaskInput.parse({ title: 'x', dueDate: null, dueTime: null, timeZone: null, source }))).toEqual({
      title: 'x', due_date: null, due_time: null, time_zone: null,
    });
  });

  it('pełna treść (jak plannerTask w EP) → kolumny zadania', () => {
    const input = InboundTaskInput.parse({
      title: 'Ubezpieczenie', description: 'Polisa **turystyczna**', status: 'cancelled', priority: 2,
      startDate: '2026-12-01', dueDate: '2026-12-10', dueTime: '18:00', timeZone: 'Europe/Warsaw', tags: ['wyjazd', 'Maroko 2026'], source,
    });
    expect(inboundTaskRow(input)).toEqual({
      title: 'Ubezpieczenie', description_md: 'Polisa **turystyczna**', status: 'cancelled', priority: 2,
      start_date: '2026-12-01', due_date: '2026-12-10', due_time: '18:00', time_zone: 'Europe/Warsaw',
    });
    expect(input.tags).toEqual(['wyjazd', 'Maroko 2026']);
  });

  it('pusty opis = brak opisu', () => {
    expect(inboundTaskRow(InboundTaskInput.parse({ title: 'x', description: '  ', source })).description_md).toBeNull();
  });

  it('błędy po polsku z nazwą pola i szczegółami', () => {
    const issue = (body: Record<string, unknown>) => {
      const r = InboundTaskInput.safeParse({ source, ...body });
      return r.success ? null : inboundIssue(r.error);
    };
    expect(issue({})).toBe('title: Brak tytułu.');
    expect(issue({ title: '' })).toBe('title: Tytuł nie może być pusty.');
    expect(issue({ title: 'x', status: 'zrobione' })).toMatch(/^status: Status: jeden z todo/);
    expect(issue({ title: 'x', priority: 5 })).toBe('priority: Priorytet: 1 (krytyczny) … 4 (niski).');
    expect(issue({ title: 'x', dueDate: '2026-13-01' })).toBe('dueDate: Data w formacie RRRR-MM-DD, np. „2026-12-12”.');
    expect(issue({ title: 'x', dueTime: '10:00' })).toBe('dueDate: Godzina i początek wymagają terminu (dueDate).');
    expect(issue({ title: 'x', dueDate: '2026-12-01', startDate: '2026-12-02' })).toBe('startDate: Początek po terminie.');
    expect(issue({ title: 'x', timeZone: 'Mars/Olympus' })).toBe('timeZone: Strefa IANA, np. „Europe/Warsaw”.');
    expect(issue({ title: 'x', tags: ['#wyjazd'] })).toBe('tags.0: Tag bez znaku „#” i znaków sterujących.');
    expect(issue({ title: 'x', source: { ...source, url: 'javascript:alert(1)' } })).toMatch(/^source\.url: Adres musi zaczynać się od https/);
    expect(issue({ title: 'x', source: { ...source, kind: 'gitlab' } })).toBe('source.kind: Rodzaj źródła: „expeditionplan”.');
    expect(issue({ title: 'x', titel: 'literówka' })).toBe('Nieznane pole: titel.');

    const r = InboundTaskInput.safeParse({ title: '', priority: 9 });
    expect(r.success).toBe(false);
    const all = inboundIssues(r.error!);
    expect(all.details.map((d) => d.path).sort()).toEqual(['priority', 'source', 'title']);
    expect(all.error).toBe(`${all.details[0]!.path}: ${all.details[0]!.message}`);
  });

  it('source zgodne z kluczem (pasuje do TaskSource), niezgodne = null', () => {
    const key = parseExternalKey(KEY)!;
    const stored = inboundSource(key, source);
    expect(stored).toEqual({ kind: 'expeditionplan', tripId: key.tripId, ref: 't-12', url: 'https://ep.example/trips/1' });
    expect(TaskSource.parse(stored)).toEqual(stored);
    expect(inboundSource(key, { ...source, url: null })).not.toHaveProperty('url');
    expect(inboundSource(key, { ...source, ref: 't-13' })).toBeNull();
    expect(inboundSource(key, { ...source, tripId: 'inny' })).toBeNull();
  });
});

describe('tagi po nazwie', () => {
  it('istniejący tag bez wielkości liter, nowy z tagId, powtórki raz', () => {
    const task = apiTaskId(USER, KEY);
    const existing = [{ id: '019a0000-0000-7000-8000-0000000000aa', name: 'Wyjazd' }];
    const tags = inboundTags(USER, task, ['wyjazd', 'bilety', 'BILETY'], existing);
    expect(tags).toEqual([
      { name: 'wyjazd', tagId: existing[0]!.id, id: taskTagId(task, existing[0]!.id) },
      { name: 'bilety', tagId: tagId(USER, 'bilety'), id: taskTagId(task, tagId(USER, 'bilety')) },
    ]);
  });
});

describe('odpowiedź', () => {
  it('kształt PlannerTaskResult z rzutu plugin_task_context', () => {
    const result = inboundTaskResult(KEY, { ...SAMPLE_TASK, status: 'in_progress', deletedAt: '2026-11-27T10:00:00Z' }, 'https://app.example/', {
      created: true, applied: ['title', 'dueDate'], kept: ['priority'],
    });
    expect(result).toEqual({
      id: SAMPLE_TASK.id, key: KEY, created: true, status: 'in_progress', deleted: true,
      url: `https://app.example/?task=${SAMPLE_TASK.id}`, applied: ['title', 'dueDate'], kept: ['priority'],
    });
    expect(inboundTaskResult(KEY, SAMPLE_TASK, 'https://app')).toMatchObject({ created: false, deleted: false, applied: [], kept: [] });
    expect(inboundTaskResult(KEY, { nie: 'zadanie' }, 'https://app')).toBeNull();
  });

  it('wynik upsert z nazwami pól API', () => {
    expect(inboundUpsertOutcome({ status: 'updated', applied: ['due_date', 'time_zone', 'tags'], kept: ['title', 'description_md', 'start_date'] })).toEqual({
      result: 'updated', applied: ['dueDate', 'timeZone', 'tags'], kept: ['title', 'description', 'startDate'],
    });
    expect(inboundUpsertOutcome({ status: 'deleted' })).toEqual({ result: 'deleted', applied: [], kept: [] });
    expect(inboundUpsertOutcome({ status: 'inny' })).toBeNull();
  });
});

describe('source w ładunku pluginu', () => {
  it('webhook niesie wyjazd i zadanie EP', () => {
    const ep = { kind: 'expeditionplan', tripId: '0b9d6c2e-1111-4222-8333-444455556666', ref: 't-12', url: 'https://ep.example/trips/1' } as const;
    const source = inboundSource(parseExternalKey(KEY)!, ep)!;
    const payload = pluginPayload({ id: 'x', events: ['task.completed'], sentAt: 'now', rule: null, task: { ...SAMPLE_TASK, source }, appUrl: 'https://app' });
    expect(payload.task.source).toEqual(ep);
    expect(pluginPayload({ id: 'x', events: ['task.sent'], sentAt: 'now', rule: null, task: SAMPLE_TASK, appUrl: 'https://app' }).task.source).toBeNull();
  });
});
