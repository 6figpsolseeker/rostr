"use client";

import { useState } from "react";
import useSWR from "swr";

/**
 * The commissioner's invite box.
 *
 * One field, two kinds of answer: a username or a wallet address, and the
 * server decides which by the shape of what was typed. Asking a commissioner to
 * classify what they are pasting is a question with an obvious answer that only
 * they can get wrong.
 *
 * **This does not add anybody to anything.** An invitation records that somebody
 * was asked; joining still runs every check it always did, and the invitee still
 * reads the whole rule set and signs its hash from their own wallet. The copy
 * says so, because a control called "invite" in most products means "add".
 */

interface Member {
  teamId: string;
  teamName: string;
  username: string | null;
  isBot: boolean;
  isCommissioner: boolean;
}

interface Invitation {
  id: string;
  username: string | null;
  addressedAs: "USERNAME" | "WALLET";
  createdAt: string;
  withdrawn: boolean;
  accepted: boolean;
}

const fetcher = async (
  url: string,
): Promise<{ members: Member[]; invitations: Invitation[] }> => {
  const response = await fetch(url);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<{ members: Member[]; invitations: Invitation[] }>;
};

export function InvitePanel({ leagueId }: { leagueId: string }) {
  const { data, error, mutate } = useSWR(`/api/leagues/${leagueId}/invites`, fetcher, {
    revalidateOnFocus: true,
  });

  const [identifier, setIdentifier] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  async function invite(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    setSent(null);

    try {
      const response = await fetch(`/api/leagues/${leagueId}/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not send that invitation");

      setSent(identifier.trim());
      setIdentifier("");
      await mutate();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Remove somebody who is already seated.
   *
   * Confirmed first, because it is the one control here that destroys something
   * — an invitation can be re-sent, a seat cannot be un-removed once the field
   * locks. The server refuses after the draw or the scheduled time regardless;
   * this is the courtesy, and `removeMember` is the rule.
   */
  async function remove(member: Member): Promise<void> {
    const who = member.username ?? member.teamName;
    if (
      !window.confirm(`Remove ${who} from the league? They would have to be invited again.`)
    ) {
      return;
    }

    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch(`/api/leagues/${leagueId}/members`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId: member.teamId }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not remove them");
      await mutate();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(invitationId: string): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await fetch(`/api/leagues/${leagueId}/invites`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitationId }),
      });
      await mutate();
    } finally {
      setBusy(false);
    }
  }

  // A 403 here means the viewer does not run this league, which is the ordinary
  // case for eleven of twelve members — so the panel renders nothing rather than
  // an error. Anything else is worth showing.
  if (error) return null;

  const members = data?.members ?? [];
  const invitations = data?.invitations ?? [];
  const outstanding = invitations.filter((i) => !i.withdrawn && !i.accepted);

  return (
    <section className="space-y-4 rounded-lg border border-nocturne-neutral-900 p-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Invite managers</h2>
        <p className="text-sm text-nocturne-neutral-400">
          By username or wallet address. They will see the invitation waiting for them, read the
          whole rule set, and join by signing it — being invited does not put anyone in the
          league.
        </p>
      </div>

      {/*
        The link, and what it honestly is.

        A private league's page is deliberately ungated — `RULES.md` requires the
        whole rule set to be readable before anyone joins, and an invitee is by
        definition not yet a member — so **this URL already is the invitation**,
        and has been since the league existed. The button surfaces a fact rather
        than creating a capability.

        Deliberately **not** a token. A tokenised link would look revocable and
        would not be: the plain league URL still works, because it has to. Making
        the link the only way in means gating `joinLeague` on an invitation,
        which is a different feature and a real decision — see `lib/account.ts`
        on the same question for usernames.
      */}
      <div className="space-y-2 rounded border border-nocturne-neutral-900 p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-nocturne-neutral-400">Invite link</span>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                .writeText(`${window.location.origin}/leagues/${leagueId}`)
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
            }}
            className="text-xs text-nocturne-accent-300 hover:underline"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
        <p className="text-[11px] text-nocturne-neutral-600">
          Anyone holding this link can read the rules and take a seat, so send it to people you
          mean to play with. Inviting by name below is the same thing with a record of who you
          asked.
        </p>
      </div>

      <form onSubmit={(e) => void invite(e)} className="flex flex-wrap gap-2">
        <input
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="route66 or a wallet address"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 rounded border border-nocturne-neutral-800 bg-transparent px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={busy || identifier.trim() === ""}
          className="rounded-[4px] border border-nocturne-accent px-4 py-2 text-[13.5px] text-nocturne-accent-200 transition-colors hover:bg-nocturne-accent/10 disabled:opacity-40"
        >
          {busy ? "Sending…" : "Invite"}
        </button>
      </form>

      {problem && <p className="text-sm text-red-400">{problem}</p>}
      {sent && (
        <p className="text-sm text-nocturne-accent-300">
          Invited {sent}. They will see it under Invitations.
        </p>
      )}

      {members.length > 0 && (
        <div className="space-y-2 border-t border-nocturne-neutral-900 pt-4">
          <h3 className="text-xs font-medium tracking-wide text-nocturne-neutral-500 uppercase">
            In the league
            <span className="ml-2 font-normal normal-case">{members.length}</span>
          </h3>
          <ul className="space-y-1 text-sm">
            {members.map((member) => (
              <li key={member.teamId} className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate">
                  {member.teamName}
                  {member.username && (
                    <span className="ml-2 text-xs text-nocturne-neutral-600">
                      {member.username}
                    </span>
                  )}
                </span>
                {member.isCommissioner ? (
                  <span className="shrink-0 text-xs text-nocturne-neutral-600">you</span>
                ) : member.isBot ? (
                  <span className="shrink-0 text-xs text-nocturne-neutral-600">bot</span>
                ) : (
                  <button
                    onClick={() => void remove(member)}
                    disabled={busy}
                    className="shrink-0 text-xs text-nocturne-neutral-600 hover:text-red-400 disabled:opacity-40"
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-nocturne-neutral-600">
            {/*
              Says when this stops working, before somebody discovers it. The
              field locks at the draft time and the trigger in `0028` refuses
              every removal after it — removing a team changes the field exactly
              as adding one does.
            */}
            Only until the draft order is drawn — after that the field is locked for everyone.
          </p>
        </div>
      )}

      {invitations.length > 0 && (
        <div className="space-y-2 border-t border-nocturne-neutral-900 pt-4">
          <h3 className="text-xs font-medium tracking-wide text-nocturne-neutral-500 uppercase">
            Asked
            <span className="ml-2 font-normal normal-case">{outstanding.length} waiting</span>
          </h3>
          <ul className="space-y-1 text-sm">
            {invitations.map((invitation) => (
              <li key={invitation.id} className="flex items-center gap-3">
                <span
                  className={`min-w-0 flex-1 truncate ${invitation.withdrawn ? "line-through opacity-50" : ""}`}
                >
                  {invitation.username ?? "(no username)"}
                </span>
                <span className="shrink-0 text-xs text-nocturne-neutral-600">
                  {invitation.accepted
                    ? "joined"
                    : invitation.withdrawn
                      ? "withdrawn"
                      : invitation.addressedAs === "WALLET"
                        ? "by wallet"
                        : "invited"}
                </span>
                {!invitation.accepted && !invitation.withdrawn && (
                  <button
                    onClick={() => void withdraw(invitation.id)}
                    disabled={busy}
                    className="shrink-0 text-xs text-nocturne-neutral-600 hover:text-nocturne-text disabled:opacity-40"
                  >
                    Withdraw
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
