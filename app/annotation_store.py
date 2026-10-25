"""
Annotation File Store
Mirrors every image's annotations (points + QA pairs + metadata) from the
working SQLite database into one JSON file per image, grouped by dataset:

    storage/annotations/
    ├── same_object/<image_id>.json    (NWPU-Crowd style density)
    └── mixed_object/<image_id>.json   (cluttered scene density)

Files are rewritten atomically after every annotation mutation, so the folders
stay live while annotating and double as a recovery / sharing / export layer.
Each file embeds "image_file" so it can be round-tripped back into the
platform via the companion-JSON loader (Import Folder auto-load).
"""

import os
import json
from datetime import datetime, timezone

from app.database import STORAGE_DIR

ANNOTATIONS_DIR = os.path.join(STORAGE_DIR, "annotations")
GROUPS = ("same_object", "mixed_object")


def _safe_id(image_id: str) -> str:
    return "".join(c if c.isalnum() or c in ("_", "-") else "_" for c in image_id)


def annotation_file_path(density_group: str, image_id: str) -> str:
    return os.path.join(ANNOTATIONS_DIR, density_group, f"{_safe_id(image_id)}.json")


def sync_image_annotation_file(conn, image_id: str):
    """Write one image's full annotation state to its per-image JSON file.
    Returns the absolute file path, or None if the image does not exist."""
    from app.schemas import build_export_data  # local import avoids import cycle

    data = build_export_data(conn, image_id=image_id)
    if not data["images"]:
        return None

    img = data["images"][0]
    # "image_file" keeps the file self-describing for the companion-JSON loader
    img["image_file"] = img["file_name"]
    img["saved_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    group = img["density_group"]
    group_dir = os.path.join(ANNOTATIONS_DIR, group)
    os.makedirs(group_dir, exist_ok=True)

    path = annotation_file_path(group, image_id)
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(img, f, indent=2, ensure_ascii=False)
    os.replace(tmp_path, path)  # atomic: readers never see a half-written file

    # If the image was re-classified into the other group, remove the stale copy
    for other in GROUPS:
        if other != group:
            stale = annotation_file_path(other, image_id)
            if os.path.exists(stale):
                os.remove(stale)

    return path


def delete_image_annotation_file(image_id: str):
    """Remove an image's annotation file from both group folders (if present)."""
    for group in GROUPS:
        path = annotation_file_path(group, image_id)
        if os.path.exists(path):
            os.remove(path)


def sync_all_annotation_files(conn, only_missing: bool = False) -> int:
    """Materialize DB annotations into per-image JSON files.
    Called on startup (only_missing=True) and from POST /api/annotations/sync-all."""
    cur = conn.cursor()
    cur.execute("SELECT image_id FROM images ORDER BY created_at ASC")
    image_ids = [r["image_id"] for r in cur.fetchall()]

    written = 0
    for image_id in image_ids:
        if only_missing:
            already_on_disk = any(
                os.path.exists(annotation_file_path(g, image_id)) for g in GROUPS
            )
            if already_on_disk:
                continue
        sync_image_annotation_file(conn, image_id)
        written += 1
    return written
