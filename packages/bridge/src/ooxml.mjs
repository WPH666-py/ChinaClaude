/**
 * A zero-dependency OOXML engine: enough ZIP + WordprocessingML + SpreadsheetML to let the model create
 * and read real .docx / .xlsx files.
 *
 * WHY HAND-ROLLED: the project ships no runtime dependencies (the bridge must start on a machine with
 * nothing installed), and the alternative — pulling a zip library plus a document library — would add
 * megabytes and a supply-chain surface to a desktop app that only needs six tools.
 *
 * WHY THE SCOPE IS THIS SMALL: a document format is a large specification, and a half-implemented one
 * that Word silently "repairs" is worse than a narrow one that is always valid. So this module writes
 * the smallest correct package for paragraphs, bullets, one table, and cell grids — and READS a bit more
 * than it writes, because incoming documents come from everywhere.
 *
 * WHAT IT DOES NOT DO: styles, images, headers/footers, shared strings on write (inline strings are
 * valid and avoid an index that can desynchronise), and number formats. Each would be its own project.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib'

// ---------------------------------------------------------------------------------------------
// ZIP container
// ---------------------------------------------------------------------------------------------

/** CRC-32, table built once. ZIP requires it and `zlib` does not expose it. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Build a ZIP archive from `[{ name, data }]`.
 *
 * Every entry is DEFLATE-compressed: a document is XML, so STORE would just waste space, and the read
 * side supports both anyway.
 */
function zipWrite(entries) {
  const chunks = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    const compressed = deflateRawSync(raw)
    const checksum = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x21, 12) // date (1980-01-01)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    // Remember where THIS entry starts before advancing: the central directory stores each part's own
    // local-header offset, not the offset after it.
    const entryOffset = offset
    chunks.push(local, name, compressed)
    offset += local.length + name.length + compressed.length

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(8, 10)
    header.writeUInt16LE(0, 12)
    header.writeUInt16LE(0x21, 14)
    header.writeUInt32LE(checksum, 16)
    header.writeUInt32LE(compressed.length, 20)
    header.writeUInt32LE(raw.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt16LE(0, 30) // extra
    header.writeUInt16LE(0, 32) // comment
    header.writeUInt16LE(0, 34) // disk
    header.writeUInt16LE(0, 36) // internal attrs
    header.writeUInt32LE(0, 38) // external attrs
    header.writeUInt32LE(entryOffset, 42)
    central.push(header, name)
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, centralBuffer, end])
}

/**
 * Read a ZIP archive into a Map of `name → Buffer`.
 *
 * The central directory is the source of truth: local headers may carry zeroed sizes (streamed archives
 * do exactly that), and an OOXML producer is free to use either method.
 */
function zipRead(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('不是有效的 Office 文件（文件太小）')

  let eocd = -1
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 66_000); index--) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 Office 文件（找不到 ZIP 结束记录）')

  const count = buffer.readUInt16LE(eocd + 10)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  const files = new Map()
  let cursor = directoryOffset

  for (let index = 0; index < count; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Office 文件损坏（中央目录不完整）')
    }
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')

    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)

    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw)
    else throw new Error(`Office 文件用了不支持的压缩方式：${method}`)

    files.set(name, data)
    cursor += 46 + nameLength + extraLength + commentLength
  }

  return files
}

// ---------------------------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------------------------

function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function xmlUnescape(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const NS_S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'

// ---------------------------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------------------------

function paragraphXml(paragraph) {
  const item = typeof paragraph === 'string' ? { text: paragraph } : paragraph ?? {}
  const text = String(item.text ?? '')
  const bullet = item.bullet === true
  // A table cell and a body paragraph cannot share the same node shape, so each call site passes what
  // it needs. `w:rPr` is where the bullet character's indentation lives.
  const properties = bullet ? '<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>' : ''
  return `<w:p>${properties}<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`
}

function tableXml(table) {
  const headers = Array.isArray(table?.headers) ? table.headers : []
  const rows = Array.isArray(table?.rows) ? table.rows : []
  const cell = (value) =>
    `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraphXml(String(value ?? ''))}</w:tc>`
  const row = (cells) => `<w:tr>${cells.map(cell).join('')}</w:tr>`
  const body = [headers.length > 0 ? row(headers) : '', ...rows.map((cells) => row(Array.isArray(cells) ? cells : []))]
    .filter((line) => line !== '')
    .join('')
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid/>${body}</w:tbl>`
}

/** The document body shared by create and append: title first, then paragraphs, then an optional table. */
function bodyXml({ title, paragraphs = [], table }) {
  const parts = []
  if (title) parts.push(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${xmlEscape(title)}</w:t></w:r></w:p>`)
  for (const paragraph of Array.isArray(paragraphs) ? paragraphs : []) parts.push(paragraphXml(paragraph))
  if (table) parts.push(tableXml(table))
  return parts.join('')
}

/**
 * Bullets need a numbering part: a `numPr` with no matching `numbering.xml` renders as a plain
 * paragraph in Word, which would silently drop the user's list.
 */
const NUMBERING_XML = `${XML_HEAD}<w:numbering xmlns:w="${NS_W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`

function documentXml(body) {
  return `${XML_HEAD}<w:document xmlns:w="${NS_W}" xmlns:r="${NS_REL}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`
}

const DOCX_CONTENT_TYPES = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`

const DOCX_ROOT_RELS = `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="word/document.xml"/></Relationships>`

const DOCX_DOC_RELS = `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/numbering" Target="numbering.xml"/></Relationships>`

/** Create a .docx from a title, paragraphs and one table. */
export function createDocx({ title, paragraphs = [], table } = {}) {
  const files = [
    { name: '[Content_Types].xml', data: DOCX_CONTENT_TYPES },
    { name: '_rels/.rels', data: DOCX_ROOT_RELS },
    { name: 'word/document.xml', data: documentXml(bodyXml({ title, paragraphs, table })) },
    { name: 'word/_rels/document.xml.rels', data: DOCX_DOC_RELS },
    { name: 'word/numbering.xml', data: NUMBERING_XML },
  ]
  return zipWrite(files)
}

/** Extract the paragraphs and tables of a .docx. */
export function readDocx(buffer) {
  const files = zipRead(buffer)
  const document = files.get('word/document.xml')
  if (!document) throw new Error('不是有效的 Word 文件（缺少 word/document.xml）')
  const xml = document.toString('utf8')

  const paragraphs = []
  let title = null
  // Table cells contain `<w:p>` too; scanning the body with tables removed is what keeps cell text from
  // appearing twice — once as a paragraph and once inside the table.
  const bodyOnly = xml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, '')
  const paragraphPattern = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g
  for (const match of bodyOnly.matchAll(paragraphPattern)) {
    const inner = match[1]
    const text = [...inner.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((part) => xmlUnescape(part[1])).join('')
    const style = /<w:pStyle w:val="([^"]+)"/.exec(inner)?.[1] ?? null
    const bullet = /<w:numPr>/.test(inner)
    if (text === '' && style === null) continue
    if (style === 'Heading1' && title === null && paragraphIsBeforeFirstText(paragraphs)) title = text
    else paragraphs.push({ text, bullet, style })
  }

  const tables = []
  const tablePattern = /<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g
  for (const match of xml.matchAll(tablePattern)) {
    const rows = []
    for (const rowMatch of match[1].matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
      const cells = []
      for (const cellMatch of rowMatch[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)) {
        const text = [...cellMatch[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((part) => xmlUnescape(part[1])).join('')
        cells.push(text)
      }
      rows.push(cells)
    }
    if (rows.length === 0) continue
    tables.push({ headers: rows[0], rows: rows.slice(1) })
  }

  return { ok: true, title, paragraphs, tables }
}

function paragraphIsBeforeFirstText(paragraphs) {
  return paragraphs.length === 0
}

/** Append paragraphs and/or a table to an existing .docx. */
export function updateDocx(buffer, { paragraphs = [], table } = {}) {
  const files = zipRead(buffer)
  const document = files.get('word/document.xml')
  if (!document) throw new Error('不是有效的 Word 文件（缺少 word/document.xml）')
  const xml = document.toString('utf8')
  const closing = '</w:body>'
  const at = xml.lastIndexOf(closing)
  if (at < 0) throw new Error('Word 文件结构异常（没有 w:body 结束标签）')

  const addition = bodyXml({ paragraphs, table })
  const next = `${xml.slice(0, at)}${addition}${xml.slice(at)}`
  files.set('word/document.xml', Buffer.from(next, 'utf8'))
  // Re-emit every part in the archive's own order so unknown parts (fonts, styles the user's tool added)
  // survive: rewriting only the ones we know about would silently strip them.
  return zipWrite([...files.entries()].map(([name, data]) => ({ name, data })))
}

// ---------------------------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------------------------

function columnName(index) {
  let value = index + 1
  let name = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

function columnIndex(name) {
  let value = 0
  for (const char of name.toUpperCase()) value = value * 26 + (char.charCodeAt(0) - 64)
  return value - 1
}

/** One cell as SpreadsheetML. Inline strings avoid a shared-strings table that can drift out of sync. */
function cellXml(cell, rowIndex, columnIndexValue) {
  const address = `${columnName(columnIndexValue)}${rowIndex + 1}`
  const item = cell !== null && typeof cell === 'object' && !Array.isArray(cell) ? cell : { value: cell }
  const formula = typeof item.formula === 'string' && item.formula !== '' ? item.formula.replace(/^=/, '') : null
  const value = item.value

  if (formula) {
    const cached = typeof value === 'number' || typeof value === 'boolean' ? String(value) : typeof value === 'string' ? xmlEscape(value) : ''
    return `<c r="${address}"><f>${xmlEscape(formula)}</f>${cached === '' ? '' : `<v>${cached}</v>`}</c>`
  }
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${address}"><v>${value}</v></c>`
  if (typeof value === 'boolean') return `<c r="${address}" t="b"><v>${value ? 1 : 0}</v></c>`
  if (value === null || value === undefined || value === '') return `<c r="${address}"/>`
  return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`
}

function sheetDataXml(rows) {
  const parts = []
  ;(Array.isArray(rows) ? rows : []).forEach((row, rowIndex) => {
    const cells = (Array.isArray(row) ? row : []).map((cell, column) => cellXml(cell, rowIndex, column)).join('')
    parts.push(`<row r="${rowIndex + 1}">${cells}</row>`)
  })
  return `<sheetData>${parts.join('')}</sheetData>`
}

function sheetNameSafe(name, index) {
  const text = String(name ?? '').trim().replace(/[\\/?*[\]:]/g, '_').slice(0, 31)
  return text === '' ? `Sheet${index + 1}` : text
}

function workbookXml(sheets) {
  const entries = sheets
    .map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('')
  return `${XML_HEAD}<workbook xmlns="${NS_S}" xmlns:r="${NS_REL}"><sheets>${entries}</sheets></workbook>`
}

function workbookRels(sheets) {
  const entries = sheets
    .map((sheet, index) => `<Relationship Id="rId${index + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
    .join('')
  return `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">${entries}</Relationships>`
}

function xlsxContentTypes(sheets) {
  const overrides = sheets
    .map((sheet, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('')
  return `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}</Types>`
}

function xlsxRootRels() {
  return `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
}

function sheetXml(rows) {
  return `${XML_HEAD}<worksheet xmlns="${NS_S}" xmlns:r="${NS_REL}">${sheetDataXml(rows)}</worksheet>`
}

function normalizeSheets(sheets) {
  const list = (Array.isArray(sheets) ? sheets : []).map((sheet, index) => ({
    name: sheetNameSafe(sheet?.name, index),
    rows: Array.isArray(sheet?.rows) ? sheet.rows : [],
  }))
  if (list.length === 0) throw new Error('至少需要一个工作表')
  return list
}

function buildXlsx(sheets) {
  const files = [
    { name: '[Content_Types].xml', data: xlsxContentTypes(sheets) },
    { name: '_rels/.rels', data: xlsxRootRels() },
    { name: 'xl/workbook.xml', data: workbookXml(sheets) },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels(sheets) },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: sheetXml(sheet.rows) })),
  ]
  return zipWrite(files)
}

/** Create a .xlsx from a list of `{ name, rows }`. */
export function createXlsx({ sheets } = {}) {
  return buildXlsx(normalizeSheets(sheets))
}

function decodeCell(xml) {
  const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(xml)?.[1] ?? null
  const inline = /<is>[\s\S]*?<t\b[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/.exec(xml)?.[1]
  const type = /<c\b[^>]*\st="([^"]+)"/.exec(xml)?.[1] ?? null
  const valueText = /<v>([\s\S]*?)<\/v>/.exec(xml)?.[1]

  let value = null
  if (inline !== undefined) value = xmlUnescape(inline)
  else if (valueText !== undefined) {
    if (type === 'b') value = valueText === '1'
    else if (type === 's') value = `#shared:${valueText}`
    else {
      const number = Number(valueText)
      value = Number.isFinite(number) ? number : xmlUnescape(valueText)
    }
  }
  return { value, formula: formula === null ? null : `=${xmlUnescape(formula)}` }
}

/** Read every sheet, in workbook order, as rows of `{ value, formula }`. */
export function readXlsx(buffer) {
  const files = zipRead(buffer)
  const workbook = files.get('xl/workbook.xml')
  if (!workbook) throw new Error('不是有效的 Excel 文件（缺少 xl/workbook.xml）')

  const shared = []
  const sharedPart = files.get('xl/sharedStrings.xml')
  if (sharedPart) {
    for (const match of sharedPart.toString('utf8').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      shared.push([...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => xmlUnescape(part[1])).join(''))
    }
  }

  const sheets = []
  const sheetEntries = [...workbook.toString('utf8').matchAll(/<sheet\b[^>]*\sname="([^"]*)"[^>]*\/>/g)]
  sheetEntries.forEach((match, index) => {
    const name = xmlUnescape(match[1])
    const part = files.get(`xl/worksheets/sheet${index + 1}.xml`)
    if (!part) {
      sheets.push({ name, rows: [] })
      return
    }
    const rows = []
    for (const rowMatch of part.toString('utf8').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = []
      for (const cellMatch of rowMatch[1].matchAll(/<c\b[^>]*>[\s\S]*?<\/c>|<c\b[^>]*\/>/g)) {
        const address = /\sr="([A-Z]+)\d+"/.exec(cellMatch[0])?.[1]
        const cell = decodeCell(cellMatch[0])
        if (cell.value && typeof cell.value === 'string' && cell.value.startsWith('#shared:')) {
          cell.value = shared[Number(cell.value.slice(8))] ?? ''
        }
        const column = address ? columnIndex(address) : row.length
        while (row.length < column) row.push({ value: null, formula: null })
        row[column] = cell
      }
      rows.push(row)
    }
    sheets.push({ name, rows })
  })

  return { ok: true, sheets }
}

/**
 * Map workbook sheet names onto their part paths, following the workbook's OWN relationship ids.
 *
 * WHY NOT `sheetN.xml` BY POSITION: that is what a generator happens to name them, not what the format
 * guarantees. A file edited by Excel can rename or reorder parts, so the relationship is the only
 * reliable link between a name the user typed and the XML to edit.
 */
function sheetParts(files) {
  const workbook = files.get('xl/workbook.xml')?.toString('utf8') ?? ''
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? ''
  const targets = new Map()
  for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = match[0]
    const id = /\bId="([^"]+)"/.exec(tag)?.[1]
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1]
    if (id && target) targets.set(id, target.replace(/^\//, '').replace(/^xl\//, ''))
  }
  const sheets = []
  for (const match of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const tag = match[0]
    const name = /\bname="([^"]*)"/.exec(tag)?.[1]
    const rid = /\br:id="([^"]+)"/.exec(tag)?.[1]
    if (name === undefined || rid === undefined) continue
    const target = targets.get(rid)
    if (!target) continue
    sheets.push({ name: xmlUnescape(name), path: `xl/${target}` })
  }
  return sheets
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Set one cell in a worksheet's XML, keeping the row's other cells and attributes untouched. */
function setCellInSheet(xml, rowNumber, column, cellXmlText) {
  const rowPattern = new RegExp(`<row\\b[^>]*\\br="${rowNumber}"[^>]*>[\\s\\S]*?</row>|<row\\b[^>]*\\br="${rowNumber}"[^>]*/>`)
  const rowMatch = rowPattern.exec(xml)
  const address = `${columnName(column)}${rowNumber}`

  if (!rowMatch) {
    const insertion = `<row r="${rowNumber}">${cellXmlText}</row>`
    const closed = xml.indexOf('</sheetData>')
    const selfClosed = /<sheetData\s*\/>/.exec(xml)
    if (selfClosed) return xml.replace(selfClosed[0], `<sheetData>${insertion}</sheetData>`)
    if (closed < 0) throw new Error('工作表结构异常（没有 sheetData）')
    // Rows must stay in ascending order; inserting before the first larger `r` keeps Excel happy.
    const rows = [...xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)]
    const next = rows.find((entry) => Number(entry[1]) > rowNumber)
    const at = next ? xml.indexOf(next[0]) : closed
    return `${xml.slice(0, at)}${insertion}${xml.slice(at)}`
  }

  const rowText = rowMatch[0]
  const cells = [...rowText.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"[^>]*\/>|<c\b[^>]*\br="([A-Z]+)\d+"[^>]*>[\s\S]*?<\/c>/g)]
  const existing = cells.find((entry) => (entry[1] ?? entry[2]) === columnName(column))
  if (existing) return xml.replace(existing[0], cellXmlText)
  // No cell at this column yet: insert before the first cell with a larger column.
  const later = cells.find((entry) => columnIndex(entry[1] ?? entry[2]) > column)
  const at = later ? rowText.indexOf(later[0]) : rowText.lastIndexOf('</row>')
  const nextRow = `${rowText.slice(0, at)}${cellXmlText}${rowText.slice(at)}`
  return xml.replace(rowText, nextRow)
}

/**
 * Update an .xlsx IN PLACE: replace whole sheets by name and/or write individual A1 cells.
 *
 * WHY IN PLACE RATHER THAN REBUILDING: the earlier version rebuilt the package from the values it
 * understood, which silently dropped charts, styles, conditional formatting and comments — a data-loss
 * bug a user only notices after saving over a real workbook. This version edits only the `<sheetData>`
 * of the sheets it touches and copies every other part byte-for-byte, so unknown parts survive because
 * they are never parsed.
 */
export function updateXlsx(buffer, { sheets, cells } = {}) {
  const files = zipRead(buffer)
  if (!files.has('xl/workbook.xml')) throw new Error('不是有效的 Excel 文件（缺少 xl/workbook.xml）')
  const index = sheetParts(files)

  const findPart = (name) => {
    const entry = index.find((sheet) => sheet.name === name)
    if (!entry || !files.has(entry.path)) return null
    return { ...entry, xml: files.get(entry.path).toString('utf8') }
  }

  for (const replacement of Array.isArray(sheets) ? sheets : []) {
    const name = sheetNameSafe(replacement?.name, index.length)
    const rows = Array.isArray(replacement?.rows) ? replacement.rows : []
    const found = findPart(name)
    if (!found) throw new Error(`没有这个工作表：${name}（本版只替换已有工作表，不支持新建）`)
    const body = rows.length === 0 ? '' : `<sheetData>${rows.map((row, rowIndex) => {
      const cellsXml = (Array.isArray(row) ? row : []).map((cell, column) => cellXml(cell, rowIndex, column)).join('')
      return `<row r="${rowIndex + 1}">${cellsXml}</row>`
    }).join('')}</sheetData>`
    let xml = found.xml
    xml = /<sheetData\s*\/>/.test(xml) ? xml.replace(/<sheetData\s*\/>/, body || '<sheetData/>') : xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, body || '<sheetData/>')
    // A stale `dimension` claims a range the sheet no longer has; Excel rewrites it on save.
    xml = xml.replace(/<dimension\b[^>]*\/>/, '')
    files.set(found.path, Buffer.from(xml, 'utf8'))
  }

  const bySheet = new Map()
  for (const edit of Array.isArray(cells) ? cells : []) {
    const name = sheetNameSafe(edit?.sheet, 0)
    const address = String(edit?.address ?? '').trim().toUpperCase()
    const match = /^([A-Z]+)(\d+)$/.exec(address)
    if (!match) throw new Error(`单元格地址非法：${address}`)
    if (!bySheet.has(name)) bySheet.set(name, [])
    bySheet.get(name).push({ column: columnIndex(match[1]), row: Number(match[2]), edit })
  }

  for (const [name, edits] of bySheet) {
    const found = findPart(name)
    if (!found) throw new Error(`没有这个工作表：${name}`)
    let xml = found.xml
    for (const { column, row, edit } of edits) {
      const value = {
        value: edit?.value ?? null,
        ...(typeof edit?.formula === 'string' && edit.formula !== '' ? { formula: edit.formula } : {}),
      }
      xml = setCellInSheet(xml, row, column, cellXml(value, row - 1, column))
    }
    files.set(found.path, Buffer.from(xml, 'utf8'))
  }

  // Re-emit every part in its original order; untouched parts keep their exact bytes.
  return zipWrite([...files.entries()].map(([name, data]) => ({ name, data })))
}

// ---------------------------------------------------------------------------------------------
// PowerPoint
// ---------------------------------------------------------------------------------------------

/**
 * A minimal but complete PresentationML package.
 *
 * WHY THE MASTER / LAYOUT / THEME PARTS ARE NOT OPTIONAL: a .pptx without them is not "a simpler deck",
 * it is a broken package — PowerPoint refuses to open it and reports a repair. Every slide must
 * reference a layout, the layout a master, and the master a theme, so those three parts exist even
 * though this module only ever writes the blank layout.
 */
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'

const PPTX_CONTENT_TYPES_HEAD = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`

const EMPTY_TREE = `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>`

const SLIDE_MASTER = `${XML_HEAD}<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_REL}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${EMPTY_TREE}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`

const SLIDE_MASTER_RELS = `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${NS_REL}/theme" Target="../theme/theme1.xml"/></Relationships>`

const SLIDE_LAYOUT = `${XML_HEAD}<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_REL}" xmlns:p="${NS_P}" type="blank" preserve="1"><p:cSld name="空白">${EMPTY_TREE}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`

const SLIDE_LAYOUT_RELS = `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`

/** A standard Office theme. PowerPoint reads fonts/colours from here; a missing theme fails the open. */
const THEME = `${XML_HEAD}<a:theme xmlns:a="${NS_A}" name="ChinaClaude"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`

const SLIDE_WIDTH_EMU = 12192000
const SLIDE_HEIGHT_EMU = 6858000

/** One text box. `id` must be unique inside the slide, or PowerPoint drops the shape. */
function textBoxXml(id, { x, y, cx, cy, text = '', bullets = [], size = 2400, bold = false }) {
  const runs = []
  if (text !== '') {
    runs.push(`<a:p><a:r><a:rPr lang="zh-CN" sz="${size}"${bold ? ' b="1"' : ''}/><a:t>${xmlEscape(text)}</a:t></a:r></a:p>`)
  }
  for (const bullet of bullets) {
    runs.push(
      `<a:p><a:pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="1800"/><a:t>${xmlEscape(bullet)}</a:t></a:r></a:p>`,
    )
  }
  const paragraphs = runs.length > 0 ? runs.join('') : '<a:p/>'
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="TextBox ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
}

function slideXml({ title, bullets = [] }) {
  const shapes = []
  let id = 2
  if (title) {
    shapes.push(textBoxXml(id++, { x: 609600, y: 457200, cx: SLIDE_WIDTH_EMU - 1219200, cy: 1371600, text: title, size: 3200, bold: true }))
  }
  if (bullets.length > 0) {
    shapes.push(textBoxXml(id++, { x: 609600, y: 1981200, cx: SLIDE_WIDTH_EMU - 1219200, cy: SLIDE_HEIGHT_EMU - 2286000, bullets }))
  }
  return `${XML_HEAD}<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_REL}" xmlns:p="${NS_P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}

function presentationXml(count) {
  const ids = Array.from({ length: count }, (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('')
  return `${XML_HEAD}<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_REL}" xmlns:p="${NS_P}" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${ids}</p:sldIdLst><p:sldSz cx="${SLIDE_WIDTH_EMU}" cy="${SLIDE_HEIGHT_EMU}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
}

function presentationRels(count) {
  const slides = Array.from({ length: count }, (_, index) => `<Relationship Id="rId${index + 2}" Type="${NS_REL}/slide" Target="slides/slide${index + 1}.xml"/>`).join('')
  return `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slides}</Relationships>`
}

function pptxContentTypes(count) {
  const slides = Array.from({ length: count }, (_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')
  return `${PPTX_CONTENT_TYPES_HEAD}${slides}</Types>`
}

/** Create a 16:9 .pptx: one slide per `{ title, bullets }`. */
export function createPptx({ slides } = {}) {
  const list = (Array.isArray(slides) ? slides : []).map((slide) => ({
    title: String(slide?.title ?? ''),
    bullets: (Array.isArray(slide?.bullets) ? slide.bullets : []).map((entry) => String(entry ?? '')),
  }))
  if (list.length === 0) throw new Error('至少需要一页幻灯片')

  const files = [
    { name: '[Content_Types].xml', data: pptxContentTypes(list.length) },
    { name: '_rels/.rels', data: `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>` },
    { name: 'ppt/presentation.xml', data: presentationXml(list.length) },
    { name: 'ppt/_rels/presentation.xml.rels', data: presentationRels(list.length) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: SLIDE_MASTER },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: SLIDE_MASTER_RELS },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: SLIDE_LAYOUT },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: SLIDE_LAYOUT_RELS },
    { name: 'ppt/theme/theme1.xml', data: THEME },
    ...list.map((slide, index) => ({ name: `ppt/slides/slide${index + 1}.xml`, data: slideXml(slide) })),
    ...list.map((_, index) => ({
      name: `ppt/slides/_rels/slide${index + 1}.xml.rels`,
      data: `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
    })),
  ]
  return zipWrite(files)
}

/** Read a .pptx as `[{ title, bullets }]`: the first text box is the title, the rest are bullets. */
export function readPptx(buffer) {
  const files = zipRead(buffer)
  const presentation = files.get('ppt/presentation.xml')
  if (!presentation) throw new Error('不是有效的 PowerPoint 文件（缺少 ppt/presentation.xml）')

  const slides = []
  for (let index = 1; ; index++) {
    const part = files.get(`ppt/slides/slide${index}.xml`)
    if (!part) break
    const xml = part.toString('utf8')
    const boxes = []
    for (const shape of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
      const paragraphs = [...shape[0].matchAll(/<a:p>[\s\S]*?<\/a:p>/g)].map((paragraph) =>
        [...paragraph[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((run) => xmlUnescape(run[1])).join(''),
      )
      const texts = paragraphs.filter((text) => text !== '')
      if (texts.length > 0) boxes.push(texts)
    }
    slides.push({ title: boxes[0]?.[0] ?? '', bullets: boxes.slice(1).flat() })
  }
  return { ok: true, slides }
}

/**
 * Append slides to an existing .pptx, leaving every other part untouched.
 *
 * WHY NOT REBUILD THE DECK: the same reason as `updateXlsx` — rebuilding would drop themes, masters,
 * images and notes the module never modelled. Here only three parts change (presentation.xml, its rels,
 * the content types) and new slide parts are added; everything else is copied byte-for-byte.
 */
export function updatePptx(buffer, { slides } = {}) {
  const files = zipRead(buffer)
  if (!files.has('ppt/presentation.xml')) throw new Error('不是有效的 PowerPoint 文件（缺少 ppt/presentation.xml）')
  const additions = (Array.isArray(slides) ? slides : []).map((slide) => ({
    title: String(slide?.title ?? ''),
    bullets: (Array.isArray(slide?.bullets) ? slide.bullets : []).map((entry) => String(entry ?? '')),
  }))
  if (additions.length === 0) throw new Error('至少要新增一页')

  const existing = [...files.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length
  let presentation = files.get('ppt/presentation.xml').toString('utf8')
  let rels = files.get('ppt/_rels/presentation.xml.rels').toString('utf8')
  let contentTypes = files.get('[Content_Types].xml').toString('utf8')

  // The highest numeric relationship id in use; the presentation also has rId1 for the master.
  const used = [...rels.matchAll(/\bId="rId(\d+)"/g)].map((match) => Number(match[1]))
  let nextRel = Math.max(0, ...used) + 1

  additions.forEach((slide, offset) => {
    const index = existing + offset + 1
    const id = 256 + existing + offset
    const rel = nextRel++
    files.set(`ppt/slides/slide${index}.xml`, Buffer.from(slideXml(slide), 'utf8'))
    files.set(
      `ppt/slides/_rels/slide${index}.xml.rels`,
      Buffer.from(
        `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
        'utf8',
      ),
    )
    presentation = presentation.replace('</p:sldIdLst>', `<p:sldId id="${id}" r:id="rId${rel}"/></p:sldIdLst>`)
    rels = rels.replace(
      '</Relationships>',
      `<Relationship Id="rId${rel}" Type="${NS_REL}/slide" Target="slides/slide${index}.xml"/></Relationships>`,
    )
    contentTypes = contentTypes.replace(
      '</Types>',
      `<Override PartName="/ppt/slides/slide${index}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
    )
  })

  files.set('ppt/presentation.xml', Buffer.from(presentation, 'utf8'))
  files.set('ppt/_rels/presentation.xml.rels', Buffer.from(rels, 'utf8'))
  files.set('[Content_Types].xml', Buffer.from(contentTypes, 'utf8'))
  return zipWrite([...files.entries()].map(([name, data]) => ({ name, data })))
}
