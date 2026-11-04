// Returns the workouts in Notion's "Ad hoc Workouts" database (Planner / Fitness hub).
// Called by index.html at /.netlify/functions/adhoc.
//
// Page format: one heading per section ("Superset A (4 rounds)"), then one bullet
// per move ("Face pulls 12-15"). A "Notes" heading holds tips.

const API = 'https://api.notion.com/v1';
const env = (k) => (globalThis.Netlify ? Netlify.env.get(k) : process.env[k]);
const DB = () => env('NOTION_ADHOC_DB') || 'ff41b1c0f2684055a5d4f983f827c911';
const json = (body, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function notion(path, token, method = 'GET', body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
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
  throw new Error('Notion is busy. Try again in a minute.');
}

const plain = (rt = []) => rt.map((t) => t.plain_text).join('').trim();
const prop = (p, name, type) => {
  const v = p.properties?.[name];
  if (!v) return '';
  if (type === 'title') return plain(v.title);
  if (type === 'text') return plain(v.rich_text);
  if (type === 'multi') return (v.multi_select || []).map((o) => o.name);
  return '';
};

export function parseBlocks(blocks) {
  const sections = [];
  const notes = [];
  let cur = null;
  const start = (raw) => {
    const name = raw.replace(/:\s*$/, '').trim();
    const m = name.match(/^(.*?)\s*\((.*)\)$/);
    cur = { h: m ? m[1] : name, sub: m ? m[2] : '', items: [] };
    if (/^notes?$/i.test(cur.h)) cur.isNotes = true;
    else sections.push(cur);
  };
  for (const b of blocks) {
    const t = b.type;
    const text = plain(b[t]?.rich_text);
    if (!text) continue;
    if (/^heading_[123]$/.test(t) || (t === 'paragraph' && /:\s*$/.test(text))) { start(text); continue; }
    if (!['bulleted_list_item', 'numbered_list_item', 'to_do', 'paragraph'].includes(t)) continue;
    const line = text.replace(/^[-•*]\s*/, '');
    if (cur?.isNotes) notes.push(line);
    else {
      if (!cur) { cur = { h: 'Workout', sub: '', items: [] }; sections.push(cur); }
      cur.items.push(line);
    }
  }
  return { sections: sections.filter((s) => s.items.length), notes };
}

export default async () => {
  const token = env('NOTION_TOKEN') || env('NOTION_KEY');
  if (!token) return json({ error: "Notion isn't connected yet." }, 500);
  try {
    const q = await notion(`/databases/${DB()}/query`, token, 'POST', {
      page_size: 50,
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
    });
    const pages = q.results.filter((p) => !p.archived);
    const workouts = await Promise.all(pages.map(async (p) => {
      const kids = await notion(`/blocks/${p.id}/children?page_size=100`, token);
      const { sections, notes } = parseBlocks(kids.results);
      return {
        id: `n:${p.id.replace(/-/g, '')}`,
        source: 'notion',
        title: prop(p, 'Workout', 'title') || 'Untitled workout',
        meta: prop(p, 'Details', 'text'),
        focus: prop(p, 'Focus', 'multi'),
        updated: p.last_edited_time,
        url: p.url,
        sections,
        notes,
      };
    }));
    return json({ workouts });
  } catch (e) {
    const msg = e.status === 401 ? 'Notion token is invalid.'
      : e.status === 403 || e.status === 404 ? "Notion can't see Ad hoc Workouts. Share the Fitness hub with the integration."
      : e.message;
    return json({ error: msg }, 502);
  }
};
