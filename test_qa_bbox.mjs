// Run with: node test_qa_bbox.mjs (no browser or database changes required).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const load = async name => import(`data:text/javascript;base64,${Buffer.from(await readFile(new URL(`app/static/js/${name}.js`, import.meta.url))).toString('base64')}`);
const { CanvasViewport } = await load('canvas_viewport');
const { QAWorkflow } = await load('qa_workflow');
const handlers = {};
globalThis.window = { addEventListener: (name, fn) => { handlers[name] = fn; } };
globalThis.document = { getElementById: () => null };
const canvasHandlers = {};
const viewport = Object.assign(Object.create(CanvasViewport.prototype), {
  canvas: { style: {}, addEventListener: (name, fn) => { canvasHandlers[name] = fn; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 500 }) },
  workflowMode: 'qa', imageLoaded: true, scale: 1, panX: 0, panY: 0,
  naturalWidth: 500, naturalHeight: 500, screenRadius: 6,
  requestOverlayRender() {}, renderMinimapDots() {}, setActiveQATargets() {},
  findPointNearScreen: () => ({ point_id: 'point' }),
  findBBoxAtScreen: () => ({ bbox_id: 'existing' })
});
viewport.initEvents();
let created = [];
const app = {
  viewport, currentWorkflow: 'qa', bboxLocked: false,
  pointWorkflow: { categories: [{ name: 'person', color: '#ff0000' }] },
  showToast() {},
  bboxWorkflow: { activeCategory: 'person', activeColor: '#ff0000',
    async createBBox(x, y, width, height, category, color) {
      const bb = { bbox_id: `new${created.length}`, x, y, width, height, category, color };
      created.push(bb); return bb;
    } }
};
const qa = new QAWorkflow(app);
qa.renderTargetBBoxUI = () => {};
qa.renderRefBBoxesUI = () => {};
qa.editingQA = { reference_bboxes: [] };
qa.pickingMode = 'target';
const event = (x, y) => ({ clientX: x, clientY: y, button: 0 });
// A drag over an existing point/box must draw and automatically link a target.
canvasHandlers.mousedown(event(100, 100));
assert.ok(viewport.drawingBBox);
canvasHandlers.mousemove(event(140, 160));
handlers.mouseup(event(140, 160));
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(created[0], { bbox_id: 'new0', x: 100, y: 100, width: 40, height: 60, category: 'person', color: '#ff0000' });
assert.equal(qa.editingQA.target_bbox.bbox_id, 'new0');
assert.equal(qa.pickingMode, null);
// A short click preserves picking of an existing bbox.
qa.pickingMode = 'target';
canvasHandlers.mousedown(event(100, 100));
handlers.mouseup(event(100, 100));
assert.equal(qa.editingQA.target_bbox.bbox_id, 'existing');
assert.equal(created.length, 1);
// Reference creation is repeatable, capped at two, and leaves picking active.
qa.pickingMode = 'reference';
await viewport.onBBoxCreate({ x: 1, y: 2, width: 10, height: 20 });
await viewport.onBBoxCreate({ x: 30, y: 2, width: 10, height: 20 });
await viewport.onBBoxCreate({ x: 60, y: 2, width: 10, height: 20 });
assert.equal(qa.editingQA.reference_bboxes.length, 2);
assert.equal(created.length, 3);
assert.equal(qa.pickingMode, 'reference');
// Space keeps panning available during picking.
viewport.isSpacePressed = true;
canvasHandlers.mousedown(event(200, 200));
assert.equal(viewport.isPanning, true);
assert.equal(viewport.drawingBBox, null);
viewport.isSpacePressed = false;
handlers.mouseup(event(200, 200));
// BBox lock prevents creation but still permits bbox picking over a point.
app.bboxLocked = true;
qa.pickingMode = 'target';
assert.equal(viewport.canDrawQABBox(), false);
canvasHandlers.mousedown(event(100, 100));
assert.equal(qa.editingQA.target_bbox.bbox_id, 'existing');
await viewport.onBBoxCreate({ x: 1, y: 2, width: 10, height: 20 });
assert.equal(created.length, 3);
app.bboxLocked = false;
// No duplicate requests and no linking into a different editor after await.
let finish;
app.bboxWorkflow.createBBox = () => new Promise(resolve => { finish = resolve; });
qa.pickingMode = 'target';
const pending = viewport.onBBoxCreate({ x: 1, y: 2, width: 10, height: 20 });
assert.equal(viewport.canDrawQABBox(), false);
qa.editingQA = { reference_bboxes: [] };
finish(created[0]);
await pending;
assert.equal(qa.editingQA.target_bbox, undefined);
assert.equal(qa.creatingBBox, false);
qa.locked = true;
assert.equal(viewport.canDrawQABBox(), false);
// Resize handles take priority over drawing, and failed saves restore geometry.
qa.locked = false;
viewport.bboxes = [{ bbox_id: 'resize', x: 10, y: 10, width: 20, height: 20 }];
viewport.selectedBBoxId = 'resize';
viewport.findBBoxHandleAtScreen = () => ({ bbox: viewport.bboxes[0], handle: 'se' });
canvasHandlers.mousedown(event(30, 30));
assert.equal(viewport.draggingBBox.mode, 'se');
assert.equal(viewport.drawingBBox, null);
viewport.draggingBBox = null;
qa.editingQA = { target_bbox: { ...viewport.bboxes[0] }, target_bbox_ids: ['resize'], reference_bboxes: [] };
app.bboxWorkflow.updateBBox = async () => false;
viewport.bboxes[0].width = 40;
await viewport.onBBoxChangeEnd(viewport.bboxes[0], { x: 10, y: 10, width: 20, height: 20 });
assert.equal(viewport.bboxes[0].width, 20);
app.bboxWorkflow.updateBBox = async () => true;
viewport.bboxes[0].width = 50;
await viewport.onBBoxChangeEnd(viewport.bboxes[0], { x: 10, y: 10, width: 20, height: 20 });
assert.equal(qa.editingQA.target_bbox.width, 50);
app.bboxWorkflow.deleteBBox = async () => true;
await qa.deleteSelectedBBox();
assert.equal(qa.editingQA.target_bbox, null);
assert.deepEqual(qa.editingQA.target_bbox_ids, []);
console.log('QA bbox interaction checks passed.');
