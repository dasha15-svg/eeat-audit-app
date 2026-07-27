// Vercel Serverless Function — POST { url } -> EEAT audit JSON
// Requires env var ANTHROPIC_API_KEY (Vercel dashboard -> Settings -> Environment Variables).
// Requires vercel.json with maxDuration: 60 (Hobby plan ceiling) for the wider crawl below.

const SYSTEM_PROMPT = `Ти — експерт з EEAT-аудиту медичних сайтів (Experience, Expertise,
Authoritativeness, Trustworthiness). Тобі передано текст зі сторінок
сайту клініки, розмічений по сторінках. Оціни кожен пункт зі списку
нижче строго за цим текстом.

Пункти для оцінки:

E2 — Результати роботи лікаря / кейси / досягнення: чи є конкретний кейс
одного пацієнта з деталями (діагноз/процедура/результат), прив'язаний
саме до лікаря. Загальна статистика клініки в цілому (наприклад
«N операцій на рік») це НЕ те саме, що кейс лікаря, і сама по собі не
є підставою для verdict pass, навіть якщо цифра конкретна.
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
його даними. Формулюй висновок саме про перевірену сторінку (за назвою
з блоку === ), а не про блог клініки в цілому, інші статті можуть
відрізнятись.
A8 — Посилання на джерела в статтях блогу — на авторитетні ресурси
(медичні асоціації, .gov, PubMed), а не випадкові сайти.
X15 — Контент (стаття блогу або опис послуги) без зайвої води: конкретні
факти, цифри, деталі, а не загальні маркетингові фрази на кшталт
«індивідуальний підхід» чи «найсучасніші технології» без розшифровки.
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
5. Спочатку виведи один рядок з загальним висновком 2-3 реченнями
українською: що на сайті вже добре працює на довіру, що найбільше
потребує уваги, без технічного жаргону, орієнтуючись на власника клініки,
який хоче зрозуміти цінність без заглиблення в деталі.
6. Відповідь пиши у форматі NDJSON: кожен рядок, окремий, повністю
самостійний JSON-об'єкт, без масиву й без обгортки навколо всього, без
преамбули, без markdown-обгортки (без потрійних зворотних лапок).

Перший рядок:
{"type":"summary","text":"..."}

Далі рівно 23 рядки, по одному на кожен пункт зі списку вище, у тому ж
порядку:
{"type":"result","id":"E2","verdict":"pass","why":"..."}

Кожен рядок має бути дійсним JSON сам по собі. Не об'єднуй кілька
об'єктів в один рядок.`;

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
// Listing/index pages match the keywords above (e.g. .../category/blog/) but
// aren't actual content, they're slow to load and add nothing to the audit.
const EXCLUDE_PATTERNS = ['/category/', '/tag/', '/page/', '/author/', '/search/'];
const MAX_PER_BUCKET = 2; // streaming now means a slow run degrades gracefully instead of showing nothing
const TIME_BUDGET_MS = 18000; // leaves real margin for the Claude call inside the 60s function ceiling

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
    if (EXCLUDE_PATTERNS.some((p) => lower.includes(p))) continue;
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
  const timer = setTimeout(() => controller.abort(), timeoutMs || 4500);
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

async function handleAudit(req, res) {
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

  // Commit to a streaming response from here on: schema results go out
  // immediately, then each line Claude finishes gets forwarded right away
  // instead of waiting for the full 22-item response to complete.
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.status(200);

  for (const sr of schemaResults) {
    res.write(JSON.stringify({ type: 'result', id: sr.id, verdict: sr.verdict, why: sr.why }) + '\n');
  }

  let claudeResp;
  try {
    claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
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
        messages: [{ role: 'user', content: combinedText }],
        stream: true
      })
    });
  } catch (e) {
    res.write(JSON.stringify({ type: 'error', message: 'Помилка звернення до Claude API' }) + '\n');
    res.end();
    return;
  }

  if (!claudeResp.ok || !claudeResp.body) {
    res.write(JSON.stringify({ type: 'error', message: 'Помилка Claude API' }) + '\n');
    res.end();
    return;
  }

  const reader = claudeResp.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let textBuffer = '';

  function flushCompleteLines() {
    let nl;
    while ((nl = textBuffer.indexOf('\n')) !== -1) {
      const raw = textBuffer.slice(0, nl).trim();
      textBuffer = textBuffer.slice(nl + 1);
      const line = raw.replace(/```json|```/g, '').trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        res.write(JSON.stringify(obj) + '\n');
      } catch (e) {
        // an incomplete or malformed line, worst case this one item is skipped
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const events = sseBuffer.split('\n\n');
      sseBuffer = events.pop();
      for (const evt of events) {
        const dataLine = evt.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        let parsedEvt;
        try {
          parsedEvt = JSON.parse(dataLine.slice(5).trim());
        } catch (e) {
          continue;
        }
        if (parsedEvt.type === 'content_block_delta' && parsedEvt.delta && typeof parsedEvt.delta.text === 'string') {
          textBuffer += parsedEvt.delta.text;
          flushCompleteLines();
        }
      }
    }
    const trailing = textBuffer.replace(/```json|```/g, '').trim();
    if (trailing) {
      try {
        res.write(JSON.stringify(JSON.parse(trailing)) + '\n');
      } catch (e) {
        // trailing partial line with no final newline, nothing more to recover
      }
    }
  } catch (e) {
    res.write(JSON.stringify({ type: 'error', message: 'З’єднання перервалося під час аналізу.' }) + '\n');
  }

  res.end();
}

module.exports = async function handler(req, res) {
  try {
    await handleAudit(req, res);
  } catch (e) {
    console.error('Unhandled error in /api/audit:', e);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Неочікувана помилка на сервері. Спробуйте ще раз.' });
    } else {
      try { res.end(); } catch (e2) { /* connection already gone */ }
    }
  }
};
