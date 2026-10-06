const EN = {
  "meta.title": "OctopusBeak | Import your banks, cards, and investments in one click",
  "meta.description": "A macOS app that imports your accounts from 11 Taiwanese institutions plus e-invoices in one click, and builds one financial overview where every number traces back to its source. Your data stays on your Mac.",
  "nav.how": "How it works",
  "nav.overview": "Overview",
  "nav.sources": "Sources",
  "nav.faq": "FAQ",
  "cta.download": "Download macOS Beta",
  "hero.title": "Banks, cards, and investments,",
  "hero.title2": " imported in one click.",
  "hero.titleTone": " Every number traces to its source.",
  "hero.lead": "OctopusBeak collects your accounts from 11 Taiwanese institutions plus e-invoices and builds one financial overview on your Mac that you can check line by line.",
  "hero.demo": "Watch the intro",
  "cta.requirements": "Requires Apple silicon · Beta",
  "demo.subtitle": "One purchase, counted twice? How OctopusBeak merges duplicate entries · 0:30",
  "demo.close": "Close",
  "demo.hint": "Press Esc or click outside to close",
  "demo.cta": "Download OctopusBeak free",
  "player.seek": "Playback position",
  "player.play": "Play",
  "player.pause": "Pause",
  "player.mute": "Mute",
  "player.unmute": "Unmute",
  "player.speed": "Playback speed",
  "player.fullscreen": "Full screen",
  "sources.title": "11 institutions plus e-invoices,",
  "sources.titleTone": " in a single import.",
  "sources.lead": "Deposits, credit cards, loans, brokerage, funds, foreign currency, and MaiCoin crypto, side by side in one place you can check. More sources are on the way.",
  "sources.badge": "Supported in Beta",
  "source.fubon": "Taipei Fubon Bank",
  "source.fubon.types": "Deposits, credit cards, loans",
  "source.esun": "E.SUN Bank",
  "source.types.cards": "Credit cards",
  "source.yuanta": "Yuanta Bank",
  "source.yuanta.types": "Deposits, foreign currency, loans, credit cards, funds",
  "source.yuantaSec": "Yuanta Securities",
  "source.yuantaSec.types": "Brokerage investments",
  "source.cathay": "Cathay United Bank",
  "source.cathay.types": "TWD deposits, foreign-currency deposits",
  "source.huanan": "Hua Nan Bank",
  "source.types.deposits": "Deposits",
  "source.ctbc": "CTBC Bank",
  "source.post": "Chunghwa Post",
  "source.sinopac": "Bank SinoPac",
  "source.types.accounts": "Accounts",
  "source.maicoin.types": "Digital assets",
  "source.other": "Other data sources",
  "source.other.types": "E-invoices",
  "flow.title": "One click",
  "flow.titleTone": " imports everything.",
  "flow.lead": "Set up your sources once. Then one click runs the import start to finish and files every account into your overview.",
  "flow.1.title": "Set up sources",
  "flow.1.body": "Credentials encrypted in macOS secure storage",
  "flow.2.title": "Import in one click",
  "flow.2.body": "Every source collected in one run",
  "flow.3.title": "Check any number",
  "flow.3.body": "Every figure links to its source",
  "overview.title": "See the whole picture,",
  "overview.titleTone": " and follow any number back to its source.",
  "overview.lead": "From total assets and liabilities down to single accounts and transactions, every layer shows where it came from. To check a number, follow it back. No more digging through files and spreadsheets.",
  "overview.assets.title": "Assets",
  "overview.assets.body": "Every account's balance and trend, by category",
  "overview.spending.title": "Spending",
  "overview.spending.body": "Merged entries, each traced back to its line items",
  "overview.liabilities.title": "Liabilities",
  "overview.liabilities.body": "Due dates first, then down to every card",
  "privacy.title": "Organized on your Mac,",
  "privacy.titleTone": " and kept there.",
  "privacy.lead": "Account data and settings stay on your Mac. Credentials are encrypted with macOS secure storage.",
  "privacy.point1": "Your data stays on your Mac",
  "privacy.point2": "Credentials encrypted by macOS",
  "faq.import.q": "Do I need to stay at my Mac during an import?",
  "faq.import.a": "No. Once your sources are set up, one click runs the import start to finish and collects every source.",
  "faq.storage.q": "Where does OctopusBeak store my data?",
  "faq.storage.a": "OctopusBeak runs on your Mac. Collected account data, financial records, and app settings are stored locally. Login credentials are encrypted with macOS secure storage.",
  "faq.mac.q": "Can my Mac run OctopusBeak Beta?",
  "faq.mac.a": "The Beta runs on Macs with Apple silicon (M-series chips). Intel Macs, Windows, and other platforms are not supported yet.",
  "final.title": "Spend less time gathering numbers,",
  "final.titleTone": " more time understanding your money.",
  "footer.tagline": "Scattered accounts. One clear picture.",
  "footer.contents": "On this page",
  "footer.download": "Download",
  "footer.releases": "Other versions and checksums",
};

const LOCALES = { "zh-Hant": "zh_TW", en: "en_US" };

const meta = {
  title: [document.querySelector('meta[property="og:title"]'), document.querySelector('meta[name="twitter:title"]')],
  description: [
    document.querySelector('meta[name="description"]'),
    document.querySelector('meta[property="og:description"]'),
    document.querySelector('meta[name="twitter:description"]'),
  ],
  locale: document.querySelector('meta[property="og:locale"]'),
};

const translated = [...document.querySelectorAll("[data-i18n]")];
const chinese = new Map(translated.map((element) => [element, element.textContent]));
const chineseMeta = { title: document.title, description: meta.description[0].content };
const buttons = document.querySelectorAll("[data-lang-button]");
// The demo video has an English cut: each element names its English file in data-src-en / data-poster-en / data-href-en.
const LOCALIZED_ATTRIBUTES = { srcEn: "src", posterEn: "poster", hrefEn: "href" };
const localizedMedia = [...document.querySelectorAll("[data-src-en], [data-poster-en], [data-href-en]")].map((element) => {
  const key = Object.keys(LOCALIZED_ATTRIBUTES).find((name) => name in element.dataset);
  const attribute = LOCALIZED_ATTRIBUTES[key];
  return { element, attribute, chinese: element.getAttribute(attribute), english: element.dataset[key] };
});

function setLanguage(language, updateUrl) {
  const english = language === "en";
  const selected = english ? "en" : "zh-Hant";

  document.documentElement.lang = selected;
  for (const element of translated) {
    element.textContent = english ? EN[element.dataset.i18n] : chinese.get(element);
  }
  for (const button of buttons) {
    button.setAttribute("aria-pressed", String(button.dataset.langButton === selected));
  }
  const reloaded = new Set();
  for (const { element, attribute, chinese: zh, english: en } of localizedMedia) {
    const wanted = english ? en : zh;
    if (element.getAttribute(attribute) === wanted) continue;
    element.setAttribute(attribute, wanted);
    const video = element.closest("video");
    if (video) reloaded.add(video);
  }
  for (const video of reloaded) video.load();

  const title = english ? EN["meta.title"] : chineseMeta.title;
  const description = english ? EN["meta.description"] : chineseMeta.description;
  document.title = title;
  for (const tag of meta.title) tag.content = title;
  for (const tag of meta.description) tag.content = description;
  meta.locale.content = LOCALES[selected];

  if (updateUrl) {
    const url = new URL(window.location.href);
    if (english) url.searchParams.set("lang", "en");
    else url.searchParams.delete("lang");
    window.history.replaceState({}, "", url);
  }
}

for (const button of buttons) {
  button.addEventListener("click", () => setLanguage(button.dataset.langButton, true));
}

if (new URLSearchParams(window.location.search).get("lang") === "en") setLanguage("en", false);

// Demo modal: the intro card and the hero button open it; Esc, the close button, or a backdrop click close it.
const demoModal = document.getElementById("demo-modal");
if (demoModal && typeof demoModal.showModal === "function") {
  const player = demoModal.querySelector(".player");
  const video = player.querySelector("video");
  const seek = player.querySelector('input[type="range"]');
  const time = player.querySelector(".player-time");
  const speedValue = player.querySelector(".player-speed-value");
  const SPEEDS = [1, 1.5, 2];

  const clock = (seconds) => {
    const whole = Math.max(0, Math.floor(seconds || 0));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  };
  const sync = () => {
    const duration = video.duration || 0;
    const played = duration ? video.currentTime / duration : 0;
    const buffered = duration && video.buffered.length ? video.buffered.end(video.buffered.length - 1) / duration : 0;
    seek.value = String(Math.round(played * 1000));
    player.style.setProperty("--played", `${played * 100}%`);
    player.style.setProperty("--buffered", `${buffered * 100}%`);
    time.textContent = `${clock(video.currentTime)} / ${clock(duration || 30)}`;
  };
  const syncState = () => {
    player.classList.toggle("is-playing", !video.paused);
    player.classList.toggle("is-muted", video.muted);
  };

  for (const opener of document.querySelectorAll("[data-demo-open]")) {
    opener.addEventListener("click", (event) => {
      event.preventDefault();
      demoModal.showModal();
      video.play().catch(() => {});
    });
  }
  demoModal.addEventListener("click", (event) => {
    if (event.target === demoModal || event.target.closest("[data-demo-close]")) demoModal.close();
  });
  demoModal.addEventListener("close", () => video.pause());

  for (const name of ["timeupdate", "progress", "loadedmetadata", "seeked", "emptied"]) video.addEventListener(name, sync);
  for (const name of ["play", "pause", "volumechange", "emptied"]) video.addEventListener(name, syncState);
  video.addEventListener("ratechange", () => (speedValue.textContent = `${video.playbackRate}×`));
  video.addEventListener("click", () => (video.paused ? video.play().catch(() => {}) : video.pause()));
  seek.addEventListener("input", () => {
    if (video.duration) video.currentTime = (Number(seek.value) / 1000) * video.duration;
  });
  player.addEventListener("click", (event) => {
    const control = event.target.closest("[data-player]");
    if (!control) return;
    const action = control.dataset.player;
    if (action === "toggle") video.paused ? video.play().catch(() => {}) : video.pause();
    if (action === "mute") video.muted = !video.muted;
    if (action === "speed") {
      const next = SPEEDS[(SPEEDS.indexOf(video.playbackRate) + 1) % SPEEDS.length];
      video.playbackRate = next;
      speedValue.textContent = `${next}×`;
    }
    if (action === "fullscreen") {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (player.requestFullscreen) player.requestFullscreen();
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    }
  });
}

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;

if (!reducedMotion && "IntersectionObserver" in window) {
  const groups = [...document.querySelectorAll("[data-reveal]")];
  const reveal = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-in");
      reveal.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -12% 0px" });
  for (const group of groups) {
    group.querySelectorAll(".reveal").forEach((element, index) => {
      element.style.setProperty("--d", `${Math.min(index, 8) * 70}ms`);
    });
    // Anything already on screen (or scrolled past, on a deep link) shows at once instead of blinking out.
    if (group.getBoundingClientRect().top < window.innerHeight) group.classList.add("is-in");
    else reveal.observe(group);
  }
  document.documentElement.classList.add("js-motion");
}

const header = document.querySelector(".site-header");
let lastScrollY = window.scrollY;
let scrollFrame = 0;
window.addEventListener("scroll", () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    const y = window.scrollY;
    if (y > lastScrollY + 4 && y > 160 && !header.contains(document.activeElement)) header.classList.add("is-hidden");
    else if (y < lastScrollY - 4 || y <= 160) header.classList.remove("is-hidden");
    lastScrollY = y;
  });
}, { passive: true });
header.addEventListener("focusin", () => header.classList.remove("is-hidden"));

// The hero portrait is one character reacting to the visitor: a download CTA in play beats a present pointer beats idle.
const hero = document.querySelector(".hero");
const POSE_FILES = { reading: "sun-phone-reading", facing: "sun-phone-facing", thumbs: "sun-phone-thumbs-up" };
const visitor = { present: false, cta: false };
const poseFor = ({ present, cta }) => (cta ? "thumbs" : present ? "facing" : "reading");

if (finePointer && !reducedMotion) {
  const headline = hero.querySelector(".display");
  const reading = hero.querySelector(".pose");
  const layers = new Map([["reading", reading]]);
  const ready = new Set(["reading"]);

  const renderPose = () => {
    const wanted = poseFor(visitor);
    const pose = ready.has(wanted) ? wanted : "reading";
    if (hero.dataset.pose === pose) return;
    hero.dataset.pose = pose;
    for (const [name, layer] of layers) layer.classList.toggle("is-on", name === pose);
  };

  const loadPoses = () => {
    for (const name of ["facing", "thumbs"]) {
      const layer = reading.cloneNode();
      layer.classList.remove("is-on");
      layer.removeAttribute("fetchpriority");
      layer.dataset.poseName = name;
      layer.src = `assets/illustrations/${POSE_FILES[name]}.webp`;
      reading.after(layer);
      layers.set(name, layer);
      layer.decode().then(() => {
        ready.add(name);
        renderPose();
      }, () => {});
    }
  };
  if (document.readyState === "complete") loadPoses();
  else window.addEventListener("load", loadPoses, { once: true });

  let pointer = null;
  let pointerFrame = 0;
  let idleTimer = 0;

  const rest = () => {
    hero.style.setProperty("--px", "0");
    hero.style.setProperty("--py", "0");
  };

  const track = () => {
    pointerFrame = 0;
    const box = hero.getBoundingClientRect();
    const inside = pointer.y >= box.top && pointer.y <= box.bottom;
    clearTimeout(idleTimer);
    if (inside) {
      const text = headline.getBoundingClientRect();
      headline.style.setProperty("--mx", `${(((pointer.x - text.left) / text.width) * 100).toFixed(1)}%`);
      headline.style.setProperty("--my", `${(((pointer.y - text.top) / text.height) * 100).toFixed(1)}%`);
      hero.style.setProperty("--px", (((pointer.x - box.left) / box.width) * 2 - 1).toFixed(3));
      hero.style.setProperty("--py", (((pointer.y - box.top) / box.height) * 2 - 1).toFixed(3));
      idleTimer = setTimeout(() => {
        visitor.present = false;
        renderPose();
      }, 3000);
    } else {
      rest();
    }
    visitor.present = inside;
    renderPose();
  };

  document.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    pointer = { x: event.clientX, y: event.clientY };
    if (!pointerFrame) pointerFrame = requestAnimationFrame(track);
  }, { passive: true });

  document.addEventListener("pointerout", (event) => {
    if (event.relatedTarget) return;
    clearTimeout(idleTimer);
    visitor.present = false;
    rest();
    renderPose();
  });

  const setCta = (engaged) => {
    visitor.cta = engaged;
    renderPose();
  };
  for (const cta of document.querySelectorAll("[data-download]")) {
    cta.addEventListener("pointerenter", () => setCta(true));
    cta.addEventListener("pointerleave", () => setCta(false));
    cta.addEventListener("focus", () => setCta(true));
    cta.addEventListener("blur", () => setCta(false));
  }
}
