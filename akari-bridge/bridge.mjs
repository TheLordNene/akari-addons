// AKARI-Brücke: verbindet Home Assistant mit AKARI, ohne Portfreigabe und ohne Tunnel.
// Die Brücke fragt AKARI laufend nach Aufträgen (eine lange https-Anfrage nach draußen),
// führt sie bei Home Assistant aus und schickt die Antworten zurück.
//
// Erlaubt sind nur: Zustände und Grundeinstellungen lesen, die Register (Bereiche, Geräte,
// Entitäten) lesen, Lampen schalten und dimmen, Szenen auslösen. Alles andere lehnt sie ab,
// auch wenn AKARI danach fragen sollte.
//
// Läuft als Home-Assistant-Add-on (Zugang zu HA kommt automatisch über den Supervisor) oder
// eigenständig mit Node 22+:
//   AKARI_SERVER=https://akari.example.de AKARI_CODE=akb_… HA_URL=http://localhost:8123 HA_TOKEN=… node bridge.mjs
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const VERSION = '1.0.1';
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);

// ── Einstellungen ──
function settings() {
  let opts = {};
  try {
    opts = JSON.parse(readFileSync('/data/options.json', 'utf8')); // Add-on-Konfiguration
  } catch {
    // eigenständig: nur Umgebungsvariablen
  }
  const server = String(process.env.AKARI_SERVER || opts.server || '').trim().replace(/\/+$/, '');
  const code = String(process.env.AKARI_CODE || opts.code || '').trim();
  // Als Add-on: Zugang über den Supervisor. s6 gibt die Umgebung nicht immer weiter, dann aus seiner Ablage lesen.
  let supervisor = process.env.SUPERVISOR_TOKEN || '';
  if (!supervisor && opts.server) {
    for (const f of ['/run/s6/container_environment/SUPERVISOR_TOKEN', '/var/run/s6/container_environment/SUPERVISOR_TOKEN']) {
      try {
        supervisor = readFileSync(f, 'utf8').trim();
        if (supervisor) break;
      } catch {}
    }
  }
  const ha = supervisor
    ? { url: 'http://supervisor/core', ws: 'ws://supervisor/core/websocket', token: supervisor }
    : { url: String(process.env.HA_URL || '').replace(/\/+$/, ''), token: String(process.env.HA_TOKEN || '') };
  if (!ha.ws && ha.url) ha.ws = `${ha.url.replace(/^http/, 'ws')}/api/websocket`;
  return { server, code, ha };
}
const cfg = settings();
function check() {
  let u;
  try {
    u = new URL(cfg.server);
  } catch {
    return 'Server fehlt oder ist keine Adresse (z. B. https://akari.lucidian.dev).';
  }
  // Ohne https nur für Tests auf demselben Rechner
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return 'Server muss mit https:// beginnen.';
  if (!/^akb_[A-Za-z0-9_-]{30,}$/.test(cfg.code)) return 'Kopplungscode fehlt oder ist unvollständig. Du findest ihn in AKARI unter Einstellungen → Verbindungen → Home Assistant.';
  if (!cfg.ha.url || !cfg.ha.token) return 'Kein Zugang zu Home Assistant (als Add-on automatisch, sonst HA_URL und HA_TOKEN setzen).';
  return null;
}

// ── Home Assistant ──
async function rest(method, path, body) {
  const r = await fetch(`${cfg.ha.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.ha.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw Object.assign(new Error(`Home Assistant antwortet mit ${r.status}`), { status: r.status });
  return r.json();
}

// Bereiche, Geräte, Entitäten und Etagen gibt es nur über die WebSocket-API
function registry() {
  const asks = { areas: 'config/area_registry/list', devices: 'config/device_registry/list', entities: 'config/entity_registry/list', floors: 'config/floor_registry/list' };
  const keys = Object.keys(asks);
  const out = {};
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(cfg.ha.ws);
    const timer = setTimeout(() => done(new Error('Home Assistant antwortet nicht über WebSocket')), 10000);
    function done(err) {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      err ? reject(err) : resolve(out);
    }
    ws.addEventListener('error', () => done(new Error('WebSocket zu Home Assistant fehlgeschlagen')));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: cfg.ha.token }));
      else if (msg.type === 'auth_invalid') done(new Error('Home Assistant lehnt die Anmeldung ab'));
      else if (msg.type === 'auth_ok') keys.forEach((k, i) => ws.send(JSON.stringify({ id: i + 1, type: asks[k] })));
      else if (msg.type === 'result') {
        const key = keys[msg.id - 1];
        if (!key) return;
        // Etagen gibt es erst seit 2024.4
        if (!msg.success && key !== 'floors') return done(new Error(`Register ${key}: ${msg.error?.message || 'Fehler'}`));
        out[key] = msg.success ? msg.result : [];
        if (Object.keys(out).length === keys.length) done();
      }
    });
  });
}

// ── Erlaubte Aufträge (dieselbe Liste wie auf dem AKARI-Server) ──
// Lampen, Szenen, Schalter (Steckdosen, Helfer, Lüfter) und Heizung. Jeder Dienst nur für
// Entitäten seiner eigenen Art: light.turn_on schaltet nie ein Schloss.
const SERVICE = /^\/api\/services\/(light\/turn_(on|off)|scene\/turn_on|(switch|input_boolean|fan)\/turn_(on|off)|climate\/set_(temperature|hvac_mode))$/;
const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;
const HVAC = new Set(['off', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only']);
async function run(job) {
  if (job.type === 'registry') return registry();
  if (job.type === 'rest' && job.method === 'GET' && (job.path === '/api/states' || job.path === '/api/config')) return rest('GET', job.path);
  if (job.type === 'rest' && job.method === 'POST' && SERVICE.test(job.path)) {
    const domain = job.path.split('/')[3];
    const ids = [].concat(job.body?.entity_id ?? []);
    if (!ids.length || ids.length > 100 || !ids.every((id) => typeof id === 'string' && ENTITY.test(id) && id.startsWith(`${domain}.`))) throw new Error('Ungültige Entitäten');
    const body = { entity_id: ids };
    const bri = Number(job.body?.brightness_pct);
    if (job.path.endsWith('light/turn_on') && Number.isFinite(bri)) body.brightness_pct = Math.max(1, Math.min(100, Math.round(bri)));
    if (job.path.endsWith('climate/set_temperature')) {
      const t = Number(job.body?.temperature);
      if (!Number.isFinite(t) || t < -30 || t > 60) throw new Error('Ungültige Temperatur');
      body.temperature = t;
    }
    if (job.path.endsWith('climate/set_hvac_mode')) {
      if (!HVAC.has(job.body?.hvac_mode)) throw new Error('Ungültige Betriebsart');
      body.hvac_mode = job.body.hvac_mode;
    }
    return rest('POST', job.path, body);
  }
  throw new Error('Auftrag nicht erlaubt');
}

let haVersion = '';
let haName = '';
async function haInfo() {
  try {
    const c = await rest('GET', '/api/config');
    haVersion = c.version || '';
    haName = c.location_name || '';
  } catch {
    // kommt beim nächsten Mal
  }
}

// ── Verbindung zu AKARI ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function loop() {
  let results = [];
  let wait = 2000;
  let lastProblem = '';
  let connected = false;
  const problem = (text) => {
    if (text !== lastProblem) log(text);
    lastProblem = text;
    connected = false;
  };
  for (;;) {
    try {
      const body = gzipSync(JSON.stringify({ results, info: { bridge: VERSION, ha: haVersion, name: haName } }));
      const r = await fetch(`${cfg.server}/api/bridge/poll`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.code}`, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'User-Agent': `akari-bridge/${VERSION}` },
        body,
        signal: AbortSignal.timeout(45000),
      });
      results = []; // abgegeben (auch bei Fehlern: AKARI wartet höchstens kurz darauf)
      if (r.status === 401) {
        problem('AKARI kennt diesen Kopplungscode nicht (mehr). Neuen Code in AKARI erzeugen und hier eintragen.');
        await sleep(60000);
        continue;
      }
      if (r.status === 429) {
        problem('Zu viele Versuche, kurze Pause.');
        await sleep(120000);
        continue;
      }
      if (!r.ok) throw new Error(`AKARI antwortet mit ${r.status}`);
      const { jobs = [] } = await r.json();
      if (!connected) {
        log(`Verbunden mit ${new URL(cfg.server).host}${haVersion ? ` (Home Assistant ${haVersion})` : ''}.`);
        connected = true;
        lastProblem = '';
      }
      wait = 2000;
      results = await Promise.all(
        jobs.slice(0, 20).map(async (job) => {
          try {
            return { id: job.id, ok: true, data: await run(job) };
          } catch (e) {
            return { id: job.id, ok: false, status: e.status || 0, error: String(e.message).slice(0, 200) };
          }
        })
      );
    } catch (e) {
      problem(`Keine Verbindung zu AKARI (${e.name === 'TimeoutError' ? 'Zeitüberschreitung' : e.cause?.code || e.message}). Neuer Versuch gleich.`);
      results = [];
      await sleep(wait);
      wait = Math.min(wait * 2, 60000);
    }
  }
}

const bad = check();
if (bad) {
  log(`Nicht gestartet: ${bad}`);
  // Als Add-on nicht in einer Schleife neu starten, sondern sichtbar warten
  setInterval(() => {}, 1 << 30);
} else {
  log(`AKARI-Brücke ${VERSION} startet, Ziel ${new URL(cfg.server).host}.`);
  await haInfo();
  setInterval(haInfo, 30 * 60_000);
  loop();
}
