# Triển khai: Web trên Vercel · API trên Render · CSDL trên Neon

```
Điện thoại / máy tính ──https──▶ Vercel (mamnon-web, Next.js)
                                   │  /api/v1/*  (proxy, cùng tên miền → cookie đăng nhập hoạt động cả trên iPhone)
                                   ▼
                                 Render (mamnon-api, NestJS) ──TLS──▶ Neon (Postgres 17)
                                   └─ ổ đĩa /var/data (ảnh, hoá đơn, nhật ký thao tác)
```

Bạn cần 3 tài khoản (đăng nhập bằng GitHub là nhanh nhất): **neon.tech**, **render.com**, **vercel.com**. Render phải có thẻ thanh toán: gói **Starter** cần để gắn ổ đĩa lưu ảnh và hoá đơn.

> **Lưu ý về ổ đĩa:** máy chủ Render (kể cả gói Free) **xoá sạch file** mỗi lần deploy hoặc khởi động lại. Ảnh đón bé, ảnh lớp và hoá đơn chỉ còn nếu gắn **Persistent Disk** (đã khai báo trong `render.yaml`, mount `/var/data`, chỉ có trên gói trả phí). Gói Free còn "ngủ" sau 15 phút không dùng, lần mở đầu chờ khoảng 50 giây.

---

## Bước 1 – Neon (Postgres)

1. Vào https://console.neon.tech → **New Project**.
   - Name: `mamnon`.
   - Postgres version: **17**.
   - Region: **AWS Asia Pacific (Singapore)**.
   - Bấm **Create project**.
2. Ở trang **Dashboard** bấm **Connect**.
   - Database: `neondb`.
   - **Tắt** công tắc **Connection pooling**: dùng kết nối trực tiếp, host **không** có `-pooler`.
   - Bấm **Copy snippet** để chép chuỗi dạng `postgresql://neondb_owner:...@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require`.
   - Đây là `DATABASE_URL`. Giữ nguyên `?sslmode=require`: API tự bật TLS khi thấy tham số này.
3. Không cần tạo bảng: API tự chạy migration khi khởi động (`MIGRATIONS_RUN=true`).
4. Sao lưu: Neon có **Restore** theo thời điểm (gói Free: 1 ngày, gói Launch: 7 ngày). Ngoài ra nên `pg_dump` hằng tuần (xem cuối trang).

## Bước 2 – Render (API)

1. Vào https://dashboard.render.com → **New +** → **Blueprint**.
2. **Connect a repository**: chọn `mamnon-backend` (cho phép Render truy cập repo nếu được hỏi). Render đọc file `render.yaml`.
3. Blueprint Name: `mamnon`. Render liệt kê service **mamnon-api** và hỏi các biến có `sync: false`. Điền:

| Biến | Giá trị |
|---|---|
| `DATABASE_URL` | chuỗi Neon ở Bước 1 |
| `CORS_ORIGIN` | tên miền web, vd `https://mamnon-web.vercel.app` (nhiều tên cách nhau dấu phẩy; preview: thêm `https://mamnon-*-<team>.vercel.app`). Chưa biết thì tạm điền `https://mamnon-web.vercel.app`, sửa sau Bước 3 |
| `PUBLIC_API_BASE` | cũng là tên miền web, vd `https://mamnon-web.vercel.app` |
| `SCHOOL_NAME` | `Trường Mầm Non Như Ý` |
| `SCHOOL_ADDRESS` | `Tổ 6 Ấp 12A, Xã Trảng Bom, TP Đồng Nai` |
| `SCHOOL_PHONE` | `0367842613` |
| `INITIAL_ADMIN_USERNAME` | tên đăng nhập BGH, vd `hieutruong` |
| `INITIAL_ADMIN_PASSWORD` | mật khẩu **tạm, mạnh**: ≥ 10 ký tự, có chữ và số, không chứa tên đăng nhập, không phải 123456. Ví dụ tạo bằng `openssl rand -base64 12` |
| `INITIAL_ADMIN_NAME` | vd `Cô Hiệu trưởng` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | để trống nếu chưa dùng thông báo đẩy. Muốn dùng: chạy `npx web-push generate-vapid-keys` và điền 2 khoá; SUBJECT = `mailto:email-cua-truong` |

   `JWT_ACCESS_SECRET` và `JWT_REFRESH_SECRET` do Render tự sinh (`generateValue`). Các biến khác đã có sẵn giá trị.
4. Bấm **Apply**. Render chạy `npm ci --include=dev && npm run build`, rồi `sh scripts/start.sh`:
   - chạy migration;
   - tạo tài khoản BGH đầu tiên **một lần** (đã có admin thì bỏ qua). Mật khẩu yếu sẽ bị từ chối và deploy báo lỗi;
   - khởi động API. Render kiểm tra `GET /api/v1/health`.
5. Khi service hiện **Live**, chép URL dạng `https://mamnon-api.onrender.com`. Mở `https://mamnon-api.onrender.com/api/v1/health` phải thấy `{"status":"ok"}`.
6. **Bắt buộc:** vào **mamnon-api → Environment**, **xoá** `INITIAL_ADMIN_PASSWORD` → **Save Changes** (Render deploy lại; tài khoản vẫn còn).
7. Kiểm tra ổ đĩa: **mamnon-api → Disks** có `mamnon-data` mount `/var/data`.

> Không có dữ liệu mẫu trên production: lệnh seed (tạo tài khoản 123456) **từ chối chạy** khi `NODE_ENV=production`.
> Cách khác để tạo admin (gói có Shell): **mamnon-api → Shell** → `INITIAL_ADMIN_USERNAME=hieutruong INITIAL_ADMIN_PASSWORD='...' npm run bootstrap:admin:prod`.
> Máy dev: `npm run bootstrap:admin -- --username hieutruong --password '...'`.

## Bước 3 – Vercel (Web)

1. Vào https://vercel.com/new → **Import Git Repository** → chọn `mamnon-web` → **Import**.
2. Framework Preset: **Next.js** (tự nhận). Root Directory: `./`. Build/Output: để mặc định.
3. Mở **Environment Variables**, thêm (áp cho Production + Preview):

| Biến | Giá trị |
|---|---|
| `API_INTERNAL_URL` | `https://mamnon-api.onrender.com` (URL Render ở Bước 2, **không** có `/` cuối) |

   **Không** đặt `NEXT_PUBLIC_API_URL`. Khi chỉ có `API_INTERNAL_URL`, web gọi `/api/v1/...` trên chính tên miền Vercel và Vercel chuyển tiếp sang Render (cấu hình trong `next.config.mjs`, không cần `vercel.json`). Nhờ vậy cookie đăng nhập là cookie cùng trang, **iPhone Safari không chặn**.
4. Bấm **Deploy**. Xong, Vercel cho tên miền dạng `https://mamnon-web.vercel.app`. Có thể đổi tên ở **Settings → Domains**, hoặc gắn tên miền riêng.
5. Nếu tên miền khác với giá trị đã điền ở Bước 2: vào Render → **mamnon-api → Environment**, sửa `CORS_ORIGIN` và `PUBLIC_API_BASE` cho đúng → **Save Changes**.
6. Đổi `API_INTERNAL_URL` sau này phải **Redeploy** web (giá trị được ghi vào lúc build).

### Cách 2 – web gọi thẳng API (không qua proxy Vercel)
Chỉ dùng khi cần, ví dụ upload file lớn (ảnh, hoá đơn) bị lỗi khi đi qua proxy Vercel.
- Vercel: `NEXT_PUBLIC_API_URL=https://mamnon-api.onrender.com`, `API_INTERNAL_URL` cùng giá trị.
- Render: `COOKIE_SAMESITE=none`, `TRUST_PROXY=1`, `CORS_ORIGIN` = tên miền web.
- Nhược điểm: cookie là cookie bên thứ ba. Safari/iPhone (và Chrome khi tắt cookie bên thứ ba) chặn, người dùng bị đăng xuất khi tải lại trang.

## Bước 4 – Đăng nhập lần đầu
1. Mở tên miền web → đăng nhập bằng `INITIAL_ADMIN_USERNAME` và mật khẩu tạm → hệ thống **bắt đổi mật khẩu**.
2. Vào **Người dùng** tạo tài khoản giáo viên, kế toán. Vào **Lớp / Nhập Excel** để nhập học sinh và phụ huynh (mẫu: `deploy/templates/mau-nhap-hoc-sinh.xlsx`).
3. Kiểm tra trang đăng nhập và phiếu thu hiện đúng tên, địa chỉ, SĐT trường.

## Sao lưu (pg_dump)
Neon đã có khôi phục theo thời điểm. Nên thêm bản dump hằng tuần lưu ngoài, ví dụ trên một máy Linux bất kỳ (cần `postgresql-client-17`):
```bash
# crontab -e  → 02:30 Chủ nhật mỗi tuần, giữ 8 bản gần nhất
30 2 * * 0  pg_dump "postgresql://...neon.tech/neondb?sslmode=require" -Fc -f $HOME/mamnon-backup/mamnon_$(date +\%F).dump && ls -1t $HOME/mamnon-backup/*.dump | tail -n +9 | xargs -r rm
```
Khôi phục: `pg_restore --clean --if-exists -d "<DATABASE_URL>" mamnon_YYYY-MM-DD.dump`.
Ảnh và hoá đơn nằm trên ổ đĩa Render. Sao lưu ổ đĩa: Render tự chụp snapshot hằng ngày, khôi phục ở **mamnon-api → Disks → Snapshots**.

## Cập nhật phiên bản
- **API:** push lên nhánh `master` → Render tự build và deploy. Migration mới tự chạy khi khởi động; migration chỉ thêm, không xoá dữ liệu. Lỗi thì Render giữ bản cũ đang chạy. Xem log ở **mamnon-api → Logs**.
- **Web:** push lên `main` → Vercel tự deploy. Bản lỗi có thể **Instant Rollback** ở **Deployments**.
- Trước khi cập nhật lớn: tạo nhánh khôi phục trên Neon (**Branches → Create branch**) để có điểm quay lại.

## Tự chạy trên VPS bằng Docker
Xem `deploy/docker-compose.yml` và `deploy/CHECKLIST.md`: Postgres 17, API, web, Caddy HTTPS, backup hằng ngày.

## Giữ API luôn thức (Render Free)
Đặt `KEEPALIVE_URL=https://<tên-api>.onrender.com/api/v1/health/ping` → API tự gọi chính nó mỗi `KEEPALIVE_INTERVAL_MS` (mặc định 600000 = 10 phút) nên Render không cho ngủ, đồng thời chạy luôn bộ gửi thông báo hẹn giờ. `GET /api/v1/health/ping` công khai, không chạm DB.
Lưu ý: gói Free có 750 giờ/tháng – đủ cho 1 dịch vụ chạy 24/7.

## Thông báo hẹn giờ – cron ngoài (tuỳ chọn, dự phòng)
API tự kiểm tra thông báo đến giờ gửi mỗi 30 giây (`ANNOUNCEMENT_TICK_MS`) và gửi bù ngay khi khởi động. Render gói Free **ngủ** sau 15 phút không có truy cập. Đã có `KEEPALIVE_URL` (mục trên) thì cron ngoài chỉ là dự phòng (nếu tiến trình bị khởi động lại mà chưa có ai truy cập):
1. Render → **mamnon-api → Environment**: copy giá trị `CRON_SECRET` (Render tự sinh).
2. Vào https://cron-job.org → **Create cronjob**:
   - URL: `https://<tên-api>.onrender.com/api/v1/internal/cron/announcements`
   - Schedule: **Every 5 minutes** (hoặc mỗi phút nếu muốn đúng giờ hơn).
   - **Advanced → Request method: POST**, thêm Header `X-Cron-Secret: <giá trị CRON_SECRET>`.
3. **Test run** → phải trả `200 {"ok":true,...}`. Sai/thiếu khoá → `401`.
Gọi nhiều lần không sao: mỗi thông báo chỉ gửi đúng 1 lần (khoá dòng `FOR UPDATE SKIP LOCKED`).

## Lưu ảnh: ổ đĩa Render hoặc Cloudflare R2
- Mặc định `STORAGE_DRIVER=local`: ảnh nằm trong `UPLOAD_DIR` trên ổ đĩa `/var/data` của Render (cần gói có Disk).
- Dùng R2 (khuyến nghị nếu không có Disk): Cloudflare → **R2 → Create bucket** (vd `mamnon-uploads`, **không** bật public) → **Manage R2 API Tokens → Create token** quyền *Object Read & Write* cho bucket đó. Điền trên Render:
  `STORAGE_DRIVER=s3`, `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`, `S3_BUCKET=mamnon-uploads`, `S3_ACCESS_KEY`, `S3_SECRET`, (`S3_REGION` mặc định `auto`). `S3_PUBLIC_BASE` để trống – ảnh trẻ luôn được phục vụ qua API có kiểm tra quyền, không public.
- Hiện R2 áp dụng cho ảnh đính kèm thông báo; ảnh hồ sơ trẻ/biên lai vẫn ở `UPLOAD_DIR`.

## Dữ liệu demo cho ảnh hướng dẫn (staging)
Chạy từ máy có mã nguồn, trỏ thẳng vào Neon (Render Free không có Shell). Mạng chặn cổng 5432 thì dùng driver WebSocket của Neon (`@neondatabase/serverless`, cổng 443) – xem ghi chú trong `src/database/demo.ts`:
```
DATABASE_URL='<Neon direct URL>' npm run demo:load    # 3 lớp (Mầm 1, Chồi 1 dùng lại nếu có; Lá 1), 27 bé + phụ huynh, 2 GV demo,
                                                      # điểm danh + nhật ký tuần này, học phí 2 tháng (đã/thiếu/chưa đóng), ca làm,
                                                      # chấm công, 1 nghỉ phép, 1 trông thay, thu chi (1 khoản > 10tr chờ duyệt),
                                                      # 1 thông báo đã gửi + 1 hẹn giờ, thực đơn tuần. Không tải ảnh.
DATABASE_URL='<Neon direct URL>' npm run demo:purge   # xoá ĐÚNG các dòng demo (kể cả phiếu thu/hoá đơn người test tạo thêm cho bé demo)
```
- Mỗi dòng tạo ra được ghi vào bảng `demo_registry`; `demo:purge` chỉ xoá các dòng đó rồi xoá bảng. Tài khoản thật (hieutruong, gv_mam1, ketoan, ph_an…) và dữ liệu nhập tay không bị đụng tới.
- Lớp "Mầm 1"/"Chồi 1" đã có thì được dùng lại và **không** bị xoá; bé demo trong lớp thì bị xoá.
- `demo:load` từ chối chạy lần 2 khi chưa purge. 2 GV demo (`demo_gv_huong`, `demo_gv_mai`) có mật khẩu ngẫu nhiên, không đăng nhập được.

## Bảng biến môi trường API
| Biến | Bắt buộc | Ghi chú |
|---|---|---|
| `DATABASE_URL` | ✔ | `?sslmode=require` → TLS. `DATABASE_SSL=true\|false\|no-verify` để ép |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | ✔ | chuỗi ngẫu nhiên dài, khác nhau |
| `NODE_ENV=production`, `MIGRATIONS_RUN=true` | ✔ | |
| `CORS_ORIGIN` | ✔ | danh sách cách dấu phẩy, hỗ trợ `*` cho preview |
| `COOKIE_SECURE=true`, `COOKIE_SAMESITE=lax\|none` | ✔ | `none` tự bật Secure |
| `TRUST_PROXY` | ✔ | `2` (qua Vercel proxy) hoặc `1` (gọi thẳng) |
| `UPLOAD_DIR`, `AUDIT_LOG_DIR` | ✔ | trên ổ đĩa bền, vd `/var/data/uploads`, `/var/data/logs` |
| `SCHOOL_NAME`, `SCHOOL_ADDRESS`, `SCHOOL_PHONE` | nên có | in trên phiếu thu, trang đăng nhập |
| `INITIAL_ADMIN_USERNAME/PASSWORD/NAME` | lần đầu | xoá PASSWORD sau khi tạo |
| `PUBLIC_API_BASE` | nên có | tên miền web |
| `VAPID_*`, `NOTIFY_CHANNELS` | tuỳ chọn | thông báo đẩy |
| `FINANCE_APPROVAL_LIMIT` | tuỳ chọn | mặc định 10000000 |
| `CRON_SECRET` | nên có | header `X-Cron-Secret` cho cron ngoài; trống = tắt endpoint (401) |
| `KEEPALIVE_URL`, `KEEPALIVE_INTERVAL_MS` | nên có (Free) | tự gọi `/api/v1/health/ping` để không ngủ; mặc định 10 phút |
| `ANNOUNCEMENT_TICK_MS` | tuỳ chọn | chu kỳ kiểm tra hẹn giờ, mặc định 30000; 0 = tắt |
| `STORAGE_DRIVER`, `S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET/S3_PUBLIC_BASE/S3_REGION` | tuỳ chọn | `local` (mặc định) hoặc `s3` (R2) |
