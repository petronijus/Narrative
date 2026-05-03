---
milestone: M16 P7
date: 2026-05-02
branch: feat/m16-p6-master-expansion
status: ready for review / continuation elsewhere
---

# Master editor: "Back to presentation" floating button + component thumbnail uploader

Two parallel changes landed on `feat/m16-p6-master-expansion` in one commit because they touch the same file (`apps/web/src/pages/ComponentMasterEditor.tsx`) and were both mid-flight.

## 1. Floating "Back to presentation" button

Problem: when a user clicked **Edit master** (Inspector or right-click menu) we navigated to `/folder/:folderId/component/:componentId` but the only way out was the toolbar Home icon — which jumps to the folder decks list and loses the originating deck context.

Solution: capture origin path at navigate-time via `location.state.from`, render a fixed bottom-center pill button in the master editor that returns the user there.

### Touchpoints

- `apps/web/src/ui/Inspector.tsx` (~L954, L1018) — `useLocation()` added; navigate now passes `state: { from: pathname + search }`.
- `apps/web/src/ui/EditorContextMenu.tsx` (~L130, L450) — same `from` plumbing in `handleEditMaster`.
- `apps/web/src/pages/ComponentMasterEditor.tsx` — reads `location.state.from`, renders button (`data-testid="master-editor-back"`) inside the provider stack so it visually overlays the editor surface. Fallback chain: `from` → `/folder/${folderId}` → `navigate(-1)`.

### Known limitations / follow-ups

- No history is stored if user opens master URL directly (refresh / shared link). Fallback handles it but lands on the folder, not the source deck.
- Button is bottom-center, fixed `z-50`. Verify it doesn't collide with future bottom-docked panels (animation timeline panel from M14, transform overlays). If conflict, move to top-right next to Toolbar.
- No e2e spec yet. Suggested coverage:
  - From inspector → edit master → click back → assert URL = source deck.
  - Direct visit to master URL → click back → assert URL = `/folder/:id`.
- Czech localization not applied (label is hardcoded English). Match whatever locale strategy the toolbar uses when adding.

## 2. Component thumbnail uploader (parallel feature, completes M16 thumb story)

`ComponentThumbnailUploader` is mounted inside the provider stack of `ComponentMasterEditor.tsx`. It hooks into `useSlideThumbnails(['master'])`, debounces (1.5s trailing edge), and PUTs the synthetic `master` slide thumbnail to a new endpoint.

### Touchpoints

- `apps/server/src/routes/components.ts` — new `PUT /components/:id/thumbnail` route (owner-only). Accepts `{ dataUrl }`, validates `data:image/(jpeg|png);base64,...`, caps payload at 1 MB decoded, writes to MinIO at stable key `components/<id>/thumb.<ext>`.
- `apps/web/src/api/client.ts` — `uploadComponentThumbnail(componentId, dataUrl)` helper.
- `apps/web/src/pages/ComponentMasterEditor.tsx` — `<ComponentThumbnailUploader>` component (mounts a thumbnail-generating effect, dedupes by exact dataUrl, drops marker on PUT failure so future renders retry).

### Known limitations / follow-ups

- No equivalent of imgproxy URL signing on the read side yet — wherever the folder grid will surface component thumbs, wire `signImgproxyUrl` like decks do.
- No DB column tracking `thumbnailKey` on `components` table — current implementation relies on the deterministic key. If the folder grid wants signed URLs without HEAD-probing, add `thumbnailUpdatedAt` and bust caches.
- Server route does not GZIP / re-encode; the client sends whatever Pixi produced. Consider downscaling before PUT if payloads grow.
- No tests yet for either the route or the React uploader.

## Verification done locally

- `pnpm --filter @narrative/web typecheck` — clean
- `pnpm --filter @narrative/server typecheck` — clean
- Not run yet: vitest, playwright e2e, lint. Run before merging.

## Continuation checklist

- [ ] Add e2e for the back-button round-trip (folder→edit master→back).
- [ ] Add unit test for `parseDataUrl` mime/size edges.
- [ ] Surface component thumbnails in the folder grid (read path).
- [ ] Decide whether the thumbnail key should be tracked in DB to enable cache busting.
- [ ] Consider extracting `from`-state plumbing into a tiny `navigateWithFrom(navigate, location, target)` helper if more "deep link with breadcrumb" entries appear (object detail, comment threads).
