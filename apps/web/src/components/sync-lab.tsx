"use client";

import { inboxId, uuidv7 } from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useState } from "react";

import { closeStore, storeFor, useStoreStatus } from "@/lib/local-store";
import { supabaseBrowser } from "@/lib/supabase-browser";

interface TaskRow extends Record<string, string | number | null> {
  id: string;
  title: string;
  status: string;
}

/** PoC-1: lokalna baza w przeglądarce, lider kart i synchronizacja — strona do ręcznych prób. */
export function SyncLab() {
  const [session, setSession] = useState<Session | null>(null);
  const [leader, setLeader] = useState(false);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { storage, error: storeError } = useStoreStatus();

  useEffect(() => {
    const supabase = supabaseBrowser();
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  // Jedna koordynacja kart na zalogowanego użytkownika i stronę (podwójne efekty Strict Mode jej
  // nie zamykają); zamykana przy wylogowaniu, blokadę lidera zwalnia też zamknięcie karty.
  const userId = session?.user.id;
  const store = useMemo<TabStore | null>(() => (userId ? storeFor(userId) : null), [userId]);

  useEffect(() => (store ? store.onRole(setLeader) : undefined), [store]);

  const reload = useCallback(async () => {
    if (!store) return;
    setLeader(store.isLeader);
    try {
      setTasks(await store.query<TaskRow>("select id, title, status from tasks where deleted_at is null order by id desc limit 30"));
      const ws = await store.query<{ id: string }>("select id from workspaces where deleted_at is null order by id limit 1");
      setWorkspace(ws[0]?.id ?? null);
      setPending(await store.pendingCount());
    } catch (e) {
      setError(String(e));
    }
  }, [store]);

  useEffect(() => {
    if (!store) return;
    // Pierwsze wczytanie jak każde następne: z wywołania zwrotnego, nie synchronicznie w efekcie.
    void Promise.resolve().then(reload);
    return store.watch(["tasks", "workspaces", "lists"], () => void reload());
  }, [store, reload]);

  if (!session) return <Login />;

  const addTask = async (title: string) => {
    if (!store || !title.trim()) return;
    let ws = workspace;
    if (!ws) {
      ws = uuidv7();
      await store.mutate("workspaces", ws, { name: "Osobiste" });
      await store.mutate("lists", inboxId(ws), { scope_id: ws, kind: "inbox", name: "Inbox" });
    }
    await store.mutate("tasks", uuidv7(), { list_id: inboxId(ws), title: title.trim() });
  };

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-4 p-8 text-sm">
      <h1 className="text-xl font-semibold">PoC-1: synchronizacja</h1>
      <dl className="grid grid-cols-2 gap-1" data-testid="status">
        <dt>Karta</dt>
        <dd data-testid="role">{leader ? "lider" : "zwykła"}</dd>
        <dt>Baza</dt>
        <dd>{leader ? storage : "w karcie-liderze"}</dd>
        <dt>Czeka na wysłanie</dt>
        <dd data-testid="pending">{pending}</dd>
        <dt>Użytkownik</dt>
        <dd>{session.user.email}</dd>
      </dl>
      {(error ?? storeError) && <p className="text-red-600">{error ?? storeError}</p>}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const input = event.currentTarget.elements.namedItem("title") as HTMLInputElement;
          void addTask(input.value).then(() => (input.value = ""));
        }}
      >
        <input name="title" placeholder="Nowe zadanie" className="flex-1 rounded border border-[var(--line)] px-2 py-1" />
        <button className="rounded bg-black px-3 py-1 text-white dark:bg-white dark:text-black">Dodaj</button>
        <button type="button" className="rounded border px-3 py-1" onClick={() => void store?.sync().then(reload)}>
          Synchronizuj
        </button>
      </form>
      <ul data-testid="tasks" className="flex flex-col gap-1">
        {tasks.map((task) => (
          <li key={task.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={task.status === "done"}
              onChange={(event) => void store?.mutate("tasks", task.id, { status: event.target.checked ? "done" : "todo" })}
            />
            <span>{task.title}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="self-start text-xs underline"
        onClick={() => {
          closeStore();
          void supabaseBrowser().auth.signOut();
        }}
      >
        Wyloguj
      </button>
    </main>
  );
}

export function Login() {
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="mx-auto flex w-full max-w-xs flex-col gap-2 p-8 text-sm"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const { error: failed } = await supabaseBrowser().auth.signInWithPassword({
          email: String(form.get("email")),
          password: String(form.get("password")),
        });
        setError(failed?.message ?? null);
      }}
    >
      <h1 className="text-lg font-semibold">Logowanie (lokalny Supabase)</h1>
      <input name="email" type="email" placeholder="e-mail" className="rounded border px-2 py-1" />
      <input name="password" type="password" placeholder="hasło" className="rounded border px-2 py-1" />
      <button className="rounded bg-black px-3 py-1 text-white dark:bg-white dark:text-black">Zaloguj</button>
      {error && <p className="text-red-600">{error}</p>}
    </form>
  );
}
