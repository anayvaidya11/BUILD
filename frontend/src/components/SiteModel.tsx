"use client";
// build — Site model (design 2): floating-island model, real planner API, design chat with the agent,
// a builder agent that places and furnishes rooms live, drag-and-drop furniture, plan view with grid,
// rulers and a tape measure, walkthrough, photoreal Cycles tour and On-site view.
// The scene is imperative three.js (src/build/siteModelApp.js); this component renders its DOM and mounts it once.
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
          <button className="cta" type="submit" id="buildBtn">Build it</button>
        </form>
        <div className="clarify" id="clarify" hidden aria-live="polite">
          <p className="q"><i className="avatar" aria-hidden="true" /><span id="clarifyQ" /></p>
          <div className="chips" id="clarifyOpts" />
        </div>
        <div className="chips" id="chips" />
      </section>

      {/* loading */}
      <ol className="s s-loading flex stepper" id="stepper" />
      <p className="s s-loading thought" id="thought" aria-live="polite" />
      <div className="s s-loading flex rules" id="rules" aria-live="polite" />
      <p className="s s-loading rulecount" id="ruleCount" aria-hidden="true" />
      <div className="s s-loading flex tray" id="tray" />
      <button className="s s-loading ghost skip" id="skipBtn">Skip ahead</button>

      {/* the builder agent's floating label (loading + edits) */}
      <div className="agenttag" id="agentTag" hidden><i aria-hidden="true" /><span /></div>

      {/* result: view tools */}
      <div className="s s-result flex viewbar" id="viewbar" role="toolbar" aria-label="View">
        <div className="seg" role="group" aria-label="View mode">
          <button type="button" data-view="3d" aria-pressed="true">3D</button>
          <button type="button" data-view="plan" aria-pressed="false">Plan</button>
        </div>
        <button type="button" className="tog" data-tog="grid" aria-pressed="false">Grid</button>
        <button type="button" className="tog" data-tog="dims" aria-pressed="false">Dimensions</button>
        <button type="button" className="tog" data-tog="measure" aria-pressed="false" title="Drag between two points on the plan">Measure</button>
      </div>
      <div className="planview" id="planView" hidden>
        <div className="ruler top" id="rulerTop" aria-hidden="true" />
        <div className="ruler left" id="rulerLeft" aria-hidden="true" />
        <div className="corner" aria-hidden="true">ft</div>
        <svg id="planSvg" role="img" aria-label="Floor plan with dimensions" />
        <div className="scalebar" id="scaleBar" aria-hidden="true" />
        <p className="planhint" id="planHint">Scroll to zoom · drag to pan · hover a room for its size</p>
      </div>
      <div id="dimTags" className="s s-result" aria-hidden="true" />

      {/* result: panel */}
      <aside className="s s-result flex panel" id="panel">
        <div className="ptabs" role="tablist" aria-label="Panel">
          <button role="tab" type="button" id="tabChat" data-tab="chat" aria-selected="true" aria-controls="paneChat">Design chat</button>
          <button role="tab" type="button" id="tabInfo" data-tab="info" aria-selected="false" aria-controls="paneInfo">Details</button>
        </div>

        <section className="pane chatpane" id="paneChat" role="tabpanel" aria-labelledby="tabChat">
          <div className="chathead">
            <h2 id="title">Your house is ready</h2>
            <p className="lede" id="lede" />
          </div>
          <ol className="msgs" id="msgs" aria-live="polite" />
          <div className="opts" id="opts" />
          <form className="chatbox" id="chatForm">
            <textarea id="chatInput" rows={1} placeholder="Ask for a change, or ask about the design…" aria-label="Message the design agent" />
            <button className="send" type="submit" aria-label="Send">
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M10 16V4M4.5 9.5 10 4l5.5 5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </form>
        </section>

        <section className="pane infopane" id="paneInfo" role="tabpanel" aria-labelledby="tabInfo" hidden>
          <div className="scroll">
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
        </section>

        <div className="foot">
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
