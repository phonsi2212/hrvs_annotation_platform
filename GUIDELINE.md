# 📘 Hướng Dẫn Chi Tiết (User & Developer Guideline) - HRVS Annotation Platform

> **High-Resolution Visual Search (HRVS) Annotation Platform** là nền tảng gán nhãn thị giác máy tính chuyên sâu, tối ưu cho hình ảnh siêu phân giải (2K / 4K / 8K+) với mật độ đối tượng cao, phục vụ các bài toán nghiên cứu Visual Search, Object Counting, Attribute Recognition và Spatial Reasoning.

---

## 📑 Mục Lục
1. [Yêu Cầu Hệ Thống](#1-yêu-cầu-hệ-thống)
2. [Cài Đặt & Khởi Chạy Nhanh](#2-cài-đặt--khởi-chạy-nhanh)
3. [Kiến Trúc & Các Chế Độ Làm Việc](#3-kiến-trúc--các-chế-độ-làm-việc)
4. [Hướng Dẫn Chi Tiết Workflow 1: Point Annotation](#4-hướng-dẫn-chi-tiết-workflow-1-point-annotation)
5. [Hướng Dẫn Chi Tiết Workflow 2: QA Annotation](#5-hướng-dẫn-chi-tiết-workflow-2-qa-annotation)
6. [Quản Lý Dataset & Cơ Chế Khóa Hoàn Thành](#6-quản-lý-dataset--cơ-chế-khóa-hoàn-thành)
7. [Lưu Trữ, Sao Lưu & Xuất Dữ Liệu](#7-lưu-trữ-sao-lưu--xuất-dữ-liệu)
8. [Bảng Phím Tắt Toàn Diện (Shortcut Cheat Sheet)](#8-bảng-phím-tắt-toàn-diện-shortcut-cheat-sheet)
9. [Cấu Trúc Mã Nguồn & Module Kỹ Thuật](#9-cấu-trúc-mã-nguồn--module-kỹ-thuật)
10. [Xử Lý Sự Cố Thường Gặp (FAQ & Troubleshooting)](#10-xử-lý-sự-cố-thường-gặp-faq--troubleshooting)

---

## 1. Yêu Cầu Hệ Thống

- **Hệ điều hành:** Linux (Ubuntu 20.04+), macOS, hoặc Windows 10/11.
- **Python:** Phiên bản Python 3.8 trở lên (khuyến nghị Python 3.10 – 3.12).
- **Trình duyệt Web:** Google Chrome, Microsoft Edge, Mozilla Firefox hoặc Safari bản mới nhất (hỗ trợ tốt chuẩn HTML5 Canvas và ES6 Modules).
- **Phần cứng:**
  - Tối thiểu 4GB RAM (Khuyến nghị 8GB+ RAM khi làm việc với nhiều ảnh 8K).
  - Không bắt buộc GPU (hệ thống frontend sử dụng Canvas 2D Affine Transform tăng tốc phần cứng trình duyệt).

---

## 2. Cài Đặt & Khởi Chạy Nhanh

### Bước 1: Tải mã nguồn về máy
```bash
git clone https://github.com/phonsi2212/hrvs_annotation_platform.git
cd hrvs_annotation_platform
```

### Bước 2: Tạo và kích hoạt môi trường ảo (Virtual Environment)
- **Trên Linux / macOS:**
  ```bash
  python3 -m venv venv
  source venv/bin/activate
  ```
- **Trên Windows (PowerShell):**
  ```powershell
  python -m venv venv
  .\venv\Scripts\Activate.ps1
  ```

### Bước 3: Cài đặt các thư viện phụ thuộc
```bash
pip install -r requirements.txt
```
*Các dependencies chính gồm có: `fastapi`, `uvicorn`, `pillow`, `pydantic`, `python-multipart`.*

### Bước 4: Khởi chạy nền tảng
```bash
python run.py
```
- Lần đầu tiên chạy, hệ thống sẽ tự động khởi tạo cơ sở dữ liệu SQLite tại `storage/hrvs_annotations.db` và nạp 2 ảnh mẫu UHD (`same_object_crowd.jpg` 4000x3000 và `mixed_object_room.jpg` 3840x2160) từ thư mục `sample_data/`.
- Mở trình duyệt web và truy cập vào địa chỉ:
  👉 **`http://localhost:8000`**

*(Tùy chọn: Muốn mở rộng cho mạng nội bộ hoặc thay đổi cổng, bạn có thể chạy: `uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload`)*

---

## 3. Kiến Trúc & Các Chế Độ Làm Việc

Nền tảng chia làm **2 phân nhóm mật độ (Density Groups)** chính:
1. **`same_object` (Đồng nhất mật độ cực cao):** Thích hợp cho bài toán đếm đám đông, vật thể nhỏ giống nhau (chuẩn benchmark NWPU-Crowd).
2. **`mixed_object` (Đa dạng đối tượng):** Thích hợp cho bối cảnh trong phòng, bàn làm việc, giá sách với nhiều lớp nhãn khác nhau.

### Bố cục giao diện người dùng (UI Layout)
```text
+---------------------------------------------------------------------------------------+
|  [Logo & HRVS Platform]       [Mode: Point | Mode: QA]       [Finish/Unlock] [Export] |
+------------------+-------------------------------------------------+------------------+
|  DATASET & IMAGES|               CANVAS VIEWPORT                   | PALETTE / QA     |
|                  |                                                 |                  |
| [Search...]      |  - Dual-Canvas 2D Rendering Engine              | - Category List  |
| - Dataset 1      |  - Smooth Pan & Zoom (0.05x - 40x)              |   (1-9 shortcuts)|
|   - img_001.jpg  |  - Minimap góc trên phải                        | - Inspector:     |
|   - img_002.jpg  |  - Halo phát sáng liên kết Ground-Truth         |   Coords, Color, |
| - Dataset 2      |                                                 |   Custom notes   |
|                  |                                                 | - QA Form (Mode 2|
+------------------+-------------------------------------------------+------------------+
| Footer: Phím tắt điều hướng [A / D], Tọa độ con trỏ (X, Y), Tỷ lệ Zoom hiện tại       |
+---------------------------------------------------------------------------------------+
```

---

## 4. Hướng Dẫn Chi Tiết Workflow 1: Point Annotation

Workflow 1 dùng để chấm điểm vị trí chính xác và gán nhãn thuộc tính cho từng đối tượng trên ảnh gốc.

### 4.1. Điều Hướng & Quan Sát Không Gian (Viewport Navigation)
- **Phóng to / Thu nhỏ (Zoom):** Lăn con lăn chuột (Mouse Wheel). Trọng tâm phóng to luôn bám theo con trỏ chuột (`0.05x` đến `40.0x`).
- **Phóng to 1:1 Pixel gốc (`Z` key):** Bấm phím `Z` để ngay lập tức đưa ảnh về tỷ lệ 1:1 (100% kích thước pixel gốc) tại vị trí con trỏ chuột — cực kỳ hữu ích khi cần xác định đỉnh đầu đám đông.
- **Vừa vặn màn hình (`F` hoặc `R` key):** Đưa toàn bộ ảnh về góc nhìn bao quát ban đầu.
- **Di chuyển góc nhìn (Pan):**
  - Giữ phím `Space` và kéo chuột.
  - Hoặc bấm giữ chuột trái ở vùng trống và kéo nhẹ.
- **Minimap điều hướng:** Ở góc trên bên phải có một bản đồ thu nhỏ hiển thị khung màu đỏ đại diện cho tầm nhìn hiện tại (frustum). Bạn có thể click hoặc rê khung đỏ trên minimap để di chuyển nhanh trên ảnh lớn. Minimap còn có các chấm nhỏ thể hiện mật độ phân bố điểm đã gán nhãn.
- **Tạm ẩn điểm chấm (`H` key):** Nhấn giữ phím `H` để tạm thời ẩn tất cả các vòng tròn điểm chấm, giúp bạn nhìn rõ chi tiết điểm ảnh bên dưới; thả phím `H` các điểm sẽ hiện lại ngay lập tức.

### 4.2. Thao Tác Chấm Điểm (Point CRUD)
1. **Thêm điểm mới:**
   - Chọn công cụ **Point Tool** (phím tắt `P`).
   - Click chuột trái vào vị trí cần chấm trên ảnh. Tọa độ chính xác theo pixel ảnh gốc sẽ được ghi nhận.
2. **Chọn & Di chuyển điểm:**
   - Chọn công cụ **Select Tool** (phím tắt `V`).
   - Click chuột trái vào điểm cần chọn (điểm được chọn sẽ có viền sáng nổi bật).
   - Bấm giữ chuột trái vào điểm đó và kéo đến vị trí mới để hiệu chỉnh tọa độ.
3. **Xóa điểm:**
   - Chọn điểm rồi bấm phím `Delete` hoặc `Backspace`.
   - Hoặc click chuột phải trực tiếp vào điểm để xóa nhanh.
4. **Đổi nhãn phân loại (Category):**
   - Bấm các phím số từ `1` đến `9` trên bàn phím để đổi nhanh danh mục cho điểm đang chọn hoặc thiết lập danh mục mặc định cho các điểm chấm tiếp theo.
   - Thêm danh mục mới: Nhập tên nhãn vào ô "Add Category" ở thanh công cụ bên phải và chọn màu tương ứng.
5. **Gán thuộc tính phụ (Inspector):**
   - Khi chọn một điểm, panel bên phải sẽ mở ra thông tin chi tiết:
     - `Color`: Màu sắc của đối tượng.
     - `State`: Trạng thái (che khuất, quay lưng, bóng mờ,...).
     - `Note`: Ghi chú tự do.
6. **Hoàn tác & Làm lại (Undo / Redo):**
   - Hỗ trợ đầy đủ `Ctrl + Z` để hoàn tác thao tác gần nhất và `Ctrl + Y` để làm lại. Lịch sử hoàn tác được lưu độc lập theo từng ảnh.

---

## 5. Hướng Dẫn Chi Tiết Workflow 2: QA Annotation

Workflow 2 dùng để xây dựng các cặp Câu hỏi – Trả lời (Question–Answer) đa phương thức, chuẩn bị tập dữ liệu huấn luyện cho mô hình đa phương thức (VLM/MLLM).

### 5.1. Chuyển sang QA Mode
- Click vào nút chuyển chế độ **"QA Mode"** ở thanh Header trên cùng.
- Khi vào QA Mode, **Canvas sẽ tự động chuyển sang trạng thái Read-only**: Toàn bộ điểm tọa độ bị khóa cố định, ngăn chặn hoàn toàn việc vô tình click xê dịch hoặc xóa nhầm điểm đã gán nhãn ở Workflow 1.

### 5.2. Tạo Cặp Q&A Mới
1. Bấm nút **"+ New Q&A"** ở panel bên phải.
2. Chọn loại tác vụ (**Task Type**):
   - `Visual Search`: Tìm kiếm vị trí đối tượng ("Người mặc áo đỏ đang ở đâu?").
   - `Counting`: Đếm số lượng đối tượng trong một vùng hoặc toàn ảnh ("Có bao nhiêu chiếc máy tính xách tay?").
   - `Attribute Recognition`: Nhận diện thuộc tính đặc trưng ("Người ở góc trái đang đội mũ màu gì?").
   - `Spatial Relation`: Quan hệ vị trí không gian ("Vật thể nào nằm ở phía bên phải chiếc đèn bàn?").
3. Nhập nội dung câu hỏi (`Question`) và câu trả lời (`Answer`).

### 5.3. Liên Kết Ground-Truth Target Points (Tính Năng Độc Quyền)
- Trong khi đang soạn thảo Q&A, click trực tiếp vào các điểm tròn trên ảnh để đánh dấu những điểm này là **bằng chứng thị giác (Ground-Truth Evidence)** cho câu trả lời.
- Các điểm được liên kết sẽ xuất hiện **vòng tròn hào quang màu xanh lá phát sáng nhấp nháy (pulsating green halo)** trên màn hình.
- Danh sách ID điểm được liên kết (`target_point_ids`) sẽ tự động được gán vào dữ liệu xuất của Q&A.
- Bấm **"Save Q&A"** để lưu cặp câu hỏi.

---

## 6. Quản Lý Dataset & Cơ Chế Khóa Hoàn Thành

### 6.1. Tổ Chức Thư Mục & Nhập Dữ Liệu Hàng Loạt (Bulk Import)
Nền tảng hỗ trợ 2 hình thức nạp ảnh vào hệ thống qua nút **"Import"**:
1. **Import Single Image / Local File:** Thêm từng file ảnh từ máy hoặc đường dẫn cục bộ.
2. **Import Dataset Folder:** Quét toàn bộ một thư mục lớn chứa hàng trăm/hàng nghìn ảnh.
   - Hỗ trợ định dạng chuẩn benchmark NWPU-Crowd:
     ```text
     dataset_root/
     ├── images/       # Chứa các file ảnh (0001.jpg, 0002.jpg, ...)
     └── jsons/        # Chứa annotation tương ứng ({"img_id": "0001.jpg", "points": [[x, y], ...]})
     ```
   - Ảnh nào đã có tọa độ điểm trong file JSON sẽ tự động được đánh dấu là `completed`.
   - Ảnh nào chưa có tọa độ sẽ ở trạng thái `todo` để người gán nhãn tiếp tục hoàn thiện.

### 6.2. Cơ Chế Khóa Trạng Thái Độc Lập (Completed Image Locking)
Để bảo vệ tính toàn vẹn dữ liệu, hệ thống chia làm 2 trạng thái độc lập cho mỗi bức ảnh:
- **`status` (Tiến độ Point):** `todo` ➔ `in_progress` ➔ `completed`.
- **`qa_status` (Tiến độ QA):** Tự động chuyển `completed` khi ảnh có ít nhất 1 cặp Q&A.

**Cơ chế bảo vệ:**
- Khi ảnh có `status = completed`, toàn bộ thao tác thêm, sửa, xóa, di chuyển điểm trên canvas sẽ bị **khóa cứng** cả ở giao diện lẫn tầng API máy chủ (trả về mã HTTP `409 Conflict`).
- Để chỉnh sửa lại, người dùng cần bấm nút **"🔓 Unlock"** ở góc trên bên phải để mở khóa.

---

## 7. Lưu Trữ, Sao Lưu & Xuất Dữ Liệu

### 7.1. Lưu Trữ Nguyên Tử (Zero-Latency Live File Store)
Mỗi thao tác chấm điểm hay chỉnh sửa Q&A đều được lưu đồng thời vào 2 tầng:
1. Cơ sở dữ liệu SQLite: `storage/hrvs_annotations.db`.
2. File JSON riêng biệt cho từng ảnh:
   - `storage/annotations/same_object/<image_id>.json`
   - `storage/annotations/mixed_object/<image_id>.json`
Tất cả các lượt ghi file đều thực hiện theo cơ chế nguyên tử (Atomic write via `.tmp` swap), đảm bảo không bao giờ bị hỏng file kể cả khi tắt ứng dụng đột ngột.

### 7.2. Tự Động Sao Lưu (Auto Backups)
Định kỳ hoặc sau mỗi đợt thao tác lớn, hệ thống sẽ snapshot toàn bộ dữ liệu ra một file nén JSON gắn kèm timestamp tại `storage/auto_backups/backup_YYYYMMDD_HHMMSS.json`.

### 7.3. Xuất Dữ Liệu Chuẩn Benchmark (Export)
Bấm nút **"Export"** ở góc trên bên phải giao diện để tải về:
- **Xuất JSON (HRVS Benchmark Specification):** Chứa đầy đủ siêu dữ liệu độ phân giải gốc, tọa độ chuẩn hóa `x_norm`, `y_norm`, danh mục, thuộc tính và liên kết Q&A target points.
- **Xuất CSV:** Bảng dữ liệu phẳng chi tiết, hỗ trợ sẵn chuẩn mã hóa UTF-8 BOM để mở tiếng Việt hoặc ký tự đặc biệt trên Microsoft Excel mà không bị lỗi font.

---

## 8. Bảng Phím Tắt Toàn Diện (Shortcut Cheat Sheet)

| Phím Tắt | Ý Nghĩa / Hành Động | Ghi Chú |
|:---:|---|---|
| `A` hoặc `←` | Chuyển sang ảnh trước đó | Trong phạm vi dataset hiện tại |
| `D` hoặc `→` | Chuyển sang ảnh kế tiếp | Trong phạm vi dataset hiện tại |
| `F` hoặc `R` | Reset góc nhìn / Fit ảnh vừa khung hình | Đưa toàn bộ ảnh về bao quát |
| `Z` | Phóng to 1:1 (Actual Pixels) | Zoom 100% tại vị trí trỏ chuột |
| `Space` + Rê chuột | Kéo di chuyển góc nhìn (Pan) | Rất mượt cho ảnh siêu phân giải |
| `Mouse Wheel` | Phóng to / Thu nhỏ theo con trỏ chuột | Từ 0.05x đến 40.0x |
| `P` | Chuyển sang công cụ Chấm điểm (Point Tool) | Chỉ khả dụng trong Point Mode |
| `V` | Chuyển sang công cụ Chọn / Di chuyển (Select Tool) | Click điểm để kéo di chuyển |
| `Chuột Trái` | Chấm điểm (Tool P) hoặc Chọn điểm (Tool V) | |
| `Chuột Phải` lên điểm | Xóa nhanh điểm | Không cần chọn trước |
| `Delete` / `Backspace` | Xóa điểm đang được chọn | |
| `H` (Nhấn & Giữ) | Tạm ẩn toàn bộ điểm chấm trên canvas | Thả ra sẽ hiển thị lại |
| `Ctrl + Z` | Hoàn tác (Undo) | Lưu theo từng ảnh |
| `Ctrl + Y` | Làm lại (Redo) | |
| `1` – `9` | Chọn nhanh danh mục từ Palette | Gán nhãn cực nhanh |
| `Esc` | Hủy chọn điểm / Đóng hộp thoại | |
| `?` | Hiển thị bảng tra cứu phím tắt trong app | |

---

## 9. Cấu Trúc Mã Nguồn & Module Kỹ Thuật

```text
hrvs_annotation_platform/
├── README.md                        # Giới thiệu tổng quan & đặc tả kỹ thuật
├── GUIDELINE.md                     # Tài liệu hướng dẫn sử dụng & thiết lập chi tiết
├── requirements.txt                 # Khai báo các gói thư viện Python cần thiết
├── run.py                           # Điểm khởi chạy server chính (FastAPI + Uvicorn)
├── test_platform.py                 # Bộ kiểm thử tự động toàn diện (Integration Tests)
├── storage/                         # Thư mục dữ liệu runtime (được cấu hình gitignore)
│   ├── hrvs_annotations.db         # Cơ sở dữ liệu SQLite
│   ├── annotations/                # Lưu file JSON live theo từng ảnh (same_object / mixed_object)
│   ├── auto_backups/               # Snapshot sao lưu tự động
│   ├── exports/                    # File xuất bản JSON / CSV
│   └── thumbnails/                 # Bộ nhớ đệm ảnh thu nhỏ tối ưu tốc độ duyệt
├── sample_data/                    # Dữ liệu ảnh mẫu 4K/UHD đính kèm repo
│   ├── generate_samples.py         # Script tự động tạo ảnh mẫu giả lập
│   ├── same_object_crowd.jpg       # Ảnh 4000x3000 giả lập đám đông cực đông
│   └── mixed_object_room.jpg       # Ảnh 3840x2160 giả lập phòng làm việc
└── app/                            # Mã nguồn ứng dụng
    ├── main.py                     # Định nghĩa toàn bộ RESTful API endpoints
    ├── database.py                 # Quản lý kết nối SQLite, migrations, index & query
    ├── annotation_store.py         # Cơ chế đồng bộ hóa JSON nguyên tử cho từng ảnh
    ├── schemas.py                  # Định dạng Pydantic models và cấu trúc HRVS Export
    └── static/                     # Giao diện Single Page Application (SPA)
        ├── index.html              # HTML giao diện chính (tự động cache-busting asset)
        ├── css/styles.css          # Giao diện Dark theme hiện đại, glassmorphism
        └── js/
            ├── app.js              # Điều phối trạng thái toàn cục & kết nối backend
            ├── canvas_viewport.js  # Engine đồ họa 2D Canvas Viewport, Affine Transform
            ├── point_workflow.js   # Xử lý sự kiện Workflow 1: CRUD điểm, drag & drop, undo/redo
            └── qa_workflow.js      # Xử lý sự kiện Workflow 2: Q&A editor & Target Linker
```

---

## 10. Xử Lý Sự Cố Thường Gặp (FAQ & Troubleshooting)

### Q1: Không thêm hoặc di chuyển được điểm trên ảnh?
- **Nguyên nhân 1:** Bức ảnh đang ở trạng thái `completed`. Hãy nhìn góc trên bên phải xem có nút **"🔓 Unlock"** không, bấm vào đó để mở khóa.
- **Nguyên nhân 2:** Bạn đang ở **QA Mode** (chế độ này cố tình khóa canvas ở trạng thái Read-only). Hãy bấm vào nút **"Point Mode"** trên thanh header để quay lại chế độ chấm điểm.
- **Nguyên nhân 3:** Đang chọn công cụ `Select Tool (V)`. Hãy bấm phím `P` để chuyển về `Point Tool`.

### Q2: Báo lỗi "Address already in use" khi chạy `python run.py`?
- Cổng `8000` đang bị chiếm dụng bởi một tiến trình khác. Bạn có thể chỉ định cổng khác:
  ```bash
  python -c "import uvicorn; uvicorn.run('app.main:app', host='127.0.0.1', port=8080)"
  ```

### Q3: Tải ảnh kích thước lớn 8K có bị chậm giật không?
- Không. Nền tảng sử dụng kỹ thuật **Dual-Canvas Rendering**:
  - Lớp ảnh gốc chỉ được vẽ lại một lần duy nhất khi pan/zoom.
  - Lớp crosshair và các điểm chấm vẽ trên canvas overlay nhẹ phía trên.
  - Các ảnh trong danh sách duyệt bên trái đều dùng **cached thumbnails 160px**, không tải ảnh 8K vào danh sách preview nên tốc độ lướt danh sách cực kỳ mượt mà.

---
*Tác giả / Duy trì dự án: [phonsi2212](https://github.com/phonsi2212)*
