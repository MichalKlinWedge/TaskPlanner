/**
 * Deterministyczny zestaw danych deweloperskich (PLAN_ETAPOWY Etap 0): 5 przestrzeni, 40 list
 * i projektów, 2 000 zadań (z podzadaniami do 4 poziomów; `tasks` — inna liczba, np. 10 000 do
 * pomiarów z Etapu 13), tagi i 15 nawyków z historią 90 dni. Służy do testów wydajności widoków
 * (PoC-5) i do `seed:dev` od MVP-1. Ten sam `seed` = te same dane.
 */
import { keyBetween, uuidv5, type ListKind, type Priority, type TaskStatus } from '@taskplanner/core';

export interface SeedOptions {
  /** Dzień odniesienia (terminy rozkładają się wokół niego), `RRRR-MM-DD`. */
  today: string;
  seed?: number;
  tasks?: number;
  habits?: number;
  /**
   * Sól identyfikatorów: ten sam zestaw dla innego konta dostaje inne id (UUIDv5 z soli i id
   * z generatora), więc nie koliduje z wierszami pierwszego konta. Brak = id jak dotąd.
   */
  idSalt?: string;
}

export interface SeedWorkspace { id: string; name: string; color: string; sortKey: string }
export interface SeedList { id: string; workspaceId: string; kind: ListKind; name: string; startDate: string | null; endDate: string | null; sortKey: string }
export interface SeedTag { id: string; name: string }
export interface SeedTask {
  id: string;
  workspaceId: string;
  listId: string;
  parentId: string | null;
  kind: 'task' | 'habit';
  title: string;
  status: TaskStatus;
  priority: Priority;
  startDate: string | null;
  dueDate: string | null;
  dueTime: string | null;
  durationMin: number | null;
  recurrence: { mode: 'schedule'; rrule: string; anchor: string } | null;
  tagIds: string[];
  sortKey: string;
  /** Ukończone: chwila ukończenia (ostatnie 30 dni, z id — bez dodatkowych losowań). */
  completedAt?: string | null;
}
export interface SeedCompletion { taskId: string; occurrenceDate: string; kind: 'done' | 'skipped' }
export interface SeedDataset { workspaces: SeedWorkspace[]; lists: SeedList[]; tags: SeedTag[]; tasks: SeedTask[]; completions: SeedCompletion[] }

const WORKSPACES = [
  { name: 'Praca', color: '#2563eb', lists: ['Wdrożenie CRM', 'Raporty kwartalne', 'Rekrutacja', 'Szkolenia', 'Pomysły', 'Spotkania', 'Prezentacja zarządu'] },
  { name: 'Dom', color: '#16a34a', lists: ['Remont kuchni', 'Zakupy', 'Rachunki', 'Ogród', 'Samochód', 'Przeprowadzka piwnicy', 'Naprawy'] },
  { name: 'Studia', color: '#9333ea', lists: ['Praca dyplomowa', 'Statystyka', 'Egzaminy', 'Lektury', 'Projekt zespołowy', 'Notatki', 'Konferencja'] },
  { name: 'Hobby', color: '#ea580c', lists: ['Fotografia', 'Rower', 'Gitara', 'Książki do przeczytania', 'Wyjazd w góry', 'Majsterkowanie', 'Filmy'] },
  { name: 'Osobiste', color: '#db2777', lists: ['Zdrowie', 'Finanse', 'Prezenty', 'Urzędy', 'Rodzina', 'Rozwój', 'Kursy online'] },
] as const;

const TAGS = ['telefon', 'szybkie', 'na_mieście', 'komputer', 'czekam', 'spotkanie', 'mail', 'weekend', 'zakupy', 'ważne', 'pomysł', 'dom'];
const VERBS = ['Zadzwonić', 'Napisać', 'Sprawdzić', 'Kupić', 'Przygotować', 'Umówić', 'Zapłacić', 'Przeczytać', 'Poprawić', 'Wysłać', 'Zamówić', 'Uporządkować', 'Zaplanować', 'Odebrać', 'Omówić'];
const OBJECTS = ['ofertę', 'raport', 'fakturę', 'wizytę', 'dokumenty', 'prezentację', 'listę', 'paczkę', 'umowę', 'notatki', 'budżet', 'harmonogram', 'zdjęcia', 'zamówienie', 'wniosek'];
const HABITS = ['Woda 2 l', 'Spacer 30 min', 'Czytanie 20 stron', 'Medytacja', 'Bez cukru', 'Rozciąganie', 'Nauka angielskiego', 'Dziennik', 'Siłownia', 'Sen przed 23', 'Warzywa do obiadu', 'Bez telefonu po 22', 'Gitara 15 min', 'Planowanie dnia', 'Witaminy'];
const STATUSES: TaskStatus[] = ['todo', 'todo', 'todo', 'todo', 'in_progress', 'waiting', 'done', 'done', 'done', 'cancelled'];

/** Mulberry32: prosty, powtarzalny generator liczb losowych. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export function generateDataset({ today, seed = 1, tasks: taskCount = 2000, habits: habitCount = 15, idSalt }: SeedOptions): SeedDataset {
  const random = rng(seed);
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  // UUID w formacie v4 z generatora — powtarzalny między uruchomieniami.
  const uuid = () => {
    const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join('');
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[int(0, 3)]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    return idSalt ? uuidv5(`seed:${idSalt}:${id}`) : id;
  };
  const nextKey = (() => {
    const last = new Map<string, string>();
    return (scope: string) => {
      const key = keyBetween(last.get(scope));
      last.set(scope, key);
      return key;
    };
  })();

  const workspaces: SeedWorkspace[] = [];
  const lists: SeedList[] = [];
  for (const ws of WORKSPACES) {
    const workspace = { id: uuid(), name: ws.name, color: ws.color, sortKey: nextKey('workspaces') };
    workspaces.push(workspace);
    lists.push({ id: uuid(), workspaceId: workspace.id, kind: 'inbox', name: 'Inbox', startDate: null, endDate: null, sortKey: nextKey(workspace.id) });
    ws.lists.forEach((name, index) => {
      const project = index % 2 === 0;
      const start = addDays(today, int(-30, 10));
      lists.push({
        id: uuid(),
        workspaceId: workspace.id,
        kind: project ? 'project' : 'list',
        name,
        startDate: project ? start : null,
        endDate: project ? addDays(start, int(14, 90)) : null,
        sortKey: nextKey(workspace.id),
      });
    });
  }

  const tags = TAGS.map((name) => ({ id: uuid(), name }));

  const tasks: SeedTask[] = [];
  // Głębokość i zadania listy zapamiętane przy dodawaniu: szukanie rodziców po całej tablicy
  // w pętli przy 10 000 zadań trwało minuty. Kolejność losowań bez zmian (ten sam `seed` = te same dane).
  const depth = new Map<string, number>();
  const byList = new Map<string, SeedTask[]>();
  const newTask = (list: SeedList, parent: SeedTask | null): SeedTask => {
    const hasDate = random() < 0.65;
    const dueDate = hasDate ? addDays(today, int(-10, 45)) : null;
    const hasTime = hasDate && random() < 0.35;
    const multiDay = hasDate && list.kind === 'project' && random() < 0.3;
    const task: SeedTask = {
      id: uuid(),
      workspaceId: list.workspaceId,
      listId: list.id,
      parentId: parent?.id ?? null,
      kind: 'task',
      title: `${pick(VERBS)} ${pick(OBJECTS)}`,
      status: pick(STATUSES),
      priority: pick([1, 2, 2, 3, 3, 3, 4, 4, 4, 4] as const),
      startDate: multiDay && dueDate ? addDays(dueDate, -int(2, 10)) : null,
      dueDate,
      dueTime: hasTime ? `${String(int(7, 19)).padStart(2, '0')}:${pick(['00', '15', '30', '45'])}` : null,
      durationMin: random() < 0.5 ? pick([15, 30, 45, 60, 90, 120]) : null,
      recurrence: null,
      tagIds: tags.filter(() => random() < 0.12).map((tag) => tag.id),
      sortKey: nextKey(`${list.id}/${parent?.id ?? ''}`),
    };
    // Rozłożone na 30 dni (≈ 1/30 dziś): wszystkie „ukończone teraz” dawały tysiące wierszy w „Dziś”.
    if (task.status === 'done') task.completedAt = `${addDays(today, -(parseInt(task.id.slice(0, 4), 16) % 30))}T16:00:00Z`;
    tasks.push(task);
    depth.set(task.id, parent ? depth.get(parent.id)! + 1 : 1);
    if (!byList.has(list.id)) byList.set(list.id, []);
    byList.get(list.id)!.push(task);
    return task;
  };

  while (tasks.length < taskCount) {
    const list = pick(lists);
    // Co piąte zadanie jest podzadaniem istniejącego z tej samej listy (do 4 poziomów).
    const candidates = random() < 0.2 ? (byList.get(list.id) ?? []).filter((t) => depth.get(t.id)! < 4) : [];
    newTask(list, candidates.length ? pick(candidates) : null);
  }

  const completions: SeedCompletion[] = [];
  const habitLists = lists.filter((l) => l.kind === 'inbox');
  for (const name of HABITS.slice(0, habitCount)) {
    const list = pick(habitLists);
    const weekdaysOnly = random() < 0.3;
    const habit: SeedTask = {
      id: uuid(),
      workspaceId: list.workspaceId,
      listId: list.id,
      parentId: null,
      kind: 'habit',
      title: name,
      status: 'todo',
      priority: 4,
      startDate: null,
      dueDate: today,
      dueTime: random() < 0.5 ? `${String(int(6, 21)).padStart(2, '0')}:00` : null,
      durationMin: null,
      recurrence: { mode: 'schedule', rrule: weekdaysOnly ? 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' : 'FREQ=DAILY', anchor: addDays(today, -90) },
      tagIds: [],
      sortKey: nextKey(`${list.id}/`),
    };
    tasks.push(habit);
    const regularity = 0.4 + random() * 0.55;
    for (let day = -90; day < 0; day++) {
      const date = addDays(today, day);
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      if (weekdaysOnly && (weekday === 0 || weekday === 6)) continue;
      const roll = random();
      if (roll < regularity) completions.push({ taskId: habit.id, occurrenceDate: date, kind: 'done' });
      else if (roll < regularity + 0.03) completions.push({ taskId: habit.id, occurrenceDate: date, kind: 'skipped' });
    }
  }

  return { workspaces, lists, tags, tasks, completions };
}
