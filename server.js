const express = require('express')
const { Telegraf } = require('telegraf')

const busboy = require('busboy')
const path = require('path')
const { toRichHtml, toStandardHtml } = require('./lib/rich')
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend')

const app = express()
const PORT = process.env.PORT || 3000
const TOKEN = process.env.BOT_TOKEN || ''
const BASE = process.env.URL || `http://localhost:${PORT}`

/* === CORS === */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})
app.use(express.json())

/* === Channel storage (KV / in-memory) === */
let kv
try { kv = require('@vercel/kv').kv } catch (e) { kv = null }
const mem = {}
function getCh(uid) { return Promise.resolve(mem[uid] || []) }
function setCh(uid, list) {
  mem[uid] = list
  if (kv) kv.set('ch:' + uid, list).catch(() => {})
}

/* === Bot === */
let bot
let botReady = false
const OWNER = process.env.OWNER_ID || ''
const botPromise = (async () => {
  if (!TOKEN) return
  bot = new Telegraf(TOKEN)
  try { await bot.telegram.getMe() } catch (e) { console.warn('getMe:', e.message) }
  botReady = true
  if (BASE && !BASE.includes('localhost')) {
    bot.telegram.setWebhook(BASE.replace(/\/+$/, '') + '/webhook').catch(() => {})
  }
})()

/* === Multipart parser === */
function parseMultipart(req) {
  return new Promise((resolve) => {
    const bb = busboy({ headers: req.headers })
    const fields = {}
    const files = {}
    bb.on('field', (name, val) => {
      try { fields[name] = JSON.parse(val) } catch (e) { fields[name] = val }
    })
    bb.on('file', (name, stream, info) => {
      const chunks = []
      stream.on('data', (c) => chunks.push(c))
      stream.on('end', () => { files[name] = { buffer: Buffer.concat(chunks), filename: info.filename, mime: info.mimeType } })
    })
    bb.on('finish', () => resolve({ fields, files }))
    bb.on('error', () => resolve({ fields, files }))
    req.pipe(bb)
  })
}

async function sendFallback(chatId, html) {
  const safe = html
    .replace(/<tg-slideshow[\s\S]*?<\/tg-slideshow>/gi, '')
    .replace(/ src="attach:\/\/[^"]*"/gi, '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<tg-emoji[^>]*>.*?<\/tg-emoji>/gi, '👍')
    .replace(/<tg-sub[^>]*>/gi, '').replace(/<\/tg-sub>/gi, '')
    .replace(/<tg-sup[^>]*>/gi, '').replace(/<\/tg-sup>/gi, '')
    .replace(/<tg-marked[^>]*>/gi, '<b>').replace(/<\/tg-marked>/gi, '</b>')
    .replace(/<tg-math[^>]*>([\s\S]*?)<\/tg-math>/gi, '$1')
    .replace(/<tg-map[^>]*\/>/gi, '')
    .replace(/<details[\s\S]*?<\/details>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?aside[^>]*>/gi, '')
    .replace(/ class="[^"]*"/gi, '')
    .replace(/ contenteditable="[^"]*"/gi, '')
    .replace(/<h([1-3])>/gi, '<b>').replace(/<\/h([1-3])>/gi, '</b>')
    .trim()
  if (!safe) return { ok: false, error: 'empty after fallback' }
  try {
    const sent = await bot.telegram.sendMessage(chatId, safe.slice(0, 4096), { parse_mode: 'HTML' })
    return { ok: true, message_id: sent.message_id }
  } catch (_) {
    const plain = safe.replace(/<[^>]+>/g, '').trim()
    if (!plain) return { ok: false, error: 'empty' }
    const sent = await bot.telegram.sendMessage(chatId, plain.slice(0, 4096))
    return { ok: true, message_id: sent.message_id, plain: true }
  }
}

/* === Routes === */

app.get('/api/health', (req, res) => {
  res.json({ ok: true, bot: !!bot })
})

app.get('/api/channels', async (req, res) => {
  const uid = req.query.userId
  if (!uid) return res.status(400).json({ error: 'Missing userId' })
  res.json({ ok: true, channels: await getCh(uid) })
})

app.post('/api/channels/add', async (req, res) => {
  const { userId, username } = req.body
  if (!userId || !username) return res.status(400).json({ ok: false, error: 'Missing fields' })
  if (!bot) return res.status(503).json({ ok: false, error: 'Bot not ready' })
  try {
    const clean = username.replace('@', '').trim()
    const chat = await bot.telegram.getChat('@' + clean)
    if (chat.type !== 'channel') return res.status(400).json({ ok: false, error: 'Не канал' })
    const me = bot.botInfo || await bot.telegram.getMe()
    const member = await bot.telegram.getChatMember(chat.id, me.id)
    if (!member || !['administrator', 'creator'].includes(member.status)) return res.status(400).json({ ok: false, error: 'Бот не админ' })
    const list = await getCh(userId)
    if (!list.find((c) => c.id === chat.id)) list.push({ id: chat.id, title: chat.title, username: '@' + clean, added: Date.now() })
    await setCh(userId, list)
    res.json({ ok: true, channel: { id: chat.id, title: chat.title, username: '@' + clean } })
  } catch (e) {
    res.status(400).json({ ok: false, error: e.code === 400 ? 'Не найден' : e.message })
  }
})

app.post('/api/channels/remove', async (req, res) => {
  const { userId, channelId } = req.body
  if (!userId || !channelId) return res.status(400).json({ ok: false, error: 'Missing fields' })
  await setCh(userId, (await getCh(userId)).filter((c) => c.id !== Number(channelId)))
  res.json({ ok: true })
})

app.post('/api/emoji', async (req, res) => {
  const { ids } = req.body
  if (!ids || !Array.isArray(ids) || !ids.length) return res.status(400).json({ ok: false, error: 'Missing ids' })
  await botPromise
  if (!bot || !botReady) return res.status(503).json({ ok: false, error: 'Bot not ready' })
  try {
    const stickers = await bot.telegram.callApi('getCustomEmojiStickers', { custom_emoji_ids: ids })
    const emojis = await Promise.all(stickers.map(async (s) => {
      const file = await bot.telegram.getFile(s.file_id)
      return { id: s.custom_emoji_id, url: 'https://api.telegram.org/file/bot' + TOKEN + '/' + file.file_path }
    }))
    res.json({ ok: true, emojis })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/api/publish', async (req, res) => {
  const ct = req.headers['content-type'] || ''
  let fields, files
  if (ct.includes('multipart/form-data')) {
    const parsed = await parseMultipart(req)
    fields = parsed.fields; files = parsed.files
  } else {
    fields = req.body; files = {}
  }
  const { userId, destination, html, text, channelId } = fields
  if (!userId || !destination || !text) return res.status(400).json({ ok: false, error: 'Missing fields' })
  await botPromise
  if (!bot || !botReady) return res.status(503).json({ ok: false, error: 'Bot not ready' })

  const richHtml = toRichHtml(html || text)
  const imageKeys = Object.keys(files).filter((k) => k.startsWith('img_')).sort()
  let chatId, chInfo

  if (destination === 'channel') {
    const list = await getCh(userId)
    if (!list.length) return res.status(400).json({ ok: false, error: 'no_channels' })
    const chId = channelId ? Number(channelId) : null
    chInfo = chId ? list.find((c) => c.id === chId) : list[0]
    if (!chInfo) return res.status(400).json({ ok: false, error: 'channel_not_found' })
    chatId = chInfo.id
  } else {
    const uid = Number(userId)
    chatId = uid > 0 ? uid : Number(OWNER) || 0
    if (!chatId) return res.status(400).json({ ok: false, error: 'no_user_id' })
  }

  function link(msgId) {
    if (destination !== 'channel' || !chInfo?.username) return null
    return 'https://t.me/' + chInfo.username.replace('@', '') + '/' + msgId
  }
  function ok(msgId) {
    return res.json({ ok: true, message_id: msgId, channel: chInfo?.title, link: link(msgId) })
  }

  /* Try sendRichMessage (Bot API 10.1+) — supports all rich formatting */
  async function tryRich(html, fileMap) {
    const payload = { chat_id: chatId, rich_message: { html } }
    if (fileMap) {
      payload.rich_message.files = fileMap.map((k) => ({ file: 'attach://' + k }))
      for (const key of fileMap) {
        const f = files[key]
        if (f && f.buffer && f.buffer.length > 0) payload[key] = { source: f.buffer, filename: f.filename || (key + '.jpg') }
      }
    }
    try {
      const sent = await Promise.race([
        bot.telegram.callApi('sendRichMessage', payload),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
      ])
      return sent.message_id
    } catch (e) {
      console.warn('tryRich:', e.description || e.message)
      throw e
    }
  }

  /* Safe HTML truncation — never cut inside a tag */
  function truncHtml(s, max) {
    if (s.length <= max) return s
    const cut = s.slice(0, max)
    const lo = cut.lastIndexOf('<')
    const lc = cut.lastIndexOf('>')
    return lo > lc ? cut.slice(0, lo) : cut
  }

  /* Standard API: sendPhoto / sendMediaGroup / sendMessage with parse_mode: 'HTML' */
  async function tryStandard(html, photoKeys) {
    const stdHtml = toStandardHtml(html)
    const fileList = photoKeys.map((k) => files[k]).filter((f) => f && f.buffer && f.buffer.length > 0)
    const makeInput = (f) => ({ source: f.buffer, filename: f.filename || 'photo.jpg' })

    if (fileList.length === 1) {
      const sent = await bot.telegram.sendPhoto(chatId, makeInput(fileList[0]), {
        caption: truncHtml(stdHtml, 1024), parse_mode: 'HTML'
      })
      return sent.message_id
    }
    if (fileList.length > 1) {
      const media = fileList.map((f, i) => ({
        type: 'photo', media: makeInput(f),
        ...(i === fileList.length - 1 ? { caption: truncHtml(stdHtml, 1024), parse_mode: 'HTML' } : {})
      }))
      const sent = await bot.telegram.sendMediaGroup(chatId, media)
      return sent[sent.length - 1].message_id
    }
    const sent = await bot.telegram.sendMessage(chatId, truncHtml(stdHtml, 4096), { parse_mode: 'HTML' })
    return sent.message_id
  }

  try {
    if (imageKeys.length > 0) {
      /* Photos: Standard API (sendPhoto/sendMediaGroup) is most reliable */
      try {
        const id = await tryStandard(richHtml, imageKeys)
        return ok(id)
      } catch (_) {
        /* Fall back to sendRichMessage (supports inline images + rich formatting) */
        try {
          const id = await tryRich(richHtml, imageKeys)
          return ok(id)
        } catch (_2) {
          const fallback = await sendFallback(chatId, richHtml)
          if (fallback.ok) return ok(fallback.message_id)
          throw new Error('All send methods failed')
        }
      }
    } else {
      try {
        const id = await tryRich(richHtml, null)
        return ok(id)
      } catch (_) {
        try {
          const id = await tryStandard(richHtml, [])
          return ok(id)
        } catch (_2) {
          const fallback = await sendFallback(chatId, richHtml)
          if (fallback.ok) return ok(fallback.message_id)
          throw new Error('All send methods failed')
        }
      }
    }
  } catch (e) {
    console.error('publish error:', e)
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/webhook', async (req, res) => {
  if (!bot) return res.status(200).json({ ok: false })
  try { await bot.handleUpdate(req.body) } catch (e) {}
  res.json({ ok: true })
})

/* === Serve frontend static files === */
app.use(express.static(FRONTEND_DIR))

/* === 404 === */
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' })
})

/* === Start === */
app.listen(PORT, () => {
  console.log('Backend running on http://localhost:' + PORT)
  if (TOKEN) console.log('Bot token loaded')
})
