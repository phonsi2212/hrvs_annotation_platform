"""BBox endpoint regression tests using an isolated in-memory database."""
import json
import sqlite3
import unittest
from unittest.mock import patch

from app.main import update_bbox, delete_bbox
from app.schemas import BBoxUpdate


class QABBoxSyncTest(unittest.TestCase):
    def test_resize_and_delete_sync_target_and_references(self):
        conn = sqlite3.connect(':memory:')
        self.addCleanup(conn.close)
        conn.row_factory = sqlite3.Row
        conn.executescript('''
            CREATE TABLE images (image_id TEXT, width INTEGER, height INTEGER, bbox_status TEXT);
            INSERT INTO images VALUES ('image', 1000, 1000, 'in_progress');
            CREATE TABLE bboxes (bbox_id TEXT, image_id TEXT, x REAL, y REAL, width REAL,
                height REAL, x_norm REAL, y_norm REAL, width_norm REAL, height_norm REAL,
                category TEXT, updated_at TEXT);
            INSERT INTO bboxes VALUES ('box', 'image', 10, 20, 10, 10, .01, .02, .01, .01, 'person', '');
            CREATE TABLE qa_annotations (qa_id TEXT, image_id TEXT, target_bbox TEXT,
                target_bbox_ids TEXT, reference_bboxes TEXT, bbox_area_ratio REAL,
                bbox_size_warning TEXT, updated_at TEXT);
        ''')
        box = {'bbox_id': 'box', 'width': 10, 'height': 10, 'area_ratio': .0001}
        for qa_id, target, ids, refs in (
            ('target', box, ['box'], []),
            ('reference', {'bbox_id': 'other', 'area_ratio': .00001}, ['other'], [box]),
        ):
            conn.execute('INSERT INTO qa_annotations VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                         (qa_id, 'image', json.dumps(target), json.dumps(ids), json.dumps(refs), .0001, 'ok_small_object', ''))
        conn.commit()
        with patch('app.main.sync_image_annotation_file') as sync:
            update_bbox('box', BBoxUpdate(width=100, height=100), conn)
            target, reference = conn.execute('SELECT * FROM qa_annotations ORDER BY qa_id DESC').fetchall()
            self.assertEqual(json.loads(target['target_bbox'])['width'], 100)
            self.assertEqual(target['bbox_size_warning'], 'warning_large_object')
            self.assertEqual(json.loads(reference['reference_bboxes'])[0]['width_norm'], .1)
            self.assertEqual(json.loads(reference['target_bbox'])['bbox_id'], 'other')
            delete_bbox('box', conn)
            target, reference = conn.execute('SELECT * FROM qa_annotations ORDER BY qa_id DESC').fetchall()
            self.assertIsNone(json.loads(target['target_bbox']))
            self.assertEqual(json.loads(target['target_bbox_ids']), [])
            self.assertEqual(target['bbox_area_ratio'], 0)
            self.assertEqual(json.loads(reference['reference_bboxes']), [])
            self.assertEqual(sync.call_count, 2)


if __name__ == '__main__':
    unittest.main()
