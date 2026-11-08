"use client";
// Role 4: the one screen. Prompt -> checker panel -> plan -> walk through -> edit.
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import * as api from "@/lib/api";
import type { GenerateResponse, Layout } from "@/lib/types";
import sampleLayout from "@/lib/sample-layout.json";
import { PromptBox } from "@/components/PromptBox";
import { CheckerPanel } from "@/components/CheckerPanel";
import { PlanView } from "@/components/PlanView";
import { Minimap } from "@/components/Minimap";
import type { PlayerPos } from "@/components/Walkthrough";
import { SiteControls, type SiteSettings } from "@/components/SiteControls";

const Walkthrough = dynamic(() => import("@/components/Walkthrough"), { ssr: false });
const SiteView = dynamic(() => import("@/components/SiteView"), { ssr: false });

type View = "plan" | "walk" | "site";

export default function Home() {
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("plan");
  const [site, setSite] = useState<SiteSettings>({ location: null, rotationDeg: 0, roof: "gable", flatten: true });
  const [player, setPlayer] = useState<PlayerPos | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);

  // Backend down? Fall back to the bundled sample so UI/3D work never blocks.
  const layout: Layout = result?.layout ?? (sampleLayout as Layout);

  useEffect(() => {
    api.sample().then(setResult).catch(() => setError("Backend not reachable; showing bundled sample."));
  }, []);

  async function run(fn: () => Promise<GenerateResponse>) {
    setBusy(true); setError(null);
    const t0 = performance.now();
    try {
      setResult(await fn());
      setElapsed((performance.now() - t0) / 1000);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex h-screen flex-col gap-3 bg-neutral-50 p-4 text-neutral-900">
      <header className="flex items-center gap-4">
        <h1 className="text-xl font-semibold">Walkthru</h1>
        <div className="flex-1"><PromptBox busy={busy} onSubmit={(p) => run(() => api.generate(p))} /></div>
      </header>
      {error && <div className="text-sm text-amber-700">{error}</div>}

      <div className="flex min-h-0 flex-1 gap-3">
        <section className="relative flex-1 overflow-hidden rounded border border-neutral-200 bg-white">
          {view === "site" ? (
            <SiteView layout={layout} {...site} onLocationChange={(location) => setSite((s) => ({ ...s, location }))} />
          ) : view === "walk" ? (
            <>
              <Walkthrough layout={layout} onMove={setPlayer} />
              <Minimap layout={layout} player={player} />
              <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-black/60 px-2 py-1 text-xs text-white">
                Click to look · WASD to walk · Esc to release mouse
              </div>
            </>
          ) : (
            <div className="h-full p-4"><PlanView layout={layout} /></div>
          )}
        </section>

        <aside className="flex w-80 flex-col gap-4">
          <div className="flex gap-1 rounded bg-neutral-200 p-1 text-sm">
            {([["plan", "Plan"], ["walk", "Walk through"], ["site", "Outside"]] as const).map(([v, label]) => (
              <button
                key={v}
                className={`flex-1 rounded px-3 py-1.5 ${view === v ? "bg-blue-600 text-white" : "text-neutral-700 hover:bg-white"}`}
                onClick={() => setView(v)}
              >
                {label}
              </button>
            ))}
          </div>
          {view === "site" && <SiteControls value={site} onChange={setSite} />}
          <CheckerPanel result={result} />
          {elapsed !== null && <div className="text-xs text-neutral-500">Round trip {elapsed.toFixed(1)} s</div>}
          <div className="mt-auto">
            <div className="mb-1 text-sm font-medium">Edit</div>
            <PromptBox
              busy={busy || !result}
              label="Apply"
              placeholder="make the kitchen bigger"
              onSubmit={(i) => result && run(() => api.edit(result.program, result.layout, i))}
            />
          </div>
        </aside>
      </div>
    </main>
  );
}
