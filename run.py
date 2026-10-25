#!/usr/bin/env python3
import os
import sys
import json
import sqlite3
import uvicorn

# Ensure the root dir is in sys.path
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from app.database import init_db, scan_and_add_image, DB_PATH
from app.main import load_annotation_data

def seed_sample_data():
    """Generates sample data if missing, and loads into database if DB is empty."""
    sample_dir = os.path.join(BASE_DIR, "sample_data")
    crowd_img = os.path.join(sample_dir, "same_object_crowd.jpg")
    room_img = os.path.join(sample_dir, "mixed_object_room.jpg")

    # If images don't exist yet, generate them
    if not os.path.exists(crowd_img) or not os.path.exists(room_img):
        print("Generating high-resolution sample images...")
        from sample_data.generate_samples import create_crowd_image, create_room_image
        create_crowd_image()
        create_room_image()

    # Check if images exist in database
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM images")
    count = cur.fetchone()[0]
    conn.close()

    if count == 0:
        print("Seeding sample images and annotations into database...")
        # 1. Add crowd image
        c_info = scan_and_add_image(crowd_img, density_group="same_object", image_id="nwpu_0001")
        if c_info:
            anno_path = os.path.join(sample_dir, "same_object_crowd_annotations.json")
            if os.path.exists(anno_path):
                with open(anno_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    conn2 = sqlite3.connect(DB_PATH)
                    load_annotation_data("nwpu_0001", data, conn2)
                    conn2.close()

        # 2. Add room image
        r_info = scan_and_add_image(room_img, density_group="mixed_object", image_id="room_0001")
        if r_info:
            anno_path = os.path.join(sample_dir, "mixed_object_room_annotations.json")
            if os.path.exists(anno_path):
                with open(anno_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    conn3 = sqlite3.connect(DB_PATH)
                    load_annotation_data("room_0001", data, conn3)
                    conn3.close()

        print("Database seeded with sample images: nwpu_0001 and room_0001.")

if __name__ == "__main__":
    init_db()
    seed_sample_data()
    print("=" * 60)
    print("  High-Resolution Visual Search (HRVS) Annotation Platform")
    print("  Server running at: http://127.0.0.1:8000")
    print("=" * 60)
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=False)
