import os
import glob
import json
import csv
import io
import sqlite3
from typing import List, Optional
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException, Depends, UploadFile, File, Form, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse, HTMLResponse
from PIL import Image
from contextlib import asynccontextmanager

from app.database import (
    BASE_DIR, DB_PATH, STORAGE_DIR, BACKUP_DIR, EXPORT_DIR, THUMB_DIR,
    get_db, init_db, scan_and_add_image, create_auto_backup, utc_now_iso
)
from app.schemas import (
    PointCreate, PointUpdate, PointOut,
    QAPairCreate, QAPairUpdate, QAPairOut,
    ImageUpdate, CategoryModel, ImportFolderRequest, DatasetImportRequest, build_export_data
)
from app.annotation_store import (
    ANNOTATIONS_DIR, sync_image_annotation_file,
    delete_image_annotation_file, sync_all_annotation_files
)

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    # Materialize per-image annotation JSON files for images not yet on disk
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        created = sync_all_annotation_files(conn, only_missing=True)
        if created > 0:
            print(f"Annotation file store: {created} per-image JSON file(s) ready in {ANNOTATIONS_DIR}")
    finally:
        conn.close()
    yield

app = FastAPI(
    title="High-Resolution Visual Search (HRVS) Annotation Platform",
    version="1.1.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/", response_class=HTMLResponse)
def get_index():
    index_file = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_file):
        with open(index_file, "r", encoding="utf-8") as f:
            html = f.read()
        # Cache-busting version for all frontend assets: derived from the
        # newest asset mtime, so every JS/CSS change rewrites the asset URLs
        # and browsers fetch fresh modules instead of reusing heuristic cache.
        try:
            newest = max(
                os.stat(os.path.join(STATIC_DIR, rel)).st_mtime_ns
                for rel in (
                    "css/styles.css",
                    "js/app.js",
                    "js/canvas_viewport.js",
                    "js/point_workflow.js",
                    "js/qa_workflow.js",
                )
            )
            html = html.replace("__APP_VERSION__", str(newest))
        except OSError:
            pass
        return html
    return "<h1>HRVS Annotation Platform</h1><p>Frontend static files not loaded yet.</p>"

# ----------------- Image Endpoints -----------------

@app.get("/api/images/serve/{image_id}")
def serve_image(image_id: str, conn: sqlite3.Connection = Depends(get_db)):
    cur = conn.cursor()
    cur.execute("SELECT file_path FROM images WHERE image_id = ?", (image_id,))
    row = cur.fetchone()
    if not row or not os.path.exists(row["file_path"]):
        raise HTTPException(status_code=404, detail="Image file not found")

    file_path = row["file_path"]
    ext = os.path.splitext(file_path)[1].lower()
    media_type = "image/jpeg"
    if ext == ".png":
        media_type = "image/png"
    elif ext == ".webp":
        media_type = "image/webp"

    return FileResponse(file_path, media_type=media_type, headers={"Cache-Control": "public, max-age=3600"})

@app.get("/api/images/{image_id}/thumbnail")
def get_image_thumbnail(
    image_id: str,
    size: int = Query(160, ge=48, le=512),
    conn: sqlite3.Connection = Depends(get_db)
):
    """Server-generated, cached thumbnail for fast image-list rendering
    (avoids pushing multi-MB 4K/8K originals into the sidebar for previews)."""
    cur = conn.cursor()
    cur.execute("SELECT file_path FROM images WHERE image_id = ?", (image_id,))
    row = cur.fetchone()
    if not row or not os.path.exists(row["file_path"]):
        raise HTTPException(status_code=404, detail="Image file not found")

    safe_id = "".join(c if c.isalnum() or c in ("_", "-") else "_" for c in image_id)
    thumb_path = os.path.join(THUMB_DIR, f"{safe_id}_{size}.jpg")
    if not os.path.exists(thumb_path):
        try:
            with Image.open(row["file_path"]) as im:
                im = im.convert("RGB")
                im.thumbnail((size, size))
                im.save(thumb_path, "JPEG", quality=80)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to generate thumbnail: {e}")

    return FileResponse(thumb_path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})

@app.get("/api/images")
def list_images(
    status: Optional[str] = None,
    qa_status: Optional[str] = None,
    density_group: Optional[str] = None,
    dataset: Optional[str] = None,
    search: Optional[str] = None,
    conn: sqlite3.Connection = Depends(get_db)
):
    cur = conn.cursor()
    # Correlated subqueries instead of LEFT JOINs: a join would explode into
    # points x qa rows per image (e.g. 10k points x 100 QA = 1M rows for one image).
    query = """
        SELECT
            i.image_id, i.file_name, i.file_path, i.dataset, i.density_group, i.status, i.qa_status,
            i.width, i.height, i.file_size, i.created_at, i.updated_at,
            (SELECT COUNT(*) FROM points p WHERE p.image_id = i.image_id) AS point_count,
            (SELECT COUNT(*) FROM qa_annotations q WHERE q.image_id = i.image_id) AS qa_count
        FROM images i
        WHERE 1=1
    """
    params = []
    if status and status != "all":
        query += " AND i.status = ?"
        params.append(status)
    if qa_status and qa_status != "all":
        query += " AND i.qa_status = ?"
        params.append(qa_status)
    if density_group and density_group != "all":
        query += " AND i.density_group = ?"
        params.append(density_group)
    if dataset and dataset != "all":
        query += " AND i.dataset = ?"
        params.append(dataset)
    if search:
        query += " AND (i.file_name LIKE ? OR i.image_id LIKE ?)"
        params.extend([f"%{search}%", f"%{search}%"])

    # Secondary sort by file_name keeps ordering stable when many images share
    # a created_at timestamp (bulk imports run within the same second).
    query += " ORDER BY i.created_at ASC, i.file_name ASC"
    cur.execute(query, params)
    rows = cur.fetchall()

    result = []
    for r in rows:
        result.append({
            "image_id": r["image_id"],
            "file_name": r["file_name"],
            "file_path": r["file_path"],
            "dataset": r["dataset"],
            "density_group": r["density_group"],
            "status": r["status"],
            "qa_status": r["qa_status"],
            "width": r["width"],
            "height": r["height"],
            "file_size": r["file_size"],
            "point_count": r["point_count"],
            "qa_count": r["qa_count"],
            "created_at": r["created_at"],
            "updated_at": r["updated_at"]
        })
    return {"total": len(result), "images": result}

@app.get("/api/images/{image_id}")
def get_image_details(image_id: str, conn: sqlite3.Connection = Depends(get_db)):
    cur = conn.cursor()
    cur.execute("SELECT * FROM images WHERE image_id = ?", (image_id,))
    img = cur.fetchone()
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")

    cur.execute("SELECT * FROM points WHERE image_id = ? ORDER BY point_id ASC", (image_id,))
    pt_rows = cur.fetchall()
    points = []
    for p in pt_rows:
        try:
            attrs = json.loads(p["attributes"]) if p["attributes"] else {}
        except Exception:
            attrs = {}
        points.append({
            "point_id": p["point_id"],
            "image_id": p["image_id"],
            "x": p["x"],
            "y": p["y"],
            "x_norm": p["x_norm"],
            "y_norm": p["y_norm"],
            "category": p["category"],
            "color": p["color"],
            "attributes": attrs,
            "created_at": p["created_at"],
            "updated_at": p["updated_at"]
        })

    cur.execute("SELECT * FROM qa_annotations WHERE image_id = ? ORDER BY qa_id ASC", (image_id,))
    qa_rows = cur.fetchall()
    qa_list = []
    for q in qa_rows:
        try:
            t_ids = json.loads(q["target_point_ids"]) if q["target_point_ids"] else []
        except Exception:
            t_ids = []
        qa_list.append({
            "qa_id": q["qa_id"],
            "image_id": q["image_id"],
            "task_type": q["task_type"],
            "question": q["question"],
            "answer": q["answer"],
            "target_point_ids": t_ids,
            "created_at": q["created_at"],
            "updated_at": q["updated_at"]
        })

    return {
        "image_id": img["image_id"],
        "file_name": img["file_name"],
        "file_path": img["file_path"],
        "dataset": img["dataset"],
        "density_group": img["density_group"],
        "status": img["status"],
        "qa_status": img["qa_status"],
        "width": img["width"],
        "height": img["height"],
        "file_size": img["file_size"],
        "point_count": len(points),
        "points": points,
        "qa_annotations": qa_list
    }

@app.patch("/api/images/{image_id}")
def update_image(image_id: str, payload: ImageUpdate, conn: sqlite3.Connection = Depends(get_db)):
    cur = conn.cursor()
    cur.execute("SELECT image_id FROM images WHERE image_id = ?", (image_id,))
    if not cur.fetchone():
        raise HTTPException(status_code=404, detail="Image not found")
    
    updates = []
    params = []
    if payload.status is not None:
        if payload.status not in ("todo", "in_progress", "completed"):
            raise HTTPException(status_code=400, detail="Invalid status")
        updates.append("status = ?")
        params.append(payload.status)
    if payload.qa_status is not None:
        if payload.qa_status not in ("todo", "in_progress", "completed"):
            raise HTTPException(status_code=400, detail="Invalid qa_status")
        updates.append("qa_status = ?")
        params.append(payload.qa_status)
    if payload.density_group is not None:
        if payload.density_group not in ("same_object", "mixed_object"):
            raise HTTPException(status_code=400, detail="Invalid density_group")
        updates.append("density_group = ?")
        params.append(payload.density_group)

    if updates:
        updates.append("updated_at = ?")
        params.append(utc_now_iso())
        params.append(image_id)
        cur.execute(f"UPDATE images SET {', '.join(updates)} WHERE image_id = ?", params)
        conn.commit()
        anno_path = sync_image_annotation_file(conn, image_id)

    return {
        "status": "ok",
        "image_id": image_id,
        "annotation_file": os.path.relpath(anno_path, BASE_DIR) if anno_path else None
    }

@app.delete("/api/images/{image_id}")
def delete_image(image_id: str, conn: sqlite3.Connection = Depends(get_db)):
    cur = conn.cursor()
    cur.execute("DELETE FROM images WHERE image_id = ?", (image_id,))
    conn.commit()
    delete_image_annotation_file(image_id)
    return {"status": "ok", "deleted_image_id": image_id}

# ----------------- Dataset Endpoints -----------------

@app.get("/api/datasets")
def list_datasets(conn: sqlite3.Connection = Depends(get_db)):
    """Dataset folder summary for the sidebar: image counts, progress and
    point totals per dataset (point counts are aggregated in Python from a
    per-image index scan — much cheaper than a points x images JOIN)."""
    cur = conn.cursor()
    cur.execute("""
        SELECT dataset,
               COUNT(*) AS image_count,
               SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
               SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
               SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) AS todo_count,
               SUM(CASE WHEN qa_status = 'completed' THEN 1 ELSE 0 END) AS qa_completed_count,
               SUM(CASE WHEN density_group = 'same_object' THEN 1 ELSE 0 END) AS same_object_count,
               SUM(CASE WHEN density_group = 'mixed_object' THEN 1 ELSE 0 END) AS mixed_object_count
        FROM images
        GROUP BY dataset
        ORDER BY image_count DESC, dataset ASC
    """)
    datasets = {r["dataset"]: {
        "dataset": r["dataset"],
        "image_count": r["image_count"],
        "completed_count": r["completed_count"],
        "in_progress_count": r["in_progress_count"],
        "todo_count": r["todo_count"],
        "qa_completed_count": r["qa_completed_count"],
        "same_object_count": r["same_object_count"],
        "mixed_object_count": r["mixed_object_count"],
        "point_count": 0
    } for r in cur.fetchall()}

    cur.execute("SELECT image_id, dataset FROM images")
    image_dataset = {r["image_id"]: r["dataset"] for r in cur.fetchall()}
    cur.execute("SELECT image_id, COUNT(*) AS c FROM points GROUP BY image_id")
    for image_id, c in cur.fetchall():
        ds = image_dataset.get(image_id)
        if ds and ds in datasets:
            datasets[ds]["point_count"] += c

    return {"total": len(datasets), "datasets": list(datasets.values())}

@app.post("/api/datasets/import")
def import_dataset(payload: DatasetImportRequest, conn: sqlite3.Connection = Depends(get_db)):
    """Import a dataset folder together with existing point annotations
    (NWPU-Crowd layout: <root>/images + <root>/jsons).

    Every image with at least one annotated point is marked `completed`
    (annotation already done); images whose JSON has an empty points list
    are left `todo` so they surface as work that still needs labeling.
    Re-running the import is idempotent: points are replaced, not duplicated.
    """
    root = os.path.abspath(payload.root_path)
    if not os.path.isdir(root):
        raise HTTPException(status_code=400, detail=f"Dataset folder does not exist: {payload.root_path}")
    if payload.density_group not in ("same_object", "mixed_object"):
        raise HTTPException(status_code=400, detail="density_group must be 'same_object' or 'mixed_object'")

    dataset_name = (payload.dataset_name or "").strip() or os.path.basename(root.rstrip("/")) or "Default"
    json_dir = os.path.abspath(payload.annotations_dir) if payload.annotations_dir else os.path.join(root, "jsons")

    # Index annotation JSONs by image stem. Both the file name (0008.json)
    # and the embedded img_id ("0008.jpg") are accepted as match keys.
    ann_by_stem = {}
    if os.path.isdir(json_dir):
        for jf in sorted(glob.glob(os.path.join(json_dir, "*.json"))):
            try:
                with open(jf, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except Exception:
                continue
            stem = os.path.splitext(os.path.basename(jf))[0]
            img_ref = data.get("img_id") or data.get("image_file") or ""
            if img_ref:
                ref_stem = os.path.splitext(os.path.basename(str(img_ref)))[0]
                ann_by_stem[ref_stem] = data
            ann_by_stem.setdefault(stem, data)

    # Category color: prefer the configured category palette entry
    cur = conn.cursor()
    point_color = payload.color
    cur.execute("SELECT color FROM categories WHERE name = ? AND density_group = ?", (payload.category, payload.density_group))
    cat_row = cur.fetchone()
    if cat_row:
        point_color = cat_row["color"]

    valid_exts = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"}
    image_files = []
    for dirpath, dirnames, files in os.walk(root):
        # Never treat annotation JSONs as images / walk into them
        dirnames[:] = [d for d in dirnames if os.path.join(dirpath, d) != json_dir]
        for f in sorted(files):
            if os.path.splitext(f)[1].lower() in valid_exts:
                image_files.append(os.path.join(dirpath, f))
    image_files.sort(key=lambda p: os.path.splitext(os.path.basename(p))[0])

    stats = {
        "dataset": dataset_name,
        "total_images": 0,
        "with_annotations": 0,
        "without_annotations": 0,
        "total_points": 0,
        "annotation_files_written": 0,
        "skipped": 0
    }
    now = utc_now_iso()

    for idx, file_path in enumerate(image_files, 1):
        # Fast path: the image is already registered (bulk re-import) — reuse
        # its stored dimensions instead of re-decoding a multi-MB UHD file.
        cur.execute("SELECT image_id, width, height FROM images WHERE file_path = ?", (file_path,))
        existing = cur.fetchone()
        if existing:
            image_id, width, height = existing["image_id"], existing["width"], existing["height"]
            cur.execute("""
                UPDATE images SET dataset = ?, density_group = ?, updated_at = ?
                WHERE image_id = ?
            """, (dataset_name, payload.density_group, now, image_id))
        else:
            info = scan_and_add_image(file_path, density_group=payload.density_group, dataset=dataset_name)
            if not info:
                stats["skipped"] += 1
                continue
            image_id, width, height = info["image_id"], info["width"], info["height"]

        stem = os.path.splitext(os.path.basename(file_path))[0]
        ann = ann_by_stem.get(stem) or {}
        raw_points = ann.get("points") or []

        # Dataset import is authoritative: replace any previous points
        cur.execute("DELETE FROM points WHERE image_id = ?", (image_id,))

        rows = []
        for i, pt in enumerate(raw_points):
            try:
                x, y = float(pt[0]), float(pt[1])
            except (TypeError, ValueError, IndexError):
                continue
            rows.append((
                f"{image_id}_pt_{i + 1:05d}",  # globally unique + idempotent re-import
                image_id, x, y,
                round(x / width, 6) if width else 0.0,
                round(y / height, 6) if height else 0.0,
                payload.category, point_color, "{}", now, now
            ))
        if rows:
            cur.executemany("""
                INSERT INTO points (point_id, image_id, x, y, x_norm, y_norm, category, color, attributes, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, rows)

        # Status rule: annotated -> completed, empty -> todo (needs labeling)
        status = "completed" if rows else "todo"
        cur.execute("UPDATE images SET status = ?, updated_at = ? WHERE image_id = ?", (status, now, image_id))

        stats["total_images"] += 1
        stats["total_points"] += len(rows)
        if rows:
            stats["with_annotations"] += 1
        else:
            stats["without_annotations"] += 1

        conn.commit()
        if sync_image_annotation_file(conn, image_id):
            stats["annotation_files_written"] += 1

        if idx % 100 == 0:
            print(f"[dataset-import] {dataset_name}: {idx}/{len(image_files)} images processed...")

    return {"status": "ok", **stats}

# ----------------- Import Endpoints -----------------

@app.post("/api/images/import-folder")
def import_folder(payload: ImportFolderRequest, conn: sqlite3.Connection = Depends(get_db)):
    folder = os.path.abspath(payload.folder_path)
    if not os.path.isdir(folder):
        raise HTTPException(status_code=400, detail=f"Folder does not exist: {payload.folder_path}")

    valid_exts = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"}
    imported = []
    skipped = []

    for root, _, files in os.walk(folder):
        for f in sorted(files):
            ext = os.path.splitext(f)[1].lower()
            if ext in valid_exts:
                file_path = os.path.join(root, f)
                info = scan_and_add_image(
                    file_path,
                    density_group=payload.density_group,
                    dataset=payload.dataset_name
                )
                if info:
                    imported.append(info)
                else:
                    skipped.append(file_path)

    # Check companion annotations in folder
    companion_jsons = glob.glob(os.path.join(folder, "*annotation*.json")) + glob.glob(os.path.join(folder, "*.json"))
    auto_loaded_annotations = 0
    for cj in companion_jsons:
        try:
            with open(cj, "r", encoding="utf-8") as f:
                data = json.load(f)
                # If format has image_file or images
                if "points" in data and "image_file" in data:
                    target_name = data["image_file"]
                    cur = conn.cursor()
                    cur.execute("SELECT image_id FROM images WHERE file_name = ?", (target_name,))
                    matched = cur.fetchone()
                    if matched:
                        load_annotation_data(matched["image_id"], data, conn)
                        auto_loaded_annotations += 1
        except Exception:
            pass

    return {
        "status": "ok",
        "imported_count": len(imported),
        "skipped_count": len(skipped),
        "auto_loaded_annotations": auto_loaded_annotations,
        "sample": imported[:5]
    }

@app.post("/api/images/upload")
async def upload_images(
    files: List[UploadFile] = File(...),
    density_group: str = Form("same_object"),
    dataset: Optional[str] = Form(None),
    conn: sqlite3.Connection = Depends(get_db)
):
    upload_dir = os.path.join(STORAGE_DIR, "uploaded_images")
    os.makedirs(upload_dir, exist_ok=True)

    imported = []
    for file in files:
        ext = os.path.splitext(file.filename)[1].lower()
        if ext not in {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"}:
            continue
        save_path = os.path.join(upload_dir, file.filename)
        content = await file.read()
        with open(save_path, "wb") as f:
            f.write(content)

        info = scan_and_add_image(save_path, density_group=density_group, dataset=dataset)
        if info:
            imported.append(info)

    return {"status": "ok", "uploaded_count": len(imported), "images": imported}

def load_annotation_data(image_id: str, data: dict, conn: sqlite3.Connection):
    """Loads points and QA from a standard dictionary into the database"""
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT width, height FROM images WHERE image_id = ?", (image_id,))
    img = cur.fetchone()
    if not img:
        return
    width, height = img["width"], img["height"]
    now = utc_now_iso()

    # Load points
    points = data.get("points", [])
    for p in points:
        pt_id = p.get("point_id") or f"pt_{datetime.now().timestamp()}_{p.get('x', 0)}"
        x = float(p.get("x", 0))
        y = float(p.get("y", 0))
        x_norm = float(p.get("x_norm", x / width if width else 0))
        y_norm = float(p.get("y_norm", y / height if height else 0))
        cat = p.get("category", "person_head")
        color = p.get("color", "#EF4444")
        attrs = json.dumps(p.get("attributes", {}))

        cur.execute("""
            INSERT OR REPLACE INTO points (point_id, image_id, x, y, x_norm, y_norm, category, color, attributes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (pt_id, image_id, x, y, x_norm, y_norm, cat, color, attrs, now, now))

    # Load QA pairs
    qa_list = data.get("qa_annotations", [])
    for q in qa_list:
        qa_id = q.get("qa_id") or f"qa_{datetime.now().timestamp()}"
        task_type = q.get("task_type", "Visual Search")
        question = q.get("question", "")
        answer = q.get("answer", "")
        target_ids = json.dumps(q.get("target_point_ids", []))

        cur.execute("""
            INSERT OR REPLACE INTO qa_annotations (qa_id, image_id, task_type, question, answer, target_point_ids, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (qa_id, image_id, task_type, question, answer, target_ids, now, now))

    # Imported question & answer pairs mark the image QA-completed
    if qa_list:
        cur.execute("UPDATE images SET qa_status = 'completed' WHERE image_id = ? AND qa_status = 'todo'", (image_id,))

    conn.commit()
    sync_image_annotation_file(conn, image_id)

@app.post("/api/images/{image_id}/import-annotations")
async def import_annotations(image_id: str, file: UploadFile = File(...), conn: sqlite3.Connection = Depends(get_db)):
    cur = conn.cursor()
    cur.execute("SELECT width, height FROM images WHERE image_id = ?", (image_id,))
    if not cur.fetchone():
        raise HTTPException(status_code=404, detail="Image not found")

    content = await file.read()
    try:
        data = json.loads(content.decode("utf-8"))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {str(e)}")

    load_annotation_data(image_id, data, conn)
    return {"status": "ok", "message": "Annotations imported successfully"}

# ----------------- Point CRUD Endpoints -----------------

@app.post("/api/images/{image_id}/points")
def add_point(image_id: str, payload: PointCreate, conn: sqlite3.Connection = Depends(get_db)):
    cur = conn.cursor()
    cur.execute("SELECT width, height, status FROM images WHERE image_id = ?", (image_id,))
    img = cur.fetchone()
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")

    # Completed images are read-only: revert the status to edit points
    if img["status"] == "completed":
        raise HTTPException(status_code=409, detail="Image is completed (locked). Set status to todo / in_progress to edit its points.")

    width, height = img["width"], img["height"]
    now = utc_now_iso()

    # Determine point_id
    if payload.point_id:
        pt_id = payload.point_id
    else:
        cur.execute("SELECT COUNT(*) FROM points WHERE image_id = ?", (image_id,))
        count = cur.fetchone()[0] + 1
        pt_id = f"pt_{count:03d}"
        # Ensure uniqueness
        cur.execute("SELECT 1 FROM points WHERE point_id = ?", (pt_id,))
        while cur.fetchone():
            count += 1
            pt_id = f"pt_{count:03d}"
            cur.execute("SELECT 1 FROM points WHERE point_id = ?", (pt_id,))

    x_norm = round(payload.x / width, 6) if width > 0 else 0.0
    y_norm = round(payload.y / height, 6) if height > 0 else 0.0
    attrs_json = json.dumps(payload.attributes or {})

    # If image status is 'todo', switch to 'in_progress'
    if img["status"] == "todo":
        cur.execute("UPDATE images SET status = 'in_progress', updated_at = ? WHERE image_id = ?", (now, image_id))

    cur.execute("""
        INSERT INTO points (point_id, image_id, x, y, x_norm, y_norm, category, color, attributes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (pt_id, image_id, payload.x, payload.y, x_norm, y_norm, payload.category, payload.color or "#EF4444", attrs_json, now, now))
    conn.commit()
    sync_image_annotation_file(conn, image_id)

    return {
        "point_id": pt_id,
        "image_id": image_id,
        "x": payload.x,
        "y": payload.y,
        "x_norm": x_norm,
        "y_norm": y_norm,
        "category": payload.category,
        "color": payload.color or "#EF4444",
        "attributes": payload.attributes or {},
        "created_at": now,
        "updated_at": now
    }

@app.post("/api/images/{image_id}/points/batch")
def add_points_batch(image_id: str, points: List[PointCreate], conn: sqlite3.Connection = Depends(get_db)):
    cur = conn.cursor()
    cur.execute("SELECT width, height, status FROM images WHERE image_id = ?", (image_id,))
    img = cur.fetchone()
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
    if img["status"] == "completed":
        raise HTTPException(status_code=409, detail="Image is completed (locked). Set status to todo / in_progress to edit its points.")
    width, height = img["width"], img["height"]
    now = utc_now_iso()

    cur.execute("SELECT COUNT(*) FROM points WHERE image_id = ?", (image_id,))
    next_num = cur.fetchone()[0] + 1

    # Track all IDs (existing + newly assigned) so batch inserts can never
    # silently REPLACE an existing point via a colliding generated id.
    existing_ids = set()
    cur.execute("SELECT point_id FROM points WHERE image_id = ?", (image_id,))
    for r in cur.fetchall():
        existing_ids.add(r[0])

    added = []
    for p in points:
        pt_id = p.point_id or f"pt_{next_num:03d}"
        while pt_id in existing_ids:
            next_num += 1
            pt_id = f"pt_{next_num:03d}"
        next_num += 1
        existing_ids.add(pt_id)

        x_norm = round(p.x / width, 6) if width else 0.0
        y_norm = round(p.y / height, 6) if height else 0.0
        attrs_json = json.dumps(p.attributes or {})

        cur.execute("""
            INSERT INTO points (point_id, image_id, x, y, x_norm, y_norm, category, color, attributes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (pt_id, image_id, p.x, p.y, x_norm, y_norm, p.category, p.color or "#EF4444", attrs_json, now, now))
        added.append(pt_id)

    conn.commit()
    sync_image_annotation_file(conn, image_id)
    return {"status": "ok", "added_count": len(added), "point_ids": added}

@app.patch("/api/points/{point_id}")
def update_point(point_id: str, payload: PointUpdate, conn: sqlite3.Connection = Depends(get_db)):
    cur = conn.cursor()
    cur.execute("SELECT p.*, i.width, i.height, i.status AS image_status FROM points p JOIN images i ON p.image_id = i.image_id WHERE p.point_id = ?", (point_id,))
    pt = cur.fetchone()
    if not pt:
        raise HTTPException(status_code=404, detail="Point not found")
    if pt["image_status"] == "completed":
        raise HTTPException(status_code=409, detail="Image is completed (locked). Set status to todo / in_progress to edit its points.")

    width, height = pt["width"], pt["height"]
    now = utc_now_iso()

    updates = []
    params = []

    new_x = payload.x if payload.x is not None else pt["x"]
    new_y = payload.y if payload.y is not None else pt["y"]

    if payload.x is not None or payload.y is not None:
        updates.extend(["x = ?", "y = ?", "x_norm = ?", "y_norm = ?"])
        x_norm = round(new_x / width, 6) if width else 0.0
        y_norm = round(new_y / height, 6) if height else 0.0
        params.extend([new_x, new_y, x_norm, y_norm])

    if payload.category is not None:
        updates.append("category = ?")
        params.append(payload.category)
    if payload.color is not None:
        updates.append("color = ?")
        params.append(payload.color)
    if payload.attributes is not None:
        updates.append("attributes = ?")
        params.append(json.dumps(payload.attributes))

    if updates:
        updates.append("updated_at = ?")
        params.append(now)
        params.append(point_id)
        cur.execute(f"UPDATE points SET {', '.join(updates)} WHERE point_id = ?", params)
        conn.commit()
        sync_image_annotation_file(conn, pt["image_id"])

    return {"status": "ok", "point_id": point_id}

@app.delete("/api/points/{point_id}")
def delete_point(point_id: str, conn: sqlite3.Connection = Depends(get_db)):
    cur = conn.cursor()
    cur.execute("""
        SELECT p.image_id, i.status AS image_status
        FROM points p JOIN images i ON p.image_id = i.image_id
        WHERE p.point_id = ?
    """, (point_id,))
    pt = cur.fetchone()
    if not pt:
        raise HTTPException(status_code=404, detail="Point not found")
    if pt["image_status"] == "completed":
        raise HTTPException(status_code=409, detail="Image is completed (locked). Set status to todo / in_progress to edit its points.")

    image_id = pt["image_id"]
    cur.execute("DELETE FROM points WHERE point_id = ?", (point_id,))

    # Also clean up from QA target_point_ids
    cur.execute("SELECT qa_id, target_point_ids FROM qa_annotations WHERE image_id = ?", (image_id,))
    qas = cur.fetchall()
    for q in qas:
        try:
            ids = json.loads(q["target_point_ids"])
            if point_id in ids:
                ids.remove(point_id)
                cur.execute("UPDATE qa_annotations SET target_point_ids = ? WHERE qa_id = ?", (json.dumps(ids), q["qa_id"]))
        except Exception:
            pass

    conn.commit()
    sync_image_annotation_file(conn, image_id)
    return {"status": "ok", "deleted_point_id": point_id}

@app.delete("/api/images/{image_id}/points")
def clear_image_points(image_id: str, conn: sqlite3.Connection = Depends(get_db)):
    cur = conn.cursor()
    cur.execute("SELECT status FROM images WHERE image_id = ?", (image_id,))
    img = cur.fetchone()
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
    if img["status"] == "completed":
        raise HTTPException(status_code=409, detail="Image is completed (locked). Set status to todo / in_progress to edit its points.")
    cur.execute("DELETE FROM points WHERE image_id = ?", (image_id,))
    cur.execute("UPDATE qa_annotations SET target_point_ids = '[]' WHERE image_id = ?", (image_id,))
    conn.commit()
    sync_image_annotation_file(conn, image_id)
    return {"status": "ok", "cleared_image_id": image_id}

# ----------------- QA CRUD Endpoints -----------------

@app.post("/api/images/{image_id}/qa")
def add_qa_pair(image_id: str, payload: QAPairCreate, conn: sqlite3.Connection = Depends(get_db)):
    cur = conn.cursor()
    cur.execute("SELECT qa_status FROM images WHERE image_id = ?", (image_id,))
    img = cur.fetchone()
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")

    # QA-completed images are read-only: revert qa_status to edit Q&A pairs
    if img["qa_status"] == "completed":
        raise HTTPException(status_code=409, detail="Image QA is completed (locked). Set QA status to todo / in_progress to edit Q&A pairs.")

    now = utc_now_iso()
    if payload.qa_id:
        qa_id = payload.qa_id
    else:
        cur.execute("SELECT COUNT(*) FROM qa_annotations WHERE image_id = ?", (image_id,))
        count = cur.fetchone()[0] + 1
        qa_id = f"qa_{count:03d}"
        cur.execute("SELECT 1 FROM qa_annotations WHERE qa_id = ?", (qa_id,))
        if cur.fetchone():
            qa_id = f"qa_{int(datetime.now().timestamp() * 1000) % 1000000:06d}"

    t_ids_json = json.dumps(payload.target_point_ids)

    cur.execute("""
        INSERT INTO qa_annotations (qa_id, image_id, task_type, question, answer, target_point_ids, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (qa_id, image_id, payload.task_type, payload.question, payload.answer, t_ids_json, now, now))

    # Auto-derive: an image that now carries a question & answer becomes QA-completed
    qa_status = img["qa_status"]
    if qa_status == "todo":
        qa_status = "completed"
        cur.execute("UPDATE images SET qa_status = ?, updated_at = ? WHERE image_id = ?", (qa_status, now, image_id))

    conn.commit()
    sync_image_annotation_file(conn, image_id)

    return {
        "qa_id": qa_id,
        "image_id": image_id,
        "task_type": payload.task_type,
        "question": payload.question,
        "answer": payload.answer,
        "target_point_ids": payload.target_point_ids,
        "qa_status": qa_status,
        "created_at": now,
        "updated_at": now
    }

@app.patch("/api/qa/{qa_id}")
def update_qa_pair(qa_id: str, payload: QAPairUpdate, conn: sqlite3.Connection = Depends(get_db)):
    cur = conn.cursor()
    cur.execute("""
        SELECT q.image_id, i.qa_status
        FROM qa_annotations q JOIN images i ON q.image_id = i.image_id
        WHERE q.qa_id = ?
    """, (qa_id,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="QA Pair not found")
    image_id = row["image_id"]
    if row["qa_status"] == "completed":
        raise HTTPException(status_code=409, detail="Image QA is completed (locked). Set QA status to todo / in_progress to edit Q&A pairs.")

    now = utc_now_iso()
    updates = []
    params = []

    if payload.task_type is not None:
        updates.append("task_type = ?")
        params.append(payload.task_type)
    if payload.question is not None:
        updates.append("question = ?")
        params.append(payload.question)
    if payload.answer is not None:
        updates.append("answer = ?")
        params.append(payload.answer)
    if payload.target_point_ids is not None:
        updates.append("target_point_ids = ?")
        params.append(json.dumps(payload.target_point_ids))

    if updates:
        updates.append("updated_at = ?")
        params.append(now)
        params.append(qa_id)
        cur.execute(f"UPDATE qa_annotations SET {', '.join(updates)} WHERE qa_id = ?", params)
        conn.commit()
        sync_image_annotation_file(conn, image_id)

    return {"status": "ok", "qa_id": qa_id}

@app.delete("/api/qa/{qa_id}")
def delete_qa_pair(qa_id: str, conn: sqlite3.Connection = Depends(get_db)):
    cur = conn.cursor()
    cur.execute("""
        SELECT q.image_id, i.qa_status
        FROM qa_annotations q JOIN images i ON q.image_id = i.image_id
        WHERE q.qa_id = ?
    """, (qa_id,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="QA Pair not found")
    image_id = row["image_id"]
    if row["qa_status"] == "completed":
        raise HTTPException(status_code=409, detail="Image QA is completed (locked). Set QA status to todo / in_progress to edit Q&A pairs.")

    cur.execute("DELETE FROM qa_annotations WHERE qa_id = ?", (qa_id,))

    # Auto-derive: no question & answer left -> QA reverts to todo
    qa_status = row["qa_status"]
    cur.execute("SELECT COUNT(*) FROM qa_annotations WHERE image_id = ?", (image_id,))
    if cur.fetchone()[0] == 0:
        qa_status = "todo"
        cur.execute("UPDATE images SET qa_status = ?, updated_at = ? WHERE image_id = ?",
                    (qa_status, utc_now_iso(), image_id))

    conn.commit()
    sync_image_annotation_file(conn, row["image_id"])
    return {"status": "ok", "deleted_qa_id": qa_id, "qa_status": qa_status}

# ----------------- Categories Endpoints -----------------

@app.get("/api/categories")
def get_categories(conn: sqlite3.Connection = Depends(get_db)):
    cur = conn.cursor()
    cur.execute("SELECT * FROM categories ORDER BY id ASC")
    rows = cur.fetchall()
    return [dict(r) for r in rows]

@app.post("/api/categories")
def add_category(payload: CategoryModel, conn: sqlite3.Connection = Depends(get_db)):
    cur = conn.cursor()
    cur.execute("SELECT 1 FROM categories WHERE name = ?", (payload.name,))
    if cur.fetchone():
        raise HTTPException(status_code=400, detail="Category already exists")
    
    cur.execute("""
        INSERT INTO categories (name, color, density_group, shortcut_key)
        VALUES (?, ?, ?, ?)
    """, (payload.name, payload.color, payload.density_group, payload.shortcut_key))
    conn.commit()
    return {"status": "ok", "name": payload.name}

# ----------------- Annotation File Store Endpoints -----------------

@app.post("/api/annotations/sync-all")
def force_sync_annotation_files(conn: sqlite3.Connection = Depends(get_db)):
    """Force-rewrite every per-image annotation JSON file from the database."""
    written = sync_all_annotation_files(conn, only_missing=False)
    return {
        "status": "ok",
        "files_written": written,
        "annotations_dir": os.path.relpath(ANNOTATIONS_DIR, BASE_DIR)
    }

# ----------------- Stats & Backup & Export Endpoints -----------------

@app.get("/api/stats")
def get_stats(conn: sqlite3.Connection = Depends(get_db)):
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM images")
    total_images = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM images WHERE status = 'completed'")
    completed_images = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM images WHERE qa_status = 'completed'")
    qa_completed_images = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM points")
    total_points = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM qa_annotations")
    total_qa = cur.fetchone()[0]

    cur.execute("SELECT density_group, COUNT(*) as c FROM images GROUP BY density_group")
    group_counts = {r["density_group"]: r["c"] for r in cur.fetchall()}

    return {
        "total_images": total_images,
        "completed_images": completed_images,
        "qa_completed_images": qa_completed_images,
        "in_progress_images": total_images - completed_images,
        "total_points": total_points,
        "total_qa": total_qa,
        "groups": group_counts
    }

@app.post("/api/backup")
def trigger_backup():
    try:
        backup_file = create_auto_backup()
        return {"status": "ok", "backup_file": backup_file, "filename": os.path.basename(backup_file)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/export/json")
def export_dataset_json(conn: sqlite3.Connection = Depends(get_db)):
    data = build_export_data(conn)
    filename = f"hrvs_benchmark_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    save_path = os.path.join(EXPORT_DIR, filename)
    with open(save_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    return JSONResponse(
        content=data,
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )

@app.get("/api/export/image/{image_id}")
def export_single_image_json(image_id: str, conn: sqlite3.Connection = Depends(get_db)):
    data = build_export_data(conn, image_id=image_id)
    if not data["images"]:
        raise HTTPException(status_code=404, detail="Image not found")
    
    filename = f"{image_id}_hrvs_export.json"
    return JSONResponse(
        content=data,
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )

@app.get("/api/export/csv")
def export_dataset_csv(conn: sqlite3.Connection = Depends(get_db)):
    cur = conn.cursor()
    cur.execute("""
        SELECT
            i.image_id, i.file_name, i.dataset, i.density_group, i.status, i.width, i.height,
            p.point_id, p.x, p.y, p.x_norm, p.y_norm, p.category, p.color, p.attributes,
            p.created_at as point_created_at
        FROM images i
        JOIN points p ON i.image_id = p.image_id
        ORDER BY i.image_id, p.point_id
    """)
    rows = cur.fetchall()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "image_id", "file_name", "dataset", "density_group", "status", "original_width", "original_height",
        "point_id", "x", "y", "x_norm", "y_norm", "category", "color", "attributes_json", "created_at"
    ])
    for r in rows:
        writer.writerow([
            r["image_id"], r["file_name"], r["dataset"], r["density_group"], r["status"], r["width"], r["height"],
            r["point_id"], r["x"], r["y"], r["x_norm"], r["y_norm"], r["category"], r["color"],
            r["attributes"], r["point_created_at"]
        ])

    csv_data = output.getvalue()
    filename = f"hrvs_points_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    save_path = os.path.join(EXPORT_DIR, filename)
    with open(save_path, "w", encoding="utf-8-sig") as f:
        f.write(csv_data)

    # UTF-8 BOM so Excel opens non-ASCII notes (Vietnamese, symbols) correctly
    return StreamingResponse(
        io.BytesIO(("﻿" + csv_data).encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )
