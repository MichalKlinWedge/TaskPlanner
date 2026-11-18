/**
 * Hybrid logical clock (SPECYFIKACJA §6): znacznik każdej zmiany pola. Format tekstowy
 * `CCCCCCCCCCCCCCC:LLLLL:węzeł` — milisekundy (15 cyfr), licznik (5 cyfr), id urządzenia —
 * porównywany jak zwykły tekst (`a > b` = `a` nowszy), także w Postgresie (`text` z collation „C”).
 *
 * Zasady: nowy znacznik jest zawsze większy od poprzedniego z tego urządzenia i od każdego
 * odebranego (`receive`), więc edycja zrobiona po zobaczeniu cudzej zmiany zawsze ją wygrywa.
 */

export type Hlc = string;

const WALL_DIGITS = 15;
const COUNTER_DIGITS = 5;
const MAX_COUNTER = 10 ** COUNTER_DIGITS - 1;
const PATTERN = /^(\d{15}):(\d{5}):([A-Za-z0-9_-]{1,64})$/;

export interface HlcParts {
  wall: number;
  counter: number;
  node: string;
}

export function formatHlc({ wall, counter, node }: HlcParts): Hlc {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(node)) throw new Error(`Niepoprawny identyfikator węzła HLC: „${node}”.`);
  return `${String(wall).padStart(WALL_DIGITS, '0')}:${String(counter).padStart(COUNTER_DIGITS, '0')}:${node}`;
}

export function parseHlc(value: Hlc): HlcParts {
  const match = PATTERN.exec(value);
  if (!match) throw new Error(`Niepoprawny znacznik HLC: „${value}”.`);
  return { wall: Number(match[1]), counter: Number(match[2]), node: match[3]! };
}

export const isHlc = (value: unknown): value is Hlc => typeof value === 'string' && PATTERN.test(value);

/** −1, 0, 1 jak w sortowaniu. Porównanie tekstowe = porównanie (czas, licznik, węzeł). */
export const compareHlc = (a: Hlc, b: Hlc): number => (a < b ? -1 : a > b ? 1 : 0);

/** Najnowszy z podanych (brak = `undefined`). */
export const maxHlc = (...values: (Hlc | undefined | null)[]): Hlc | undefined =>
  values.reduce<Hlc | undefined>((best, value) => (value && (!best || value > best) ? value : best), undefined);

export class HlcClock {
  private wall = 0;
  private counter = 0;

  constructor(
    readonly node: string,
    private readonly now: () => number = () => Date.now(),
    last?: Hlc,
  ) {
    formatHlc({ wall: 0, counter: 0, node });
    if (last) this.receive(last);
  }

  /** Ostatni wydany albo odebrany stan zegara. */
  get last(): Hlc {
    return formatHlc({ wall: this.wall, counter: this.counter, node: this.node });
  }

  /** Znacznik nowej lokalnej zmiany. */
  tick(): Hlc {
    const physical = this.now();
    if (physical > this.wall) {
      this.wall = physical;
      this.counter = 0;
    } else {
      this.bump();
    }
    return this.last;
  }

  /** Uwzględnij znacznik zobaczony u innego węzła (pobrane zmiany, odpowiedź serwera). */
  receive(remote: Hlc): void {
    const { wall, counter } = parseHlc(remote);
    const physical = this.now();
    if (physical > this.wall && physical > wall) {
      this.wall = physical;
      this.counter = 0;
    } else if (wall > this.wall) {
      this.wall = wall;
      this.counter = counter;
    } else if (wall === this.wall) {
      this.counter = Math.max(this.counter, counter);
    }
  }

  private bump() {
    if (this.counter >= MAX_COUNTER) {
      this.wall += 1;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
  }
}
