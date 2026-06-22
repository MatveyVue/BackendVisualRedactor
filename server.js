const express = require('express')
const { Telegraf } = require('telegraf')
const FormData = require('form-data/lib/form_data')
const busboy = require('busboy')
const path = require('path')
const { toRichHtml } = require('./lib/rich')
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
  try {
    await bot.telegram.getMe()
    botReady = true
  } catch (e) { console.error('bot init fail:', e.message) }
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

/* === Upload image to Telegram === */
async function uploadImageToTg(buffer, mime, chatId) {
  try {
    const fd = new FormData()
    fd.append('chat_id', String(chatId || OWNER || (bot ? (await bot.telegram.getMe()).id : '0')))
    fd.append('photo', buffer, { filename: 'photo.' + (mime && mime.includes('png') ? 'png' : 'jpg'), contentType: mime || 'image/jpeg' })
    const r = await fetch('https://api.telegram.org/bot' + TOKEN + '/sendPhoto', { method: 'POST', body: fd, headers: fd.getHeaders() })
    const d = await r.json()
    if (!d.ok) return null
    const fileId = d.result.photo[d.result.photo.length - 1].file_id
    const fr = await fetch('https://api.telegram.org/bot' + TOKEN + '/getFile?file_id=' + fileId)
    const f = await fr.json()
    if (!f.ok) return null
    return 'https://api.telegram.org/file/bot' + TOKEN + '/' + f.result.file_path
  } catch (e) { return null }
}

async function sendFallback(chatId, html) {
  const strip = html.replace(/<tg-spoiler[^>]*>/gi, '<span class="tg-spoiler">')
    .replace(/<\/tg-spoiler>/gi, '</span>')
    .replace(/<tg-slideshow>[\s\S]*?<\/tg-slideshow>/gi, '[📷 слайдшоу]')
    .replace(/<tg-emoji[^>]*>.*?<\/tg-emoji>/gi, '👍')
    .replace(/<tg-sub[^>]*>/gi, '<small>').replace(/<\/tg-sub>/gi, '</small>')
    .replace(/<tg-sup[^>]*>/gi, '<small>').replace(/<\/tg-sup>/gi, '</small>')
    .replace(/<tg-marked[^>]*>/gi, '<b>').replace(/<\/tg-marked>/gi, '</b>')
    .replace(/<tg-math[^>]*>([\s\S]*?)<\/tg-math>/gi, '$1')
    .replace(/<tg-map[^>]*\/>/gi, '[📍 карта]')
    .replace(/<details[\s\S]*?<\/details>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '').trim()
  if (!strip) return { ok: false, error: 'empty after fallback' }
  const sent = await bot.telegram.sendMessage(chatId, strip.slice(0, 4096), { parse_mode: 'HTML' })
  return { ok: true, message_id: sent.message_id }
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
    const me = botInfo || await bot.telegram.getMe()
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

  let richHtml = toRichHtml(html || text)
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

  if (imageKeys.length > 0) {
    for (const key of imageKeys) {
      const file = files[key]
      if (file && file.buffer && file.buffer.length > 0) {
        const url = await uploadImageToTg(file.buffer, file.mime, chatId)
        if (url) richHtml = richHtml.replace('attach://' + key, url)
      }
    }
  }

  try {
    const sent = await bot.telegram.callApi('sendRichMessage', { chat_id: chatId, rich_message: { html: richHtml } })
    if (destination === 'channel') {
      const link = chInfo?.username ? 'https://t.me/' + chInfo.username.replace('@', '') + '/' + sent.message_id : null
      return res.json({ ok: true, channel: chInfo?.title, link })
    }
    res.json({ ok: true })
  } catch (e) {
    try {
      const fallback = await sendFallback(chatId, richHtml)
      if (fallback.ok) return res.json({ ok: true, fallback: true, msg: 'Без rich-форматирования' })
    } catch (_) {}
    res.status(500).json({ ok: false, error: e.message + (e.description ? ' — ' + e.description : '') })
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
