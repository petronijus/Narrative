import * as Y from 'yjs'
import pg from 'pg'

const client = new pg.Client(process.env.POSTGRES_URL)
await client.connect()
const deckId = process.argv[2] || 'hThPXKaPm4Oz'
const { rows } = await client.query('SELECT update FROM deck_updates WHERE deck_id = $1', [deckId])
const doc = new Y.Doc()
for (const r of rows) Y.applyUpdate(doc, new Uint8Array(r.update))
const slides = doc.getArray('slides')
console.log(`deck ${deckId} → ${slides.length} slides, ${rows.length} updates`)
const slideIdx = Number(process.argv[3] ?? 4)
const slide = slides.get(slideIdx)
const objects = slide.get('objects')
console.log(`slide ${slideIdx + 1}: ${objects.length} objects`)
for (let i = 0; i < objects.length; i++) {
  const obj = objects.get(i).toJSON()
  const extra = obj.posterAssetId ? ` posterAssetId=${obj.posterAssetId}` : ''
  const font = obj.fontFamily ? ` font="${obj.fontFamily}"` : ''
  console.log(
    `  [${i}] type=${obj.type} assetId=${obj.assetId ?? '-'}${extra} fill=${obj.fill !== undefined ? '0x' + obj.fill.toString(16) : '-'} fillStyle=${obj.fillStyle?.kind ?? '-'}${font} x=${obj.x} y=${obj.y} w=${obj.width} h=${obj.height}`,
  )
}
await client.end()
