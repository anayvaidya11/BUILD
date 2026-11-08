"use client";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { PlanView } from "@/components/PlanView";
import { layout, stops } from "./geometry";

const HouseScene = dynamic(() => import("./HouseScene"), { ssr: false });
const github = "https://github.com/jimmxchen/BUILD";
const study = "https://www.houzz.com/magazine/2024-u-s-houzz-and-home-study-renovation-trends-stsetivw-vs~174492310";
class SceneBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
function Model({ progress = 0 }: { progress?: number }) {
  const [failed, setFailed] = useState(false);
  const fallback = <div className="lp-plan"><PlanView layout={layout} /><span>Floor plan preview · 3D unavailable</span></div>;
  return <div className="lp-model" role="img" aria-label="Three-dimensional model of the bundled three-bedroom home">
    <div className="lp-model-underlay"><PlanView layout={layout} /></div>
    {failed ? fallback : <SceneBoundary fallback={fallback}><HouseScene progress={progress} onFailure={() => setFailed(true)} /></SceneBoundary>}
  </div>;
}
function Stat({ value, suffix, children }: { value: number; suffix: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [number, setNumber] = useState(value);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      const start = performance.now();
      const tick = (now: number) => { const t = Math.min((now - start) / 1100, 1); setNumber(value * (1 - Math.pow(1 - t, 3))); if (t < 1) frame = requestAnimationFrame(tick); };
      frame = requestAnimationFrame(tick);
    }, { threshold: 0.5 });
    if (ref.current) observer.observe(ref.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [value]);
  return <div ref={ref} className="lp-stat"><strong aria-label={`${value}${suffix}`}><span aria-hidden="true">{value % 1 ? number.toFixed(1) : Math.round(number)}{suffix}</span></strong><p>{children}</p></div>;
}
export default function Landing() {
  const journey = useRef<HTMLElement>(null);
  const [progress, setProgress] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [plan, setPlan] = useState(false);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(media.matches);
    sync(); media.addEventListener("change", sync);
    let frame = 0;
    const update = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
      if (!journey.current || media.matches) return;
      const rect = journey.current.getBoundingClientRect();
      setProgress(Math.max(0, Math.min(1, -rect.top / Math.max(1, rect.height - innerHeight))));
    }); };
    update(); addEventListener("scroll", update, { passive: true }); addEventListener("resize", update);
    return () => { media.removeEventListener("change", sync); removeEventListener("scroll", update); removeEventListener("resize", update); cancelAnimationFrame(frame); };
  }, []);
  const stage = stops[Math.min(stops.length - 1, Math.floor(progress * (stops.length - 1)))];
  return <div className="lp">
    <a className="lp-skip" href="#lp-main">Skip to content</a>
    <header className="lp-nav"><a href="#" aria-label="BUILD home"><Image src="/logo.webp" alt="BUILD" width={120} height={60} priority /></a><nav aria-label="Main navigation"><a href="#problem">The problem</a><a href="#how">How it works</a><a href="#explore">Explore</a><a href="#demo">Demo</a></nav><details className="lp-mobile-menu"><summary>Menu</summary><div><a href="#problem">The problem</a><a href="#how">How it works</a><a href="#explore">Explore</a><a href="#demo">Demo</a></div></details><Link className="lp-button" href="/">Try BUILD <span>↗</span></Link></header>
    <main id="lp-main">
      <section className="lp-hero lp-grid">
        <div className="lp-eyebrow"><span className="lp-dot" /> YOUR IDEAS. REAL DIMENSIONS.</div>
        <h1>Imagine your home.<br /><em>Then walk through it.</em></h1>
        <p className="lp-intro">Describe the place you have in mind. Turn it into a rule-checked floor plan, step inside in 3D, and make it yours.</p>
        <div className="lp-actions"><Link className="lp-button" href="/">Try BUILD <span>↗</span></Link><a className="lp-text-link" href="#explore">Explore the experience <span>↓</span></a></div>
        <div className="lp-hero-model"><div className="lp-sheet-label">BUILD / RESIDENCE 001<span>CONCEPT STUDY</span></div>{plan ? <div className="lp-flat"><PlanView layout={layout} /></div> : <Model />}<div className="lp-model-footer"><span>3 bedrooms · 2 baths · 1,708 sq ft</span><div className="lp-toggle" aria-label="Preview mode"><button aria-pressed={plan} onClick={() => setPlan(true)}>2D plan</button><button aria-pressed={!plan} onClick={() => setPlan(false)}>3D model</button></div></div></div>
        <div className="lp-caption"><span>01 / FROM AN IDEA TO A PLACE</span><span>Actual bundled BUILD layout. Furnishings are illustrative.</span></div>
      </section>
      <section id="problem" className="lp-section">
        <div className="lp-section-head"><span className="lp-eyebrow">01 / THE DISTANCE BETWEEN IDEA & HOME</span><h2>Big decisions.<br /><span>Too little perspective.</span></h2><p>Plans on paper ask you to imagine everything. Traditional design takes expertise and iteration. And a beautiful AI image can’t tell you whether the rooms actually fit.</p></div>
        <div className="lp-stats"><Stat value={9.6} suffix=" mo">Average time planning a kitchen renovation.</Stat><Stat value={39} suffix="%">Of renovating homeowners went over budget.</Stat><Stat value={91} suffix="%">Of renovating homeowners hired professionals.</Stat></div>
        <a className="lp-source" href={study} target="_blank" rel="noreferrer">2024 U.S. Houzz & Home Study · 2023 renovation activity among surveyed Houzz users ↗</a>
        <p className="lp-manifesto">You shouldn’t have to build a home<br />to understand <em>what it feels like.</em></p>
      </section>
      <section id="how" className="lp-section lp-how">
        <div className="lp-section-head"><span className="lp-eyebrow">02 / LESS GUESSWORK. MORE POSSIBILITY.</span><h2>A conversation.<br />A plan. <span>A place.</span></h2></div>
        <div className="lp-steps"><article><span className="lp-step-number">01</span><h3>Describe</h3><p>Start with how you want to live. BUILD interprets the rooms, relationships and space you need.</p><div className="lp-prompt">“A 3-bedroom home with an open kitchen, an office, and about 1,800 square feet.”<span>YOUR BRIEF <b>↗</b></span></div></article><article><span className="lp-step-number">02</span><h3>Generate</h3><p>AI plans the rooms. A deterministic solver places them. The checker tests the geometry.</p><div className="lp-mini-plan"><PlanView layout={layout} /></div></article><article><span className="lp-step-number">03</span><h3>Explore & refine</h3><p>Walk through at human scale. Ask for a change and explore the updated design.</p><div className="lp-edit"><span>“Make the kitchen bigger.”</span><div>ONE MODEL <i>→</i> 2D + 3D</div></div></article></div>
      </section>
      <section id="explore" ref={journey} className={`lp-journey ${reduced ? "lp-reduced" : ""}`}>
        <div className="lp-sticky lp-grid"><div className="lp-tour-heading"><span className="lp-eyebrow">03 / A DIFFERENT PERSPECTIVE</span><h2>Go from looking.<br /><em>To being there.</em></h2><p>{reduced ? "Choose a viewpoint to explore the sample home." : "Scroll to step inside a real BUILD floor plan."}</p></div><Model progress={progress} /><div className="lp-tour-note"><span>{String(Math.floor(progress * 7) + 1).padStart(2, "0")} / 08</span><h3>{stage.label}</h3><p>{stage.detail}</p></div><div className="lp-tour-controls"><label htmlFor="tour-progress">Explore the house</label><input id="tour-progress" type="range" min="0" max="1" step="0.001" value={progress} onChange={e => {
          const value = Number(e.target.value); setProgress(value);
          if (!reduced && journey.current) window.scrollTo({ top: journey.current.offsetTop + value * (journey.current.offsetHeight - innerHeight), behavior: "instant" });
        }} /><a href="#technology">Continue to how it works ↓</a></div></div>
      </section>
      <section id="technology" className="lp-section lp-tech"><div className="lp-section-head"><span className="lp-eyebrow">04 / IMAGINATION, WITH A FOUNDATION</span><h2>Creative intelligence.<br /><span>Concrete geometry.</span></h2><p>Language models understand your ideas. Exact geometry needs a different kind of thinking. BUILD brings both together.</p></div><ol className="lp-pipeline">{["Your brief", "AI room planner", "Geometry solver", "Rule checker", "Shared model", "2D + 3D"].map((s, i) => <li key={s}><small>0{i + 1}</small>{s}<span aria-hidden="true">→</span></li>)}</ol><div className="lp-tech-bottom"><p>Failed checks feed back into repair attempts. Natural-language edits change the underlying design, so your plan and walkthrough stay connected.</p><ul><li>Non-overlapping rooms</li><li>Reachable doorways</li><li>Room size constraints</li></ul></div><p className="lp-source">Concept design and supported layout checks. Not building-code certification or construction documents.</p></section>
      <section id="demo" className="lp-section lp-demo"><div><span className="lp-eyebrow">05 / YOUR NEXT CHAPTER</span><h2>Don’t just imagine it.<br /><em>Step inside.</em></h2><p>Open the BUILD application to describe your home, generate a plan, explore it and refine it through conversation.</p><div className="lp-actions"><Link className="lp-button" href="/">Launch BUILD <span>↗</span></Link><a href={github} className="lp-text-link">View GitHub ↗</a></div></div><div className="lp-demo-plan"><div className="lp-sheet-label">BUILD / PRODUCT PREVIEW<span>BUNDLED SAMPLE</span></div><PlanView layout={layout} /><span className="lp-valid">✓ {layout.checks.filter(c => c.pass).length} sample layout checks passed</span></div></section>
    </main><footer className="lp-footer"><Image src="/logo.webp" alt="BUILD" width={100} height={50} /><p>A little closer to the place you imagine.</p><Link href="/">Open the app ↗</Link><a href={github}>GitHub ↗</a></footer>
  </div>;
}
