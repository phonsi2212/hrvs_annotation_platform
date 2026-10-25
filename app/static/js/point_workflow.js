/**
 * PointWorkflow Module
 * Logic for Workflow 1: Point-level Annotation Mode (CRUD, move/drag, shortcuts, undo/redo, category palette)
 */

export class PointWorkflow {
  constructor(app) {
    this.app = app;
    this.viewport = app.viewport;

    // State
    this.activeTool = 'add'; // 'add' | 'select'
    this.activeCategory = null;
    this.categories = [];
    this.undoStack = [];
    this.redoStack = [];

    this.initElements();
    this.initEvents();
  }

  initElements() {
    this.catContainer = document.getElementById('categoryGrid');
    this.pointInspectorCard = document.getElementById('pointInspectorCard');
    this.pointIdField = document.getElementById('inspectorPointId');
    this.pointXField = document.getElementById('inspectorPointX');
    this.pointYField = document.getElementById('inspectorPointY');
    this.pointNormField = document.getElementById('inspectorPointNorm');
    this.pointCatSelect = document.getElementById('inspectorPointCat');
    this.pointColorPicker = document.getElementById('inspectorPointColor');
    this.pointNoteField = document.getElementById('inspectorPointNote');
    this.pointAttrColorField = document.getElementById('inspectorAttrColor');
    this.pointAttrStateField = document.getElementById('inspectorAttrState');
    this.deletePointBtn = document.getElementById('deletePointBtn');
    this.pointsListTableBody = document.getElementById('pointsListTableBody');
    this.pointsCategoryBreakdown = document.getElementById('pointsCategoryBreakdown');
    this.pointsCountBadge = document.getElementById('pointsCountBadge');

    // Tool buttons
    this.toolAddBtn = document.getElementById('toolAddPoint');
    this.toolSelectBtn = document.getElementById('toolSelectPoint');
    this.undoBtn = document.getElementById('toolUndo');
    this.redoBtn = document.getElementById('toolRedo');
    this.clearPointsBtn = document.getElementById('toolClearPoints');

    if (this.toolAddBtn) {
      this.toolAddBtn.addEventListener('click', () => this.setTool('add'));
    }
    if (this.toolSelectBtn) {
      this.toolSelectBtn.addEventListener('click', () => this.setTool('select'));
    }
    if (this.undoBtn) {
      this.undoBtn.addEventListener('click', () => this.undo());
    }
    if (this.redoBtn) {
      this.redoBtn.addEventListener('click', () => this.redo());
    }
    if (this.clearPointsBtn) {
      this.clearPointsBtn.addEventListener('click', () => this.confirmClearAllPoints());
    }

    // Inspector change listeners
    if (this.deletePointBtn) {
      this.deletePointBtn.addEventListener('click', () => {
        if (this.viewport.selectedPointId) {
          this.deletePoint(this.viewport.selectedPointId);
        }
      });
    }

    const saveFieldChange = () => this.saveSelectedPointChanges();
    if (this.pointCatSelect) this.pointCatSelect.addEventListener('change', saveFieldChange);
    if (this.pointColorPicker) this.pointColorPicker.addEventListener('change', saveFieldChange);
    if (this.pointNoteField) this.pointNoteField.addEventListener('input', saveFieldChange);
    if (this.pointAttrColorField) this.pointAttrColorField.addEventListener('input', saveFieldChange);
    if (this.pointAttrStateField) this.pointAttrStateField.addEventListener('input', saveFieldChange);

    if (this.pointXField) {
      this.pointXField.addEventListener('change', () => {
        if (this.app.pointLocked) {
          this.lockedToast();
          this.updateInspectorValues(this.getSelectedPoint());
          return;
        }
        const pt = this.getSelectedPoint();
        if (pt) {
          const val = parseFloat(this.pointXField.value);
          if (!isNaN(val)) {
            pt.x = val;
            this.updatePointPosition(pt);
          }
        }
      });
    }
    if (this.pointYField) {
      this.pointYField.addEventListener('change', () => {
        if (this.app.pointLocked) {
          this.lockedToast();
          this.updateInspectorValues(this.getSelectedPoint());
          return;
        }
        const pt = this.getSelectedPoint();
        if (pt) {
          const val = parseFloat(this.pointYField.value);
          if (!isNaN(val)) {
            pt.y = val;
            this.updatePointPosition(pt);
          }
        }
      });
    }

    // Custom Category Adder
    const addCatBtn = document.getElementById('addNewCategoryBtn');
    if (addCatBtn) {
      addCatBtn.addEventListener('click', () => this.promptNewCategory());
    }
  }

  initEvents() {
    // Canvas click in point mode
    this.viewport.onCanvasClick = (coords, e) => {
      if (this.app.currentWorkflow !== 'point') return;
      if (!this.app.activeImage) return;

      // The Select tool never creates points; clicking empty space deselects instead.
      if (this.activeTool !== 'add') {
        this.deselectPoint();
        return;
      }

      if (this.app.pointLocked) {
        this.lockedToast();
        return;
      }

      if (coords.x >= 0 && coords.x <= this.viewport.naturalWidth &&
          coords.y >= 0 && coords.y <= this.viewport.naturalHeight) {
        this.addPointAt(coords.x, coords.y);
      }
    };

    // Point selected
    this.viewport.onPointClick = (pt, e) => {
      if (this.app.currentWorkflow !== 'point') return;
      this.selectPoint(pt.point_id);
    };

    // Point dragged
    this.viewport.onPointDrag = (pt) => {
      this.updateInspectorValues(pt);
    };

    // Drag ended
    this.viewport.onPointDragEnd = (pt, startPos) => {
      if (!startPos) return;
      if (this.app.pointLocked) {
        // Viewport blocks drag start on locked images; restore if it ever slips through
        pt.x = startPos.x;
        pt.y = startPos.y;
        this.lockedToast();
        return;
      }
      if (Math.abs(pt.x - startPos.x) > 0.5 || Math.abs(pt.y - startPos.y) > 0.5) {
        // Record undo
        this.undoStack.push({
          type: 'move',
          point_id: pt.point_id,
          oldX: startPos.x,
          oldY: startPos.y,
          newX: pt.x,
          newY: pt.y
        });
        this.redoStack = [];
        this.syncPointPositionToBackend(pt);
      }
    };

    // Global shortcut listener
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      // Point-editing shortcuts only apply in Point Annotation mode
      // (the canvas is read-only in QA mode)
      if (this.app.currentWorkflow !== 'point') return;

      // P for Add Point tool
      if (e.key === 'p' || e.key === 'P') {
        this.setTool('add');
      }
      // V for Select tool
      if (e.key === 'v' || e.key === 'V') {
        this.setTool('select');
      }
      // Delete or Backspace to delete selected point
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.viewport.selectedPointId) {
          e.preventDefault();
          this.deletePoint(this.viewport.selectedPointId);
        }
      }
      // Ctrl+Z Undo, Ctrl+Y Redo
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) {
          this.redo();
        } else {
          this.undo();
        }
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        this.redo();
      }

      // Number keys 1-9 for quick category switch
      if (e.key >= '1' && e.key <= '9') {
        const cat = this.categories.find(c => c.shortcut_key === e.key);
        if (cat) {
          this.setActiveCategory(cat);
          this.app.showToast(`Active category: ${cat.name}`, 'info');
        }
      }
    });

    // Right click delete event from canvas
    window.addEventListener('point-delete-request', (e) => {
      if (e.detail && e.detail.point_id) {
        this.deletePoint(e.detail.point_id);
      }
    });
  }

  setTool(tool) {
    this.activeTool = tool;
    if (this.toolAddBtn) this.toolAddBtn.classList.toggle('active', tool === 'add');
    if (this.toolSelectBtn) this.toolSelectBtn.classList.toggle('active', tool === 'select');
  }

  // Completed images are read-only: every point mutation checks this first.
  lockedToast() {
    this.app.showToast('🔒 Image is completed (locked). Press 🔓 Unlock or change the status to edit points.', 'error');
  }

  // Clears the current selection and hides the inspector (Escape / Select tool).
  deselectPoint() {
    this.viewport.setSelectedPoint(null);
    if (this.pointInspectorCard) this.pointInspectorCard.style.display = 'none';
    this.highlightPointInTable(null);
  }

  // Per-image state isolation: called when the active image changes so that
  // undo/redo history and the inspector can never act on a previous image.
  resetForImage() {
    this.undoStack = [];
    this.redoStack = [];
    this.viewport.selectedPointId = null;
    this.viewport.hoveredPointId = null;
    this.viewport.setActiveQATargets([]);
    if (this.pointInspectorCard) this.pointInspectorCard.style.display = 'none';
    this.highlightPointInTable(null);
  }

  async loadCategories() {
    try {
      const res = await fetch('/api/categories');
      this.categories = await res.json();
      this.renderCategoryGrid();
    } catch (err) {
      console.error('Failed to load categories:', err);
    }
  }

  renderCategoryGrid() {
    if (!this.catContainer) return;
    this.catContainer.innerHTML = '';

    const currentGroup = this.app.activeImage ? this.app.activeImage.density_group : 'same_object';
    const groupCats = this.categories.filter(c => c.density_group === currentGroup || c.density_group === 'both');

    // Fallback if none
    const listToRender = groupCats.length > 0 ? groupCats : this.categories;

    listToRender.forEach((cat, idx) => {
      const btn = document.createElement('button');
      btn.className = `cat-btn ${this.activeCategory && this.activeCategory.name === cat.name ? 'active' : ''}`;
      btn.innerHTML = `
        <span class="cat-color-dot" style="background-color: ${cat.color};"></span>
        <span class="cat-name">${cat.name}</span>
        ${cat.shortcut_key ? `<span class="cat-key-badge">${cat.shortcut_key}</span>` : ''}
      `;
      btn.addEventListener('click', () => {
        this.setActiveCategory(cat);
      });
      this.catContainer.appendChild(btn);
    });

    // Populate inspector category dropdown
    if (this.pointCatSelect) {
      this.pointCatSelect.innerHTML = '';
      this.categories.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.name;
        opt.textContent = c.name;
        this.pointCatSelect.appendChild(opt);
      });
    }

    // Default active category
    if (!this.activeCategory || !listToRender.find(c => c.name === this.activeCategory.name)) {
      if (listToRender.length > 0) {
        this.setActiveCategory(listToRender[0]);
      }
    }
  }

  setActiveCategory(cat) {
    this.activeCategory = cat;
    if (this.catContainer) {
      const btns = this.catContainer.querySelectorAll('.cat-btn');
      btns.forEach(b => {
        const name = b.querySelector('.cat-name').textContent;
        b.classList.toggle('active', name === cat.name);
      });
    }
    // If a point is currently selected, update its category (quick reclassify)
    const pt = this.getSelectedPoint();
    if (pt) {
      if (this.app.pointLocked) {
        this.lockedToast();
        return;
      }
      pt.category = cat.name;
      pt.color = cat.color;
      this.viewport.requestOverlayRender();
      this.updateInspectorValues(pt);
      this.renderPointsSummary();
      this.syncPointCategoryToBackend(pt);
      this.app.showToast(`${pt.point_id} reclassified → ${cat.name}`, 'info');
    }
  }

  async promptNewCategory() {
    const name = prompt("Enter new category name (e.g. tablet, dog, helmet):");
    if (!name || !name.trim()) return;
    const cleanName = name.trim().toLowerCase().replace(/\s+/g, '_');

    const defaultColors = ["#10b981", "#3b82f6", "#f59e0b", "#ec4899", "#8b5cf6", "#06b6d4"];
    const color = defaultColors[Math.floor(Math.random() * defaultColors.length)];
    const group = this.app.activeImage ? this.app.activeImage.density_group : 'mixed_object';

    try {
      const res = await fetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cleanName, color: color, density_group: group })
      });
      if (res.ok) {
        await this.loadCategories();
        this.app.showToast(`Category added: ${cleanName}`, 'success');
      } else {
        const err = await res.json();
        alert(err.detail || 'Failed to add category');
      }
    } catch (err) {
      console.error(err);
    }
  }

  async addPointAt(x, y) {
    if (!this.app.activeImage) return;
    const imgId = this.app.activeImage.image_id;
    const cat = this.activeCategory || { name: 'person_head', color: '#ef4444' };

    const payload = {
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      category: cat.name,
      color: cat.color,
      attributes: {}
    };

    try {
      const res = await fetch(`/api/images/${imgId}/points`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Failed to create point');
      const newPoint = await res.json();

      // Add to viewport points
      this.viewport.points.push(newPoint);
      this.selectPoint(newPoint.point_id);
      this.renderPointsSummary();
      this.app.updateActiveImageBadgeCounts();

      // Push to Undo stack
      this.undoStack.push({ type: 'add', point: newPoint });
      this.redoStack = [];
      this.viewport.requestRender();
    } catch (err) {
      console.error(err);
      this.app.showToast('Error creating point', 'error');
    }
  }

  selectPoint(pointId) {
    this.viewport.setSelectedPoint(pointId);
    const pt = this.getSelectedPoint();
    if (pt) {
      this.updateInspectorValues(pt);
      if (this.pointInspectorCard) this.pointInspectorCard.style.display = 'block';
    } else {
      if (this.pointInspectorCard) this.pointInspectorCard.style.display = 'none';
    }
    this.highlightPointInTable(pointId);
  }

  getSelectedPoint() {
    return this.viewport.points.find(p => p.point_id === this.viewport.selectedPointId);
  }

  updateInspectorValues(pt) {
    if (!pt) return;
    if (this.pointIdField) this.pointIdField.textContent = pt.point_id;
    if (this.pointXField) this.pointXField.value = pt.x;
    if (this.pointYField) this.pointYField.value = pt.y;
    if (this.pointNormField) {
      this.pointNormField.textContent = `[${pt.x_norm || 0}, ${pt.y_norm || 0}]`;
    }
    if (this.pointCatSelect) this.pointCatSelect.value = pt.category;
    if (this.pointColorPicker) this.pointColorPicker.value = pt.color || '#ef4444';

    const attrs = pt.attributes || {};
    if (this.pointNoteField) this.pointNoteField.value = attrs.note || '';
    if (this.pointAttrColorField) this.pointAttrColorField.value = attrs.color || '';
    if (this.pointAttrStateField) this.pointAttrStateField.value = attrs.state || '';
  }

  async saveSelectedPointChanges() {
    const pt = this.getSelectedPoint();
    if (!pt) return;
    if (this.app.pointLocked) {
      this.lockedToast();
      this.updateInspectorValues(pt);
      return;
    }

    const newCat = this.pointCatSelect ? this.pointCatSelect.value : pt.category;
    const newColor = this.pointColorPicker ? this.pointColorPicker.value : pt.color;
    const attrs = {
      ...(pt.attributes || {}),
      note: this.pointNoteField ? this.pointNoteField.value.trim() : '',
      color: this.pointAttrColorField ? this.pointAttrColorField.value.trim() : '',
      state: this.pointAttrStateField ? this.pointAttrStateField.value.trim() : ''
    };

    pt.category = newCat;
    pt.color = newColor;
    pt.attributes = attrs;

    this.viewport.requestRender();
    this.renderPointsSummary();

    // Debounced sync to backend
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(async () => {
      try {
        await fetch(`/api/points/${pt.point_id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category: newCat, color: newColor, attributes: attrs })
        });
      } catch (err) {
        console.error('Failed to update point:', err);
      }
    }, 300);
  }

  async updatePointPosition(pt) {
    if (this.viewport.naturalWidth && this.viewport.naturalHeight) {
      pt.x_norm = +(pt.x / this.viewport.naturalWidth).toFixed(6);
      pt.y_norm = +(pt.y / this.viewport.naturalHeight).toFixed(6);
    }
    this.viewport.requestRender();
    this.updateInspectorValues(pt);
    await this.syncPointPositionToBackend(pt);
  }

  async syncPointPositionToBackend(pt) {
    try {
      await fetch(`/api/points/${pt.point_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: pt.x, y: pt.y })
      });
      this.renderPointsSummary();
    } catch (err) {
      console.error('Failed to sync point position:', err);
    }
  }

  async syncPointCategoryToBackend(pt) {
    try {
      await fetch(`/api/points/${pt.point_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: pt.category, color: pt.color })
      });
      this.renderPointsSummary();
    } catch (err) {
      console.error(err);
    }
  }

  async deletePoint(pointId, recordUndo = true) {
    if (this.app.pointLocked) {
      this.lockedToast();
      return;
    }
    const ptIndex = this.viewport.points.findIndex(p => p.point_id === pointId);
    if (ptIndex === -1) return;
    const pt = this.viewport.points[ptIndex];

    try {
      const res = await fetch(`/api/points/${pointId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');

      if (recordUndo) {
        this.undoStack.push({ type: 'delete', point: { ...pt } });
        this.redoStack = [];
      }

      this.viewport.points.splice(ptIndex, 1);
      if (this.viewport.selectedPointId === pointId) {
        this.viewport.selectedPointId = null;
        if (this.pointInspectorCard) this.pointInspectorCard.style.display = 'none';
      }
      this.viewport.requestRender();
      this.renderPointsSummary();
      this.app.updateActiveImageBadgeCounts();
      this.app.showToast(`Deleted point ${pointId}`, 'info');
    } catch (err) {
      console.error('Delete point error:', err);
    }
  }

  async confirmClearAllPoints() {
    if (!this.app.activeImage) return;
    if (this.app.pointLocked) {
      this.lockedToast();
      return;
    }
    if (this.viewport.points.length === 0) return;
    if (!confirm(`Are you sure you want to delete all ${this.viewport.points.length} points on this image?`)) return;

    try {
      const res = await fetch(`/api/images/${this.app.activeImage.image_id}/points`, { method: 'DELETE' });
      if (res.ok) {
        this.viewport.points = [];
        this.viewport.selectedPointId = null;
        if (this.pointInspectorCard) this.pointInspectorCard.style.display = 'none';
        this.viewport.requestRender();
        this.renderPointsSummary();
        this.app.updateActiveImageBadgeCounts();
        this.app.showToast('All points cleared', 'info');
      }
    } catch (err) {
      console.error(err);
    }
  }

  async undo() {
    if (this.app.pointLocked) {
      this.lockedToast();
      return;
    }
    if (this.undoStack.length === 0) {
      this.app.showToast('Nothing to undo', 'info');
      return;
    }
    const action = this.undoStack.pop();

    if (action.type === 'add') {
      // Revert add: delete the point
      await this.deletePoint(action.point.point_id, false);
      this.redoStack.push(action);
    } else if (action.type === 'delete') {
      // Revert delete: re-add point
      try {
        const res = await fetch(`/api/images/${this.app.activeImage.image_id}/points`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action.point)
        });
        if (res.ok) {
          const restored = await res.json();
          this.viewport.points.push(restored);
          this.selectPoint(restored.point_id);
          this.viewport.requestRender();
          this.renderPointsSummary();
          this.app.updateActiveImageBadgeCounts();
          this.redoStack.push(action);
        }
      } catch (err) {
        console.error(err);
      }
    } else if (action.type === 'move') {
      // Revert move
      const pt = this.viewport.points.find(p => p.point_id === action.point_id);
      if (pt) {
        pt.x = action.oldX;
        pt.y = action.oldY;
        await this.updatePointPosition(pt);
        this.redoStack.push(action);
      }
    }
    this.app.showToast('Undo performed', 'info');
  }

  async redo() {
    if (this.app.pointLocked) {
      this.lockedToast();
      return;
    }
    if (this.redoStack.length === 0) {
      this.app.showToast('Nothing to redo', 'info');
      return;
    }
    const action = this.redoStack.pop();

    if (action.type === 'add') {
      // Re-add
      try {
        const res = await fetch(`/api/images/${this.app.activeImage.image_id}/points`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action.point)
        });
        if (res.ok) {
          const added = await res.json();
          this.viewport.points.push(added);
          this.selectPoint(added.point_id);
          this.viewport.requestRender();
          this.renderPointsSummary();
          this.undoStack.push(action);
        }
      } catch (err) {}
    } else if (action.type === 'delete') {
      await this.deletePoint(action.point.point_id, false);
      this.undoStack.push(action);
    } else if (action.type === 'move') {
      const pt = this.viewport.points.find(p => p.point_id === action.point_id);
      if (pt) {
        pt.x = action.newX;
        pt.y = action.newY;
        await this.updatePointPosition(pt);
        this.undoStack.push(action);
      }
    }
    this.app.showToast('Redo performed', 'info');
  }

  renderPointsSummary() {
    const pts = this.viewport.points || [];
    if (this.pointsCountBadge) {
      this.pointsCountBadge.textContent = `${pts.length} pts`;
    }

    // Category breakdown
    if (this.pointsCategoryBreakdown) {
      const counts = {};
      pts.forEach(p => counts[p.category] = (counts[p.category] || 0) + 1);
      this.pointsCategoryBreakdown.innerHTML = '';
      for (const [cat, cnt] of Object.entries(counts)) {
        const catDef = this.categories.find(c => c.name === cat);
        const col = catDef ? catDef.color : '#ef4444';
        const pill = document.createElement('span');
        pill.className = 'status-badge';
        pill.style.borderColor = col;
        pill.style.color = col;
        pill.style.backgroundColor = `${col}15`;
        pill.textContent = `${cat}: ${cnt}`;
        this.pointsCategoryBreakdown.appendChild(pill);
      }
    }

    // Points table list. Densely annotated images (e.g. NWPU crowds with 10k+
    // points) would freeze the DOM if every row were rendered, so the table is
    // capped and the remainder summarized in a single footer row.
    if (this.pointsListTableBody) {
      this.pointsListTableBody.innerHTML = '';
      const MAX_TABLE_ROWS = 300;
      const visiblePts = pts.length > MAX_TABLE_ROWS ? pts.slice(0, MAX_TABLE_ROWS) : pts;
      visiblePts.forEach(p => {
        const tr = document.createElement('tr');
        tr.id = `pt-row-${p.point_id}`;
        tr.style.cursor = 'pointer';
        tr.className = p.point_id === this.viewport.selectedPointId ? 'active-point-row' : '';
        tr.innerHTML = `
          <td style="font-family: var(--font-mono); color: var(--accent-cyan);">${p.point_id}</td>
          <td><span class="cat-color-dot" style="display:inline-block; background-color:${p.color || '#ef4444'}"></span> ${p.category}</td>
          <td style="font-family: var(--font-mono); font-size:0.7rem; color:var(--text-muted);">${Math.round(p.x)}, ${Math.round(p.y)}</td>
        `;
        tr.addEventListener('click', () => {
          this.selectPoint(p.point_id);
          this.viewport.centerOnPoint(p.point_id);
        });
        this.pointsListTableBody.appendChild(tr);
      });
      if (pts.length > MAX_TABLE_ROWS) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td colspan="3" style="padding: 6px; text-align: center; color: var(--text-muted); font-size: 0.7rem;">
            … +${(pts.length - MAX_TABLE_ROWS).toLocaleString()} more points (list truncated — select points on the canvas)
          </td>
        `;
        this.pointsListTableBody.appendChild(tr);
      }
    }
  }

  highlightPointInTable(pointId) {
    if (!this.pointsListTableBody) return;
    const rows = this.pointsListTableBody.querySelectorAll('tr');
    rows.forEach(r => {
      r.style.backgroundColor = r.id === `pt-row-${pointId}` ? 'rgba(99, 102, 241, 0.2)' : '';
    });
  }
}
