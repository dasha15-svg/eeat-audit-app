// Vercel Serverless Function — POST { url } -> EEAT audit JSON
// Deploy target for the checklist in eeat_checklist_breakdown.md.
// Requires env var ANTHROPIC_API_KEY (Vercel dashboard -> Settings -> Environment Variables).

const SYSTEM_PROMPT = `Ти — експерт з EEAT-аудиту медичних сайтів (Experience, Expertise,
Authoritativeness, Trustworthiness). Тобі передано текст зі сторінок
сайту клініки, розмічений по сторінках. Оціни кожен пункт зі списку
нижче строго за цим текстом.

Пункти для оцінки:

E2 — Результати роботи лікаря / кейси / досягнення: чи є конкретний кейс
з деталями (діагноз/процедура/результат), а не загальна фраза про «великий досвід».
E3 — Іменний коментар лікаря про послугу: чи є цитата, приписана
конкретному лікарю на ім'я (не безособове «наші фахівці вважають»).
E4 — Коментарі лікарів/експертів у блозі: чи є іменна атрибуція автора.
X3 — Освіта лікаря вказана конкретно: названо виш і спеціальність, а не
просто слово «вища».
X4 — Стаж/досвід роботи лікаря вказаний конкретно: є число років або рік
початку практики, а не розпливчасте «великий досвід».
X6 — Сертифікати/дипломи/ліцензії лікаря згадані в тексті (текстова
згадка, не фото).
X7 — Блок пріоритетних напрямків на головній змістовний: названо
конкретні напрямки, а не загальні слова на кшталт «лікуємо все».
X8 — Блок обладнання називає конкретні моделі/бренди, а не лише
«сучасне обладнання».
X9 — SEO-текст про клініку змістовний, специфічний саме для цієї
клініки, а не шаблонний.
X10 — Показання та протипоказання на сторінці послуги: мінімум 2-3
конкретних пункти в кожному блоці, не загальна фраза.
X11 — Симптоми / коли показана послуга описані інформативно.
X12 — Етапи/процес надання послуги описані покроково.
X13 — Етапи підготовки до процедури описані.
X14 — Блок реабілітації/відновлення описаний.
A7 — Автор/рецензент статті в блозі клікабельний і веде на сторінку з
його даними.
A8 — Посилання на джерела в статтях блогу — на авторитетні ресурси
(медичні асоціації, .gov, PubMed), а не випадкові сайти.
T1 — Сторінка «Про клініку» існує і змістовна (не заглушка на
2 речення).
T2 — Сертифікати та ліцензії клініки згадані або показані.
T4 — Відгуки (на головній, у лікаря, на сторінці послуги) виглядають
справжніми: є конкретика (ім'я, що саме сподобалось), а не шаблонне
«чудова клініка, всім раджу».
T9 — Інформація про ліцензію у футері конкретна: вказано номер
ліцензії, а не просто фраза «ліцензовано».
T11 — Медичний дисклеймер присутній і доречний за змістом.
T17 — Блок FAQ на сторінці послуги є і відповідає по суті, а не
формально.

Правила:
1. Оцінюй СТРОГО за переданим текстом. Якщо даних для оцінки пункту
немає — verdict = "unknown". Ніколи не вигадуй і не додумуй те, чого
немає в тексті.
2. Для кожного пункту поверни: id, verdict (pass / partial / fail / unknown),
reason (українською, максимум 15 слів), recommendation (українською,
максимум 12 слів; якщо verdict = pass — можна порожній рядок).
3. Відповідь — строго JSON, без преамбули, без markdown-обгортки (без
потрійних зворотних лапок), без коментарів до або після JSON.

Формат відповіді:
{"results":[{"id":"E2","verdict":"pass","reason":"...","recommendation":"..."}]}

Поверни рівно 22 об'єкти в results — по одному на кожен пункт зі списку
вище, у тому ж порядку.`;

// Light heuristic: after the main page, follow up to 2 internal links that
// look like a doctors/about page, so a single URL from the visitor still
// surfaces doctor-level EEAT signals. Not a full crawl — that's backlog.
const LINK_KEYWORDS = [
  'vrach', 'doctor', 'likar', 'лікар', 'врач',
  'o-nas', 'про-клін', 'about', 'team', 'komanda', 'команда', 'спеціаліст'
];

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function findRelatedLinks(html, baseUrl) {
  const found = [];
  const seen = new Set();
  const re = /<a\s+[^>]*href=["']([^"'#]+)["'][^>]*>/gi;
  let m;
  const base = new URL(baseUrl);
  while ((m = re.exec(html)) && found.length < 2) {
    const href = m[1];
    const lower = href.toLowerCase();
    if (!LINK_KEYWORDS.some((kw) => lower.includes(kw))) continue;
    try {
      const abs = new URL(href, base).href;
      if (new URL(abs).hostname !== base.hostname) continue;
      if (seen.has(abs)) continue;
      seen.add(abs);
      found.push(abs);
    } catch (e) {
      // malformed href, skip
    }
  }
  return found;
}

async function fetchPage(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EEATAuditBot/1.0)' },
    redirect: 'follow'
  });
  if (!resp.ok) throw new Error('status ' + resp.status);
  return resp.text();
}

// Pure code, no LLM and no external API: JSON-LD lives in <script> tags,
// which stripHtml() removes before the text goes to Claude — so we pull
// it out of the RAW html first, before any stripping happens.
function extractSchemaTypes(html) {
  const found = new Set();
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html))) {
    try {
      const data = JSON.parse(m[1].trim());
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      items.forEach((item) => {
        const type = item && item['@type'];
        if (!type) return;
        (Array.isArray(type) ? type : [type]).forEach((t) => found.add(String(t)));
      });
    } catch (e) {
      // malformed or non-JSON-LD script block — skip it, don't fail the request
    }
  }
  return Array.from(found);
}

function buildSchemaResults(allHtml) {
  const types = new Set();
  allHtml.forEach((html) => extractSchemaTypes(html).forEach((t) => types.add(t)));
  const hasType = (re) => Array.from(types).some((t) => re.test(t));

  const checks = [
    { id: 'SCHEMA-ORG', label: 'MedicalOrganization', ok: hasType(/MedicalOrganization|MedicalClinic/i) },
    { id: 'SCHEMA-DOC', label: 'лікаря (Physician/Person)', ok: hasType(/Physician|^Person$/i) },
    { id: 'SCHEMA-SERVICE', label: 'послуги (MedicalProcedure)', ok: hasType(/MedicalProcedure/i) }
  ];
  return checks.map((c) => ({
    id: c.id,
    verdict: c.ok ? 'pass' : 'fail',
    reason: c.ok
      ? 'Знайдена в JSON-LD на прочитаних сторінках.'
      : 'Не знайдена в JSON-LD на жодній із прочитаних сторінок: ' + c.label + '.',
    recommendation: c.ok ? '' : 'Додати JSON-LD зі схемою ' + c.label + '.'
  }));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let url = (req.body && req.body.url || '').trim();
  if (!url) {
    res.status(400).json({ error: 'URL обов’язковий' });
    return;
  }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  let mainHtml;
  try {
    mainHtml = await fetchPage(url);
  } catch (e) {
    res.status(502).json({ error: 'Не вдалося прочитати сайт за цим посиланням. Перевірте адресу.' });
    return;
  }

  const allHtml = [mainHtml];
  const parts = ['=== Головна ===\n' + stripHtml(mainHtml).slice(0, 8000)];

  const relatedLinks = findRelatedLinks(mainHtml, url);
  for (const link of relatedLinks) {
    try {
      const html = await fetchPage(link);
      allHtml.push(html);
      parts.push('=== ' + link + ' ===\n' + stripHtml(html).slice(0, 8000));
    } catch (e) {
      // a related page failing to load isn't fatal — skip it
    }
  }

  const schemaResults = buildSchemaResults(allHtml);

  const combinedText = parts.join('\n\n');

  let claudeData;
  try {
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: combinedText }]
      })
    });
    claudeData = await claudeResp.json();
  } catch (e) {
    res.status(502).json({ error: 'Помилка звернення до Claude API' });
    return;
  }

  if (claudeData.error) {
    res.status(502).json({ error: claudeData.error.message || 'Помилка Claude API' });
    return;
  }

  const textBlocks = (claudeData.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  let clean = textBlocks.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    // Model added stray text around the JSON despite instructions —
    // fall back to the substring between the first { and the last }.
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        parsed = JSON.parse(clean.slice(start, end + 1));
      } catch (e2) {
        res.status(502).json({ error: 'Не вдалося розібрати відповідь моделі. Спробуйте ще раз.' });
        return;
      }
    } else {
      res.status(502).json({ error: 'Не вдалося розібрати відповідь моделі. Спробуйте ще раз.' });
      return;
    }
  }

  res.status(200).json({
    results: [...(parsed.results || []), ...schemaResults],
    pagesRead: parts.length
  });
};
