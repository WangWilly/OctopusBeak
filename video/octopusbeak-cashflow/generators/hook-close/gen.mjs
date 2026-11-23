// Generates 01-hook.html and 03-close.html in zh (compositions/frames) and en (compositions/frames-en).
// Run from PROJECT_DIR: node .hyperframes/work-01-03/gen.mjs
import { readFileSync, writeFileSync } from "node:fs";

const SVG = readFileSync("assets/banknote-defs.svg", "utf8");
function cut(start, end) {
  const i = SVG.indexOf(start);
  return SVG.slice(i, SVG.indexOf(end, i) + end.length);
}
const RAW = {
  rosette: cut('<symbol id="rosette"', "</symbol>"),
  w: cut('<g id="w"', "</g>"),
};
function prefixed(p, keys) {
  return keys
    .map((k) => RAW[k])
    .join("\n")
    .replace(/ id="([^"]+)"/g, ` id="${p}$1"`)
    .replace(/href="#([^"]+)"/g, `href="#${p}$1"`);
}

const FONTS = `
      @font-face { font-family: "PingFang TC"; font-weight: 400; src: local("PingFangTC-Regular"), local("PingFang TC"); }
      @font-face { font-family: "PingFang TC"; font-weight: 500; src: local("PingFangTC-Medium"), local("PingFang TC Medium"); }
      @font-face { font-family: "PingFang TC"; font-weight: 600; src: local("PingFangTC-Semibold"), local("PingFang TC Semibold"); }
      @font-face { font-family: "PingFang TC"; font-weight: 700; src: local("PingFangTC-Semibold"), local("PingFang TC Semibold"); }
      @font-face { font-family: "SF Mono"; font-weight: 400; src: local("SFMono-Regular"), local("SF Mono Regular"), local("Menlo-Regular"); }
      @font-face { font-family: "SF Mono"; font-weight: 700; src: local("SFMono-Bold"), local("SF Mono Bold"), local("Menlo-Bold"); }`;

// Night headline gradient: CSS stops 15% #fff, 78% #c4f5ee, 118% #5fd4c9 → SVG clamps at 100% (#8ce3da).
const GRAD = (id) => `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0.15" stop-color="#ffffff"/><stop offset="0.78" stop-color="#c4f5ee"/><stop offset="1" stop-color="#8ce3da"/></linearGradient>`;

const NIGHT_CSS = (p) => `
      [id="${p}-night"] {
        position: absolute; inset: 0; overflow: hidden;
        background: linear-gradient(135deg, #071f4a 0%, #0d4672 52%, #12808f 100%);
      }
      [id="${p}-night-waves"] { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; }
      [id="${p}-night-rosette"] {
        position: absolute; left: 460px; top: 40px; width: 1000px; height: 1000px;
        color: #edf4f1; opacity: 0.14; transform-origin: 50% 50%;
      }
      [id="${p}-night-rosette"] svg { display: block; width: 1000px; height: 1000px; overflow: visible; }`;

const NIGHT_HTML = (p, dur, track, extra = "") => `
    <div id="${p}-night" class="clip" data-start="0" data-duration="${dur}" data-track-index="${track}"${extra}>
      <svg id="${p}-night-waves" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect width="1920" height="1080" fill="url(#${p}-waves-teal)" opacity="0.4" />
      </svg>
      <div id="${p}-night-rosette">
        <svg viewBox="-460 -460 920 920" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><use href="#${p}-rosette" x="-460" y="-460" width="920" height="920" /></svg>
      </div>
    </div>`;

// ─────────────────────────────── 01-hook ───────────────────────────────
const HOOK_STR = {
  zh: {
    lang: "zh-Hant",
    names: ["台北富邦銀行 7028", "台北富邦銀行 7036", "玉山銀行", "元大銀行 7819"],
    sub: "10 月淨變動",
    nodes: ["富邦 7028", "富邦 7036", "玉山", "元大 7819"],
    line1: "錢流過四個帳戶，",
    line2: "這個月，到底流去哪了",
    q: "？",
    headSize: 64,
    cardW: 440,
  },
  en: {
    lang: "en",
    names: ["Taipei Fubon Bank 7028", "Taipei Fubon Bank 7036", "E.SUN Bank", "Yuanta Bank 7819"],
    sub: "October net change",
    nodes: ["Fubon 7028", "Fubon 7036", "E.SUN", "Yuanta 7819"],
    line1: "Your money runs through four accounts.",
    line2: "So where did October's go",
    q: "?",
    headSize: 56,
    cardW: 500,
  },
};

function hook(lang) {
  const S = HOOK_STR[lang];
  const p = "f01";
  const cards = [
    { logo: "fubon", amt: "+2,473", pos: true },
    { logo: "fubon", amt: "+30,000", pos: true },
    { logo: "esun", amt: "−18,345", pos: false },
    { logo: "yuanta-bank", amt: "−32,064", pos: false },
  ];
  const cardHtml = cards
    .map(
      (c, i) => `
        <div id="${p}-card${i}" class="${p}-card" data-layout-allow-occlusion>
          <svg id="${p}-stream${i}" class="${p}-stream" viewBox="0 -24 280 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <defs>
              <linearGradient id="${p}-sg${i}" x1="0" y1="0" x2="280" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#5fd4c9" stop-opacity="0.85"/><stop offset="1" stop-color="#5fd4c9" stop-opacity="0"/></linearGradient>
              <clipPath id="${p}-sc${i}"><rect id="${p}-sr${i}" x="0" y="-24" width="0" height="48" /></clipPath>
            </defs>
            <g clip-path="url(#${p}-sc${i})" fill="none" stroke="url(#${p}-sg${i})" stroke-linecap="round">
              <path d="M0 -4 C 40 -18, 80 10, 130 -4 S 220 -18, 280 -6" stroke-width="2" />
              <path d="M0 4 C 40 -10, 80 18, 130 4 S 220 -10, 280 2" stroke-width="1.2" />
              <path id="${p}-sd${i}" d="M0 0 C 40 -14, 80 14, 130 0 S 220 -14, 280 -2" stroke-width="1.6" stroke-dasharray="10 14" />
            </g>
          </svg>
          <div id="${p}-name${i}" class="${p}-name"></div>
          <div class="${p}-row2">
            <span id="${p}-sub${i}" class="${p}-sub"></span>
            <span class="${p}-amt" style="color: ${c.pos ? "#285d3f" : "#7d4a40"}">${c.amt}</span>
          </div>
        </div>`,
    )
    .join("");
  const discHtml = cards
    .map(
      (c, i) => `
        <div id="${p}-disc${i}" class="${p}-disc" data-layout-allow-occlusion><img src="assets/logos/${c.logo}.webp" alt="" /></div>
        <div id="${p}-label${i}" class="${p}-label"></div>`,
    )
    .join("");

  return `<template id="01-hook-template">
  <div id="root" data-composition-id="01-hook" data-start="0" data-duration="4.5" data-width="1920" data-height="1080">
    <style>${FONTS}

      #root {
        position: relative; width: 1920px; height: 1080px; overflow: hidden;
        font-family: "PingFang TC", sans-serif; color: #0e1217;
      }
      #root * { box-sizing: border-box; }
      [id="${p}-defs"] { position: absolute; width: 0; height: 0; overflow: hidden; }
${NIGHT_CSS(p)}

      [id="${p}-stage"] { position: absolute; inset: 0; }
      .${p}-card {
        position: absolute; height: 116px; border-radius: 18px;
        background: rgba(255, 255, 255, 0.95);
        box-shadow: 0 18px 40px rgba(4, 18, 40, 0.28);
        transform-origin: 50% 50%; opacity: 0;
      }
      .${p}-stream { position: absolute; top: 34px; width: 280px; height: 48px; overflow: visible; }
      .${p}-name {
        position: absolute; left: 106px; right: 24px; top: 18px;
        font-size: 26px; font-weight: 600; line-height: 36px; white-space: nowrap; color: #0e1217;
      }
      .${p}-row2 {
        position: absolute; left: 106px; right: 24px; top: 56px; height: 44px;
        display: flex; justify-content: space-between; align-items: baseline;
      }
      .${p}-sub { font-size: 22px; font-weight: 500; line-height: 44px; color: #5e646a; white-space: nowrap; }
      .${p}-amt {
        font-family: "SF Mono", ui-monospace, Menlo, monospace; font-weight: 700; font-size: 34px;
        line-height: 44px; font-variant-numeric: tabular-nums; white-space: nowrap;
      }
      .${p}-disc {
        position: absolute; width: 88px; height: 88px; border-radius: 50%;
        background: #ffffff; border: 1px solid #d5dae1;
        box-shadow: 0 10px 24px rgba(15, 23, 42, 0.18);
        transform-origin: 50% 50%; opacity: 0;
      }
      .${p}-disc img { position: absolute; left: 15px; top: 15px; width: 56px; height: 56px; object-fit: contain; display: block; }
      .${p}-label {
        position: absolute; width: 240px; height: 28px; text-align: center;
        font-size: 20px; font-weight: 600; line-height: 28px; color: #ffffff; white-space: nowrap;
        clip-path: inset(0% 100% 0% 0%);
      }
      [id="${p}-head"] { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; overflow: visible; }
      [id="${p}-head"] text { font-family: "PingFang TC", sans-serif; font-weight: 700; }
    </style>

    <svg id="${p}-defs" xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true">
      <defs>
        ${prefixed(p + "-", ["rosette", "w"])}
        <pattern id="${p}-waves-teal" style="color: #18a9a4" patternUnits="userSpaceOnUse" width="600" height="300"><use href="#${p}-w" /></pattern>
        ${GRAD(p + "-hg")}
      </defs>
    </svg>
${NIGHT_HTML(p, 4.5, 0)}

    <div id="${p}-stage" class="clip" data-start="0" data-duration="4.5" data-track-index="1">${cardHtml}${discHtml}
      <svg id="${p}-head" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <text id="${p}-l1" x="960" y="880" text-anchor="middle" fill="url(#${p}-hg)"></text>
        <text id="${p}-l2" x="960" y="960" text-anchor="middle" fill="url(#${p}-hg)"></text>
        <text id="${p}-l2q" x="960" y="960" text-anchor="middle" fill="transparent" opacity="0"><tspan id="${p}-l2qa"></tspan><tspan id="${p}-l2qb" fill="#5fd4c9"></tspan></text>
      </svg>
    </div>

    <script>
      (function () {
        window.__timelines = window.__timelines || {};
        const STR = ${JSON.stringify(S, null, 2).replace(/\n/g, "\n        ")};
        const DUR = 4.5;
        const FILM_START = 0;
        const root = document.querySelector('[data-composition-id="01-hook"]');
        const $ = (id) => root.querySelector('[id="${p}-' + id + '"]');
        const tl = gsap.timeline({ paused: true });

        // ground: rosette angle continuous across the film (0.6°/s)
        tl.fromTo($("night-rosette"), { rotation: 0.6 * FILM_START },
          { rotation: 0.6 * (FILM_START + DUR), duration: DUR, ease: "none" }, 0);

        // cards (pop order 7028, 7036, 玉山, 7819) and their nodes
        const CARDS = [
          { cx: 500, cy: 330, tilt: -2, dx: 5.2, dy: -3, node: [360, 640] },
          { cx: 1420, cy: 300, tilt: 1.5, dx: -4.2, dy: 4.2, node: [1000, 340] },
          { cx: 560, cy: 600, tilt: 1.5, dx: 4.2, dy: 4.2, node: [1180, 747] },
          { cx: 1380, cy: 620, tilt: -2.5, dx: -5.2, dy: -3, node: [1340, 340] },
        ];
        const W = STR.cardW, H = 116;
        CARDS.forEach((c, i) => {
          $("name" + i).textContent = STR.names[i];
          $("sub" + i).textContent = STR.sub;
          $("label" + i).textContent = STR.nodes[i];
        });
        [$("l1"), $("l2"), $("l2q")].forEach((el) => el.setAttribute("font-size", String(STR.headSize)));
        $("l1").textContent = STR.line1;
        $("l2").textContent = STR.line2 + STR.q;
        $("l2qa").textContent = STR.line2;
        $("l2qb").textContent = STR.q;
        const POP0 = 0.3, POP_GAP = 0.5, POP_DUR = 0.5;
        const FADE_AT = 3.5, FADE_DUR = 0.35;
        const FLY_AT = 3.55, FLY_DUR = 0.7;
        const LABEL_AT = 4.12;
        const expoOut = gsap.parseEase("expo.out");
        const p2Out = gsap.parseEase("power2.out");
        const p2InOut = gsap.parseEase("power2.inOut");
        const clamp = (x) => Math.max(0, Math.min(1, x));
        const els = CARDS.map((c, i) => {
          const card = $("card" + i), disc = $("disc" + i), label = $("label" + i);
          card.style.left = (c.cx - W / 2) + "px";
          card.style.top = (c.cy - H / 2) + "px";
          card.style.width = W + "px";
          $("stream" + i).style.left = W + "px";
          disc.style.left = (c.node[0] - 44) + "px";
          disc.style.top = (c.node[1] - 44) + "px";
          label.style.left = (c.node[0] - 120) + "px";
          label.style.top = (c.node[1] + 52) + "px";
          return { card, disc, label, sr: $("sr" + i), sd: $("sd" + i) };
        });

        function render(t) {
          CARDS.forEach((c, i) => {
            const e = els[i];
            const popAt = POP0 + POP_GAP * i;
            const pp = clamp((t - popAt) / POP_DUR);
            const s = 0.85 + 0.15 * expoOut(pp);
            const op = p2Out(pp);
            const f = t / DUR;
            const ox = c.dx * f, oy = c.dy * f;
            const fade = 1 - clamp((t - FADE_AT) / FADE_DUR);
            e.card.style.opacity = String(op * fade);
            e.card.style.transform = "translate(" + ox + "px," + oy + "px) rotate(" + c.tilt + "deg) scale(" + s + ")";
            // stream: draws on after the pop, dashes run along it at 40px/s
            const sp = clamp((t - popAt - 0.15) / 0.8);
            e.sr.setAttribute("width", String(280 * p2Out(sp)));
            e.sd.setAttribute("stroke-dashoffset", String(-40 * t));
            // disc: rides the card, then flies to its node
            const a = c.tilt * Math.PI / 180;
            const lx = (-W / 2 + 56) * s, ly = 0;
            const cardX = c.cx + ox + lx * Math.cos(a) - ly * Math.sin(a);
            const cardY = c.cy + oy + lx * Math.sin(a) + ly * Math.cos(a);
            const k = p2InOut(clamp((t - FLY_AT) / FLY_DUR));
            const x = cardX + (c.node[0] - cardX) * k;
            const y = cardY + (c.node[1] - cardY) * k;
            const ds = (64 / 88) * s + (1 - (64 / 88) * s) * k;
            const rot = c.tilt * (1 - k);
            e.disc.style.opacity = String(op);
            e.disc.style.transform = "translate(" + (x - c.node[0]) + "px," + (y - c.node[1]) + "px) rotate(" + rot + "deg) scale(" + ds + ")";
            // node label prints under the disc (stepped)
            const lp = clamp((t - LABEL_AT - 0.05 * i) / 0.24);
            const step = Math.floor(lp * 4) / 4;
            e.label.style.clipPath = "inset(0% " + (100 - step * 100) + "% 0% 0%)";
          });
        }
        let driverT = 0;
        const driver = { get t() { return driverT; }, set t(x) { driverT = x; render(x); } };
        tl.fromTo(driver, { t: 0 }, { t: DUR, duration: DUR, ease: "none" }, 0);
        render(0);

        // headline: line 1 at 1.9, line 2 0.35s later; the question mark flashes teal once
        tl.fromTo($("l1"), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.55, ease: "power3.out" }, 1.9);
        tl.fromTo($("l2"), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.55, ease: "power3.out" }, 2.25);
        tl.fromTo($("l2q"), { opacity: 0 }, { opacity: 1, duration: 0.12, ease: "power1.out" }, 2.8);
        tl.to($("l2q"), { opacity: 0, duration: 0.45, ease: "power2.out" }, 2.95);
        // headline lifts and fades
        tl.to([$("l1"), $("l2")], { opacity: 0, y: -24, duration: 0.4, ease: "power2.in", stagger: 0.05 }, 3.5);

        tl.set({}, {}, DUR);
        window.__timelines["01-hook"] = tl;
      })();
    </script>
  </div>
</template>
`;
}

// ─────────────────────────────── 03-close ───────────────────────────────
// Bar geometry measured from assets/app/hero-{zh,en}.png placed at x=120, y=230, w=1680 (scale 0.77348).
const X = {
  salary: [257.68, 1728.84],
  interest: [1731.16, 1761.33],
  home: [257.68, 750.39],
  transport: [753.48, 833.15],
  dining: [836.24, 895.03],
  daily: [897.35, 946.85],
  shopping: [949.17, 979.34],
  leisure: [982.43, 1011.82],
  kept: [1014.14, 1761.33],
};
const CLOSE_STR = {
  zh: {
    lang: "zh-Hant", shot: "hero-zh.png",
    salary: "薪資 86,500", home: "居家 29,381", kept: "留下來 43,168 · 50%",
    caption: "收支流水 · 實際畫面",
    sub: "收支流水 · v0.11", tag: "資料只留在你的 Mac。",
    geo: { inY: [601.271, 650.773], outY: [665.47, 714.972], cardBottom: 792.3, ulRight: 694, keptShift: 12.4 },
  },
  en: {
    lang: "en", shot: "hero-en.png",
    salary: "Salary 86,500", home: "Home 29,381", kept: "Kept 43,168 · 50%",
    caption: "Cash flow · the real screen",
    sub: "Cash flow · v0.11", tag: "Your data stays on your Mac.",
    geo: { inY: [623.702, 673.204], outY: [687.901, 737.403], cardBottom: 814.8, ulRight: 833, keptShift: 12.4 },
  },
};

function close(lang) {
  const S = CLOSE_STR[lang];
  const p = "f03";
  const bar = (id, key, y, fill, extra = "") =>
    `<div id="${p}-b-${id}" class="${p}-bar ${p}-row-${y}" style="left: ${X[key][0]}px; width: ${(X[key][1] - X[key][0]).toFixed(1)}px; background: ${fill};${extra}"></div>`;
  const bars = [
    bar("salary", "salary", "in", "#285d3f"),
    bar("interest", "interest", "in", "#76527c"),
    bar("home", "home", "out", "#7d4a40"),
    bar("transport", "transport", "out", "#915d2a"),
    bar("dining", "dining", "out", "#266299"),
    bar("daily", "daily", "out", "#186e57"),
    bar("shopping", "shopping", "out", "#76527c"),
    bar("leisure", "leisure", "out", "#2a5e6a"),
    bar("kept", "kept", "out", "#ebf0ed", " border: 1px solid rgba(40, 93, 63, 0.4);"),
  ].join("\n          ");
  const lbl = (id, left, width, y, color, align) =>
    `<div id="${p}-t-${id}" class="${p}-tl ${p}-row-${y}" style="left: ${left}px; width: ${width}px; color: ${color}; text-align: ${align};"></div>`;
  const labels = [
    lbl("salary", 271.989, 1456.851, "in", "#ffffff", "left"),
    lbl("home", 271.989, 478.398, "out", "#ffffff", "left"),
    lbl("kept", X.kept[0], (X.kept[1] - X.kept[0]).toFixed(1), "out", "#285d3f", "center"),
  ].join("\n          ");

  return `<template id="03-close-template">
  <div id="root" data-composition-id="03-close" data-start="0" data-duration="5" data-width="1920" data-height="1080">
    <style>${FONTS}

      #root {
        position: relative; width: 1920px; height: 1080px; overflow: hidden;
        font-family: "PingFang TC", sans-serif; color: #0e1217;
      }
      #root * { box-sizing: border-box; }
      [id="${p}-defs"] { position: absolute; width: 0; height: 0; overflow: hidden; }

      /* paper ground */
      [id="${p}-paper"] {
        position: absolute; inset: 0; overflow: hidden;
        background:
          radial-gradient(ellipse 70% 60% at 0% 100%, #edf4f1 0%, rgba(237, 244, 241, 0.6) 45%, rgba(237, 244, 241, 0) 80%),
          #f9fafc;
      }
      [id="${p}-paper-waves"] { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; }
      [id="${p}-paper-rosette"] {
        position: absolute; left: 1000px; top: 260px; width: 1000px; height: 1000px;
        color: #2c6485; opacity: 0.05; transform-origin: 50% 50%;
      }
      [id="${p}-paper-rosette"] svg { display: block; width: 1000px; height: 1000px; overflow: visible; }
${NIGHT_CSS(p)}
      [id="${p}-night"] { clip-path: circle(0px at 960px 540px); }

      [id="${p}-stage"] { position: absolute; inset: 0; }
      [id="${p}-cam"] { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; transform-origin: 960px 520px; }
      [id="${p}-card"] {
        position: absolute; left: 120px; top: 230px; width: 1680px; height: 585px; border-radius: 16px;
        background: #ffffff; box-shadow: 0 20px 50px rgba(15, 23, 42, 0.10);
      }
      .${p}-bar { position: absolute; border-radius: 5px; }
      .${p}-tl { position: absolute; font-size: 20px; font-weight: 700; white-space: nowrap; }
      [id="${p}-shot"] {
        position: absolute; left: 120px; top: 230px; width: 1680px; border-radius: 18.5px;
        overflow: hidden; opacity: 0;
      }
      [id="${p}-shot"] img { display: block; width: 1680px; height: 584.8px; }
      [id="${p}-ul"] {
        position: absolute; left: 158px; top: 336px; height: 4px; border-radius: 2px;
        background: #18a9a4; transform-origin: 0% 50%; transform: scaleX(0);
      }
      [id="${p}-caption"], [id="${p}-brand"] { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; overflow: visible; }
      [id="${p}-caption"] text, [id="${p}-brand"] text { font-family: "PingFang TC", sans-serif; }
      [id="${p}-icon"] {
        position: absolute; left: 885px; top: 295px; width: 150px; height: 150px; border-radius: 34px;
        overflow: hidden; box-shadow: 0 18px 36px rgba(0, 0, 0, 0.3);
      }
      [id="${p}-icon"] img { display: block; width: 150px; height: 150px; }
    </style>

    <svg id="${p}-defs" xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true">
      <defs>
        ${prefixed(p + "-", ["rosette", "w"])}
        <pattern id="${p}-waves-teal" style="color: #18a9a4" patternUnits="userSpaceOnUse" width="600" height="300"><use href="#${p}-w" /></pattern>
        <pattern id="${p}-waves-ink" style="color: #0e1217" patternUnits="userSpaceOnUse" width="600" height="300"><use href="#${p}-w" /></pattern>
        ${GRAD(p + "-hg")}
      </defs>
    </svg>

    <div id="${p}-paper" class="clip" data-start="0" data-duration="5" data-track-index="0">
      <svg id="${p}-paper-waves" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect width="1920" height="1080" fill="url(#${p}-waves-ink)" opacity="0.04" />
      </svg>
      <div id="${p}-paper-rosette">
        <svg viewBox="-460 -460 920 920" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><use href="#${p}-rosette" x="-460" y="-460" width="920" height="920" /></svg>
      </div>
    </div>

    <div id="${p}-stage" class="clip" data-start="0" data-duration="5" data-track-index="1">
      <div id="${p}-cam">
        <div id="${p}-card" data-layout-allow-occlusion></div>
        <div id="${p}-drawn" data-layout-allow-occlusion>
          ${bars}
          ${labels}
        </div>
        <div id="${p}-shot" data-layout-allow-occlusion><img id="${p}-shotimg" alt="" /></div>
        <div id="${p}-ul" data-layout-allow-occlusion></div>
      </div>
      <svg id="${p}-caption" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <text id="${p}-cap" x="120" y="880" font-size="24" font-weight="600" fill="#5e646a"></text>
      </svg>
    </div>
${NIGHT_HTML(p, 5, 2, " data-layout-allow-occlusion")}

    <div id="${p}-brandstage" class="clip" data-start="0" data-duration="5" data-track-index="3">
      <div id="${p}-icon"><img src="assets/app-icon-180.png" alt="OctopusBeak" /></div>
      <svg id="${p}-brand" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <text id="${p}-word" x="960" y="555" text-anchor="middle" font-size="96" font-weight="700" fill="url(#${p}-hg)">OctopusBeak</text>
        <text id="${p}-sub" x="960" y="625" text-anchor="middle" font-size="36" font-weight="600" fill="#c4f5ee"></text>
        <text id="${p}-tag" x="960" y="690" text-anchor="middle" font-size="30" font-weight="500" fill="#ffffff" fill-opacity="0.75"></text>
      </svg>
    </div>

    <script>
      (function () {
        window.__timelines = window.__timelines || {};
        const STR = ${JSON.stringify(S, null, 2).replace(/\n/g, "\n        ")};
        const DUR = 5;
        const FILM_START = 26;
        const root = document.querySelector('[data-composition-id="03-close"]');
        const $ = (id) => root.querySelector('[id="${p}-' + id + '"]');
        const tl = gsap.timeline({ paused: true });

        // grounds: rosette angle continuous across the film (0.6°/s)
        tl.fromTo([$("paper-rosette"), $("night-rosette")], { rotation: 0.6 * FILM_START },
          { rotation: 0.6 * (FILM_START + DUR), duration: DUR, ease: "none" }, 0);

        // Scene 1 (0.0–0.5): the real screen fades in over the drawn bars; the card takes the screen's shape
        $("shotimg").setAttribute("src", "assets/app/" + STR.shot);
        $("t-salary").textContent = STR.salary;
        $("t-home").textContent = STR.home;
        $("t-kept").textContent = STR.kept;
        $("cap").textContent = STR.caption;
        $("sub").textContent = STR.sub;
        $("tag").textContent = STR.tag;
        [["in", STR.geo.inY], ["out", STR.geo.outY]].forEach(([row, y]) => {
          root.querySelectorAll(".${p}-row-" + row).forEach((el) => {
            el.style.top = y[0] + "px";
            el.style.height = (y[1] - y[0]) + "px";
            el.style.lineHeight = (y[1] - y[0]) + "px";
          });
        });
        const shotH = STR.geo.cardBottom - 230;
        $("shot").style.height = shotH + "px";
        $("ul").style.width = (STR.geo.ulRight - 158) + "px";
        tl.fromTo($("shot"), { opacity: 0 }, { opacity: 1, duration: 0.5, ease: "power1.inOut" }, 0);
        tl.fromTo($("card"), { height: 585, borderRadius: 16 }, { height: shotH, borderRadius: 18.5, duration: 0.5, ease: "power1.inOut" }, 0);
        tl.fromTo($("t-kept"), { x: 0 }, { x: STR.geo.keptShift, duration: 0.35, ease: "power2.inOut" }, 0);
        tl.fromTo([$("t-salary"), $("t-home"), $("t-kept")], { opacity: 1 }, { opacity: 0, duration: 0.5, ease: "power1.inOut" }, 0);
        tl.fromTo($("drawn"), { opacity: 1 }, { opacity: 0, duration: 0.05, ease: "none" }, 0.5);

        // Scene 2 (0.5–2.3): slow push-in; caption; teal underline under the screen's headline
        tl.fromTo($("cam"), { scale: 1 }, { scale: 1.035, duration: 1.8, ease: "power2.inOut" }, 0.5);
        tl.fromTo($("cap"), { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, 0.7);
        tl.fromTo($("ul"), { scaleX: 0 }, { scaleX: 1, duration: 0.7, ease: "power3.out" }, 1.0);

        // Scene 3 (2.3–2.9): night returns as a circle wipe from the centre
        const night = $("night");
        const wipeDriver = { get t() { return 0; }, set t(x) {
          const k = gsap.parseEase("power2.inOut")(Math.max(0, Math.min(1, (x - 2.3) / 0.6)));
          night.style.clipPath = "circle(" + (2300 * k) + "px at 960px 540px)";
        } };
        tl.fromTo(wipeDriver, { t: 0 }, { t: DUR, duration: DUR, ease: "none" }, 0);

        // once the night has covered the frame, the paper stage is gone
        tl.set($("stage"), { autoAlpha: 0 }, 2.9);

        // Scene 4 (2.7–5.0): brand lockup rises in, staggered
        tl.fromTo([$("icon"), $("word"), $("sub"), $("tag")], { opacity: 0, y: 24 },
          { opacity: 1, y: 0, duration: 0.6, ease: "power3.out", stagger: 0.12 }, 2.7);

        tl.set({}, {}, DUR);
        window.__timelines["03-close"] = tl;
      })();
    </script>
  </div>
</template>
`;
}

for (const [lang, dir] of [["zh", "compositions/frames"], ["en", "compositions/frames-en"]]) {
  writeFileSync(`${dir}/01-hook.html`, hook(lang));
  writeFileSync(`${dir}/03-close.html`, close(lang));
}
console.log("ok");
