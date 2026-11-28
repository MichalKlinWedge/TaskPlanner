"use client";

/**
 * Współdzielenie przestrzeni (v1.x): panel „Osoby” w karcie przestrzeni (`SharingPanel`) i zaproszenia
 * do zalogowanego (`ScopeInvites` — pasek pod nagłówkiem, także przyjęcie z linku `/?invite=` i zgoda na
 * rolę właściciela). Rolę właściciela proponuje się członkowi; działa dopiero po jego potwierdzeniu.
 * Dane na serwerze (RPC z `lib/sharing.ts`) — wymaga sieci; po przyjęciu albo opuszczeniu przestrzeni
 * `store.sync()` pobiera (albo usuwa z urządzenia) jej dane.
 */
import {
  canManageMember,
  GUEST_ACCESS,
  GUEST_ACCESS_HINT,
  GUEST_ACCESS_NOTE,
  inviteLink,
  memberRoleLabel,
  memberSince,
  OWNER_AFTER,
  OWNER_OFFER_NOTE,
  ownerOfferQuestion,
  ownerResignQuestion,
  ownershipAcceptQuestion,
  ownershipHeirs,
  ownershipOfferText,
  plural,
  SCOPE_ROLE,
  SCOPE_ROLE_HINT,
  shareEmail,
  WORKSPACE_SHARE_NOTE,
  type GuestAccess,
  type OwnerAfter,
  type OwnershipOffer,
  type ScopeRole,
  type ShareRole,
  type SpaceMember,
} from "@taskplanner/core";
import type { TabStore } from "@taskplanner/sync";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import {
  acceptInvite,
  acceptLinkInvite,
  answerOwnershipOffer,
  cancelOwnershipOffer,
  declineInvite,
  myInvites,
  myOwnershipOffers,
  offerOwnership,
  removeMember,
  resignOwner,
  revokeInvite,
  setMemberRole,
  shareWorkspace,
  workspaceSharing,
  type MyInvite,
  type PendingInvite,
  type PendingOwnerOffer,
  type WorkspaceSharing,
} from "@/lib/sharing";

import { Button, Input, Notice, Select } from "./ui";

const ROLES: ShareRole[] = ["editor", "viewer"];
const AFTER: OwnerAfter[] = ["editor", "viewer", "leave"];
const ACCESS: GuestAccess[] = ["edit", "view", "hidden"];
const date = (iso: string) => new Date(iso).toLocaleDateString("pl-PL", { dateStyle: "medium" });
const offlineText = "Udostępnianie wymaga połączenia z internetem.";
const message = (e: unknown) => (typeof navigator !== "undefined" && !navigator.onLine ? offlineText : e instanceof Error ? e.message : String(e));

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    window.prompt("Skopiuj link zaproszenia:", text);
    return false;
  }
}

/**
 * Członkowie przestrzeni, zaproszenia (właściciel) i „Opuść przestrzeń” (pozostali). `lists` (tylko
 * właściciel) — dostęp gości do każdej listy; zapis lokalny, działa też offline.
 */
export function SharingPanel({
  store,
  workspaceId,
  workspaceName,
  lists,
}: {
  store: TabStore;
  workspaceId: string;
  workspaceName: string;
  lists?: { id: string; name: string; guestAccess: GuestAccess }[];
}) {
  const [sharing, setSharing] = useState<WorkspaceSharing | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ShareRole>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSharing(await workspaceSharing(workspaceId));
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, [workspaceId]);

  useEffect(() => {
    void Promise.resolve().then(load);
    // Zgoda drugiej osoby zmienia role poza tym oknem — odśwież po powrocie do karty.
    const refresh = () => void load();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load]);

  const act = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await work();
      if (done) setInfo(done);
    } catch (e) {
      setError(message(e));
    }
    await load();
    setBusy(false);
  };

  const normalized = shareEmail(email);
  const owner = sharing?.role === "owner";
  const me = sharing?.members.find((m) => m.me);
  const offers = sharing?.offers ?? [];

  const propose = (member: SpaceMember, after: OwnerAfter | null) => {
    if (!window.confirm(ownerOfferQuestion(member.email, workspaceName, after))) return;
    void act(
      () => offerOwnership(workspaceId, member.userId, after),
      `Propozycja dla ${member.email} czeka w aplikacji tej osoby — ${after ? "przestrzeń przejdzie na nią" : "rola właściciela zacznie działać"} po jej potwierdzeniu.`,
    );
  };

  const changeRole = (member: SpaceMember, next: ScopeRole) => {
    if (next === member.role) return;
    if (next === "owner") return propose(member, null);
    if (member.role === "owner" && !window.confirm(`Odebrać ${member.email} rolę właściciela przestrzeni „${workspaceName}”? Ta osoba zostanie z rolą ${SCOPE_ROLE[next]}.`)) return;
    void act(() => setMemberRole(workspaceId, member.userId, next));
  };

  const resign = (after: OwnerAfter) => {
    if (!window.confirm(ownerResignQuestion(workspaceName, after))) return;
    void act(async () => {
      await store.sync().catch(() => undefined); // zmiany zapisane jeszcze jako właściciel
      await resignOwner(workspaceId, after);
      await store.sync().catch(() => undefined);
    });
  };

  const invite = (event: FormEvent) => {
    event.preventDefault();
    if (!normalized) return;
    void act(async () => {
      const { token } = await shareWorkspace(workspaceId, normalized, role);
      setEmail("");
      const copied = await copy(inviteLink(window.location.origin, token));
      setInfo(`Zaproszenie dla ${normalized} czeka w aplikacji tej osoby${copied ? " — link skopiowany do schowka, możesz go też wysłać" : ""}.`);
    });
  };

  const setAccess = (listId: string, guestAccess: GuestAccess) =>
    store.mutate("lists", listId, { guest_access: guestAccess }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  const leave = () => {
    if (!window.confirm(`Opuścić przestrzeń „${workspaceName}”? Jej zadania znikną z Twoich urządzeń; wrócisz tylko z nowym zaproszeniem.`)) return;
    void act(async () => {
      if (me) await removeMember(workspaceId, me.userId);
      await store.sync().catch(() => undefined);
    });
  };

  return (
    <div className="mt-3 rounded-md border border-[var(--line)] p-3 text-sm" data-testid="sharing-panel">
      {owner ? <p className="mb-3 text-xs opacity-70">{WORKSPACE_SHARE_NOTE}</p> : null}
      {owner ? (
        <form onSubmit={invite} className="mb-1 flex flex-wrap items-center gap-2">
          <Input
            aria-label="Adres e-mail osoby zapraszanej"
            placeholder="adres@example.com"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
            className="min-w-48 flex-1"
          />
          <Select aria-label="Rola" value={role} onChange={(e) => setRole(e.target.value as ShareRole)} className="w-36">
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {SCOPE_ROLE[r]}
              </option>
            ))}
          </Select>
          <Button kind="primary" type="submit" disabled={busy || !normalized}>
            Zaproś
          </Button>
        </form>
      ) : null}
      {owner ? <p className="mb-3 text-xs opacity-60">{SCOPE_ROLE[role]} — {SCOPE_ROLE_HINT[role]}.</p> : null}
      {sharing ? (
        <ul className="divide-y divide-[var(--line)]">
          {sharing.members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1 truncate">
                {m.email}
                {m.me ? <span className="ml-1 opacity-60">(Ty)</span> : null}
                {memberSince(m.joinedAt) ? <span className="ml-2 text-xs opacity-60">{memberSince(m.joinedAt)}</span> : null}
              </span>
              {canManageMember(me, m) ? (
                <>
                  <Select
                    aria-label={`Rola ${m.email}`}
                    value={m.role}
                    disabled={busy}
                    onChange={(e) => changeRole(m, e.target.value as ScopeRole)}
                    className="w-32"
                  >
                    <option value="owner">{m.role === "owner" ? SCOPE_ROLE.owner : `${SCOPE_ROLE.owner}…`}</option>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {SCOPE_ROLE[r]}
                      </option>
                    ))}
                  </Select>
                  <Button
                    kind="ghost"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Usunąć ${m.email} z przestrzeni „${workspaceName}”? Jej dane znikną z urządzeń tej osoby.`)) void act(() => removeMember(workspaceId, m.userId));
                    }}
                  >
                    Usuń
                  </Button>
                </>
              ) : (
                <span className="rounded bg-[var(--hover)] px-2 py-0.5 text-xs">{memberRoleLabel(m, sharing.members)}</span>
              )}
            </li>
          ))}
          {offers.map((o) => (
            <OfferRow key={o.id} offer={o} canCancel={owner && (o.mine || !!me?.primary)} busy={busy} onCancel={() => void act(() => cancelOwnershipOffer(o.id), "Propozycja wycofana.")} />
          ))}
          {sharing.invites.map((i) => (
            <InviteRow key={i.id} invite={i} busy={busy} onRevoke={() => void act(() => revokeInvite(i.id))} onCopied={setInfo} />
          ))}
        </ul>
      ) : null}
      {lists?.length ? (
        <div className="mt-3 border-t border-[var(--line)] pt-3" data-testid="list-access">
          <p className="mb-1 font-medium">Dostęp do list</p>
          <p className="mb-2 text-xs opacity-60">{GUEST_ACCESS_NOTE}</p>
          <ul className="flex flex-col gap-1">
            {lists.map((l) => (
              <li key={l.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{l.name}</span>
                <Select
                  aria-label={`Dostęp gości do listy ${l.name}`}
                  title={GUEST_ACCESS_HINT[l.guestAccess]}
                  value={l.guestAccess}
                  onChange={(e) => void setAccess(l.id, e.target.value as GuestAccess)}
                  className="w-32"
                >
                  {ACCESS.map((a) => (
                    <option key={a} value={a} title={GUEST_ACCESS_HINT[a]}>
                      {GUEST_ACCESS[a]}
                    </option>
                  ))}
                </Select>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {owner && me && sharing.members.length > 1 ? (
        <OwnershipSection
          members={sharing.members}
          primary={!!me.primary}
          busy={busy}
          onHandOver={(member, after) => propose(member, after)}
          onResign={resign}
        />
      ) : null}
      {sharing && !owner ? (
        <div className="mt-2 flex items-center gap-2">
          <span className="flex-1 text-xs opacity-70">
            Twoja rola: {SCOPE_ROLE[sharing.role]}
            {sharing.role === "viewer" ? " — możesz tylko przeglądać zadania." : "."}
          </span>
          <Button kind="ghost" disabled={busy} onClick={leave}>
            Opuść przestrzeń
          </Button>
        </div>
      ) : null}
      {info ? (
        <div className="mt-2">
          <Notice tone="ok">{info}</Notice>
        </div>
      ) : null}
      {error ? (
        <div className="mt-2">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}
    </div>
  );
}

/** Propozycja roli właściciela / przekazania, która czeka na zgodę adresata. */
function OfferRow({ offer, canCancel, busy, onCancel }: { offer: PendingOwnerOffer; canCancel: boolean; busy: boolean; onCancel: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-2 py-2" data-testid="owner-offer">
      <span className="min-w-0 flex-1">
        {offer.after ? "Przekazanie przestrzeni" : "Rola właściciela"} dla {offer.email}
        <span className="ml-2 text-xs opacity-60">
          {offer.mine ? "" : `od ${offer.offeredBy}, `}
          {offer.expired ? "propozycja wygasła" : `czeka na zgodę do ${date(offer.expiresAt)}`}
        </span>
      </span>
      {canCancel ? (
        <Button kind="ghost" disabled={busy} onClick={onCancel}>
          Wycofaj
        </Button>
      ) : null}
    </li>
  );
}

/** Zrzeczenie się roli właściciela: przekazanie wybranej osobie (za jej zgodą), a współwłaściciel także bez następcy. */
function OwnershipSection({
  members,
  primary,
  busy,
  onHandOver,
  onResign,
}: {
  members: SpaceMember[];
  primary: boolean;
  busy: boolean;
  onHandOver: (member: SpaceMember, after: OwnerAfter) => void;
  onResign: (after: OwnerAfter) => void;
}) {
  const [heirId, setHeirId] = useState("");
  const [after, setAfter] = useState<OwnerAfter>("editor");
  const heirs = ownershipHeirs(members);
  const heir = heirs.find((m) => m.userId === heirId);
  return (
    <div className="mt-3 border-t border-[var(--line)] pt-3" data-testid="ownership">
      <p className="mb-1 font-medium">Zrzeczenie się roli właściciela</p>
      <p className="mb-2 text-xs opacity-60">
        {primary
          ? "Przestrzeń przejmie wybrana osoba — ze wszystkimi Twoimi uprawnieniami, gdy potwierdzi przejęcie."
          : "Możesz zrezygnować z roli (zostaje główny właściciel) albo przekazać ją innej osobie — gdy ją przyjmie."}{" "}
        {OWNER_OFFER_NOTE}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs">
          Przejmuje
          <Select value={heir ? heirId : ""} onChange={(e) => setHeirId(e.target.value)} disabled={busy}>
            <option value="">{primary ? "wybierz osobę" : "bez następcy"}</option>
            {heirs.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.email} ({memberRoleLabel(m, members).toLowerCase()})
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Twoja rola potem
          <Select value={after} onChange={(e) => setAfter(e.target.value as OwnerAfter)} disabled={busy} className="w-44">
            {AFTER.map((a) => (
              <option key={a} value={a}>
                {OWNER_AFTER[a]}
              </option>
            ))}
          </Select>
        </label>
        <Button disabled={busy || (primary && !heir)} onClick={() => (heir ? onHandOver(heir, after) : onResign(after))}>
          {heir || primary ? "Przekaż przestrzeń…" : "Zrzeknij się roli…"}
        </Button>
      </div>
    </div>
  );
}

function InviteRow({ invite, busy, onRevoke, onCopied }: { invite: PendingInvite; busy: boolean; onRevoke: () => void; onCopied: (text: string) => void }) {
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <span className="min-w-0 flex-1 truncate">
        {invite.email}
        <span className="ml-2 text-xs opacity-60">
          {invite.expired ? "zaproszenie wygasło" : `zaproszono ${date(invite.createdAt)}, ważne do ${date(invite.expiresAt)}`}
        </span>
      </span>
      <span className="rounded bg-[var(--hover)] px-2 py-0.5 text-xs">{SCOPE_ROLE[invite.role]}</span>
      {!invite.expired ? (
        <Button
          kind="ghost"
          disabled={busy}
          onClick={() => void copy(inviteLink(window.location.origin, invite.token)).then((ok) => ok && onCopied(`Link dla ${invite.email} skopiowany do schowka.`))}
        >
          Kopiuj link
        </Button>
      ) : null}
      <Button kind="ghost" disabled={busy} onClick={() => window.confirm(`Unieważnić zaproszenie dla ${invite.email}? Wysłany link przestanie działać.`) && onRevoke()}>
        Unieważnij
      </Button>
    </li>
  );
}

/** Zaproszenia i propozycje własności do zalogowanego: przyjęcie z linku po zalogowaniu i lista do przyjęcia / odrzucenia. */
export function ScopeInvites({ store }: { store: TabStore }) {
  const [invites, setInvites] = useState<MyInvite[]>([]);
  const [offers, setOffers] = useState<OwnershipOffer[]>([]);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextInvites, nextOffers] = await Promise.all([myInvites(), myOwnershipOffers()]);
      setInvites(nextInvites);
      setOffers(nextOffers);
    } catch {
      // Offline albo chwilowy błąd — lista wróci przy następnej próbie.
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        if (await acceptLinkInvite()) {
          if (alive) setInfo("Dołączono do udostępnionej przestrzeni — jej zadania pobierają się teraz na to urządzenie.");
          await store.sync().catch(() => undefined);
        }
      } catch (e) {
        if (alive) setError(`Nie udało się przyjąć zaproszenia z linku: ${message(e)}`);
      }
      if (alive) await load();
    })();
    const refresh = () => void load();
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [load, store]);

  const respond = async (invite: MyInvite, accept: boolean) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (accept) {
        await acceptInvite({ id: invite.id });
        setInfo(`Dołączono do przestrzeni „${invite.workspace}” — jej zadania pobierają się teraz na to urządzenie.`);
        await store.sync().catch(() => undefined);
      } else {
        await declineInvite(invite.id);
      }
    } catch (e) {
      setError(message(e));
    }
    await load();
    setBusy(false);
  };

  const answer = async (offer: OwnershipOffer, accept: boolean) => {
    if (accept && !window.confirm(`Potwierdź przejęcie. ${ownershipAcceptQuestion(offer)}`)) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await answerOwnershipOffer(offer.id, accept);
      if (accept) {
        setInfo(`Jesteś teraz właścicielem przestrzeni „${offer.workspace}”.`);
        await store.sync().catch(() => undefined);
      }
    } catch (e) {
      setError(message(e));
    }
    await load();
    setBusy(false);
  };

  if (!invites.length && !offers.length && !info && !error) return null;
  return (
    <section aria-label="Zaproszenia do przestrzeni" className="border-b border-[var(--line)] bg-[var(--surface)] px-4 py-2 text-sm" data-testid="scope-invites">
      {invites.length ? (
        <p className="mb-1 font-medium">{plural(invites.length, ["Zaproszenie do przestrzeni", "Zaproszenia do przestrzeni", "Zaproszeń do przestrzeni"])}</p>
      ) : null}
      <ul className="flex flex-col gap-1">
        {invites.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1">
              <strong>„{i.workspace}”</strong>
              {i.invitedBy ? ` od ${i.invitedBy}` : ""} — rola: {SCOPE_ROLE[i.role].toLowerCase()} ({SCOPE_ROLE_HINT[i.role]})
            </span>
            <Button kind="primary" disabled={busy} onClick={() => void respond(i, true)}>
              Przyjmij
            </Button>
            <Button kind="ghost" disabled={busy} onClick={() => window.confirm(`Odrzucić zaproszenie do „${i.workspace}”? Żeby dołączyć później, potrzebne będzie nowe zaproszenie.`) && void respond(i, false)}>
              Odrzuć
            </Button>
          </li>
        ))}
        {offers.map((o) => (
          <li key={o.id} className="flex flex-wrap items-center gap-2" data-testid="ownership-offer">
            <span className="min-w-0 flex-1">{ownershipOfferText(o)}</span>
            <Button kind="primary" disabled={busy} onClick={() => void answer(o, true)}>
              {o.after ? "Przejmij…" : "Przyjmij…"}
            </Button>
            <Button kind="ghost" disabled={busy} onClick={() => void answer(o, false)}>
              Odmów
            </Button>
          </li>
        ))}
      </ul>
      {info ? (
        <div className="mt-1 flex items-center gap-2">
          <div className="flex-1">
            <Notice tone="ok">{info}</Notice>
          </div>
          <Button kind="ghost" onClick={() => setInfo(null)} aria-label="Zamknij">
            ✕
          </Button>
        </div>
      ) : null}
      {error ? (
        <div className="mt-1 flex items-center gap-2">
          <div className="flex-1">
            <Notice tone="error">{error}</Notice>
          </div>
          <Button kind="ghost" onClick={() => setError(null)} aria-label="Zamknij">
            ✕
          </Button>
        </div>
      ) : null}
    </section>
  );
}
