/**
 * QAWorkflow Module
 * Logic for Mode 3: Question–Answer (Visual Search Sample) Annotation Mode.
 * Implements the 12-field BBox annotation sample specification:
 * 1. image_id (Required)
 * 2. density_category (Required: 'people' | 'animal' | 'vehicle')
 * 3. question_id (Required)
 * 4. question_type (Required: 'Attribute' | 'Spatial' | 'Relation')
 * 5. target_group (Required: 'Same-density' | 'Different-density')
 * 6. question (Required, English)
 * 7. answer (Required, short & objective)
 * 8. target_bbox (Required; 1 visible bbox)
 * 9. reference_bboxes (Optional; up to 2 landmark bboxes)
 * 10. uniqueness_verified (Required; must be true)
 * 11. bbox_area_ratio (Computed automatically)
 * 12. bbox_size_warning (Computed automatically)
 */

export class QAWorkflow {
  constructor(app) {
    this.app = app;
    this.viewport = app.viewport;

    // State
    this.qaList = [];
    this.selectedQAId = null;
    this.editingQA = null;
    this.pickingMode = null; // 'target' | 'reference' | null
    this.locked = false;
    this.creatingBBox = false;
    this.bboxClass = app.bboxWorkflow.activeCategory;
    this.addingClass = false;

    this.initElements();
    this.initEvents();
  }

  initElements() {
    this.qaListContainer = document.getElementById('qaListContainer');
    this.qaCountBadge = document.getElementById('qaCountBadge');
    this.newQABtn = document.getElementById('newQABtn');

    // QA Form / Modal elements
    this.qaEditorCard = document.getElementById('qaEditorCard');
    this.qaEditorTitle = document.getElementById('qaEditorTitle');
    this.qaImageIdBadge = document.getElementById('qaImageIdBadge');
    this.qaQuestionIdInput = document.getElementById('qaQuestionIdInput');
    this.qaDensityCategorySelect = document.getElementById('qaDensityCategorySelect');
    this.qaQuestionTypeSelect = document.getElementById('qaQuestionTypeSelect');
    this.qaTargetGroupSelect = document.getElementById('qaTargetGroupSelect');
    this.qaQuestionInput = document.getElementById('qaQuestionInput');
    this.qaAnswerInput = document.getElementById('qaAnswerInput');

    // BBox Picking controls
    this.togglePickTargetBBoxBtn = document.getElementById('togglePickTargetBBoxBtn');
    this.qaTargetBBoxContainer = document.getElementById('qaTargetBBoxContainer');
    this.qaTargetBBoxContainer?.addEventListener('click', e => {
      if (!e.target.closest('button')) this.selectBBoxForClass(this.editingQA?.target_bbox?.bbox_id);
    });
    if (this.qaTargetBBoxContainer) this.qaTargetBBoxContainer.title = 'Click to select this BBox and edit its class';
    this.qaTargetBBoxAlert = document.getElementById('qaTargetBBoxAlert');
    this.togglePickRefBBoxesBtn = document.getElementById('togglePickRefBBoxesBtn');
    this.qaRefBBoxesContainer = document.getElementById('qaRefBBoxesContainer');
    this.qaBBoxCategorySelect = document.getElementById('qaBBoxCategorySelect');
    this.qaSelectedBBoxId = document.getElementById('qaSelectedBBoxId');
    this.qaBBoxClassPalette = document.getElementById('qaBBoxClassPalette');
    this.qaCustomClassInput = this.qaBBoxCategorySelect;
    this.qaBBoxClassSuggestions = document.getElementById('qaBBoxClassSuggestions');
    this.qaCustomClassColor = document.getElementById('qaCustomClassColor');
    this.qaAddCustomClassBtn = document.getElementById('qaAddCustomClassBtn');
    this.qaBBoxCategorySelect?.addEventListener('change', () => {
      const name = this.qaBBoxCategorySelect.value.trim().toLowerCase().replace(/\s+/g, '_');
      if (this.app.pointWorkflow.categories.some(c => c.name === name)) this.useBBoxClass(name);
    });
    this.qaAddCustomClassBtn?.addEventListener('click', () => this.addCustomBBoxClass());
    this.qaCustomClassInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this.addCustomBBoxClass(); }
    });
    document.getElementById('qaDeselectBBoxBtn')?.addEventListener('click', () => {
      this.viewport.selectedBBoxId = null;
      this.renderSelectedBBoxClass();
      this.viewport.requestOverlayRender();
    });
    this.qaBBoxDrawHint = document.getElementById('qaBBoxDrawHint');
    this.qaDeleteBBoxBtn = document.getElementById('qaDeleteBBoxBtn');
    this.qaDeleteBBoxBtn?.addEventListener('click', () => this.deleteSelectedBBox());

    // Uniqueness Checkbox
    this.qaUniquenessVerifiedCheck = document.getElementById('qaUniquenessVerifiedCheck');

    this.saveQABtn = document.getElementById('saveQABtn');
    this.cancelQABtn = document.getElementById('cancelQABtn');

    if (this.newQABtn) {
      this.newQABtn.addEventListener('click', () => this.startNewQA());
    }
    if (this.saveQABtn) {
      this.saveQABtn.addEventListener('click', () => this.saveQA());
    }
    if (this.cancelQABtn) {
      this.cancelQABtn.addEventListener('click', () => this.cancelQAEditor());
    }

    if (this.togglePickTargetBBoxBtn) {
      this.togglePickTargetBBoxBtn.addEventListener('click', () => {
        this.pickingMode = (this.pickingMode === 'target') ? null : 'target';
        this.updatePickingButtons();
        if (this.pickingMode === 'target') {
          this.app.showToast('🎯 Click an existing box or drag to create a new Target BBox. Hold Space to pan.', 'info');
        }
      });
    }

    if (this.togglePickRefBBoxesBtn) {
      this.togglePickRefBBoxesBtn.addEventListener('click', () => {
        this.pickingMode = (this.pickingMode === 'reference') ? null : 'reference';
        this.updatePickingButtons();
        if (this.pickingMode === 'reference') {
          this.app.showToast('📍 Click existing boxes or drag to create Reference BBoxes (max 2). Hold Space to pan.', 'info');
        }
      });
    }
  }

  initEvents() {
    this.viewport.canEditQABBox = () => !!(this.editingQA && !this.locked && !this.app.bboxLocked && !this.creatingBBox && !this.addingClass);
    const originalChangeEnd = this.viewport.onBBoxChangeEnd;
    this.viewport.onBBoxChangeEnd = async (bb, original) => {
      if (this.app.currentWorkflow !== 'qa') return originalChangeEnd?.(bb, original);
      if (!this.viewport.canEditQABBox()) {
        Object.assign(bb, original);
        this.viewport.requestOverlayRender();
        return;
      }
      this.creatingBBox = true;
      const imageId = this.app.activeImage?.image_id;
      try {
        const saved = await this.app.bboxWorkflow.updateBBox(bb.bbox_id, {
          x: bb.x, y: bb.y, width: bb.width, height: bb.height
        });
        if (!saved) Object.assign(bb, original);
        if (this.app.activeImage?.image_id === imageId) this.syncBBoxInQA(bb.bbox_id, bb);
      } finally {
        this.creatingBBox = false;
        this.renderSelectedBBoxClass();
        this.viewport.requestOverlayRender();
      }
    };
    window.addEventListener('keydown', e => {
      if (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (this.app.currentWorkflow === 'qa' && this.viewport.canEditQABBox() && ['Delete', 'Backspace'].includes(e.key)) {
        e.preventDefault();
        this.deleteSelectedBBox();
      }
    });
    this.viewport.isPickingQABBox = () => !!(this.editingQA && this.pickingMode && !this.locked);
    this.viewport.canDrawQABBox = () => !!(
      this.editingQA && this.pickingMode && !this.locked &&
      !this.app.bboxLocked && !this.creatingBBox && !this.addingClass
    );
    const originalDraftStyle = this.viewport.getActiveBBoxDraftStyle;
    this.viewport.getActiveBBoxDraftStyle = () => {
      if (this.app.currentWorkflow === 'qa' && this.editingQA) {
        const category = this.bboxClass || this.app.bboxWorkflow.activeCategory;
        const cat = this.app.pointWorkflow.categories.find(c => c.name === category);
        return { category, color: cat?.color || this.app.bboxWorkflow.activeColor };
      }
      return originalDraftStyle?.();
    };
    const originalBBoxCreate = this.viewport.onBBoxCreate;
    this.viewport.onBBoxCreate = (rect) => {
      if (this.app.currentWorkflow === 'qa') return this.createPickedBBox(rect);
      return originalBBoxCreate?.(rect);
    };

    // When BBox is clicked in QA mode
    const origBBoxClick = this.viewport.onBBoxClick;
    this.viewport.onBBoxClick = (bb, e) => {
      if (this.app.currentWorkflow === 'qa' && !bb) this.renderSelectedBBoxClass();
      if (this.app.currentWorkflow === 'qa' && this.editingQA && !this.locked && !this.creatingBBox && bb) {
        this.viewport.selectedBBoxId = bb.bbox_id;
        this.bboxClass = bb.category;
        this.renderSelectedBBoxClass();
        this.viewport.requestOverlayRender();
        if (this.pickingMode === 'target') {
          this.setTargetBBox(bb);
          this.pickingMode = null;
          this.updatePickingButtons();
          this.focusBBoxClassInput();
          return;
        } else if (this.pickingMode === 'reference') {
          this.toggleRefBBox(bb);
          this.updatePickingButtons();
          this.focusBBoxClassInput();
          return;
        }
        this.focusBBoxClassInput();
      }
      if (origBBoxClick) origBBoxClick(bb, e);
    };
  }

  resetForImage() {
    this.cancelBBoxResize();
    this.viewport.drawingBBox = null;
    this.editingQA = null;
    this.pickingMode = null;
    this.selectedQAId = null;
    if (this.qaEditorCard) this.qaEditorCard.style.display = 'none';
    this.viewport.setActiveQATargets([], [], []);
  }

  setQAList(list) {
    this.qaList = list || [];
    this.renderQAList();
    if (this.qaCountBadge) {
      this.qaCountBadge.textContent = `${this.qaList.length} Samples`;
    }
  }

  setLocked(locked) {
    this.locked = locked;
    if (this.newQABtn) this.newQABtn.disabled = locked;
    if (locked && this.editingQA) this.cancelQAEditor();
    this.updatePickingButtons();
    this.renderQAList();
  }

  lockedToast() {
    this.app.showToast('🔒 QA is completed (locked). Press 🔓 Unlock QA or change status to edit samples.', 'error');
  }

  updatePickingButtons() {
    this.renderSelectedBBoxClass();
    this.viewport.drawingBBox = null;
    this.viewport.requestOverlayRender();
    if (this.qaBBoxDrawHint) {
      this.qaBBoxDrawHint.textContent = this.app.bboxLocked
        ? 'BBox is locked. Unlock in BBox mode to draw new boxes. Existing boxes can still be picked.'
        : 'Click to select; drag to create while picking. Drag selected box handles to resize; Delete removes the selected box. Hold Space to pan. Box changes are saved immediately.';
    }
    if (this.togglePickTargetBBoxBtn) {
      if (this.pickingMode === 'target') {
        this.togglePickTargetBBoxBtn.className = 'btn btn-success active';
        this.togglePickTargetBBoxBtn.textContent = '🎯 Click / Drag Target...';
      } else {
        this.togglePickTargetBBoxBtn.className = 'btn btn-success';
        this.togglePickTargetBBoxBtn.textContent = '🎯 Pick Target BBox';
      }
    }
    if (this.togglePickRefBBoxesBtn) {
      if (this.pickingMode === 'reference') {
        this.togglePickRefBBoxesBtn.className = 'btn active';
        this.togglePickRefBBoxesBtn.style.background = '#6366f1';
        this.togglePickRefBBoxesBtn.style.color = '#fff';
        this.togglePickRefBBoxesBtn.textContent = '📍 Click / Drag Ref (0-2)...';
      } else {
        this.togglePickRefBBoxesBtn.className = 'btn';
        this.togglePickRefBBoxesBtn.style.background = '#4f46e5';
        this.togglePickRefBBoxesBtn.style.color = '#fff';
        this.togglePickRefBBoxesBtn.textContent = '📍 Pick Ref BBoxes';
      }
    }
  }

  cancelBBoxResize() {
    if (this.viewport.draggingBBox) {
      Object.assign(this.viewport.draggingBBox.bbox, this.viewport.draggingBBox.origRect);
      this.viewport.draggingBBox = null;
    }
  }

  renderSelectedBBoxClass() {
    const select = this.qaBBoxCategorySelect;
    if (!select) return;
    const bb = this.viewport.bboxes.find(b => b.bbox_id === this.viewport.selectedBBoxId);
    if (this.qaSelectedBBoxId) this.qaSelectedBBoxId.textContent = bb ? `— #${bb.bbox_id}` : '— bbox mới';
    this.qaBBoxClassSuggestions?.replaceChildren();
    const categories = [...this.app.pointWorkflow.categories];
    if (bb && !categories.some(c => c.name === bb.category)) categories.push({ name: bb.category });
    const currentClass = bb?.category || this.bboxClass;
    if (!categories.some(c => c.name === currentClass) && categories.length) this.bboxClass = categories[0].name;
    categories.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat.name;
        option.textContent = cat.name;
        this.qaBBoxClassSuggestions?.appendChild(option);
    });
    select.value = bb?.category || this.bboxClass || '';
    const disabled = !this.viewport.canEditQABBox() || !!this.viewport.draggingBBox || this.addingClass;
    select.disabled = disabled;
    if (this.qaAddCustomClassBtn) this.qaAddCustomClassBtn.disabled = disabled;
    if (this.qaDeleteBBoxBtn) this.qaDeleteBBoxBtn.disabled = disabled || !bb;
    if (this.qaBBoxClassPalette) {
      this.qaBBoxClassPalette.replaceChildren();
      categories.forEach(cat => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `cat-btn ${cat.name === select.value ? 'active' : ''}`;
        button.textContent = cat.name;
        button.style.borderLeft = `4px solid ${cat.color || '#10b981'}`;
        button.disabled = disabled;
        button.addEventListener('click', () => this.useBBoxClass(cat.name));
        this.qaBBoxClassPalette.appendChild(button);
      });
    }
  }

  async useBBoxClass(category) {
    if (!this.viewport.canEditQABBox() || this.viewport.draggingBBox || this.addingClass) return;
    if (!this.app.pointWorkflow.categories.some(c => c.name === category)) return;
    this.bboxClass = category;
    await this.changeSelectedBBoxClass(category);
    this.renderSelectedBBoxClass();
  }

  selectBBoxForClass(id) {
    const bb = this.viewport.bboxes.find(b => b.bbox_id === id);
    if (!bb || !this.editingQA || this.creatingBBox || this.addingClass) return;
    this.viewport.selectedBBoxId = id;
    this.bboxClass = bb.category;
    this.pickingMode = null;
    this.updatePickingButtons();
    this.focusBBoxClassInput();
  }

  focusBBoxClassInput() {
    if (this.qaBBoxCategorySelect && !this.qaBBoxCategorySelect.disabled) {
      this.qaBBoxCategorySelect.focus({ preventScroll: true });
      this.qaBBoxCategorySelect.select();
    }
  }

  async addCustomBBoxClass() {
    if (this.addingClass || !this.viewport.canEditQABBox() || this.viewport.draggingBBox) return;
    const name = (this.qaCustomClassInput?.value || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (!name) {
      this.qaCustomClassInput?.focus();
      return;
    }
    const editor = this.editingQA;
    const typedName = this.qaCustomClassInput?.value || '';
    let failed = false;
    const selectedId = this.viewport.selectedBBoxId;
    const imageId = this.app.activeImage?.image_id;
    this.addingClass = true;
    this.renderSelectedBBoxClass();
    try {
      if (!this.app.pointWorkflow.categories.some(c => c.name === name)) {
        const color = this.qaCustomClassColor?.value || '#10b981';
        const response = await fetch('/api/categories', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color, density_group: this.app.activeImage?.density_group || 'mixed_object' })
        });
        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.detail || 'Không thể tạo class');
        }
        await this.app.pointWorkflow.loadCategories();
        if (!this.app.pointWorkflow.categories.some(c => c.name === name)) throw new Error('Không tải được class mới. Vui lòng thử lại.');
      }
      if (this.editingQA !== editor || this.app.activeImage?.image_id !== imageId) return;
      this.addingClass = false;
      if (this.viewport.selectedBBoxId === selectedId) await this.useBBoxClass(name);
      else this.bboxClass = name;
      if (this.qaCustomClassInput) this.qaCustomClassInput.value = '';
      this.app.showToast(`Class sẵn sàng: ${name}`, 'success');
    } catch (error) {
      failed = true;
      this.app.showToast(error.message || 'Không thể tạo class', 'error');
    } finally {
      this.addingClass = false;
      this.renderSelectedBBoxClass();
      if (this.editingQA === editor) {
        if (failed && this.qaCustomClassInput) this.qaCustomClassInput.value = typedName;
        this.focusBBoxClassInput();
      }
    }
  }

  async changeSelectedBBoxClass(category) {
    const bb = this.viewport.bboxes.find(b => b.bbox_id === this.viewport.selectedBBoxId);
    const cat = this.app.pointWorkflow.categories.find(c => c.name === category);
    if (!bb || !cat || !this.viewport.canEditQABBox() || this.viewport.draggingBBox || bb.category === category) {
      this.renderSelectedBBoxClass();
      return;
    }
    const imageId = this.app.activeImage?.image_id;
    this.creatingBBox = true;
    this.renderSelectedBBoxClass();
    try {
      const saved = await this.app.bboxWorkflow.updateBBox(bb.bbox_id, { category: cat.name, color: cat.color });
      if (saved && this.app.activeImage?.image_id === imageId) {
        this.syncBBoxInQA(bb.bbox_id, bb);
        this.app.showToast(`Updated BBox #${bb.bbox_id} class to ${cat.name}`, 'success');
      }
    } finally {
      this.creatingBBox = false;
      this.renderSelectedBBoxClass();
    }
  }

  syncBBoxInQA(id, bbox) {
    this.renderSelectedBBoxClass();
    const sync = qa => {
      if (qa.target_bbox?.bbox_id === id || qa.target_bbox_ids?.includes(id)) {
        qa.target_bbox = bbox ? { ...bbox } : null;
        qa.target_bbox_ids = bbox ? [id] : [];
        qa.bbox_area_ratio = bbox ? +(bbox.width / this.viewport.naturalWidth * bbox.height / this.viewport.naturalHeight).toFixed(8) : 0;
        if (qa.target_bbox) qa.target_bbox.area_ratio = qa.bbox_area_ratio;
        qa.bbox_size_warning = qa.bbox_area_ratio >= 0.001 ? 'warning_large_object' : 'ok_small_object';
      }
      qa.reference_bboxes = (qa.reference_bboxes || []).flatMap(ref => ref.bbox_id !== id ? [ref] : bbox ? [{ ...bbox }] : []);
    };
    this.qaList.forEach(sync);
    if (this.editingQA) {
      sync(this.editingQA);
      this.renderTargetBBoxUI();
      this.renderRefBBoxesUI();
      this.syncViewportHighlights();
    }
    this.renderQAList();
  }

  async deleteSelectedBBox() {
    if (!this.viewport.canEditQABBox()) return;
    const id = this.viewport.selectedBBoxId;
    if (!id) return;
    this.creatingBBox = true;
    try {
      if (await this.app.bboxWorkflow.deleteBBox(id)) this.syncBBoxInQA(id, null);
    } finally {
      this.creatingBBox = false;
      this.renderSelectedBBoxClass();
    }
  }

  async createPickedBBox(rect) {
    if (!this.viewport.canDrawQABBox()) return;
    const editor = this.editingQA;
    const mode = this.pickingMode;
    if (mode === 'reference' && (editor.reference_bboxes || []).length >= 2) {
      this.app.showToast('Maximum 2 Reference BBoxes. Remove one before adding another.', 'warning');
      return;
    }
    const style = this.viewport.getActiveBBoxDraftStyle();
    this.creatingBBox = true;
    try {
      const bb = await this.app.bboxWorkflow.createBBox(
        rect.x, rect.y, rect.width, rect.height, style.category, style.color
      );
      if (!bb || this.editingQA !== editor || this.locked) return;
      if (mode === 'target') {
        this.setTargetBBox(bb);
        if (this.pickingMode === mode) this.pickingMode = null;
      } else {
        this.toggleRefBBox(bb);
      }
      this.updatePickingButtons();
    } finally {
      this.creatingBBox = false;
      this.renderSelectedBBoxClass();
      if (this.editingQA === editor) this.focusBBoxClassInput();
    }
  }

  setTargetBBox(bb) {
    if (!this.editingQA || !bb) return;
    const W = this.viewport.naturalWidth || 1;
    const H = this.viewport.naturalHeight || 1;
    const wNorm = +(bb.width / W).toFixed(6);
    const hNorm = +(bb.height / H).toFixed(6);
    const areaRatio = +(wNorm * hNorm).toFixed(8);

    this.editingQA.target_bbox = {
      bbox_id: bb.bbox_id,
      category: bb.category,
      x: round1(bb.x),
      y: round1(bb.y),
      width: round1(bb.width),
      height: round1(bb.height),
      x_norm: +(bb.x / W).toFixed(6),
      y_norm: +(bb.y / H).toFixed(6),
      width_norm: wNorm,
      height_norm: hNorm,
      area_ratio: areaRatio
    };
    this.editingQA.target_bbox_ids = [bb.bbox_id];
    this.editingQA.bbox_area_ratio = areaRatio;
    this.editingQA.bbox_size_warning = (areaRatio >= 0.001) ? 'warning_large_object' : 'ok_small_object';

    // Remove from reference if it was there
    if (this.editingQA.reference_bboxes) {
      this.editingQA.reference_bboxes = this.editingQA.reference_bboxes.filter(r => r.bbox_id !== bb.bbox_id);
    }

    // Auto-suggest density category based on bbox category
    if (this.qaDensityCategorySelect) {
      const c = (bb.category || '').toLowerCase();
      if (/dog|cat|animal|horse|sheep|cow|bird|bear|elephant|lion/.test(c)) {
        this.qaDensityCategorySelect.value = 'animal';
      } else if (/car|truck|bus|bike|motor|vehicle|train|boat|plane/.test(c)) {
        this.qaDensityCategorySelect.value = 'vehicle';
      } else {
        this.qaDensityCategorySelect.value = 'people';
      }
    }

    this.renderTargetBBoxUI();
    this.renderRefBBoxesUI();
    this.syncViewportHighlights();
    this.app.showToast(`🎯 Linked Target BBox #${bb.bbox_id} (${(areaRatio * 100).toFixed(3)}%)`, 'success');
  }

  toggleRefBBox(bb) {
    if (!this.editingQA || !bb) return;
    if (this.editingQA.target_bbox && this.editingQA.target_bbox.bbox_id === bb.bbox_id) {
      this.app.showToast('⚠️ BBox này đang là Target BBox, không thể chọn làm Reference BBox!', 'warning');
      return;
    }

    this.editingQA.reference_bboxes = this.editingQA.reference_bboxes || [];
    const idx = this.editingQA.reference_bboxes.findIndex(r => r.bbox_id === bb.bbox_id);

    if (idx >= 0) {
      this.editingQA.reference_bboxes.splice(idx, 1);
      this.app.showToast(`Removed Reference BBox #${bb.bbox_id}`, 'info');
    } else {
      if (this.editingQA.reference_bboxes.length >= 2) {
        this.app.showToast('⚠️ Tối đa 2 Reference BBoxes cho một sample!', 'warning');
        return;
      }
      const W = this.viewport.naturalWidth || 1;
      const H = this.viewport.naturalHeight || 1;
      const wNorm = +(bb.width / W).toFixed(6);
      const hNorm = +(bb.height / H).toFixed(6);
      this.editingQA.reference_bboxes.push({
        bbox_id: bb.bbox_id,
        category: bb.category,
        x: round1(bb.x),
        y: round1(bb.y),
        width: round1(bb.width),
        height: round1(bb.height),
        x_norm: +(bb.x / W).toFixed(6),
        y_norm: +(bb.y / H).toFixed(6),
        width_norm: wNorm,
        height_norm: hNorm,
        area_ratio: +(wNorm * hNorm).toFixed(8)
      });
      this.app.showToast(`📍 Added Reference BBox #${bb.bbox_id} (${this.editingQA.reference_bboxes.length}/2)`, 'info');
    }

    this.renderRefBBoxesUI();
    this.syncViewportHighlights();
  }

  renderTargetBBoxUI() {
    if (!this.qaTargetBBoxContainer || !this.editingQA) return;
    const tb = this.editingQA.target_bbox;

    if (!tb || !tb.bbox_id) {
      this.qaTargetBBoxContainer.innerHTML = `
        <span style="color: var(--text-muted); font-size: 0.72rem; font-style: italic;">
          No target bbox selected. Click <strong>'🎯 Pick Target BBox'</strong> then click a box or drag to draw a new one.
        </span>
      `;
      if (this.qaTargetBBoxAlert) {
        this.qaTargetBBoxAlert.style.display = 'none';
        this.qaTargetBBoxAlert.innerHTML = '';
      }
      return;
    }

    const areaPct = (tb.area_ratio || 0) * 100;
    const isLarge = areaPct >= 0.1;
    const pctStr = areaPct < 0.01 ? areaPct.toFixed(4) : areaPct.toFixed(3);

    this.qaTargetBBoxContainer.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; background:var(--bg-secondary); padding:4px 8px; border-radius:4px; border:1px solid #10b981;">
        <span style="font-family:var(--font-mono); font-weight:600; color:#34d399;">
          🎯 ${tb.bbox_id} · ${tb.category} [${Math.round(tb.width)}×${Math.round(tb.height)}px] (${pctStr}%)
        </span>
        <button type="button" class="btn btn-icon" id="clearTargetBBoxBtn" title="Clear target bbox" style="width:20px; height:20px; line-height:1; padding:0; color:#ef4444;">&times;</button>
      </div>
    `;

    const clearBtn = document.getElementById('clearTargetBBoxBtn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        this.editingQA.target_bbox = null;
        this.editingQA.target_bbox_ids = [];
        this.editingQA.bbox_area_ratio = 0.0;
        this.editingQA.bbox_size_warning = 'ok_small_object';
        this.renderTargetBBoxUI();
        this.syncViewportHighlights();
      });
    }

    if (this.qaTargetBBoxAlert) {
      this.qaTargetBBoxAlert.style.display = 'block';
      if (isLarge) {
        this.qaTargetBBoxAlert.innerHTML = `
          <div class="bbox-area-alert alert-warning" style="margin:0; padding:6px 8px;">
            <div class="font-bold flex items-center gap-1">⚠️ Cảnh báo: Target BBox = ${pctStr}% (≥ 0.1%) — Large Object!</div>
            <div class="text-xs mt-0.5">Tiêu chuẩn Small Object benchmark yêu cầu diện tích &lt; 0.1% toàn ảnh.</div>
          </div>
        `;
      } else {
        this.qaTargetBBoxAlert.innerHTML = `
          <div class="bbox-area-alert alert-success" style="margin:0; padding:6px 8px;">
            <div class="font-bold flex items-center gap-1">✓ Chuẩn Small Object (< 0.1%): ${pctStr}%</div>
          </div>
        `;
      }
    }
  }

  renderRefBBoxesUI() {
    if (!this.qaRefBBoxesContainer || !this.editingQA) return;
    const refs = this.editingQA.reference_bboxes || [];

    if (refs.length === 0) {
      this.qaRefBBoxesContainer.innerHTML = `
        <span style="color: var(--text-muted); font-size: 0.72rem; font-style: italic;">
          Optional landmark references for Spatial / Relation questions (0/2).
        </span>
      `;
      return;
    }

    this.qaRefBBoxesContainer.innerHTML = '';
    refs.forEach(r => {
      const chip = document.createElement('span');
      chip.className = 'qa-target-chip';
      chip.style.borderColor = '#6366f1';
      chip.style.background = 'rgba(99, 102, 241, 0.18)';
      chip.style.color = '#c7d2fe';
      chip.style.cursor = 'pointer';
      chip.title = 'Click to select this BBox and edit its class';
      chip.addEventListener('click', () => this.selectBBoxForClass(r.bbox_id));
      chip.innerHTML = `
        📍 ${r.bbox_id} · ${r.category}
        <span class="remove-chip-btn" title="Remove">&times;</span>
      `;
      chip.querySelector('.remove-chip-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.editingQA.reference_bboxes = this.editingQA.reference_bboxes.filter(b => b.bbox_id !== r.bbox_id);
        this.renderRefBBoxesUI();
        this.syncViewportHighlights();
      });
      this.qaRefBBoxesContainer.appendChild(chip);
    });
  }

  syncViewportHighlights() {
    const tbId = this.editingQA && this.editingQA.target_bbox ? [this.editingQA.target_bbox.bbox_id] : [];
    const refIds = (this.editingQA && this.editingQA.reference_bboxes) ? this.editingQA.reference_bboxes.map(r => r.bbox_id) : [];
    this.viewport.setActiveQATargets([], tbId, refIds);
  }

  startNewQA() {
    if (this.locked) {
      this.lockedToast();
      return;
    }
    const imgId = this.app.activeImage ? this.app.activeImage.image_id : '';
    const nextQId = `${imgId}_q${String(this.qaList.length + 1).padStart(2, '0')}`;
    const defaultGroup = (this.app.activeImage && this.app.activeImage.density_group === 'same_object')
      ? 'Same-density' : 'Different-density';

    this.editingQA = {
      qa_id: null,
      image_id: imgId,
      density_category: 'people',
      question_id: nextQId,
      question_type: 'Attribute',
      target_group: defaultGroup,
      task_type: 'Visual Search',
      question: '',
      answer: '',
      target_bbox: null,
      target_bbox_ids: [],
      reference_bboxes: [],
      uniqueness_verified: true,
      bbox_area_ratio: 0.0,
      bbox_size_warning: 'ok_small_object',
      target_point_ids: []
    };

    // If a bbox was already selected on canvas, auto-pick it as target
    if (this.viewport.selectedBBoxId) {
      const selectedBB = this.viewport.bboxes.find(b => b.bbox_id === this.viewport.selectedBBoxId);
      if (selectedBB) {
        this.setTargetBBox(selectedBB);
      }
    }

    this.openQAEditor('Compose Visual Search QA Sample');
  }

  editQAPair(qa) {
    if (this.locked) {
      this.lockedToast();
      return;
    }
    const imgId = qa.image_id || (this.app.activeImage ? this.app.activeImage.image_id : '');

    // Reconstruct target_bbox if missing
    let tb = qa.target_bbox;
    if (!tb && qa.target_bbox_ids && qa.target_bbox_ids.length > 0) {
      const found = this.viewport.bboxes.find(b => b.bbox_id === qa.target_bbox_ids[0]);
      if (found) {
        tb = { ...found };
      }
    }

    this.editingQA = {
      qa_id: qa.qa_id,
      image_id: imgId,
      density_category: qa.density_category || 'people',
      question_id: qa.question_id || qa.qa_id,
      question_type: qa.question_type || 'Attribute',
      target_group: qa.target_group || 'Same-density',
      task_type: qa.task_type || 'Visual Search',
      question: qa.question || '',
      answer: qa.answer || '',
      target_bbox: tb || null,
      target_bbox_ids: tb ? [tb.bbox_id] : (qa.target_bbox_ids || []),
      reference_bboxes: [...(qa.reference_bboxes || [])],
      uniqueness_verified: qa.uniqueness_verified !== false,
      bbox_area_ratio: qa.bbox_area_ratio || 0.0,
      bbox_size_warning: qa.bbox_size_warning || 'ok_small_object',
      target_point_ids: [...(qa.target_point_ids || [])]
    };

    this.openQAEditor(`Edit QA Sample (${this.editingQA.question_id})`);
  }

  openQAEditor(title) {
    if (!this.qaEditorCard) return;
    this.qaEditorTitle.textContent = title;
    if (this.qaImageIdBadge && this.app.activeImage) {
      this.qaImageIdBadge.textContent = `Image: ${this.app.activeImage.image_id}`;
    }

    if (this.qaQuestionIdInput) this.qaQuestionIdInput.value = this.editingQA.question_id || '';
    if (this.qaDensityCategorySelect) this.qaDensityCategorySelect.value = this.editingQA.density_category || 'people';
    if (this.qaQuestionTypeSelect) this.qaQuestionTypeSelect.value = this.editingQA.question_type || 'Attribute';
    if (this.qaTargetGroupSelect) this.qaTargetGroupSelect.value = this.editingQA.target_group || 'Same-density';
    if (this.qaQuestionInput) this.qaQuestionInput.value = this.editingQA.question || '';
    if (this.qaAnswerInput) this.qaAnswerInput.value = this.editingQA.answer || '';
    if (this.qaUniquenessVerifiedCheck) this.qaUniquenessVerifiedCheck.checked = this.editingQA.uniqueness_verified !== false;

    this.pickingMode = null;
    this.updatePickingButtons();
    this.renderTargetBBoxUI();
    this.renderRefBBoxesUI();
    this.syncViewportHighlights();

    this.qaEditorCard.style.display = 'block';
    if (this.qaQuestionInput) this.qaQuestionInput.focus();
  }

  cancelQAEditor() {
    this.cancelBBoxResize();
    this.viewport.drawingBBox = null;
    this.viewport.requestOverlayRender();
    this.editingQA = null;
    this.pickingMode = null;
    if (this.qaEditorCard) this.qaEditorCard.style.display = 'none';
    this.viewport.setActiveQATargets([], [], []);
  }

  async saveQA() {
    if (!this.app.activeImage || !this.editingQA) return;
    if (this.creatingBBox || this.addingClass || this.viewport.draggingBBox) {
      this.app.showToast('Please wait for the new bounding box to finish saving.', 'info');
      return;
    }
    if (this.locked) {
      this.lockedToast();
      return;
    }

    const imgId = this.app.activeImage.image_id;
    const qText = this.qaQuestionInput ? this.qaQuestionInput.value.trim() : '';
    const aText = this.qaAnswerInput ? this.qaAnswerInput.value.trim() : '';

    // 1. Validation: Question & Answer
    if (!qText) {
      this.app.showToast('Please enter a question before saving.', 'error');
      if (this.qaQuestionInput) this.qaQuestionInput.focus();
      return;
    }
    if (!aText) {
      this.app.showToast('Please enter an answer before saving.', 'error');
      if (this.qaAnswerInput) this.qaAnswerInput.focus();
      return;
    }

    // 2. Validation: Target BBox is required
    if (!this.editingQA.target_bbox) {
      this.app.showToast('⚠️ Vui lòng chọn 1 Target BBox trên ảnh!', 'warning');
      this.pickingMode = 'target';
      this.updatePickingButtons();
      return;
    }

    // 3. Validation: Uniqueness Verified must be true
    const isUniquenessVerified = this.qaUniquenessVerifiedCheck ? this.qaUniquenessVerifiedCheck.checked : true;
    if (!isUniquenessVerified) {
      this.app.showToast("⚠️ Vui lòng kiểm tra và tích chọn 'Uniqueness Verified' trước khi lưu!", 'warning');
      if (this.qaUniquenessVerifiedCheck) this.qaUniquenessVerifiedCheck.focus();
      return;
    }

    const densityCategory = this.qaDensityCategorySelect ? this.qaDensityCategorySelect.value : 'people';
    const questionId = (this.qaQuestionIdInput && this.qaQuestionIdInput.value.trim())
      ? this.qaQuestionIdInput.value.trim()
      : (this.editingQA.question_id || `${imgId}_q01`);
    const questionType = this.qaQuestionTypeSelect ? this.qaQuestionTypeSelect.value : 'Attribute';
    const targetGroup = this.qaTargetGroupSelect ? this.qaTargetGroupSelect.value : 'Same-density';

    const areaRatio = this.editingQA.bbox_area_ratio || 0.0;
    const sizeWarning = (areaRatio >= 0.001) ? 'warning_large_object' : 'ok_small_object';

    const payload = {
      image_id: imgId,
      density_category: densityCategory,
      question_id: questionId,
      question_type: questionType,
      target_group: targetGroup,
      task_type: questionType,
      question: qText,
      answer: aText,
      target_bbox: this.editingQA.target_bbox,
      target_bbox_ids: [this.editingQA.target_bbox.bbox_id],
      reference_bboxes: this.editingQA.reference_bboxes || [],
      uniqueness_verified: isUniquenessVerified,
      bbox_area_ratio: areaRatio,
      bbox_size_warning: sizeWarning,
      target_point_ids: this.editingQA.target_point_ids || []
    };

    try {
      let savedQA = null;
      if (this.editingQA.qa_id) {
        // Update
        const res = await fetch(`/api/qa/${this.editingQA.qa_id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error('Update QA failed');
        savedQA = { qa_id: this.editingQA.qa_id, ...payload };
        const idx = this.qaList.findIndex(q => q.qa_id === this.editingQA.qa_id);
        if (idx >= 0) this.qaList[idx] = savedQA;
        this.app.showToast(`Updated QA Sample ${questionId}`, 'success');
      } else {
        // Create
        const res = await fetch(`/api/images/${imgId}/qa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error('Create QA failed');
        savedQA = await res.json();
        this.qaList.push(savedQA);
        this.app.showToast(`Created QA Sample ${questionId}`, 'success');
      }

      this.cancelQAEditor();
      this.renderQAList();
      this.selectQA(savedQA.qa_id);

      if (savedQA.qa_status && this.app.activeImage) {
        this.app.activeImage.qa_status = savedQA.qa_status;
        this.app.updateLockStates();
      }
      this.app.updateActiveImageBadgeCounts();
    } catch (err) {
      console.error(err);
      this.app.showToast('Failed to save QA Sample', 'error');
    }
  }

  selectQA(qaId) {
    this.selectedQAId = qaId;
    const cards = this.qaListContainer.querySelectorAll('.qa-card');
    cards.forEach(c => c.classList.toggle('selected-qa', c.id === `qa-card-${qaId}`));

    const qa = this.qaList.find(q => q.qa_id === qaId);
    if (qa) {
      const tbId = qa.target_bbox ? [qa.target_bbox.bbox_id] : (qa.target_bbox_ids || []);
      const refIds = (qa.reference_bboxes || []).map(r => r.bbox_id);
      this.viewport.setActiveQATargets([], tbId, refIds);
      if (tbId.length > 0) {
        this.viewport.centerOnBBox(tbId[0]);
      }
    }
  }

  renderQAList() {
    if (!this.qaListContainer) return;
    this.qaListContainer.innerHTML = '';

    if (this.qaList.length === 0) {
      this.qaListContainer.innerHTML = `
        <div style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 0.8rem;">
          ${this.locked
            ? 'No QA samples yet — QA is locked.<br>Press <strong>🔓 Unlock QA</strong> to start annotating.'
            : 'No visual search QA samples yet for this image.<br>Click <strong>"+ New QA Pair"</strong> to create one.'}
        </div>
      `;
      return;
    }

    this.qaList.forEach((qa) => {
      const card = document.createElement('div');
      card.className = `qa-card ${this.selectedQAId === qa.qa_id ? 'selected-qa' : ''}`;
      card.id = `qa-card-${qa.qa_id}`;

      const tb = qa.target_bbox;
      const tbId = tb ? tb.bbox_id : (qa.target_bbox_ids && qa.target_bbox_ids.length > 0 ? qa.target_bbox_ids[0] : null);
      const refs = qa.reference_bboxes || [];
      const areaRatio = qa.bbox_area_ratio ?? (tb ? tb.area_ratio : 0);
      const areaPct = (areaRatio || 0) * 100;
      const isLarge = areaPct >= 0.1;
      const pctStr = areaPct < 0.01 ? areaPct.toFixed(4) : areaPct.toFixed(3);

      const refChipsHtml = refs.map(r => `
        <span class="qa-target-chip" style="border-color:#6366f1; background:rgba(99,102,241,0.15); color:#a5b4fc; font-size:0.65rem;">
          📍 ${r.bbox_id} · ${r.category}
        </span>
      `).join(' ');

      card.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 4px; flex-wrap: wrap;">
          <div style="display:flex; gap:4px; align-items:center;">
            <span class="qa-type-badge">${qa.question_type || qa.task_type || 'Attribute'}</span>
            <span class="qa-group-badge" style="font-size:0.65rem; padding:1px 5px; border-radius:3px; background:rgba(148,163,184,0.15); color:#94a3b8;">${qa.target_group || 'Same-density'}</span>
            <span class="qa-density-badge" style="font-size:0.65rem; padding:1px 5px; border-radius:3px; background:rgba(59,130,246,0.15); color:#60a5fa;">${qa.density_category || 'people'}</span>
          </div>
          <span style="font-size: 0.7rem; color: var(--text-muted); font-family: var(--font-mono);">${qa.question_id || qa.qa_id}</span>
        </div>

        <div class="qa-question-text" style="margin-top:5px;"><strong>Q:</strong> ${this.escapeHtml(qa.question)}</div>
        <div class="qa-answer-text" style="margin-top:2px;"><strong>A:</strong> ${this.escapeHtml(qa.answer)}</div>

        <div style="margin-top: 6px; display:flex; flex-direction:column; gap:3px;">
          <div style="display:flex; align-items:center; gap:6px; font-size:0.7rem;">
            <span style="color:var(--text-muted);">Target:</span>
            ${tbId ? `
              <span class="qa-target-chip" style="font-size:0.68rem; font-weight:600; color:#34d399; border-color:#10b981;">
                🎯 ${tbId} (${pctStr}%) ${isLarge ? '<span style="color:#ef4444;">⚠️ Large</span>' : '<span style="color:#10b981;">✓ Small</span>'}
              </span>
            ` : '<span style="color:var(--text-muted); font-style:italic;">None</span>'}
          </div>

          ${refs.length > 0 ? `
            <div style="display:flex; align-items:center; gap:6px; font-size:0.7rem; flex-wrap:wrap;">
              <span style="color:var(--text-muted);">Ref (${refs.length}):</span>
              ${refChipsHtml}
            </div>
          ` : ''}

          <div style="display:flex; align-items:center; gap:6px; margin-top:2px;">
            <span style="font-size:0.66rem; color:#10b981; font-weight:600;">✓ Uniqueness Verified</span>
          </div>
        </div>

        ${this.locked ? '' : `
        <div style="display: flex; gap: 6px; margin-top: 6px; justify-content: flex-end;">
          <button class="btn btn-icon edit-qa-btn" title="Edit Sample" style="width:26px; height:26px; padding:2px;">✏️</button>
          <button class="btn btn-icon btn-danger delete-qa-btn" title="Delete Sample" style="width:26px; height:26px; padding:2px;">🗑️</button>
        </div>`}
      `;

      card.addEventListener('mouseenter', () => {
        const tId = tb ? [tb.bbox_id] : (qa.target_bbox_ids || []);
        const rIds = (qa.reference_bboxes || []).map(r => r.bbox_id);
        this.viewport.setActiveQATargets([], tId, rIds);
      });

      card.addEventListener('mouseleave', () => {
        if (this.selectedQAId !== qa.qa_id) {
          const selQA = this.qaList.find(q => q.qa_id === this.selectedQAId);
          if (selQA) {
            const tId = selQA.target_bbox ? [selQA.target_bbox.bbox_id] : (selQA.target_bbox_ids || []);
            const rIds = (selQA.reference_bboxes || []).map(r => r.bbox_id);
            this.viewport.setActiveQATargets([], tId, rIds);
          } else {
            this.viewport.setActiveQATargets([], [], []);
          }
        }
      });

      card.addEventListener('click', (e) => {
        if (e.target.closest('.delete-qa-btn') || e.target.closest('.edit-qa-btn')) return;
        this.selectQA(qa.qa_id);
      });

      if (!this.locked) {
        const editBtn = card.querySelector('.edit-qa-btn');
        if (editBtn) {
          editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.editQAPair(qa);
          });
        }
        const delBtn = card.querySelector('.delete-qa-btn');
        if (delBtn) {
          delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteQA(qa.qa_id);
          });
        }
      }

      this.qaListContainer.appendChild(card);
    });
  }

  async deleteQA(qaId) {
    if (this.locked) {
      this.lockedToast();
      return;
    }
    if (!confirm(`Delete visual search QA sample ${qaId}?`)) return;

    try {
      const res = await fetch(`/api/qa/${qaId}`, { method: 'DELETE' });
      if (res.ok) {
        const data = await res.json();
        this.qaList = this.qaList.filter(q => q.qa_id !== qaId);
        if (this.selectedQAId === qaId) {
          this.selectedQAId = null;
          this.viewport.setActiveQATargets([], [], []);
        }
        if (data.qa_status && this.app.activeImage) {
          this.app.activeImage.qa_status = data.qa_status;
          this.app.updateLockStates();
        }
        this.renderQAList();
        this.app.updateActiveImageBadgeCounts();
        this.app.showToast(`Deleted Sample ${qaId}`, 'info');
      }
    } catch (err) {
      console.error(err);
      this.app.showToast('Failed to delete sample', 'error');
    }
  }

  escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

function round1(v) {
  return Math.round((v || 0) * 10) / 10;
}
