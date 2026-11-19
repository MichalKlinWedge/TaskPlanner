# Build Androida bez EAS

Decyzja (PoC-4, 18.11.2026): APK budujemy sami — lokalnie (`expo run:android` / Gradle) i w GitHub Actions (`.github/workflows/android.yml`). EAS Build i EAS Update nie są używane (limit 15 buildów/mies. na Free wyczerpał się w trakcie PoC-4). `expo-updates` zostaje w zależnościach, ale bez `updates.url` nic nie pobiera; aktualizacja = nowy APK.

## Lokalnie (iteracja z telefonem przez USB)

1. JDK 17 (np. Temurin) i Android SDK: `platform-tools`, `platforms;android-37.0`, `build-tools;37.0.0`, `ndk;27.1.12297006`, `cmake;3.22.1` (Android Studio instaluje je samo; bez niego — `cmdline-tools` + `sdkmanager`). Zmienne `JAVA_HOME`, `ANDROID_HOME`, `platform-tools` w `PATH`.
2. Telefon: Opcje programisty → Debugowanie USB; po podłączeniu zaakceptować klucz komputera (`adb devices` pokazuje `device`).
3. `cd apps/mobile && npx expo run:android` — prebuild, build debug, instalacja i Metro. Kolejne zmiany JS przez Metro bez przebudowy; przebudowa tylko po zmianie zależności natywnych albo `app.json`.
4. Build samodzielny (JS w APK, do testów bez komputera): `npx expo run:android --variant release` albo `cd android && gradlew assembleRelease`.

**Windows — długie ścieżki.** Z katalogu o długiej ścieżce (np. worktree `…\.claude\worktrees\…`) CMake/ninja kończy się `ninja: error: mkdir(...): No such file or directory`. `subst` nie pomaga (Node rozwiązuje prawdziwą ścieżkę). Ninja 1.10 z domyślnego CMake 3.22.1 nie obsługuje długich ścieżek nawet przy `LongPathsEnabled = 1` (ścieżki obiektów codegenu Gesture Handlera mają ~275 znaków także z kopii `C:\tp`). Rozwiązanie:

1. `sdkmanager "cmake;3.31.6"` (ninja 1.12.1 obsługuje długie ścieżki);
2. w `android/local.properties` (prebuild go usuwa — dopisać po każdym prebuildzie): `cmake.dir=C\:/Users/<użytkownik>/AppData/Local/Android/Sdk/cmake/3.31.6`;
3. `LongPathsEnabled = 1` w systemie (wymaga administratora) i build z katalogu o krótszej ścieżce (kopia bez `node_modules`, potem `npm ci`).

Szybciej: `gradlew assembleDebug -PreactNativeArchitectures=arm64-v8a` (jedna architektura).

## GitHub Actions

Uruchomienie: Actions → „Android APK” → *Run workflow* (opcja „Utworzyć GitHub Release”) albo push tagu `android-v*` (np. `git tag android-v0.1.0 && git push origin android-v0.1.0`). APK jest w artefaktach przebiegu (30 dni) i — przy tagu — w Releases.

### Klucz podpisu (robisz sam, raz)

Klucz podpisu jest na zawsze: APK podpisany innym kluczem nie zaktualizuje zainstalowanej aplikacji. Trzymać kopię poza repozytorium (menedżer haseł).

1. Wygenerowanie (JDK ma `keytool`):
   ```
   keytool -genkeypair -v -storetype PKCS12 -keystore taskplanner-release.jks -alias taskplanner -keyalg RSA -keysize 4096 -validity 10000
   ```
2. Base64 do sekretu (PowerShell):
   ```
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("taskplanner-release.jks")) | Set-Clipboard
   ```
3. GitHub → repozytorium → Settings → Secrets and variables → Actions → *New repository secret*:
   - `ANDROID_KEYSTORE_BASE64` — schowek z kroku 2,
   - `ANDROID_KEYSTORE_PASSWORD` — hasło magazynu,
   - `ANDROID_KEY_ALIAS` — `taskplanner`,
   - `ANDROID_KEY_PASSWORD` — hasło klucza (przy PKCS12 to samo co magazynu).
4. Opcjonalnie (zakładka *Variables*): `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` — wartości domyślne w APK (w aplikacji i tak można je zmienić na ekranie „Konto i serwer”).

Bez sekretów workflow też działa, ale APK jest podpisany kluczem debug (ostrzeżenie w przebiegu).

### Uwagi

- APK lokalny (klucz debug) i z Actions (klucz release) mają różne podpisy — przy zmianie trzeba odinstalować aplikację (lokalne dane znikają).
- Limity Actions: `docs/USLUGI.md`.
- Gdyby kiedyś były potrzebne aktualizacje OTA: własny serwer zgodny z protokołem Expo Updates (`updates.url` w `app.json`), bez EAS.
