// Annonce automatique des nouveautés : quand news.json contient des entrées plus récentes que la dernière annonce,
// envoie une notification sur le canal public d’annonces (ntfy). Les gens s’y abonnent depuis l’écran « Nouveautés ».
import fs from 'node:fs';

const TOPIC = JSON.parse(fs.readFileSync(new URL('./annonces-config.json', import.meta.url), 'utf8')).topic;
const SITE = 'https://cguensly99-source.github.io/Klinik-/';
const news = JSON.parse(fs.readFileSync('news.json', 'utf8'));
const mark = 'veille/announced.txt';
const last = fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8').trim() : '';
if (!news.length) { console.log('Aucune nouveauté.'); process.exit(0); }
const idx = last ? news.findIndex((n) => n.id === last) : -1;
const force = process.argv.includes('--force');
const todo = force ? news.slice(0, 1) : idx === -1 ? news.slice(0, 1) : news.slice(0, idx);
if (!todo.length) { console.log('Déjà annoncé :', last); process.exit(0); }

const lines = [];
for (const n of todo) { lines.push(n.title); for (const it of n.items || []) lines.push('• ' + it); lines.push(''); }
lines.push('Ouvre Klinik pour voir les nouveautés : ' + SITE);
const r = await fetch('https://ntfy.sh/', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ topic: TOPIC, title: 'Klinik : ' + todo[0].title, message: lines.join('\n').slice(0, 3800), tags: ['books'], priority: 3, click: SITE })
});
if (!r.ok) { console.error('ntfy a répondu', r.status); process.exit(1); }
fs.mkdirSync('veille', { recursive: true });
fs.writeFileSync(mark, news[0].id + '\n');
console.log('Annonce envoyée :', todo.map((n) => n.id).join(', '));
