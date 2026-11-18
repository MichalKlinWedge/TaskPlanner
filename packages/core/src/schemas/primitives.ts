/**
 * Podstawowe typy danych wspólne dla schematów (SPECYFIKACJA §5 „Konwencje”). Czas zadań jest
 * „pływający”: data i godzina ścienna użytkownika bez strefy.
 */
import { z } from 'zod';

/** Klucz kolejności ręcznej (`sort_key`, `sort-key.ts`). */
export const SortKey = z.string().regex(/^[0-9a-z]+$/, 'Klucz kolejności: cyfry i małe litery, np. „0010”.');

/** Data pływająca `RRRR-MM-DD`. */
export const LocalDate = z.iso.date();
export type LocalDate = z.infer<typeof LocalDate>;

/** Godzina pływająca `GG:MM`. */
export const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Godzina w formacie GG:MM, np. „09:30”.');
export type LocalTime = z.infer<typeof LocalTime>;

/** Priorytet 1–4: 1 = krytyczny, 4 = niski (domyślny). */
export const Priority = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type Priority = z.infer<typeof Priority>;

export const TaskStatus = z.enum(['todo', 'in_progress', 'waiting', 'done', 'cancelled']);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const ListKind = z.enum(['inbox', 'project', 'list']);
export type ListKind = z.infer<typeof ListKind>;

export const ProjectStatus = z.enum(['active', 'on_hold', 'done']);
export type ProjectStatus = z.infer<typeof ProjectStatus>;
