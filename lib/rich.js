function toRichHtml(html) {
  html = html.replace(/<span[^>]*class="[^"]*spoiler[^"]*"[^>]*>([\s\S]*?)<\/span>/gi, '<tg-spoiler>$1</tg-spoiler>')
  html = html.replace(/<span[^>]*class="[^"]*tg-emoji[^"]*"[^>]*data-id="([^"]*)"[^>]*>([\s\S]*?)<\/span>/gi, '<tg-emoji emoji-id="$1">$2</tg-emoji>')
  html = html.replace(/<ul[^>]*class="[^"]*task[^"]*"[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner) => {
    inner = inner.replace(/<li[^>]*class="[^"]*done[^"]*"[^>]*>/gi, '<li><input type="checkbox" checked>')
    inner = inner.replace(/<li[^>]*>/gi, '<li><input type="checkbox">')
    return '<ul>' + inner + '</ul>'
  })
  html = html.replace(/<aside[^>]*class="[^"]*pull-quote[^"]*"[^>]*>([\s\S]*?)<\/aside>/gi, '<aside>$1</aside>')
  html = html.replace(/<div[^>]*class="[^"]*slideshow[^"]*"[^>]*>([\s\S]*?)<\/div>/gi, '<tg-slideshow>$1</tg-slideshow>')
  html = html.replace(/<div[^>]*class="[^"]*map[^"]*"([^>]*)>/gi, (_, a) => {
    const lat = (a.match(/data-lat="([^"]*)"/) || [])[1] || '0'
    const lng = (a.match(/data-lng="([^"]*)"/) || [])[1] || '0'
    const addr = (a.match(/data-address="([^"]*)"/) || [])[1]
    return addr ? '<tg-map lat="' + lat + '" long="' + lng + '" address="' + addr + '"/>' : '<tg-map lat="' + lat + '" long="' + lng + '"/>'
  })
  html = html.replace(/<span[^>]*class="[^"]*tg-sub[^"]*"[^>]*>([\s\S]*?)<\/span>/gi, '<tg-sub>$1</tg-sub>')
  html = html.replace(/<span[^>]*class="[^"]*tg-sup[^"]*"[^>]*>([\s\S]*?)<\/span>/gi, '<tg-sup>$1</tg-sup>')
  html = html.replace(/<mark[^>]*>([\s\S]*?)<\/mark>/gi, '<tg-marked>$1</tg-marked>')
  html = html.replace(/<details[^>]*class="[^"]*tg-details[^"]*"[^>]*>([\s\S]*?)<\/details>/gi, '<details>$1</details>')
  html = html.replace(/<span[^>]*class="[^"]*tg-math[^"]*"[^>]*>([\s\S]*?)<\/span>/gi, '<tg-math>$1</tg-math>')
  html = html.replace(/<pre[^>]*class="[^"]*tg-code[^"]*"[^>]*>([\s\S]*?)<\/pre>/gi, '<pre>$1</pre>')
  html = html.replace(/\sclass="[^"]*"/gi, '')
  html = html.replace(/<br\s*\/?>/gi, '\n')
  return html.trim()
}

/* Convert rich HTML to standard parse_mode: 'HTML' */
function toStandardHtml(html) {
  html = html
    .replace(/<h([1-3])>/gi, '<b>').replace(/<\/h([1-3])>/gi, '</b>')
    .replace(/<tg-sub[^>]*>([\s\S]*?)<\/tg-sub>/gi, '$1')
    .replace(/<tg-sup[^>]*>([\s\S]*?)<\/tg-sup>/gi, '$1')
    .replace(/<tg-marked[^>]*>([\s\S]*?)<\/tg-marked>/gi, '<b>$1</b>')
    .replace(/<tg-math[^>]*>([\s\S]*?)<\/tg-math>/gi, '<i>$1</i>')
    .replace(/<tg-emoji[^>]*>.*?<\/tg-emoji>/gi, '👍')
    .replace(/<tg-slideshow[\s\S]*?<\/tg-slideshow>/gi, '')
    .replace(/ src="attach:\/\/[^"]*"/gi, '')
    .replace(/<tg-map[^>]*\/>/gi, '')
    .replace(/<aside[^>]*>([\s\S]*?)<\/aside>/gi, '<i>$1</i>')
    .replace(/<details[\s\S]*?<\/details>/gi, '')
    .replace(/<table[\s\S]*?<\/table>/gi, '')
    .replace(/<hr\s*\/?>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\s(contenteditable|data-[a-z]+)="[^"]*"/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return html
}

module.exports = { toRichHtml, toStandardHtml }
