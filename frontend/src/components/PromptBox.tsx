"use client";
// Role 4: prompt input.
import { useState } from "react";

export function PromptBox({ onSubmit, busy, label = "Generate", placeholder }: {
  onSubmit: (text: string) => void; busy: boolean; label?: string; placeholder?: string;
}) {
  const [text, setText] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => { e.preventDefault(); if (text.trim()) onSubmit(text.trim()); }}
    >
      <input
        className="flex-1 rounded border border-neutral-300 bg-white px-3 py-2 text-neutral-900"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder ?? "3 bed, 2 bath, open kitchen, home office, about 1,800 sq ft"}
        disabled={busy}
      />
      <button className="rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy}>
        {busy ? "Working…" : label}
      </button>
    </form>
  );
}
