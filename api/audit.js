// Vercel Serverless Function — POST { url } -> EEAT audit JSON
// Requires env var ANTHROPIC_API_KEY (Vercel dashboard -> Settings -> Environment Variables).
// Requires vercel.json with maxDuration: 60 (Hobby plan ceiling) for the wider crawl below.

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
немає, verdict = "unknown". Ніколи не вигадуй і не додумуй те, чого
немає в тексті.
2. Для кожного пункту поверни: id, verdict (pass / partial / fail / unknown),
why (українською, 20-30 слів), одним реченням поєднай: що саме знайдено
на сайті (або що відсутнє) і чому цей фактор важливий для довіри Google,
AI-пошуку та пацієнтів. Це має звучати як пояснення для власника клініки,
не як суха технічна нотатка.
3. НЕ використовуй тире (—) у полі why. Пиши звичайними реченнями через
крапку або кому.
4. Кожне пояснення в why має бути унікальним за формулюванням, навіть
якщо два пункти отримали однаковий verdict, не повторюй однакові
конструкції речень.
5. Додай окреме поле summary — загальний висновок 2-3 реченнями
українською: що на сайті вже добре працює на довіру, що найбільше
потребує уваги, без технічного жаргону, орієнтуючись на власника клініки,
який хоче зрозуміти цінність без заглиблення в деталі.
6. Відповідь — строго JSON, без преамбули, без markdown-обгортки (без
потрійних зворотних лапок), без коментарів до або після JSON.

Формат відповіді:
{"summary":"...","results":[{"id":"E2","verdict":"pass","why":"..."}]}

У results поверни рівно 22 об'єкти, по одному на кожен пункт зі списку
вище, у тому ж порядку.`;

// Broader discovery than a single guess: categorize internal links into
// buckets so one URL from the visitor still surfaces doctor/service/blog
// content, not just the homepage. Still bounded — a real unlimited crawl
// needs a queue, which is explicitly out of scope for this version.
const LINK_BUCKETS = {
  about: ['o-nas', 'про-клін', 'pro-klinik', 'about-us', 'about'],
  doctor: ['vrach', 'doctor', 'likar', 'лікар', 'врач', 'staff', 'komanda', 'команда', 'спеціаліст'],
  service: ['uslug', 'poslug', 'service', 'lechenie', 'likuvannya', 'hirurg', 'terapiya', 'diagnostika'],
  blog: ['blog', 'stati', 'статт', /\/20\d\d\/\d\d\/\d\d\//]
};
const MAX_PER_BUCKET = 2;
const TIME_BUDGET_MS = 35000; // leaves headroom for the Claude call inside the 60s function ceiling

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

function categorizeLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const re = /<a\s+[^>]*href=["']([^"'#]+)["'][^>]*>/gi;
  const seen = new Set([base.href]);
  const buckets = { about: [], doctor: [], service: [], blog: [] };
  let m;
  while ((m = re.exec(html))) {
    let abs;
    try {
      abs = new URL(m[1], base).href;
    } catch (e) { continue; }
    if (new URL(abs).hostname !== base.hostname) continue;
    if (seen.has(abs)) continue;
    const lower = abs.toLowerCase();
    for (const bucket of Object.keys(LINK_BUCKETS)) {
      if (buckets[bucket].length >= MAX_PER_BUCKET) continue;
      const matched = LINK_BUCKETS[bucket].some((kw) =>
        kw instanceof RegExp ? kw.test(lower) : lower.includes(kw)
      );
      if (matched) {
        buckets[bucket].push(abs);
        seen.add(abs);
        break;
      }
    }
  }
  return buckets;
}

function pickPagesToFetch(buckets) {
  const labeled = [];
  if (buckets.about[0]) labeled.push({ url: buckets.about[0], fallback: 'Про клініку' });
  buckets.doctor.forEach((u, i) => labeled.push({ url: u, fallback: 'Лікар ' + (i + 1) }));
  buckets.service.forEach((u, i) => labeled.push({ url: u, fallback: 'Послуга ' + (i + 1) }));
  buckets.blog.forEach((u, i) => labeled.push({ url: u, fallback: 'Стаття блогу ' + (i + 1) }));
  return labeled;
}

function extractTitle(html) {
  let m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const title = stripHtml(m[1]).slice(0, 70).trim();
  return title || null;
}

async function fetchPage(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 6000);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EEATAuditBot/1.0)' },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!resp.ok) throw new Error('status ' + resp.status);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
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

  const hasOrg = hasType(/MedicalOrganization|MedicalClinic/i);
  const hasDoc = hasType(/Physician|^Person$/i);
  const hasService = hasType(/MedicalProcedure/i);

  return [
    {
      id: 'SCHEMA-ORG',
      verdict: hasOrg ? 'pass' : 'fail',
      why: hasOrg
        ? 'Сайт позначений як MedicalOrganization у коді сторінки, тому Google і AI одразу розуміють, що це медичний заклад, а не блог чи інтернет-магазин.'
        : 'У коді сторінки немає позначки MedicalOrganization, тому пошуковим системам і AI доводиться здогадуватись, що це взагалі за сайт, замість того щоб знати це напевно.'
    },
    {
      id: 'SCHEMA-DOC',
      verdict: hasDoc ? 'pass' : 'fail',
      why: hasDoc
        ? 'Лікарі позначені в коді як окремі персони, це дозволяє Google показувати їхні імена та кваліфікацію прямо у видачі, а не просто текстом на сторінці.'
        : 'Лікарі ніде не позначені в коді як окремі персони, через це Google не може винести їхні імена й кваліфікацію у видачу, навіть якщо на сторінці все написано.'
    },
    {
      id: 'SCHEMA-SERVICE',
      verdict: hasService ? 'pass' : 'fail',
      why: hasService
        ? 'Послуги оформлені в коді як MedicalProcedure, тож AI-пошуковики можуть точно зіставити запит пацієнта з конкретною процедурою на сайті.'
        : 'Послуги не оформлені в коді як MedicalProcedure, тому AI-пошуковикам складніше зрозуміти, яка саме процедура описана на сторінці, навіть якщо текст цілком зрозумілий людині.'
    }
  ];
}

module.exports = async function handler(req, res) {
  const START = Date.now();
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
  const parts = ['=== Головна ===\n' + stripHtml(mainHtml).slice(0, 6000)];
  const pagesSummary = ['Головна'];

  const buckets = categorizeLinks(mainHtml, url);
  const toFetch = pickPagesToFetch(buckets);

  for (const page of toFetch) {
    if (Date.now() - START > TIME_BUDGET_MS) break; // out of time budget — stop discovering, move on to analysis
    try {
      const html = await fetchPage(page.url);
      allHtml.push(html);
      const label = extractTitle(html) || page.fallback;
      parts.push('=== ' + label + ' ===\n' + stripHtml(html).slice(0, 6000));
      pagesSummary.push(label);
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
    summary: parsed.summary || null,
    pagesRead: parts.length,
    pagesSummary
  });
};
