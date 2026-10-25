import json
from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field
from datetime import datetime, timezone

class PointBase(BaseModel):
    x: float
    y: float
    category: str
    color: Optional[str] = "#EF4444"
    attributes: Optional[Dict[str, Any]] = Field(default_factory=dict)

class PointCreate(PointBase):
    point_id: Optional[str] = None

class PointUpdate(BaseModel):
    x: Optional[float] = None
    y: Optional[float] = None
    category: Optional[str] = None
    color: Optional[str] = None
    attributes: Optional[Dict[str, Any]] = None

class PointOut(PointBase):
    point_id: str
    image_id: str
    x_norm: float
    y_norm: float
    created_at: str
    updated_at: str

class QAPairBase(BaseModel):
    task_type: str = "Visual Search"
    question: str
    answer: str
    target_point_ids: List[str] = Field(default_factory=list)

class QAPairCreate(QAPairBase):
    qa_id: Optional[str] = None

class QAPairUpdate(BaseModel):
    task_type: Optional[str] = None
    question: Optional[str] = None
    answer: Optional[str] = None
    target_point_ids: Optional[List[str]] = None

class QAPairOut(QAPairBase):
    qa_id: str
    image_id: str
    created_at: str
    updated_at: str

class ImageUpdate(BaseModel):
    status: Optional[str] = None
    qa_status: Optional[str] = None
    density_group: Optional[str] = None

class CategoryModel(BaseModel):
    name: str
    color: str
    density_group: str = "mixed_object"
    shortcut_key: Optional[str] = None

class ImportFolderRequest(BaseModel):
    folder_path: str
    density_group: str = "same_object"
    dataset_name: Optional[str] = None

class DatasetImportRequest(BaseModel):
    """Bulk dataset import with existing point annotations (e.g. NWPU-Crowd).

    Layout convention (NWPU-Crowd-HRVS):
        root_path/
        ├── images/   0008.jpg, 0017.jpg, ...
        └── jsons/    0008.json = {"img_id": "0008.jpg", "human_num": N,
                                    "points": [[x, y], ...]}

    Images whose JSON contains at least one point are marked `completed`;
    images with an empty points list stay `todo` for manual labeling.
    """
    root_path: str
    dataset_name: Optional[str] = None
    density_group: str = "same_object"
    annotations_dir: Optional[str] = None  # default: <root_path>/jsons
    category: str = "person_head"
    color: str = "#EF4444"

def build_export_data(conn, image_id: Optional[str] = None) -> Dict[str, Any]:
    """Builds the exact Section 5 HRVS export JSON schema"""
    import sqlite3
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    
    if image_id:
        cur.execute("SELECT * FROM images WHERE image_id = ?", (image_id,))
    else:
        cur.execute("SELECT * FROM images ORDER BY created_at ASC")
    
    image_rows = cur.fetchall()
    images_export = []

    for img in image_rows:
        img_id = img["image_id"]

        # Fetch points
        cur.execute("SELECT * FROM points WHERE image_id = ? ORDER BY point_id ASC", (img_id,))
        pt_rows = cur.fetchall()
        points_list = []
        for p in pt_rows:
            try:
                attrs = json.loads(p["attributes"]) if p["attributes"] else {}
            except Exception:
                attrs = {}
            points_list.append({
                "point_id": p["point_id"],
                "x": round(float(p["x"]), 2),
                "y": round(float(p["y"]), 2),
                "x_norm": round(float(p["x_norm"]), 6),
                "y_norm": round(float(p["y_norm"]), 6),
                "category": p["category"],
                "attributes": attrs
            })

        # Fetch QA pairs
        cur.execute("SELECT * FROM qa_annotations WHERE image_id = ? ORDER BY qa_id ASC", (img_id,))
        qa_rows = cur.fetchall()
        qa_list = []
        for q in qa_rows:
            try:
                target_ids = json.loads(q["target_point_ids"]) if q["target_point_ids"] else []
            except Exception:
                target_ids = []
            qa_list.append({
                "qa_id": q["qa_id"],
                "task_type": q["task_type"],
                "question": q["question"],
                "answer": q["answer"],
                "target_point_ids": target_ids
            })

        images_export.append({
            "image_id": img["image_id"],
            "file_name": img["file_name"],
            "file_path": img["file_path"],
            "dataset": img["dataset"],
            "density_group": img["density_group"],
            "status": img["status"],
            "qa_status": img["qa_status"],
            "original_resolution": {
                "width": img["width"],
                "height": img["height"]
            },
            "point_count": len(points_list),
            "points": points_list,
            "qa_annotations": qa_list
        })

    return {
        "benchmark_name": "HRVS_Benchmark",
        "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "total_images": len(images_export),
        "images": images_export
    }
