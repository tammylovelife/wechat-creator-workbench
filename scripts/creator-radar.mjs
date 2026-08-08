const DEEPSEEK_API_URL = `https://api.deepseek.com/chat/completions`
const GOOGLE_NEWS_RSS = `https://news.google.com/rss/search`

const queries = [
  `AI tools creator workflow`,
  `AI video generation creator`,
  `AI short drama generative video`,
  `AI model product update creators`,
]

function required(name) {
  const value = process.env[name]?.trim()
  if (!value)
    throw new Error(`Missing GitHub secret: ${name}`)
  return value
}

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, `$1`)
    .replace(/&amp;/g, `&`)
    .replace(/&quot;/g, `\"`)
    .replace(/&#39;/g, `'`)
    .replace(/&lt;/g, `<`)
    .replace(/&gt;/g, `>`)
    .trim()
}

function field(item, name) {
  const match = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, `i`))
  return match ? decodeXml(match[1]) : ``
}

function parseFeed(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].flatMap(([_, item]) => {
    const title = field(item, `title`).replace(/\s+-\s+[^-]+$/, ``)
    const url = field(item, `link`)
    const publishedAt = field(item, `pubDate`)
    const source = field(item, `source`)
    if (!title || !url.startsWith(`http`))
      return []
    return [{ title, url, publishedAt, source }]
  })
}

async function loadSources() {
  const responses = await Promise.all(queries.map(async (query) => {
    const url = new URL(GOOGLE_NEWS_RSS)
    url.searchParams.set(`q`, query)
    url.searchParams.set(`hl`, `zh-CN`)
    url.searchParams.set(`gl`, `CN`)
    url.searchParams.set(`ceid`, `CN:zh-Hans`)
    const response = await fetch(url, { headers: { 'User-Agent': `creator-radar/1.0` } })
    if (!response.ok)
      throw new Error(`News source failed: ${response.status}`)
    return parseFeed(await response.text())
  }))

  const unique = new Map()
  for (const item of responses.flat()) {
    const key = item.title.toLowerCase()
    if (!unique.has(key))
      unique.set(key, item)
  }
  return [...unique.values()].slice(0, 32)
}

function clip(value, length) {
  return String(value ?? ``).replace(/\s+/g, ` `).trim().slice(0, length)
}

function parseModelJson(content) {
  const normalized = String(content ?? ``)
    .trim()
    .replace(/^```(?:json)?\s*/i, ``)
    .replace(/\s*```$/, ``)

  if (!normalized)
    throw new Error(`DeepSeek returned an empty response`)

  try {
    return JSON.parse(normalized)
  }
  catch {
    throw new Error(`DeepSeek returned incomplete JSON; please run the workflow again`)
  }
}

async function selectIdeas(sources, deepseekKey) {
  const prompt = `你是中文个人公众号的选题编辑。账号方向：AI 工具、AI 视频制作和 AI 短剧创作；读者是希望提升创作效率的普通创作者。\n\n请仅依据下面的公开新闻，挑出最值得今天写的 5 条。优先实用、真实、新鲜、能给创作者带来具体变化的信息；排除营销软文、重复报道和与创作无关的行业新闻。不要编造事实、数据或来源。\n\n只返回 JSON：{\"summary\":\"一句话判断\",\"items\":[{\"sourceIndex\":1,\"topic\":\"选题\",\"whyNow\":\"为什么值得关注\",\"writingAngle\":\"公众号切入角度\",\"headline\":\"建议标题\"}]}。sourceIndex 必须对应给出的编号。\n\n来源：\n${sources.map((source, index) => `${index + 1}. ${source.title} | ${source.source || `公开网页`} | ${source.publishedAt} | ${source.url}`).join(`\n`)}`
  const response = await fetch(DEEPSEEK_API_URL, {
    method: `POST`,
    headers: {
      Authorization: `Bearer ${deepseekKey}`,
      'Content-Type': `application/json`,
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL?.trim() || `deepseek-v4-flash`,
      thinking: { type: `disabled` },
      temperature: 0.25,
      max_tokens: 3000,
      response_format: { type: `json_object` },
      messages: [
        { role: `system`, content: `只输出合法 JSON。` },
        { role: `user`, content: prompt },
      ],
    }),
  })
  if (!response.ok)
    throw new Error(`DeepSeek request failed: ${response.status}`)

  const payload = await response.json()
  const content = payload?.choices?.[0]?.message?.content
  const parsed = parseModelJson(content)
  const items = Array.isArray(parsed?.items) ? parsed.items : []
  const seen = new Set()
  const normalized = items.flatMap((item) => {
    const sourceIndex = Number(item?.sourceIndex)
    const source = sources[sourceIndex - 1]
    const topic = clip(item?.topic, 80)
    if (!source || !topic || seen.has(sourceIndex))
      return []
    seen.add(sourceIndex)
    return [{
      source,
      topic,
      whyNow: clip(item?.whyNow, 180),
      writingAngle: clip(item?.writingAngle, 180),
      headline: clip(item?.headline, 80),
    }]
  }).slice(0, 5)

  if (normalized.length !== 5)
    throw new Error(`DeepSeek did not return five usable ideas`)
  return { summary: clip(parsed?.summary, 160), items: normalized }
}

function dateInChina() {
  return new Intl.DateTimeFormat(`zh-CN`, {
    timeZone: `Asia/Shanghai`,
    year: `numeric`,
    month: `2-digit`,
    day: `2-digit`,
  }).format(new Date()).replaceAll(`/`, `-`)
}

async function pushToFeishu(radar, webhook) {
  const rows = [
    [{ tag: `text`, text: radar.summary || `今晚适合从“具体创作变化”切入。` }],
  ]
  for (const [index, item] of radar.items.entries()) {
    rows.push([{ tag: `text`, text: `${index + 1}. ${item.topic}\n建议标题：${item.headline}\n为什么：${item.whyNow}\n切入：${item.writingAngle}` }])
    rows.push([{ tag: `a`, text: `查看来源：${item.source.title}`, href: item.source.url }])
  }
  const response = await fetch(webhook, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({
      msg_type: `post`,
      content: {
        zh_cn: {
          title: `AI 选题雷达 · ${dateInChina()} · 5 条`,
          content: rows,
        },
      },
    }),
  })
  if (!response.ok)
    throw new Error(`Feishu push failed: ${response.status}`)
}

async function main() {
  const deepseekKey = required(`DEEPSEEK_API_KEY`)
  const feishuWebhook = required(`FEISHU_WEBHOOK_URL`)
  const sources = await loadSources()
  if (sources.length < 8)
    throw new Error(`Not enough public sources today`)
  const radar = await selectIdeas(sources, deepseekKey)
  await pushToFeishu(radar, feishuWebhook)
  console.log(`Pushed ${radar.items.length} creator ideas for ${dateInChina()}.`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
