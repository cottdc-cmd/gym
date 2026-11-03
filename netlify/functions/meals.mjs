// Returns the newest "Weekly Meal Plan" page from Notion, shaped for the Meals tab.
// Called by index.html at /.netlify/functions/meals.
// Uses the same NOTION_TOKEN as sync.mjs. The integration needs access to the
// Nutrition hub (or to each Weekly Meal Plan page).

const API = 'https://api.notion.com/v1';
const env = (k) => (globalThis.Netlify ? Netlify.env.get(k) : process.env[k]);
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

async function children(id, token) {
  const out = [];
  let cursor;
  do {
    const q = `?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
    const page = await notion(`/blocks/${id}/children${q}`, token);
    out.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return out;
}

// Rich text -> small HTML (bold/italic only), escaped.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = (rt = []) => rt.map((t) => {
  let s = esc(t.plain_text);
  if (t.annotations?.bold) s = `<b>${s}</b>`;
  if (t.annotations?.italic) s = `<i>${s}</i>`;
  return s;
}).join('');
const plain = (rt = []) => rt.map((t) => t.plain_text).join('').trim();

const DAYS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

async function tableRows(block, token) {
  const rows = await children(block.id, token);
  return rows.filter((r) => r.type === 'table_row').map((r) => r.table_row.cells);
}

function weekFromTable(rows) {
  const head = rows[0].map((c) => plain(c).toLowerCase());
  const col = (re) => head.findIndex((h) => re.test(h));
  const ci = { d: col(/^day/), b: col(/breakfast/), l: col(/lunch/), s: col(/snack/), n: col(/dinner/), p: col(/protein/) };
  if (ci.d < 0 || ci.n < 0) return null;
  const week = [];
  rows.slice(1).forEach((cells) => {
    const first = plain(cells[ci.d] || []);
    const key = first.slice(0, 3).toLowerCase();
    if (!DAYS[key]) return;
    const get = (i) => (i >= 0 ? plain(cells[i] || []) : '');
    const dinner = get(ci.n);
    week.push({
      d: DAYS[key],
      t: /rest/i.test(first) ? 'rest' : 'training',
      b: get(ci.b), l: get(ci.l), s: get(ci.s),
      n: /^(out|eating out|dinner out)\b/i.test(dinner) ? 'OUT' : dinner,
      p: get(ci.p),
    });
  });
  return week.length ? week : null;
}

async function renderBlocks(blocks, token) {
  let out = '';
  let list = null;
  const close = () => { if (list) { out += `</${list}>`; list = null; } };
  for (const b of blocks) {
    const t = b.type;
    if (t === 'bulleted_list_item' || t === 'numbered_list_item') {
      const tag = t === 'bulleted_list_item' ? 'ul' : 'ol';
      if (list !== tag) { close(); out += `<${tag}>`; list = tag; }
      out += `<li>${html(b[t].rich_text)}</li>`;
      continue;
    }
    close();
    if (t === 'paragraph') { const h = html(b.paragraph.rich_text); if (h) out += `<div class="idea">${h}</div>`; }
    else if (t === 'heading_3') out += `<div class="swap-h">${html(b.heading_3.rich_text)}</div>`;
    else if (t === 'callout' || t === 'quote') out += `<div class="swap-note">${html(b[t].rich_text)}</div>`;
    else if (t === 'table') {
      const rows = await tableRows(b, token);
      const hasHeader = b.table.has_column_header;
      const head = hasHeader ? rows[0].map(plain) : null;
      rows.slice(hasHeader ? 1 : 0).forEach((cells) => {
        const parts = cells.map((c, i) => {
          const v = html(c);
          if (!v) return '';
          return head && i > 0 && head[i] && head[i].length <= 4 ? `${v} ${esc(head[i])}` : v;
        }).filter(Boolean);
        out += `<div class="swap-group">${parts.join(' · ')}</div>`;
      });
    }
  }
  close();
  return out;
}

export default async () => {
  const token = env('NOTION_TOKEN') || env('NOTION_KEY');
  if (!token) return json({ error: "Notion isn't connected yet." }, 500);
  try {
    const found = await notion('/search', token, 'POST', {
      query: 'Weekly Meal Plan',
      filter: { property: 'object', value: 'page' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 20,
    });
    const plans = found.results
      .map((p) => ({ p, title: plain(Object.values(p.properties || {}).find((x) => x.type === 'title')?.title) }))
      .filter((x) => /^weekly meal plan/i.test(x.title) && !x.p.archived)
      .sort((a, b) => (a.p.created_time < b.p.created_time ? 1 : -1));
    if (!plans.length) return json({ error: "Notion can't see any Weekly Meal Plan pages. Share the Nutrition hub with the integration." }, 404);
    const { p, title } = plans[0];

    const blocks = await children(p.id, token);
    let week = null;
    let intro = '';
    const sections = [];
    let cur = null;
    for (const b of blocks) {
      if (b.type === 'heading_2' || b.type === 'heading_1') {
        cur = { title: plain(b[b.type].rich_text), blocks: [] };
        sections.push(cur);
        continue;
      }
      if (!week && b.type === 'table') {
        week = weekFromTable(await tableRows(b, token));
        if (week) continue;
      }
      if (!cur && b.type === 'callout') {
        const kids = b.has_children ? await children(b.id, token) : [];
        intro += `<div class="idea">${html(b.callout.rich_text)}</div>` + (await renderBlocks(kids, token));
        continue;
      }
      if (cur) cur.blocks.push(b);
    }
    const rendered = [];
    for (const s of sections) {
      if (/week at a glance/i.test(s.title) && !s.blocks.length) continue;
      const body = await renderBlocks(s.blocks, token);
      if (body) rendered.push({ title: s.title, html: body });
    }
    return json({
      title,
      range: title.replace(/^weekly meal plan:?\s*/i, ''),
      url: p.url,
      updated: p.last_edited_time,
      intro,
      week,
      sections: rendered,
    });
  } catch (e) {
    const msg = e.status === 401 ? 'Notion token is invalid.'
      : e.status === 403 || e.status === 404 ? "Notion can't see the meal plan. Share the Nutrition hub with the integration."
      : e.message;
    return json({ error: msg }, 502);
  }
};
