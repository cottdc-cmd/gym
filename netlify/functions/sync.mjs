// Saves a finished workout to the "Workout Log" database in Notion.
// Called by index.html at /.netlify/functions/sync.
//
// Needs one environment variable on the debowgym Netlify site:
//   NOTION_TOKEN       – a Notion integration token that has access to Workout Log
// Optional:
//   NOTION_WORKOUT_DB  – override the Workout Log database id

const API = 'https://api.notion.com/v1';
const DEFAULT_DB = '3daad06858894c9d815d9a06a4e60889'; // Planner / Fitness hub / Workout Log
const TRACKS = { gym: 'Gym', home: 'Home', adhoc: 'Ad hoc' };

const json = (body, status = 200) => Response.json(body, { status });
const clip = (v, n) => String(v ?? '').slice(0, n);
const env = (k) => (globalThis.Netlify ? Netlify.env.get(k) : process.env[k]);

async function notion(path, method, body, token) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || `Notion error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  throw new Error('Notion is busy. Tap Sync to retry.');
}

const text = (s) => [{ type: 'text', text: { content: clip(s, 2000) } }];
const fmtSet = (x) => `${x.weight || '–'}×${x.reps || '–'}`;

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const token = env('NOTION_TOKEN');
  if (!token) return json({ error: "Notion isn't connected yet. Add NOTION_TOKEN in Netlify." }, 500);
  const dbId = env('NOTION_WORKOUT_DB') || DEFAULT_DB;

  let s;
  try { s = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }

  const entries = Array.isArray(s.entries) ? s.entries.slice(0, 60) : [];
  if (!entries.length) return json({ error: 'No sets to save.' }, 400);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(s.localDate) ? s.localDate : new Date().toISOString().slice(0, 10);
  const track = TRACKS[s.track] || 'Gym';
  const day = clip(s.dayName || 'Workout', 120);
  const volume = Math.max(0, Math.round(Number(s.volume) || 0));
  const lines = entries.map((e) => {
    const sets = (Array.isArray(e.sets) ? e.sets : []).slice(0, 30);
    return { name: clip(e.name, 120), sets, line: `${clip(e.name, 120)}: ${sets.map(fmtSet).join(', ')}` };
  });
  const setsDone = lines.reduce((n, l) => n + l.sets.length, 0);
  const nice = new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const title = `${track} · ${day} — ${nice}`;

  try {
    // Skip duplicates if the app retries a sync that already landed.
    const existing = await notion(`/databases/${dbId}/query`, 'POST', {
      page_size: 1,
      filter: { and: [
        { property: 'Session', title: { equals: title } },
        { property: 'Date', date: { equals: date } },
      ] },
    }, token);
    if (existing.results?.length) return json({ ok: true, url: existing.results[0].url, duplicate: true });

    const page = await notion('/pages', 'POST', {
      parent: { database_id: dbId },
      properties: {
        Session: { title: text(title) },
        Date: { date: { start: date } },
        Track: { select: { name: track } },
        Day: { rich_text: text(day) },
        Volume: { number: volume },
        'Sets Done': { number: setsDone },
        Notes: { rich_text: text(lines.map((l) => `${l.name} ${l.sets.length}×`).join(' | ')) },
      },
      children: lines.slice(0, 90).map((l) => ({
        object: 'block', type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: text(l.line) },
      })),
    }, token);
    return json({ ok: true, url: page.url });
  } catch (e) {
    const msg = e.status === 404 || e.status === 403
      ? "Notion can't see Workout Log yet. Share it with the integration."
      : e.status === 401 ? 'Notion token is invalid.' : e.message;
    return json({ error: msg }, 502);
  }
};
