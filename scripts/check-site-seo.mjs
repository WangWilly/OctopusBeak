import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';

const siteUrl = 'https://wangwilly.github.io/OctopusBeak/';
const indexPath = 'site/index.html';
const robotsPath = 'site/robots.txt';
const sitemapPath = 'site/sitemap.xml';
const favicon32Path = 'site/assets/favicon-32x32.png';
const favicon16Path = 'site/assets/favicon-16x16.png';
const appleTouchIconPath = 'site/assets/apple-touch-icon.png';
const siteIconPath = 'site/assets/site-icon.png';

const html = readFileSync(indexPath, 'utf8');

function assertIncludes(source, needle, label) {
  assert.ok(source.includes(needle), `${label} missing: ${needle}`);
}

assertIncludes(html, `<link rel="canonical" href="${siteUrl}" />`, 'canonical');
assertIncludes(html, `<link rel="alternate" hreflang="en" href="${siteUrl}?lang=en" />`, 'English hreflang');
assertIncludes(html, `<link rel="alternate" hreflang="zh-Hant" href="${siteUrl}?lang=zh-Hant" />`, 'Traditional Chinese hreflang');
assertIncludes(html, `<link rel="alternate" hreflang="x-default" href="${siteUrl}" />`, 'default hreflang');
assertIncludes(html, `<meta name="robots" content="index, follow" />`, 'robots meta');
assertIncludes(html, `<meta property="og:url" content="${siteUrl}" />`, 'Open Graph URL');
assertIncludes(html, '<meta property="og:site_name" content="OctopusBeak" />', 'Open Graph site name');
assertIncludes(html, '<meta property="og:type" content="website" />', 'Open Graph type');
assertIncludes(html, '<meta property="og:locale" content="en_US" />', 'Open Graph locale');
assertIncludes(html, '<meta property="og:locale:alternate" content="zh_TW" />', 'Open Graph alternate locale');
assertIncludes(html, '<meta property="og:image:type" content="image/png" />', 'Open Graph image type');
assertIncludes(html, '<meta name="application-name" content="OctopusBeak" />', 'application name');
assertIncludes(html, '<meta name="apple-mobile-web-app-title" content="OctopusBeak" />', 'Apple app title');
assertIncludes(html, '<link rel="icon" type="image/png" sizes="32x32" href="assets/favicon-32x32.png" />', '32px favicon');
assertIncludes(html, '<link rel="icon" type="image/png" sizes="16x16" href="assets/favicon-16x16.png" />', '16px favicon');
assertIncludes(html, '<link rel="apple-touch-icon" sizes="180x180" href="assets/apple-touch-icon.png" />', 'Apple touch icon');
assertIncludes(html, '<img class="brand-icon" src="assets/site-icon.png" alt="" aria-hidden="true" />', 'top-left brand icon');
assertIncludes(html, '<img class="cta-icon" src="assets/site-icon.png" alt="" aria-hidden="true" />', 'CTA icon');
assertIncludes(html, '<meta name="twitter:title" content="OctopusBeak App · Bank automation and financial dashboard" />', 'Twitter title');
assertIncludes(html, '<meta name="twitter:description" content="OctopusBeak pulls bank statement activity into one calm workspace with account drilldowns and desktop-owned credentials." />', 'Twitter description');
assertIncludes(html, 'document.querySelector(\'meta[name="twitter:title"]\')?.setAttribute(\'content\', t(\'metadata.title\'));', 'localized Twitter title update');
assertIncludes(html, 'document.querySelector(\'meta[name="twitter:description"]\')?.setAttribute(\'content\', t(\'metadata.description\'));', 'localized Twitter description update');
assertIncludes(html, 'document.querySelector(\'meta[property="og:locale"]\')?.setAttribute(\'content\', t(\'metadata.locale\'));', 'localized Open Graph locale update');

const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
assert.ok(jsonLdMatch, 'JSON-LD script missing');
const structuredData = JSON.parse(jsonLdMatch[1]);
assert.equal(structuredData['@context'], 'https://schema.org');
assert.equal(structuredData['@type'], 'SoftwareApplication');
assert.equal(structuredData.name, 'OctopusBeak');
assert.equal(structuredData.url, siteUrl);
assert.equal(structuredData.applicationCategory, 'FinanceApplication');
assert.equal(structuredData.operatingSystem, 'macOS');
assert.equal(structuredData.downloadUrl, 'https://github.com/WangWilly/OctopusBeak/releases/latest');
assert.equal(structuredData.sameAs, 'https://github.com/WangWilly/OctopusBeak');
assert.equal(structuredData.softwareVersion, 'Beta');

assert.ok(existsSync(robotsPath), 'site/robots.txt missing');
const robots = readFileSync(robotsPath, 'utf8');
assertIncludes(robots, 'User-agent: *', 'robots user-agent');
assertIncludes(robots, 'Allow: /', 'robots allow');
assertIncludes(robots, `Sitemap: ${siteUrl}sitemap.xml`, 'robots sitemap');

assert.ok(existsSync(sitemapPath), 'site/sitemap.xml missing');
const sitemap = readFileSync(sitemapPath, 'utf8');
assertIncludes(sitemap, `<loc>${siteUrl}</loc>`, 'sitemap root URL');
assertIncludes(sitemap, '<lastmod>2026-07-07</lastmod>', 'sitemap lastmod');
assertIncludes(sitemap, `href="${siteUrl}?lang=en"`, 'sitemap English alternate');
assertIncludes(sitemap, `href="${siteUrl}?lang=zh-Hant"`, 'sitemap Traditional Chinese alternate');
assertIncludes(sitemap, `href="${siteUrl}"`, 'sitemap default alternate');

assert.ok(existsSync(favicon32Path), '32px favicon file missing');
assert.ok(existsSync(favicon16Path), '16px favicon file missing');
assert.ok(existsSync(appleTouchIconPath), 'Apple touch icon file missing');
assert.ok(existsSync(siteIconPath), 'site brand icon file missing');

console.log('site SEO checks passed');
