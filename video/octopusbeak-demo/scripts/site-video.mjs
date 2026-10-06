// Renders the zh-Hant and English cuts, encodes them for the web, and copies them to the site.
//   npm run site-video                      → writes site/assets/octopusbeak-demo{,-en}{.mp4,-poster.webp}
//   npm run site-video -- --out <dir>       → writes the four files to <dir> instead (a dry run)
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PROJECT = resolve(import.meta.dirname, "..");
const outFlag = process.argv.indexOf("--out");
const OUT = outFlag > -1 ? resolve(process.argv[outFlag + 1]) : resolve(PROJECT, "../../site/assets");
const INDEX = join(PROJECT, "index.html");
const BGM = join(PROJECT, "assets/bgm/track-30s.mp3");
const POSTER_AT = "4.4"; // the opening question, fully set

// The site plays each cut in a ~400px tile and a 1040px modal: 720p H.264 is sharp enough at ~4.5 MB.
const CUTS = [
  { name: "octopusbeak-demo", frames: "compositions/frames/" },
  { name: "octopusbeak-demo-en", frames: "compositions/frames-en/" },
];

const run = (command, args) => execFileSync(command, args, { cwd: PROJECT, stdio: "inherit" });

if (!existsSync(BGM)) {
  console.error(`Missing ${BGM}. The music bed is not committed; see README.md § Music to fetch and cut it.`);
  process.exit(1);
}

mkdirSync(join(PROJECT, "renders"), { recursive: true });
mkdirSync(OUT, { recursive: true });
const zhIndex = readFileSync(INDEX, "utf8");

try {
  for (const cut of CUTS) {
    // A project holds one root composition, so each cut points index.html at its own frame folder.
    writeFileSync(INDEX, zhIndex.replaceAll("compositions/frames/", cut.frames));
    const master = join(PROJECT, "renders", `${cut.name}.mp4`);
    run("npx", ["--yes", "hyperframes@0.8.137", "render", "--quality", "high", "--output", master]);

    const web = join(PROJECT, "renders", `${cut.name}-web.mp4`);
    run("ffmpeg", ["-v", "error", "-y", "-i", master, "-vf", "scale=1280:720:flags=lanczos", "-c:v", "libx264", "-preset", "slow", "-crf", "23", "-pix_fmt", "yuv420p", "-profile:v", "high", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "128k", web]);
    const poster = join(PROJECT, "renders", `${cut.name}-poster.webp`);
    run("ffmpeg", ["-v", "error", "-y", "-ss", POSTER_AT, "-i", master, "-frames:v", "1", "-vf", "scale=960:540:flags=lanczos", "-c:v", "libwebp", "-quality", "72", poster]);

    copyFileSync(web, join(OUT, `${cut.name}.mp4`));
    copyFileSync(poster, join(OUT, `${cut.name}-poster.webp`));
  }
} finally {
  writeFileSync(INDEX, zhIndex);
}

console.log(`Wrote ${CUTS.map((cut) => `${cut.name}.mp4 + poster`).join(", ")} to ${OUT}`);
