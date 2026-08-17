import { readFile, writeFile } from 'node:fs/promises'

const DEEPSEEK_API_URL = `https://api.deepseek.com/chat/completions`
const GOOGLE_NEWS_RSS = `https://news.google.com/rss/search`
const BING_NEWS_RSS = `https://www.bing.com/news/search`
const MAX_SOURCE_AGE_DAYS = 5
const HISTORY_DAYS = 14
const HISTORY_FILE = new URL(`../data/creator-radar-history.json`, import.meta.url)

const queries = [
  `AI视频 模型 更新 实测 工作流 when:3d`,
  `AI视频 角色一致性 分镜 口型 视频生成 实操 when:7d`,
  `AI短剧 制作 视频生成 工作流 实操 when:7d`,
  `重要 AI 模型 产品 发布 更新 创作者 when:3d`,
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
    const summary = field(item, `description`).replace(/<[^>]*>/g, ``)
    if (!title || !url.startsWith(`http`))
      return []
    return [{ title, url, publishedAt, source, summary: clip(summary, 360) }]
  })
}

function isFresh(item) {
  const timestamp = Date.parse(item.publishedAt)
  if (Number.isNaN(timestamp))
    return false
  const age = Date.now() - timestamp
  return age >= -24 * 60 * 60 * 1000 && age <= MAX_SOURCE_AGE_DAYS * 24 * 60 * 60 * 1000
}

async function loadSources() {
  const fetchRss = async (url, label) => {
    let lastError = `${label} unavailable`
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: {
            Accept: `application/rss+xml, application/xml, text/xml`,
            'User-Agent': `Mozilla/5.0 creator-radar/1.0`,
          },
        })
        if (!response.ok) {
          lastError = `${label} failed: ${response.status}`
        }
        else {
          const items = parseFeed(await response.text())
          if (items.length)
            return items
          lastError = `${label} returned no items`
        }
      }
      catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      if (attempt < 2)
        await new Promise(resolve => setTimeout(resolve, 800 * attempt))
    }
    return []
  }

  const responses = await Promise.all(queries.map(async (query) => {
    const googleUrl = new URL(GOOGLE_NEWS_RSS)
    googleUrl.searchParams.set(`q`, query)
    googleUrl.searchParams.set(`hl`, `zh-CN`)
    googleUrl.searchParams.set(`gl`, `CN`)
    googleUrl.searchParams.set(`ceid`, `CN:zh-Hans`)
    const googleItems = await fetchRss(googleUrl, `Google News`)
    if (googleItems.length)
      return googleItems

    const bingUrl = new URL(BING_NEWS_RSS)
    bingUrl.searchParams.set(`q`, query.replace(/\s+when:\d+d$/, ``))
    bingUrl.searchParams.set(`format`, `rss`)
    return fetchRss(bingUrl, `Bing News`)
  }))

  const history = await readHistory()
  const unique = new Map()
  for (const item of responses.flat().filter(isFresh)) {
    const key = item.title.toLowerCase()
    if (!unique.has(key) && !sourceWasSent(item, history))
      unique.set(key, item)
  }
  return [...unique.values()].slice(0, 32)
}

function clip(value, length) {
  return String(value ?? ``).replace(/\s+/g, ` `).trim().slice(0, length)
}

function historyCutoff() {
  return Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000
}

async function readHistory() {
  try {
    const parsed = JSON.parse(await readFile(HISTORY_FILE, `utf8`))
    return Array.isArray(parsed?.items)
      ? parsed.items.filter(item => Number(item?.sentAt) >= historyCutoff())
      : []
  }
  catch {
    return []
  }
}

function textKey(value) {
  return String(value ?? ``).toLowerCase().replace(/[^\p{L}\p{N}]/gu, ``)
}

function sourceWasSent(source, history) {
  const title = textKey(source.title)
  return history.some((item) => {
    if (item?.url === source.url)
      return true
    const previousTitle = textKey(item?.sourceTitle)
    return title.length > 14 && previousTitle.length > 14 && (title.includes(previousTitle) || previousTitle.includes(title))
  })
}

function historyBrief(history) {
  return history.length
    ? history.map(item => `- ${item.topic}｜${item.headline}`).join(`\n`)
    : `无`
}

async function saveHistory(items) {
  const previous = await readHistory()
  const records = [
    ...items.map(item => ({
      sentAt: Date.now(),
      topic: item.topic,
      headline: item.headline,
      sourceTitle: item.source.title,
      url: item.source.url,
    })),
    ...previous,
  ].slice(0, 100)
  await writeFile(HISTORY_FILE, `${JSON.stringify({ items: records }, null, 2)}\n`, `utf8`)
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

async function selectIdeas(sources, history, deepseekKey) {
  const prompt = `你是一个中文个人公众号的资深选题编辑。账号核心方向：AI 视频制作、AI 短剧、角色一致性、分镜、口型、视频生成与 ComfyUI 工作流；读者是想亲自上手做内容的普通创作者。\n\n请只依据下方最近 5 天的公开来源，选出最多 5 个“作者今晚真的愿意动笔”的选题。\n\n硬性筛选：\n- 优先 AI 视频/短剧制作；可保留 1 条真正重要、且能改变普通创作者工作方式的最新 AI 资讯，以及 1 条实操工具或内容表达案例；\n- 只推荐最近可验证的新发布、新实测或新工作流；旧模型版本、换壳新闻、过期教程、泛行业报道一律排除；\n- 下方列出了最近 14 天已经推送过的题目。禁止重复相同模型、相同版本、相同功能或相同教程；即使换了来源或标题也算重复。只有出现明确的新版本或实质新功能，才允许再次提及，并必须在 whyNow 中说明“新在哪里”；\n- 排除融资、股价、政策、纯企业公告、海外产品罗列，以及读者无法实际使用的消息；\n- 不要把新闻标题换个说法，也不要编造教程、功能、数据或爆款案例。可靠来源不足 5 条时宁可少推；没有明显值得写的内容时，items 返回空数组。\n\n每条都必须回答“我今晚能写成什么”，写成具体、克制的公众号切口。标题要自然，有好奇心但不夸张。\n\n只返回 JSON：{\"summary\":\"给作者的一句编辑判断；若无新内容，直接说今天没有值得打扰的更新\",\"items\":[{\"sourceIndex\":1,\"topic\":\"具体可写的选题\",\"whyNow\":\"来源中能确认的变化，40字内\",\"writingAngle\":\"我今晚可以怎样写，60字内\",\"headline\":\"一个可直接使用的中文标题\"}]}。sourceIndex 必须对应给出的编号。\n\n最近 14 天已推送（禁止重复）：\n${historyBrief(history)}\n\n候选来源：\n${sources.map((source, index) => `${index + 1}. 标题：${source.title}\n来源：${source.source || `公开网页`}｜时间：${source.publishedAt}\n摘要：${source.summary || `无摘要`}\n链接：${source.url}`).join(`\n\n`)}`
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
    [{ tag: `text`, text: `AI选题雷达｜公众号选题雷达｜AI 选题雷达\n${radar.summary || `今晚适合从“具体创作变化”切入。`}` }],
  ]
  for (const [index, item] of radar.items.entries()) {
    rows.push([{ tag: `text`, text: `${index + 1}. ${item.topic}\n今晚怎么写：${item.writingAngle}\n标题：${item.headline}\n依据：${item.whyNow}` }])
    rows.push([{ tag: `a`, text: `查看来源：${item.source.title}`, href: item.source.url }])
  }
  const response = await fetch(webhook, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({
      msg_type: `post`,
      content: {
        post: {
          zh_cn: {
            title: `AI 选题雷达 · ${dateInChina()} · ${radar.items.length} 条`,
            content: rows,
          },
        },
      },
    }),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || result?.code !== 0)
    throw new Error(`Feishu push failed: ${result?.msg || response.status}`)
}

async function main() {
  const deepseekKey = required(`DEEPSEEK_API_KEY`)
  const feishuWebhook = required(`FEISHU_WEBHOOK_URL`)
  const sources = await loadSources()
  if (sources.length < 3)
    throw new Error(`Not enough public sources today; news providers may be temporarily unavailable`)
  const history = await readHistory()
  const radar = await selectIdeas(sources, history, deepseekKey)
  await pushToFeishu(radar, feishuWebhook)
  await saveHistory(radar.items)
  console.log(`Pushed ${radar.items.length} creator ideas for ${dateInChina()}.`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
