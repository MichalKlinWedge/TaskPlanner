'use no memo';
// Widżet to drzewo zwykłych funkcji wywoływanych poza Reactem — React Compiler nie może ich
// przerabiać (dodałby hooki pamięci podręcznej → „Invalid hook call”).
import { FlexWidget, TextWidget } from 'react-native-android-widget';

import { APP_URI, themed, type Palette } from './ui';

export const QUICK_ADD_WIDGET = 'QuickAdd';

/**
 * „Szybkie dodawanie” (M20): pole otwiera okno nad ekranem głównym z klawiaturą (bez otwierania aplikacji),
 * mikrofon — od razu systemowe rozpoznawanie mowy; tekst trafia do Inbox (moduł `quick-capture`, `lib/quick-capture.ts`).
 * Licznik Inbox otwiera Inbox.
 */
function QuickAddWidgetView({ inbox, palette }: { inbox: number | null; palette: Palette }) {
  return (
    <FlexWidget
      style={{ height: 'match_parent', width: 'match_parent', backgroundColor: palette.bg, borderRadius: 28, padding: 6, flexDirection: 'row', alignItems: 'center' }}
    >
      <FlexWidget
        clickAction="OPEN_URI"
        clickActionData={{ uri: APP_URI.capture }}
        accessibilityLabel="Dodaj zadanie"
        style={{ flex: 1, height: 'match_parent', backgroundColor: palette.field, borderRadius: 22, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center' }}
      >
        <TextWidget text="＋" style={{ fontSize: 18, fontWeight: '600', color: palette.accent, marginRight: 8 }} />
        <TextWidget text="Dodaj zadanie" maxLines={1} style={{ fontSize: 15, color: palette.muted }} />
      </FlexWidget>
      <FlexWidget
        clickAction="OPEN_URI"
        clickActionData={{ uri: APP_URI.captureVoice }}
        accessibilityLabel="Podyktuj zadanie"
        style={{ height: 'match_parent', backgroundColor: palette.field, borderRadius: 22, paddingHorizontal: 12, marginLeft: 6, justifyContent: 'center' }}
      >
        <TextWidget text="🎤" style={{ fontSize: 18 }} />
      </FlexWidget>
      {inbox !== null ? (
        <FlexWidget
          clickAction="OPEN_URI"
          clickActionData={{ uri: APP_URI.inbox }}
          accessibilityLabel={`Inbox: ${inbox}`}
          style={{ height: 'match_parent', paddingHorizontal: 10, marginLeft: 2, flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}
        >
          <TextWidget text={String(inbox)} style={{ fontSize: 15, fontWeight: '600', color: palette.fg }} />
          <TextWidget text="Inbox" style={{ fontSize: 10, color: palette.muted }} />
        </FlexWidget>
      ) : null}
    </FlexWidget>
  );
}

/** `inbox` = `null` — licznik niedostępny (błąd bazy): sam przycisk dodawania. */
export const quickAddWidget = (inbox: number | null) => themed((palette) => <QuickAddWidgetView inbox={inbox} palette={palette} />);
