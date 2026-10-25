/**
 * QAWorkflow Module
 * Logic for Workflow 2: Question–Answer (QA) Annotation Mode.
 * Locks point coordinate editing, allows browsing QA pairs,
 * creating/editing QA, and selecting Ground-Truth Target Points directly on canvas.
 */

export class QAWorkflow {
  constructor(app) {
    this.app = app;
    this.viewport = app.viewport;

    // State
    this.qaList = [];
    this.selectedQAId = null;
    this.editingQA = null; // null or { qa_id, task_type, question, answer, target_point_ids }
    this.isSelectingTargets = false;
    this.locked = false; // true while the image's QA status is 'completed'

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
    this.qaTaskTypeSelect = document.getElementById('qaTaskTypeSelect');
    this.qaQuestionInput = document.getElementById('qaQuestionInput');
    this.qaAnswerInput = document.getElementById('qaAnswerInput');
    this.qaTargetChipsContainer = document.getElementById('qaTargetChipsContainer');
    this.toggleSelectTargetsBtn = document.getElementById('toggleSelectTargetsBtn');
    this.saveQABtn = document.getElementById('saveQABtn');
    this.cancelQABtn = document.getElementById('cancelQABtn');
    this.quickPromptSelect = document.getElementById('quickPromptSelect');

    if (this.newQABtn) {
      this.newQABtn.addEventListener('click', () => this.startNewQA());
    }
    if (this.saveQABtn) {
      this.saveQABtn.addEventListener('click', () => this.saveQA());
    }
    if (this.cancelQABtn) {
      this.cancelQABtn.addEventListener('click', () => this.cancelQAEditor());
    }
    if (this.toggleSelectTargetsBtn) {
      this.toggleSelectTargetsBtn.addEventListener('click', () => this.toggleTargetSelectionMode());
    }
    if (this.quickPromptSelect) {
      this.quickPromptSelect.addEventListener('change', (e) => {
        if (e.target.value && this.qaQuestionInput) {
          this.qaQuestionInput.value = e.target.value + " ";
          this.qaQuestionInput.focus();
        }
      });
    }
  }

  initEvents() {
    // When point is clicked in QA mode
    const origPointClick = this.viewport.onPointClick;
    this.viewport.onPointClick = (pt, e) => {
      if (this.app.currentWorkflow === 'qa') {
        if (this.editingQA && this.isSelectingTargets) {
          this.toggleTargetPoint(pt.point_id);
          return;
        }
      }
      if (origPointClick) origPointClick(pt, e);
    };
  }

  // Per-image state isolation: called when the active image changes.
  resetForImage() {
    this.editingQA = null;
    this.isSelectingTargets = false;
    this.selectedQAId = null;
    if (this.qaEditorCard) this.qaEditorCard.style.display = 'none';
    this.viewport.setActiveQATargets([]);
  }

  setQAList(list) {
    this.qaList = list || [];
    this.renderQAList();
    if (this.qaCountBadge) {
      this.qaCountBadge.textContent = `${this.qaList.length} Q&A`;
    }
  }

  // QA-completed images are read-only: no creating / editing / deleting Q&A
  // pairs until the QA status is reverted (Finish QA button unlocks).
  setLocked(locked) {
    this.locked = locked;
    if (this.newQABtn) this.newQABtn.disabled = locked;
    if (locked && this.editingQA) this.cancelQAEditor();
    this.renderQAList();
  }

  lockedToast() {
    this.app.showToast('🔒 QA is completed (locked). Press 🔓 Unlock QA or change the QA status to edit Q&A pairs.', 'error');
  }

  renderQAList() {
    if (!this.qaListContainer) return;
    this.qaListContainer.innerHTML = '';

    if (this.qaList.length === 0) {
      this.qaListContainer.innerHTML = `
        <div style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 0.8rem;">
          ${this.locked
            ? 'No QA annotations yet — QA is locked.<br>Press <strong>🔓 Unlock QA</strong> to start annotating.'
            : 'No QA annotations yet for this image.<br>Click <strong>"+ New QA Pair"</strong> to create one.'}
        </div>
      `;
      return;
    }

    this.qaList.forEach((qa, idx) => {
      const card = document.createElement('div');
      card.className = `qa-card ${this.selectedQAId === qa.qa_id ? 'selected-qa' : ''}`;
      card.id = `qa-card-${qa.qa_id}`;

      const targetCount = qa.target_point_ids ? qa.target_point_ids.length : 0;
      const targetChipsHtml = (qa.target_point_ids || []).map(id => {
        const pt = this.viewport.points.find(p => p.point_id === id);
        const cat = pt ? `(${pt.category})` : '';
        return `<span class="qa-target-chip">${id} ${cat}</span>`;
      }).join('');

      card.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <span class="qa-type-badge">${qa.task_type || 'Visual Search'}</span>
          <span style="font-size: 0.7rem; color: var(--text-muted); font-family: var(--font-mono);">${qa.qa_id}</span>
        </div>
        <div class="qa-question-text">Q: ${this.escapeHtml(qa.question)}</div>
        <div class="qa-answer-text">A: ${this.escapeHtml(qa.answer)}</div>
        <div class="qa-targets-row">
          <span style="font-size: 0.68rem; color: var(--text-muted);">Targets (${targetCount}):</span>
          ${targetChipsHtml || '<span style="font-size: 0.68rem; color: var(--text-muted);">None linked</span>'}
        </div>
        ${this.locked ? '' : `
        <div style="display: flex; gap: 6px; margin-top: 6px; justify-content: flex-end;">
          <button class="btn btn-icon edit-qa-btn" title="Edit QA" style="width:26px; height:26px; padding:2px;">✏️</button>
          <button class="btn btn-icon btn-danger delete-qa-btn" title="Delete QA" style="width:26px; height:26px; padding:2px;">🗑️</button>
        </div>`}
      `;

      // Highlight target points on hover / click
      card.addEventListener('mouseenter', () => {
        this.viewport.setActiveQATargets(qa.target_point_ids);
      });
      card.addEventListener('mouseleave', () => {
        if (this.selectedQAId !== qa.qa_id) {
          this.viewport.setActiveQATargets(this.selectedQAId ? this.getTargetsForQA(this.selectedQAId) : []);
        }
      });
      card.addEventListener('click', (e) => {
        if (e.target.closest('.delete-qa-btn') || e.target.closest('.edit-qa-btn')) return;
        this.selectQA(qa.qa_id);
      });

      if (!this.locked) {
        const editBtn = card.querySelector('.edit-qa-btn');
        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.editQAPair(qa);
        });

        const delBtn = card.querySelector('.delete-qa-btn');
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.deleteQA(qa.qa_id);
        });
      }

      this.qaListContainer.appendChild(card);
    });
  }

  selectQA(qaId) {
    this.selectedQAId = qaId;
    const cards = this.qaListContainer.querySelectorAll('.qa-card');
    cards.forEach(c => c.classList.toggle('selected-qa', c.id === `qa-card-${qaId}`));

    const qa = this.qaList.find(q => q.qa_id === qaId);
    if (qa) {
      this.viewport.setActiveQATargets(qa.target_point_ids);
      // Center on first target point if available
      if (qa.target_point_ids && qa.target_point_ids.length > 0) {
        this.viewport.centerOnPoint(qa.target_point_ids[0]);
      }
    }
  }

  getTargetsForQA(qaId) {
    const qa = this.qaList.find(q => q.qa_id === qaId);
    return qa ? qa.target_point_ids : [];
  }

  startNewQA() {
    if (this.locked) {
      this.lockedToast();
      return;
    }
    this.editingQA = {
      qa_id: null,
      task_type: 'Visual Search',
      question: '',
      answer: '',
      target_point_ids: []
    };
    if (this.viewport.selectedPointId) {
      this.editingQA.target_point_ids.push(this.viewport.selectedPointId);
    }
    this.openQAEditor("Create New QA Pair");
  }

  editQAPair(qa) {
    if (this.locked) {
      this.lockedToast();
      return;
    }
    this.editingQA = {
      qa_id: qa.qa_id,
      task_type: qa.task_type,
      question: qa.question,
      answer: qa.answer,
      target_point_ids: [...(qa.target_point_ids || [])]
    };
    this.openQAEditor(`Edit QA (${qa.qa_id})`);
  }

  openQAEditor(title) {
    if (!this.qaEditorCard) return;
    this.qaEditorTitle.textContent = title;
    this.qaTaskTypeSelect.value = this.editingQA.task_type;
    this.qaQuestionInput.value = this.editingQA.question;
    this.qaAnswerInput.value = this.editingQA.answer;
    this.isSelectingTargets = true;
    this.updateTargetSelectorButton();
    this.renderTargetChips();

    this.qaEditorCard.style.display = 'block';
    this.viewport.setActiveQATargets(this.editingQA.target_point_ids);
    this.qaQuestionInput.focus();
  }

  cancelQAEditor() {
    this.editingQA = null;
    this.isSelectingTargets = false;
    if (this.qaEditorCard) this.qaEditorCard.style.display = 'none';
    this.viewport.setActiveQATargets(this.selectedQAId ? this.getTargetsForQA(this.selectedQAId) : []);
  }

  toggleTargetSelectionMode() {
    this.isSelectingTargets = !this.isSelectingTargets;
    this.updateTargetSelectorButton();
    if (this.isSelectingTargets) {
      this.app.showToast('Click points on canvas to toggle Ground-Truth targets', 'info');
    }
  }

  updateTargetSelectorButton() {
    if (!this.toggleSelectTargetsBtn) return;
    if (this.isSelectingTargets) {
      this.toggleSelectTargetsBtn.className = 'btn btn-success';
      this.toggleSelectTargetsBtn.textContent = '🎯 Target Picking Active (Click Point)';
    } else {
      this.toggleSelectTargetsBtn.className = 'btn';
      this.toggleSelectTargetsBtn.textContent = '🎯 Enable Point Picker';
    }
  }

  toggleTargetPoint(pointId) {
    if (!this.editingQA) return;
    const idx = this.editingQA.target_point_ids.indexOf(pointId);
    if (idx >= 0) {
      this.editingQA.target_point_ids.splice(idx, 1);
    } else {
      this.editingQA.target_point_ids.push(pointId);
    }
    this.renderTargetChips();
    this.viewport.setActiveQATargets(this.editingQA.target_point_ids);
    this.app.showToast(`Target point ${pointId} ${idx >= 0 ? 'removed' : 'linked'}`, 'info');
  }

  renderTargetChips() {
    if (!this.qaTargetChipsContainer || !this.editingQA) return;
    this.qaTargetChipsContainer.innerHTML = '';

    if (this.editingQA.target_point_ids.length === 0) {
      this.qaTargetChipsContainer.innerHTML = `<span style="font-size:0.7rem; color:var(--text-muted);">No points linked. Click points on the image above.</span>`;
      return;
    }

    this.editingQA.target_point_ids.forEach(id => {
      const pt = this.viewport.points.find(p => p.point_id === id);
      const cat = pt ? `(${pt.category})` : '';
      const chip = document.createElement('span');
      chip.className = 'qa-target-chip';
      chip.innerHTML = `
        ${id} ${cat}
        <span class="remove-chip-btn" title="Remove">&times;</span>
      `;
      chip.querySelector('.remove-chip-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleTargetPoint(id);
      });
      this.qaTargetChipsContainer.appendChild(chip);
    });
  }

  async saveQA() {
    if (!this.app.activeImage || !this.editingQA) return;
    if (this.locked) {
      this.lockedToast();
      return;
    }
    const imgId = this.app.activeImage.image_id;
    const qText = this.qaQuestionInput.value.trim();
    const aText = this.qaAnswerInput.value.trim();

    if (!qText) {
      this.app.showToast('Please enter a question before saving.', 'error');
      this.qaQuestionInput.focus();
      return;
    }

    const payload = {
      task_type: this.qaTaskTypeSelect.value,
      question: qText,
      answer: aText,
      target_point_ids: this.editingQA.target_point_ids
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
        savedQA = { qa_id: this.editingQA.qa_id, image_id: imgId, ...payload };
        const idx = this.qaList.findIndex(q => q.qa_id === this.editingQA.qa_id);
        if (idx >= 0) this.qaList[idx] = savedQA;
        this.app.showToast('QA pair updated', 'success');
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
        this.app.showToast('QA pair created', 'success');
      }

      this.cancelQAEditor();
      this.renderQAList();
      this.selectQA(savedQA.qa_id);
      // Creating the first Q&A auto-completes the QA status -> image locks
      if (savedQA.qa_status && this.app.activeImage) {
        this.app.activeImage.qa_status = savedQA.qa_status;
        this.app.updateLockStates();
      }
      this.app.updateActiveImageBadgeCounts();
    } catch (err) {
      console.error(err);
      this.app.showToast('Failed to save QA pair', 'error');
    }
  }

  async deleteQA(qaId) {
    if (this.locked) {
      this.lockedToast();
      return;
    }
    if (!confirm(`Delete QA pair ${qaId}?`)) return;

    try {
      const res = await fetch(`/api/qa/${qaId}`, { method: 'DELETE' });
      if (res.ok) {
        const data = await res.json();
        this.qaList = this.qaList.filter(q => q.qa_id !== qaId);
        if (this.selectedQAId === qaId) {
          this.selectedQAId = null;
          this.viewport.setActiveQATargets([]);
        }
        // Deleting the last Q&A reverts the QA status to todo
        if (data.qa_status && this.app.activeImage) {
          this.app.activeImage.qa_status = data.qa_status;
          this.app.updateLockStates();
        }
        this.renderQAList();
        this.app.updateActiveImageBadgeCounts();
        this.app.showToast(`Deleted QA ${qaId}`, 'info');
      }
    } catch (err) {
      console.error(err);
    }
  }

  escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
