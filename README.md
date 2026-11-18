# TaskPlanner

Osobisty system zadań codziennych: listy, kanban, kalendarz z time-blockingiem i oś czasu nad tymi samymi danymi. Web (Next.js, PWA) i Android (Expo), oba działają offline. Backend: Supabase.

- Specyfikacja: [SPECYFIKACJA.md](SPECYFIKACJA.md)
- Plan etapowy: [PLAN_ETAPOWY.md](PLAN_ETAPOWY.md)
- Warunki usług zewnętrznych: [docs/USLUGI.md](docs/USLUGI.md)

## Start

```bash
npm install
cp .env.example .env.local     # uzupełnij klucze Supabase
npm run check                  # typy, lint, testy
npm run web                    # http://localhost:3000
npm run supabase -- start      # lokalny Supabase (Docker), porty 545xx
```

Aplikacja Android wymaga dev buildu (`npx eas-cli@latest build --platform android --profile development` w `apps/mobile`), potem `npm run mobile`.
