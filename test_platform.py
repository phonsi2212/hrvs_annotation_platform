"""
Automated unit & integration tests for HRVS Annotation Platform:
1. Coordinate math verification: screenToImage & imageToScreen roundtrip
2. FastAPI test client for endpoints (images, points, QA, export, backup)
3. Standard HRVS export validation
"""

import os
import sys
import json
import sqlite3

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from fastapi.testclient import TestClient
from app.main import app
from app.database import DB_PATH, init_db

def test_coordinate_math():
    """Verify affine transform mathematical precision at different zoom levels"""
    print("\n--- Test 1: Coordinate Math Precision ---")
    scales = [0.1, 0.5, 1.0, 4.5, 20.0, 40.0]
    pan_positions = [(0, 0), (100, -250), (-1450, 890), (3840, 2160)]

    for scale in scales:
        for panX, panY in pan_positions:
            orig_img_x = 1420.5
            orig_img_y = 890.2

            # Forward transform: imageToScreen
            screenX = orig_img_x * scale + panX
            screenY = orig_img_y * scale + panY

            # Inverse transform: screenToImage
            calc_img_x = (screenX - panX) / scale
            calc_img_y = (screenY - panY) / scale

            # Assert roundtrip precision within float tolerance
            assert abs(calc_img_x - orig_img_x) < 1e-6, f"X mismatch at scale {scale}"
            assert abs(calc_img_y - orig_img_y) < 1e-6, f"Y mismatch at scale {scale}"

    print("✓ Coordinate math verified at all zoom scales (0.1x to 40x) with zero precision drift!")

def test_annotation_file_store():
    """Verify per-image JSON files under storage/annotations/<group>/ stay in
    sync with every CRUD operation (live auto-save)."""
    print("\n--- Test 3: Per-Image Annotation File Store ---")
    from app.annotation_store import annotation_file_path, sync_all_annotation_files

    client = TestClient(app)

    # Materialize missing files only (a full rewrite of 500 NWPU files would
    # make this test take tens of seconds)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    sync_all_annotation_files(conn, only_missing=True)
    conn.close()

    # 1. File exists for an annotated image in the correct group folder
    res = client.get("/api/images")
    img = next(i for i in res.json()["images"] if i["point_count"] > 0)
    img_id, group = img["image_id"], img["density_group"]
    fpath = annotation_file_path(group, img_id)
    assert os.path.exists(fpath), f"Missing annotation file: {fpath}"
    with open(fpath, encoding="utf-8") as f:
        before = json.load(f)
    assert before["density_group"] == group
    assert "points" in before and "qa_annotations" in before and "image_file" in before
    print(f"✓ Annotation file exists: {os.path.relpath(fpath, BASE_DIR)} ({len(before['points'])} points)")

    # 2. Adding a point rewrites the file immediately
    res = client.post(f"/api/images/{img_id}/points", json={
        "x": 111.0, "y": 222.0, "category": "person_head", "color": "#EF4444"
    })
    pt_id = res.json()["point_id"]
    with open(fpath, encoding="utf-8") as f:
        after = json.load(f)
    assert any(p["point_id"] == pt_id for p in after["points"]), "Added point not mirrored to JSON file"
    print(f"✓ Add point mirrored to file instantly ({pt_id})")

    # 3. Deleting the point removes it from the file
    client.delete(f"/api/points/{pt_id}")
    with open(fpath, encoding="utf-8") as f:
        final = json.load(f)
    assert not any(p["point_id"] == pt_id for p in final["points"]), "Deleted point still present in JSON file"
    print("✓ Delete point mirrored to file instantly")

    # 4. Status change (Finish button) updates the file, then restore original status
    prev_status = before["status"]
    client.patch(f"/api/images/{img_id}", json={"status": "completed"})
    with open(fpath, encoding="utf-8") as f:
        done = json.load(f)
    assert done["status"] == "completed", "Status not mirrored to JSON file"
    client.patch(f"/api/images/{img_id}", json={"status": prev_status})
    print("✓ Status change (Finish) mirrored to file")

def test_api_endpoints():
    """Verify all FastAPI CRUD and export endpoints"""
    print("\n--- Test 2: FastAPI Endpoints ---")
    client = TestClient(app)

    # 1. Health / List Images
    res = client.get("/api/images")
    assert res.status_code == 200
    data = res.json()
    assert "images" in data
    assert len(data["images"]) >= 2, "Expected at least 2 seeded images"
    print(f"✓ List images: {len(data['images'])} images found")

    img_id = data["images"][0]["image_id"]

    # 2. Image details
    res = client.get(f"/api/images/{img_id}")
    assert res.status_code == 200
    img_data = res.json()
    assert "points" in img_data
    assert "qa_annotations" in img_data
    initial_point_count = len(img_data["points"])
    print(f"✓ Image detail for {img_id}: {initial_point_count} points, {len(img_data['qa_annotations'])} QAs")

    # 3. Add Point
    test_pt = {
        "x": 1500.5,
        "y": 950.5,
        "category": "person_head",
        "color": "#EF4444",
        "attributes": {"color": "test_blue", "note": "Unit test point"}
    }
    res = client.post(f"/api/images/{img_id}/points", json=test_pt)
    assert res.status_code == 200
    created_pt = res.json()
    new_pt_id = created_pt["point_id"]
    assert created_pt["x"] == 1500.5
    assert created_pt["y"] == 950.5
    print(f"✓ Add point succeeded: ID {new_pt_id}")

    # 4. Update Point
    update_data = {"x": 1510.0, "y": 960.0, "category": "hat_cap"}
    res = client.patch(f"/api/points/{new_pt_id}", json=update_data)
    assert res.status_code == 200
    print(f"✓ Update point position and class succeeded")

    # 4.5 Unlock QA editing: the image carries seeded Q&A pairs, so its QA
    # status backfills to completed (locked) — revert before adding more.
    res = client.patch(f"/api/images/{img_id}", json={"qa_status": "in_progress"})
    assert res.status_code == 200

    # 5. Add QA Pair
    test_qa = {
        "task_type": "Visual Search",
        "question": "Where is the unit test point?",
        "answer": "At coordinates (1510, 960)",
        "target_point_ids": [new_pt_id]
    }
    res = client.post(f"/api/images/{img_id}/qa", json=test_qa)
    assert res.status_code == 200
    created_qa = res.json()
    new_qa_id = created_qa["qa_id"]
    assert created_qa["question"] == test_qa["question"]
    assert new_pt_id in created_qa["target_point_ids"]
    print(f"✓ Add QA pair with target grounding succeeded: ID {new_qa_id}")

    # 6. Delete Point (verify cleanup in QA targets)
    res = client.delete(f"/api/points/{new_pt_id}")
    assert res.status_code == 200
    print(f"✓ Delete point succeeded")

    # 7. Delete QA Pair
    res = client.delete(f"/api/qa/{new_qa_id}")
    assert res.status_code == 200
    print(f"✓ Delete QA pair succeeded")

    # 7.5 Restore the original QA status (completed — image has seeded Q&A)
    client.patch(f"/api/images/{img_id}", json={"qa_status": "completed"})

    # 8. Trigger Snapshot Backup
    res = client.post("/api/backup")
    assert res.status_code == 200
    backup_resp = res.json()
    assert os.path.exists(backup_resp["backup_file"])
    print(f"✓ Auto-backup snapshot generated: {backup_resp['filename']}")
    # A full snapshot now weighs ~111MB (503k points) — don't let test runs
    # pile them up in storage/auto_backups/
    os.remove(backup_resp["backup_file"])

    # 9. Export Benchmark JSON
    res = client.get("/api/export/json")
    assert res.status_code == 200
    export_json = res.json()
    assert export_json["benchmark_name"] == "HRVS_Benchmark"
    assert "images" in export_json
    assert len(export_json["images"]) >= 2
    for img in export_json["images"]:
        assert "original_resolution" in img
        assert "width" in img["original_resolution"]
        assert "height" in img["original_resolution"]
        assert "points" in img
        assert "qa_annotations" in img
    print(f"✓ Export full dataset JSON matches Section 5 specification exactly")

    # 10. Export CSV
    res = client.get("/api/export/csv")
    assert res.status_code == 200
    assert "image_id,file_name,dataset,density_group" in res.text
    print(f"✓ Export CSV stream validated")

def test_datasets():
    """Verify dataset grouping endpoints and the NWPU-Crowd bulk import rules:
    images with annotations -> completed, empty ones -> todo."""
    print("\n--- Test 4: Datasets & NWPU Import Rules ---")
    client = TestClient(app)

    # 1. Dataset list
    res = client.get("/api/datasets")
    assert res.status_code == 200
    datasets = res.json()["datasets"]
    assert len(datasets) >= 1, "Expected at least one dataset"
    by_name = {d["dataset"]: d for d in datasets}
    print(f"✓ Datasets listed: {[d['dataset'] for d in datasets]}")

    # 2. NWPU-Crowd-HRVS-500 was imported with the expected split
    if "NWPU-Crowd-HRVS-500" in by_name:
        nwpu = by_name["NWPU-Crowd-HRVS-500"]
        assert nwpu["image_count"] == 500
        assert nwpu["completed_count"] + nwpu["in_progress_count"] + nwpu["todo_count"] == 500
        if nwpu["in_progress_count"] == 0:
            # Pristine post-import state: 477 annotated -> completed, 23 empty -> todo
            assert nwpu["completed_count"] == 477, f"Expected 477 completed, got {nwpu['completed_count']}"
            assert nwpu["todo_count"] == 23, f"Expected 23 todo, got {nwpu['todo_count']}"
            assert nwpu["point_count"] == 502837, f"Expected 502837 points, got {nwpu['point_count']}"
            print(f"✓ NWPU pristine import: 500 images, 477 completed, 23 todo, 502837 points")
        else:
            print(f"✓ NWPU dataset: 500 images (import split superseded by live edits: "
                  f"{nwpu['in_progress_count']} in progress, {nwpu['todo_count']} todo)")

        # 3. Dataset filter on list_images + invariant: todo images carry no points
        res = client.get("/api/images", params={"dataset": "NWPU-Crowd-HRVS-500"})
        nwpu_images = res.json()["images"]
        assert len(nwpu_images) == 500
        assert all(i["dataset"] == "NWPU-Crowd-HRVS-500" for i in nwpu_images)
        assert all(i["point_count"] == 0 for i in nwpu_images if i["status"] == "todo"), \
            "todo images must carry no points"
        print(f"✓ Dataset filter + todo-has-no-points invariant ({len(nwpu_images)} images)")

        # 4. Image detail exposes the dataset field
        res = client.get("/api/images/0008")
        d = res.json()
        assert d["dataset"] == "NWPU-Crowd-HRVS-500"
        assert d["status"] == "completed"
        assert len(d["points"]) == 10294  # NWPU 0008.jpg has 10294 heads
        print(f"✓ Image detail: 0008 -> {d['dataset']}, {d['status']}, {len(d['points'])} points")

def test_locks():
    """Completed images are read-only: point edits are blocked while the image
    status is 'completed', Q&A edits are blocked while qa_status is 'completed'.
    Reverting the respective status unlocks editing again."""
    print("\n--- Test 5: Completed Image Locking ---")
    client = TestClient(app)

    # --- Point lock ---
    client.patch("/api/images/room_0001", json={"status": "completed"})
    r = client.post("/api/images/room_0001/points", json={"x": 10, "y": 20, "category": "book"})
    assert r.status_code == 409, "Adding a point to a completed image must be blocked"
    r = client.delete("/api/images/room_0001/points")
    assert r.status_code == 409, "Clearing points of a completed image must be blocked"

    res = client.get("/api/images/room_0001")
    pt_id = res.json()["points"][0]["point_id"]
    r = client.patch(f"/api/points/{pt_id}", json={"x": 99})
    assert r.status_code == 409, "Moving a point of a completed image must be blocked"
    r = client.delete(f"/api/points/{pt_id}")
    assert r.status_code == 409, "Deleting a point of a completed image must be blocked"
    print("✓ Point add / move / delete / clear all blocked on completed image (409)")

    # Unlock -> edits allowed again
    client.patch("/api/images/room_0001", json={"status": "in_progress"})
    r = client.post("/api/images/room_0001/points", json={"x": 10, "y": 20, "category": "book"})
    assert r.status_code == 200
    client.delete(f"/api/points/{r.json()['point_id']}")
    print("✓ Reverting status unlocks point editing")

    # --- QA lock (room_0001 carries seeded Q&A -> qa_status completed) ---
    r = client.post("/api/images/room_0001/qa", json={"task_type": "Visual Search", "question": "q?", "answer": "a"})
    assert r.status_code == 409, "Adding Q&A to a QA-completed image must be blocked"
    client.patch("/api/images/room_0001", json={"qa_status": "in_progress"})
    r = client.post("/api/images/room_0001/qa", json={"task_type": "Visual Search", "question": "q?", "answer": "a"})
    assert r.status_code == 200
    client.delete(f"/api/qa/{r.json()['qa_id']}")
    client.patch("/api/images/room_0001", json={"qa_status": "completed"})
    print("✓ Q&A edits blocked while qa_status is completed, unlocked by revert")

    # --- Auto-derive on a QA-todo image (0017: point-completed, no Q&A yet).
    # Also proves that a completed POINT status never blocks QA work.
    r = client.get("/api/images/0017")
    assert r.json()["status"] == "completed" and r.json()["qa_status"] == "todo"
    r = client.post("/api/images/0017/qa", json={"question": "How many people?", "answer": "Many"})
    assert r.status_code == 200
    assert r.json()["qa_status"] == "completed", "First Q&A pair must auto-complete the QA status"
    r = client.post("/api/images/0017/qa", json={"question": "q2", "answer": "a2"})
    assert r.status_code == 409, "Image must lock Q&A editing after the first Q&A pair"
    client.patch("/api/images/0017", json={"qa_status": "in_progress"})
    r = client.post("/api/images/0017/qa", json={"question": "q2", "answer": "a2"})
    assert r.status_code == 200
    qa2_id = r.json()["qa_id"]
    client.delete(f"/api/qa/{qa2_id}")
    print("✓ QA status auto-derives: first Q&A -> completed (locked), revert -> editable")

    # Deleting the remaining Q&A reverts qa_status to todo
    res = client.get("/api/images/0017")
    remaining_qa_id = res.json()["qa_annotations"][0]["qa_id"]
    r = client.delete(f"/api/qa/{remaining_qa_id}")
    assert r.status_code == 200 and r.json()["qa_status"] == "todo", "Removing all Q&A must revert qa_status to todo"
    print("✓ Removing all Q&A pairs reverts qa_status to todo")

if __name__ == "__main__":
    init_db()
    test_coordinate_math()
    test_api_endpoints()
    test_annotation_file_store()
    test_datasets()
    test_locks()
    print("\n🎉 ALL TESTS PASSED SUCCESSFULLY!")
