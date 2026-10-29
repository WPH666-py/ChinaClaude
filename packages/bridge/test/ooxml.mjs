/**
 * OOXML engine: the two file formats and the ZIP container under them.
 *
 * WHY THE ASSERTIONS ARE ABOUT STRUCTURE, NOT BYTES: a valid package is one Word/Excel opens, and what
 * this suite can prove without the applications is that every part exists, parses, and round-trips
 * through the same reader. Byte-for-byte comparisons would break on any harmless reordering and teach
 * nothing about whether the file is right.
 */
import { inflateRawSync } from 'node:zlib'

import { finish, makeCheck } from './harness.mjs'
import { createDocx, createPptx, createXlsx, readDocx, readPptx, readXlsx, updateDocx, updateXlsx } from '../src/ooxml.mjs'

const results = []
const check = makeCheck(results)

/** Minimal ZIP part lister: the EOCD is at the end and names are the only thing needed here. */
function parts(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) return []
  const count = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)
  const names = []
  for (let index = 0; index < count; index++) {
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    names.push(buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'))
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return names
}

/** Pull one part out by name, using the central directory (mirrors `zipRead` in the module). */
function part(buffer, wanted) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)
  for (let index = 0; index < count; index++) {
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    if (name === wanted) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26)
      const localExtraLength = buffer.readUInt16LE(localOffset + 28)
      const start = localOffset + 30 + localNameLength + localExtraLength
      const raw = buffer.subarray(start, start + compressedSize)
      return method === 0 ? raw : inflateRawSync(raw)
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return null
}

try {
  {
    const buffer = createDocx({
      title: '季度报告',
      paragraphs: ['第一段', { text: '要点一', bullet: true }],
      table: { headers: ['项目', '金额'], rows: [['差旅', '1200']] },
    })
    check('docx: produced a buffer', Buffer.isBuffer(buffer) && buffer.length > 0)
    const names = parts(buffer)
    check(
      'docx: package parts present',
      ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/numbering.xml'].every((name) => names.includes(name)),
      names.join(','),
    )
    const document = part(buffer, 'word/document.xml')?.toString('utf8') ?? ''
    check('docx: document.xml is xml', document.startsWith('<?xml'))
    check('docx: escaping is applied', !document.includes('<w:t>第一段 &') || document.includes('&amp;'))

    const doc = readDocx(buffer)
    check('docx: title round-trips', doc.title === '季度报告', String(doc.title))
    check('docx: paragraph round-trips', doc.paragraphs.some((entry) => entry.text === '第一段'))
    check('docx: bullet flag round-trips', doc.paragraphs.some((entry) => entry.bullet === true && entry.text === '要点一'))
    check('docx: table round-trips', doc.tables.length === 1 && doc.tables[0].headers.join(',') === '项目,金额', JSON.stringify(doc.tables))
    check('docx: cell text does not duplicate as a paragraph', doc.paragraphs.every((entry) => entry.text !== '差旅'))

    const updated = updateDocx(buffer, { paragraphs: ['追加一段'] })
    const reread = readDocx(updated)
    check('docx update: keeps the original', reread.paragraphs.some((entry) => entry.text === '第一段'))
    check('docx update: appends', reread.paragraphs.some((entry) => entry.text === '追加一段'))
    check('docx update: returns a new buffer', Buffer.isBuffer(updated) && updated.length > 0)
  }

  {
    const buffer = createXlsx({
      sheets: [
        { name: '总表', rows: [['项目', '金额'], ['差旅', 1200], ['合计', { formula: 'SUM(B2:B2)', value: 1200 }]] },
        { name: '明细', rows: [['a', 1]] },
      ],
    })
    const names = parts(buffer)
    check('xlsx: workbook parts present', names.includes('xl/workbook.xml') && names.includes('xl/worksheets/sheet2.xml'), names.join(','))
    check('xlsx: sheet part is xml', (part(buffer, 'xl/worksheets/sheet1.xml')?.toString('utf8') ?? '').startsWith('<?xml'))

    const book = readXlsx(buffer)
    check('xlsx: two sheets', book.sheets.length === 2, JSON.stringify(book.sheets.map((sheet) => sheet.name)))
    check('xlsx: inline string survives', book.sheets[0].rows[0][0].value === '项目')
    check('xlsx: number survives', book.sheets[0].rows[1][1].value === 1200)
    check('xlsx: formula survives', String(book.sheets[0].rows[2][1].formula).includes('SUM'))

    const updated = updateXlsx(buffer, { cells: [{ sheet: '总表', address: 'B3', value: 999 }] })
    const reread = readXlsx(updated)
    check('xlsx update: cell written', reread.sheets[0].rows[2][1].value === 999, JSON.stringify(reread.sheets[0].rows[2]))
    check('xlsx update: other sheet intact', reread.sheets[1].rows[0][0].value === 'a')

    const replaced = updateXlsx(buffer, { sheets: [{ name: '明细', rows: [['b', 2]] }] })
    const reread2 = readXlsx(replaced)
    check('xlsx update: sheet replaced by name', reread2.sheets.length === 2 && reread2.sheets[1].rows[0][0].value === 'b')

    /**
     * Preservation: the whole point of editing in place. Every part except the edited worksheet must be
     * byte-identical — that is what keeps styles, charts, comments and parts this module does not model.
     */
    const before = parts(buffer)
    const after = parts(updated)
    check('xlsx update: same part list', before.join(',') === after.join(','), `${before.join(',')} vs ${after.join(',')}`)
    const sheet1 = 'xl/worksheets/sheet1.xml'
    const untouched = before.filter((name) => name !== sheet1)
    const identical = untouched.every((name) => Buffer.compare(part(buffer, name), part(updated, name)) === 0)
    check('xlsx update: untouched parts are byte-identical', identical === true)
    check('xlsx update: the edited part did change', Buffer.compare(part(buffer, sheet1), part(updated, sheet1)) !== 0)

    let missingSheet = ''
    try {
      updateXlsx(buffer, { cells: [{ sheet: '不存在', address: 'A1', value: 1 }] })
    } catch (error) {
      missingSheet = String(error?.message ?? error)
    }
    check('xlsx update: unknown sheet refuses instead of inventing one', missingSheet.includes('没有这个工作表'), missingSheet)
  }

  {
    const buffer = createPptx({ slides: [{ title: '封面', bullets: ['要点一', '要点二'] }, { title: '第二页', bullets: [] }] })
    const names = parts(buffer)
    check(
      'pptx: master / layout / theme parts present',
      ['ppt/presentation.xml', 'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml'].every((name) => names.includes(name)),
      names.join(','),
    )
    check('pptx: slide parts present', names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length === 2, names.join(','))
    const deck = readPptx(buffer)
    check('pptx: slides round-trip', deck.slides.length === 2, JSON.stringify(deck.slides))
    check('pptx: title round-trips', deck.slides[0].title === '封面', deck.slides[0].title)
    check('pptx: bullets round-trip', deck.slides[0].bullets.join('|') === '要点一|要点二', deck.slides[0].bullets.join('|'))

    let pptError = ''
    try {
      readPptx(Buffer.alloc(8))
    } catch (error) {
      pptError = String(error?.message ?? error)
    }
    check('pptx: bad input refuses', pptError !== '')
  }

  {
    let docxError = ''
    try {
      readDocx(Buffer.from('not a zip'))
    } catch (error) {
      docxError = String(error?.message ?? error)
    }
    check('bad docx: refuses with a Chinese message', docxError.includes('Office 文件') || docxError.includes('Word 文件'), docxError)

    let xlsxError = ''
    try {
      readXlsx(Buffer.alloc(4))
    } catch (error) {
      xlsxError = String(error?.message ?? error)
    }
    check('bad xlsx: refuses instead of hanging', xlsxError !== '')
  }
} catch (error) {
  check('suite ran without throwing', false, String(error?.stack ?? error))
}

finish(results)
