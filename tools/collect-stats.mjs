// Compteur de visites de Klinik : lit les signaux anonymes gardés par ntfy (12 h) et les cumule dans un fichier.
// Lancé toutes les 3 heures par .github/workflows/stats.yml. Aucune donnée personnelle : seulement des comptes.
import fs from 'node:fs';
import crypto from 'node:crypto';
const cfg = JSON.parse(fs.readFileSync(new URL('./stats-config.json', import.meta.url), 'utf8'));
const dir = cfg.dir;
const statePath = `${dir}/state.json`, outPath = `${dir}/stats.json`;
const tz = 'America/Port-au-Prince';
const dayOf = (sec) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(sec * 1000));
const H = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const zero = () => ({ new: 0, back: 0, offres: 0, credit: 0, demandes: 0, actives: 0, guide: 0, essais: 0 });

let st = { since: dayOf(Date.now() / 1000), seen: [], days: {}, sources: {}, devices: {}, totals: zero(), tagsAsked: [], tagsActive: [], runs: 0 };
if (fs.existsSync(statePath)) st = { ...st, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) };
const seen = new Set(st.seen);

const url = `https://ntfy.sh/${cfg.topic}/json?poll=1&since=all`;
const res = await fetch(url, { headers: { 'User-Agent': 'klinik-stats/1' } });
if (!res.ok) { console.error('ntfy a répondu', res.status); process.exit(1); }
const lines = (await res.text()).split('\n').filter(Boolean);
let read = 0, added = 0;
for (const line of lines) {
  let m; try { m = JSON.parse(line); } catch { continue; }
  if (m.event !== 'message' || !m.id) continue;
  read++;
  if (seen.has(m.id)) continue;
  seen.add(m.id);
  const title = String(m.title || ''), body = String(m.message || ''), day = dayOf(m.time);
  const d = (st.days[day] ||= zero());
  const parts = body.split(' · ').map((x) => x.trim());
  const field = (p) => (parts.find((x) => x.startsWith(p)) || '').slice(p.length).trim();
  const tag = field('code client ').split(/[ .]/)[0];
  const bump = (k) => { d[k] = (d[k] || 0) + 1; st.totals[k] = (st.totals[k] || 0) + 1; added++; };
  if (title === 'Nouveau visiteur' || title === 'Visiteur de retour') {
    const isNew = title === 'Nouveau visiteur';
    bump(isNew ? 'new' : 'back');
    const src = (field('source :') || 'inconnue').toLowerCase(), dev = parts[1] || 'inconnu';
    const s = (st.sources[src] ||= { new: 0, visits: 0 }); s.visits++; if (isNew) s.new++;
    if (isNew) st.devices[dev] = (st.devices[dev] || 0) + 1;
  } else if (title.startsWith('Quelqu') && title.includes('offres')) bump('offres');
  else if (title === 'Crédit épuisé') bump('credit');
  else if (title.startsWith('Demande d’essai')) bump('essais');
  else if (title.startsWith('Demande d')) { bump('demandes'); if (tag && !st.tagsAsked.includes(H(tag))) st.tagsAsked.push(H(tag)); }
  else if (title === 'Code activé') { bump('actives'); if (tag && !st.tagsActive.includes(H(tag))) st.tagsActive.push(H(tag)); }
  else if (title === 'Guide ouvert') bump('guide');
  // « Test Klinik » et tout le reste : ignoré
}
st.seen = [...seen].slice(-3000);
st.runs++;
const now = new Date().toISOString();
fs.writeFileSync(statePath, JSON.stringify(st));
const pub = { since: st.since, updated: now, lastRead: read, lastAdded: added, runs: st.runs, days: st.days, sources: st.sources, devices: st.devices, totals: st.totals, clients: { asked: st.tagsAsked.length, activated: st.tagsActive.length } };
fs.writeFileSync(outPath, JSON.stringify(pub));
console.log(`ntfy : ${read} signaux lus, ${added} nouveaux. Total visites : ${st.totals.new + st.totals.back}.`);
