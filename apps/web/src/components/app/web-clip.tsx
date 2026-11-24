"use client";

/**
 * Wycinek strony w oknie szybkiego dodawania (v1.x): edytowalny opis (zaznaczenie jako cytat ze źródłem) i „✨ Streść”
 * — propozycja tytułu i punktów od AI na koncie użytkownika. Przycisk widać tylko przy sprawdzonym koncie AI i gdy
 * jest co streszczać; bez sieci jest nieaktywny. Wynik tylko wypełnia pola (core `applyClipSummary`), zapisuje Enter.
 */
import {
  AI_CLIP,
  AI_NEEDS_NETWORK,
  aiAccountReady,
  aiClipNote,
  applyClipSummary,
  CLIP_DESCRIPTION_MAX,
  clipRequest,
  WEB_CLIP,
  type ClipFields,
  type WebClip,
} from "@taskplanner/core";
import { useEffect, useRef, useState } from "react";

import { askClip, useAiAccount } from "@/lib/ai";
import { useOnline } from "@/lib/use-online";

import { useAppEnv } from "./app-env";
import { Button, inputClass, Notice } from "./ui";

export interface ClipFieldsetProps {
  clip: WebClip;
  /** Tytuł wstawiony z zakładki — nieruszony może zastąpić propozycja AI. */
  initialTitle: string;
  title: string;
  setTitle: (value: string) => void;
  description: string;
  setDescription: (value: string) => void;
  focusTitle: () => void;
  add: () => void;
}

export function ClipFieldset({ clip, initialTitle, title, setTitle, description, setDescription, focusTitle, add }: ClipFieldsetProps) {
  return (
    <div className="mt-3 flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
        {WEB_CLIP.description}
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            // Escape wraca do tytułu (nie gubi opisu); Enter w opisie to nowa linia.
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            focusTitle();
          }}
          maxLength={CLIP_DESCRIPTION_MAX}
          placeholder={WEB_CLIP.placeholder}
          className={`${inputClass} max-h-64 min-h-24 w-full resize-y font-mono text-[13px] leading-relaxed text-[var(--foreground)] [field-sizing:content]`}
        />
      </label>
      <p className="text-xs text-[var(--muted)]">{clip.selection ? WEB_CLIP.quoted : WEB_CLIP.page}</p>
      <ClipSummary clip={clip} initialTitle={initialTitle} title={title} setTitle={setTitle} description={description} setDescription={setDescription} />
      <div className="flex justify-end">
        <Button kind="primary" disabled={!title.trim()} onClick={add}>
          {WEB_CLIP.add}
        </Button>
      </div>
    </div>
  );
}

function ClipSummary({ clip, initialTitle, title, setTitle, description, setDescription }: Omit<ClipFieldsetProps, "focusTitle" | "add">) {
  const { store } = useAppEnv();
  const account = useAiAccount(store);
  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<string | null>(null);
  // Ostatnia propozycja i stan pól sprzed niego („Cofnij streszczenie”).
  const [applied, setApplied] = useState<{ title: string; points: string; before: ClipFields } | null>(null);
  // Odpowiedź przychodzi po chwili — trafia do pól takich, jakie są wtedy.
  const fields = useRef<ClipFields>({ title, description });
  useEffect(() => {
    fields.current = { title, description };
  });

  const request = aiAccountReady(account) ? clipRequest(clip, account.id) : null;
  if (!request || !aiAccountReady(account)) return null;

  const ask = async () => {
    if (busy || !online) return;
    setBusy(true);
    setError(null);
    setProposal(null);
    try {
      const answer = await askClip(request);
      const before = fields.current;
      const next = applyClipSummary(answer, before, { clip, initialTitle, previous: applied });
      setTitle(next.title);
      setDescription(next.description);
      setProposal(next.proposal);
      setApplied({ title: next.suggested, points: next.points, before: applied?.before ?? before });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const undo = () => {
    if (!applied) return;
    setTitle(applied.before.title);
    setDescription(applied.before.description);
    setApplied(null);
    setProposal(null);
  };

  return (
    <section aria-label="Streszczenie AI" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy || !online} title={online ? undefined : AI_NEEDS_NETWORK} onClick={() => void ask()}>
          {busy ? AI_CLIP.busy : applied ? AI_CLIP.again : AI_CLIP.button}
        </Button>
        {applied ? (
          <Button kind="ghost" disabled={busy} onClick={undo}>
            {AI_CLIP.undo}
          </Button>
        ) : null}
      </div>
      {proposal ? (
        <p className="flex flex-wrap items-center gap-2 text-xs">
          <span>
            {AI_CLIP.proposal} <strong className="font-medium">{proposal}</strong>
          </span>
          <Button
            kind="ghost"
            className="px-2 py-0.5 text-xs"
            onClick={() => {
              setTitle(proposal);
              setProposal(null);
            }}
          >
            {AI_CLIP.use}
          </Button>
        </p>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className="text-xs text-[var(--muted)]">{aiClipNote(account.provider, clip.selection !== "")}</p>
    </section>
  );
}
