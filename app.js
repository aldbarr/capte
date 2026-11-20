/* Capte – capture rapide de notes et tâches (perso / pro), voix ou texte.
   Hors ligne d'abord : copie locale + synchronisation avec Supabase (Postgres) quand on est connecté. */
(() => {
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const KEY_ITEMS = 'capte.items', KEY_SET = 'capte.settings', KEY_PENDING = 'capte.pending';
const TABLE = 'capte_items';
const I18N = window.CAPTE_I18N;

// ---------- Stockage local ----------
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { toast(t('storageFail')); } };
const nowIso = () => new Date().toISOString();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

const detectLang = () => { const l = (navigator.language || 'fr').slice(0, 2); return I18N[l] ? l : 'fr'; };
let settings = Object.assign({ apiKey: '', model: 'claude-haiku-4-5', lang: detectLang(), speechLang: 'auto', lastDomain: 'perso', dbUrl: '', dbKey: '', lastSync: null, lastExport: null }, load(KEY_SET, {}));
if (settings.lang && settings.lang.includes('-')) { settings.speechLang = settings.lang; settings.lang = settings.lang.slice(0, 2); } // migration v1
let items = load(KEY_ITEMS, []).map(i => ({ updatedAt: i.createdAt, deleted: false, doneAt: null, ...i }));
let pending = new Set(load(KEY_PENDING, []));
const live = () => items.filter(i => !i.deleted);
const saveSettings = () => save(KEY_SET, settings);

// ---------- Traductions ----------
function t(key, vars) {
  let s = (I18N[settings.lang] || I18N.fr)[key] ?? I18N.fr[key] ?? key;
  if (vars) for (const k in vars) s = s.replace('{' + k + '}', vars[k]);
  return s;
}
const L = () => I18N[settings.lang] || I18N.fr;
function applyI18n() {
  document.documentElement.lang = settings.lang;
  $$('[data-i18n]').forEach(e => { e.textContent = t(e.dataset.i18n); });
  $$('[data-i18n-ph]').forEach(e => { e.placeholder = t(e.dataset.i18nPh); });
  $$('[data-i18n-aria]').forEach(e => { e.setAttribute('aria-label', t(e.dataset.i18nAria)); });
  setRecHint();
  render(); renderSync(); renderAccount();
}

// ---------- Dates ----------
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fromIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const diffDays = s => Math.round((fromIso(s) - today0()) / 864e5);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function fmtDue(due, time) {
  if (!due) return '';
  const n = diffDays(due), d = fromIso(due);
  let s;
  if (n === 0) s = t('today');
  else if (n === 1) s = t('tomorrow');
  else if (n === -1) s = t('yesterday');
  else if (n > 1 && n < 7) s = cap(d.toLocaleDateString(L().locale, { weekday: 'long' }));
  else s = d.toLocaleDateString(L().locale, { day: 'numeric', month: 'short', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
  return time ? `${s} · ${time}` : s;
}

// ---------- Compréhension des dates (FR / EN / DE) ----------
const norm = s => s.normalize('NFC').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/’/g, "'");
const WEEKDAYS = { dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6 };
const MONTHS = [
  ['janvier', 'janv', 'january', 'jan', 'januar'], ['fevrier', 'fevr', 'fev', 'february', 'feb', 'februar'], ['mars', 'march', 'mar', 'marz'],
  ['avril', 'avr', 'april', 'apr'], ['mai', 'may'], ['juin', 'june', 'jun', 'juni'], ['juillet', 'juil', 'july', 'jul', 'juli'],
  ['aout', 'august', 'aug'], ['septembre', 'sept', 'sep', 'september'], ['octobre', 'oct', 'october', 'oktober', 'okt'],
  ['novembre', 'nov', 'november'], ['decembre', 'dec', 'december', 'dezember', 'dez']];
const monthIdx = w => MONTHS.findIndex(a => a.includes(w));
const NUMS = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, dix: 10, quinze: 15,
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, seven: 7, ten: 10, einem: 1, einer: 1, zwei: 2, drei: 3, vier: 4, funf: 5, zehn: 10 };
const PRE = '(?:(?:le|ce|pour|avant|d\'ici|on|by|this|next|before|am|bis|diesen|nachsten|kommenden) )?';

function parseWhen(text) {
  text = text.normalize('NFC');
  const n = norm(text), t0 = today0();
  let due = null, time = null; const spans = [];
  const take = (re, fn) => {
    if (due) return;
    for (const m of n.matchAll(new RegExp(re.source, 'g'))) {
      const r = fn(m); if (r) { due = iso(r); spans.push(text.substr(m.index, m[0].length)); return; }
    }
  };
  take(new RegExp('\\b' + PRE + "(aujourd'hui|ce soir|ce matin|cet apres-midi|today|tonight|this (?:morning|afternoon|evening)|heute(?: abend| nachmittag| morgen)?)\\b"), () => t0);
  take(new RegExp('\\b' + PRE + '(apres[- ]?demain|the day after tomorrow|day after tomorrow|ubermorgen)\\b'), () => addDays(t0, 2));
  take(new RegExp('\\b' + PRE + '(demain|tomorrow|morgen)\\b'), () => addDays(t0, 1));
  take(/\b(?:dans|in) (\d+|un|une|deux|trois|quatre|cinq|six|sept|huit|dix|quinze|a|an|one|two|three|four|five|seven|ten|einem|einer|zwei|drei|vier|funf|zehn) (jours?|semaines?|mois|days?|weeks?|months?|tagen?|wochen?|monaten?|monat)\b/, m => {
    const k = NUMS[m[1]] ?? parseInt(m[1], 10), u = m[2];
    if (/^(jour|day|tag)/.test(u)) return addDays(t0, k);
    if (/^(sem|week|woch)/.test(u)) return addDays(t0, 7 * k);
    const d = new Date(t0); d.setMonth(d.getMonth() + k); return d;
  });
  take(/\b(la semaine prochaine|semaine prochaine|next week|nachste woche|kommende woche)\b/, () => addDays(t0, ((8 - t0.getDay()) % 7) || 7));
  take(/\b(ce week-?end|this weekend|am wochenende|dieses wochenende)\b/, () => addDays(t0, (6 - t0.getDay() + 7) % 7));
  take(/\b(fin (?:du|de) mois|end of (?:the )?month|ende des monats|monatsende)\b/, () => new Date(t0.getFullYear(), t0.getMonth() + 1, 0));
  const mkDate = (day, mi, year) => {
    if (mi < 0 || day < 1 || day > 31) return null;
    const d = new Date(year || t0.getFullYear(), mi, day);
    if (!year && d < t0) d.setFullYear(d.getFullYear() + 1);
    return d;
  };
  take(new RegExp('\\b' + PRE + "(1er|\\d{1,2})(?:st|nd|rd|th)?\\.? (?:of )?([a-z]{3,9})\\.?(?: (\\d{4}))?\\b"), m => mkDate(m[1] === '1er' ? 1 : +m[1], monthIdx(m[2]), m[3] && +m[3]));
  take(/\b(?:on )?([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?\b/, m => mkDate(+m[2], monthIdx(m[1]), m[3] && +m[3]));
  take(new RegExp('\\b' + PRE + '(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{2,4}))?\\b'), m => {
    let y = m[3] ? +m[3] : null; if (y && y < 100) y += 2000;
    return +m[2] >= 1 && +m[2] <= 12 ? mkDate(+m[1], +m[2] - 1, y) : null;
  });
  take(new RegExp('\\b' + PRE + '(' + Object.keys(WEEKDAYS).join('|') + ')(?: prochain)?\\b'), m => {
    let k = (WEEKDAYS[m[1]] - t0.getDay() + 7) % 7; if (k === 0) k = 7;
    return addDays(t0, k);
  });

  const tm = /(?:(?:^|\s)(?:a|vers|pour|at|um|gegen|around) )?\b(\d{1,2})(?:(?: ?h(?:eures?)?| ?uhr|:)(?: ?(\d{2}))?|\s?(am|pm))(?![a-z0-9])/.exec(n);
  if (tm && +tm[1] < 24) {
    let h = +tm[1];
    if (tm[3] === 'pm' && h < 12) h += 12; if (tm[3] === 'am' && h === 12) h = 0;
    time = `${pad(h)}:${pad(tm[2] ? +tm[2] : 0)}`; spans.push(text.substr(tm.index, tm[0].length));
  } else {
    const mm = /(?:^|\s)(a midi|at noon|um mittag|mittags)\b/.exec(n);
    if (mm) { time = '12:00'; spans.push(text.substr(mm.index, mm[0].length)); }
  }
  if (time && !due) due = iso(t0);
  return { due, time, spans };
}

// ---------- Tri par règles (FR / EN / DE) ----------
const FR_VERBS = 'appeler|rappeler|telephoner|envoyer|acheter|reserver|payer|prendre|relancer|ecrire|repondre|preparer|commander|contacter|faire|verifier|planifier|organiser|inscrire|annuler|confirmer|renouveler|imprimer|signer|reparer|ranger|chercher|recuperer|demander|finir|terminer|mettre|lire|valider|fixer|caler|regler|deposer|amener|emmener|aller|passer|nettoyer|laver|changer|trouver|programmer|transmettre|partager|publier|livrer|facturer|resilier|souscrire|telecharger|installer';
const EN_VERBS = 'call|email|e-mail|send|buy|book|pay|reply|answer|prepare|order|contact|check|schedule|plan|cancel|confirm|renew|print|sign|fix|repair|pick up|ask|finish|submit|review|write|read|clean|find|update|follow up|get|make|go|bring|take|text|invoice';
const DE_VERBS = 'anrufen|zuruckrufen|schicken|senden|kaufen|buchen|bezahlen|zahlen|beantworten|antworten|vorbereiten|bestellen|kontaktieren|prufen|kundigen|bestatigen|drucken|unterschreiben|reparieren|abholen|erledigen|fragen|schreiben|aufraumen|putzen|vereinbaren|organisieren|einreichen|uberweisen|mailen|reservieren|absagen';
const RE_TASK = new RegExp(
  `(^|[.!?]\\s*)(${FR_VERBS}|${EN_VERBS})\\b` +
  `|\\b(${DE_VERBS})\\b` +
  `|\\b(il faut|faut que|faudrait|je dois|on doit|penser a|pense a|n'oublie|rappelle[- ]?moi|a faire|ne pas oublier` +
  `|need to|have to|i must|remind me|don'?t forget|todo|to-do|to do|deadline|urgent|asap` +
  `|ich muss|muss ich|wir mussen|erinnere mich|nicht vergessen|denk an|denke an|dringend)\\b`);
const RE_NOTE = /\b(idee|idea|note|notiz|pour info|fyi|j'ai appris|i learned|gelernt|remarque|reflexion|souvenir|citation|quote|zitat|a retenir|bon a savoir|good to know|gut zu wissen|interessant|interesting|j'ai lu|i read|apparemment|apparently)\b/;
const PRO = ['client', 'clients', 'reunion', 'meeting', 'call', 'popety', 'devis', 'collegue', 'collaborateur', 'projet', 'rapport', 'presentation', 'equipe', 'deal', 'prospect', 'contrat', 'offre', 'parcelle', 'notaire', 'commune', 'architecte', 'promoteur', 'boss', 'manager', 'board', 'investisseur', 'kpi', 'linkedin', 'pipedrive', 'demo', 'onboarding', 'recrutement', 'candidat', 'salon', 'conference', 'partenaire', 'fournisseur', 'sprint', 'roadmap', 'feature', 'bug', 'release', 'bureau', 'boulot', 'travail', 'pro',
  'customer', 'customers', 'colleague', 'project', 'report', 'team', 'contract', 'proposal', 'quote', 'invoice', 'office', 'work', 'notary', 'investor', 'supplier', 'hiring', 'candidate', 'webinar',
  'kunde', 'kunden', 'besprechung', 'sitzung', 'kollege', 'kollegin', 'projekt', 'bericht', 'prasentation', 'vertrag', 'angebot', 'offerte', 'rechnung', 'buro', 'arbeit', 'notar', 'chef', 'lieferant', 'parzelle'];
const PERSO = ['famille', 'enfant', 'enfants', 'fils', 'fille', 'femme', 'mari', 'maman', 'papa', 'parents', 'maison', 'appart', 'courses', 'medecin', 'dentiste', 'pediatre', 'pharmacie', 'anniversaire', 'vacances', 'sport', 'foot', 'gym', 'ecole', 'creche', 'garderie', 'voiture', 'garage', 'jardin', 'cadeau', 'resto', 'restaurant', 'apero', 'soiree', 'amis', 'copain', 'week-end', 'weekend', 'impots', 'loyer', 'chien', 'chat', 'velo', 'film', 'livre', 'recette', 'perso', 'noel', 'mariage', 'bapteme',
  'family', 'kids', 'son', 'daughter', 'wife', 'husband', 'mum', 'mom', 'dad', 'home', 'groceries', 'doctor', 'dentist', 'pharmacy', 'birthday', 'holiday', 'holidays', 'vacation', 'school', 'car', 'garden', 'gift', 'present', 'friends', 'dog', 'cat', 'bike', 'movie', 'book', 'recipe', 'christmas', 'wedding',
  'familie', 'kinder', 'kind', 'sohn', 'tochter', 'frau', 'mann', 'mama', 'zuhause', 'wohnung', 'einkaufen', 'arzt', 'zahnarzt', 'apotheke', 'geburtstag', 'ferien', 'urlaub', 'schule', 'kita', 'auto', 'garten', 'geschenk', 'freunde', 'hund', 'katze', 'velo', 'rezept', 'weihnachten', 'hochzeit', 'steuern', 'miete'];
const RE_PRO = new RegExp(`\\b(${PRO.join('|')})\\b`, 'g'), RE_PERSO = new RegExp(`\\b(${PERSO.join('|')})\\b`, 'g');
const SUBJ = { prenne: 'prendre', fasse: 'faire', aille: 'aller', appelle: 'appeler', rappelle: 'rappeler', envoie: 'envoyer', renvoie: 'renvoyer', écrive: 'écrire', réponde: 'répondre', voie: 'voir', finisse: 'finir', mette: 'mettre', lise: 'lire', achète: 'acheter', paie: 'payer', paye: 'payer', règle: 'régler', vende: 'vendre', dise: 'dire', puisse: 'pouvoir', parte: 'partir', sorte: 'sortir', rende: 'rendre', attende: 'attendre', choisisse: 'choisir', remplisse: 'remplir' };
const toInfinitive = w => { const l = w.toLowerCase(); return SUBJ[l] || (/e$/.test(l) ? l + 'r' : w); };
const RE_PREFIX = /^(note\s*:|notiz\s*:|id[ée]e\s*:|idea\s*:|todo\s*:|to-?do\s*:|t[aâ]che\s*:|task\s*:|aufgabe\s*:)\s*|^(rappelle[- ]?moi (de |d['’])|il faut que (je |j['’])?|il faut |faut que (je |j['’])?|je dois |penser [àa] |pense [àa] |n['’]oublie pas (de |d['’])|ne pas oublier (de |d['’])|remind me to |i need to |i have to |need to |have to |don['’]?t forget to |i must |erinnere mich(,? daran)?,? (dass ich |zu )?|ich muss |nicht vergessen:? |denke? an )/i;

function ruleClassify(text) {
  text = text.normalize('NFC').trim();
  const n = norm(text), w = parseWhen(text);
  let score = RE_TASK.test(n) ? 2 : 0;
  if (w.due) score += 1;
  if (RE_NOTE.test(n)) score -= 2;
  const type = score >= 1 ? 'task' : 'note';
  const p = (n.match(RE_PRO) || []).length, q = (n.match(RE_PERSO) || []).length;
  const domain = p > q ? 'pro' : q > p ? 'perso' : settings.lastDomain;

  let clean = text, prev;
  do { prev = clean; clean = clean.replace(RE_PREFIX, ''); } while (clean !== prev);
  if (/^(il faut que|faut que)/i.test(text)) clean = clean.replace(/^(\S+)/, toInfinitive);
  const first = clean.split(/(?<=[.!?])\s|\n/)[0];
  let title = first;
  if (type === 'task') for (const s of w.spans) title = title.replace(s, ' ');
  title = title.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').replace(/^[,\s]+|[,\s]+$/g, '').trim();
  title = title.replace(/\s+(by|on|at|before|until|pour|avant|le|au|d'ici|jusqu'[àa]|bis|am|um|vor)$/i, '').trim();
  if (title.length > 90) title = title.slice(0, 87).replace(/\s\S*$/, '') + '…';
  title = cap(title) || text.slice(0, 60);
  let body = (type === 'note' || clean.length > first.length + 2) ? text : '';
  if (body === title) body = '';
  return { type, domain, title, body, due: type === 'task' ? w.due : null, time: type === 'task' ? w.time : null };
}

// ---------- Tri par Claude (optionnel) ----------
async function aiClassify(text) {
  const d = new Date();
  const system = `You sort one entry (dictated or typed) for Aldo's notes app. Aldo lives in French-speaking Switzerland and works at Popety.io (proptech, real estate). He writes in French, English or German.
Current date and time: ${d.toLocaleDateString('en-GB', { weekday: 'long' })} ${iso(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}.
Reply ONLY with a JSON object, no other text:
{"type":"task"|"note","domain":"perso"|"pro","title":"short title; for a task an action verb, without the date","body":"useful details or cleaned-up text, otherwise empty string","due":"YYYY-MM-DD" or null,"time":"HH:MM" or null}
Rules: "task" if the entry implies something to do, otherwise "note". Write title and body in the SAME language as the entry. Fix obvious transcription mistakes. If the domain is unclear, use "${settings.lastDomain}". A note always has due=null.`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: settings.model, max_tokens: 500, system, messages: [{ role: 'user', content: text }] })
  });
  if (!r.ok) throw new Error('API ' + r.status);
  const j = await r.json();
  const raw = (j.content || []).map(c => c.text || '').join('');
  const o = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  return {
    type: o.type === 'note' ? 'note' : 'task', domain: o.domain === 'pro' ? 'pro' : 'perso',
    title: String(o.title || text).trim(), body: String(o.body || '').trim(),
    due: /^\d{4}-\d{2}-\d{2}$/.test(o.due || '') ? o.due : null, time: /^\d{2}:\d{2}$/.test(o.time || '') ? o.time : null
  };
}

// ---------- Modifications (toujours locales d'abord, puis envoyées à la base) ----------
function commit(it) {
  it.updatedAt = nowIso();
  if (!items.includes(it)) items.unshift(it);
  pending.add(it.id);
  save(KEY_ITEMS, items); save(KEY_PENDING, [...pending]);
  render(); scheduleSync();
}

// ---------- Base de données (Supabase) ----------
const cfg = window.CAPTE_CONFIG || {};
let sb = null, session = null, syncing = false, syncState = 'local', syncTimer = null, lastErr = '';
function dbUrl() { return (settings.dbUrl || cfg.supabaseUrl || '').trim(); }
function dbKey() { return (settings.dbKey || cfg.supabaseAnonKey || '').trim(); }
function initDb() {
  sb = null; session = null;
  if (!dbUrl() || !dbKey() || !window.supabase) { setSync('local'); renderAccount(); return; }
  try { sb = window.supabase.createClient(dbUrl(), dbKey(), { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'capte.auth' } }); }
  catch (e) { sb = null; lastErr = e.message; setSync('err'); return; }
  sb.auth.getSession().then(({ data }) => { session = data && data.session; renderAccount(); session ? sync() : setSync('login'); });
  sb.auth.onAuthStateChange((_ev, s) => { session = s; renderAccount(); renderSync(); });
}
const toRow = i => ({ id: i.id, user_id: session.user.id, type: i.type, domain: i.domain, title: i.title, body: i.body || '', due: i.due || null, time: i.time || null,
  done: !!i.done, done_at: i.doneAt || null, created_at: i.createdAt, updated_at: i.updatedAt || i.createdAt, deleted: !!i.deleted });
const fromRow = r => ({ id: r.id, type: r.type, domain: r.domain, title: r.title, body: r.body || '', due: r.due || null, time: r.time || null,
  done: !!r.done, doneAt: r.done_at || null, createdAt: r.created_at, updatedAt: r.updated_at, deleted: !!r.deleted });
const ts = s => Date.parse(s || 0) || 0;

function scheduleSync(delay = 800) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, delay); }
async function sync() {
  if (!sb) { setSync('local'); return; }
  if (!session) { setSync('login'); return; }
  if (!navigator.onLine) { setSync('off'); return; }
  if (syncing) { scheduleSync(1500); return; }
  syncing = true; setSync('sync');
  try {
    // 1. Envoi des modifications locales
    const ids = [...pending];
    const rows = items.filter(i => pending.has(i.id)).map(toRow);
    for (let k = 0; k < rows.length; k += 500) {
      const { error } = await sb.from(TABLE).upsert(rows.slice(k, k + 500), { onConflict: 'id' });
      if (error) throw error;
    }
    ids.forEach(id => pending.delete(id)); save(KEY_PENDING, [...pending]);
    // 2. Récupération de tout ce qui est en base (par pages de 1000)
    const remote = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from(TABLE).select('*').order('created_at', { ascending: true }).range(from, from + 999);
      if (error) throw error;
      remote.push(...data); if (data.length < 1000) break;
    }
    // 3. Fusion : la version la plus récente gagne ; rien de local n'est jamais jeté
    const byId = new Map(items.map(i => [i.id, i]));
    const seen = new Set();
    for (const r of remote) {
      seen.add(r.id);
      const loc = byId.get(r.id);
      if (!loc || (!pending.has(r.id) && ts(r.updated_at) > ts(loc.updatedAt))) byId.set(r.id, fromRow(r));
    }
    for (const i of items) if (!seen.has(i.id)) pending.add(i.id); // présent ici mais pas en base → on l'enverra
    items = [...byId.values()];
    save(KEY_ITEMS, items); save(KEY_PENDING, [...pending]);
    settings.lastSync = nowIso(); saveSettings();
    render(); renderAccount();
    setSync(pending.size ? 'sync' : 'ok');
    if (pending.size) { syncing = false; return scheduleSync(300); }
  } catch (e) {
    lastErr = e.message || String(e); setSync(navigator.onLine ? 'err' : 'off');
    scheduleSync(30000);
  } finally { syncing = false; }
}
function setSync(s) { syncState = s; renderSync(); }
function renderSync() {
  const p = $('#syncPill'); if (!p) return;
  const map = { ok: ['ok', 'stOk'], sync: ['sync', 'stSync'], off: ['off', 'stOff'], local: ['', 'stLocal'], err: ['err', 'stErr'], login: ['off', 'stLogin'] };
  const [cls, key] = map[syncState] || map.local;
  p.className = 'pill ' + cls; p.querySelector('span').textContent = t(key);
  p.title = syncState === 'err' ? t('syncErr', { e: lastErr }) : '';
  $('#loginBanner').classList.toggle('hidden', !(sb && !session));
}
function renderAccount() {
  if (!$('#accNoDb')) return;
  $('#accNoDb').classList.toggle('hidden', !!sb);
  $('#accOut').classList.toggle('hidden', !sb || !!session);
  $('#accIn').classList.toggle('hidden', !sb || !session);
  if (session) $('#aWho').textContent = session.user.email;
  $('#aLast').textContent = t('lastSync', { t: settings.lastSync ? new Date(settings.lastSync).toLocaleString(L().locale) : t('never') });
}
$('#syncPill').onclick = () => { if (syncState === 'err') toast(t('syncErr', { e: lastErr })); if (sb && session) sync(); else openSettings(); };
$('#loginBanner').onclick = () => openSettings();
const creds = () => { const e = $('#aEmail').value.trim(), p = $('#aPass').value; if (!e || !p) { toast(t('fillCreds')); return null; } return { email: e, password: p }; };
$('#aSignIn').onclick = async () => {
  const c = creds(); if (!c) return;
  const { data, error } = await sb.auth.signInWithPassword(c);
  if (error) return toast(error.message);
  session = data.session; for (const i of items) pending.add(i.id); save(KEY_PENDING, [...pending]); // envoie les données déjà sur l'appareil
  $('#aPass').value = ''; renderAccount(); toast(t('signedIn')); sync();
};
$('#aSignUp').onclick = async () => {
  const c = creds(); if (!c) return;
  const { data, error } = await sb.auth.signUp(c);
  if (error) return toast(error.message);
  if (data.session) { session = data.session; for (const i of items) pending.add(i.id); renderAccount(); toast(t('signedIn')); sync(); }
  else toast(t('signUpCheck'));
};
$('#aSignOut').onclick = async () => {
  if (pending.size && !await askConfirm(t('pendingWarn', { n: pending.size }), t('signOut'))) return;
  await sb.auth.signOut(); session = null;
  items = []; pending.clear(); save(KEY_ITEMS, items); save(KEY_PENDING, []); // les données restent en base
  renderAccount(); render(); setSync('login'); toast(t('signedOut'));
};
$('#aSync').onclick = () => sync();
window.addEventListener('online', () => sync());
window.addEventListener('offline', () => setSync('off'));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
setInterval(() => { if (document.visibilityState === 'visible' && session) sync(); }, 60000);

// ---------- Dictée ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recording = false, baseText = '';
const speechLang = () => settings.speechLang === 'auto' ? L().speech : settings.speechLang;
let claudeDict = null, dictFinal = '';
function startClaudeDict() {
  baseText = $('#input').value ? $('#input').value.replace(/\s*$/, ' ') : ''; dictFinal = '';
  claudeDict.start().catch(e => { setRec(false); if (String(e && (e.code || e.message || e)).includes('not_granted')) toast(t('micDenied')); });
  setRec(true);
}
function startRec() {
  if (claudeDict) return startClaudeDict();
  if (!SR) { toast(t('dictUnavailable')); $('#input').focus(); return; }
  rec = new SR(); rec.lang = speechLang(); rec.interimResults = true; rec.continuous = true;
  baseText = $('#input').value ? $('#input').value.replace(/\s*$/, ' ') : '';
  rec.onresult = e => {
    let fin = '', interim = '';
    for (let i = 0; i < e.results.length; i++) (e.results[i].isFinal ? (fin += e.results[i][0].transcript) : (interim += e.results[i][0].transcript));
    $('#input').value = (baseText + fin + interim).replace(/^\s+/, ''); onInput();
  };
  rec.onerror = e => { if (e.error === 'not-allowed') toast(t('micDenied')); else if (e.error !== 'no-speech' && e.error !== 'aborted') toast(t('dictErr', { e: e.error })); };
  rec.onend = () => setRec(false);
  try { rec.start(); setRec(true); } catch { setRec(false); }
}
function stopRec() { if (claudeDict) { claudeDict.stop().catch(() => {}); return; } if (rec) rec.stop(); setRec(false); }
function setRecHint() { $('#micHint').textContent = recording ? t('hintRec') : (SR || claudeDict ? t('hintIdle') : t('hintNoSR')); }
function setRec(on) {
  const was = recording; recording = on;
  $('#btnMic').classList.toggle('rec', on); setRecHint();
  if (was && !on && $('#input').value.trim()) analyse();
}
$('#btnMic').onclick = () => recording ? stopRec() : startRec();

// ---------- Capture & proposition ----------
let draft = null;
function onInput() { $('#btnAnalyse').disabled = !$('#input').value.trim(); }
$('#input').addEventListener('input', onInput);
$('#input').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) analyse(); });
$('#btnAnalyse').onclick = analyse;
async function analyse() {
  const text = $('#input').value.trim(); if (!text) return;
  let source = t('sourceRules');
  $('#btnAnalyse').disabled = true; $('#btnAnalyse').textContent = t('analysing');
  try {
    if (settings.apiKey) { draft = await aiClassify(text); source = t('sourceAI'); } else draft = ruleClassify(text);
  } catch (err) { draft = ruleClassify(text); source = t('sourceAIFail', { e: err.message }); }
  $('#btnAnalyse').textContent = t('continue'); onInput();
  draft.raw = text; showDraft(source);
}
function setSeg(sel, v) { $$(sel + ' button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); }
function showDraft(source) {
  setSeg('.seg[data-field=type]', draft.type); setSeg('.seg[data-field=domain]', draft.domain);
  $('#pTitle').value = draft.title; $('#pBody').value = draft.body || '';
  $('#pDue').value = draft.due || ''; $('#pTime').value = draft.time || '';
  $('#pDueRow').classList.toggle('hidden', draft.type !== 'task');
  $('#pSource').textContent = source + t('editHint');
  $('#proposal').classList.remove('hidden');
  $('#proposal').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$$('.seg[data-field] button').forEach(b => b.onclick = () => {
  const f = b.parentElement.dataset.field; draft[f] = b.dataset.v; setSeg(`.seg[data-field=${f}]`, b.dataset.v);
  if (f === 'type') {
    $('#pDueRow').classList.toggle('hidden', draft.type !== 'task');
    if (draft.type === 'task' && !$('#pDue').value) { const w = parseWhen(draft.raw); $('#pDue').value = w.due || ''; $('#pTime').value = w.time || ''; }
  }
});
$('#btnCancel').onclick = () => { $('#proposal').classList.add('hidden'); draft = null; };
$('#btnSave').onclick = () => {
  if (!draft) return;
  const it = {
    id: uid(), type: draft.type, domain: draft.domain,
    title: $('#pTitle').value.trim() || draft.raw.slice(0, 60), body: $('#pBody').value.trim(),
    due: draft.type === 'task' ? ($('#pDue').value || null) : null, time: draft.type === 'task' ? ($('#pTime').value || null) : null,
    done: false, doneAt: null, createdAt: nowIso(), deleted: false
  };
  settings.lastDomain = it.domain; saveSettings();
  commit(it);
  $('#input').value = ''; onInput(); $('#proposal').classList.add('hidden'); draft = null;
  toast(t(it.type === 'task' ? 'taskAdded' : 'noteSaved', { d: t(it.domain).toLowerCase() }));
};

// ---------- Rendu ----------
const filters = { tasks: 'all', notes: 'all' };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function itemHTML(it) {
  const late = it.type === 'task' && !it.done && it.due && diffDays(it.due) < 0;
  const meta = [`<span class="tag ${it.domain}">${esc(t(it.domain))}</span>`];
  if (it.type === 'task' && it.due) meta.push(`<span class="${late ? 'late' : ''}">${esc(fmtDue(it.due, it.time))}</span>`);
  if (it.type === 'note') meta.push(`<span>${new Date(it.createdAt).toLocaleDateString(L().locale, { day: 'numeric', month: 'short' })}</span>`);
  return `<li class="item ${it.domain} ${it.done ? 'done' : ''}" data-id="${esc(it.id)}">
    ${it.type === 'task' ? `<span class="box" role="checkbox" aria-checked="${!!it.done}"></span>` : ''}
    <div class="c"><div class="t">${esc(it.title)}</div><div class="m">${meta.join('')}</div>${it.body ? `<div class="b">${esc(it.body)}</div>` : ''}</div></li>`;
}
function taskOrder(a, b) {
  const da = a.due ? a.due + (a.time || '99') : '9999', db = b.due ? b.due + (b.time || '99') : '9999';
  return da < db ? -1 : da > db ? 1 : (b.createdAt || '').localeCompare(a.createdAt || '');
}
function bucket(it) {
  if (!it.due) return t('noDate');
  const n = diffDays(it.due);
  return n < 0 ? t('late') : n === 0 ? t('today') : n === 1 ? t('tomorrow') : n < 7 ? t('thisWeek') : t('later');
}
function render() {
  const all = live();
  const open = all.filter(i => i.type === 'task' && !i.done);
  const urgent = open.filter(i => i.due && diffDays(i.due) <= 0).length;
  $('#taskCount').textContent = urgent || '';

  const tf = filters.tasks;
  let tasks = all.filter(i => i.type === 'task' && (tf === 'all' || i.domain === tf));
  const done = tasks.filter(i => i.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
  tasks = tasks.filter(i => !i.done).sort(taskOrder);
  let html = '', cur = null;
  for (const it of tasks) { const g = bucket(it); if (g !== cur) { html += `<li class="group">${esc(g)}</li>`; cur = g; } html += itemHTML(it); }
  if ($('#showDone').checked && done.length) html += `<li class="group">${esc(t('doneGroup'))}</li>` + done.map(itemHTML).join('');
  $('#taskList').innerHTML = html || `<li class="empty">${esc(t('emptyTasks'))}</li>`;

  const nf = filters.notes, q = norm($('#search').value.trim());
  const notes = all.filter(i => i.type === 'note' && (nf === 'all' || i.domain === nf) && (!q || norm(i.title + ' ' + (i.body || '')).includes(q)))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  $('#noteList').innerHTML = notes.map(itemHTML).join('') || `<li class="empty">${esc(t(q ? 'noResults' : 'emptyNotes'))}</li>`;

  const focus = open.filter(i => i.due && diffDays(i.due) <= 0).sort(taskOrder);
  if (typeof renderBackupInfo === 'function') renderBackupInfo();
  $('#today').innerHTML = focus.length ? `<div class="group">${esc(t('todayBlock'))}</div><ul class="list">${focus.map(itemHTML).join('')}</ul>` : '';
}
document.addEventListener('click', e => {
  const li = e.target.closest('.item'); if (!li) return;
  const it = items.find(i => i.id === li.dataset.id); if (!it) return;
  if (e.target.classList.contains('box')) {
    it.done = !it.done; it.doneAt = it.done ? nowIso() : null; commit(it);
    if (it.done) toast(t('doneToast'));
    return;
  }
  openEdit(it);
});

// ---------- Édition ----------
let editing = null;
function openEdit(it) {
  editing = { ...it };
  setSeg('.seg[data-efield=type]', it.type); setSeg('.seg[data-efield=domain]', it.domain);
  $('#eTitle').value = it.title; $('#eBody').value = it.body || '';
  $('#eDue').value = it.due || ''; $('#eTime').value = it.time || '';
  $('#eDueRow').classList.toggle('hidden', it.type !== 'task');
  $('#dlgEdit').showModal();
}
$$('.seg[data-efield] button').forEach(b => b.onclick = () => {
  const f = b.parentElement.dataset.efield; editing[f] = b.dataset.v; setSeg(`.seg[data-efield=${f}]`, b.dataset.v);
  if (f === 'type') $('#eDueRow').classList.toggle('hidden', editing.type !== 'task');
});
$('#eSave').onclick = () => {
  const it = items.find(i => i.id === editing.id);
  Object.assign(it, { type: editing.type, domain: editing.domain, title: $('#eTitle').value.trim() || it.title, body: $('#eBody').value.trim(),
    due: editing.type === 'task' ? ($('#eDue').value || null) : null, time: editing.type === 'task' ? ($('#eTime').value || null) : null });
  if (it.type === 'note') { it.done = false; it.doneAt = null; }
  commit(it); $('#dlgEdit').close();
};
$('#eClose').onclick = () => $('#dlgEdit').close();
$('#eDelete').onclick = async () => {
  if (!await askConfirm(t('confirmDelete'), t('delete'))) return;
  const it = items.find(i => i.id === editing.id); it.deleted = true; // suppression douce, conservée en base
  commit(it); $('#dlgEdit').close(); toast(t('deleted'));
};

// ---------- Téléchargement / import (CSV pour Excel, JSON pour sauvegarde) ----------
const CSV_SEP = ';';
const csvCell = v => { const s = v == null ? '' : String(v); return /[";\n\r,]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function toCSV(list) {
  const lines = [L().csvHead.join(CSV_SEP)];
  for (const i of list) lines.push([i.id, i.type === 'task' ? t('typeTask') : t('typeNote'), t(i.domain), i.title, i.body, i.due, i.time, i.done ? '1' : '0', i.createdAt].map(csvCell).join(CSV_SEP));
  return '﻿' + lines.join('\r\n');
}
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0];
  const sep = [';', ',', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}
// Reconnaît les en-têtes dans les 3 langues
const HEAD_ALIASES = { id: ['id'], type: ['type', 'typ'], domain: ['domain', 'domaine', 'bereich'], title: ['title', 'titre', 'titel', 'task', 'tache', 'aufgabe', 'note', 'notiz'],
  body: ['details', 'detail', 'body'], due: ['due', 'echeance', 'faellig', 'fallig', 'date'], time: ['time', 'heure', 'uhrzeit'], done: ['done', 'fait', 'erledigt'], createdAt: ['created_at', 'cree_le', 'erstellt_am', 'createdat'] };
function rowsToItems(rows, defaultType) {
  const head = rows[0].map(h => norm(h.trim()));
  const col = {}; for (const k in HEAD_ALIASES) col[k] = head.findIndex(h => HEAD_ALIASES[k].includes(h));
  const hasHead = Object.values(col).some(v => v >= 0);
  const data = hasHead ? rows.slice(1) : rows;
  if (!hasHead) col.title = 0;
  const get = (r, k) => col[k] >= 0 ? (r[col[k]] || '').trim() : '';
  const toDate = s => { if (!s) return null; if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10); const m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/); return m ? `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad(+m[2])}-${pad(+m[1])}` : null; };
  return data.map(r => {
    const ty = norm(get(r, 'type')), dm = norm(get(r, 'domain'));
    const type = /^(note|notiz)/.test(ty) ? 'note' : /^(task|tache|aufgabe)/.test(ty) ? 'task' : defaultType;
    const domain = /^(pro|work|beruf)/.test(dm) ? 'pro' : /^(perso|personal|privat)/.test(dm) ? 'perso' : settings.lastDomain;
    const done = /^(1|true|oui|yes|ja|x)$/i.test(get(r, 'done'));
    return { id: get(r, 'id') || uid(), type, domain, title: get(r, 'title'), body: get(r, 'body'), due: type === 'task' ? toDate(get(r, 'due')) : null,
      time: type === 'task' && /^\d{1,2}:\d{2}$/.test(get(r, 'time')) ? get(r, 'time').padStart(5, '0') : null,
      done, doneAt: done ? nowIso() : null, createdAt: get(r, 'createdAt') || nowIso(), deleted: false };
  }).filter(i => i.title);
}
let claudeDownloads = null;
async function download(name, content, mime) {
  if (claudeDownloads) { try { await claudeDownloads.save({ filename: name, data: content }); } catch (e) { toast(String(e.message || e)); } return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type: mime })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
let exportScope = 'all';
$$('[data-export]').forEach(b => b.onclick = () => { exportScope = b.dataset.export; $('#dlgExport').showModal(); });
$('#sExport').onclick = () => { exportScope = 'all'; $('#dlgExport').showModal(); };
$('#xClose').onclick = () => $('#dlgExport').close();
$$('#dlgExport [data-fmt]').forEach(b => b.onclick = () => {
  const list = live().filter(i => exportScope === 'all' || i.type === exportScope);
  const name = `capte-${exportScope === 'task' ? 'tasks' : exportScope === 'note' ? 'notes' : 'all'}-${iso(new Date())}`;
  if (b.dataset.fmt === 'csv') download(name + '.csv', toCSV(list), 'text/csv;charset=utf-8');
  else download(name + '.json', JSON.stringify({ app: 'capte', version: 2, exportedAt: nowIso(), items: list }, null, 2), 'application/json');
  settings.lastExport = nowIso(); saveSettings(); renderBackupInfo();
  $('#dlgExport').close();
});
$$('input[data-import]').forEach(inp => inp.onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const scope = inp.dataset.import, defType = scope === 'note' ? 'note' : 'task';
  try {
    const txt = await f.text(); let incoming;
    if (/\.json$/i.test(f.name) || /^\s*[[{]/.test(txt)) {
      const data = JSON.parse(txt); incoming = (Array.isArray(data) ? data : data.items) || [];
      incoming = incoming.filter(i => i && i.title).map(i => ({ deleted: false, done: false, domain: 'perso', type: defType, createdAt: nowIso(), ...i, id: i.id || uid() }));
    } else incoming = rowsToItems(parseCSV(txt), defType);
    if (!incoming.length) throw 0;
    const byId = new Map(items.map(i => [i.id, i])); let n = 0;
    for (const it of incoming) {
      const cur = byId.get(it.id);
      if (!cur) { items.push(it); n++; pending.add(it.id); it.updatedAt = it.updatedAt || nowIso(); }
      else if (cur.deleted && !it.deleted) { Object.assign(cur, it, { deleted: false, updatedAt: nowIso() }); n++; pending.add(cur.id); }
    }
    save(KEY_ITEMS, items); save(KEY_PENDING, [...pending]); render(); scheduleSync();
    toast(t('imported', { n }));
  } catch { toast(t('invalidFile')); }
  e.target.value = '';
});

// ---------- Navigation & filtres ----------
function go(view) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  window.scrollTo(0, 0);
}
$$('.tabs button').forEach(b => b.onclick = () => go(b.dataset.view));
$$('#view-tasks .seg[data-filter] button').forEach(b => b.onclick = () => { filters.tasks = b.dataset.v; setSeg('#view-tasks .seg[data-filter]', b.dataset.v); render(); });
$$('#view-notes .seg[data-filter] button').forEach(b => b.onclick = () => { filters.notes = b.dataset.v; setSeg('#view-notes .seg[data-filter]', b.dataset.v); render(); });
setSeg('#view-tasks .seg[data-filter]', 'all'); setSeg('#view-notes .seg[data-filter]', 'all');
$('#showDone').onchange = render;
$('#search').oninput = render;

// ---------- Réglages ----------
function renderBackupInfo() {
  $('#backupInfo').textContent = t('backupInfo');
  // Rappel de sauvegarde (utile sans base de données) : jamais sauvegardé, ou il y a plus de 7 jours
  const n = live().length, days = settings.lastExport ? Math.floor((Date.now() - Date.parse(settings.lastExport)) / 864e5) : null;
  const show = !session && n >= 3 && (days === null || days >= 7);
  const bb = $('#backupBanner');
  bb.classList.toggle('hidden', !show);
  if (show) bb.textContent = days === null ? t('backupNever', { n }) : t('backupOld', { d: days });
}
$('#backupBanner').onclick = () => { exportScope = 'all'; $('#dlgExport').showModal(); };
function openSettings() {
  $('#sKey').value = settings.apiKey; $('#sModel').value = settings.model; $('#sLang').value = settings.speechLang;
  $('#sDbUrl').value = settings.dbUrl; $('#sDbKey').value = settings.dbKey;
  setSeg('#langSeg', settings.lang); renderAccount(); renderBackupInfo();
  $('#dlgSettings').showModal();
}
$('#btnSettings').onclick = openSettings;
$$('#langSeg button').forEach(b => b.onclick = () => { settings.lang = b.dataset.v; saveSettings(); setSeg('#langSeg', b.dataset.v); applyI18n(); renderBackupInfo(); });
$('#sClose').onclick = () => $('#dlgSettings').close();
$('#sSave').onclick = () => {
  const dbChanged = $('#sDbUrl').value.trim() !== settings.dbUrl || $('#sDbKey').value.trim() !== settings.dbKey;
  settings.apiKey = $('#sKey').value.trim(); settings.model = $('#sModel').value.trim() || 'claude-haiku-4-5';
  settings.speechLang = $('#sLang').value; settings.dbUrl = $('#sDbUrl').value.trim(); settings.dbKey = $('#sDbKey').value.trim();
  saveSettings(); if (dbChanged) initDb();
  $('#dlgSettings').close(); toast(t('settingsSaved'));
};

// ---------- Confirmation dans la page ----------
function askConfirm(msg, okLabel) {
  return new Promise(res => {
    const d = $('#dlgConfirm'); $('#cMsg').textContent = msg; $('#cOk').textContent = okLabel || t('ok'); $('#cNo').textContent = t('cancel');
    const done = v => { d.close(); res(v); };
    $('#cOk').onclick = () => done(true); $('#cNo').onclick = () => done(false); d.oncancel = () => res(false);
    d.showModal();
  });
}

// ---------- Divers ----------
let tt;
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => el.classList.remove('show'), 2600); }

const params = new URLSearchParams(location.search);
if (params.get('view')) go(params.get('view'));
if (params.has('rec')) setTimeout(startRec, 300);
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

applyI18n();
initDb();
// Dans une page claude.ai : dictée et téléchargements passent par les capacités de Claude
if (window.claude && typeof window.claude.use === 'function') {
  window.claude.use('dictation').then(d => {
    if (!d) return; claudeDict = d;
    d.onPartial(({ text }) => { $('#input').value = (baseText + dictFinal + text).replace(/^\s+/, ''); onInput(); });
    d.onFinal(({ text }) => { dictFinal += text + ' '; $('#input').value = (baseText + dictFinal).replace(/^\s+/, ''); onInput(); });
    d.onState(({ state }) => { if (state === 'idle' && recording) setRec(false); });
    setRecHint();
  }).catch(() => {});
  window.claude.use('downloads').then(d => { claudeDownloads = d; }).catch(() => {});
}
window.__capte = { ruleClassify, parseWhen, sync, toCSV, parseCSV, rowsToItems }; // débogage
})();
