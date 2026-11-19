/**
 * Typowane trasy Expo Routera (`.expo/types/router.d.ts`) bez uruchamiania `expo start`: `typecheck`
 * widzi nowe i przeniesione ekrany od razu (plik jest w `.gitignore`, generuje go też serwer Metro).
 */
const path = require('node:path');

const root = path.resolve(__dirname, '..');
process.env.EXPO_ROUTER_APP_ROOT = path.join(root, 'src/app');
// `@expo/router-server` jest zależnością `@expo/cli` (nie aplikacji) — szukany obok niego.
const cli = path.dirname(require.resolve('@expo/cli/package.json', { paths: [root] }));
const typedRoutes = require(require.resolve('@expo/router-server/build/typed-routes', { paths: [cli, root] }));
typedRoutes.regenerateDeclarations(path.join(root, '.expo/types'), {});
