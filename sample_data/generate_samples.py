"""
Generate realistic High-Resolution sample images and default annotations:
1. same_object_crowd.jpg: 4000x3000 (Dense crowd simulating NWPU-Crowd)
2. mixed_object_room.jpg: 3840x2160 (Cluttered room with diverse objects)
"""

import os
import random
import math
import json
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SAMPLE_DIR = os.path.dirname(os.path.abspath(__file__))

def create_crowd_image(path="same_object_crowd.jpg", width=4000, height=3000):
    full_path = os.path.join(SAMPLE_DIR, path)
    if os.path.exists(full_path):
        print(f"Sample crowd image already exists at {full_path}")
        return full_path

    print(f"Generating high-res crowd image ({width}x{height})...")
    random.seed(42)
    img = Image.new("RGB", (width, height), (35, 38, 45))
    draw = ImageDraw.Draw(img)

    # 1. Background ground & stadium/plaza texture
    for y in range(0, height, 40):
        shade = 30 + int(15 * math.sin(y / 150.0))
        draw.rectangle([0, y, width, min(height, y + 40)], fill=(shade, shade + 3, shade + 8))

    # Architectural lines / pavement tiles
    for x in range(0, width, 250):
        draw.line([(x, 0), (x, height)], fill=(45, 48, 55), width=2)
    for y in range(0, height, 200):
        draw.line([(0, y), (width, y)], fill=(45, 48, 55), width=2)

    # Some plaza features (stage, barriers, pathways)
    draw.rectangle([width * 0.1, height * 0.05, width * 0.9, height * 0.15], fill=(55, 60, 70))
    draw.text((int(width * 0.42), int(height * 0.08)), "NWPU-CROWD HIGH DENSITY ZONE A", fill=(200, 210, 225))

    # 2. Crowd generation
    # Dense clusters across the field
    hair_colors = [(20, 20, 20), (35, 25, 20), (60, 45, 30), (80, 60, 40), (150, 140, 130), (180, 160, 120)]
    skin_tones = [(245, 205, 180), (225, 185, 155), (200, 155, 125), (160, 115, 85), (255, 220, 200)]
    shirt_colors = [
        (40, 80, 160), (180, 40, 40), (40, 150, 60), (200, 170, 30),
        (220, 220, 220), (30, 30, 30), (120, 60, 160), (210, 100, 30)
    ]

    points_data = []
    point_idx = 1

    # Dense zones
    clusters = [
        (width * 0.35, height * 0.35, 800, 500, 120),
        (width * 0.65, height * 0.38, 750, 450, 100),
        (width * 0.50, height * 0.65, 1100, 650, 200),
        (width * 0.20, height * 0.70, 600, 400, 80),
        (width * 0.80, height * 0.75, 650, 450, 90),
    ]

    for cx, cy, rx, ry, count in clusters:
        for _ in range(count):
            angle = random.uniform(0, 2 * math.pi)
            dist = (random.random() ** 0.5)
            px = int(cx + math.cos(angle) * rx * dist)
            py = int(cy + math.sin(angle) * ry * dist)

            if 20 <= px < width - 20 and 20 <= py < height - 20:
                head_r = random.randint(6, 12)
                skin = random.choice(skin_tones)
                hair = random.choice(hair_colors)
                shirt = random.choice(shirt_colors)

                # Torso / shoulders
                draw.ellipse([px - head_r * 2, py + head_r // 2, px + head_r * 2, py + head_r * 3], fill=shirt)
                # Head
                draw.ellipse([px - head_r, py - head_r, px + head_r, py + head_r], fill=skin)
                # Hair / hat
                has_hat = random.random() < 0.25
                hat_color = (220, 30, 30) if random.random() < 0.3 else (230, 200, 40)
                if has_hat:
                    draw.ellipse([px - head_r - 1, py - head_r - 2, px + head_r + 1, py], fill=hat_color)
                else:
                    draw.arc([px - head_r, py - head_r, px + head_r, py + head_r], start=180, end=360, fill=hair, width=3)

                # Keep a selection of well-defined points as ground truth
                if random.random() < 0.35 and point_idx <= 80:
                    attr = {}
                    if has_hat and hat_color == (220, 30, 30):
                        attr = {"color": "red_hat", "note": "Person with red hat"}
                    elif has_hat:
                        attr = {"color": "yellow_cap", "note": "Person with yellow cap"}
                    
                    points_data.append({
                        "point_id": f"pt_{point_idx:03d}",
                        "x": float(px),
                        "y": float(py),
                        "x_norm": round(px / width, 6),
                        "y_norm": round(py / height, 6),
                        "category": "person_head",
                        "attributes": attr
                    })
                    point_idx += 1

    # Save JPEG
    img.save(full_path, "JPEG", quality=92, optimize=True)
    print(f"Crowd image saved to {full_path} with {len(points_data)} ground-truth points.")

    # Save companion annotation JSON for instant import
    qa_list = [
        {
            "qa_id": "qa_001",
            "task_type": "Visual Search",
            "question": "Where is the person wearing a red hat near the upper-left cluster?",
            "answer": "Located at upper-left dense cluster around coordinates (1420, 890).",
            "target_point_ids": [p["point_id"] for p in points_data if p.get("attributes", {}).get("color") == "red_hat"][:2]
        },
        {
            "qa_id": "qa_002",
            "task_type": "Counting",
            "question": "How many individuals are distinctly annotated in the center dense zone?",
            "answer": f"There are {len(points_data)} target annotated person heads across the high-density sections.",
            "target_point_ids": [p["point_id"] for p in points_data[:10]]
        }
    ]

    anno_path = os.path.join(SAMPLE_DIR, "same_object_crowd_annotations.json")
    with open(anno_path, "w", encoding="utf-8") as f:
        json.dump({
            "image_file": path,
            "density_group": "same_object",
            "width": width,
            "height": height,
            "points": points_data,
            "qa_annotations": qa_list
        }, f, indent=2)

    return full_path

def create_room_image(path="mixed_object_room.jpg", width=3840, height=2160):
    full_path = os.path.join(SAMPLE_DIR, path)
    if os.path.exists(full_path):
        print(f"Sample room image already exists at {full_path}")
        return full_path

    print(f"Generating high-res cluttered room image ({width}x{height})...")
    random.seed(101)
    img = Image.new("RGB", (width, height), (220, 215, 205))
    draw = ImageDraw.Draw(img)

    # 1. Room structure
    # Wall (top 60%), Floor (bottom 40%)
    wall_h = int(height * 0.55)
    draw.rectangle([0, 0, width, wall_h], fill=(235, 230, 220))
    # Floor (wood planks)
    for y in range(wall_h, height, 30):
        shade = 140 + int(20 * math.sin(y / 40.0))
        draw.rectangle([0, y, width, min(height, y + 30)], fill=(shade + 30, shade, shade - 20))
        draw.line([(0, y), (width, y)], fill=(110, 80, 50), width=1)

    # Baseboard
    draw.rectangle([0, wall_h - 15, width, wall_h + 15], fill=(250, 245, 240))

    # Large Bookcase on left
    draw.rectangle([80, 100, 750, wall_h + 350], fill=(70, 45, 30), outline=(50, 30, 20), width=4)
    # Shelves
    shelf_ys = [280, 480, 680, 880, 1080]
    for sy in shelf_ys:
        draw.rectangle([85, sy, 745, sy + 20], fill=(90, 60, 40))

    points_data = []
    pt_num = 1

    # Populate books on shelves
    book_colors = [
        (180, 45, 45), (45, 80, 160), (35, 130, 65), (210, 150, 30),
        (110, 40, 140), (220, 100, 40), (60, 60, 60), (240, 240, 240)
    ]
    for sy in shelf_ys:
        bx = 110
        while bx < 700:
            bw = random.randint(18, 35)
            bh = random.randint(120, 170)
            color = random.choice(book_colors)
            draw.rectangle([bx, sy - bh, bx + bw, sy], fill=color, outline=(30, 30, 30), width=1)
            # Annotate some books
            if random.random() < 0.2 and pt_num <= 20:
                color_name = "red" if color[0] > 150 and color[1] < 60 else "blue" if color[2] > 120 else "green"
                points_data.append({
                    "point_id": f"pt_{pt_num:03d}",
                    "x": float(bx + bw // 2),
                    "y": float(sy - bh // 2),
                    "x_norm": round((bx + bw // 2) / width, 6),
                    "y_norm": round((sy - bh // 2) / height, 6),
                    "category": "book",
                    "attributes": {"color": color_name, "state": "standing"}
                })
                pt_num += 1
            bx += bw + random.randint(2, 6)

    # Wall Clock
    clock_cx, clock_cy = 1300, 300
    draw.ellipse([clock_cx - 90, clock_cy - 90, clock_cx + 90, clock_cy + 90], fill=(245, 245, 245), outline=(30, 30, 30), width=6)
    draw.line([(clock_cx, clock_cy), (clock_cx + 40, clock_cy - 20)], fill=(20, 20, 20), width=4)
    draw.line([(clock_cx, clock_cy), (clock_cx - 10, clock_cy + 50)], fill=(180, 20, 20), width=2)
    points_data.append({
        "point_id": f"pt_{pt_num:03d}",
        "x": float(clock_cx),
        "y": float(clock_cy),
        "x_norm": round(clock_cx / width, 6),
        "y_norm": round(clock_cy / height, 6),
        "category": "clock",
        "attributes": {"color": "white_black", "state": "hanging"}
    })
    pt_num += 1

    # Large Desk in center-right
    desk_x1, desk_y1 = 900, 950
    desk_x2, desk_y2 = 3400, 1650
    draw.rectangle([desk_x1, desk_y1, desk_x2, desk_y2], fill=(160, 115, 80), outline=(100, 70, 45), width=5)
    # Desk legs
    draw.rectangle([920, desk_y2, 980, height - 100], fill=(80, 55, 35))
    draw.rectangle([desk_x2 - 80, desk_y2, desk_x2 - 20, height - 100], fill=(80, 55, 35))

    # Laptop 1 on desk
    lap1_x, lap1_y = 1450, 1100
    draw.rectangle([lap1_x, lap1_y, lap1_x + 360, lap1_y + 240], fill=(180, 185, 190), outline=(50, 50, 50), width=3)
    draw.rectangle([lap1_x + 20, lap1_y + 15, lap1_x + 340, lap1_y + 160], fill=(30, 50, 80)) # Screen
    draw.rectangle([lap1_x + 30, lap1_y + 170, lap1_x + 330, lap1_y + 225], fill=(90, 95, 100)) # Keyboard
    points_data.append({
        "point_id": f"pt_{pt_num:03d}",
        "x": float(lap1_x + 180),
        "y": float(lap1_y + 120),
        "x_norm": round((lap1_x + 180) / width, 6),
        "y_norm": round((lap1_y + 120) / height, 6),
        "category": "laptop",
        "attributes": {"color": "silver", "state": "open"}
    })
    laptop_pt_id = f"pt_{pt_num:03d}"
    pt_num += 1

    # Mug next to laptop
    mug_x, mug_y = 1880, 1180
    draw.ellipse([mug_x, mug_y, mug_x + 70, mug_y + 70], fill=(210, 40, 40), outline=(120, 20, 20), width=2)
    draw.arc([mug_x + 55, mug_y + 15, mug_x + 85, mug_y + 55], start=270, end=90, fill=(120, 20, 20), width=4)
    draw.ellipse([mug_x + 10, mug_y + 10, mug_x + 60, mug_y + 60], fill=(80, 45, 25)) # Coffee inside
    points_data.append({
        "point_id": f"pt_{pt_num:03d}",
        "x": float(mug_x + 35),
        "y": float(mug_y + 35),
        "x_norm": round((mug_x + 35) / width, 6),
        "y_norm": round((mug_y + 35) / height, 6),
        "category": "cup",
        "attributes": {"color": "red", "state": "filled"}
    })
    mug_pt_id = f"pt_{pt_num:03d}"
    pt_num += 1

    # Dual Monitors in center
    mon_x, mon_y = 2050, 980
    draw.rectangle([mon_x, mon_y, mon_x + 550, mon_y + 330], fill=(25, 25, 25), outline=(10, 10, 10), width=4)
    draw.rectangle([mon_x + 15, mon_y + 15, mon_x + 535, mon_y + 300], fill=(45, 60, 90)) # Screen glow
    points_data.append({
        "point_id": f"pt_{pt_num:03d}",
        "x": float(mon_x + 275),
        "y": float(mon_y + 165),
        "x_norm": round((mon_x + 275) / width, 6),
        "y_norm": round((mon_y + 165) / height, 6),
        "category": "monitor",
        "attributes": {"color": "black", "state": "on"}
    })
    pt_num += 1

    # Water Bottle on desk right
    bot_x, bot_y = 2800, 1080
    draw.rectangle([bot_x, bot_y + 30, bot_x + 50, bot_y + 150], fill=(100, 190, 240, 180), outline=(60, 120, 180), width=2)
    draw.rectangle([bot_x + 15, bot_y, bot_x + 35, bot_y + 30], fill=(40, 80, 150))
    points_data.append({
        "point_id": f"pt_{pt_num:03d}",
        "x": float(bot_x + 25),
        "y": float(bot_y + 75),
        "x_norm": round((bot_x + 25) / width, 6),
        "y_norm": round((bot_y + 75) / height, 6),
        "category": "bottle",
        "attributes": {"color": "cyan_transparent", "material": "plastic"}
    })
    pt_num += 1

    # Desk Lamp on left of desk
    lamp_x, lamp_y = 1000, 800
    draw.ellipse([lamp_x + 20, lamp_y + 200, lamp_x + 100, lamp_y + 230], fill=(60, 60, 60))
    draw.line([(lamp_x + 60, lamp_y + 200), (lamp_x + 90, lamp_y + 90)], fill=(90, 90, 90), width=8)
    draw.polygon([(lamp_x + 60, lamp_y + 90), (lamp_x + 140, lamp_y + 60), (lamp_x + 120, lamp_y + 130)], fill=(230, 180, 40))
    points_data.append({
        "point_id": f"pt_{pt_num:03d}",
        "x": float(lamp_x + 100),
        "y": float(lamp_y + 90),
        "x_norm": round((lamp_x + 100) / width, 6),
        "y_norm": round((lamp_y + 90) / height, 6),
        "category": "lamp",
        "attributes": {"color": "yellow", "state": "adjustable"}
    })
    pt_num += 1

    # Office Chair
    chair_cx, chair_cy = 1800, 1600
    draw.rectangle([chair_cx - 150, chair_cy - 120, chair_cx + 150, chair_cy + 120], fill=(40, 45, 55), outline=(20, 25, 30), width=5)
    draw.rectangle([chair_cx - 120, chair_cy - 300, chair_cx + 120, chair_cy - 130], fill=(45, 50, 60), outline=(20, 25, 30), width=5)
    points_data.append({
        "point_id": f"pt_{pt_num:03d}",
        "x": float(chair_cx),
        "y": float(chair_cy - 200),
        "x_norm": round(chair_cx / width, 6),
        "y_norm": round((chair_cy - 200) / height, 6),
        "category": "chair",
        "attributes": {"color": "dark_grey", "material": "mesh"}
    })
    pt_num += 1

    # Backpack on floor
    pack_x, pack_y = 3000, 1700
    draw.polygon([(pack_x, pack_y + 150), (pack_x + 180, pack_y + 150), (pack_x + 150, pack_y), (pack_x + 30, pack_y)], fill=(30, 80, 140), outline=(20, 40, 80), width=3)
    points_data.append({
        "point_id": f"pt_{pt_num:03d}",
        "x": float(pack_x + 90),
        "y": float(pack_y + 75),
        "x_norm": round((pack_x + 90) / width, 6),
        "y_norm": round((pack_y + 75) / height, 6),
        "category": "backpack",
        "attributes": {"color": "navy_blue", "state": "resting_on_floor"}
    })
    pt_num += 1

    # Save JPEG
    img.save(full_path, "JPEG", quality=92, optimize=True)
    print(f"Room image saved to {full_path} with {len(points_data)} ground-truth points.")

    qa_list = [
        {
            "qa_id": "qa_001",
            "task_type": "Attribute Recognition",
            "question": "What color is the coffee mug next to the laptop on the wooden desk?",
            "answer": "The coffee mug is red.",
            "target_point_ids": [mug_pt_id]
        },
        {
            "qa_id": "qa_002",
            "task_type": "Spatial Relation",
            "question": "Which electronic devices are placed directly on the main desk surface?",
            "answer": "A silver laptop and a black dual-monitor display.",
            "target_point_ids": [laptop_pt_id, f"pt_{pt_num-4:03d}"]
        },
        {
            "qa_id": "qa_003",
            "task_type": "Visual Search",
            "question": "Where is the wall clock located in the room?",
            "answer": "It is mounted high on the upper wall to the left of the desk area.",
            "target_point_ids": [p["point_id"] for p in points_data if p["category"] == "clock"]
        }
    ]

    anno_path = os.path.join(SAMPLE_DIR, "mixed_object_room_annotations.json")
    with open(anno_path, "w", encoding="utf-8") as f:
        json.dump({
            "image_file": path,
            "density_group": "mixed_object",
            "width": width,
            "height": height,
            "points": points_data,
            "qa_annotations": qa_list
        }, f, indent=2)

    return full_path

if __name__ == "__main__":
    create_crowd_image()
    create_room_image()
