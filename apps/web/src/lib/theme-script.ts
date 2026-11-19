/**
 * Skrypt motywu do <head> (komponent serwerowy `layout.tsx`, więc osobno od hooka w `theme.ts`):
 * ta sama reguła co `applyTheme`, bez Reacta — `data-theme` jest ustawione przed pierwszym malowaniem.
 */
export const THEME_KEY = "tp-theme";

export const THEME_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=d?"dark":"light"}catch(e){}`;
