// Vercel Serverless Function — POST { url } -> EEAT audit JSON
// Deploy target for the checklist in eeat_checklist_breakdown.md.
// Requires env var ANTHROPIC_API_KEY (Vercel dashboard -> Settings -> Environment Variables).

const SYSTEM_PROMPT = `Ты — эксперт по EEAT-аудиту медицинских сайтов (Experience, Expertise,
Authoritativeness, Trustworthiness). Тебе передан извлечённый текстовый
контент со страниц сайта клиники, размеченный по страницам. Оцени каждый
пункт из списка ниже строго по переданному контенту.

Пункты для оценки:

E2 — Результаты работы врача / кейсы / достижения: есть ли конкретный кейс
с деталями (диагноз/процедура/результат), а не общая фраза о «большом опыте».
E3 — Именной комментарий врача об услуге: есть ли цитата, приписанная
конкретному врачу по имени (не безличная «наши специалисты считают»).
E4 — Комментарии врачей/экспертов в блоге: есть ли именная атрибуция автора.
X3 — Образование врача указано конкретно: назван вуз и специальность, а не
просто слово «высшее».
X4 — Стаж/опыт работы врача указан конкретно: есть число лет или год начала
практики, а не расплывчатое «большой опыт».
X6 — Сертификаты/дипломы/лицензии врача упомянуты в тексте (текстовое
упоминание, не фото).
X7 — Блок приоритетных направлений на главной содержателен: названы
конкретные направления, а не общие слова вроде «лечим всё».
X8 — Блок оборудования называет конкретные модели/бренды, а не только
«современное оборудование».
X9 — SEO-текст о клинике содержательный, специфичный именно для этой
клиники, а не шаблонный.
X10 — Показания и противопоказания на странице услуги: минимум 2-3
конкретных пункта в каждом блоке, не общая фраза.
X11 — Симптомы / когда показана услуга описаны информативно.
X12 — Этапы/процесс оказания услуги описаны по шагам.
X13 — Этапы подготовки к процедуре описаны.
X14 — Блок реабилитации/восстановления описан.
A7 — Автор/рецензент статьи в блоге кликабелен и ведёт на страницу с его
данными.
A8 — Ссылки на источники в статьях блога — на авторитетные ресурсы
(медицинские ассоциации, .gov, PubMed), а не случайные сайты.
T1 — Страница «Про клинику» существует и содержательна (не заглушка на
2 предложения).
T2 — Сертификаты и лицензии клиники упомянуты или показаны.
T4 — Отзывы (на главной, у врача, на странице услуги) выглядят подлинными:
есть конкретика (имя, что именно понравилось), а не шаблонное «отличная
клиника, всем советую».
T9 — Информация о лицензии в футере конкретная: указан номер лицензии,
а не просто фраза «лицензировано».
T11 — Медицинский дисклеймер присутствует и уместен по содержанию.
T17 — Блок FAQ на странице услуги есть и отвечает по существу, а не
формально.

Правила:
1. Оценивай СТРОГО по переданному тексту. Если данных для оценки пункта
нет — verdict = "unknown". Никогда не угадывай и не додумывай то, чего
нет в тексте.
2. Для каждого пункта верни: id, verdict (pass / partial / fail / unknown),
reason (1-2 предложения, почему такой вердикт), recommendation (конкретная
рекомендация, что исправить; если verdict = pass — можно пустую строку).
3. Ответ — строго JSON, без преамбулы, без markdown-обёртки (без три
обратных кавычки), без комментариев до или после JSON.

Формат ответа:
{"results":[{"id":"E2","verdict":"pass","reason":"...","recommendation":"..."}]}

Верни ровно 22 объекта в results — по одному на каждый пункт из списка выше,
в том же порядке.`;

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
    { id: 'SCHEMA-DOC', label: 'врача (Physician/Person)', ok: hasType(/Physician|^Person$/i) },
    { id: 'SCHEMA-SERVICE', label: 'услуги (MedicalProcedure)', ok: hasType(/MedicalProcedure/i) }
  ];
  return checks.map((c) => ({
    id: c.id,
    verdict: c.ok ? 'pass' : 'fail',
    reason: c.ok
      ? 'Найдена в JSON-LD на прочитанных страницах.'
      : 'Не найдена в JSON-LD ни на одной из прочитанных страниц: ' + c.label + '.',
    recommendation: c.ok ? '' : 'Добавить JSON-LD со схемой ' + c.label + '.'
  }));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let url = (req.body && req.body.url || '').trim();
  if (!url) {
    res.status(400).json({ error: 'URL обязателен' });
    return;
  }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  let mainHtml;
  try {
    mainHtml = await fetchPage(url);
  } catch (e) {
    res.status(502).json({ error: 'Не удалось прочитать сайт по этой ссылке. Проверьте адрес.' });
    return;
  }

  const allHtml = [mainHtml];
  const parts = ['=== Главная ===\n' + stripHtml(mainHtml).slice(0, 8000)];

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
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: combinedText }]
      })
    });
    claudeData = await claudeResp.json();
  } catch (e) {
    res.status(502).json({ error: 'Ошибка обращения к Claude API' });
    return;
  }

  if (claudeData.error) {
    res.status(502).json({ error: claudeData.error.message || 'Ошибка Claude API' });
    return;
  }

  const textBlocks = (claudeData.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const clean = textBlocks.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    res.status(502).json({ error: 'Не удалось разобрать ответ модели. Попробуйте ещё раз.' });
    return;
  }

  res.status(200).json({
    results: [...(parsed.results || []), ...schemaResults],
    pagesRead: parts.length
  });
};
