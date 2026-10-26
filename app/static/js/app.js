/**
 * HRVS Annotation Platform - Main Application Coordinator
 */

import { CanvasViewport } from 'app/canvas_viewport';
import { PointWorkflow } from 'app/point_workflow';
import { BBoxWorkflow } from 'app/bbox_workflow';
import { QAWorkflow } from 'app/qa_workflow';

export class App {
  constructor() {
    this.currentWorkflow = 'point'; // 'point' | 'bbox' | 'qa'
    this.images = [];
    this.activeImageIndex = 0;
    this.activeImage = null;

    // Dataset explorer: null = top-level dataset folder view,
    // a string = drilled into that dataset's image list.
    this.datasets = [];
    this.activeDataset = null;

    // Read-only protection: completed images cannot be edited until their
    // status is reverted (per workflow: points, bboxes, vs. Q&A pairs).
    this.pointLocked = false;
    this.bboxLocked = false;
    this.qaLocked = false;

    // Filters
    this.statusFilter = 'all';
    this.densityFilter = 'all';
    this.searchQuery = '';

    // Guard against out-of-order image detail responses (rapid A/D navigation)
    this._imageReqToken = 0;

    // Initialize Viewport Engine (dual-canvas: base = image, overlay = markers)
    const canvas = document.getElementById('annotationCanvas');
    const overlayCanvas = document.getElementById('overlayCanvas');
    const minimapCanvas = document.getElementById('minimapCanvas');
    this.viewport = new CanvasViewport(canvas, overlayCanvas, minimapCanvas);

    // Initialize Workflows
    this.pointWorkflow = new PointWorkflow(this);
    this.bboxWorkflow = new BBoxWorkflow(this);
    this.qaWorkflow = new QAWorkflow(this);

    this.initUI();
    this.initGlobalShortcuts();
    this.bootstrap();
  }

  async bootstrap() {
    await this.pointWorkflow.loadCategories();
    this.updateSidebarView();
    await this.loadImages();
  }

  initUI() {
    // Mode Switcher Tabs
    this.tabPointMode = document.getElementById('tabPointMode');
    this.tabBBoxMode = document.getElementById('tabBBoxMode');
    this.tabQAMode = document.getElementById('tabQAMode');
    this.panelPointWorkflow = document.getElementById('panelPointWorkflow');
    this.panelBBoxWorkflow = document.getElementById('panelBBoxWorkflow');
    this.panelQAWorkflow = document.getElementById('panelQAWorkflow');
    this.modeBannerQA = document.getElementById('modeBannerQA');

    if (this.tabPointMode) {
      this.tabPointMode.addEventListener('click', () => this.switchWorkflow('point'));
    }
    if (this.tabBBoxMode) {
      this.tabBBoxMode.addEventListener('click', () => this.switchWorkflow('bbox'));
    }
    if (this.tabQAMode) {
      this.tabQAMode.addEventListener('click', () => this.switchWorkflow('qa'));
    }

    // Image Steppers
    this.prevImgBtn = document.getElementById('prevImageBtn');
    this.nextImgBtn = document.getElementById('nextImageBtn');
    this.stepperText = document.getElementById('stepperText');
    if (this.prevImgBtn) this.prevImgBtn.addEventListener('click', () => this.prevImage());
    if (this.nextImgBtn) this.nextImgBtn.addEventListener('click', () => this.nextImage());

    // Search & Filter
    this.searchInput = document.getElementById('imageSearchInput');
    this.statusFilterSelect = document.getElementById('statusFilterSelect');
    this.densityFilterSelect = document.getElementById('densityFilterSelect');

    // Dataset explorer: back button returns to the dataset folder list
    this.backToDatasetsBtn = document.getElementById('backToDatasetsBtn');
    if (this.backToDatasetsBtn) {
      this.backToDatasetsBtn.addEventListener('click', () => this.backToDatasets());
    }

    if (this.searchInput) {
      let debounceTimer = null;
      this.searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.trim().toLowerCase();
        // Debounce to avoid a server round-trip on every keystroke
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => this.loadImages(), 250);
      });
    }
    if (this.statusFilterSelect) {
      this.statusFilterSelect.addEventListener('change', (e) => {
        this.statusFilter = e.target.value;
        this.loadImages();
      });
    }
    if (this.densityFilterSelect) {
      this.densityFilterSelect.addEventListener('change', (e) => {
        this.densityFilter = e.target.value;
        this.loadImages();
      });
    }

    // Image Status & Density dropdowns in Viewport / Panel
    this.imageStatusSelect = document.getElementById('imageStatusSelect');
    this.imageDensitySelect = document.getElementById('imageDensitySelect');
    this.bboxDensitySelect = document.getElementById('bboxDensitySelect');
    if (this.imageStatusSelect) {
      this.imageStatusSelect.addEventListener('change', (e) => {
        if (this.currentWorkflow === 'bbox') {
          this.updateBBoxStatus(e.target.value);
        } else {
          this.updateImageStatus(e.target.value);
        }
      });
    }
    if (this.imageDensitySelect) {
      this.imageDensitySelect.addEventListener('change', (e) => {
        this.updateImageDensity(e.target.value);
      });
    }
    if (this.bboxDensitySelect) {
      this.bboxDensitySelect.addEventListener('change', (e) => {
        this.updateImageDensity(e.target.value);
      });
    }

    // QA status dropdown (QA workflow progress: question & answer pairs)
    this.qaStatusSelect = document.getElementById('qaStatusSelect');
    if (this.qaStatusSelect) {
      this.qaStatusSelect.addEventListener('change', (e) => {
        this.updateQAStatus(e.target.value);
      });
    }

    // Viewport Toolbar Buttons
    const fitBtn = document.getElementById('toolFitScreen');
    const zoomInBtn = document.getElementById('toolZoomIn');
    const zoomOutBtn = document.getElementById('toolZoomOut');
    const actualSizeBtn = document.getElementById('toolActualSize');
    const hideBtn = document.getElementById('toolToggleHide');
    const crosshairBtn = document.getElementById('toolToggleCrosshair');
    const markerSizeSelect = document.getElementById('markerSizeSelect');
    this.zoomLevelBadge = document.getElementById('zoomLevelBadge');

    if (fitBtn) fitBtn.addEventListener('click', () => this.viewport.fitToScreen());
    if (zoomInBtn) zoomInBtn.addEventListener('click', () => {
      this.viewport.zoomAt(this.viewport.canvas.width / 2, this.viewport.canvas.height / 2, 1.25);
    });
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => {
      this.viewport.zoomAt(this.viewport.canvas.width / 2, this.viewport.canvas.height / 2, 0.8);
    });
    if (actualSizeBtn) {
      actualSizeBtn.addEventListener('click', () => this.viewport.zoomToActual());
    }
    if (hideBtn) {
      hideBtn.addEventListener('click', () => {
        this.viewport.setHidePoints(!this.viewport.hidePoints);
      });
      // Keep the toolbar button in sync with the H-hold key
      this.viewport.onHidePointsChange = (v) => hideBtn.classList.toggle('active', v);
    }
    if (crosshairBtn) {
      crosshairBtn.addEventListener('click', () => {
        this.viewport.showCrosshair = !this.viewport.showCrosshair;
        crosshairBtn.classList.toggle('active', this.viewport.showCrosshair);
        this.viewport.requestRender();
      });
    }
    if (markerSizeSelect) {
      markerSizeSelect.addEventListener('change', (e) => {
        this.viewport.screenRadius = parseInt(e.target.value, 10) || 6;
        this.viewport.requestRender();
      });
    }

    // Finish button: mark the image completed + write its final annotation JSON file.
    // Once completed the image is locked (read-only) and the same button turns
    // into Unlock, which reverts the status so points / bboxes can be edited again.
    const finishBtn = document.getElementById('finishImageBtn');
    if (finishBtn) {
      finishBtn.addEventListener('click', async () => {
        if (!this.activeImage) return;
        if (this.currentWorkflow === 'bbox') {
          if (this.bboxLocked) {
            await this.updateBBoxStatus('in_progress');
            this.showToast('Unlocked — bounding boxes are editable again (BBox status: in progress)', 'info');
            return;
          }
          if (this.viewport.bboxes.length === 0 &&
              !confirm('This image has no bounding boxes. Mark BBox status as completed anyway?')) {
            return;
          }
          finishBtn.disabled = true;
          try {
            await this.updateBBoxStatus('completed');
            this.showToast('BBox Completed — annotation saved & locked', 'success');
          } finally {
            finishBtn.disabled = false;
          }
          return;
        }

        if (this.pointLocked) {
          await this.updateImageStatus('in_progress');
          this.showToast('Unlocked — points are editable again (status: in progress)', 'info');
          return;
        }
        if (this.viewport.points.length === 0 &&
            !confirm('This image has no points. Mark it as completed anyway?')) {
          return;
        }
        finishBtn.disabled = true;
        try {
          const res = await fetch(`/api/images/${this.activeImage.image_id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'completed' })
          });
          if (res.ok) {
            const data = await res.json();
            this.activeImage.status = 'completed';
            if (this.imageStatusSelect) this.imageStatusSelect.value = 'completed';
            this.updateLockStates();
            await this.loadImages();
            this.showToast(`Completed — annotation saved to ${data.annotation_file || 'storage/annotations/'}`, 'success');
          } else {
            this.showToast('Failed to finish image', 'error');
          }
        } catch (err) {
          console.error(err);
          this.showToast('Failed to finish image', 'error');
        } finally {
          finishBtn.disabled = false;
        }
      });
    }

    // Finish QA button: same lock/unlock pattern for Q&A pairs
    const finishQABtn = document.getElementById('finishQABtn');
    if (finishQABtn) {
      finishQABtn.addEventListener('click', async () => {
        if (!this.activeImage) return;
        if (this.qaLocked) {
          await this.updateQAStatus('in_progress');
          this.showToast('Unlocked — Q&A pairs are editable again (QA status: in progress)', 'info');
          return;
        }
        if (this.qaWorkflow.qaList.length === 0 &&
            !confirm('This image has no Q&A pairs. Mark its QA as completed anyway?')) {
          return;
        }
        finishQABtn.disabled = true;
        try {
          await this.updateQAStatus('completed');
          this.showToast('QA completed — Q&A editing locked', 'success');
        } finally {
          finishQABtn.disabled = false;
        }
      });
    }

    // Brightness / Contrast Controls
    const brightnessSlider = document.getElementById('brightnessSlider');
    const contrastSlider = document.getElementById('contrastSlider');
    const resetFiltersBtn = document.getElementById('resetFiltersBtn');

    if (brightnessSlider) {
      brightnessSlider.addEventListener('input', (e) => {
        this.viewport.brightness = parseInt(e.target.value, 10);
        document.getElementById('brightnessVal').textContent = `${this.viewport.brightness}%`;
        this.viewport.requestRender();
      });
    }
    if (contrastSlider) {
      contrastSlider.addEventListener('input', (e) => {
        this.viewport.contrast = parseInt(e.target.value, 10);
        document.getElementById('contrastVal').textContent = `${this.viewport.contrast}%`;
        this.viewport.requestRender();
      });
    }
    if (resetFiltersBtn) {
      resetFiltersBtn.addEventListener('click', () => {
        this.viewport.brightness = 100;
        this.viewport.contrast = 100;
        if (brightnessSlider) brightnessSlider.value = 100;
        if (contrastSlider) contrastSlider.value = 100;
        document.getElementById('brightnessVal').textContent = '100%';
        document.getElementById('contrastVal').textContent = '100%';
        this.viewport.requestRender();
      });
    }

    // Viewport HUD updates
    this.hudCoords = document.getElementById('hudCoords');
    this.hudNorm = document.getElementById('hudNorm');
    this.hudZoom = document.getElementById('hudZoom');
    this.hudRes = document.getElementById('hudRes');

    this.viewport.onCursorMove = (info) => {
      if (this.hudCoords) {
        this.hudCoords.textContent = `(${Math.round(info.imageX * 10) / 10}, ${Math.round(info.imageY * 10) / 10})`;
      }
      if (this.hudNorm) {
        this.hudNorm.textContent = `[${info.normX}, ${info.normY}]`;
      }
      if (this.hudZoom) {
        this.hudZoom.textContent = `${info.scale.toFixed(2)}x`;
      }
      if (this.zoomLevelBadge) {
        this.zoomLevelBadge.textContent = `${Math.round(info.scale * 100)}%`;
      }
    };

    // Draggable floating toolbar (handle: drag to move, double-click to reset)
    this.initDraggableToolbar();

    // Modals
    this.initModals();
  }

  /**
   * Makes the floating canvas toolbar draggable via its grip handle.
   * - Natural width is measured once and locked in px, so the toolbar keeps its
   *   exact size and shape wherever it is moved (no re-wrapping near edges)
   * - Position is clamped inside the viewport so it can never be lost off-screen
   * - Persisted in localStorage and restored on load (re-clamped on window resize)
   * - Double-clicking the handle resets to the default centered position
   */
  initDraggableToolbar() {
    const toolbar = document.querySelector('.canvas-toolbar');
    const handle = document.getElementById('toolbarDragHandle');
    const viewport = document.getElementById('viewportCenter');
    if (!toolbar || !handle || !viewport) return;

    const STORAGE_KEY = 'hrvs_toolbar_pos';

    const savePos = (x, y) => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ x, y })); } catch (e) { /* storage unavailable */ }
    };

    // An absolutely positioned element with width:auto shrinks to fit the space
    // left of the right edge — so its wrap changes with its position. Measuring
    // the natural width (anchored at 0) and locking it in px removes that
    // dependency entirely: same size and shape at every position.
    const lockNaturalWidth = () => {
      toolbar.style.left = '0px';
      toolbar.style.top = '0px';
      toolbar.style.transform = 'none';
      toolbar.style.width = 'auto';
      const natural = toolbar.offsetWidth; // already capped by max-width
      toolbar.style.width = `${natural}px`;
      return natural;
    };

    const applyPos = (x, y, save = false) => {
      // Keep the toolbar fully inside the viewport at all times
      const vw = viewport.clientWidth;
      const vh = viewport.clientHeight;
      const tw = toolbar.offsetWidth;
      const th = toolbar.offsetHeight;
      x = Math.min(Math.max(0, x), Math.max(0, vw - tw));
      y = Math.min(Math.max(0, y), Math.max(0, vh - th));
      toolbar.style.left = `${x}px`;
      toolbar.style.top = `${y}px`;
      toolbar.style.transform = 'none';
      if (save) savePos(x, y);
    };

    const centerDefault = () => {
      const w = lockNaturalWidth();
      applyPos((viewport.clientWidth - w) / 2, 14, false);
    };

    // Lock the size first, then restore a saved position (or default-center)
    lockNaturalWidth();
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) { /* ignore */ }
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      applyPos(saved.x, saved.y, false);
    } else {
      applyPos((viewport.clientWidth - toolbar.offsetWidth) / 2, 14, false);
    }

    // On resize: re-measure (content/max-width may have changed) and re-clamp
    window.addEventListener('resize', () => {
      if (toolbar.classList.contains('dragging')) return;
      const vRect = viewport.getBoundingClientRect();
      const tRect = toolbar.getBoundingClientRect();
      lockNaturalWidth();
      applyPos(tRect.left - vRect.left, tRect.top - vRect.top, false);
    });

    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const vRect = viewport.getBoundingClientRect();
      const tRect = toolbar.getBoundingClientRect();
      const offsetX = e.clientX - tRect.left;
      const offsetY = e.clientY - tRect.top;
      toolbar.classList.add('dragging');

      const onMove = (ev) => {
        applyPos(ev.clientX - vRect.left - offsetX, ev.clientY - vRect.top - offsetY, false);
      };
      const onUp = () => {
        toolbar.classList.remove('dragging');
        const r = toolbar.getBoundingClientRect();
        savePos(r.left - vRect.left, r.top - vRect.top);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    handle.addEventListener('dblclick', () => {
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
      centerDefault();
      this.showToast('Toolbar reset to default position', 'info');
    });
  }

  initModals() {
    // Import Modal
    const importModal = document.getElementById('importModal');
    const openImportBtn = document.getElementById('openImportBtn');
    const closeImportBtn = document.getElementById('closeImportBtn');
    const submitImportFolderBtn = document.getElementById('submitImportFolderBtn');
    const importFolderPathInput = document.getElementById('importFolderPathInput');
    const importFolderGroup = document.getElementById('importFolderGroup');

    if (openImportBtn && importModal) {
      openImportBtn.addEventListener('click', () => importModal.classList.add('open'));
    }
    if (closeImportBtn && importModal) {
      closeImportBtn.addEventListener('click', () => importModal.classList.remove('open'));
    }
    if (submitImportFolderBtn) {
      submitImportFolderBtn.addEventListener('click', async () => {
        const folder = importFolderPathInput.value.trim();
        if (!folder) return alert('Please enter a folder path.');
        submitImportFolderBtn.disabled = true;
        submitImportFolderBtn.textContent = 'Scanning...';
        try {
          const res = await fetch('/api/images/import-folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder_path: folder, density_group: importFolderGroup.value })
          });
          const data = await res.json();
          if (res.ok) {
            this.showToast(`Imported ${data.imported_count} images (${data.auto_loaded_annotations} with annotations)`, 'success');
            importModal.classList.remove('open');
            await this.backToDatasets();
          } else {
            alert(data.detail || 'Import failed');
          }
        } catch (err) {
          console.error(err);
          alert('Import error');
        } finally {
          submitImportFolderBtn.disabled = false;
          submitImportFolderBtn.textContent = 'Import Folder';
        }
      });
    }

    // Dataset import: images + NWPU-style annotation JSONs in one go
    const submitDatasetImportBtn = document.getElementById('submitDatasetImportBtn');
    const datasetImportPathInput = document.getElementById('datasetImportPathInput');
    const datasetImportNameInput = document.getElementById('datasetImportNameInput');

    if (submitDatasetImportBtn) {
      submitDatasetImportBtn.addEventListener('click', async () => {
        const rootPath = datasetImportPathInput ? datasetImportPathInput.value.trim() : '';
        if (!rootPath) return alert('Please enter the dataset root folder path.');
        submitDatasetImportBtn.disabled = true;
        submitDatasetImportBtn.textContent = 'Importing...';
        try {
          const res = await fetch('/api/datasets/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              root_path: rootPath,
              dataset_name: (datasetImportNameInput && datasetImportNameInput.value.trim()) || null,
              density_group: importFolderGroup.value
            })
          });
          const data = await res.json();
          if (res.ok) {
            this.showToast(
              `Dataset "${data.dataset}": ${data.total_images} images — ` +
              `${data.with_annotations} completed, ${data.without_annotations} todo, ` +
              `${data.total_points.toLocaleString()} points`,
              'success'
            );
            importModal.classList.remove('open');
            await this.backToDatasets();
          } else {
            alert(data.detail || 'Dataset import failed');
          }
        } catch (err) {
          console.error(err);
          alert('Dataset import error');
        } finally {
          submitDatasetImportBtn.disabled = false;
          submitDatasetImportBtn.textContent = 'Import Dataset';
        }
      });
    }

    // File / Multi-file / Folder Upload Input
    const fileUploadInput = document.getElementById('fileUploadInput');
    if (fileUploadInput) {
      fileUploadInput.addEventListener('change', async (e) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;
        const formData = new FormData();
        for (const file of files) {
          formData.append('files', file);
        }
        formData.append('density_group', importFolderGroup.value);

        this.showToast(`Uploading ${files.length} images...`, 'info');
        try {
          const res = await fetch('/api/images/upload', {
            method: 'POST',
            body: formData
          });
          const data = await res.json();
          if (res.ok) {
            this.showToast(`Uploaded ${data.uploaded_count} images successfully!`, 'success');
            importModal.classList.remove('open');
            await this.backToDatasets();
          }
        } catch (err) {
          console.error(err);
          alert('Upload failed');
        }
      });
    }

    // Export Modal
    const exportModal = document.getElementById('exportModal');
    const openExportBtn = document.getElementById('openExportBtn');
    const closeExportBtn = document.getElementById('closeExportBtn');
    const downloadJsonBtn = document.getElementById('downloadJsonBtn');
    const downloadCsvBtn = document.getElementById('downloadCsvBtn');
    const downloadBBoxesCsvBtn = document.getElementById('downloadBBoxesCsvBtn');
    const downloadSingleJsonBtn = document.getElementById('downloadSingleJsonBtn');

    if (openExportBtn && exportModal) {
      openExportBtn.addEventListener('click', () => {
        exportModal.classList.add('open');
        this.updateExportPreview();
      });
    }
    if (closeExportBtn && exportModal) {
      closeExportBtn.addEventListener('click', () => exportModal.classList.remove('open'));
    }
    if (downloadJsonBtn) {
      downloadJsonBtn.addEventListener('click', () => {
        window.location.href = '/api/export/json';
      });
    }
    if (downloadCsvBtn) {
      downloadCsvBtn.addEventListener('click', () => {
        window.location.href = '/api/export/csv';
      });
    }
    if (downloadBBoxesCsvBtn) {
      downloadBBoxesCsvBtn.addEventListener('click', () => {
        window.location.href = '/api/export/bboxes-csv';
      });
    }
    if (downloadSingleJsonBtn) {
      downloadSingleJsonBtn.addEventListener('click', () => {
        if (this.activeImage) {
          window.location.href = `/api/export/image/${this.activeImage.image_id}`;
        }
      });
    }

    // Force-rewrite all per-image annotation JSON files from the database
    const syncAnnotationFilesBtn = document.getElementById('syncAnnotationFilesBtn');
    if (syncAnnotationFilesBtn) {
      syncAnnotationFilesBtn.addEventListener('click', async () => {
        syncAnnotationFilesBtn.disabled = true;
        syncAnnotationFilesBtn.textContent = 'Syncing...';
        try {
          const res = await fetch('/api/annotations/sync-all', { method: 'POST' });
          const data = await res.json();
          if (res.ok) {
            this.showToast(`Rewrote ${data.files_written} annotation file(s) in ${data.annotations_dir}/`, 'success');
          }
        } catch (err) {
          console.error(err);
          this.showToast('Sync failed', 'error');
        } finally {
          syncAnnotationFilesBtn.disabled = false;
          syncAnnotationFilesBtn.textContent = '🔄 Sync Annotation Files';
        }
      });
    }

    // Shortcuts Modal
    const shortcutsModal = document.getElementById('shortcutsModal');
    const openShortcutsBtn = document.getElementById('openShortcutsBtn');
    const closeShortcutsBtn = document.getElementById('closeShortcutsBtn');
    if (openShortcutsBtn && shortcutsModal) {
      openShortcutsBtn.addEventListener('click', () => shortcutsModal.classList.add('open'));
    }
    if (closeShortcutsBtn && shortcutsModal) {
      closeShortcutsBtn.addEventListener('click', () => shortcutsModal.classList.remove('open'));
    }

    // Click on the dark overlay backdrop closes any modal
    document.querySelectorAll('.modal-overlay').forEach((overlay) => {
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) overlay.classList.remove('open');
      });
    });

    // Backup Button
    const backupBtn = document.getElementById('triggerBackupBtn');
    if (backupBtn) {
      backupBtn.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/backup', { method: 'POST' });
          const data = await res.json();
          if (res.ok) {
            this.showToast(`Backup saved to ${data.filename}`, 'success');
          }
        } catch (err) {
          console.error(err);
        }
      });
    }
  }

  initGlobalShortcuts() {
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      // A / ArrowLeft for Previous Image
      if (e.key === 'a' || e.key === 'A' || e.key === 'ArrowLeft') {
        e.preventDefault();
        this.prevImage();
      }
      // D / ArrowRight for Next Image
      if (e.key === 'd' || e.key === 'D' || e.key === 'ArrowRight') {
        e.preventDefault();
        this.nextImage();
      }
      // F or R for Fit to Screen
      if (e.key === 'f' || e.key === 'F' || e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        this.viewport.fitToScreen();
      }
      // Z for Zoom 1:1 (actual pixels)
      if (e.key === 'z' || e.key === 'Z') {
        this.viewport.zoomToActual();
      }
      // Escape: close modal > cancel QA editor > deselect point or bbox
      if (e.key === 'Escape') {
        const openModal = document.querySelector('.modal-overlay.open');
        if (openModal) {
          openModal.classList.remove('open');
        } else if (this.currentWorkflow === 'qa' && this.qaWorkflow && this.qaWorkflow.editingQA) {
          this.qaWorkflow.cancelQAEditor();
        } else if (this.currentWorkflow === 'bbox' && this.bboxWorkflow) {
          this.bboxWorkflow.deselectBBox();
        } else if (this.pointWorkflow) {
          this.pointWorkflow.deselectPoint();
        }
      }
      // ? for Shortcuts Modal
      if (e.key === '?') {
        const modal = document.getElementById('shortcutsModal');
        if (modal) modal.classList.toggle('open');
      }
    });
  }

  switchWorkflow(mode) {
    this.currentWorkflow = mode;
    this.viewport.workflowMode = mode;

    const addBtn = document.getElementById('toolAddPoint');
    const selectBtn = document.getElementById('toolSelectPoint');

    if (mode === 'point') {
      if (this.tabPointMode) this.tabPointMode.classList.add('active');
      if (this.tabBBoxMode) this.tabBBoxMode.classList.remove('active');
      if (this.tabQAMode) this.tabQAMode.classList.remove('active');
      if (this.panelPointWorkflow) this.panelPointWorkflow.style.display = 'flex';
      if (this.panelBBoxWorkflow) this.panelBBoxWorkflow.style.display = 'none';
      if (this.panelQAWorkflow) this.panelQAWorkflow.style.display = 'none';
      if (this.modeBannerQA) this.modeBannerQA.style.display = 'none';
      if (addBtn) {
        addBtn.innerHTML = '<span>➕ Add</span>';
        addBtn.title = 'Add Point (Key: P)';
      }
      if (selectBtn) {
        selectBtn.title = 'Select / Move Point (Key: V)';
      }
      this.pointWorkflow.setTool(this.pointWorkflow.activeTool);
      this.showToast('Mode 1: Point Annotation active', 'info');
    } else if (mode === 'bbox') {
      if (this.tabPointMode) this.tabPointMode.classList.remove('active');
      if (this.tabBBoxMode) this.tabBBoxMode.classList.add('active');
      if (this.tabQAMode) this.tabQAMode.classList.remove('active');
      if (this.panelPointWorkflow) this.panelPointWorkflow.style.display = 'none';
      if (this.panelBBoxWorkflow) this.panelBBoxWorkflow.style.display = 'flex';
      if (this.panelQAWorkflow) this.panelQAWorkflow.style.display = 'none';
      if (this.modeBannerQA) this.modeBannerQA.style.display = 'none';
      if (addBtn) {
        addBtn.innerHTML = '<span>➕ Draw Box</span>';
        addBtn.title = 'Draw Bounding Box (Keys: B or P)';
      }
      if (selectBtn) {
        selectBtn.title = 'Select / Move / Resize BBox (Key: V)';
      }
      this.bboxWorkflow.setTool(this.bboxWorkflow.activeTool);
      this.showToast('Mode 2: Bounding Box Annotation active', 'info');
    } else if (mode === 'qa') {
      if (this.tabPointMode) this.tabPointMode.classList.remove('active');
      if (this.tabBBoxMode) this.tabBBoxMode.classList.remove('active');
      if (this.tabQAMode) this.tabQAMode.classList.add('active');
      if (this.panelPointWorkflow) this.panelPointWorkflow.style.display = 'none';
      if (this.panelBBoxWorkflow) this.panelBBoxWorkflow.style.display = 'none';
      if (this.panelQAWorkflow) this.panelQAWorkflow.style.display = 'flex';
      if (this.modeBannerQA) this.modeBannerQA.style.display = 'block';
      this.showToast('Mode 3: QA Annotation active (Click points/boxes to link targets)', 'info');
    }

    if (this.imageStatusSelect && this.activeImage) {
      this.imageStatusSelect.value = mode === 'bbox'
        ? (this.activeImage.bbox_status || 'todo')
        : this.activeImage.status;
    }

    // Applies per-workflow read-only locks (QA mode disables point/bbox tools too)
    this.updateLockStates();
    // Sidebar status badges + the status filter follow the active workflow's
    // status, so re-label the filter and refetch with the matching param
    if (this.statusFilterSelect) {
      if (mode === 'qa') {
        this.statusFilterSelect.title = 'Filter by QA Status';
        this.statusFilterSelect.options[0].text = 'QA Status: All';
      } else if (mode === 'bbox') {
        this.statusFilterSelect.title = 'Filter by BBox Status';
        this.statusFilterSelect.options[0].text = 'BBox Status: All';
      } else {
        this.statusFilterSelect.title = 'Filter by Point Status';
        this.statusFilterSelect.options[0].text = 'Status: All';
      }
    }
    this.loadImages();
    this.viewport.requestRender();
  }

  /**
   * Completed images are read-only, per workflow:
   *  - Point editing locks when the image `status` is 'completed'
   *  - BBox editing locks when `bbox_status` is 'completed'
   *  - Q&A editing locks when `qa_status` is 'completed' (image has Q&A pairs)
   * Unlocking = reverting the respective status (dropdown or Finish/Unlock button).
   */
  updateLockStates() {
    const img = this.activeImage;
    this.pointLocked = !!(img && img.status === 'completed');
    this.bboxLocked = !!(img && img.bbox_status === 'completed');
    this.qaLocked = !!(img && img.qa_status === 'completed');
    this.viewport.pointsLocked = this.pointLocked;
    this.viewport.bboxesLocked = this.bboxLocked;

    const activeCanvasLocked = (this.currentWorkflow === 'qa') ||
      (this.currentWorkflow === 'bbox' ? this.bboxLocked : this.pointLocked);

    // Canvas tools: disabled in QA mode or when the active workflow is locked
    const pointToolIds = ['toolAddPoint', 'toolSelectPoint', 'toolUndo', 'toolRedo', 'toolClearPoints'];
    pointToolIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = activeCanvasLocked;
    });

    // Lock badge + Finish <-> Unlock button for Point / BBox mode
    const isLocked = this.currentWorkflow === 'bbox' ? this.bboxLocked : this.pointLocked;
    const pointLockBadge = document.getElementById('pointLockBadge');
    if (pointLockBadge) pointLockBadge.style.display = isLocked ? 'inline-flex' : 'none';
    const finishBtn = document.getElementById('finishImageBtn');
    if (finishBtn) {
      finishBtn.innerHTML = isLocked ? '<span>🔓 Unlock</span>' : '<span>✅ Finish</span>';
      finishBtn.classList.toggle('unlock-btn', isLocked);
      finishBtn.title = isLocked
        ? 'Completed and locked. Click to revert to In Progress and edit annotations.'
        : 'Mark as Completed and save its annotation JSON file';
    }

    // QA status select, lock banner, Finish QA <-> Unlock QA button
    if (this.qaStatusSelect && img) this.qaStatusSelect.value = img.qa_status;
    const qaLockBanner = document.getElementById('qaLockBanner');
    if (qaLockBanner) qaLockBanner.style.display = this.qaLocked ? 'flex' : 'none';
    const finishQABtn = document.getElementById('finishQABtn');
    if (finishQABtn) {
      finishQABtn.innerHTML = this.qaLocked ? '<span>🔓 Unlock QA</span>' : '<span>✅ Finish QA</span>';
      finishQABtn.classList.toggle('unlock-btn', this.qaLocked);
      finishQABtn.title = this.qaLocked
        ? 'QA is completed and locked. Click to revert to In Progress and edit Q&A pairs.'
        : "Mark this image's QA as Completed and lock Q&A editing";
    }

    if (this.qaWorkflow) this.qaWorkflow.setLocked(this.qaLocked);
  }

  async updateBBoxStatus(newStatus) {
    if (!this.activeImage) return;
    try {
      const res = await fetch(`/api/images/${this.activeImage.image_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bbox_status: newStatus })
      });
      if (res.ok) {
        this.activeImage.bbox_status = newStatus;
        if (this.imageStatusSelect && this.currentWorkflow === 'bbox') {
          this.imageStatusSelect.value = newStatus;
        }
        this.updateLockStates();
        this.loadImages();
        this.showToast(`BBox status changed to ${newStatus.replace('_', ' ')}`, 'info');
      }
    } catch (err) {
      console.error(err);
    }
  }

  async updateQAStatus(newStatus) {
    if (!this.activeImage) return;
    try {
      const res = await fetch(`/api/images/${this.activeImage.image_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qa_status: newStatus })
      });
      if (res.ok) {
        this.activeImage.qa_status = newStatus;
        this.updateLockStates();
        this.loadImages();
        this.showToast(`QA status changed to ${newStatus.replace('_', ' ')}`, 'info');
      }
    } catch (err) {
      console.error(err);
    }
  }

  async loadImages() {
    const params = new URLSearchParams();
    // Status filter follows the active workflow
    const statusParam = this.currentWorkflow === 'qa'
      ? 'qa_status'
      : (this.currentWorkflow === 'bbox' ? 'bbox_status' : 'status');
    if (this.statusFilter !== 'all') params.append(statusParam, this.statusFilter);
    if (this.densityFilter !== 'all') params.append('density_group', this.densityFilter);
    if (this.searchQuery) params.append('search', this.searchQuery);
    if (this.activeDataset) params.append('dataset', this.activeDataset);

    try {
      const res = await fetch(`/api/images?${params.toString()}`);
      const data = await res.json();
      this.images = data.images || [];

      if (this.activeDataset === null) {
        // Top level: the sidebar shows dataset folders, but the full image
        // list is still loaded so the canvas and A / D navigation keep working.
        await this.loadDatasets();
      } else {
        this.renderImageList();
      }

      // Maintain active image or select first
      if (this.images.length > 0) {
        const foundIdx = this.activeImage ? this.images.findIndex(img => img.image_id === this.activeImage.image_id) : -1;
        this.selectImageByIndex(foundIdx >= 0 ? foundIdx : 0);
      } else {
        this.activeImage = null;
        this.activeImageIndex = 0;
        this.updateStepper();
      }

      // Update total stats
      this.updateGlobalStats();
    } catch (err) {
      console.error('Failed to load images:', err);
    }
  }

  // ---- Dataset Explorer (left sidebar top level) --------------------------

  async loadDatasets() {
    try {
      const res = await fetch('/api/datasets');
      const data = await res.json();
      this.datasets = data.datasets || [];
    } catch (err) {
      console.error('Failed to load datasets:', err);
    }
    if (this.activeDataset === null) {
      this.renderDatasetList();
    }
  }

  renderDatasetList() {
    const container = document.getElementById('datasetListContainer');
    if (!container) return;
    container.innerHTML = '';

    if (this.datasets.length === 0) {
      container.innerHTML = `
        <div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 0.8rem;">
          No datasets yet.<br>Use <strong>Import</strong> to add images.
        </div>
      `;
      return;
    }

    this.datasets.forEach((ds) => {
      const card = document.createElement('div');
      card.className = 'dataset-card';

      const pct = ds.image_count > 0 ? Math.round((ds.completed_count / ds.image_count) * 100) : 0;
      const densityTags = [];
      if (ds.same_object_count > 0) {
        densityTags.push(`<span class="tag-density density-same">Same-obj</span>`);
      }
      if (ds.mixed_object_count > 0) {
        densityTags.push(`<span class="tag-density density-mixed">Mixed-obj</span>`);
      }

      card.innerHTML = `
        <div class="card-top">
          <span class="card-title" title="${ds.dataset}">📁 ${ds.dataset}</span>
          <span class="status-badge status-completed">${pct}%</span>
        </div>
        <div class="card-meta-row">
          <div class="card-tags">
            ${densityTags.join('')}
            <span style="font-family: var(--font-mono); font-size: 0.65rem; color: var(--text-secondary);">🖼 ${ds.image_count}</span>
            <span style="font-family: var(--font-mono); font-size: 0.65rem; color: #fca5a5;">📍 ${this.formatCount(ds.point_count)}</span>
            <span style="font-family: var(--font-mono); font-size: 0.65rem; color: #fbbf24;">📦 ${this.formatCount(ds.bbox_count || 0)}</span>
            <span style="font-family: var(--font-mono); font-size: 0.65rem; color: #6ee7b7;" title="Images with completed Q&A">💬 ${ds.qa_completed_count}/${ds.image_count}</span>
          </div>
        </div>
        <div class="dataset-progress">
          <div class="dataset-progress-fill" style="width: ${pct}%"></div>
        </div>
        <div class="dataset-meta-footer">
          <span>✅ ${ds.completed_count} completed</span>
          <span>🕒 ${ds.in_progress_count} in progress</span>
          <span>📋 ${ds.todo_count} todo</span>
        </div>
      `;

      card.addEventListener('click', () => this.openDataset(ds.dataset));
      container.appendChild(card);
    });
  }

  async openDataset(name) {
    this.activeDataset = name;
    this.updateSidebarView();
    await this.loadImages();
  }

  async backToDatasets() {
    this.activeDataset = null;
    this.updateSidebarView();
    await this.loadImages();
  }

  // Switches the left sidebar between the dataset folder list and the
  // image list of the active dataset.
  updateSidebarView() {
    const inside = this.activeDataset !== null;
    const dsContainer = document.getElementById('datasetListContainer');
    const imgContainer = document.getElementById('imageListContainer');
    const backBtn = document.getElementById('backToDatasetsBtn');
    const title = document.getElementById('sidebarTitle');
    const searchBox = document.getElementById('searchFilterBox');

    if (dsContainer) dsContainer.style.display = inside ? 'none' : 'flex';
    if (imgContainer) imgContainer.style.display = inside ? 'flex' : 'none';
    if (backBtn) backBtn.style.display = inside ? 'inline-flex' : 'none';
    if (title) title.textContent = inside ? this.activeDataset : 'Datasets';
    if (searchBox) searchBox.style.display = inside ? 'flex' : 'none';
  }

  // 503000 -> "503k" (compact counts on dataset cards)
  formatCount(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }

  renderImageList() {
    const container = document.getElementById('imageListContainer');
    if (!container) return;
    const prevScrollTop = container.scrollTop;
    container.innerHTML = '';

    if (this.images.length === 0) {
      container.innerHTML = `
        <div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 0.8rem;">
          No matching images found.<br>Use <strong>Import</strong> to add images.
        </div>
      `;
      return;
    }

    this.images.forEach((img, idx) => {
      const card = document.createElement('div');
      card.className = `image-card ${idx === this.activeImageIndex ? 'active' : ''}`;
      card.id = `img-card-${img.image_id}`;

      const densityClass = img.density_group === 'same_object' ? 'density-same' : 'density-mixed';
      const densityLabel = img.density_group === 'same_object' ? 'Same-obj' : 'Mixed-obj';

      // Sidebar badge tracks the active workflow: QA mode shows qa_status, BBox mode shows bbox_status
      const badgeStatus = this.currentWorkflow === 'qa'
        ? (img.qa_status || 'todo')
        : (this.currentWorkflow === 'bbox' ? (img.bbox_status || 'todo') : img.status);
      const badgeTitle = `Point: ${img.status.replace('_', ' ')} | BBox: ${(img.bbox_status || 'todo').replace('_', ' ')} | QA: ${(img.qa_status || 'todo').replace('_', ' ')}`;

      card.innerHTML = `
        <img class="card-thumb" src="/api/images/${encodeURIComponent(img.image_id)}/thumbnail"
             alt="" loading="lazy" onerror="this.classList.add('thumb-error')">
        <div class="card-main">
          <div class="card-top">
            <span class="card-title" title="${img.file_name}">${img.file_name}</span>
            <span class="status-badge status-${badgeStatus}" id="card-status-${img.image_id}" title="${badgeTitle}">${badgeStatus.replace('_', ' ')}</span>
          </div>
          <div class="card-meta-row">
            <div class="card-tags">
              <span class="tag-density ${densityClass}">${densityLabel}</span>
              <span style="font-family: var(--font-mono); font-size: 0.65rem;">${img.width}x${img.height}</span>
            </div>
          </div>
          <div class="tag-counts">
            <span class="count-point" id="card-pts-${img.image_id}">📍 ${img.point_count}</span>
            <span class="count-bbox" id="card-bbs-${img.image_id}" title="BBox status: ${(img.bbox_status || 'todo').replace('_', ' ')}">📦 ${img.bbox_count || 0}</span>
            <span class="count-qa ${img.qa_status === 'completed' ? 'qa-done' : ''}" id="card-qa-${img.image_id}" title="QA status: ${(img.qa_status || 'todo').replace('_', ' ')}">💬 ${img.qa_count}</span>
          </div>
        </div>
      `;

      card.addEventListener('click', () => {
        this.selectImageByIndex(idx);
      });

      container.appendChild(card);
    });

    container.scrollTop = prevScrollTop;
  }

  async selectImageByIndex(index) {
    if (index < 0 || index >= this.images.length) return;
    this.activeImageIndex = index;
    const item = this.images[index];

    // Highlight active card
    const cards = document.querySelectorAll('.image-card');
    cards.forEach((c, i) => c.classList.toggle('active', i === index));

    this.updateStepper();

    // Fetch full details
    const token = ++this._imageReqToken;
    try {
      const res = await fetch(`/api/images/${item.image_id}`);
      const fullImg = await res.json();
      if (token !== this._imageReqToken) return; // A newer selection superseded this response
      this.activeImage = fullImg;

      // Update resolution in HUD
      if (this.hudRes) {
        this.hudRes.textContent = `${fullImg.width} × ${fullImg.height} px`;
      }
      if (this.imageStatusSelect) {
        this.imageStatusSelect.value = this.currentWorkflow === 'bbox'
          ? (fullImg.bbox_status || 'todo')
          : fullImg.status;
      }
      if (this.imageDensitySelect) {
        this.imageDensitySelect.value = fullImg.density_group;
      }
      if (this.bboxDensitySelect) {
        this.bboxDensitySelect.value = fullImg.density_group;
      }
      if (this.qaStatusSelect) {
        this.qaStatusSelect.value = fullImg.qa_status || 'todo';
      }

      // Reset per-image workflow state (undo history, selection, open editors)
      // so actions from the previous image can never leak into this one.
      this.pointWorkflow.resetForImage();
      this.bboxWorkflow.resetForImage();
      this.qaWorkflow.resetForImage();

      // Load image into viewport FIRST so a failure in any later UI update
      // can never leave the canvas blank
      await this.viewport.loadImage(`/api/images/serve/${fullImg.image_id}`);

      // Pass points, bboxes, and QAs to workflows
      this.viewport.setPoints(fullImg.points || []);
      this.viewport.setBBoxes(fullImg.bboxes || []);
      this.pointWorkflow.renderCategoryGrid();
      this.pointWorkflow.renderPointsSummary();
      this.bboxWorkflow.renderCategoryGrid();
      this.bboxWorkflow.renderBBoxesSummary();
      this.qaWorkflow.setQAList(fullImg.qa_annotations || []);

      // If QA targets active, highlight
      if (this.currentWorkflow === 'qa' && this.qaWorkflow.selectedQAId) {
        this.viewport.setActiveQATargets(
          this.qaWorkflow.getTargetsForQA(this.qaWorkflow.selectedQAId),
          this.qaWorkflow.getBBoxTargetsForQA(this.qaWorkflow.selectedQAId)
        );
      }

      // Bring the active card into view when navigating with A / D
      const activeCard = document.getElementById(`img-card-${fullImg.image_id}`);
      if (activeCard) activeCard.scrollIntoView({ block: 'nearest' });

      this.viewport.requestRender();

      // Apply per-workflow read-only locks LAST: purely UI state (badges,
      // button labels, tool disabling) — the server still enforces the
      // locks, so a failure here must never block the image itself.
      try {
        this.updateLockStates();
      } catch (err) {
        console.error('updateLockStates failed:', err);
      }
    } catch (err) {
      console.error('Failed to load image details:', err);
    }
  }

  prevImage() {
    if (this.images.length === 0) return;
    const nextIdx = (this.activeImageIndex - 1 + this.images.length) % this.images.length;
    this.selectImageByIndex(nextIdx);
  }

  nextImage() {
    if (this.images.length === 0) return;
    const nextIdx = (this.activeImageIndex + 1) % this.images.length;
    this.selectImageByIndex(nextIdx);
  }

  updateStepper() {
    if (this.stepperText) {
      const total = this.images.length;
      const curr = total > 0 ? this.activeImageIndex + 1 : 0;
      this.stepperText.textContent = `${curr} / ${total}`;
    }
  }

  async updateImageStatus(newStatus) {
    if (!this.activeImage) return;
    try {
      const res = await fetch(`/api/images/${this.activeImage.image_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      if (res.ok) {
        this.activeImage.status = newStatus;
        this.loadImages();
        this.showToast(`Status changed to ${newStatus}`, 'info');
      }
    } catch (err) {
      console.error(err);
    }
  }

  async updateImageDensity(newDensity) {
    if (!this.activeImage) return;
    try {
      const res = await fetch(`/api/images/${this.activeImage.image_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ density_group: newDensity })
      });
      if (res.ok) {
        this.activeImage.density_group = newDensity;
        if (this.imageDensitySelect) this.imageDensitySelect.value = newDensity;
        if (this.bboxDensitySelect) this.bboxDensitySelect.value = newDensity;
        this.pointWorkflow.renderCategoryGrid();
        this.bboxWorkflow.renderCategoryGrid();
        this.loadImages();
        this.showToast(`Density group set to ${newDensity}`, 'info');
      }
    } catch (err) {
      console.error(err);
    }
  }

  updateActiveImageBadgeCounts() {
    if (!this.activeImage) return;
    const ptsCount = this.viewport.points.length;
    const bbsCount = this.viewport.bboxes.length;
    const qaCount = this.qaWorkflow.qaList.length;

    const ptEl = document.getElementById(`card-pts-${this.activeImage.image_id}`);
    const bbEl = document.getElementById(`card-bbs-${this.activeImage.image_id}`);
    const qaEl = document.getElementById(`card-qa-${this.activeImage.image_id}`);
    if (ptEl) ptEl.textContent = `📍 ${ptsCount}`;
    if (bbEl) bbEl.textContent = `📦 ${bbsCount}`;
    if (qaEl) qaEl.textContent = `💬 ${qaCount}`;

    // Status badge follows the active workflow
    const stEl = document.getElementById(`card-status-${this.activeImage.image_id}`);
    if (stEl) {
      const badgeStatus = this.currentWorkflow === 'qa'
        ? (this.activeImage.qa_status || 'todo')
        : (this.currentWorkflow === 'bbox' ? (this.activeImage.bbox_status || 'todo') : this.activeImage.status);
      stEl.className = `status-badge status-${badgeStatus}`;
      stEl.textContent = badgeStatus.replace('_', ' ');
    }

    this.updateGlobalStats();
  }

  async updateGlobalStats() {
    try {
      const res = await fetch('/api/stats');
      const stats = await res.json();
      const progressPill = document.getElementById('progressPill');
      if (progressPill) {
        const pct = stats.total_images > 0 ? Math.round((stats.completed_images / stats.total_images) * 100) : 0;
        progressPill.textContent = `${stats.completed_images}/${stats.total_images} (${pct}%)`;
      }
      const qaPill = document.getElementById('qaProgressPill');
      if (qaPill) {
        qaPill.textContent = `💬 ${stats.qa_completed_images}/${stats.total_images}`;
      }
    } catch (err) {}
  }

  async updateExportPreview() {
    const previewEl = document.getElementById('exportJsonPreview');
    if (!previewEl) return;
    previewEl.textContent = 'Generating preview...';
    try {
      const res = await fetch('/api/export/json');
      const data = await res.json();
      const text = JSON.stringify(data, null, 2);
      // Cap the preview so very large datasets don't freeze the DOM
      previewEl.textContent = text.length > 20000
        ? text.slice(0, 20000) + '\n\n... (preview truncated — download the full JSON for all records)'
        : text;
    } catch (err) {
      previewEl.textContent = 'Preview error.';
    }
  }

  showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icon = type === 'success' ? '✅' : (type === 'error' ? '❌' : (type === 'warning' ? '⚠️' : 'ℹ️'));
    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 2800);
  }
}

// Instantiate on DOM load
window.addEventListener('DOMContentLoaded', () => {
  window.hrvsApp = new App();
});
