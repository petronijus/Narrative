# M11 Phase 2 — tus Resumable Upload Pipeline + imgproxy Signed URL Generation

**Date**: 2026-04-20
**Agent**: media
**Branch**: main
**Status**: Complete — 163/163 tests pass (48 new), 0 typecheck errors

---

## What was done

### New files

- `apps/server/src/media/imgproxyUrl.ts` — `signImgproxyUrl(args)` function.
  Signs imgproxy URLs using HMAC-SHA256 (imgproxy docs algorithm).
  Supports variants `thumb`, `display`, `original` with preset processing directives.
  Output format: `{baseUrl}/{signature}/{processing}/plain/s3://{bucket}/{storageKey}@{extension}`
  Both IMGPROXY_KEY and IMGPROXY_SALT are hex-decoded to Buffer before HMAC computation.
  Signature is URL-safe base64 without padding (Node.js `digest('base64url')`).

- `apps/server/src/media/tus.ts` — `registerTusPlugin(app, { db })` Fastify plugin.
  Mounts `@tus/server` at `/api/uploads` with `@tus/s3-store` pointing to MinIO.
  Fastify forwards all `/api/uploads` and `/api/uploads/*` requests to `tusServer.handle(req.raw, reply.raw)`.
  Three lifecycle hooks:
  - `onUploadCreate(req, res, upload)`: validates JWT auth (editor/owner role required), rejects non-image MIME (415).
  - `onIncomingRequest(req, res, uploadId)`: re-validates auth on PATCH and DELETE.
  - `onUploadFinish(req, res, upload)`: reads S3 head for authoritative size, probes image dims via `probe-image-size` (first 64 KB range read), inserts `media_assets` row, returns `{ assetId, storageKey, mimeType, sizeBytes, width?, height? }` as JSON body.
    Upload ID encoding: `"{assetId}:{deckId}:{storageKey-base64url}"` — lets `onUploadFinish` reconstruct storageKey without a DB lookup.
    Size limit: `MAX_UPLOAD_SIZE` env, default 25 MB.

- `apps/server/src/media/routes.ts` — `registerMediaRoutes(app, { db })`:
  - `GET /api/media/:assetId/url?variant=<thumb|display|original>` — returns `{ url }` with signed imgproxy URL. Auth: JWT required, viewer role sufficient. Cache-Control: max-age=600.
  - `DELETE /api/media/:assetId` — owner only. Removes DB row; MinIO object is NOT deleted (M29 GC).

- Test files:
  - `apps/server/src/media/imgproxyUrl.test.ts` — 15 tests: determinism, variant differentiation, processing segment contents, URL-safe base64, hex decode, invalid hex rejection.
  - `apps/server/src/media/routes.test.ts` — 11 tests: authorized GET returns URL, 404 for unknown asset, 403 for no access, 400 for invalid variant, Cache-Control header, DELETE role gating.
  - `apps/server/src/media/tus.test.ts` — 14 tests: Fastify passthrough routing, onUploadCreate (401/400/415/403/editor-ok/owner-ok), onIncomingRequest PATCH auth, onUploadFinish createMediaAsset call + response shape + malformed id.

### Modified files

- `apps/server/src/media/index.ts` — Barrel updated to export `imgproxyUrl.ts`, `routes.ts`, `tus.ts`.

- `apps/server/src/index.ts` — Added `registerTusPlugin` and `registerMediaRoutes` calls after `registerSharingRoutes`. CORS `methods` updated to include `PATCH` and `HEAD` (required by tus protocol).

- `apps/server/package.json` — Added four new production dependencies.

---

## Key decisions

### Why `@tus/server` over `tus-node-server`

`@tus/server` is the actively maintained package (tus-node-server is the old name). The npm package `@tus/server` is at v2.x at time of implementation. The `@tus/s3-store` package supports MinIO with `forcePathStyle: true` — no workaround needed. The `.handle(req.raw, reply.raw)` bridge works cleanly with Fastify; no sibling HTTP server was needed.

### Why the compound upload ID encoding

tus uses the upload ID as the primary S3 key prefix. By encoding `assetId:deckId:base64url(storageKey)` into the tus upload ID, the `onUploadFinish` hook gets all the context it needs from the upload object alone — no extra DB lookup or in-memory state. The `namingFunction` hook is the right place to generate this.

### Why `probe-image-size` over `sharp`

`probe-image-size` is pure JS, ~50 KB, no native binaries. It only reads the minimum bytes needed to identify image dimensions (typically first few hundred bytes for JPEG/PNG/WebP) via a range read from S3. `sharp` requires a native binary and is a heavier dependency. For the use case (getting width/height on upload finalize), `probe-image-size` is sufficient and avoids cross-compilation issues in Docker.

### Why `probe-image-size` is imported via `createRequire`

It is a CommonJS module with no ESM export. The server package uses `"type": "module"` (ESM). `createRequire(import.meta.url)` gives a CJS-compatible require function. The dependency is wrapped in a typed interface to avoid leaking `any` into the codebase.

### imgproxy URL signing algorithm

The path that gets signed is: `"/" + processing + "/plain/" + sourceUrl + "@" + extension`
For the `original` variant (no processing), the path is: `"/plain/" + sourceUrl + "@" + extension`
The HMAC input is: `Buffer.concat([saltBuffer, Buffer.from(path, 'utf8')])`
The signature is: `createHmac('sha256', keyBuffer).update(data).digest('base64url')`
This matches the imgproxy documentation exactly. URL-safe base64 without padding is what imgproxy expects.

---

## Security notes

- **Auth**: JWT required on all upload paths (create, resume PATCH, terminate DELETE). `onUploadCreate` validates deck role (editor or owner). Share-token viewer paths do NOT grant upload rights.
- **MIME validation**: `content-type` in `Upload-Metadata` is checked during `onUploadCreate` (quick reject). `probe-image-size` on finalize is an additional structural check. SVGs and exotic formats that probe-image-size cannot parse still get inserted without dims (non-fatal).
- **Size limit**: enforced by `@tus/server` `maxSize` option (default 25 MB). MinIO also has a max object size cap.
- **SSRF / path traversal**: `storageKey` is constructed server-side from server-generated `assetId` and the `deckId` that was validated against the user's deck permissions. Neither component comes directly from user-controlled file content.
- **imgproxy SSRF**: the source URL passed to imgproxy is `s3://{bucket}/{storageKey}` — server-controlled. imgproxy fetches from MinIO, not from arbitrary URLs.
- **Rate limiting**: not implemented in M11. Tracked as M29.
- **Virus scan**: not implemented. Tracked as M29.

---

## How to verify end-to-end

### Prerequisites

- MinIO running on `MINIO_ENDPOINT` with `MEDIA_BUCKET` created.
- imgproxy running on `IMGPROXY_ENDPOINT` with `IMGPROXY_USE_S3=true`, `IMGPROXY_S3_ENDPOINT`, `IMGPROXY_KEY`, `IMGPROXY_SALT`.
- Server running with `BYPASS_AUTH=true` for local testing.

### 1. Create an upload

```bash
curl -i -X POST http://localhost:3001/api/uploads \
  -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Length: 12345" \
  -H "Upload-Metadata: filename $(echo -n 'photo.jpg' | base64),deckId $(echo -n 'YOUR_DECK_ID' | base64),content-type $(echo -n 'image/jpeg' | base64)" \
  -H "Content-Type: application/offset+octet-stream"
```

Response: `201 Created` with `Location: http://localhost:3001/api/uploads/{uploadId}`

### 2. Upload a chunk (PATCH)

```bash
curl -i -X PATCH http://localhost:3001/api/uploads/{uploadId} \
  -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Offset: 0" \
  -H "Content-Type: application/offset+octet-stream" \
  --data-binary @photo.jpg
```

On finalize: `200 OK` with `{ assetId, storageKey, mimeType, sizeBytes, width, height }`.

### 3. Get a signed imgproxy URL

```bash
curl http://localhost:3001/api/media/{assetId}/url?variant=display
```

Response: `{ "url": "http://localhost:8080/SIGNATURE/rs:fit:1600:1600:0/plain/s3://narrative-media/decks/.../original.jpg@webp" }`

### 4. Verify the signed URL works

```bash
curl -L "$(curl -s http://localhost:3001/api/media/{assetId}/url | jq -r .url)" -o result.webp
```

### 5. tus-js-client (browser integration test)

```js
import * as tus from 'tus-js-client'

const upload = new tus.Upload(file, {
  endpoint: 'http://localhost:3001/api/uploads',
  headers: { Authorization: `Bearer ${jwt}` },
  metadata: {
    filename: file.name,
    deckId: 'YOUR_DECK_ID',
    'content-type': file.type,
  },
  onSuccess: () => console.log('done', upload.url),
})
upload.start()
```

---

## Consumer expectations for phase 3

### editor-ui

- Use `tus-js-client` to POST to `/api/uploads`, passing JWT in `headers.Authorization`.
- Send `Upload-Metadata`: `deckId`, `filename`, `content-type` (and optionally `width`, `height` if known from FileReader).
- On success (upload finalize returns `{ assetId, width, height }`), call `createObjectOfType(ctx, 'image', { assetId, width, height, x, y })` via the mutations API.
- For `<img src>`, fetch `GET /api/media/{assetId}/url?variant=display` with JWT, use returned URL.
- Optimistic UI: insert a placeholder object at drop time, update with real `assetId` on finalize.

### renderer

- On `ImageObject` mount, call `GET /api/media/{assetId}/url?variant=display` (debounced + cached in ResourceManager).
- Load the returned signed URL into a Pixi Texture via `PIXI.Assets.load(url)`.
- For thumbnails in the slide list panel: use `?variant=thumb` (400×225).
- HLS video: not yet available (M12 BullMQ workers).

---

## Known TODOs

| ID  | Description                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| M29 | MinIO orphan GC — when `media_assets` row is deleted (or deck cascade), the S3 object remains. Add a post-delete hook or BullMQ cleanup job. |
| M29 | Per-user upload rate limiting — protect against abuse.                                                                                       |
| M12 | Video upload support — accept `video/*` MIME, enqueue BullMQ ffmpeg job for HLS transcoding + poster frame.                                  |
| M29 | Virus scan on finalize — integrate ClamAV or similar.                                                                                        |
| M12 | 302 redirect endpoint `GET /api/media/:assetId` → imgproxy URL — convenient for `<img src>` in shared/public contexts.                       |
