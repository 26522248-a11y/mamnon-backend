# Round 3 API – QR payments, class photo album

Base `/api/v1`, JWT, errors `{code, message, details?}`, lists `{items}` (same conventions as round2-api.md).
Sources: `mamnon-design/mockups7.html` (screens 1–4 + reconciliation table), `qa/testcases-dot3.md` (QR-01…09, ALB-01…06).
Status: **§1 QR payments implemented** (migration `Round3Qr`, tests `test/round3-qr.e2e-spec.ts`); §2 photo album: contract only.

---

## 1. QR payments (VietQR)

### 1.1 Configuration
| env | example | note |
|---|---|---|
| `BANK_BIN` | `970436` | NAPAS BIN of the school's bank (6 digits) |
| `BANK_ACCOUNT_NO` | `0071000123456` | |
| `BANK_ACCOUNT_NAME` | `TRUONG MAM NON NHU Y` | upper-case, no diacritics (as the bank shows it) |

Configured = all three set and non-empty. If **not** configured:
- sample account used outside production: BIN `970436`, account `0000000000`, name `DU LIEU MAU - KHONG CHUYEN TIEN`.
- `NODE_ENV !== 'production'` → endpoints return a **sample** QR (fixed sample account) with `sample: true`; UI shows the label "Dữ liệu mẫu · chưa có tài khoản thật" (QR-04).
- `NODE_ENV === 'production'` → `409 BANK_ACCOUNT_NOT_CONFIGURED`, `details: {schoolPhone}` (= `/settings/school` `phone`) so the card can say "Vui lòng liên hệ nhà trường: 028 …". **Never** a sample QR in production.

`GET /settings/school` gains `bankTransfer: {enabled: boolean, sample: boolean}` (enabled = configured, or non-production sample) so the invoice screen knows whether to show the QR block; `phone` is already there.

### 1.2 GET /invoices/:id/qr — admin, accountant, parent (own child only)
```json
{
  "invoiceId": "…", "invoiceNo": "HD202611-00042",
  "amount": 3050000,                       // = totalAmount - paidAmount (still owed)
  "transferContent": "HD202611-00042",     // = invoice code, unique per invoice
  "bank": { "bin": "970436", "accountNo": "0071000123456", "accountName": "TRUONG MAM NON NHU Y" },
  "payload": "000201010212…6304ABCD",      // EMVCo VietQR string; frontend renders it as a QR image
  "sample": false,
  "pendingClaim": null                     // or the open transfer claim (see 1.3) – UI shows the yellow card instead
}
```
- Payload: EMVCo MPM, dynamic (`010212`), merchant account info tag 38 = GUID `A000000727` + (BIN, account) + service `QRIBFTTA`; currency `704`, amount (tag 54, integer VND), country `VN`, additional data tag 62 sub-tag 08 = `transferContent`; CRC16-CCITT (tag 63).
- Errors: `403` parent of another child (QR-02) · `404` · `409 INVOICE_VOID` · `409 ALREADY_PAID` · `409 ZERO_INVOICE` (QR-03) · `409 BANK_ACCOUNT_NOT_CONFIGURED` (production only).
- Banks may strip `-` from the content; the reconciliation screen matches content case-insensitively ignoring non-alphanumerics (`HD20261100042` ≙ `HD202611-00042`).

### 1.3 Transfer claims ("Tôi đã chuyển")
Table `transfer_claims`: `id, invoice_id, child_id, amount, transferred_at, note, status ('pending_confirmation'|'confirmed'|'rejected'), claimed_by, claimed_at, decided_by, decided_at, reject_reason, payment_id`. Partial unique index `(invoice_id) WHERE status = 'pending_confirmation'`.

**POST /invoices/:id/transfer-claims** — parent (own child only); admin/accountant may file on behalf (`onBehalf: true` stored).
Body `{amount?: int (default = still owed), transferredAt?: ISO (default now, not in future), note?: ≤500}`.
- Creates a claim with `status: 'pending_confirmation'`. **The invoice is never marked paid** by this call (QR-05): `invoice.status` stays `unpaid|partial`, it stays in `/debts`, `paidAmount` unchanged. Invoice views (`GET /invoices`, `/invoices/:id`) add `paymentStatus: 'pending_confirmation' | null` and `transferClaim` (latest claim) for the yellow card ("Đang chờ nhà trường xác nhận – bạn đã chuyển 3.050.000đ lúc 20:14").
- Idempotent (QR-06): if a pending claim already exists → `200` with that claim (no second row, no second notification); new claim → `201`.
- Response `{created: boolean, claim}` (claim = view below). `400 TRANSFERRED_AT_IN_FUTURE` (5 min tolerance).
- Errors: same as 1.2 (`403/404/409 INVOICE_VOID/ALREADY_PAID/ZERO_INVOICE`); 403 is checked before 409.
- Claim view: `{id, invoiceId, childId, amount, transferredAt, note, status, onBehalf, claimedAt, claimedBy:{id,name}, decidedAt, decidedBy:{id,name}|null, rejectReason, paymentId, receiptNo}`.
- Notifies admins + accountants (`type: 'transfer_claim'`). Audit `transfer_claim.create` (after = claim).

**GET /transfer-claims?status=pending_confirmation|confirmed|rejected&classId=&period=** — admin, accountant (reconciliation table, "5 giao dịch chờ").
Item: claim view + `{childName, className, invoiceNo, invoiceStatus, amountDue (current, 0 if void), difference (= amount - amountDue)}`; pending first, oldest first. UI shows "⚠ lệch 100.000" when `difference ≠ 0`.

**POST /transfer-claims/:id/confirm** — admin, accountant only (teacher/parent → 403, QR-08).
Body `{amount?: int (actually received, default = claim amount), receivedAt?: ISO, note?}`.
- Creates a normal payment exactly like `POST /invoices/:id/payments` with `method: 'transfer'`, `payerName` = claimant, note `Chuyển khoản – xác nhận yêu cầu <claimId>`, i.e. a receipt (phiếu thu, `receiptNo`).
- Shortfall → invoice `partial`, remaining debt correct; excess → child credit (`overpayment` credit transaction) (QR-09). Button "Ghi thu một phần" = confirm with the smaller amount.
- Claim → `confirmed`, `paymentId`, `decidedBy/At`. Response `{claim, receipt}` (receipt = same shape as `GET /payments/:id/receipt`).
- Parent notified (`type: 'payment'`, "Đã nhận tiền … Biên lai PT…") (green card).
- Errors: `409 CLAIM_ALREADY_DECIDED`; `409 ALREADY_PAID` if the invoice was settled meanwhile (reject the claim or record a prepayment instead); `409 INVOICE_VOID`.
- Audit `transfer_claim.confirm`, before = pending claim, after = confirmed claim + paymentId/receiptNo/amount.

**POST /transfer-claims/:id/reject** — admin, accountant only. Body `{reason: string, required, non-blank, ≤500}` (400 `VALIDATION_ERROR` otherwise).
- Response `{claim}`. Claim → `rejected`, `rejectReason`; invoice untouched. Parent notified with the reason (`type: 'transfer_claim_rejected'`, important). Parent can file a new claim afterwards.
- `409 CLAIM_ALREADY_DECIDED`. Audit `transfer_claim.reject` with `reason`, before/after.

Side rules: voiding an invoice with a pending claim auto-rejects the claim (`rejectReason: 'Hoá đơn đã huỷ'`, parent notified, audited). A manual cash payment does not touch an open claim.

New NotificationType values: `transfer_claim`, `transfer_claim_rejected`.

---

## 2. Class photo album

### 2.1 Rules (PM decided)
- Consent = `children.photo_consent` (round 2, parent-set, default **not** consenting).
- Posting or tagging a photo with **any** tagged child lacking consent → `422 PHOTO_CONSENT_MISSING`, `details: {children: [{childId, name}]}`; nothing is saved. Same check when adding tags later (ALB-01, ALB-02). Checked server-side regardless of UI.
- **No automatic face blur** (the "1 bé bị che" element in the mockup is out of scope).
- When a parent turns consent **off**: in the same transaction every photo tagging that child is auto-**hidden** (not deleted): `hidden: true, hiddenReason: 'CONSENT_WITHDRAWN', hiddenForChildIds: [...]` (column `hidden_for_child_ids uuid[]`; the child is appended if the photo is already hidden), `hiddenAt`. Parents no longer see them; teachers of the class see them greyed with the reason; class teachers get a notification (`type: 'photo_hidden'`). Audit `photo.auto_hide` per photo (reason, childId). The PUT photo-consent response adds `hiddenPhotos: n` (ALB-03).
- Re-enabling consent does **not** unhide.
- `hiddenForChildIds` is **sticky**: removing child X's tag from a photo hidden because of X does **not** remove X from `hiddenForChildIds` and does not unhide (untagging is still allowed and audited).
- A teacher (or admin) can unhide only if **every child in `hiddenForChildIds` has consent again AND every currently tagged child consents**; otherwise `422 PHOTO_CONSENT_MISSING` listing the children lacking consent from both sets. On unhide, `hiddenForChildIds` is cleared.
- Photo files are served **only** through the authenticated endpoint (no static URLs). Viewers: admin; teachers of the class; parents **of a child in that class** (others → 403, no token → 401) (ALB-04). Hidden/deleted photos → 404 for parents.
- Teachers post only to their own classes (403 otherwise, ALB-06); admin any class.

### 2.2 Upload
- `multipart/form-data`: `files[]` (1–20, each ≤ 15 MB), JPEG/PNG/WebP/HEIC detected by **magic bytes** (extension/Content-Type ignored); anything else (exe, txt renamed .jpg) → `400 UNSUPPORTED_IMAGE` with the file name (ALB-05). HEIC/PNG/WebP are converted to JPEG; EXIF (incl. GPS) stripped; auto-rotated; stored as `full` (max 2048 px) + `thumb` (400 px) under `UPLOAD_DIR/photos/<classId>/`.
- Too large → `413 FILE_TOO_LARGE`.

### 2.3 Endpoints
- **POST /classes/:classId/photo-posts** — teacher (own class), admin. Fields: `files[]`, `caption` (≤300), `tags` = JSON array aligned with files, each an array of childIds (e.g. `[["id1","id2"],[],["id1"]]`). Every tagged child must be active, in that class (`400 CHILD_NOT_IN_CLASS`) and consenting (`422 PHOTO_CONSENT_MISSING`). → `201` post view. Notifies parents of the class (`type: 'photo_post'`, not important). Audit `photo_post.create` (photo ids, tags).
- **GET /classes/:classId/photo-posts?before=<ISO>&limit=20** — class viewers. `{items: [{id, classId, caption, createdAt, author:{id,name}, likeCount, likedByMe, photos: [{id, width, height, childIds, mine (tags my child – parent), hidden, hiddenReason, hiddenForChildIds}]}], nextBefore}`. Parents get only non-hidden photos and only `childIds` of their own children (other kids' tags not revealed; `mine` flag drives "có bé An"). Teachers/admin see hidden photos with `hiddenReason` and `hiddenForChildIds` (+ names).
- **GET /photos/:id/file?size=thumb|full&download=1** — streams the JPEG (`Cache-Control: private`). `download=1` (Content-Disposition attachment) for parents only if the photo tags their own child, else 403 ("Chỉ tải được ảnh có con mình").
- **PUT /photos/:id/tags** `{childIds}` — teacher (own class), admin. Added children are checked as in POST (`422 PHOTO_CONSENT_MISSING`). Removing a tag (even of a child in `hiddenForChildIds`) is allowed but never unhides and never shrinks `hiddenForChildIds`. Audit `photo.tags` before/after (tags + hidden state).
- **POST /photos/:id/unhide** — teacher (own class), admin. Requires consent for every child in `hiddenForChildIds` (tagged or not any more) and for every current tag; else `422 PHOTO_CONSENT_MISSING` `details.children: [{childId, name}]`. Audit `photo.unhide` (before has `hiddenForChildIds`).
- **DELETE /photos/:id**, **DELETE /photo-posts/:id** — author teacher or admin; soft delete (file kept 30 days), audit.
- **POST / DELETE /photo-posts/:id/like** — parents and teachers who can view; idempotent.

Album footer text (frontend): "Ảnh chỉ dành cho phụ huynh trong lớp. Vui lòng không chia sẻ ảnh có bé khác lên mạng xã hội."

New NotificationType values: `photo_post`, `photo_hidden`.

---

## 3. Test mapping
| QA | Covered by |
|---|---|
| QR-01/02/03/04 | 1.2 (amount = owed, content = invoiceNo, 403 other child, 409 paid/void/zero, sample label / 409 in production) |
| QR-05/06 | 1.3 create (never paid; idempotent 200) |
| QR-07/08/09 | confirm / reject (receipt, reason to parent, audit; 403 teacher/parent; partial / credit) |
| ALB-01/02/03 | 2.1 consent rules (422 on post and on adding tags; auto-hide on withdrawal) |
| ALB-04 | 2.1 authenticated file endpoint (403 / 401) |
| ALB-05 | 2.2 magic-byte check, HEIC → JPEG |
| ALB-06 | 2.1 / 2.3 own class only |

## 2.4 A1 / A2 additions (implemented 10/10)
- **POST /classes/:classId/photo-posts** also accepts `hiddenForChildIds` = JSON array aligned with files (`[["childId"],[]]`) – the "🙈 Ẩn bé đi" choice. A tagged child **without** consent is accepted only if listed there for that photo; the photo is then saved `hidden: true, hiddenReason: 'CONSENT_MISSING'` (parents never see it; teachers see it greyed; unhide rules as above). Otherwise that photo is `rejected` (`code: PHOTO_CONSENT_MISSING`, `children`), other photos in the request are still saved (`results[]` per photo, matched by `clientId`/`index`); if nothing could be saved → `422 PHOTO_CONSENT_MISSING` with message "Chưa đăng được: phụ huynh của … chưa cho đăng hình. Bỏ ảnh có bé hoặc ẩn bé rồi đăng lại." and `details: {children, results}`.
- Files > 15 MB → `413 PAYLOAD_TOO_LARGE`. Retry with a saved `clientId` → `duplicate: true` (no new photo).
- **GET /classes/:classId/photo-consent-summary** (teacher of class, admin) → `{items: [{childId, fullName, photoConsent, asked}], notAllowed: [...]}` – the "🚫 n bé chưa cho đăng hình" list.
- **GET/PUT /children/:id/photo-consent** now return `asked` (parent answered at least once → don't ask again on app open). The first answer is recorded even if it equals the default (`false`), audit `before.consent = null` → history "Chưa hỏi → Có/Không". PUT response adds `hiddenPhotos` (photos auto-hidden because consent was turned off).
- Sensitive-change history texts for photo consent: label "Đồng ý đăng hình", values "Có" / "Không" / "Chưa hỏi".
