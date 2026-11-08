/*
 * Swissyphus motion runtime (Carte Nationale system).
 *
 * Every film is a pure function of time: window.render(t) draws the frame at
 * t seconds. render.mjs steps t at 30 fps, screenshots each frame and encodes
 * the MP4, so a film can be re-rendered whenever its numbers change.
 */
(function () {
  const B = {
    lake: "#123C4D", contour: "#1F7A8C", glacier: "#8FC1C4", snow: "#EEF3F2",
    trail: "#D97B4F", trailInk: "#B0532A", trailLt: "#E8956C", ink2: "#3D5A63", night: "#0B2733",
  };
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  /** Progress 0..1 of t through [a, b]. */
  const seg = (t, a, b) => clamp((t - a) / (b - a));
  const easeOut = (x) => 1 - Math.pow(1 - x, 3);
  const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const lerp = (a, b, x) => a + (b - a) * x;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Math.round(n).toLocaleString("en-US").replace(/,/g, "'");

  function show(el, p, dy = 18) {
    const e = easeOut(p);
    el.style.opacity = String(e);
    el.style.transform = `translateY(${(1 - e) * dy}px)`;
  }
  function type(el, text, p) {
    const n = Math.round(text.length * clamp(p));
    el.textContent = text.slice(0, n);
    el.classList.toggle("caret", p > 0 && p < 1);
  }
  /** A rule that draws from the left. */
  function draw(el, p) {
    el.style.transform = `scaleX(${easeInOut(p)})`;
  }
  /** Mark SVG (38-unit grid). The boulder can roll along the slope: roll 0 = foot, 1 = rest. */
  function markSvg(id, size, slope = B.lake) {
    return `<svg viewBox="-2 -4 42 44" width="${size}" height="${size}" style="overflow:visible"><path d="M0 38H38V13Z" fill="${slope}"/><circle id="${id}" cx="28" cy="8" r="8" fill="${B.trail}"/></svg>`;
  }
  function roll(id, p) {
    const e = easeOut(p);
    const c = $(id);
    if (!c) return;
    c.setAttribute("cx", String(lerp(4, 28, e)));
    c.setAttribute("cy", String(lerp(23.8, 8, e)));
  }
  /** Shared masthead: mark, wordmark, use-case eyebrow and coordinates. */
  function masthead(useCase, coords) {
    return `
    <div class="mast" id="mast">
      <div class="brand">${markSvg("mast-boulder", 46)}<span>swissyphus</span></div>
      <div class="mono eyebrow" id="mast-case">${useCase}</div>
      <div class="mono coords" id="mast-coords">${coords}</div>
    </div>
    <div class="rule" id="mast-rule" style="top:118px"></div>`;
  }
  function animMast(t) {
    draw($("mast-rule"), seg(t, 0, 0.7));
    show($("mast"), seg(t, 0.05, 0.6), -10);
    roll("mast-boulder", seg(t, 0.2, 1.1));
  }
  /** End card: the boulder rolls up its slope; tagline and command. */
  function endCard() {
    return `
    <div class="end" id="end">
      <div class="end-mark">${markSvg("end-boulder", 260)}</div>
      <div>
        <div class="end-word">swissyphus</div>
        <div class="disp end-tag">Every Swiss source.<br><span class="accent">Always running.</span></div>
        <div class="end-cmd mono"><span class="p">$</span> npx -y swissyphus</div>
        <div class="mono end-meta">151 TOOLS · 66 PUBLIC SOURCES · ZERO API KEYS · EVERY ANSWER CITED</div>
      </div>
    </div>`;
  }
  function animEnd(t, start) {
    const p = seg(t, start, start + 0.5);
    $("end").style.opacity = String(easeOut(p));
    $("end").style.pointerEvents = p > 0 ? "auto" : "none";
    roll("end-boulder", seg(t, start + 0.15, start + 1.3));
    show(document.querySelector(".end-word"), seg(t, start + 0.3, start + 0.9));
    show(document.querySelector(".end-tag"), seg(t, start + 0.55, start + 1.15));
    show(document.querySelector(".end-cmd"), seg(t, start + 0.9, start + 1.5));
    show(document.querySelector(".end-meta"), seg(t, start + 1.1, start + 1.7));
  }
  window.SY = { B, clamp, seg, easeOut, easeInOut, lerp, $, fmt, show, type, draw, markSvg, roll, masthead, animMast, endCard, animEnd };
})();
