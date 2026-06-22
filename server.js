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
let botInfo = null
let bot
function initBot() {
  if (!TOKEN || bot) return
  bot = new Telegraf(TOKEN)
  bot.telegram.getMe().then((me) => { botInfo = me }).catch(() => {})
  if (BASE && !BASE.includes('localhost')) {
    bot.telegram.setWebhook(BASE.replace(/\/+$/, '') + '/webhook').catch(() => {})
  }
}
initBot()

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
async function uploadImageToTg(buffer, mime) {
  try {
    const fd = new FormData()
    fd.append('chat_id', String(process.env.OWNER_ID || '0'))
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
  if (!bot) return res.status(503).json({ ok: false, error: 'Bot not ready' })

  let richHtml = toRichHtml(html || text)
  const imageKeys = Object.keys(files).filter((k) => k.startsWith('img_')).sort()

  if (imageKeys.length > 0) {
    for (const key of imageKeys) {
      const file = files[key]
      if (file && file.buffer && file.buffer.length > 0) {
        const url = await uploadImageToTg(file.buffer, file.mime)
        if (url) richHtml = richHtml.replace('attach://' + key, url)
      }
    }
  }

  try {
    const richMessage = { html: richHtml }
    if (destination === 'channel') {
      const list = await getCh(userId)
      if (!list.length) return res.status(400).json({ ok: false, error: 'no_channels' })
      const chId = channelId ? Number(channelId) : null
      const ch = chId ? list.find((c) => c.id === chId) : list[0]
      if (!ch) return res.status(400).json({ ok: false, error: 'channel_not_found' })
      const sent = await bot.telegram.callApi('sendRichMessage', { chat_id: ch.id, rich_message: richMessage })
      const link = ch.username ? 'https://t.me/' + ch.username.replace('@', '') + '/' + sent.message_id : null
      res.json({ ok: true, channel: ch.title, link })
    } else if (destination === 'saved') {
      const uid = Number(userId)
      const targetId = uid > 0 ? uid : Number(process.env.OWNER_ID) || 0
      if (!targetId) return res.status(400).json({ ok: false, error: 'no_user_id' })
      await bot.telegram.callApi('sendRichMessage', { chat_id: targetId, rich_message: richMessage })
      res.json({ ok: true })
    } else {
      res.status(400).json({ ok: false, error: 'unknown_destination' })
    }
  } catch (e) {
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
