/**
 * Wejście aplikacji. Kolejność ma znaczenie:
 * 1. polyfille (Hermes nie ma `crypto.getRandomValues` ani pełnego `URL`),
 * 2. zadania w tle zdefiniowane w zasięgu modułu — system uruchamia bundel bez ekranu
 *    (akcja z powiadomienia, kliknięcie w widżet) i zadanie musi już być zarejestrowane,
 * 3. dopiero potem Expo Router.
 */
import './src/lib/polyfills';
import './src/background/register';
import 'expo-router/entry';
