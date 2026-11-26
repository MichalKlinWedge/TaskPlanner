"use client";

/** Opis zadania (Markdown) tylko do odczytu — podgląd w edytorze opisu i w podglądzie zadania. */
import { TaskItem } from "@tiptap/extension-list";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useRef } from "react";

import { descriptionExtensions, descriptionMarkdown } from "@/lib/editor";

const PREVIEW_CLASS =
  "text-sm [&_.tiptap]:outline-none [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:border-l-4 [&_blockquote]:pl-3 [&_pre]:bg-black/10 [&_pre]:p-2 [&_code]:rounded [&_code]:bg-black/10 [&_code]:px-1 [&_h1]:mt-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-2 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-1 [&_h3]:font-semibold [&_a]:text-[var(--accent)] [&_a]:underline [&_hr]:my-2 [&_hr]:border-[var(--line)] [&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0 [&_ul[data-type=taskList]_li]:flex [&_ul[data-type=taskList]_li]:items-start [&_ul[data-type=taskList]_li]:gap-2 [&_ul[data-type=taskList]_label]:mt-1.5 [&_ul[data-type=taskList]_p]:my-0.5 [&_li[data-checked=true]>div]:text-[var(--muted)] [&_li[data-checked=true]>div]:line-through [&_table]:my-2 [&_table]:border-collapse [&_td]:border [&_td]:border-[var(--line)] [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-[var(--line)] [&_th]:bg-[var(--hover)] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_td_p]:my-0 [&_th_p]:my-0";

/** Pola list zadań klikalne mimo trybu tylko do odczytu: zmianę zapisuje `onToggleCheckbox`, nie TipTap. */
const checkableExtensions = [...descriptionExtensions.filter((e) => e.name !== "taskItem"), TaskItem.configure({ nested: true, onReadOnlyChecked: () => true })];

/**
 * Markdown opisu wyrenderowany przez TipTap tylko do odczytu (ten sam GFM co wcześniej w edytorze).
 * `onToggleCheckbox(index, total)` — kliknięte pole listy zadań (kolejne w podglądzie, z `total` wszystkich);
 * `false` = nie zapisano, pole wraca do poprzedniego stanu.
 */
export function MarkdownPreview({ markdown, onEdit, onToggleCheckbox }: { markdown: string; onEdit?: () => void; onToggleCheckbox?: (index: number, total: number) => boolean }) {
  const checkable = !!onToggleCheckbox;
  const toggle = useRef(onToggleCheckbox);
  useEffect(() => {
    toggle.current = onToggleCheckbox;
  });
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = box.current;
    if (!root || !checkable) return;
    // Po obsłudze TipTapa (pole już przełączone): które to pole — z kolejności w podglądzie.
    const onChange = (e: Event) => {
      const input = e.target;
      if (!(input instanceof HTMLInputElement) || input.type !== "checkbox") return;
      const all = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
      if (!toggle.current?.(all.indexOf(input), all.length)) input.checked = !input.checked;
    };
    root.addEventListener("change", onChange);
    return () => root.removeEventListener("change", onChange);
  }, [checkable]);
  const editor = useEditor({
    extensions: checkable ? checkableExtensions : descriptionExtensions,
    content: "",
    immediatelyRender: false,
    editable: false,
    editorProps: { attributes: { "aria-label": "Podgląd opisu" } },
  });
  useEffect(() => {
    if (editor && descriptionMarkdown(editor).trim() !== markdown.trim()) editor.commands.setContent(markdown, { contentType: "markdown" });
  }, [editor, markdown]);
  return (
    <div ref={box} className={PREVIEW_CLASS} onDoubleClick={onEdit} title={onEdit ? "Dwuklik — edycja Markdown" : undefined} data-testid="description-preview">
      {markdown.trim() ? <EditorContent editor={editor} /> : <p className="text-[var(--muted)]">Brak opisu.</p>}
    </div>
  );
}
