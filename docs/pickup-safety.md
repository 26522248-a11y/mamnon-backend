# An toàn đón trẻ – đợt 1 (API contract)

All paths are under `/api/v1`. Errors use `{code, message, details?}`. Times are ISO-8601 UTC; the UI shows them in VN time.

## 1. Who may take the child

| Who | How | Approval |
|---|---|---|
| Parent / guardian listed on the child (`canPickup=true`) | `POST /attendance/:id/pickup {guardianId}` | direct |
| Authorized picker registered by a parent, **approved by admin** | `POST /attendance/:id/pickup {authorizedPickerId}` | direct |
| Anyone else (incl. a picker still `pending` or `rejected`) | pickup request → `POST /attendance/:id/pickup {pickupRequestId}` | **parent step AND school step** |

After every hand-over the child's parents get (inbox + push): `Bé đã được <X> (<relation>) đón lúc HH:MM`.

## 2. Authorized pickers (`người đón hộ`)

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/children/:id/pickup-people` | admin, class teacher, parent of child | `{childId, guardians[{id, fullName, relation, phone, idNumberMasked, canPickup, isParentAccount, onList}], authorizedPickers[view]}` |
| GET | `/children/:id/authorized-pickers` | same | `view[]` |
| POST | `/children/:id/authorized-pickers` (multipart) | parent of the child (admin) | `fullName*, relation*, idNumber*` (12 digits), `phone1*`, `phone2?`, `photo*` (JPG/PNG/HEIC by real content; HEIC/HEIF stored as JPEG). 201 `view` with `status:'pending'`. No photo → 400 `PHOTO_REQUIRED`; same CCCD already on this child → 409 `DUPLICATE_PICKER`; other parent/teacher → 403. Admins are notified (`picker_registration`). |
| PATCH | `/authorized-pickers/:id` (multipart or JSON) | parent of the child (admin) | any of the above fields; `phone2:""` clears it. Changing name / CCCD / photo sends a parent-edited picker back to `pending`. |
| DELETE | `/authorized-pickers/:id` | parent of the child (admin) | 204, soft delete (history kept) |
| GET | `/authorized-pickers?status&childId` | admin: all (approval queue); teacher: own classes; parent: own children | `view[]` |
| POST | `/authorized-pickers/:id/approve` `{note?}` | admin | 409 `ALREADY_DECIDED` if not pending. Parents notified (`picker_decision`). |
| POST | `/authorized-pickers/:id/reject` `{note*}` | admin | no note → 400 `NOTE_REQUIRED` |
| GET | `/authorized-pickers/:id/photo` | admin, class teacher, parent of child | 401 / 403 otherwise |
| GET | `/authorized-pickers/:id/history` | admin, class teacher, parent of child | `{id, deleted, items[{action: create|update|delete|approve|reject, changes (CCCD masked), changedBy, changedByName, changedByRole, changedAt}]}` |

`view` = `{id, childId, childName, fullName, relation, phone1, phone2, idNumberMasked ("********6789"), photoUrl, status: pending|approved|rejected, onList, decidedBy, decidedByName, decidedAt, decisionNote, createdBy, createdByName, createdAt, updatedAt}`. The full CCCD never appears in these responses.

### Contact phones for the 15-minute calls
| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/children/:id/contact-phones` | admin, class teacher, parent of child | `{childId, phone1, phone2, updatedBy, updatedByName, updatedAt, callOrder[escalation phone]}` |
| PATCH | `/children/:id/contact-phones` `{phone1*, phone2?}` | parent of the child (admin) | other child / teacher → 403. `phone2: ""` clears it; same as phone1 → 400. Effective immediately in `escalation.phones`; history kept; admins notified (`contact_change`). |
| GET | `/children/:id/contact-phones/history` | admin, class teacher, parent of child | `{childId, items[{before{phone1, phone2}, after{…}, changedBy, changedByName, changedByRole, changedAt}]}` |

Call order: contact phones set by the parent first; free slots (max 2) are filled from guardian phones.

## 3. Hand-over screen

| Method | Path | Who | Response |
|---|---|---|---|
| GET | `/attendance/:id/pickup-options` | admin, class teacher | `{attendanceId, date, status, child{id, fullName, className, photoUrl}, pickedUp: pickup\|null, guardians[{kind:'guardian', id, fullName, relation, phone, idNumberMasked, hasAccount, canPickup, canHandOver, blockers}], authorizedPickers[{kind:'authorized_picker', …, photoUrl, status, canHandOver, blockers: [] \| ['NOT_APPROVED_YET'] \| ['REJECTED']}], requests[{kind:'pickup_request', …requestView, escalation, warnings, canHandOver, blockers (+'YOU_APPROVED')}]}` |
| GET | `/attendance/:id/pickup-identity?kind=guardian\|authorized_picker\|pickup_request&id=` | admin, class teacher (not parents, not other classes) | `{kind, id, attendanceId, childId, fullName, relation, idNumber (FULL), photoUrl, phones[], audited:true}`. Each call is written to `sensitive_access_logs` (user, role, entity, child, attendance, ip, time). |
| POST | `/attendance/:id/pickup` `{guardianId \| authorizedPickerId \| pickupRequestId, pickedUpAt?, note?}` | admin, class teacher | 201 `{…pickup, pickerKind: guardian\|authorized_picker\|request, authorizedPickerId, recordedBy, handedOverBy, handedOverByName, warnings[], notified[]}` |

Hand-over errors: exactly one person id → else 400 `PICKUP_PERSON_REQUIRED`; already handed over → **409 `ALREADY_PICKED_UP`**; guardian `canPickup=false` → 403 `PICKUP_NOT_ALLOWED`; picker pending/rejected → 403 `PICKER_NOT_APPROVED`; request rejected (either step) → 403 `PICKUP_REQUEST_REJECTED`; expired (even if both steps approved) → 403 `PICKUP_REQUEST_EXPIRED`; a step missing → 403 `PICKUP_REQUEST_PENDING` with `details: ['PARENT_PENDING'?, 'SCHOOL_PENDING'?]`; the school approver hands over → 403 `APPROVER_CANNOT_HAND_OVER`.

`warnings[]`: `{code:'SAME_PICKER_MULTIPLE_CHILDREN', message, children[{childId, childName, relation, how: picked_up|request, status, at}]}` when the same phone or CCCD picked up / asked for another child that day. Never blocks.

## 4. Off-list pickup requests (two steps)

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/attendance/:id/pickup-requests` (JSON or multipart) | admin, class teacher | `pickerName*, pickerPhone*, note*, relation?, pickerIdNumber?` (12 digits), `photo?`. Today only. Push (with Confirm / Reject buttons) goes **only to this child's parents**; it is not added to the general inbox. Response: staff view + `delivery[{channel, sent, failed, skipped}]`. |
| GET | `/pickup-requests/feed?date&childId` | parent | `{date, pendingCount, items[requestView + needsMyAction]}`; items needing my answer first; includes `photoUrl`. For the "Bé hôm nay" banner (works without push). |
| GET | `/pickup-requests?status&childId&date` | admin; teacher: own classes (+ today's for the duty account); parent: own children | staff view adds `escalation`, `warnings` |
| GET | `/pickup-requests/:id` | same | |
| GET | `/pickup-requests/:id/photo` | admin, class teacher, parent of child, today's duty account | |
| POST | `/pickup-requests/:id/confirm` `{note?}` | parent of the child → **parent step**; admin or today's duty account → **school step** | teacher (incl. homeroom) without duty / accountant → 403 `NOT_ON_DUTY`; duty account on another day's request → 403 `NOT_ON_DUTY` |
| POST | `/pickup-requests/:id/reject` `{note}` | same | school reject needs `note` → else 400 `NOTE_REQUIRED`; parent reject note optional |
| POST | `/pickup-requests/:id/parent-decision` `{decision: approve\|reject, note*}` | admin | records the PARENT step on the parent's behalf after a phone call (`parent.channel = 'on_behalf'`, `decidedOnBehalf = true`) |
| POST | `/pickup-requests/:id/call-attempts` `{phone, outcome: no_answer\|busy\|wrong_number\|confirmed\|rejected\|other, guardianId?, note?}` | admin, class teacher, today's duty account | 201 staff view. Only a log: never changes the request. |

Decisions: already decided step / request → 409 `ALREADY_DECIDED`; expired → 409 `REQUEST_EXPIRED` (atomic, a second click cannot change it). A rejection on either step makes the request `rejected`. When both steps are `approved`, `status = 'approved'`. The teacher who created the request is notified of each step.

`requestView`: `{id, attendanceId, childId, childName, classId, className, pickerName, pickerPhone, pickerIdNumberMasked, relation, note, photoUrl, status: pending|approved|rejected|expired, expiresAt, requestedBy, createdAt, dueAt (createdAt + PICKUP_ESCALATE_MINUTES), parent{status, decidedBy, decidedByName, decidedAt, note, channel: app|push|on_behalf}, school{status, decidedBy, decidedByName, decidedAt, note, role: admin|duty}, blockers[EXPIRED|REJECTED|PARENT_PENDING|SCHOOL_PENDING], readyForHandover, decidedBy, decidedByName, decidedOnBehalf, decidedAt, decisionNote}` (the last five are legacy "last decision" fields).

### 15-minute rule (`escalation`, staff views)
`{afterMinutes: 15, dueAt, due, promptCall, phones[{order: 1|2, guardianId|null, name|null, relation|null, phone, tel: "tel:09…", source: contact|guardian}], nextPhone, callAttempts[{id, phone, guardianId, outcome, note, calledBy, calledByName, at}]}`.
`due`/`promptCall` become true when the parent step is still pending, the request is not expired and `now ≥ createdAt + PICKUP_ESCALATE_MINUTES` (default 15). Phones: the parent's contact phones first (see below), then guardians with a parent account, the first 2 different numbers. `nextPhone` = the first number not yet called. Nothing is ever handed over or approved automatically; after expiry (2 h / end of day) the request is `expired`.

## 5. Duty roster (`trực đón`)

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/pickup-duties` `{userId, dates[YYYY-MM-DD], note?}` | admin (others 403) | staff only (parent / inactive → 400 `INVALID_DUTY_USER`); duplicates ignored; returns the rows |
| GET | `/pickup-duties?from&to&userId` | admin: all; teacher/accountant: own | default today … +30 days. `[{id, date, userId, userName, userRole, assignedBy, note, createdAt}]` |
| GET | `/pickup-duties/me` | staff | `{today, onDutyToday, canApproveToday, upcoming[]}` |
| DELETE | `/pickup-duties/:id` | admin | 204 |

The duty account gives the school step only for requests of its duty date, and only on that date. If it is also the person handing over, the hand-over is refused (`APPROVER_CANNOT_HAND_OVER`); someone else must hand over.

## 6. Web push

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/push/vapid-public-key` | public | `{publicKey, enabled, channels[{channel, enabled}]}` |
| POST | `/push/subscriptions` `{endpoint, keys{p256dh, auth}}` | any logged-in user | `PushSubscription.toJSON()`; same endpoint → moved to the current user |
| GET | `/push/subscriptions` | own | |
| DELETE | `/push/subscriptions` `{endpoint}` | own | 204 |
| POST | `/push/test` | any | sends a test push to myself |
| POST | `/push/actions` `{token, action: confirm\|reject, requestId?, note?}` | **public** (token from payload) | records the PARENT step with `channel:'push'`. Forged / other request → 403 `INVALID_ACTION_TOKEN`; expired → 409 `REQUEST_EXPIRED`; already answered → 409 `ALREADY_DECIDED`; user no longer a parent of the child → 403. |
| GET | `/push/pickup-photo/:requestId?t=<token>` | public, token-checked | picker photo for the notification |

Payload (JSON) sent to the service worker:
```json
{ "title": "Xác nhận người đón bé Nguyễn Gia An", "body": "Chú Tư (Chú), SĐT 0909123456 xin đón bé lúc 16:40. Hết hạn 18:40.",
  "tag": "pickup-<id>", "requireInteraction": true, "icon": "/icon-192.png", "badge": "/icon-192.png",
  "actions": [{ "action": "confirm", "title": "Xác nhận" }, { "action": "reject", "title": "Từ chối" }],
  "data": { "type": "pickup_request", "url": "/today", "pickupRequestId": "…", "childId": "…", "expiresAt": "…",
            "actionToken": "<jwt, ≤2h, bound to this request + this parent>", "actionUrl": "https://…/api/v1/push/actions",
            "photoUrl": "https://…/api/v1/push/pickup-photo/<id>?t=…" } }
```
Other types: `picked_up` (`data.pickupId, pickedUpByName, pickedUpAt`), `pickup_decision`, `picker_registration`, `picker_decision`.

Service worker example (frontend):
```js
self.addEventListener('push', (e) => {
  const p = e.data.json();
  e.waitUntil(self.registration.showNotification(p.title, {
    body: p.body, tag: p.tag, icon: p.icon, badge: p.badge, image: p.data.photoUrl || undefined,
    requireInteraction: p.requireInteraction, actions: p.actions, data: p.data,
  }));
});
self.addEventListener('notificationclick', (e) => {
  const d = e.notification.data || {};
  e.notification.close();
  if (d.type === 'pickup_request' && (e.action === 'confirm' || e.action === 'reject')) {
    e.waitUntil(fetch(d.actionUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: d.actionToken, action: e.action, requestId: d.pickupRequestId }) })
      .then((r) => r.json()).then((res) => self.registration.showNotification(
        e.action === 'confirm' ? 'Đã xác nhận' : 'Đã từ chối', { body: res.message || '', tag: 'pickup-result-' + d.pickupRequestId }))
      .catch(() => clients.openWindow(d.url)));
    return;
  }
  e.waitUntil(clients.openWindow(d.url || '/'));
});
```
Subscribe after login: `reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: <publicKey as Uint8Array> })` then `POST /push/subscriptions` with `sub.toJSON()`. On iPhone push only works for the installed PWA (iOS 16.4+); the feed + 15-minute call prompt cover the rest.

## 7. Channel layer
`NOTIFY_CHANNELS` (default `inapp,webpush`): `inapp` (inbox), `webpush` (needs VAPID keys), `sms`, `zalo` (stubs: every attempt is logged as `skipped` in `notification_deliveries`). Every push attempt is logged (`sent|failed|skipped`); 404/410 removes the subscription; failures never break the request flow.

## 8. Inbox
`GET /notifications` and unread counts no longer include `pickup_request` items (they live in `/pickup-requests/feed` + push).
