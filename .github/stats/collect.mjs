#!/usr/bin/env node
// Daily usage stats for Swissyphus, written as CSV to the directory given as argv[2]
// (the `stats` branch checkout). Run by .github/workflows/stats.yml.
//
//   npm.csv        date,downloads                     daily npm downloads (merged, newest wins)
//   releases.csv   date,tag,asset,downloads           cumulative GitHub Release asset downloads (.mcpb)
//   repo.csv       date,stars,forks,watchers,open_issues
//   views.csv      date,views,unique_visitors         GitHub repo page views   (needs STATS_TOKEN)
//   clones.csv     date,clones,unique_cloners         git clones               (needs STATS_TOKEN)
//   referrers.csv  date,referrer,views,unique         top referrers snapshot   (needs STATS_TOKEN)
//   README.md      summary
//
// GitHub keeps traffic data for 14 days only, so a daily run is what makes it a history.
// Container (GHCR) pulls have no public API and are not collected.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] || "stats-data";
const REPO = process.env.GITHUB_REPOSITORY || "cwellbournewood/swissyphus";
const PKG = process.env.NPM_PACKAGE || "swissyphus";
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const TRAFFIC_TOKEN = process.env.STATS_TOKEN || "";
const today = new Date().toISOString().slice(0, 10);

async function get(url, token) {
  const headers = { "User-Agent": "swissyphus-stats", Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
  return res.json();
}

async function readCsv(file) {
  const p = join(OUT, file);
  if (!existsSync(p)) return [];
  const [, ...lines] = (await readFile(p, "utf8")).trim().split("\n");
  return lines.filter(Boolean).map((l) => l.split(","));
}
async function writeCsv(file, header, rows) {
  await writeFile(join(OUT, file), [header, ...rows.map((r) => r.join(","))].join("\n") + "\n");
}
// Rows keyed by `keyLen` leading columns; new rows replace old ones with the same key.
async function merge(file, header, fresh, keyLen = 1) {
  const map = new Map((await readCsv(file)).map((r) => [r.slice(0, keyLen).join(","), r]));
  for (const r of fresh) map.set(r.slice(0, keyLen).join(","), r.map(String));
  const rows = [...map.values()].sort((a, b) => a.join(",").localeCompare(b.join(",")));
  await writeCsv(file, header, rows);
  return rows;
}
const csvSafe = (s) => String(s).replace(/[,\n\r]/g, " ");

await mkdir(OUT, { recursive: true });
const notes = [];

// npm: the last 30 days, so a missed run heals itself.
const npm = await get(`https://api.npmjs.org/downloads/range/last-month/${PKG}`);
const npmRows = await merge("npm.csv", "date,downloads", npm.downloads.map((d) => [d.day, d.downloads]));

// GitHub: repo counters and release asset downloads.
const repo = await get(`https://api.github.com/repos/${REPO}`, GH_TOKEN);
await merge("repo.csv", "date,stars,forks,watchers,open_issues",
  [[today, repo.stargazers_count, repo.forks_count, repo.subscribers_count, repo.open_issues_count]]);
const releases = await get(`https://api.github.com/repos/${REPO}/releases?per_page=100`, GH_TOKEN);
const assetRows = releases.flatMap((r) => r.assets.map((a) => [today, r.tag_name, csvSafe(a.name), a.download_count]));
const relRows = await merge("releases.csv", "date,tag,asset,downloads", assetRows, 3);

// Traffic: needs a token with read access to repository administration (GITHUB_TOKEN cannot).
let views = [], clones = [];
if (TRAFFIC_TOKEN) {
  const v = await get(`https://api.github.com/repos/${REPO}/traffic/views`, TRAFFIC_TOKEN);
  views = await merge("views.csv", "date,views,unique_visitors", v.views.map((x) => [x.timestamp.slice(0, 10), x.count, x.uniques]));
  const c = await get(`https://api.github.com/repos/${REPO}/traffic/clones`, TRAFFIC_TOKEN);
  clones = await merge("clones.csv", "date,clones,unique_cloners", c.clones.map((x) => [x.timestamp.slice(0, 10), x.count, x.uniques]));
  const refs = await get(`https://api.github.com/repos/${REPO}/traffic/popular/referrers`, TRAFFIC_TOKEN);
  await merge("referrers.csv", "date,referrer,views,unique", refs.map((x) => [today, csvSafe(x.referrer), x.count, x.uniques]), 2);
} else {
  notes.push("GitHub traffic (views, clones, referrers) is not collected: add a `STATS_TOKEN` secret (see the workflow).");
}

// Summary.
const sum = (rows, col, days) => rows.filter((r) => (Date.parse(today) - Date.parse(r[0])) / 864e5 <= days)
  .reduce((n, r) => n + Number(r[col]), 0);
const latestAssets = relRows.filter((r) => r[0] === today);
const mcpb = latestAssets.filter((r) => r[2].endsWith(".mcpb")).reduce((n, r) => n + Number(r[3]), 0);
const lines = [
  `# Swissyphus usage stats`, ``,
  `Updated ${today} by \`.github/workflows/stats.yml\` on \`main\`. Raw data: the CSV files in this branch.`, ``,
  `| Metric | Last 7 days | Last 30 days | All recorded |`, `|---|---:|---:|---:|`,
  `| npm downloads | ${sum(npmRows, 1, 7)} | ${sum(npmRows, 1, 30)} | ${sum(npmRows, 1, 1e6)} |`,
  ...(views.length ? [`| GitHub page views | ${sum(views, 1, 7)} | ${sum(views, 1, 30)} | ${sum(views, 1, 1e6)} |`,
    `| GitHub clones | ${sum(clones, 1, 7)} | ${sum(clones, 1, 30)} | ${sum(clones, 1, 1e6)} |`] : []),
  ``,
  `- \`.mcpb\` downloads, all releases (cumulative): **${mcpb}**`,
  `- Stars ${repo.stargazers_count} · forks ${repo.forks_count} · watchers ${repo.subscribers_count}`,
  ``,
  `npm counts include CI and mirror downloads, so read them as a trend, not as people. A local`,
  `install sends nothing back, so there is no count of active users by design.`,
  ...(notes.length ? [``, ...notes.map((n) => `> ${n}`)] : []),
];
await writeFile(join(OUT, "README.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
