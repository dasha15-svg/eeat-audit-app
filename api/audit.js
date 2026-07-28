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
1a. verdict = "fail" тільки якщо пункт дійсно відсутній у переданому
тексті. Якщо щось релевантне Є, але коротке, загальне чи неповне,
це "partial", а не "fail". Не занижуй verdict лише через якість подачі.
2. Для кожного пункту поверни: id, verdict (pass / partial / fail / unknown),
why (українською, максимум 12 слів, коротко і по суті), одним реченням поєднай: що саме знайдено
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
який хоче зрозуміти цінність без заглиблення в деталі. Пиши "відсутнє"
у summary лише про пункти, яким ти сам поставиш verdict fail. Якщо
пункт partial, пиши в summary "потребує доопрацювання" чи подібне,
а не "відсутнє".
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
// buckets so one URL from the visitor surfaces doctor/service/blog content
// across a real chunk of the site, not just the homepage.
const LINK_BUCKETS = {
  about: ['o-nas', 'про-клін', 'pro-klinik', 'about-us', 'about'],
  doctor: ['vrach', 'doctor', 'likar', 'лікар', 'врач', 'staff', 'komanda', 'команда', 'спеціаліст'],
  service: [
    'uslug', 'poslug', 'service', 'lechenie', 'likuvannya', 'hirurg', 'terapiya', 'diagnostika',
    'napryam', 'napravlen', 'specializ'
  ],
  blog: ['blog', 'stati', 'статт', /\/20\d\d\/\d\d\/\d\d\//]
};
// Different sections carry different weight in the checklist — services and
// recent blog posts matter more than a second or third doctor bio.
const BUCKET_CAPS = { about: 1, doctor: 1, service: 1, blog: 1 }; // back to the original reliable scope — 5 pages total incl. homepage
// Listing/index pages match the keywords above (e.g. .../category/blog/) but
// aren't actual content, they're slow to load and add nothing to the audit.
const EXCLUDE_PATTERNS = ['/category/', '/tag/', '/page/', '/author/', '/search/'];
// A URL whose entire last path segment IS one of these generic words is
// almost certainly a listing page (e.g. /services/, /blog/), not an
// individual service or article — those need a longer, specific slug.
const LISTING_SLUGS = new Set([
  'services', 'service', 'uslugi', 'uslugi-i-tseny', 'poslugy', 'poslugi',
  'catalog', 'katalog', 'products', 'shop', 'blog', 'articles', 'stati', 'statti', 'novyny', 'news'
]);
const HARD_DEADLINE_MS = 270000; // absolute ceiling for the whole request, 30s margin under the 300s platform kill

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&copy;/gi, '©')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyListingPage(url) {
  const path = new URL(url).pathname.replace(/\/+$/, '');
  const lastSegment = (path.split('/').pop() || '').toLowerCase();
  return LISTING_SLUGS.has(lastSegment);
}

function categorizeLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const re = /<a\s+[^>]*href=["']([^"'#]+)["'][^>]*>/gi;
  const seen = new Set([base.href]);
  const buckets = { about: [], doctor: [], service: [], blog: [] };
  const listingPages = { about: null, doctor: null, service: null, blog: null };
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
    const isListing = isLikelyListingPage(abs);
    for (const bucket of Object.keys(LINK_BUCKETS)) {
      const matched = LINK_BUCKETS[bucket].some((kw) =>
        kw instanceof RegExp ? kw.test(lower) : lower.includes(kw)
      );
      if (!matched) continue;
      if (isListing) {
        if (!listingPages[bucket]) { listingPages[bucket] = abs; seen.add(abs); }
      } else if (buckets[bucket].length < BUCKET_CAPS[bucket]) {
        buckets[bucket].push(abs);
        seen.add(abs);
      }
      break;
    }
  }
  return { buckets, listingPages };
}

// If a bucket came back empty because the only matching link was a listing
// page (e.g. the homepage only links to /services/, not to any specific
// service), fetch that one listing page and mine it for real sub-page
// links. This costs one extra fetch, not counted as an analyzed page.
async function fillFromListingPage(bucket, listingUrl, baseUrl) {
  if (!listingUrl) return [];
  try {
    const html = await fetchPage(listingUrl);
    const base = new URL(baseUrl);
    const re = /<a\s+[^>]*href=["']([^"'#]+)["'][^>]*>/gi;
    const found = [];
    const seen = new Set();
    let m;
    while ((m = re.exec(html)) && found.length < BUCKET_CAPS[bucket]) {
      let abs;
      try { abs = new URL(m[1], base).href; } catch (e) { continue; }
      if (new URL(abs).hostname !== base.hostname) continue;
      if (abs === listingUrl || seen.has(abs)) continue;
      if (EXCLUDE_PATTERNS.some((p) => abs.toLowerCase().includes(p))) continue;
      if (isLikelyListingPage(abs)) continue;
      const lower = abs.toLowerCase();
      const matched = LINK_BUCKETS[bucket].some((kw) =>
        kw instanceof RegExp ? kw.test(lower) : lower.includes(kw)
      );
      if (matched) { found.push(abs); seen.add(abs); }
    }
    return found;
  } catch (e) {
    return [];
  }
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
  const timer = setTimeout(() => controller.abort(), timeoutMs || 8000);
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

function buildContactResults(mainHtml) {
  const text = stripHtml(mainHtml);
  const results = [];

  const phoneRe = /(\+?\d{1,3}[\s.\-]?)?\(?\d{2,4}\)?[\s.\-]?\d{2,3}[\s.\-]?\d{2,3}[\s.\-]?\d{2,4}/;
  const hasPhone = phoneRe.test(text);
  results.push({
    id: 'T7',
    verdict: hasPhone ? 'pass' : 'fail',
    why: hasPhone
      ? 'На головній сторінці є номер телефону, це базовий і очікуваний сигнал контактності для медичного сайту.'
      : 'На головній сторінці не вдалося знайти номер телефону в тексті, пацієнту складніше зрозуміти, як звʼязатися з клінікою.'
  });

  const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const hasEmail = emailRe.test(text);
  results.push({
    id: 'T8',
    verdict: hasEmail ? 'pass' : 'fail',
    why: hasEmail
      ? 'Електронна пошта вказана на головній сторінці, це додатковий канал зв’язку окрім телефону.'
      : 'Електронну пошту на головній сторінці знайти не вдалося, лишається лише телефон чи форма.'
  });

  const currentYear = new Date().getFullYear();
  const copyrightMatch = text.match(/(?:©|copyright)\D{0,10}(\d{4})/i);
  let copyrightVerdict = 'unknown';
  let copyrightWhy = 'Явного «copyright» з роком на головній сторінці не знайдено, тому перевірити актуальність неможливо.';
  if (copyrightMatch) {
    const year = parseInt(copyrightMatch[1], 10);
    if (year >= currentYear - 1) {
      copyrightVerdict = 'pass';
      copyrightWhy = 'Рік у позначці copyright актуальний (' + year + '), це слабкий, але сигнал, що сайт підтримується.';
    } else {
      copyrightVerdict = 'partial';
      copyrightWhy = 'Рік у позначці copyright застарілий (' + year + '), це може справляти враження покинутого сайту.';
    }
  }
  results.push({ id: 'T13', verdict: copyrightVerdict, why: copyrightWhy });

  const legalRe = /(privacy[\s-]?policy|політика конфіденційност|конфіденційності|публічна оферта|угода користувача|terms of use|умови використання)/i;
  const hasLegal = legalRe.test(text);
  results.push({
    id: 'T14',
    verdict: hasLegal ? 'pass' : 'fail',
    why: hasLegal
      ? 'На сайті є посилання на політику конфіденційності чи умови використання, це базова юридична прозорість.'
      : 'Посилань на політику конфіденційності або умови використання на головній сторінці не знайдено.'
  });

  return results;
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

async function handleAudit(url, controller, encoder) {
  const START = Date.now();
  const send = (obj) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));

  let mainHtml;
  try {
    mainHtml = await fetchPage(url);
  } catch (e) {
    send({ type: 'error', message: 'Не вдалося прочитати сайт за цим посиланням. Перевірте адресу.' });
    return;
  }

  // These only need the homepage, so send them the moment it's in —
  // no reason to make the visitor wait for 13 more pages to see anything.
  const contactResults = buildContactResults(mainHtml);
  for (const cr of contactResults) {
    send({ type: 'result', id: cr.id, verdict: cr.verdict, why: cr.why });
  }

  const allHtml = [mainHtml];
  const parts = ['=== Головна ===\n' + stripHtml(mainHtml).slice(0, 5500)];

  const { buckets, listingPages } = categorizeLinks(mainHtml, url);
  const fallbackJobs = Object.keys(buckets)
    .filter((bucket) => buckets[bucket].length === 0 && listingPages[bucket])
    .map((bucket) => fillFromListingPage(bucket, listingPages[bucket], url).then((found) => { buckets[bucket] = found; }));
  await Promise.allSettled(fallbackJobs);

  const toFetch = pickPagesToFetch(buckets);

  // Fetch every related page at once instead of one at a time — total time
  // becomes roughly "the slowest single page", not "the sum of all of them".
  const fetchedPages = await Promise.allSettled(
    toFetch.map((page) => fetchPage(page.url).then((html) => ({ page, html })))
  );
  for (const result of fetchedPages) {
    if (result.status !== 'fulfilled') continue; // a related page failing to load isn't fatal — skip it
    const { page, html } = result.value;
    allHtml.push(html);
    const label = extractTitle(html) || page.fallback;
    parts.push('=== ' + label + ' ===\n' + stripHtml(html).slice(0, 5500));
  }

  const schemaResults = buildSchemaResults(allHtml);
  const combinedText = parts.join('\n\n');

  for (const sr of schemaResults) {
    send({ type: 'result', id: sr.id, verdict: sr.verdict, why: sr.why });
  }

  let claudeResp;
  const claudeController = new AbortController();
  const claudeConnectTimer = setTimeout(() => claudeController.abort(), 30000);
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
        max_tokens: 2500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: combinedText }],
        stream: true
      }),
      signal: claudeController.signal
    });
  } catch (e) {
    send({ type: 'error', message: 'Помилка звернення до Claude API (з’єднання не відповіло вчасно)' });
    return;
  } finally {
    clearTimeout(claudeConnectTimer);
  }

  if (!claudeResp.ok || !claudeResp.body) {
    send({ type: 'error', message: 'Помилка Claude API' });
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
        send(JSON.parse(line));
      } catch (e) {
        // an incomplete or malformed line, worst case this one item is skipped
      }
    }
  }

  try {
    while (true) {
      if (Date.now() - START > HARD_DEADLINE_MS) {
        send({ type: 'error', message: 'Аналіз зайняв надто багато часу, показані пункти, які встигли прийти.' });
        break;
      }
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
        send(JSON.parse(trailing));
      } catch (e) {
        // trailing partial line with no final newline, nothing more to recover
      }
    }
  } catch (e) {
    send({ type: 'error', message: 'З’єднання перервалося під час аналізу.' });
  }
}

export default async function handler(request) {
  const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: jsonHeaders });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }
  let url = ((body && body.url) || '').trim();
  if (!url) {
    return new Response(JSON.stringify({ error: 'URL обов’язковий' }), { status: 400, headers: jsonHeaders });
  }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        await handleAudit(url, controller, encoder);
      } catch (e) {
        console.error('Unhandled error in /api/audit:', e);
        try {
          controller.enqueue(encoder.encode(JSON.stringify({ type: 'error', message: 'Неочікувана помилка на сервері. Спробуйте ще раз.' }) + '\n'));
        } catch (e2) {
          // controller may already be closed, nothing more to do
        }
      } finally {
        try { controller.close(); } catch (e3) { /* already closed */ }
      }
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no'
    }
  });
}

export const config = { runtime: 'nodejs' };
