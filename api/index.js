const { Telegraf } = require('telegraf')
const FormData = require('form-data/lib/form_data')

const TOKEN = process.env.BOT_TOKEN || ''
const BASE = process.env.URL || process.env.VERCEL_URL || ''
const OWNER = process.env.OWNER_ID || ''

let kv
try { kv = require('@vercel/kv').kv } catch (e) { kv = null }
const mem = {}

function getCh(uid) { return Promise.resolve(mem[uid] || []) }
function setCh(uid, list) {
  mem[uid] = list
  if (kv) kv.set('ch:' + uid, list).catch(() => {})
}

let bot
let botReady = false
const botPromise = (async () => {
  if (!TOKEN) return
  bot = new Telegraf(TOKEN)
  try { await bot.telegram.getMe() } catch (e) { console.warn('getMe:', e.message) }
  botReady = true
  if (BASE && !BASE.includes('localhost')) {
    bot.telegram.setWebhook(BASE.replace(/\/+$/, '') + '/api/webhook').catch(() => {})
  }
})()

function parseBody(req) {
  return new Promise(r => {
    const ct = req.headers['content-type'] || ''
    if (ct.includes('multipart/form-data')) {
      const busboy = require('busboy')
      const bb = busboy({ headers: req.headers })
      const fields = {}
      const files = {}
      let done = false
      bb.on('field', (name, val) => { try { fields[name] = JSON.parse(val) } catch (e) { fields[name] = val } })
      bb.on('file', (name, stream, info) => {
        const chunks = []
        stream.on('data', c => chunks.push(c))
        stream.on('end', () => { files[name] = { buffer: Buffer.concat(chunks), filename: info.filename, mime: info.mimeType } })
      })
      bb.on('finish', () => { if (!done) { done = true; r({ fields, files }) } })
      bb.on('error', () => { if (!done) { done = true; r({ fields, files }) } })
      req.pipe(bb)
    } else {
      let b = ''
      req.on('data', c => b += c)
      req.on('end', () => { try { r({ fields: JSON.parse(b), files: {} }) } catch (e) { r({ fields: {}, files: {} }) } })
    }
  })
}

function json(res, data, s = 200) {
  res.writeHead(s, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  })
  res.end(JSON.stringify(data))
}

async function uploadImageToTg(buffer, mime, uploadChatId) {
  try {
    const fd = new FormData()
    fd.append('chat_id', String(uploadChatId))
    fd.append('photo', buffer, { filename: 'photo.' + (mime && mime.includes('png') ? 'png' : 'jpg'), contentType: mime || 'image/jpeg' })
    const r = await fetch('https://api.telegram.org/bot' + TOKEN + '/sendPhoto', { method: 'POST', body: fd, headers: fd.getHeaders() })
    const d = await r.json()
    if (!d.ok) return null
    return d.result.photo[d.result.photo.length - 1].file_id
  } catch (e) { return null }
}

async function getFileUrl(fileId) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + TOKEN + '/getFile?file_id=' + fileId)
    const d = await r.json()
    if (!d.ok) return null
    return 'https://api.telegram.org/file/bot' + TOKEN + '/' + d.result.file_path
  } catch (e) { return null }
}

async function sendFallback(chatId, html) {
  const safe = html
    .replace(/<tg-slideshow[\s\S]*?<\/tg-slideshow>/gi, '')
    .replace(/ src="attach:\/\/[^"]*"/gi, '')
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
    .replace(/<pre>/gi, '<pre>').replace(/<\/pre>/gi, '</pre>')
    .replace(/<code>/gi, '<code>').replace(/<\/code>/gi, '</code>')
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

async function handler(req, res) {
  const url = new URL(req.url, 'http://h')
  const path = url.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    })
    res.end()
    return
  }

  const cors = (s) => { res.setHeader('Access-Control-Allow-Origin', '*'); return s }

  try {
    if (req.method === 'GET' && path === '/api/health') {
      return json(res, { ok: true, bot: !!bot })
    }

    if (req.method === 'GET' && path === '/api/channels') {
      const uid = url.searchParams.get('userId')
      if (!uid) return json(res, { error: 'Missing userId' }, 400)
      return json(res, { ok: true, channels: await getCh(uid) })
    }

    if (req.method === 'POST' && path === '/api/channels/add') {
      const { fields } = await parseBody(req)
      const { userId, username } = fields
      if (!userId || !username) return json(res, { ok: false, error: 'Missing fields' }, 400)
      if (!bot) return json(res, { ok: false, error: 'Bot not ready' }, 503)
      try {
        const clean = username.replace('@', '').trim()
        const chat = await bot.telegram.getChat('@' + clean)
        if (chat.type !== 'channel') return json(res, { ok: false, error: 'Не канал' }, 400)
        const me = bot.botInfo || await bot.telegram.getMe()
        const member = await bot.telegram.getChatMember(chat.id, me.id)
        if (!member || !['administrator', 'creator'].includes(member.status)) return json(res, { ok: false, error: 'Бот не админ' }, 400)
        const list = await getCh(userId)
        if (!list.find(c => c.id === chat.id)) list.push({ id: chat.id, title: chat.title, username: '@' + clean, added: Date.now() })
        await setCh(userId, list)
        return json(res, { ok: true, channel: { id: chat.id, title: chat.title, username: '@' + clean } })
      } catch (e) {
        return json(res, { ok: false, error: e.code === 400 ? 'Не найден' : e.message }, 400)
      }
    }

    if (req.method === 'POST' && path === '/api/channels/remove') {
      const { fields } = await parseBody(req)
      const { userId, channelId } = fields
      if (!userId || !channelId) return json(res, { ok: false, error: 'Missing fields' }, 400)
      const id = Number(channelId)
      await setCh(userId, (await getCh(userId)).filter(c => c.id !== id))
      return json(res, { ok: true })
    }

    if (req.method === 'POST' && path === '/api/publish') {
      const body = await parseBody(req)
      const { fields, files } = body
      const { userId, destination, html, text, channelId } = fields
      if (!userId || !destination || !text) return json(res, { ok: false, error: 'Missing fields' }, 400)
      await botPromise
      if (!bot || !botReady) return json(res, { ok: false, error: 'Bot not ready' }, 503)

      const { toRichHtml } = require('../lib/rich')
      let richHtml = toRichHtml(html || text)
      const imageKeys = Object.keys(files).filter(k => k.startsWith('img_')).sort()
      let chatId, chInfo
      if (destination === 'channel') {
        const list = await getCh(userId)
        if (!list.length) return json(res, { ok: false, error: 'no_channels' })
        const chId = channelId ? Number(channelId) : null
        chInfo = chId ? list.find(c => c.id === chId) : list[0]
        if (!chInfo) return json(res, { ok: false, error: 'channel_not_found' }, 400)
        chatId = chInfo.id
      } else {
        const uid = Number(userId)
        chatId = uid > 0 ? uid : Number(OWNER) || 0
        if (!chatId) return json(res, { ok: false, error: 'no_user_id' }, 400)
      }

      async function sendIt(html) {
        const clean = html.replace(/ src="attach:\/\/[^"]*"/gi, '').replace(/<tg-slideshow[\s\S]*?<\/tg-slideshow>/gi, '')
        try {
          const sent = await bot.telegram.callApi('sendRichMessage', { chat_id: chatId, rich_message: { html: clean } })
          if (destination === 'channel') {
            const link = chInfo?.username ? 'https://t.me/' + chInfo.username.replace('@', '') + '/' + sent.message_id : null
            return json(res, { ok: true, channel: chInfo?.title, link })
          }
          return json(res, { ok: true })
        } catch (e) {
          try {
            const fallback = await sendFallback(chatId, clean)
            if (fallback.ok) return json(res, { ok: true, fallback: true, msg: 'Без rich-форматирования' })
          } catch (_) {}
          return json(res, { ok: false, error: e.message + (e.description ? ' — ' + e.description : '') }, 500)
        }
      }

      if (imageKeys.length > 0) {
        const payload = {
          chat_id: chatId,
          rich_message: { html: richHtml, files: imageKeys.map(k => ({ file: 'attach://' + k })) }
        }
        for (const key of imageKeys) {
          const file = files[key]
          if (file && file.buffer && file.buffer.length > 0) {
            payload[key] = { source: file.buffer, filename: file.filename || (key + '.jpg') }
          }
        }
        try {
          const sent = await bot.telegram.callApi('sendRichMessage', payload)
          if (destination === 'channel') {
            const link = chInfo?.username ? 'https://t.me/' + chInfo.username.replace('@', '') + '/' + sent.message_id : null
            return json(res, { ok: true, channel: chInfo?.title, link })
          }
          return json(res, { ok: true })
        } catch (e) {
          return sendIt(richHtml)
        }
      } else {
        return sendIt(richHtml)
      }
    }

    if (req.method === 'POST' && path === '/api/webhook') {
      if (!bot) return json(res, { ok: false }, 200)
      const body = await parseBody(req)
      try { await bot.handleUpdate(body.fields) } catch (e) {}
      return json(res, { ok: true }, 200)
    }

    json(res, { error: 'Not found' }, 404)
  } catch (e) {
    json(res, { error: e.message }, 500)
  }
}

module.exports = handler
