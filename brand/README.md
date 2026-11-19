# Marka TaskPlanner

Znak: białe zaznaczenie (zrobione) i bursztynowa kropka (teraz / przypomnienie) na indygo.
Źródłem wszystkich plików jest `scripts/brand.mjs` — zmiany w nim, potem:

```bash
node scripts/brand.mjs
```

| Plik | Użycie |
| --- | --- |
| `mark.svg` | znak (favicon, ikona, splash) |
| `mark-ink.svg`, `mark-paper.svg` | znak jednobarwny na ciemnym / jasnym tle |
| `logo.svg`, `logo-dark.svg` | znak + nazwa na jasnym / ciemnym tle |

Generowane poza `brand/`: `apps/web/src/app/icon.svg`, `apple-icon.png`, `apps/web/public/icons/*`
(manifest PWA), `apps/mobile/assets/images/*` (ikona, adaptive icon z wersją monochrome, splash).

## Kolory

| Nazwa | Hex | Rola |
| --- | --- | --- |
| Indygo | `#4F46E5` | kolor główny, tło adaptive icon, `theme_color` |
| Indygo jasne → ciemne | `#6366F1` → `#3730A3` | gradient tła znaku |
| Bursztyn | `#FBBF24` | akcent (kropka) |
| Atrament | `#18181B` | tekst na jasnym tle |
| Papier / Noc | `#FAFAFA` / `#09090B` | tło jasne / ciemne (jak `globals.css`) |

Napis w `logo*.svg` jest tekstem (Geist, zastępczo Segoe UI / Inter) — do druku zamień go na krzywe.
Wokół znaku zostaw pusty margines co najmniej ¼ jego szerokości; nie zmieniaj proporcji ani kolorów kropki.
