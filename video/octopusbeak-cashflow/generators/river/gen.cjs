// Generates compositions/frames/02-river.html (zh-TW) and compositions/frames-en/02-river.html (en)
// from one template. The two files differ only in the STR block.
const fs = require("fs");
const path = require("path");
const W = __dirname;
const PROJECT = path.resolve(W, "../..");

const prefix = (s) => s.replace(/id="([^"]+)"/g, 'id="f02-$1"').replace(/href="#([^"]+)"/g, 'href="#f02-$1"');
const ROSETTE = prefix(fs.readFileSync(path.join(W, "rosette.txt"), "utf8").trim());
const WAVES = prefix(fs.readFileSync(path.join(W, "waves.txt"), "utf8").trim());

const STR_ZH = {
  lang: "zh",
  eyebrow: "新功能 · 收支流水",
  h1: "所有帳戶的錢，匯成一條河。",
  h2: "帳戶之間搬錢，不算收支。",
  h3: "錢的去向，一眼看清。",
  h4: '10 月，每收進 100 元，<br>留下了 <span class="f02-g">50</span> 元。',
  headFont: 56,
  cellIn: "流入",
  cellOut: "流出",
  cellKept: "留下來",
  subIn: "2 筆 · 薪資佔 99.5%",
  subOut: "22 筆 · 居家佔 67%",
  subKept: "流入的 50%，<br>比上期多 30 個百分點",
  node7028: "富邦 7028",
  node7036: "富邦 7036",
  node7819: "元大 7819",
  nodeEsun: "玉山",
  salary: "薪資 86,500",
  interest: "利息 412",
  sealA: "內部轉帳 · 已配對",
  pillB: "換匯",
  pillC: "未配對 2 筆",
  coinCur: "USD",
  coinAmt: "1,000.00",
  panelHead: "帳戶間搬錢 · 不計入收支",
  panelHeadFont: 18,
  rowA: "內部轉帳 1 組",
  rowB: "換匯 1 組",
  rowC: "未配對 2 筆",
  home: "居家 29,381",
  transport: "交通 4,736",
  dining: "餐飲 3,458",
  daily: "日常 2,889",
  shopping: "購物 1,780",
  leisure: "休閒 1,500",
  pool: "留下來 43,168 · 50%",
  barSalary: "薪資 86,500",
  barHome: "居家 29,381",
  barKept: "留下來 43,168 · 50%",
  // real flow-bar rows in hero-zh.png pixels (2172×756), measured: [top, bottom)
  barInY: [480, 544],
  barOutY: [563, 627],
};

const STR_EN = {
  lang: "en",
  eyebrow: "New · Cash flow",
  h1: "Every account's money, one river.",
  h2: "Moving money between your own accounts isn't inflow or outflow.",
  h3: "Where the money went,<br>at a glance.",
  h4: 'In October, of every 100<br>that came in, <span class="f02-g">50</span> stayed.',
  headFont: 48,
  cellIn: "Inflow",
  cellOut: "Outflow",
  cellKept: "Kept",
  subIn: "2 items · Salary 99.5%",
  subOut: "22 items · Home 67%",
  subKept: "50% of inflow, up 30 points<br>on the previous period",
  node7028: "Fubon 7028",
  node7036: "Fubon 7036",
  node7819: "Yuanta 7819",
  nodeEsun: "E.SUN",
  salary: "Salary 86,500",
  interest: "Interest 412",
  sealA: "Internal transfer · paired",
  pillB: "Currency exchange",
  pillC: "Unpaired · 2",
  coinCur: "USD",
  coinAmt: "1,000.00",
  panelHead: "Between your accounts · not counted",
  panelHeadFont: 16,
  rowA: "Internal transfer · 1",
  rowB: "Currency exchange · 1",
  rowC: "Unpaired · 2",
  home: "Home 29,381",
  transport: "Transport 4,736",
  dining: "Dining 3,458",
  daily: "Daily 2,889",
  shopping: "Shopping 1,780",
  leisure: "Leisure 1,500",
  pool: "Kept 43,168 · 50%",
  barSalary: "Salary 86,500",
  barHome: "Home 29,381",
  barKept: "Kept 43,168 · 50%",
  // real flow-bar rows in hero-en.png pixels (2172×756), measured: [top, bottom)
  barInY: [509, 573],
  barOutY: [592, 656],
};

const tpl = fs.readFileSync(path.join(W, "template.html"), "utf8")
  .replace("__ROSETTE__", ROSETTE)
  .replace("__WAVES__", WAVES);

for (const [STR, dir] of [[STR_ZH, "frames"], [STR_EN, "frames-en"]]) {
  const out = tpl.replace("/*__STR__*/", "const STR = " + JSON.stringify(STR, null, 2) + ";");
  const p = path.join(PROJECT, "compositions", dir, "02-river.html");
  fs.writeFileSync(p, out);
  console.log("wrote", p, out.length);
}
