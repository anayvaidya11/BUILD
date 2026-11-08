"use client";
// build — Site model (design 2): floating-island model, real planner API, drag-and-drop furniture,
// walkthrough, photoreal Cycles tour and On-site view. The scene is imperative three.js
// (src/build/siteModelApp.js); this component renders its DOM and mounts it once.
import { useEffect } from "react";

export default function SiteModel() {
  useEffect(() => {
    import("@/build/siteModelApp").then((m) => m.mountSiteModel());
  }, []);

  return (
    <>
      <canvas id="gl" aria-label="3D model of the house" />

      <div className="top">
        <a href="/" id="logo" aria-label="build home" />
        <div className="s s-loading timer" id="timer">0.0 s</div>
        <button className="s s-result ghost" id="newBtn">New house</button>
      </div>

      {/* landing */}
      <section className="s s-landing landing">
        <h1>Describe a home.<br />Walk through it in a minute.</h1>
        <p className="sub">build plans the rooms, checks every layout rule, then hands you the keys to a 3D model you can walk through at eye height.</p>
        <form className="prompt" id="promptForm">
          <label htmlFor="prompt" className="sr" hidden>Describe your home</label>
          <input id="prompt" autoComplete="off" />
          <button className="cta" type="submit">Build it</button>
        </form>
        <div className="chips" id="chips" />
      </section>

      {/* loading */}
      <ol className="s s-loading flex stepper" id="stepper" />
      <p className="s s-loading thought" id="thought" aria-live="polite" />
      <div className="s s-loading flex rules" id="rules" aria-live="polite" />
      <p className="s s-loading rulecount" id="ruleCount" aria-hidden="true" />
      <div className="s s-loading flex tray" id="tray" />
      <button className="s s-loading ghost skip" id="skipBtn">Skip ahead</button>

      {/* result */}
      <aside className="s s-result flex panel" id="panel">
        <div className="scroll">
          <h2 id="title">Your house is ready</h2>
          <p className="lede" id="lede" />
          <div className="stats" id="stats" />
          <h3>Rooms</h3>
          <ul className="rooms" id="roomList" />
          <h3>Layout rules</h3>
          <details id="fixDetails"><summary id="fixSum">All rules pass</summary><ol id="fixLog" /></details>
        </div>
        <section className="look" aria-label="Look inside the rooms">
          <div className="lookhead"><h3>Look inside</h3><div className="pills" id="pills" role="group" aria-label="Room type" /></div>
          <div className="minis" id="minis">
            {[0, 1, 2].map((i) => (
              <figure className="tile" key={i}><div className="view" /><figcaption><b /><span /></figcaption></figure>
            ))}
          </div>
        </section>
        <div className="foot">
          <form className="edit" id="editForm"><input id="editInput" placeholder="Make the kitchen bigger" aria-label="Change a room" /><button>Apply</button></form>
          <p className="editmsg" id="editMsg" aria-live="polite" />
          <button className="cta walkbtn" id="walkBtn">Walk through</button>
        </div>
      </aside>
      <div id="tags" className="s s-result" />
      <p className="s s-result draghint" id="dragHint"><b>Drag furniture</b> to move it · R rotates · Esc cancels</p>

      {/* walk */}
      <div className="s s-walk hud-room" id="hudRoom">Living Room</div>
      <div className="s s-walk minimap"><div className="wrap" id="mini" /></div>
      <p className="s s-walk hint">W A S D to move, drag to look around, Esc to leave</p>
      <button className="s s-walk ghost exitwalk" id="exitWalk">Leave walkthrough</button>
    </>
  );
}
