const EN = {
  "meta.title": "OctopusBeak | See your banks, cards, and investments in one place",
  "meta.description": "Built for people in Taiwan managing multiple financial accounts. OctopusBeak automatically collects scattered account data, keeping assets, liabilities, transactions, and their sources clear and traceable.",
  "nav.how": "How it works",
  "nav.overview": "Financial overview",
  "nav.sources": "Supported sources",
  "nav.faq": "FAQ",
  "cta.download": "Download macOS Beta",
  "hero.eyebrow": "For people in Taiwan managing 3+ financial accounts",
  "hero.title": "Stop piecing together your banks, cards, and investments in spreadsheets.",
  "hero.lead": "OctopusBeak automatically collects your scattered account data and organizes it into a traceable financial overview you can verify anytime.",
  "hero.demo": "Watch the full demo",
  "cta.requirements": "Requires Apple silicon · Beta release",
  "sources.eyebrow": "Currently supported",
  "sources.title": "Every account belongs in your financial picture.",
  "sources.lead": "From bank deposits and credit cards to investment records, OctopusBeak is gradually bringing the financial sources people use most into one place you can verify.",
  "sources.badge": "Available in Beta",
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
  "flow.eyebrow": "See the full workflow",
  "flow.title": "Let automation handle the repetitive work. Keep every important decision in your hands.",
  "flow.lead": "Choose your financial sources, and OctopusBeak will collect and organize the account data. It only asks you to step in for verification codes, OTPs, or decisions that require your judgment.",
  "flow.1.title": "Choose sources",
  "flow.1.body": "Select the accounts you want to organize",
  "flow.2.title": "Collect automatically",
  "flow.2.body": "Retrieve account data through repeatable workflows",
  "flow.3.title": "Step in when needed",
  "flow.3.body": "Handle verification codes, OTPs, or decisions",
  "flow.4.title": "See the full picture",
  "flow.4.body": "Keep every account and transaction traceable",
  "overview.eyebrow": "From overview to detail",
  "overview.title": "See the full picture, with a clear path back to every detail.",
  "overview.lead": "Move from total assets and liabilities down to individual accounts and transactions, with every layer pointing back to its source. When something needs checking, there is no need to dig through files and spreadsheets again.",
  "privacy.eyebrow": "Convenience without giving up privacy",
  "privacy.title": "Organize your financial data—and keep it on your own computer.",
  "privacy.lead": "Your account data and settings stay on your Mac. Credentials are encrypted through macOS secure storage, and whenever something requires judgment, OctopusBeak pauses and waits for you.",
  "privacy.point1": "Your data stays on your Mac",
  "privacy.point2": "Your credentials are protected by macOS",
  "privacy.point3": "Your judgment stays in your hands",
  "faq.storage.q": "Where does OctopusBeak store my data?",
  "faq.storage.a": "OctopusBeak runs on your Mac. Collected account data, financial records, and app settings are stored locally, while login credentials are encrypted through macOS secure storage. When a verification code, OTP, or decision is required, the app pauses and hands control back to you.",
  "faq.mac.q": "Can my Mac run OctopusBeak Beta?",
  "faq.mac.a": "The current Beta supports Macs with Apple silicon (M-series chips). Intel Macs, Windows, and other platforms are not supported yet.",
  "final.eyebrow": "Start organizing",
  "final.title": "Spend less time organizing. Spend more time understanding your finances.",
  "footer.tagline": "Scattered accounts. One clear financial picture.",
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
