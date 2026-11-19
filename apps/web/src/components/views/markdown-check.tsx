"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useState } from "react";

import { descriptionExtensions, descriptionMarkdown } from "@/lib/editor";

import fixture from "../../../../../fixtures/markdown.json";

import { afterPaint } from "./perf";

interface Result {
  exact: number;
  stable: number;
  failures: { input: string; output: string; second: string }[];
  ms: number;
}

const normalize = (md: string) => md.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();

/**
 * TipTap + @tiptap/markdown: każdy opis wczytany do edytora i zapisany z powrotem. „Bez zmian” =
 * ten sam tekst; „stabilne” = drugi przebieg daje to samo co pierwszy (inny zapis tej samej treści).
 */
export function MarkdownCheck({ onRendered }: { onRendered: (ms: number | null) => void }) {
  const editor = useEditor({
    extensions: descriptionExtensions,
    content: "",
    immediatelyRender: false,
  });
  const [result, setResult] = useState<Result | null>(null);
  const [sample, setSample] = useState(0);

  useEffect(() => {
    if (!editor) return;
    const start = performance.now();
    const failures: Result["failures"] = [];
    let exact = 0;
    let stable = 0;
    for (const input of fixture.samples) {
      editor.commands.setContent(input, { contentType: "markdown" });
      const output = descriptionMarkdown(editor);
      editor.commands.setContent(output, { contentType: "markdown" });
      const second = descriptionMarkdown(editor);
      if (normalize(output) === normalize(input)) exact++;
      else failures.push({ input, output, second });
      if (normalize(second) === normalize(output)) stable++;
    }
    editor.commands.setContent(fixture.samples[0]!, { contentType: "markdown" });
    const ms = performance.now() - start;
    afterPaint(() => {
      setResult({ exact, stable, failures, ms });
      onRendered(null);
    });
  }, [editor, onRendered]);

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p data-testid="markdown-result">
        {result
          ? `Bez zmian: ${result.exact}/${fixture.samples.length} · stabilne po drugim przebiegu: ${result.stable}/${fixture.samples.length} · ${result.ms.toFixed(0)} ms`
          : "liczę…"}
      </p>
      <div className="flex items-center gap-2 text-xs">
        <label>
          Opis nr{" "}
          <input
            type="number"
            min={0}
            max={fixture.samples.length - 1}
            value={sample}
            onChange={(e) => {
              const n = Number(e.target.value);
              setSample(n);
              editor?.commands.setContent(fixture.samples[n] ?? "", { contentType: "markdown" });
            }}
            className="w-16 rounded border px-1"
          />
        </label>
      </div>
      <div className="prose-sm rounded border border-[var(--line)] bg-[var(--surface)] p-3 [&_.tiptap]:outline-none [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:border-l-4 [&_blockquote]:pl-3 [&_pre]:bg-black/10 [&_pre]:p-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_a]:underline [&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0 [&_li[data-type=taskItem]]:flex [&_li[data-type=taskItem]]:gap-2">
        <EditorContent editor={editor} />
      </div>
      {result && result.failures.length > 0 && (
        <details data-testid="markdown-failures">
          <summary>Różnice ({result.failures.length})</summary>
          <ul className="flex flex-col gap-2 text-xs">
            {result.failures.slice(0, 30).map((f, i) => (
              <li key={i} className="grid grid-cols-2 gap-2">
                <pre className="whitespace-pre-wrap rounded bg-black/5 p-1">{f.input}</pre>
                <pre className="whitespace-pre-wrap rounded bg-red-500/10 p-1">{f.output}</pre>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
