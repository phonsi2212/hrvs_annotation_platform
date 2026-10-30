/**
 * BBoxWorkflow Module
 * Handles Mode 2: Bounding Box Annotation Mode
 * Tools: Draw BBox (drag), Select/Move/Resize BBox, Undo/Redo, Category Palette,
 * BBox Inspector (X, Y, W, H, Normalized coords, Area %, Attributes), and BBox List.
 */

export class BBoxWorkflow {
  constructor(app) {
    this.app = app;
    this.viewport = app.viewport;

    this.activeTool = 'draw'; // 'draw' | 'select'
    this.activeCategory = 'person_head';
    this.activeColor = '#EF4444';

    // Undo / Redo Stacks per image
    this.undoStack = [];
    this.redoStack = [];

    this.initElements();
    this.initEvents();
  }

  initElements() {
    this.categoryGrid = document.getElementById('bboxCategoryGridContainer');
    this.totalBBoxesBadge = document.getElementById('totalBBoxesBadge');
    this.bboxesBreakdownContainer = document.getElementById('bboxesBreakdownContainer');
    this.bboxesTableBody = document.getElementById('bboxesTableBody');

    // Inspector elements
    this.inspectorSection = document.getElementById('bboxInspectorSection');
    this.inspBBoxId = document.getElementById('inspBBoxId');
    this.inspBBoxX = document.getElementById('inspBBoxX');
    this.inspBBoxY = document.getElementById('inspBBoxY');
    this.inspBBoxW = document.getElementById('inspBBoxW');
    this.inspBBoxH = document.getElementById('inspBBoxH');
    this.inspBBoxNorm = document.getElementById('inspBBoxNorm');
    this.inspBBoxArea = document.getElementById('inspBBoxArea');
    this.inspBBoxAreaAlert = document.getElementById('inspBBoxAreaAlert');
    this.inspBBoxCatSelect = document.getElementById('inspBBoxCatSelect');
    this.inspBBoxColorInput = document.getElementById('inspBBoxColorInput');
    this.inspBBoxAttrColor = document.getElementById('inspBBoxAttrColor');
    this.inspBBoxAttrState = document.getElementById('inspBBoxAttrState');
    this.inspBBoxAttrNote = document.getElementById('inspBBoxAttrNote');
    this.deleteSelectedBBoxBtn = document.getElementById('deleteSelectedBBoxBtn');

    // Add Custom Category Button in BBox panel
    this.addBBoxCategoryBtn = document.getElementById('addBBoxCategoryBtn');
    if (this.addBBoxCategoryBtn) {
      this.addBBoxCategoryBtn.addEventListener('click', () => {
        if (this.app.pointWorkflow) {
          this.app.pointWorkflow.promptNewCategory();
        }
      });
    }
  }

  initEvents() {
    // Provide active category & color to viewport draft rectangle
    this.viewport.getActiveBBoxDraftStyle = () => ({
      category: this.activeCategory,
      color: this.activeColor
    });

    // Finish drawing a new BBox on canvas
    this.viewport.onBBoxCreate = async (rect) => {
      if (this.app.currentWorkflow !== 'bbox') return;
      if (this.app.bboxLocked) {
        this.lockedToast();
        return;
      }
      await this.createBBox(rect.x, rect.y, rect.width, rect.height, this.activeCategory, this.activeColor);
    };

    // Click / select BBox on canvas
    this.viewport.onBBoxClick = (bb, e) => {
      if (this.app.currentWorkflow === 'bbox') {
        if (bb) {
          this.selectBBox(bb);
        } else {
          this.deselectBBox();
        }
      }
    };

    // Live drag / resize update
    this.viewport.onBBoxChange = (bb) => {
      if (this.app.currentWorkflow === 'bbox' && this.viewport.selectedBBoxId === bb.bbox_id) {
        this.populateInspector(bb);
      }
    };

    // Drag / resize finished -> persist to backend + push undo
    this.viewport.onBBoxChangeEnd = async (bb, origRect) => {
      if (this.app.currentWorkflow !== 'bbox') return;
      const newRect = { x: bb.x, y: bb.y, width: bb.width, height: bb.height };
      await this.updateBBox(bb.bbox_id, newRect);
      this.undoStack.push({
        type: 'move_resize',
        bbox_id: bb.bbox_id,
        from: origRect,
        to: newRect
      });
      this.redoStack = [];

      const totalArea = (this.viewport.naturalWidth || 1) * (this.viewport.naturalHeight || 1);
      const areaPct = ((bb.width * bb.height) / totalArea) * 100;
      if (areaPct >= 0.1) {
        this.app.showToast(`⚠️ BBox #${bb.bbox_id} có diện tích ${areaPct.toFixed(3)}% (≥ 0.1%) — Vượt chuẩn Small Object!`, 'warning');
      }
    };

    // Right-click quick delete
    window.addEventListener('bbox-delete-request', async (e) => {
      if (this.app.currentWorkflow === 'bbox' && e.detail && e.detail.bbox_id) {
        if (this.app.bboxLocked) {
          this.lockedToast();
          return;
        }
        await this.deleteBBox(e.detail.bbox_id);
      }
    });

    // Inspector numeric coordinate changes
    const onCoordInputChange = async () => {
      const bb = this.getSelectedBBox();
      if (!bb || this.app.bboxLocked) return;
      const nx = parseFloat(this.inspBBoxX.value);
      const ny = parseFloat(this.inspBBoxY.value);
      const nw = parseFloat(this.inspBBoxW.value);
      const nh = parseFloat(this.inspBBoxH.value);
      if ([nx, ny, nw, nh].some(v => isNaN(v)) || nw < 1 || nh < 1) return;
      const origRect = { x: bb.x, y: bb.y, width: bb.width, height: bb.height };
      const newRect = { x: nx, y: ny, width: nw, height: nh };
      await this.updateBBox(bb.bbox_id, newRect);
      this.undoStack.push({
        type: 'move_resize',
        bbox_id: bb.bbox_id,
        from: origRect,
        to: newRect
      });
      this.redoStack = [];
    };

    [this.inspBBoxX, this.inspBBoxY, this.inspBBoxW, this.inspBBoxH].forEach((inp) => {
      if (inp) inp.addEventListener('change', onCoordInputChange);
    });

    if (this.inspBBoxCatSelect) {
      this.inspBBoxCatSelect.addEventListener('change', async (e) => {
        const bb = this.getSelectedBBox();
        if (!bb || this.app.bboxLocked) return;
        const newCat = e.target.value;
        const cats = this.app.pointWorkflow ? this.app.pointWorkflow.categories : [];
        const catObj = cats.find(c => c.name === newCat);
        const newColor = catObj ? catObj.color : bb.color;
        await this.updateBBox(bb.bbox_id, { category: newCat, color: newColor });
      });
    }

    if (this.inspBBoxColorInput) {
      this.inspBBoxColorInput.addEventListener('change', async (e) => {
        const bb = this.getSelectedBBox();
        if (!bb || this.app.bboxLocked) return;
        await this.updateBBox(bb.bbox_id, { color: e.target.value });
      });
    }

    const updateAttrs = async () => {
      const bb = this.getSelectedBBox();
      if (!bb || this.app.bboxLocked) return;
      const attrs = {
        ...(bb.attributes || {}),
        color: this.inspBBoxAttrColor ? this.inspBBoxAttrColor.value.trim() : '',
        state: this.inspBBoxAttrState ? this.inspBBoxAttrState.value.trim() : '',
        note: this.inspBBoxAttrNote ? this.inspBBoxAttrNote.value.trim() : ''
      };
      Object.keys(attrs).forEach(k => { if (!attrs[k]) delete attrs[k]; });
      await this.updateBBox(bb.bbox_id, { attributes: attrs });
    };

    if (this.inspBBoxAttrColor) this.inspBBoxAttrColor.addEventListener('change', updateAttrs);
    if (this.inspBBoxAttrState) this.inspBBoxAttrState.addEventListener('change', updateAttrs);
    if (this.inspBBoxAttrNote) this.inspBBoxAttrNote.addEventListener('change', updateAttrs);

    if (this.deleteSelectedBBoxBtn) {
      this.deleteSelectedBBoxBtn.addEventListener('click', async () => {
        const bb = this.getSelectedBBox();
        if (bb) await this.deleteBBox(bb.bbox_id);
      });
    }

    // Keyboard shortcuts for BBox mode
    window.addEventListener('keydown', async (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (this.app.currentWorkflow !== 'bbox') return;

      if (e.key === 'p' || e.key === 'P' || e.key === 'b' || e.key === 'B') {
        this.setTool('draw');
      } else if (e.key === 'v' || e.key === 'V') {
        this.setTool('select');
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const bb = this.getSelectedBBox();
        if (bb) {
          e.preventDefault();
          await this.deleteBBox(bb.bbox_id);
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        if (e.shiftKey) {
          e.preventDefault();
          await this.redo();
        } else {
          e.preventDefault();
          await this.undo();
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        await this.redo();
      } else if (/^[0-9]$/.test(e.key)) {
        const group = this.app.activeImage ? this.app.activeImage.density_group : 'same_object';
        const cats = this.app.pointWorkflow ? this.app.pointWorkflow.categories : [];
        const matched = cats.find(c => c.density_group === group && c.shortcut_key === e.key);
        if (matched) {
          await this.applyCategorySelection(matched.name, matched.color);
        }
      }
    });
  }

  lockedToast() {
    this.app.showToast('🔒 Image BBox is completed (locked). Press 🔓 Unlock or change status to In Progress to edit boxes.', 'error');
  }

  resetForImage() {
    this.undoStack = [];
    this.redoStack = [];
    this.deselectBBox();
  }

  setTool(tool) {
    this.activeTool = tool;
    this.viewport.bboxTool = tool;
    const btnAdd = document.getElementById('toolAddPoint');
    const btnSelect = document.getElementById('toolSelectPoint');
    if (this.app.currentWorkflow === 'bbox') {
      if (btnAdd) btnAdd.classList.toggle('active', tool === 'draw');
      if (btnSelect) btnSelect.classList.toggle('active', tool === 'select');
    }
  }

  renderCategoryGrid() {
    if (!this.categoryGrid) return;
    const group = this.app.activeImage ? this.app.activeImage.density_group : 'same_object';
    const cats = this.app.pointWorkflow ? this.app.pointWorkflow.categories : [];
    const groupCats = cats.filter(c => c.density_group === group);
    const displayCats = groupCats.length > 0 ? groupCats : cats;

    if (!displayCats.some(c => c.name === this.activeCategory) && displayCats.length > 0) {
      this.activeCategory = displayCats[0].name;
      this.activeColor = displayCats[0].color;
    }

    this.categoryGrid.innerHTML = '';
    displayCats.forEach(cat => {
      const btn = document.createElement('button');
      btn.className = `cat-btn ${cat.name === this.activeCategory ? 'active' : ''}`;
      btn.innerHTML = `
        <span class="cat-color-dot" style="background-color: ${cat.color}"></span>
        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${cat.name}</span>
        ${cat.shortcut_key ? `<span class="cat-key-badge">${cat.shortcut_key}</span>` : ''}
      `;
      btn.addEventListener('click', () => {
        this.applyCategorySelection(cat.name, cat.color);
      });
      this.categoryGrid.appendChild(btn);
    });

    if (this.inspBBoxCatSelect) {
      this.inspBBoxCatSelect.innerHTML = '';
      cats.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.name;
        opt.textContent = `${c.name} (${c.density_group === 'same_object' ? 'Same' : 'Mixed'})`;
        this.inspBBoxCatSelect.appendChild(opt);
      });
    }
  }

  async applyCategorySelection(name, color) {
    this.selectCategory(name, color);
    const bb = this.getSelectedBBox();
    if (!bb || bb.category === name) return;
    if (this.app.bboxLocked) {
      this.lockedToast();
      return;
    }
    const prev = { category: bb.category, color: bb.color };
    const next = { category: name, color };
    await this.updateBBox(bb.bbox_id, next);
    this.undoStack.push({ type: 'reclassify', bbox_id: bb.bbox_id, from: prev, to: next });
    this.redoStack = [];
    this.app.showToast(`Reclassified ${bb.bbox_id} → ${name}`, 'info');
  }

  selectCategory(name, color) {
    this.activeCategory = name;
    this.activeColor = color;
    this.renderCategoryGrid();
  }

  async createBBox(x, y, width, height, category, color, customId = null, pushUndo = true) {
    if (!this.app.activeImage) return null;
    if (this.app.bboxLocked) {
      this.lockedToast();
      return null;
    }
    const imgId = this.app.activeImage.image_id;

    try {
      const payload = { x, y, width, height, category, color, attributes: {} };
      if (customId) payload.bbox_id = customId;

      const res = await fetch(`/api/images/${imgId}/bboxes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Failed to create bbox');
      const newBB = await res.json();
      // The request may finish after the annotator switches to another image.
      if (this.app.activeImage?.image_id !== imgId) return newBB;

      if (newBB.bbox_status && this.app.activeImage) {
        this.app.activeImage.bbox_status = newBB.bbox_status;
        if (this.app.imageStatusSelect && this.app.currentWorkflow === 'bbox') {
          this.app.imageStatusSelect.value = newBB.bbox_status;
        }
      }

      this.viewport.bboxes.push(newBB);
      this.selectBBox(newBB);
      this.viewport.renderMinimapDots();
      this.viewport.requestOverlayRender();
      this.renderBBoxesSummary();
      this.app.updateActiveImageBadgeCounts();

      if (pushUndo) {
        this.undoStack.push({ type: 'add', bbox: { ...newBB } });
        this.redoStack = [];
      }

      const areaRatio = newBB.area_ratio ?? ((newBB.width_norm || 0) * (newBB.height_norm || 0));
      const areaPct = areaRatio * 100;
      if (areaPct >= 0.1) {
        this.app.showToast(`⚠️ BBox #${newBB.bbox_id} có diện tích ${areaPct.toFixed(3)}% (≥ 0.1%) — Vượt chuẩn Small Object!`, 'warning');
      } else {
        this.app.showToast(`✓ Đã tạo BBox #${newBB.bbox_id} (${areaPct.toFixed(3)}% · Small Object)`, 'success');
      }

      return newBB;
    } catch (err) {
      console.error(err);
      this.app.showToast('Error adding bounding box', 'error');
      return null;
    }
  }

  async updateBBox(bboxId, updates) {
    const imageId = this.app.activeImage?.image_id;
    if (this.app.bboxLocked) {
      this.lockedToast();
      return;
    }
    try {
      const res = await fetch(`/api/bboxes/${bboxId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      if (!res.ok) throw new Error('Failed to update bbox');
      const data = await res.json();

      if (this.app.activeImage?.image_id !== imageId) return false;

      const bb = this.viewport.bboxes.find(b => b.bbox_id === bboxId);
      if (bb) {
        Object.assign(bb, updates);
        if (data.x_norm !== undefined) {
          bb.x = data.x;
          bb.y = data.y;
          bb.width = data.width;
          bb.height = data.height;
          bb.x_norm = data.x_norm;
          bb.y_norm = data.y_norm;
          bb.width_norm = data.width_norm;
          bb.height_norm = data.height_norm;
          bb.area_ratio = data.area_ratio;
        }
        this.populateInspector(bb);
      }
      this.viewport.renderMinimapDots();
      this.viewport.requestOverlayRender();
      this.renderBBoxesSummary();
      return true;
    } catch (err) {
      console.error(err);
      this.app.showToast('Error updating bounding box', 'error');
      return false;
    }
  }

  async deleteBBox(bboxId, pushUndo = true) {
    const imageId = this.app.activeImage?.image_id;
    if (this.app.bboxLocked) {
      this.lockedToast();
      return;
    }
    const idx = this.viewport.bboxes.findIndex(b => b.bbox_id === bboxId);
    if (idx === -1) return;
    const removed = { ...this.viewport.bboxes[idx] };

    try {
      const res = await fetch(`/api/bboxes/${bboxId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete bbox failed');

      if (this.app.activeImage?.image_id !== imageId) return false;

      this.viewport.bboxes = this.viewport.bboxes.filter(bb => bb.bbox_id !== bboxId);
      if (this.viewport.selectedBBoxId === bboxId) {
        this.deselectBBox();
      }
      this.viewport.renderMinimapDots();
      this.viewport.requestOverlayRender();
      this.renderBBoxesSummary();
      this.app.updateActiveImageBadgeCounts();

      if (pushUndo) {
        this.undoStack.push({ type: 'delete', bbox: removed });
        this.redoStack = [];
      }
      this.app.showToast(`Deleted BBox ${bboxId}`, 'info');
      return true;
    } catch (err) {
      console.error(err);
      this.app.showToast('Error deleting bounding box', 'error');
    }
  }

  async clearAllBBoxes() {
    if (!this.app.activeImage || this.viewport.bboxes.length === 0) return;
    if (this.app.bboxLocked) {
      this.lockedToast();
      return;
    }
    if (!confirm(`Clear all ${this.viewport.bboxes.length} bounding boxes on this image?`)) return;

    const backupBBoxes = this.viewport.bboxes.map(b => ({ ...b }));
    const imgId = this.app.activeImage.image_id;

    try {
      const res = await fetch(`/api/images/${imgId}/bboxes`, { method: 'DELETE' });
      if (res.ok) {
        this.undoStack.push({ type: 'clear', bboxes: backupBBoxes });
        this.redoStack = [];
        this.viewport.setBBoxes([]);
        this.deselectBBox();
        this.renderBBoxesSummary();
        this.app.updateActiveImageBadgeCounts();
        this.app.showToast('Cleared all bounding boxes on image', 'info');
      }
    } catch (err) {
      console.error(err);
    }
  }

  async undo() {
    if (this.app.bboxLocked) {
      this.lockedToast();
      return;
    }
    if (this.undoStack.length === 0) {
      this.app.showToast('Nothing to undo', 'info');
      return;
    }
    const action = this.undoStack.pop();
    this.redoStack.push(action);

    if (action.type === 'add') {
      await this.deleteBBox(action.bbox.bbox_id, false);
    } else if (action.type === 'delete') {
      const b = action.bbox;
      await this.createBBox(b.x, b.y, b.width, b.height, b.category, b.color, b.bbox_id, false);
    } else if (action.type === 'move_resize') {
      await this.updateBBox(action.bbox_id, action.from);
    } else if (action.type === 'reclassify') {
      await this.updateBBox(action.bbox_id, action.from);
    } else if (action.type === 'clear') {
      await this.restoreBBoxesBatch(action.bboxes);
    }
  }

  async redo() {
    if (this.app.bboxLocked) {
      this.lockedToast();
      return;
    }
    if (this.redoStack.length === 0) {
      this.app.showToast('Nothing to redo', 'info');
      return;
    }
    const action = this.redoStack.pop();
    this.undoStack.push(action);

    if (action.type === 'add') {
      const b = action.bbox;
      await this.createBBox(b.x, b.y, b.width, b.height, b.category, b.color, b.bbox_id, false);
    } else if (action.type === 'delete') {
      await this.deleteBBox(action.bbox.bbox_id, false);
    } else if (action.type === 'move_resize') {
      await this.updateBBox(action.bbox_id, action.to);
    } else if (action.type === 'reclassify') {
      await this.updateBBox(action.bbox_id, action.to);
    } else if (action.type === 'clear') {
      if (!this.app.activeImage) return;
      const imgId = this.app.activeImage.image_id;
      const res = await fetch(`/api/images/${imgId}/bboxes`, { method: 'DELETE' });
      if (res.ok) {
        this.viewport.setBBoxes([]);
        this.deselectBBox();
        this.renderBBoxesSummary();
        this.app.updateActiveImageBadgeCounts();
      }
    }
  }

  async restoreBBoxesBatch(bboxes) {
    if (!this.app.activeImage || !bboxes || bboxes.length === 0) return;
    const imgId = this.app.activeImage.image_id;
    try {
      const res = await fetch(`/api/images/${imgId}/bboxes/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bboxes.map(b => ({
          bbox_id: b.bbox_id,
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          category: b.category,
          color: b.color,
          attributes: b.attributes || {}
        })))
      });
      if (!res.ok) throw new Error('Batch restore bboxes failed');
      const detailRes = await fetch(`/api/images/${imgId}`);
      if (detailRes.ok) {
        const fullImg = await detailRes.json();
        this.viewport.setBBoxes(fullImg.bboxes || []);
        this.renderBBoxesSummary();
        this.app.updateActiveImageBadgeCounts();
      }
    } catch (err) {
      console.error(err);
      this.app.showToast('Failed to restore bounding boxes', 'error');
    }
  }

  selectBBox(bb) {
    this.viewport.setSelectedBBox(bb.bbox_id);
    if (this.inspectorSection) {
      this.inspectorSection.style.display = 'flex';
      this.populateInspector(bb);
    }
  }

  deselectBBox() {
    this.viewport.setSelectedBBox(null);
    if (this.inspectorSection) {
      this.inspectorSection.style.display = 'none';
    }
    if (this.inspBBoxAreaAlert) {
      this.inspBBoxAreaAlert.innerHTML = '';
    }
  }

  getSelectedBBox() {
    if (!this.viewport.selectedBBoxId) return null;
    return this.viewport.bboxes.find(b => b.bbox_id === this.viewport.selectedBBoxId);
  }

  populateInspector(bb) {
    if (!this.inspectorSection || !bb) return;
    this.inspBBoxId.textContent = bb.bbox_id;
    this.inspBBoxX.value = Math.round(bb.x * 10) / 10;
    this.inspBBoxY.value = Math.round(bb.y * 10) / 10;
    this.inspBBoxW.value = Math.round(bb.width * 10) / 10;
    this.inspBBoxH.value = Math.round(bb.height * 10) / 10;

    if (this.inspBBoxNorm) {
      this.inspBBoxNorm.textContent = `[${bb.x_norm}, ${bb.y_norm}, ${bb.width_norm}, ${bb.height_norm}]`;
    }
    const areaPct = (bb.area_ratio || (bb.width_norm * bb.height_norm) || 0) * 100;
    const isSmall = areaPct < 0.1;
    const pctStr = areaPct < 0.01 ? areaPct.toFixed(4) : areaPct.toFixed(3);

    if (this.inspBBoxArea) {
      this.inspBBoxArea.innerHTML = `${pctStr}% <span class="bbox-size-badge ${isSmall ? 'size-small' : 'size-large'}">${isSmall ? 'Small (<0.1%)' : 'Large (≥0.1%)'}</span>`;
    }

    if (this.inspBBoxAreaAlert) {
      if (!isSmall) {
        this.inspBBoxAreaAlert.innerHTML = `
          <div class="bbox-area-alert alert-warning">
            <div class="font-bold flex items-center gap-1">⚠️ CẢNH BÁO: Diện tích ≥ 0.1% (${pctStr}%)</div>
            <div class="text-xs mt-0.5">Bounding box này là <b>Large Object</b>. Chuẩn visual search small object yêu cầu diện tích <b>&lt; 0.1%</b> toàn ảnh.</div>
          </div>
        `;
      } else {
        this.inspBBoxAreaAlert.innerHTML = `
          <div class="bbox-area-alert alert-success">
            <div class="font-bold flex items-center gap-1">✓ Chuẩn Small Object (${pctStr}%)</div>
            <div class="text-xs mt-0.5">Diện tích &lt; 0.1% toàn ảnh, đạt tiêu chuẩn small visual search target.</div>
          </div>
        `;
      }
    }
    if (this.inspBBoxCatSelect) this.inspBBoxCatSelect.value = bb.category;
    if (this.inspBBoxColorInput) this.inspBBoxColorInput.value = bb.color || '#EF4444';

    const attrs = bb.attributes || {};
    if (this.inspBBoxAttrColor) this.inspBBoxAttrColor.value = attrs.color || '';
    if (this.inspBBoxAttrState) this.inspBBoxAttrState.value = attrs.state || '';
    if (this.inspBBoxAttrNote) this.inspBBoxAttrNote.value = attrs.note || '';
  }

  renderBBoxesSummary() {
    const bboxes = this.viewport.bboxes || [];
    if (this.totalBBoxesBadge) {
      this.totalBBoxesBadge.textContent = `${bboxes.length} boxes`;
    }

    if (this.bboxesBreakdownContainer) {
      const counts = {};
      let smallCount = 0;
      bboxes.forEach(b => {
        counts[b.category] = (counts[b.category] || 0) + 1;
        const areaRatio = b.area_ratio ?? ((b.width_norm || 0) * (b.height_norm || 0));
        if (areaRatio < 0.001) smallCount += 1;
      });
      this.bboxesBreakdownContainer.innerHTML = '';

      if (bboxes.length > 0) {
        const sizePill = document.createElement('div');
        sizePill.style.cssText = 'font-size: 0.7rem; background: var(--bg-secondary); padding: 3px 7px; border-radius: 4px; border: 1px solid var(--border-color); width: 100%; display: flex; justify-content: space-between;';
        sizePill.innerHTML = `<span>🔍 Small (<0.1%): <strong style="color:#38bdf8;">${smallCount}</strong></span> <span>📐 Large (≥0.1%): <strong style="color:#fbbf24;">${bboxes.length - smallCount}</strong></span>`;
        this.bboxesBreakdownContainer.appendChild(sizePill);
      }

      Object.entries(counts).forEach(([cat, count]) => {
        const pill = document.createElement('div');
        pill.style.cssText = 'font-size: 0.72rem; background: var(--bg-secondary); padding: 3px 7px; border-radius: 4px; border: 1px solid var(--border-color); display: flex; justify-content: space-between; gap: 6px;';
        pill.innerHTML = `<span>${cat}</span> <strong style="font-family:var(--font-mono); color:var(--accent-primary);">${count}</strong>`;
        this.bboxesBreakdownContainer.appendChild(pill);
      });
    }

    if (this.bboxesTableBody) {
      this.bboxesTableBody.innerHTML = '';
      const displayBBoxes = bboxes.slice(-150);
      displayBBoxes.forEach(b => {
        const areaPct = ((b.area_ratio ?? ((b.width_norm || 0) * (b.height_norm || 0))) * 100);
        const pctStr = areaPct < 0.01 ? areaPct.toFixed(4) : areaPct.toFixed(2);
        const tr = document.createElement('tr');
        tr.style.cssText = 'cursor: pointer; border-bottom: 1px solid var(--border-color); font-size: 0.72rem;';
        if (b.bbox_id === this.viewport.selectedBBoxId) {
          tr.style.background = 'rgba(99, 102, 241, 0.15)';
        }
        tr.innerHTML = `
          <td style="padding: 4px; font-family: var(--font-mono);">${b.bbox_id}</td>
          <td style="padding: 4px;"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${b.color};margin-right:4px;"></span>${b.category}</td>
          <td style="padding: 4px; font-family: var(--font-mono);">${Math.round(b.x)},${Math.round(b.y)} (${Math.round(b.width)}×${Math.round(b.height)})</td>
          <td style="padding: 4px; font-family: var(--font-mono); color:${areaPct < 0.1 ? '#38bdf8' : '#fbbf24'};">${pctStr}%</td>
          <td style="padding: 4px; text-align:right;">
            <button class="del-bb-row-btn" data-id="${b.bbox_id}" style="background:none;border:none;color:#fca5a5;cursor:pointer;">&times;</button>
          </td>
        `;
        tr.addEventListener('click', (e) => {
          if (e.target.classList.contains('del-bb-row-btn')) return;
          this.selectBBox(b);
          this.viewport.centerOnBBox(b.bbox_id);
        });
        const delBtn = tr.querySelector('.del-bb-row-btn');
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.deleteBBox(b.bbox_id);
        });
        this.bboxesTableBody.appendChild(tr);
      });
    }
  }
}
