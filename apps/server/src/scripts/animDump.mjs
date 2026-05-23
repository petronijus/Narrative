import * as Y from 'yjs'
import pg from 'pg'
const client = new pg.Client(process.env.POSTGRES_URL)
await client.connect()
const { rows } = await client.query('SELECT update FROM deck_updates WHERE deck_id = $1', [
  'fJa8gBp7g-6t',
])
const doc = new Y.Doc()
for (const r of rows) Y.applyUpdate(doc, new Uint8Array(r.update))
const slides = doc.getArray('slides')
const slide = slides.get(6)
const anims = slide.get('animations')
console.log('animations:', JSON.stringify(anims.toJSON(), null, 2))
await client.end()
