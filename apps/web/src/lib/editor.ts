/**
 * Edytor opisu zadania (SPECYFIKACJA M5, D4): Markdown (GFM) jako format zapisu.
 * Wspólne dla edytora w MVP-2 i sprawdzenia w PoC-5.
 */
import type { Editor } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

export const descriptionExtensions = [
  StarterKit.configure({ link: { autolink: true, openOnClick: false } }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Markdown,
];

/**
 * Markdown opisu z edytora. Link, którego tekst jest jego adresem, zapisuje się goło
 * (`https://…`, GFM i tak robi z niego link) — TipTap pisze `[https://…](https://…)`, a marki
 * renderują się z zastępnikiem zamiast tekstu, więc poprawka jest na gotowym tekście.
 */
export function descriptionMarkdown(editor: Editor): string {
  return editor.getMarkdown().replace(/\[(https?:\/\/[^\]\s]+)\]\(\1\)/g, "$1");
}
