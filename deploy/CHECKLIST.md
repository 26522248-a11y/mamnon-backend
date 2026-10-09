# Checklist triển khai lên VPS (Ubuntu 22.04/24.04, 2 CPU / 4 GB RAM)

Làm lần lượt từng bước, đánh dấu `[x]` khi xong. Lệnh chạy bằng user có `sudo`. `<root>` là thư mục chứa 2 repo, ví dụ `/opt/mamnon`.

---

## 0. Chuẩn bị (trước ngày triển khai)

- [ ] Có VPS Ubuntu 22.04 hoặc 24.04, **2 CPU / 4 GB RAM / ≥ 40 GB SSD**, có IP public tĩnh.
- [ ] Có tên miền (vd `mamnon.truonghoasen.edu.vn`) và quyền sửa DNS.
- [ ] Có email nhận thông báo chứng chỉ (Let's Encrypt).
- [ ] Đã có **thông tin thật của trường**: tên đầy đủ, địa chỉ, số điện thoại (in trên phiếu thu, phiếu chi, file Excel, trang đăng nhập).
- [ ] Nơi lưu backup ngoài VPS (ổ ngoài / Google Drive / máy khác) để chép backup ra hằng tuần.

## 1. Cài đặt máy chủ

```bash
sudo apt update && sudo apt -y upgrade
sudo timedatectl set-timezone Asia/Ho_Chi_Minh
# swap 2 GB (build Next.js cần thêm RAM)
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
# tường lửa: chỉ SSH + HTTP + HTTPS
sudo apt -y install ufw git
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp
sudo ufw --force enable
```

- [ ] `timedatectl` hiện `Asia/Ho_Chi_Minh`; `free -h` có swap 2G; `sudo ufw status` có 22, 80, 443.

## 2. Cài Docker (bản chính thức)

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update && sudo apt -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER   # đăng xuất / đăng nhập lại để có hiệu lực
```

- [ ] `docker version` và `docker compose version` (v2.x) chạy được không cần `sudo`.

## 3. Lấy mã nguồn

Hai repo phải nằm **cạnh nhau**:

```bash
sudo mkdir -p /opt/mamnon && sudo chown $USER /opt/mamnon && cd /opt/mamnon
git clone <url-repo-backend> mamnon-backend
git clone <url-repo-web>     mamnon-web
# Không có git remote: chép từ máy dev, vd  rsync -a --exclude node_modules --exclude .next mamnon-backend mamnon-web user@vps:/opt/mamnon/
```

- [ ] `ls /opt/mamnon` có `mamnon-backend` và `mamnon-web`.
- [ ] Ghi lại phiên bản đang triển khai: `git -C mamnon-backend rev-parse --short HEAD` và tương tự với web.

## 4. Điền `deploy/.env`

```bash
cd /opt/mamnon/mamnon-backend/deploy
cp .env.example .env && chmod 600 .env
openssl rand -base64 48   # chạy 3 lần: POSTGRES_PASSWORD, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET
nano .env
```

- [ ] `DOMAIN` = tên miền thật (không có `https://`), `ACME_EMAIL` = email thật.
- [ ] `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`: 3 chuỗi ngẫu nhiên **khác nhau**, ≥ 32 ký tự. Không dùng giá trị mẫu.
- [ ] `INITIAL_ADMIN_USERNAME` (vd `hieutruong`) và `INITIAL_ADMIN_PASSWORD`: ≥ 10 ký tự, có cả chữ và số, **không** phải `123456` hay mật khẩu phổ biến, không chứa tên đăng nhập.
- [ ] ⚠️ **`SCHOOL_NAME`, `SCHOOL_ADDRESS`, `SCHOOL_PHONE` phải là thông tin THẬT của trường.** File mẫu có địa chỉ / SĐT ví dụ (`12 Đường Hoa Sen…`, `028 3812 3456`) – nếu để nguyên, phiếu thu / phiếu chi in ra cho phụ huynh sẽ sai. Kiểm tra lại chính tả tên trường.
- [ ] `BACKUP_DIR` (mặc định `./backups`): nên trỏ sang ổ riêng nếu có, vd `/mnt/backup/mamnon`.
- [ ] Sau khi điền: `docker compose config > /dev/null && echo OK` in ra `OK` (không báo thiếu biến).

## 5. DNS

- [ ] Tạo bản ghi **A**: `DOMAIN` → IP public của VPS (và **AAAA** nếu VPS có IPv6; nếu không có IPv6 thì **không** tạo AAAA).
- [ ] Chờ DNS có hiệu lực: `dig +short <DOMAIN>` trả về đúng IP VPS (có thể mất 5–30 phút).
- [ ] Cổng 80 và 443 không bị nhà cung cấp VPS chặn (Let's Encrypt cần cổng 80 để cấp chứng chỉ).

## 6. Khởi động

```bash
cd /opt/mamnon/mamnon-backend/deploy
docker compose up -d --build          # lần đầu build mất ~5–10 phút
docker compose ps
docker compose logs migrate
```

- [ ] `docker compose ps`: `migrate` = **exited (0)**; `db`, `api`, `web`, `caddy`, `backup` = running (`db` healthy).
- [ ] `docker compose logs migrate` có dòng `bootstrap:admin: created admin "<tên>"` (lần đầu).
  - Nếu thấy `INITIAL_ADMIN_PASSWORD refused: …` → sửa mật khẩu trong `.env`, chạy lại `docker compose up -d`.
  - Nếu `migrate` lỗi kết nối DB → `docker compose logs db`.

## 7. Admin đầu tiên (`bootstrap:admin`)

Service `migrate` tự chạy `bootstrap-admin` sau migration: chỉ tạo **một** tài khoản admin với `mustChangePassword=true`; nếu đã có admin thì bỏ qua. **Không** có tài khoản demo nào (`admin/123456`, `gv1`, `ph1`…) – seed demo bị chặn khi `NODE_ENV=production`.

- [ ] Mở `https://<DOMAIN>`, đăng nhập bằng `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` → hệ thống bắt **đổi mật khẩu** → đổi sang mật khẩu mới, cất vào nơi an toàn.
- [ ] Xoá mật khẩu khỏi file env: sửa `.env` thành `INITIAL_ADMIN_PASSWORD=` (để trống). Không cần khởi động lại.
- [ ] Thử đăng nhập `admin` / `123456` → phải **thất bại**.
- [ ] Tạo tài khoản giáo viên, kế toán trong màn hình Quản lý người dùng; tạo lớp; nhập học sinh (Excel: tải mẫu `deploy/templates/mau-nhap-hoc-sinh.xlsx`, bấm Kiểm tra trước rồi mới Nhập; **cất kỹ file kết quả có mật khẩu tạm của phụ huynh**).

## 8. Kiểm tra HTTPS

```bash
curl -sI https://<DOMAIN> | head -1                          # HTTP/2 200
curl -s https://<DOMAIN>/api/v1/health                       # {"status":"ok",...}
curl -s https://<DOMAIN>/api/v1/settings/school              # tên / địa chỉ / SĐT THẬT của trường
curl -sI http://<DOMAIN> | grep -i location                  # chuyển sang https://
echo | openssl s_client -connect <DOMAIN>:443 -servername <DOMAIN> 2>/dev/null | openssl x509 -noout -issuer -dates
```

- [ ] Trình duyệt hiện ổ khoá, chứng chỉ do **Let's Encrypt** cấp, còn hạn ~90 ngày (Caddy tự gia hạn).
- [ ] `/api/v1/settings/school` trả đúng thông tin thật (nếu sai → sửa `.env`, `docker compose up -d api`).
- [ ] Nếu chứng chỉ không cấp được: `docker compose logs caddy` (thường do DNS chưa đúng hoặc cổng 80 bị chặn).
- [ ] (Tuỳ chọn) Chặn Swagger công khai: thêm `respond /api/docs* 404` vào `deploy/Caddyfile`, `docker compose restart caddy`.

## 9. Kiểm tra backup hằng ngày

Service `backup` chạy lúc `BACKUP_TIME` (mặc định 02:30 giờ VN): `pg_dump` (có kiểm tra đọc lại) + nén thư mục ảnh, xoay vòng 14 ngày / 8 tuần / 12 tháng.

```bash
docker compose exec backup backup.sh          # chạy thử ngay
ls -lh backups/daily/                         # có mamnon_YYYY-MM-DD_HHMM.dump và uploads_….tar.gz
docker compose logs backup | tail -5          # "backup OK: …"
```

- [ ] Chạy thử thành công, file `.dump` > 0 byte.
- [ ] **Sáng hôm sau** kiểm tra lại: có file mới với giờ ≈ 02:30 → lịch chạy tự động hoạt động.
- [ ] Đặt lịch chép `backups/` ra ngoài VPS (vd hằng tuần bằng `rsync`/`rclone`). Backup chỉ nằm trên VPS = mất khi VPS hỏng.

## 10. Khôi phục thử (bắt buộc làm ít nhất 1 lần trước khi dùng thật)

Khôi phục vào **DB tạm** để không đụng dữ liệu đang chạy:

```bash
F=$(ls -1t backups/daily/mamnon_*.dump | head -1)
docker compose exec -T db createdb -U mamnon mamnon_restore_test
docker compose exec -T db pg_restore -U mamnon -d mamnon_restore_test --no-owner < "$F"
docker compose exec -T db psql -U mamnon -d mamnon_restore_test -c "select count(*) as users from users; select count(*) as children from children; select max(created_at) from invoices;"
docker compose exec -T db dropdb -U mamnon mamnon_restore_test
tar -tzf $(ls -1t backups/daily/uploads_*.tar.gz | head -1) | head    # file ảnh đọc được
```

- [ ] Số lượng users / children khớp với hệ thống đang chạy; không có lỗi `pg_restore`.
- [ ] Ghi lại ngày làm khôi phục thử: ________

**Khôi phục thật** (khi mất dữ liệu): xem mục "Khôi phục" trong `README.md` (dừng `api` → `pg_restore --clean` vào `mamnon` → giải nén ảnh → `start api`).

## 11. Nâng cấp phiên bản

```bash
cd /opt/mamnon/mamnon-backend/deploy
# 1) ghi lại phiên bản hiện tại + giữ image cũ để rollback
git -C .. rev-parse --short HEAD > ../.prev-backend; git -C ../../mamnon-web rev-parse --short HEAD > ../.prev-web
docker tag mamnon-api:latest mamnon-api:prev && docker tag mamnon-web:latest mamnon-web:prev
# 2) backup ngay trước khi nâng cấp
docker compose exec backup backup.sh
# 3) lấy mã mới và build lại (migrate chạy migration mới trước khi api khởi động)
git -C .. pull && git -C ../../mamnon-web pull
docker compose up -d --build
docker compose ps && docker compose logs migrate | tail -20
```

- [ ] Đọc ghi chú phát hành / commit trước khi nâng cấp (có migration không? có biến `.env` mới không? so sánh `.env.example` với `.env`).
- [ ] Nâng cấp ngoài giờ học (tối / cuối tuần); báo trước cho giáo viên.
- [ ] Sau nâng cấp: `migrate` exited (0), đăng nhập được, mở thử Điểm danh, Học phí, một phiếu thu.

## 12. Rollback (khi bản mới lỗi)

**Trường hợp A – bản mới KHÔNG có migration (hoặc migration chỉ thêm cột):** quay lại image cũ.

```bash
cd /opt/mamnon/mamnon-backend/deploy
docker tag mamnon-api:prev mamnon-api:latest && docker tag mamnon-web:prev mamnon-web:latest
git -C .. checkout $(cat ../.prev-backend) && git -C ../../mamnon-web checkout $(cat ../.prev-web)
docker compose up -d --no-build
```

**Trường hợp B – bản mới có migration làm đổi dữ liệu:** hoàn tác migration rồi mới quay image (chạy bằng image MỚI, vì nó chứa file migration):

```bash
docker compose run --rm migrate node node_modules/typeorm/cli.js -d dist/database/data-source.js migration:revert   # mỗi lần hoàn tác 1 migration
# rồi làm như Trường hợp A
```

**Trường hợp C – dữ liệu hỏng:** khôi phục backup chụp ở bước 11.2 (xem README "Khôi phục") rồi làm như Trường hợp A. Dữ liệu nhập sau thời điểm backup sẽ mất → ghi lại để nhập lại.

- [ ] Sau rollback: `docker compose ps` bình thường, đăng nhập được, báo lại cho người dùng.
- [ ] Khi đã có bản sửa lỗi: chạy `git checkout main` (hoặc nhánh đang dùng) cho cả 2 repo trước lần nâng cấp kế tiếp.

## 13. Vận hành hằng tuần / hằng tháng

- [ ] Hằng tuần: xem `docker compose ps`, `df -h` (dung lượng đĩa), có file backup mới; chép backup ra ngoài.
- [ ] Hằng tháng: `sudo apt update && sudo apt -y upgrade` (khởi động lại VPS nếu cần, stack tự chạy lại nhờ `restart: unless-stopped`).
- [ ] Mỗi học kỳ: làm lại bước 10 (khôi phục thử).
