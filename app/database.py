import os
import sqlite3
import json
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional
from PIL import Image

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORAGE_DIR = os.path.join(BASE_DIR, "storage")
DB_PATH = os.path.join(STORAGE_DIR, "hrvs_annotations.db")
BACKUP_DIR = os.path.join(STORAGE_DIR, "auto_backups")
EXPORT_DIR = os.path.join(STORAGE_DIR, "exports")
THUMB_DIR = os.path.join(STORAGE_DIR, "thumbnails")

os.makedirs(STORAGE_DIR, exist_ok=True)
os.makedirs(BACKUP_DIR, exist_ok=True)
os.makedirs(EXPORT_DIR, exist_ok=True)
os.makedirs(THUMB_DIR, exist_ok=True)

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    cur = conn.cursor()

    # Images table
    cur.execute("""
    CREATE TABLE IF NOT EXISTS images (
        image_id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        dataset TEXT NOT NULL DEFAULT 'Default',
        density_group TEXT NOT NULL CHECK(density_group IN ('same_object', 'mixed_object')),
        status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress', 'completed')),
        bbox_status TEXT NOT NULL DEFAULT 'todo' CHECK(bbox_status IN ('todo', 'in_progress', 'completed')),
        qa_status TEXT NOT NULL DEFAULT 'todo' CHECK(qa_status IN ('todo', 'in_progress', 'completed')),
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        file_size INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
    """)

    # Migration: existing databases gain the dataset column, backfilled from
    # the parent folder of each image file (e.g. .../NWPU-Crowd-HRVS-500/images/0008.jpg
    # -> dataset "NWPU-Crowd-HRVS-500").
    cur.execute("PRAGMA table_info(images)")
    existing_cols = {row[1] for row in cur.fetchall()}
    if "dataset" not in existing_cols:
        cur.execute("ALTER TABLE images ADD COLUMN dataset TEXT NOT NULL DEFAULT 'Default'")
        cur.execute("SELECT image_id, file_path FROM images")
        for img_id, fpath in cur.fetchall():
            folder = os.path.basename(os.path.dirname(os.path.abspath(fpath)))
            cur.execute("UPDATE images SET dataset = ? WHERE image_id = ?", (folder or "Default", img_id))

    # Migration: QA status column. An image that already carries question &
    # answer pairs starts out QA-completed; everything else stays todo.
    if "qa_status" not in existing_cols:
        cur.execute("ALTER TABLE images ADD COLUMN qa_status TEXT NOT NULL DEFAULT 'todo'")
        cur.execute("""
            UPDATE images SET qa_status = 'completed'
            WHERE image_id IN (SELECT DISTINCT image_id FROM qa_annotations)
        """)

    # Migration: BBox status column.
    if "bbox_status" not in existing_cols:
        cur.execute("ALTER TABLE images ADD COLUMN bbox_status TEXT NOT NULL DEFAULT 'todo'")

    # Points table
    cur.execute("""
    CREATE TABLE IF NOT EXISTS points (
        point_id TEXT PRIMARY KEY,
        image_id TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        x_norm REAL NOT NULL,
        y_norm REAL NOT NULL,
        category TEXT NOT NULL,
        color TEXT DEFAULT '#EF4444',
        attributes TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (image_id) REFERENCES images(image_id) ON DELETE CASCADE
    )
    """)

    # Bounding Boxes table
    cur.execute("""
    CREATE TABLE IF NOT EXISTS bboxes (
        bbox_id TEXT PRIMARY KEY,
        image_id TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        width REAL NOT NULL,
        height REAL NOT NULL,
        x_norm REAL NOT NULL,
        y_norm REAL NOT NULL,
        width_norm REAL NOT NULL,
        height_norm REAL NOT NULL,
        category TEXT NOT NULL,
        color TEXT DEFAULT '#EF4444',
        attributes TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (image_id) REFERENCES images(image_id) ON DELETE CASCADE
    )
    """)

    # QA Annotations table
    cur.execute("""
    CREATE TABLE IF NOT EXISTS qa_annotations (
        qa_id TEXT PRIMARY KEY,
        image_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        target_point_ids TEXT DEFAULT '[]',
        target_bbox_ids TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (image_id) REFERENCES images(image_id) ON DELETE CASCADE
    )
    """)

    cur.execute("PRAGMA table_info(qa_annotations)")
    qa_cols = {row[1] for row in cur.fetchall()}
    if "target_bbox_ids" not in qa_cols:
        cur.execute("ALTER TABLE qa_annotations ADD COLUMN target_bbox_ids TEXT DEFAULT '[]'")
    if "density_category" not in qa_cols:
        cur.execute("ALTER TABLE qa_annotations ADD COLUMN density_category TEXT DEFAULT 'people'")
    if "question_id" not in qa_cols:
        cur.execute("ALTER TABLE qa_annotations ADD COLUMN question_id TEXT")
        cur.execute("UPDATE qa_annotations SET question_id = qa_id WHERE question_id IS NULL")
    if "question_type" not in qa_cols:
        cur.execute("ALTER TABLE qa_annotations ADD COLUMN question_type TEXT DEFAULT 'Attribute'")
        cur.execute("UPDATE qa_annotations SET question_type = 'Attribute' WHERE question_type IS NULL")
    if "target_group" not in qa_cols:
        cur.execute("ALTER TABLE qa_annotations ADD COLUMN target_group TEXT DEFAULT 'Same-density'")
        cur.execute("UPDATE qa_annotations SET target_group = 'Same-density' WHERE target_group IS NULL")
    if "target_bbox" not in qa_cols:
        cur.execute("ALTER TABLE qa_annotations ADD COLUMN target_bbox TEXT DEFAULT '{}'")
    if "reference_bboxes" not in qa_cols:
        cur.execute("ALTER TABLE qa_annotations ADD COLUMN reference_bboxes TEXT DEFAULT '[]'")
    if "uniqueness_verified" not in qa_cols:
        cur.execute("ALTER TABLE qa_annotations ADD COLUMN uniqueness_verified INTEGER DEFAULT 1")
    if "bbox_area_ratio" not in qa_cols:
        cur.execute("ALTER TABLE qa_annotations ADD COLUMN bbox_area_ratio REAL DEFAULT 0.0")
    if "bbox_size_warning" not in qa_cols:
        cur.execute("ALTER TABLE qa_annotations ADD COLUMN bbox_size_warning TEXT DEFAULT 'ok_small_object'")

    # Categories config table (allows users to add/customize category list & colors)
    cur.execute("""
    CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        color TEXT NOT NULL,
        density_group TEXT NOT NULL,
        shortcut_key TEXT
    )
    """)

    # Create Indexes for fast querying
    cur.execute("CREATE INDEX IF NOT EXISTS idx_points_image ON points(image_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_bboxes_image ON bboxes(image_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_qa_image ON qa_annotations(image_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_images_status ON images(status)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_images_bbox_status ON images(bbox_status)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_images_group ON images(density_group)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_images_dataset ON images(dataset)")

    # Seed default categories if empty
    cur.execute("SELECT COUNT(*) FROM categories")
    if cur.fetchone()[0] == 0:
        default_cats = [
            # same_object (NWPU-Crowd)
            ("person_head", "#EF4444", "same_object", "1"),
            ("hat_cap", "#F59E0B", "same_object", "2"),
            ("upper_body", "#3B82F6", "same_object", "3"),
            ("bag_backpack", "#8B5CF6", "same_object", "4"),
            # mixed_object (Cluttered Room)
            ("book", "#10B981", "mixed_object", "1"),
            ("cup", "#F43F5E", "mixed_object", "2"),
            ("bottle", "#06B6D4", "mixed_object", "3"),
            ("laptop", "#6366F1", "mixed_object", "4"),
            ("monitor", "#8B5CF6", "mixed_object", "5"),
            ("chair", "#EC4899", "mixed_object", "6"),
            ("lamp", "#EAB308", "mixed_object", "7"),
            ("clock", "#14B8A6", "mixed_object", "8"),
            ("backpack", "#F97316", "mixed_object", "9"),
            ("other", "#94A3B8", "mixed_object", "0"),
        ]
        cur.executemany("INSERT INTO categories (name, color, density_group, shortcut_key) VALUES (?, ?, ?, ?)", default_cats)

    conn.commit()
    conn.close()

def scan_and_add_image(file_path: str, density_group: str = "same_object", image_id: Optional[str] = None, dataset: Optional[str] = None) -> Optional[Dict[str, Any]]:
    if not os.path.exists(file_path):
        return None

    file_name = os.path.basename(file_path)
    file_size = os.path.getsize(file_path)

    try:
        with Image.open(file_path) as img:
            width, height = img.size
    except Exception as e:
        print(f"Error reading image dimensions for {file_path}: {e}")
        return None

    if dataset is None or not dataset.strip():
        # Default: group by the folder the image lives in
        dataset = os.path.basename(os.path.dirname(os.path.abspath(file_path))) or "Default"

    if not image_id:
        stem = os.path.splitext(file_name)[0]
        # Clean stem for ID
        safe_stem = "".join(c if c.isalnum() or c in ("_", "-") else "_" for c in stem)
        image_id = safe_stem

    now = utc_now_iso()

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # Check if image_id or file_path already exists
    cur.execute("SELECT image_id FROM images WHERE file_path = ?", (file_path,))
    existing = cur.fetchone()
    if existing:
        image_id = existing[0]
        cur.execute("""
            UPDATE images SET
                dataset = ?,
                density_group = ?,
                width = ?,
                height = ?,
                file_size = ?,
                updated_at = ?
            WHERE image_id = ?
        """, (dataset, density_group, width, height, file_size, now, image_id))
    else:
        # Check if ID collision
        cur.execute("SELECT 1 FROM images WHERE image_id = ?", (image_id,))
        if cur.fetchone():
            image_id = f"{image_id}_{int(datetime.now().timestamp())}"

        cur.execute("""
            INSERT INTO images (image_id, file_name, file_path, dataset, density_group, status, width, height, file_size, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?)
        """, (image_id, file_name, file_path, dataset, density_group, width, height, file_size, now, now))

    conn.commit()
    conn.close()

    return {
        "image_id": image_id,
        "file_name": file_name,
        "file_path": file_path,
        "dataset": dataset,
        "density_group": density_group,
        "width": width,
        "height": height,
        "file_size": file_size
    }

def create_auto_backup() -> str:
    """Exports full database state to a timestamped JSON file in auto_backups/"""
    from app.schemas import build_export_data
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        data = build_export_data(conn)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_file = os.path.join(BACKUP_DIR, f"backup_{timestamp}.json")
        with open(backup_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        return backup_file
    finally:
        conn.close()
