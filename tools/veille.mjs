// Veille médicale de Klinik : interroge PubMed (API officielle NCBI) pour chaque sujet suivi,
// garde les nouvelles recommandations et consensus, et remplit veille/feed.json (affiché dans « Nouveautés »).
// Option --links : vérifie aussi que les références citées par les fiches répondent encore.
// Rien n’est modifié dans les fiches : la veille SIGNALE, un humain relit avant d’intégrer.
import fs from 'node:fs';

const DIR = 'veille';
const watch = JSON.parse(fs.readFileSync(`${DIR}/watch.json`, 'utf8')); // [{id, system, title, terms:[...]}]
const cfg = JSON.parse(fs.readFileSync(new URL('./stats-config.json', import.meta.url), 'utf8'));
const statePath = `${DIR}/state.json`, feedPath = `${DIR}/feed.json`;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { seen: [], runs: 0 };
const feed = fs.existsSync(feedPath) ? JSON.parse(fs.readFileSync(feedPath, 'utf8')) : { items: [] };
const seen = new Set(state.seen);
const first = state.runs === 0;
const DAYS = first ? 45 : 21;
const EU = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'klinik-veille/1 (+https://cguensly99-source.github.io/Klinik-/)' } });
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue; }
      return null;
    } catch { await sleep(1500 * (i + 1)); }
  }
  return null;
}

// terme -> chapitres concernés
const byTerm = new Map();
for (const c of watch) for (const t of c.terms || []) {
  const k = t.toLowerCase();
  if (!byTerm.has(k)) byTerm.set(k, []);
  byTerm.get(k).push({ id: c.id, title: c.title, system: c.system });
}

const found = new Map(); // pmid -> {chapters:Map}
let queries = 0, failed = 0;
for (const [term, chapters] of byTerm) {
  const q = `("${term}"[Title]) AND (guideline*[Title] OR recommendation*[Title] OR consensus[Title] OR guideline[pt] OR "practice guideline"[pt]) AND (english[la] OR french[la])`;
  const url = `${EU}/esearch.fcgi?db=pubmed&retmode=json&retmax=15&sort=date&datetype=edat&reldate=${DAYS}&tool=klinik&term=${encodeURIComponent(q)}`;
  const j = await getJson(url); queries++;
  await sleep(400);
  if (!j || !j.esearchresult) { failed++; continue; }
  for (const id of j.esearchresult.idlist || []) {
    if (!found.has(id)) found.set(id, new Map());
    for (const ch of chapters) found.get(id).set(ch.id, ch);
  }
}

const fresh = [...found.keys()].filter((id) => !seen.has(id));
const added = [];
for (let i = 0; i < fresh.length; i += 40) {
  const ids = fresh.slice(i, i + 40);
  const j = await getJson(`${EU}/esummary.fcgi?db=pubmed&retmode=json&tool=klinik&id=${ids.join(',')}`);
  await sleep(400);
  if (!j || !j.result) { failed++; continue; }
  for (const id of ids) {
    const r = j.result[id]; if (!r || !r.title) continue;
    seen.add(id);
    if (/^\s*(erratum|correction|corrigendum|retraction|retracted|comment on|reply to|withdrawn)\b/i.test(r.title)) continue;
    added.push({
      pmid: id,
      title: String(r.title).replace(/\s+/g, ' ').trim().slice(0, 300),
      journal: String(r.fulljournalname || r.source || '').slice(0, 120),
      date: String(r.pubdate || r.epubdate || '').slice(0, 20),
      addedAt: new Date().toISOString().slice(0, 10),
      chapters: [...found.get(id).values()].slice(0, 6).map((c) => ({ id: c.id, title: c.title }))
    });
  }
}

const cutoff = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
feed.items = [...added, ...(feed.items || [])].filter((x) => x.addedAt >= cutoff).slice(0, 80);
feed.updated = new Date().toISOString();
feed.note = 'Publications repérées automatiquement dans PubMed. Signalées avant relecture : elles ne modifient pas les fiches.';

// Vérification des liens des références (facultative)
let links = null;
if (process.argv.includes('--links') && fs.existsSync(`${DIR}/refs.json`)) {
  const refs = JSON.parse(fs.readFileSync(`${DIR}/refs.json`, 'utf8')); // {url: [chapterIds]}
  const urls = Object.keys(refs);
  const broken = [];
  let idx = 0;
  const check = async (u) => {
    const ctl = (m) => fetch(u, { method: m, redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0 klinik-linkcheck/1' } });
    try {
      let r = await ctl('HEAD');
      if ([400, 403, 405, 429, 501].includes(r.status)) r = await ctl('GET');
      if (r.status === 404 || r.status === 410) broken.push({ url: u, status: r.status, chapters: refs[u].slice(0, 5) });
    } catch { /* réseau : on ne conclut pas */ }
  };
  await Promise.all(Array.from({ length: 6 }, async () => { while (idx < urls.length) await check(urls[idx++]); }));
  links = { checkedAt: new Date().toISOString(), total: urls.length, broken };
  fs.writeFileSync(`${DIR}/links.json`, JSON.stringify(links, null, 1));
}

state.seen = [...seen].slice(-4000);
state.runs++;
fs.writeFileSync(statePath, JSON.stringify(state));
fs.writeFileSync(feedPath, JSON.stringify(feed));
console.log(`veille : ${queries} requêtes (${failed} échecs), ${added.length} nouvelles publications, ${feed.items.length} dans le fil.` + (links ? ` Liens : ${links.total} vérifiés, ${links.broken.length} cassés.` : ''));

// Prévenir l’administrateur (même canal ntfy que les visites)
const lines = [];
if (added.length) lines.push(`${added.length} nouvelle(s) recommandation(s) repérée(s) :`, ...added.slice(0, 5).map((a) => `• ${a.title.slice(0, 110)} (${a.chapters[0] ? a.chapters[0].title.slice(0, 40) : ''})`));
if (links && links.broken.length) lines.push(`${links.broken.length} lien(s) de référence cassé(s) : ${links.broken.slice(0, 3).map((b) => b.url.slice(0, 70)).join(' ; ')}`);
if (lines.length && !first) {
  try {
    await fetch('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: cfg.topic, title: 'Veille Klinik', message: lines.join('\n').slice(0, 3500), tags: ['mag'], priority: 3, click: 'https://cguensly99-source.github.io/Klinik-/' }) });
  } catch { /* ignoré */ }
}
if (failed > queries / 2) { console.error('Trop d’échecs PubMed : voir les journaux.'); process.exit(1); }
