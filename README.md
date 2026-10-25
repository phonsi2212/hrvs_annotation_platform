# High-Resolution Visual Search (HRVS) Annotation Platform

A high-performance, browser-based annotation platform specifically engineered for **High-Resolution Visual Search (HRVS)** on 2K/4K/8K+ images across two core benchmark density profiles:
1. **Same-object Density (`same_object`)**: Extreme density formed by homogeneous objects (e.g., small human heads in the **NWPU-Crowd** dataset).
2. **Mixed-object Density (`mixed_object`)**: High density composed of varied objects (e.g., cluttered indoor rooms and office desks).

> 📘 **Tài liệu hướng dẫn chi tiết tiếng Việt (Full Guideline):** Xem tại [GUIDELINE.md](GUIDELINE.md) để biết cách thiết lập chi tiết, bảng phím tắt và giải thích mọi chức năng của nền tảng.

---

## 🌟 Key Architectural Highlights

### 1. Two Decoupled Workflows (Independent Modes)
- **Workflow 1: Point-level Annotation Mode (100% Complete MVP)**
  - Exact `(x, y)` coordinate placement on original image pixels.
  - Category palette with quick keyboard shortcuts (`1` - `9`), custom classes, and color chips.
  - Interactive drag-and-drop point repositioning.
  - Real-time inspector for metadata and fine-grained attributes (`color`, `state`, `sub_type`, `note`).
  - Full Undo / Redo support (`Ctrl + Z` / `Ctrl + Y`).
- **Workflow 2: Question–Answer (QA) Annotation Mode**
  - Read-only canvas locks point coordinates to prevent accidental movement.
  - Create and edit Q&A pairs for tasks: `Visual Search`, `Counting`, `Attribute Recognition`, `Spatial Relation`.
  - **Ground-Truth Target Linker**: Interactively click points on the canvas to link them as visual evidence (`target_point_ids`) with animated green pulsating halos.

### 2. High-Precision Viewport Engine
- **Dual-Canvas Rendering**: The image renders on a base layer (redrawn only on pan/zoom/filter), while crosshair and markers render on a cheap overlay layer — the 4K/8K source is never re-rasterized on mouse move.
- **Hardware-accelerated 2D Affine Transform**: Smoothly handles 4K/8K+ resolutions without memory strain.
- **Cursor-Centered Zoom**: Smooth zoom from `0.05x` to `40.0x`, plus **1:1 actual-pixel zoom** (`Z` key) for precise point placement.
- **Constant Screen-Size Markers**: Markers maintain consistent screen dimensions (e.g., 6px radius) regardless of zoom scale, avoiding visual obstruction at 20x–40x magnification.
- **Minimap Navigator**: Real-time overview with draggable viewport frustum, cached background (no per-frame rescaling of the full-res image), and **annotation coverage dots** so you can spot unannotated regions at a glance.
- **Hold to Hide (`H` Key)**: Temporarily hides point markers to inspect raw underlying image pixels (restores the previous visibility state on release).
- **Contrast & Brightness Controls**: Interactive sliders to inspect shadow and highlight details.

### 3. Dataset Explorer & Bulk Annotation Import
- **Dataset folders in the left sidebar**: every image is grouped by its dataset (derived from its source folder, or set explicitly at import). The top level lists dataset cards with progress bars, image counts, and total points; clicking a dataset drills into its image list (A / D navigation stays scoped to the active dataset).
- **`POST /api/datasets/import`** imports a whole benchmark folder with existing point annotations in one call (e.g. NWPU-Crowd layout `<root>/images` + `<root>/jsons`, where each JSON is `{"img_id": "0008.jpg", "human_num": N, "points": [[x, y], ...]}`):
  - Images whose JSON contains points are marked **`completed`** (annotation already done).
  - Images with empty points stay **`todo`** so they surface as labeling work.
  - The import is idempotent (points are replaced, not duplicated) and writes all per-image annotation JSON files.
  - Also available in the Import modal → **Option 2: Import Dataset Folder**.

### 4. Per-Workflow Status & Completed-Image Locking
- **Two independent statuses per image**:
  - `status` — point annotation progress (`todo` → `in_progress` → `completed`, set by the first point, the ✅ Finish button, or the status dropdown).
  - `qa_status` — question & answer progress. An image that carries at least one Q&A pair is **QA-`completed`** (auto-derived: adding the first Q&A completes it; deleting the last one reverts it to `todo`). Bulk imports backfill the same rule.
- **Completed images are read-only** (enforced server-side with `409` and reflected in the UI):
  - Point editing (add / move / delete / clear / undo / redo) is blocked while `status = completed`.
  - Q&A editing is blocked while `qa_status = completed` (point status never blocks QA work — QA is the next pipeline stage).
  - To edit, revert the respective status: the ✅ Finish button flips into **🔓 Unlock** (same for ✅ Finish QA / 🔓 Unlock QA), or pick another status in the dropdown. Selecting/inspecting existing points remains allowed on locked images.

### 5. Local-First & Zero-Latency Persistence
- Instant auto-save to local **SQLite** (`storage/hrvs_annotations.db`).
- **Live per-image annotation files**: every add / edit / delete rewrites the image's JSON file instantly under
  `storage/annotations/same_object/` or `storage/annotations/mixed_object/` (one file per image, atomic writes).
  The **✅ Finish** button marks the image completed and saves the final file; re-classifying an image moves its file between the two folders automatically.
- Automated JSON backup snapshots (`storage/auto_backups/`).
- Import whole folders by local path without network upload delays.
- **Server-generated cached thumbnails** (`storage/thumbnails/`) keep the image list fast even with hundreds of 4K/8K images.
- Standard HRVS JSON and CSV exports (CSV ships with a UTF-8 BOM so non-ASCII notes open correctly in Excel).
- Annotation files embed `image_file`, so copying them next to images and using **Import Folder** round-trips them back into the platform.

### 6. Dense-Image Rendering Guardrails (10k+ points)
- Overlay markers switch to a fast filled-square path when an image carries more than 2,000 points (selected / hovered / QA-target points keep their full highlight rings).
- The minimap's annotation coverage dots are pre-rendered into an offscreen cache layer — panning a 15,000-point crowd never re-plots them per frame.
- The right-panel points table is capped at 300 rows with a "… +N more" footer, keeping the DOM responsive on the densest NWPU images (up to 15,426 heads).

---

## 🚀 Quick Start

### 1. Requirements
- Python 3.10+
- Libraries: `fastapi`, `uvicorn`, `pillow`, `pydantic`, `python-multipart`

```bash
cd hrvs_annotation_platform
pip install -r requirements.txt
```

### 2. Launch Server
```bash
python run.py
```
Open [http://localhost:8000](http://localhost:8000) in your web browser.

Sample datasets (`same_object_crowd.jpg` 4000×3000 and `mixed_object_room.jpg` 3840×2160) are pre-generated and seeded automatically.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Description |
|---|---|
| `A` / `←` | Previous image (within the active dataset view) |
| `D` / `→` | Next image (within the active dataset view) |
| `F` or `R` | Fit image to screen (Reset zoom and center) |
| `Z` | Zoom to actual pixels (1:1) for precise placement |
| `Space` + Drag | Pan view across the image |
| Left Drag (empty area) | Pan view — hold and move; a click without movement still adds a point |
| Mouse Wheel | Cursor-centered Zoom (0.05x - 40x) |
| `P` | Switch to Add Point tool |
| `V` | Switch to Select / Move tool |
| `Left Click` | Add point or select point |
| Drag Point | Reposition selected point |
| `Delete` / `Backspace` | Delete selected point |
| Right Click on Point | Quick delete point |
| `H` (Hold) | Hide point markers to inspect image pixels |
| `Ctrl + Z` | Undo last point action |
| `Ctrl + Y` | Redo action |
| `1` - `9` | Select category from palette |
| `Esc` | Close dialogs / deselect point / cancel QA editor |
| `?` | Show keyboard shortcuts modal |

**Notes:** Point-editing shortcuts (tools, undo/redo, delete) are disabled while in QA mode, where the canvas is read-only. The Select tool never creates points — clicking empty space deselects instead. Undo/redo history is scoped per image and reset on image switch.

---

## 📁 Project Structure

```text
hrvs_annotation_platform/
├── README.md
├── requirements.txt                 # fastapi, uvicorn, pillow, pydantic, python-multipart
├── run.py                           # Server launcher at http://localhost:8000
├── storage/
│   ├── hrvs_annotations.db          # SQLite Database
│   ├── annotations/                 # Live per-image annotation JSON store
│   │   ├── same_object/             #   NWPU-Crowd density group
│   │   └── mixed_object/            #   Cluttered scene density group
│   ├── auto_backups/                # Automated JSON snapshots
│   ├── thumbnails/                  # Server-generated cached thumbnails
│   └── exports/                     # Exported JSON and CSV files
├── sample_data/                     # Pre-generated 4K/UHD test images and annotations
│   ├── generate_samples.py          # Generator script
│   ├── same_object_crowd.jpg        # 4000x3000 NWPU-Crowd simulation
│   └── mixed_object_room.jpg        # 3840x2160 Cluttered room scene
└── app/
    ├── __init__.py
    ├── main.py                      # FastAPI REST endpoints
    ├── annotation_store.py          # Live per-image JSON file sync (storage/annotations/)
    ├── database.py                  # Database connection, schemas, and indexing
    ├── schemas.py                   # Pydantic models & standard export builder
    └── static/
        ├── index.html               # Main Single-Page UI (assets auto cache-busted: server injects ?v=<newest mtime> so refreshes never run stale cached modules)
        ├── css/
        │   └── styles.css           # Modern dark UI and glassmorphism styling
        └── js/
            ├── app.js               # Main Coordinator & Global state
            ├── canvas_viewport.js   # 2D Canvas Viewport Engine with affine transforms
            ├── point_workflow.js    # Mode 1 logic: CRUD, drag & drop, undo/redo
            └── qa_workflow.js       # Mode 2 logic: QA editor & Ground-Truth point linker
```

---

## 📊 Standard HRVS JSON Export Format

Exports generated via `GET /api/export/json` adhere strictly to the HRVS specification:

```json
{
  "benchmark_name": "HRVS_Benchmark",
  "exported_at": "2026-10-21T07:00:00Z",
  "total_images": 2,
  "images": [
    {
      "image_id": "nwpu_0001",
      "file_name": "same_object_crowd.jpg",
      "file_path": "/path/to/sample_data/same_object_crowd.jpg",
      "dataset": "sample_data",
      "density_group": "same_object",
      "status": "completed",
      "qa_status": "todo",
      "original_resolution": {
        "width": 4000,
        "height": 3000
      },
      "point_count": 80,
      "points": [
        {
          "point_id": "pt_001",
          "x": 1844.0,
          "y": 1218.0,
          "x_norm": 0.461,
          "y_norm": 0.406,
          "category": "person_head",
          "attributes": {
            "color": "red_hat",
            "note": "Person with red hat"
          }
        }
      ],
      "qa_annotations": [
        {
          "qa_id": "qa_001",
          "task_type": "Visual Search",
          "question": "Where is the person wearing a red hat near the upper-left cluster?",
          "answer": "Located at upper-left dense cluster around coordinates (1420, 890).",
          "target_point_ids": ["pt_017", "pt_020"]
        }
      ]
    }
  ]
}
```
