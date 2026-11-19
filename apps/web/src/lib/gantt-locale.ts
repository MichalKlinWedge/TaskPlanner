/**
 * Polskie napisy SVAR Gantt (`@svar-ui/gantt-locales` ma tylko en i cn, a `core-locales` — bez
 * polskiego): kalendarz, formaty i te teksty osi, które widać bez edytora i menu SVAR.
 */
const calendar = {
  monthFull: ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"],
  monthShort: ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"],
  dayFull: ["niedziela", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota"],
  dayShort: ["nd", "pn", "wt", "śr", "cz", "pt", "sb"],
  hours: "Godziny",
  minutes: "Minuty",
  done: "Gotowe",
  clear: "Wyczyść",
  today: "Dziś",
  am: ["am", "AM"],
  pm: ["pm", "PM"],
  weekStart: 1,
  clockFormat: 24,
};

export const GANTT_PL = {
  lang: "pl-PL",
  calendar,
  core: { ok: "OK", cancel: "Anuluj", select: "Wybierz", "No data": "Brak danych", "Rows per page": "Wierszy na stronę", "Total pages": "Stron" },
  formats: { timeFormat: "%H:%i", dateFormat: "%d.%m.%Y", monthYearFormat: "%F %Y", yearFormat: "%Y" },
  gantt: {
    "Task name": "Zadanie",
    "Start date": "Początek",
    "End date": "Koniec",
    "Add task": "Dodaj zadanie",
    Duration: "Dni",
    Task: "Zadanie",
    Milestone: "Kamień milowy",
    "Summary task": "Projekt",
    Progress: "Postęp",
    Predecessors: "Poprzednicy",
    Successors: "Następnicy",
    "End-to-start": "Koniec → początek",
    "Start-to-start": "Początek → początek",
    "End-to-end": "Koniec → koniec",
    "Start-to-end": "Początek → koniec",
    "No links": "Brak zależności",
    Lag: "Opóźnienie",
    Delete: "Usuń",
    Week: "Tydzień",
    Q: "Kwartał",
    "Link violation": "Naruszona zależność",
    "Remove link": "Usuń zależność",
  },
};
