import { useEffect, useState } from "react";
import { api } from "./lib/api";
import { Login } from "./pages/Login";

type Status = { db: string; pgvector?: string | null };

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    api("/api/auth/me").then(() => setAuthed(true), () => setAuthed(false));
  }, []);

  useEffect(() => {
    if (authed) api<Status>("/api/status").then(setStatus, () => setStatus(null));
  }, [authed]);

  if (authed === null) return null;
  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;

  return (
    <main className="mx-auto max-w-2xl px-4 py-12 space-y-4">
      <h1 className="text-xl font-semibold">Intelligence Operations Center</h1>
      <p className="text-neutral-600 dark:text-neutral-400">
        Signed in. The Today, Briefs, Finding, Sources, and Settings pages arrive in milestone M7.
      </p>
      <p className="text-sm">Database: {status?.db ?? "…"} · pgvector: {status?.pgvector ?? "…"}</p>
      <button
        className="text-sm text-accent underline"
        onClick={() => api("/api/auth/logout", { method: "POST" }).then(() => setAuthed(false))}
      >
        Sign out
      </button>
    </main>
  );
}
