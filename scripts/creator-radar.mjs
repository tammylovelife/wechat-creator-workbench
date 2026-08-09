const DEEPSEEK_API_URL = `https://api.deepseek.com/chat/completions`
const GOOGLE_NEWS_RSS = `https://news.google.com/rss/search`
const MAX_SOURCE_AGE_DAYS = 5

const queries = [
  `AI视频 模型 更新 实测 工作流 when:3d`,
  `AI视频 角色一致性 分镜 口型 视频生成 实操 when:7d`,
  `AI短剧 制作 视频生成 工作流 实操 when:7d`,
  `ComfyUI AI视频 Seedance 即梦 可灵 工作流 when:7d`,
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
  for (const item of responses.flat().filter(isFresh)) {
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
  const prompt = `你是一个中文个人公众号的资深选题编辑。账号最核心的方向：AI 视频制作、AI 短剧、角色一致性、分镜、口型、视频生成与 ComfyUI 工作流；读者是想亲自上手做内容的普通创作者。\n\n请只依据下方最近 5 天的公开来源，选出最多 5 个“作者今晚真的愿意动笔”的选题。\n\n硬性筛选：\n- 5 条里至少 4 条必须直接和 AI 视频制作相关；优先模型新能力、角色一致性、镜头控制、分镜、配音口型、短剧工作流和 ComfyUI；\n- 只推荐最近可验证的新发布、新实测或新工作流；任何旧模型版本、换壳新闻、过期教程、泛行业报道一律排除；\n- 若提到具体模型版本，只能在来源明确且确实是当前更新时推荐，绝不推荐已被新版本替代的功能；\n- 第 5 条可为创作者的选题/表达案例，但必须能直接服务 AI 视频账号；\n- 排除融资、股价、政策、纯企业公告、海外产品罗列，以及读者无法实际使用的消息；\n- 不要把新闻标题换个说法，也不要编造教程、功能、数据或爆款案例。若可靠来源不足 5 条，宁可少推。\n\n每条都必须回答“我今晚能写成什么”，写成具体、克制的公众号切口。标题要自然，有好奇心但不夸张。\n\n只返回 JSON：{\"summary\":\"给作者的一句编辑判断\",\"items\":[{\"sourceIndex\":1,\"topic\":\"具体可写的选题\",\"whyNow\":\"来源中能确认的变化，40字内\",\"writingAngle\":\"我今晚可以怎样写，60字内\",\"headline\":\"一个可直接使用的中文标题\"}]}。sourceIndex 必须对应给出的编号。\n\n来源：\n${sources.map((source, index) => `${index + 1}. 标题：${source.title}\n来源：${source.source || `公开网页`}｜时间：${source.publishedAt}\n摘要：${source.summary || `无摘要`}\n链接：${source.url}`).join(`\n\n`)}`
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

  if (!normalized.length)
    throw new Error(`DeepSeek did not return usable creator ideas`)
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
