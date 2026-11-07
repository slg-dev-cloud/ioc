import { useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) setError("Too many attempts. Try again in 15 minutes.");
      else if (err instanceof ApiError && err.status === 401) setError("Incorrect password.");
      else setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen grid place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">Intelligence Operations Center</h1>
        <label className="block">
          <span className="text-sm text-neutral-600 dark:text-neutral-400">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2"
            required
          />
        </label>
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-accent px-3 py-2 text-white disabled:opacity-60"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
