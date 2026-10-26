/**
 * CanvasViewport Engine (dual-canvas architecture)
 *
 * baseCanvas    – draws only the image; re-rasterized on pan / zoom / filter / resize.
 * overlayCanvas – draws crosshair + point markers; cheap enough to redraw on mouse move.
 *
 * Splitting the layers keeps a 4K/8K source image from being re-drawn on every
 * mouse move (the dominant cost when crosshairs are enabled), while the minimap
 * background is pre-rendered once into an offscreen cache instead of re-scaling
 * the full-resolution image each frame.
 */

export class CanvasViewport {
  constructor(baseCanvasElement, overlayCanvasElement, minimapCanvasElement) {
    // Base layer: image pixels only.
    this.baseCanvas = baseCanvasElement;
    this.baseCtx = this.baseCanvas.getContext('2d', { alpha: false });

    // Overlay layer: crosshair + markers. Also the interaction surface (top-most).
    this.canvas = overlayCanvasElement;
    this.ctx = this.canvas.getContext('2d');

    this.minimapCanvas = minimapCanvasElement;
    this.minimapCtx = this.minimapCanvas ? this.minimapCanvas.getContext('2d') : null;
    this._minimapCache = document.createElement('canvas');
    // Annotation coverage dots are static per points-load: pre-render them
    // into their own cache so panning (15k+ dots) never re-plots per frame.
    this._minimapDotsCache = document.createElement('canvas');

    // Image & transforms
    this.image = null;
    this.imageLoaded = false;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this._loadToken = 0;

    this.scale = 1.0;
    this.panX = 0;
    this.panY = 0;
    this.minScale = 0.05;
    this.maxScale = 40.0;

    // View adjustments
    this.brightness = 100; // %
    this.contrast = 100;   // %
    this.hidePoints = false;
    this.showCrosshair = true;
    this.screenRadius = 6;  // px constant size on screen
    this.onHidePointsChange = null;

    // Mouse & interaction states
    this.mouseX = 0;
    this.mouseY = 0;
    this.mouseInside = false;
    this.isPanning = false;
    this.panStartX = 0;
    this.panStartY = 0;
    this.isSpacePressed = false;

    // Left-drag pan on empty space: below this threshold (px) the press is a
    // click (add point / deselect); beyond it the press becomes a view pan.
    this.LEFT_DRAG_THRESHOLD_PX = 4;
    this._pendingClickPan = null;

    // Data references
    this.points = [];
    this.selectedPointId = null;
    this.hoveredPointId = null;
    this.activeQATargetIds = new Set();

    // Bounding Boxes data & state
    this.bboxes = [];
    this.selectedBBoxId = null;
    this.hoveredBBoxId = null;
    this.activeQATargetBBoxIds = new Set();
    this.bboxesLocked = false;
    this.bboxTool = 'draw'; // 'draw' | 'select'
    this.drawingBBox = null;
    this.draggingBBox = null;

    this.workflowMode = 'point'; // 'point' | 'bbox' | 'qa'
    // True while the active image's status is 'completed': points become
    // read-only (select/inspect allowed, dragging and edits blocked).
    this.pointsLocked = false;

    // Callbacks
    this.onCursorMove = null;
    this.onPointClick = null;
    this.onPointHover = null;
    this.onPointDrag = null;
    this.onPointDragEnd = null;
    this.onBBoxCreate = null;
    this.onBBoxClick = null;
    this.onBBoxHover = null;
    this.onBBoxChange = null;
    this.onBBoxChangeEnd = null;
    this.getActiveBBoxDraftStyle = null;
    this.onCanvasClick = null;

    // Drag point state
    this.draggingPoint = null;
    this.dragStartImagePos = null;

    this.initEvents();
    this.resizeCanvas();

    // React to layout changes (window resize, sidebar toggles, zoomed browser UI)
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this.resizeCanvas());
      this._resizeObserver.observe(this.baseCanvas.parentElement);
    }
  }

  resizeCanvas() {
    const rect = this.baseCanvas.parentElement.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    this.baseCanvas.width = w;
    this.baseCanvas.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.requestRender();
  }

  loadImage(url) {
    return new Promise((resolve, reject) => {
      const token = ++this._loadToken;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (token !== this._loadToken) {
          resolve(null); // A newer load superseded this one; ignore silently.
          return;
        }
        this.image = img;
        this.naturalWidth = img.naturalWidth;
        this.naturalHeight = img.naturalHeight;
        this.imageLoaded = true;
        this.fitToScreen();
        this.renderMinimapBackground();
        // Dot positions depend on the image dimensions — re-plot for the new image
        this.renderMinimapDots();
        this.requestRender();
        resolve(img);
      };
      img.onerror = (err) => {
        console.error("Failed to load image:", url, err);
        if (token === this._loadToken) reject(err);
      };
      img.src = url;
    });
  }

  fitToScreen() {
    if (!this.imageLoaded) return;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const sx = (cw * 0.94) / this.naturalWidth;
    const sy = (ch * 0.94) / this.naturalHeight;
    this.scale = Math.min(sx, sy);
    this.panX = (cw - this.naturalWidth * this.scale) / 2;
    this.panY = (ch - this.naturalHeight * this.scale) / 2;
    this.requestRender();
  }

  // Zoom to actual pixels (1:1), keeping the given screen position fixed.
  zoomToActual(screenX, screenY) {
    if (!this.imageLoaded) return;
    const sx = screenX ?? this.canvas.width / 2;
    const sy = screenY ?? this.canvas.height / 2;
    const img = this.screenToImage(sx, sy);
    this.scale = 1.0;
    this.panX = sx - img.x;
    this.panY = sy - img.y;
    this.requestRender();
  }

  // Exact coordinate transformations
  screenToImage(screenX, screenY) {
    const imgX = (screenX - this.panX) / this.scale;
    const imgY = (screenY - this.panY) / this.scale;
    return {
      x: imgX,
      y: imgY,
      xClamped: Math.max(0, Math.min(this.naturalWidth, imgX)),
      yClamped: Math.max(0, Math.min(this.naturalHeight, imgY))
    };
  }

  imageToScreen(imgX, imgY) {
    return {
      x: imgX * this.scale + this.panX,
      y: imgY * this.scale + this.panY
    };
  }

  zoomAt(screenX, screenY, factor) {
    if (!this.imageLoaded) return;
    const oldScale = this.scale;
    const newScale = Math.min(this.maxScale, Math.max(this.minScale, oldScale * factor));
    if (newScale === oldScale) return;

    this.panX = screenX - (screenX - this.panX) * (newScale / oldScale);
    this.panY = screenY - (screenY - this.panY) * (newScale / oldScale);
    this.scale = newScale;
    this.requestRender();
  }

  setHidePoints(value) {
    this.hidePoints = value;
    if (this.onHidePointsChange) this.onHidePointsChange(value);
    this.renderMinimapDots();
    this.requestOverlayRender();
  }

  initEvents() {
    // Wheel Zoom centered on cursor
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      this.zoomAt(mx, my, factor);
    }, { passive: false });

    // Mouse Move
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouseX = e.clientX - rect.left;
      this.mouseY = e.clientY - rect.top;
      this.mouseInside = true;

      if (this.isPanning) {
        const dx = this.mouseX - this.panStartX;
        const dy = this.mouseY - this.panStartY;
        this.panStartX = this.mouseX;
        this.panStartY = this.mouseY;

        // Left-drag on empty space only becomes a pan once the cursor moves
        // past the threshold; smaller movements stay a "click in progress".
        if (this._pendingClickPan) {
          const dist = Math.hypot(
            this.mouseX - this._pendingClickPan.startX,
            this.mouseY - this._pendingClickPan.startY
          );
          if (dist > this.LEFT_DRAG_THRESHOLD_PX) {
            this._pendingClickPan.moved = true;
          }
          if (!this._pendingClickPan.moved) {
            this.requestOverlayRender();
            return;
          }
        }

        this.panX += dx;
        this.panY += dy;
        this.canvas.style.cursor = 'grabbing';
        this.requestRender();
        return;
      }

      // Drawing a new Bounding Box
      if (this.drawingBBox) {
        const pos = this.screenToImage(this.mouseX, this.mouseY);
        this.drawingBBox.currX = Math.round(pos.xClamped * 10) / 10;
        this.drawingBBox.currY = Math.round(pos.yClamped * 10) / 10;
        if (Math.hypot(this.mouseX - this.drawingBBox.startScreenX, this.mouseY - this.drawingBBox.startScreenY) > 4) {
          this.drawingBBox.moved = true;
        }
        this.requestOverlayRender();
        return;
      }

      // Moving or Resizing an existing Bounding Box
      if (this.draggingBBox) {
        const pos = this.screenToImage(this.mouseX, this.mouseY);
        this._applyBBoxDrag(pos.xClamped, pos.yClamped);
        if (this.onBBoxChange) {
          this.onBBoxChange(this.draggingBBox.bbox);
        }
        this.requestOverlayRender();
        return;
      }

      // Dragging point (image layer is untouched -> overlay-only render)
      if (this.draggingPoint) {
        const pos = this.screenToImage(this.mouseX, this.mouseY);
        this.draggingPoint.x = Math.round(pos.xClamped * 10) / 10;
        this.draggingPoint.y = Math.round(pos.yClamped * 10) / 10;
        if (this.naturalWidth > 0 && this.naturalHeight > 0) {
          this.draggingPoint.x_norm = +(this.draggingPoint.x / this.naturalWidth).toFixed(6);
          this.draggingPoint.y_norm = +(this.draggingPoint.y / this.naturalHeight).toFixed(6);
        }
        if (this.onPointDrag) {
          this.onPointDrag(this.draggingPoint);
        }
        this.requestOverlayRender();
        return;
      }

      if (this.workflowMode === 'bbox') {
        const handleHit = (!this.bboxesLocked && this.selectedBBoxId)
          ? this.findBBoxHandleAtScreen(this.mouseX, this.mouseY)
          : null;
        const bb = this.findBBoxAtScreen(this.mouseX, this.mouseY, this.bboxTool === 'draw');
        const nextHoverId = bb ? bb.bbox_id : null;
        if (nextHoverId !== this.hoveredBBoxId) {
          this.hoveredBBoxId = nextHoverId;
          if (this.onBBoxHover) this.onBBoxHover(bb);
          this.requestOverlayRender();
        }
        if (this.isSpacePressed) {
          this.canvas.style.cursor = 'grab';
        } else if (handleHit) {
          this.canvas.style.cursor = this._cursorForHandle(handleHit.handle);
        } else if (bb && (this.bboxTool === 'select' || bb._borderHit)) {
          this.canvas.style.cursor = this.bboxesLocked ? 'pointer' : 'move';
        } else {
          this.canvas.style.cursor = 'crosshair';
        }
      } else {
        // Check hover point (and hover bbox in QA mode)
        const pt = this.findPointNearScreen(this.mouseX, this.mouseY, this.screenRadius + 4);
        if ((pt ? pt.point_id : null) !== this.hoveredPointId) {
          this.hoveredPointId = pt ? pt.point_id : null;
          if (this.onPointHover) this.onPointHover(pt);
          this.requestOverlayRender();
        }
        if (this.workflowMode === 'qa') {
          const bb = !pt ? this.findBBoxAtScreen(this.mouseX, this.mouseY, false) : null;
          if ((bb ? bb.bbox_id : null) !== this.hoveredBBoxId) {
            this.hoveredBBoxId = bb ? bb.bbox_id : null;
            this.requestOverlayRender();
          }
        }

        // Cursor affordance
        if (this.isSpacePressed) {
          this.canvas.style.cursor = 'grab';
        } else if (pt) {
          this.canvas.style.cursor = (this.workflowMode === 'point' && !this.pointsLocked) ? 'move' : 'pointer';
        } else if (this.workflowMode === 'qa' && this.hoveredBBoxId) {
          this.canvas.style.cursor = 'pointer';
        } else {
          this.canvas.style.cursor = 'crosshair';
        }
      }

      // Cursor update callback
      if (this.onCursorMove && this.imageLoaded) {
        const coords = this.screenToImage(this.mouseX, this.mouseY);
        this.onCursorMove({
          screenX: this.mouseX,
          screenY: this.mouseY,
          imageX: coords.xClamped,
          imageY: coords.yClamped,
          normX: this.naturalWidth ? +(coords.xClamped / this.naturalWidth).toFixed(6) : 0,
          normY: this.naturalHeight ? +(coords.yClamped / this.naturalHeight).toFixed(6) : 0,
          isInside: coords.x >= 0 && coords.x <= this.naturalWidth && coords.y >= 0 && coords.y <= this.naturalHeight,
          scale: this.scale
        });
      }

      if (this.showCrosshair) {
        this.requestOverlayRender();
      }
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.mouseInside = false;
      if (this.hoveredPointId) {
        this.hoveredPointId = null;
        if (this.onPointHover) this.onPointHover(null);
      }
      if (this.hoveredBBoxId) {
        this.hoveredBBoxId = null;
        if (this.onBBoxHover) this.onBBoxHover(null);
      }
      this.requestOverlayRender();
    });

    // Mouse Down
    this.canvas.addEventListener('mousedown', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouseX = e.clientX - rect.left;
      this.mouseY = e.clientY - rect.top;

      // Pan with Space or Middle click (button 1) or Right click (button 2 with alt)
      if (this.isSpacePressed || e.button === 1 || (e.button === 2 && e.altKey)) {
        this.isPanning = true;
        this.panStartX = this.mouseX;
        this.panStartY = this.mouseY;
        this.canvas.style.cursor = 'grabbing';
        return;
      }

      if (e.button === 0) { // Left click
        if (this.workflowMode === 'bbox') {
          // 1. Check resize handles on selected bbox
          if (!this.bboxesLocked && this.selectedBBoxId) {
            const handleHit = this.findBBoxHandleAtScreen(this.mouseX, this.mouseY);
            if (handleHit) {
              const pos = this.screenToImage(this.mouseX, this.mouseY);
              this.draggingBBox = {
                bbox: handleHit.bbox,
                mode: handleHit.handle,
                startImgX: pos.xClamped,
                startImgY: pos.yClamped,
                origRect: {
                  x: handleHit.bbox.x,
                  y: handleHit.bbox.y,
                  width: handleHit.bbox.width,
                  height: handleHit.bbox.height
                }
              };
              this.requestOverlayRender();
              return;
            }
          }

          // 2. Check existing bbox hit (in 'select' mode: interior or border; in 'draw' mode: border/label hit)
          const hitBBox = this.findBBoxAtScreen(this.mouseX, this.mouseY, this.bboxTool === 'draw');
          if (hitBBox && (this.bboxTool === 'select' || hitBBox._borderHit || this.bboxesLocked)) {
            this.selectedBBoxId = hitBBox.bbox_id;
            if (!this.bboxesLocked) {
              const pos = this.screenToImage(this.mouseX, this.mouseY);
              this.draggingBBox = {
                bbox: hitBBox,
                mode: 'move',
                startImgX: pos.xClamped,
                startImgY: pos.yClamped,
                origRect: {
                  x: hitBBox.x,
                  y: hitBBox.y,
                  width: hitBBox.width,
                  height: hitBBox.height
                }
              };
            }
            if (this.onBBoxClick) this.onBBoxClick(hitBBox, e);
            this.requestOverlayRender();
            return;
          }

          // 3. In 'draw' mode (and unlocked), start drawing a new BBox on drag
          if (this.bboxTool === 'draw' && !this.bboxesLocked && this.imageLoaded) {
            const pos = this.screenToImage(this.mouseX, this.mouseY);
            const style = this.getActiveBBoxDraftStyle ? this.getActiveBBoxDraftStyle() : { color: '#EF4444', category: 'object' };
            this.drawingBBox = {
              startX: Math.round(pos.xClamped * 10) / 10,
              startY: Math.round(pos.yClamped * 10) / 10,
              currX: Math.round(pos.xClamped * 10) / 10,
              currY: Math.round(pos.yClamped * 10) / 10,
              startScreenX: this.mouseX,
              startScreenY: this.mouseY,
              moved: false,
              color: style.color || '#EF4444',
              category: style.category || 'object'
            };
            this.requestOverlayRender();
            return;
          }

          // 4. Otherwise ('select' mode on empty space, or locked): pan on drag, or select/deselect on click
          this.isPanning = true;
          this.panStartX = this.mouseX;
          this.panStartY = this.mouseY;
          this._pendingClickPan = { startX: this.mouseX, startY: this.mouseY, moved: false };
          this.requestOverlayRender();
          return;
        }

        const hitPoint = this.findPointNearScreen(this.mouseX, this.mouseY, this.screenRadius + 4);
        const hitBBoxInQA = (!hitPoint && this.workflowMode === 'qa')
          ? this.findBBoxAtScreen(this.mouseX, this.mouseY, false)
          : null;

        if (hitPoint) {
          if (this.workflowMode === 'point') {
            // Select the point; only start a drag when points are editable
            this.selectedPointId = hitPoint.point_id;
            if (!this.pointsLocked) {
              this.draggingPoint = hitPoint;
              this.dragStartImagePos = { x: hitPoint.x, y: hitPoint.y };
            }
            if (this.onPointClick) this.onPointClick(hitPoint, e);
          } else if (this.workflowMode === 'qa') {
            // QA Mode: Lock point edits. Clicking selects/toggles target point
            if (this.onPointClick) this.onPointClick(hitPoint, e);
          }
        } else if (hitBBoxInQA) {
          if (this.onBBoxClick) this.onBBoxClick(hitBBoxInQA, e);
        } else {
          // Empty space: press-and-hold pans the view. If released without
          // exceeding LEFT_DRAG_THRESHOLD_PX, it is treated as a click
          // (add point / deselect) instead of a drag.
          this.isPanning = true;
          this.panStartX = this.mouseX;
          this.panStartY = this.mouseY;
          this._pendingClickPan = { startX: this.mouseX, startY: this.mouseY, moved: false };
        }
        this.requestOverlayRender();
      }
    });

    // Mouse Up
    window.addEventListener('mouseup', (e) => {
      if (this.drawingBBox) {
        const draft = this.drawingBBox;
        this.drawingBBox = null;
        const x1 = Math.min(draft.startX, draft.currX);
        const y1 = Math.min(draft.startY, draft.currY);
        const w = Math.abs(draft.currX - draft.startX);
        const h = Math.abs(draft.currY - draft.startY);
        const screenW = w * this.scale;
        const screenH = h * this.scale;

        if (draft.moved && screenW >= 4 && screenH >= 4 && w >= 1 && h >= 1) {
          if (this.onBBoxCreate) {
            this.onBBoxCreate({
              x: Math.round(x1 * 10) / 10,
              y: Math.round(y1 * 10) / 10,
              width: Math.round(w * 10) / 10,
              height: Math.round(h * 10) / 10
            });
          }
        } else {
          // Short click without dragging: select bbox under cursor or deselect
          const hitAny = this.findBBoxAtScreen(draft.startScreenX, draft.startScreenY, false);
          if (hitAny) {
            this.selectedBBoxId = hitAny.bbox_id;
            if (this.onBBoxClick) this.onBBoxClick(hitAny, e);
          } else {
            this.selectedBBoxId = null;
            if (this.onBBoxClick) this.onBBoxClick(null, e);
          }
        }
        this.requestOverlayRender();
        return;
      }

      if (this.draggingBBox) {
        const dragInfo = this.draggingBBox;
        this.draggingBBox = null;
        const bb = dragInfo.bbox;
        const orig = dragInfo.origRect;
        if (
          bb.x !== orig.x ||
          bb.y !== orig.y ||
          bb.width !== orig.width ||
          bb.height !== orig.height
        ) {
          if (this.onBBoxChangeEnd) {
            this.onBBoxChangeEnd(bb, orig);
          }
        }
        this.renderMinimapDots();
        this.requestOverlayRender();
        return;
      }

      if (this.isPanning) {
        const pending = this._pendingClickPan;
        this._pendingClickPan = null;
        this.isPanning = false;
        this.canvas.style.cursor = this.isSpacePressed ? 'grab' : 'crosshair';

        // A left press on empty space that never turned into a drag is a
        // click: add point (Add tool), deselect (Select tool), etc.
        if (pending && !pending.moved) {
          const rect = this.canvas.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          if (mx >= 0 && my >= 0 && mx <= rect.width && my <= rect.height) {
            if (this.workflowMode === 'bbox') {
              this.selectedBBoxId = null;
              if (this.onBBoxClick) this.onBBoxClick(null, e);
              this.requestOverlayRender();
            } else if (this.onCanvasClick) {
              const coords = this.screenToImage(mx, my);
              this.onCanvasClick(coords, e);
            }
          }
        }
      }
      if (this.draggingPoint) {
        if (this.onPointDragEnd) {
          this.onPointDragEnd(this.draggingPoint, this.dragStartImagePos);
        }
        this.draggingPoint = null;
        this.dragStartImagePos = null;
      }
    });

    // Prevent default context menu on canvas for custom handling
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (this.workflowMode === 'bbox') {
        const bb = this.findBBoxAtScreen(mx, my, false);
        if (bb) {
          const evt = new CustomEvent('bbox-delete-request', { detail: { bbox_id: bb.bbox_id } });
          window.dispatchEvent(evt);
        }
        return;
      }
      const pt = this.findPointNearScreen(mx, my, this.screenRadius + 5);
      if (pt && this.workflowMode === 'point') {
        // Quick delete on right click
        const evt = new CustomEvent('point-delete-request', { detail: { point_id: pt.point_id } });
        window.dispatchEvent(evt);
      }
    });

    // Keyboard Space & H key listeners
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.code === 'Space' && !this.isSpacePressed) {
        this.isSpacePressed = true;
        if (!this.isPanning) this.canvas.style.cursor = 'grab';
        e.preventDefault();
      }
      if ((e.key === 'h' || e.key === 'H') && !this.hidePoints) {
        // Remember the pre-hold state so releasing H restores it
        this._hideBeforeKey = this.hidePoints;
        this.setHidePoints(true);
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.isSpacePressed = false;
        if (!this.isPanning) this.canvas.style.cursor = 'crosshair';
      }
      if (e.key === 'h' || e.key === 'H') {
        this.setHidePoints(this._hideBeforeKey ?? false);
        this._hideBeforeKey = null;
      }
    });

    // Interactive Minimap events
    if (this.minimapCanvas) {
      this.minimapCanvas.addEventListener('mousedown', (e) => {
        this.handleMinimapClick(e);
      });
      this.minimapCanvas.addEventListener('mousemove', (e) => {
        if (e.buttons === 1) {
          this.handleMinimapClick(e);
        }
      });
    }
  }

  handleMinimapClick(e) {
    if (!this.imageLoaded) return;
    const rect = this.minimapCanvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width;
    const my = (e.clientY - rect.top) / rect.height;

    // Target image coords
    const targetImgX = mx * this.naturalWidth;
    const targetImgY = my * this.naturalHeight;

    // Center screen on target
    this.panX = this.canvas.width / 2 - targetImgX * this.scale;
    this.panY = this.canvas.height / 2 - targetImgY * this.scale;
    this.requestRender();
  }

  findPointNearScreen(screenX, screenY, maxDistancePx) {
    let closest = null;
    let minD2 = maxDistancePx * maxDistancePx;
    // Inline transform math (no per-point object allocation): this runs on
    // every mouse move and must stay cheap even with 15k+ points.
    const sc = this.scale;
    const px = this.panX;
    const py = this.panY;

    for (const p of this.points) {
      const dx = p.x * sc + px - screenX;
      const dy = p.y * sc + py - screenY;
      const d2 = dx * dx + dy * dy;
      if (d2 <= minD2) {
        minD2 = d2;
        closest = p;
      }
    }
    return closest;
  }

  setPoints(pointsList) {
    this.points = pointsList || [];
    this.hoveredPointId = null;
    this.renderMinimapDots();
    this.requestOverlayRender();
  }

  setSelectedPoint(pointId) {
    this.selectedPointId = pointId;
    this.requestOverlayRender();
  }

  setBBoxes(bboxesList) {
    this.bboxes = bboxesList || [];
    this.hoveredBBoxId = null;
    this.renderMinimapDots();
    this.requestOverlayRender();
  }

  setSelectedBBox(bboxId) {
    this.selectedBBoxId = bboxId;
    this.requestOverlayRender();
  }

  setActiveQATargets(targetIds, targetBBoxIds) {
    this.activeQATargetIds = new Set(targetIds || []);
    if (targetBBoxIds !== undefined) {
      this.activeQATargetBBoxIds = new Set(targetBBoxIds || []);
    }
    this.renderMinimapDots();
    this.requestOverlayRender();
  }

  centerOnPoint(pointId) {
    const pt = this.points.find(p => p.point_id === pointId);
    if (!pt || !this.imageLoaded) return;
    this.panX = this.canvas.width / 2 - pt.x * this.scale;
    this.panY = this.canvas.height / 2 - pt.y * this.scale;
    this.selectedPointId = pointId;
    this.requestRender();
  }

  centerOnBBox(bboxId) {
    const bb = this.bboxes.find(b => b.bbox_id === bboxId);
    if (!bb || !this.imageLoaded) return;
    const cx = bb.x + bb.width / 2;
    const cy = bb.y + bb.height / 2;
    this.panX = this.canvas.width / 2 - cx * this.scale;
    this.panY = this.canvas.height / 2 - cy * this.scale;
    this.selectedBBoxId = bboxId;
    this.requestRender();
  }

  // ---- Bounding Box Hit-Testing & Geometry Helpers ------------------------

  _getBBoxScreenRect(bb) {
    const sc = this.scale;
    const x = bb.x * sc + this.panX;
    const y = bb.y * sc + this.panY;
    const w = bb.width * sc;
    const h = bb.height * sc;
    return { x, y, w, h, x2: x + w, y2: y + h };
  }

  _getBBoxHandlesScreen(bb) {
    const r = this._getBBoxScreenRect(bb);
    const mx = r.x + r.w / 2;
    const my = r.y + r.h / 2;
    return [
      { handle: 'nw', x: r.x,  y: r.y },
      { handle: 'n',  x: mx,   y: r.y },
      { handle: 'ne', x: r.x2, y: r.y },
      { handle: 'e',  x: r.x2, y: my },
      { handle: 'se', x: r.x2, y: r.y2 },
      { handle: 's',  x: mx,   y: r.y2 },
      { handle: 'sw', x: r.x,  y: r.y2 },
      { handle: 'w',  x: r.x,  y: my }
    ];
  }

  findBBoxHandleAtScreen(screenX, screenY, maxDistPx = 7) {
    if (!this.selectedBBoxId) return null;
    const bb = this.bboxes.find(b => b.bbox_id === this.selectedBBoxId);
    if (!bb) return null;
    const handles = this._getBBoxHandlesScreen(bb);
    for (const h of handles) {
      if (Math.abs(screenX - h.x) <= maxDistPx && Math.abs(screenY - h.y) <= maxDistPx) {
        return { bbox: bb, handle: h.handle };
      }
    }
    return null;
  }

  findBBoxAtScreen(screenX, screenY, borderPriorityOnly = false) {
    if (this.hidePoints || !this.bboxes.length) return null;
    const borderTol = 6;
    const borderHits = [];
    const interiorHits = [];

    for (const bb of this.bboxes) {
      const r = this._getBBoxScreenRect(bb);
      const inOuter = (
        screenX >= r.x - borderTol &&
        screenX <= r.x2 + borderTol &&
        screenY >= r.y - borderTol &&
        screenY <= r.y2 + borderTol
      );
      if (!inOuter) continue;

      const nearLeft   = Math.abs(screenX - r.x) <= borderTol;
      const nearRight  = Math.abs(screenX - r.x2) <= borderTol;
      const nearTop    = Math.abs(screenY - r.y) <= borderTol;
      const nearBottom = Math.abs(screenY - r.y2) <= borderTol;
      const nearLabel  = (screenX >= r.x && screenX <= r.x + Math.min(140, Math.max(48, r.w)) && screenY >= r.y - 18 && screenY <= r.y + 4);

      if (nearLeft || nearRight || nearTop || nearBottom || nearLabel) {
        borderHits.push(bb);
      } else if (screenX >= r.x && screenX <= r.x2 && screenY >= r.y && screenY <= r.y2) {
        interiorHits.push(bb);
      }
    }

    // Prefer smaller boxes when overlapping
    const byAreaAsc = (a, b) => (a.width * a.height) - (b.width * b.height);
    if (borderHits.length > 0) {
      borderHits.sort(byAreaAsc);
      const hit = borderHits[0];
      hit._borderHit = true;
      return hit;
    }
    if (!borderPriorityOnly && interiorHits.length > 0) {
      interiorHits.sort(byAreaAsc);
      const hit = interiorHits[0];
      hit._borderHit = false;
      return hit;
    }
    return null;
  }

  _cursorForHandle(handle) {
    switch (handle) {
      case 'nw':
      case 'se':
        return 'nwse-resize';
      case 'ne':
      case 'sw':
        return 'nesw-resize';
      case 'n':
      case 's':
        return 'ns-resize';
      case 'e':
      case 'w':
        return 'ew-resize';
      default:
        return 'move';
    }
  }

  _applyBBoxDrag(currImgX, currImgY) {
    if (!this.draggingBBox) return;
    const { bbox, mode, startImgX, startImgY, origRect } = this.draggingBBox;
    const dx = currImgX - startImgX;
    const dy = currImgY - startImgY;
    const W = this.naturalWidth || 1;
    const H = this.naturalHeight || 1;

    if (mode === 'move') {
      let nx = origRect.x + dx;
      let ny = origRect.y + dy;
      nx = Math.max(0, Math.min(W - origRect.width, nx));
      ny = Math.max(0, Math.min(H - origRect.height, ny));
      bbox.x = Math.round(nx * 10) / 10;
      bbox.y = Math.round(ny * 10) / 10;
    } else {
      let x1 = origRect.x;
      let y1 = origRect.y;
      let x2 = origRect.x + origRect.width;
      let y2 = origRect.y + origRect.height;

      if (mode.includes('w')) x1 = Math.max(0, Math.min(x2 - 1, x1 + dx));
      if (mode.includes('e')) x2 = Math.min(W, Math.max(x1 + 1, x2 + dx));
      if (mode.includes('n')) y1 = Math.max(0, Math.min(y2 - 1, y1 + dy));
      if (mode.includes('s')) y2 = Math.min(H, Math.max(y1 + 1, y2 + dy));

      bbox.x = Math.round(x1 * 10) / 10;
      bbox.y = Math.round(y1 * 10) / 10;
      bbox.width = Math.round((x2 - x1) * 10) / 10;
      bbox.height = Math.round((y2 - y1) * 10) / 10;
    }

    if (this.naturalWidth > 0 && this.naturalHeight > 0) {
      bbox.x_norm = +(bbox.x / this.naturalWidth).toFixed(6);
      bbox.y_norm = +(bbox.y / this.naturalHeight).toFixed(6);
      bbox.width_norm = +(bbox.width / this.naturalWidth).toFixed(6);
      bbox.height_norm = +(bbox.height / this.naturalHeight).toFixed(6);
      bbox.area_ratio = +(bbox.width_norm * bbox.height_norm).toFixed(8);
    }
  }

  // ---- Render scheduling -------------------------------------------------
  // requestRender()         -> base + overlay (pan / zoom / filter / resize)
  // requestOverlayRender()  -> overlay only (mouse move, hover, selection)

  requestRender() {
    this._scheduleRender(true, true);
  }

  requestOverlayRender() {
    this._scheduleRender(false, true);
  }

  _scheduleRender(needBase, needOverlay) {
    this._needBase = this._needBase || needBase;
    this._needOverlay = this._needOverlay || needOverlay;
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      const base = this._needBase;
      const overlay = this._needOverlay;
      this._needBase = false;
      this._needOverlay = false;
      if (base) this.renderBase();
      if (overlay) this.renderOverlay();
      this.renderMinimap();
    });
  }

  // Kept for API compatibility with older callers.
  render() {
    this.renderBase();
    this.renderOverlay();
    this.renderMinimap();
  }

  renderBase() {
    const cw = this.baseCanvas.width;
    const ch = this.baseCanvas.height;
    const ctx = this.baseCtx;

    // Background fill
    ctx.fillStyle = "#090d16";
    ctx.fillRect(0, 0, cw, ch);

    if (!this.imageLoaded || !this.image) {
      ctx.fillStyle = "#64748b";
      ctx.font = "14px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No image selected or loading...", cw / 2, ch / 2);
      return;
    }

    ctx.save();
    if (this.brightness !== 100 || this.contrast !== 100) {
      ctx.filter = `brightness(${this.brightness}%) contrast(${this.contrast}%)`;
    }
    // High-quality rendering
    ctx.imageSmoothingEnabled = this.scale < 2.0;
    ctx.drawImage(
      this.image,
      this.panX,
      this.panY,
      this.naturalWidth * this.scale,
      this.naturalHeight * this.scale
    );
    ctx.restore();
  }

  renderOverlay() {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, cw, ch);

    if (!this.imageLoaded) return;

    // Subtle Crosshair (only while the cursor is over the canvas)
    if (this.showCrosshair && this.mouseInside) {
      ctx.save();
      ctx.strokeStyle = "rgba(148, 163, 184, 0.25)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(this.mouseX, 0);
      ctx.lineTo(this.mouseX, ch);
      ctx.moveTo(0, this.mouseY);
      ctx.lineTo(cw, this.mouseY);
      ctx.stroke();
      ctx.restore();
    }

    // Constant Screen-Size Markers & Bounding Boxes (if not hidden)
    if (!this.hidePoints) {
      this.renderBBoxes(ctx);
      this.renderPoints(ctx);
    }
  }

  _renderTopCenterBanner(ctx, isLarge, pctStr, wPx, hPx) {
    const cw = this.canvas.width;
    const bannerH = 34;
    const bannerW = isLarge ? 590 : 430;
    const bx = Math.round((cw - bannerW) / 2);
    const by = 20;

    ctx.save();
    // Drop shadow
    ctx.shadowColor = isLarge ? "rgba(220, 38, 38, 0.85)" : "rgba(16, 185, 129, 0.5)";
    ctx.shadowBlur = isLarge ? 18 : 8;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 3;

    // Background pill
    ctx.fillStyle = isLarge ? "rgba(220, 38, 38, 0.96)" : "rgba(5, 150, 105, 0.92)";
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(bx, by, bannerW, bannerH, 8);
    } else {
      ctx.rect(bx, by, bannerW, bannerH);
    }
    ctx.fill();

    // Border
    ctx.strokeStyle = isLarge ? "#fecaca" : "#a7f3d0";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Text label
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 13px 'Segoe UI', system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const text = isLarge
      ? `⚠️ CẢNH BÁO: BBox = ${pctStr}% (≥ 0.1%) — VƯỢT TIÊU CHUẨN SMALL OBJECT!`
      : `✓ Chuẩn Small Object (< 0.1%): ${pctStr}% (${wPx}×${hPx}px)`;

    ctx.fillText(text, bx + bannerW / 2, by + bannerH / 2);
    ctx.restore();
  }

  renderBBoxes(ctx) {
    if (!this.bboxes.length && !this.drawingBBox) return;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const isBBoxMode = this.workflowMode === 'bbox';
    const isQAMode = this.workflowMode === 'qa';

    ctx.save();
    ctx.font = "600 10px JetBrains Mono, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    for (const bb of this.bboxes) {
      const r = this._getBBoxScreenRect(bb);
      if (r.x2 < -20 || r.x > cw + 20 || r.y2 < -20 || r.y > ch + 20) continue;

      const isSelected = bb.bbox_id === this.selectedBBoxId;
      const isHovered = bb.bbox_id === this.hoveredBBoxId;
      const isQATarget = this.activeQATargetBBoxIds.has(bb.bbox_id);
      const isDraggingThis = this.draggingBBox && this.draggingBBox.bbox === bb;
      const baseColor = bb.color || "#EF4444";

      const totalArea = (this.naturalWidth || 1) * (this.naturalHeight || 1);
      const areaPct = ((bb.area_ratio ?? ((bb.width * bb.height) / totalArea)) * 100);
      const isSmall = areaPct < 0.1;
      const pctStr = areaPct < 0.01 ? areaPct.toFixed(4) : areaPct.toFixed(3);

      if (isDraggingThis) {
        const isLarge = !isSmall;
        if (isLarge) {
          ctx.fillStyle = "rgba(239, 68, 68, 0.28)";
          ctx.fillRect(r.x, r.y, r.w, r.h);

          ctx.save();
          ctx.shadowColor = "rgba(239, 68, 68, 0.95)";
          ctx.shadowBlur = 14;
          ctx.strokeStyle = "#ef4444";
          ctx.lineWidth = 3;
          ctx.setLineDash([8, 4]);
          ctx.strokeRect(r.x, r.y, r.w, r.h);
          ctx.restore();
        } else {
          ctx.fillStyle = "rgba(16, 185, 129, 0.18)";
          ctx.fillRect(r.x, r.y, r.w, r.h);

          ctx.strokeStyle = "#10b981";
          ctx.lineWidth = 2.5;
          ctx.setLineDash([5, 4]);
          ctx.strokeRect(r.x, r.y, r.w, r.h);
        }
        ctx.setLineDash([]);

        // Dragging badge
        const dragLabel = isLarge
          ? `⚠️ VƯỢT 0.1%: ${pctStr}% (${Math.round(bb.width)}×${Math.round(bb.height)}px) — LARGE OBJECT`
          : `✓ Small: ${pctStr}% (${Math.round(bb.width)}×${Math.round(bb.height)}px)`;
        ctx.font = "bold 11px JetBrains Mono, monospace";
        const tw = ctx.measureText(dragLabel).width + 16;
        const by = r.y >= 24 ? r.y - 24 : r.y;
        ctx.fillStyle = isLarge ? "#dc2626" : "#059669";
        ctx.fillRect(r.x, by, tw, 22);
        ctx.strokeStyle = isLarge ? "#fecaca" : "#a7f3d0";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(r.x, by, tw, 22);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(dragLabel, r.x + 8, by + 11);
        ctx.font = "600 10px JetBrains Mono, monospace";

        this._renderTopCenterBanner(ctx, isLarge, pctStr, Math.round(bb.width), Math.round(bb.height));
      } else {
        // Interior fill for selected / hovered / QA target
        if (isQATarget) {
          ctx.fillStyle = "rgba(16, 185, 129, 0.22)";
          ctx.fillRect(r.x, r.y, r.w, r.h);
        } else if (isSelected) {
          ctx.fillStyle = !isSmall ? "rgba(239, 68, 68, 0.20)" : "rgba(251, 191, 36, 0.14)";
          ctx.fillRect(r.x, r.y, r.w, r.h);
        } else if (isHovered && (isBBoxMode || isQAMode)) {
          ctx.fillStyle = "rgba(255, 255, 255, 0.10)";
          ctx.fillRect(r.x, r.y, r.w, r.h);
        }

        // Border stroke
        ctx.beginPath();
        if (!isBBoxMode && !isQAMode && !isSelected) {
          ctx.setLineDash([4, 3]);
          ctx.globalAlpha = 0.65;
        } else {
          ctx.setLineDash([]);
          ctx.globalAlpha = 1.0;
        }
        ctx.strokeStyle = isQATarget ? "#10b981" : (isSelected ? (!isSmall ? "#ef4444" : "#fbbf24") : (isHovered ? "#ffffff" : baseColor));
        ctx.lineWidth = (isSelected || isQATarget) ? 2.5 : (isHovered ? 2.0 : 1.75);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.setLineDash([]);
        ctx.globalAlpha = 1.0;

        // Label badge at top-left (in bbox/qa mode, or when selected/hovered)
        if (isBBoxMode || isSelected || isHovered || isQATarget) {
          let labelText;
          if (isSelected || isHovered) {
            labelText = !isSmall
              ? `⚠️ ${bb.bbox_id} · ${bb.category} (${pctStr}% ≥ 0.1% LARGE)`
              : `${bb.bbox_id} · ${bb.category} (${pctStr}% · S)`;
          } else {
            labelText = !isSmall
              ? `⚠️ ${bb.bbox_id} · ${bb.category}`
              : `${bb.bbox_id} · ${bb.category}`;
          }

          const padX = 6;
          const badgeH = 18;
          ctx.font = !isSmall && isSelected ? "bold 10px JetBrains Mono, monospace" : "600 10px JetBrains Mono, monospace";
          const textW = ctx.measureText(labelText).width;
          const badgeW = textW + padX * 2;
          const badgeY = r.y >= badgeH + 2 ? r.y - badgeH : r.y;

          ctx.fillStyle = isQATarget ? "#059669" : (isSelected ? (!isSmall ? "#dc2626" : "#d97706") : (!isSmall ? "#b91c1c" : baseColor));
          ctx.fillRect(r.x, badgeY, badgeW, badgeH);
          ctx.fillStyle = "#ffffff";
          ctx.fillText(labelText, r.x + padX, badgeY + badgeH / 2);
          ctx.font = "600 10px JetBrains Mono, monospace";
        }
      }

      // Resize handles when selected in BBox mode & unlocked
      if (isSelected && isBBoxMode && !this.bboxesLocked) {
        const handles = this._getBBoxHandlesScreen(bb);
        const hs = 7;
        for (const h of handles) {
          ctx.fillStyle = !isSmall ? "#fee2e2" : "#ffffff";
          ctx.strokeStyle = !isSmall ? "#dc2626" : "#d97706";
          ctx.lineWidth = 1.5;
          ctx.fillRect(h.x - hs / 2, h.y - hs / 2, hs, hs);
          ctx.strokeRect(h.x - hs / 2, h.y - hs / 2, hs, hs);
        }
      }
    }

    // Active draft box while click-dragging to create a new BBox
    if (this.drawingBBox) {
      const d = this.drawingBBox;
      const x1 = Math.min(d.startX, d.currX);
      const y1 = Math.min(d.startY, d.currY);
      const w = Math.abs(d.currX - d.startX);
      const h = Math.abs(d.currY - d.startY);
      const s1 = this.imageToScreen(x1, y1);
      const sw = w * this.scale;
      const sh = h * this.scale;

      const totalArea = (this.naturalWidth || 1) * (this.naturalHeight || 1);
      const areaPct = ((w * h) / totalArea) * 100;
      const isLarge = areaPct >= 0.1;
      const pctStr = areaPct < 0.01 ? areaPct.toFixed(4) : areaPct.toFixed(3);

      if (isLarge) {
        ctx.fillStyle = "rgba(239, 68, 68, 0.28)";
        ctx.fillRect(s1.x, s1.y, sw, sh);

        ctx.save();
        ctx.shadowColor = "rgba(239, 68, 68, 0.95)";
        ctx.shadowBlur = 14;
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 4]);
        ctx.strokeRect(s1.x, s1.y, sw, sh);
        ctx.restore();
      } else {
        ctx.fillStyle = "rgba(16, 185, 129, 0.18)";
        ctx.fillRect(s1.x, s1.y, sw, sh);

        ctx.strokeStyle = "#10b981";
        ctx.lineWidth = 2.25;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(s1.x, s1.y, sw, sh);
      }
      ctx.setLineDash([]);

      const draftLabel = isLarge
        ? `⚠️ VƯỢT 0.1%: ${pctStr}% (${Math.round(w)}×${Math.round(h)}px) — LARGE OBJECT`
        : `✓ Small Object: ${pctStr}% (${Math.round(w)}×${Math.round(h)}px)`;

      ctx.font = "bold 11px JetBrains Mono, monospace";
      const tw = ctx.measureText(draftLabel).width + 16;
      const by = s1.y >= 24 ? s1.y - 24 : s1.y;

      ctx.fillStyle = isLarge ? "#dc2626" : "#059669";
      ctx.fillRect(s1.x, by, tw, 22);
      ctx.strokeStyle = isLarge ? "#fecaca" : "#a7f3d0";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(s1.x, by, tw, 22);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(draftLabel, s1.x + 8, by + 11);

      this._renderTopCenterBanner(ctx, isLarge, pctStr, Math.round(w), Math.round(h));
    }

    ctx.restore();
  }

  renderPoints(ctx) {
    const r = this.screenRadius;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const margin = r + 14;

    // Dense-image fast path: with thousands of markers (e.g. NWPU crowds with
    // 10k+ heads), plain filled squares for ordinary points keep the overlay
    // cheap; selected / hovered / QA-target points still get their full rings.
    const fastMode = this.points.length > 2000;

    ctx.lineWidth = 1.5;
    ctx.font = "10px JetBrains Mono, monospace";
    ctx.textAlign = 'left';

    for (const p of this.points) {
      const s = this.imageToScreen(p.x, p.y);
      // Cull points out of screen
      if (s.x < -margin || s.x > cw + margin || s.y < -margin || s.y > ch + margin) {
        continue;
      }

      const isSelected = p.point_id === this.selectedPointId;
      const isHovered = p.point_id === this.hoveredPointId;
      const isQATarget = this.activeQATargetIds.has(p.point_id);

      if (fastMode && !isSelected && !isHovered && !isQATarget) {
        ctx.fillStyle = p.color || "#ef4444";
        const d = r * 1.7;
        ctx.fillRect(s.x - d / 2, s.y - d / 2, d, d);
        continue;
      }

      // QA Target Glow
      if (isQATarget) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 7, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(16, 185, 129, 0.3)";
        ctx.fill();
        ctx.strokeStyle = "#10b981";
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.lineWidth = 1.5;
      }

      // Selected Point Highlight Ring
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = "#fbbf24";
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.lineWidth = 1.5;
      }

      // Hover Ring
      if (isHovered && !isSelected) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
      }

      // Point Core
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = p.color || "#ef4444";
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();

      // If QA target or selected, draw small ID label
      if (isSelected || isQATarget) {
        ctx.fillStyle = isQATarget ? "#6ee7b7" : "#fef08a";
        ctx.fillText(p.point_id, s.x + r + 4, s.y + 3);
      }
    }
  }

  // Pre-render the scaled-down image once per load (not per frame).
  renderMinimapBackground() {
    if (!this.minimapCtx || !this.imageLoaded) return;
    const mw = this.minimapCanvas.width;
    const mh = this.minimapCanvas.height;
    this._minimapCache.width = mw;
    this._minimapCache.height = mh;
    const cacheCtx = this._minimapCache.getContext('2d');
    cacheCtx.clearRect(0, 0, mw, mh);
    cacheCtx.drawImage(this.image, 0, 0, mw, mh);
  }

  // Re-render the (static) annotation coverage dots into their cache layer.
  // Called on points load / QA target change / hide toggle — not per frame.
  renderMinimapDots() {
    if (!this.minimapCtx) return;
    const mw = this.minimapCanvas.width;
    const mh = this.minimapCanvas.height;
    this._minimapDotsCache.width = mw;
    this._minimapDotsCache.height = mh;
    const dctx = this._minimapDotsCache.getContext('2d');
    dctx.clearRect(0, 0, mw, mh);
    if (this.hidePoints || (!this.points.length && !this.bboxes.length) || !this.naturalWidth || !this.naturalHeight) return;

    // Plot bounding boxes on minimap
    if (this.bboxes.length) {
      dctx.strokeStyle = "rgba(245, 158, 11, 0.75)";
      dctx.lineWidth = 1;
      for (const b of this.bboxes) {
        const x = (b.x / this.naturalWidth) * mw;
        const y = (b.y / this.naturalHeight) * mh;
        const w = Math.max(2, (b.width / this.naturalWidth) * mw);
        const h = Math.max(2, (b.height / this.naturalHeight) * mh);
        dctx.strokeRect(x, y, w, h);
      }
    }

    // Two passes (normal dots, then QA targets) keep fillStyle constant per
    // pass — one style switch instead of one per point.
    dctx.fillStyle = "rgba(239, 68, 68, 0.55)";
    for (const p of this.points) {
      const x = (p.x / this.naturalWidth) * mw;
      const y = (p.y / this.naturalHeight) * mh;
      dctx.fillRect(x - 0.5, y - 0.5, 1.5, 1.5);
    }
    if (this.activeQATargetIds.size) {
      dctx.fillStyle = "#34d399";
      for (const p of this.points) {
        if (!this.activeQATargetIds.has(p.point_id)) continue;
        const x = (p.x / this.naturalWidth) * mw;
        const y = (p.y / this.naturalHeight) * mh;
        dctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
    }
  }

  renderMinimap() {
    if (!this.minimapCtx || !this.imageLoaded) return;
    const mw = this.minimapCanvas.width;
    const mh = this.minimapCanvas.height;
    const mctx = this.minimapCtx;

    // Blit cached layers instead of re-scaling the full-res image and
    // re-plotting every annotation dot each frame.
    mctx.clearRect(0, 0, mw, mh);
    if (this._minimapCache.width > 0) {
      mctx.drawImage(this._minimapCache, 0, 0);
    }
    if (!this.hidePoints && this._minimapDotsCache.width > 0) {
      mctx.drawImage(this._minimapDotsCache, 0, 0);
    }

    // Calculate visible viewport rectangle in image coords
    const topLeft = this.screenToImage(0, 0);
    const bottomRight = this.screenToImage(this.canvas.width, this.canvas.height);

    const x1 = Math.max(0, (topLeft.x / this.naturalWidth) * mw);
    const y1 = Math.max(0, (topLeft.y / this.naturalHeight) * mh);
    const x2 = Math.min(mw, (bottomRight.x / this.naturalWidth) * mw);
    const y2 = Math.min(mh, (bottomRight.y / this.naturalHeight) * mh);

    mctx.save();
    mctx.fillStyle = "rgba(99, 102, 241, 0.15)";
    mctx.fillRect(x1, y1, Math.max(4, x2 - x1), Math.max(4, y2 - y1));
    mctx.strokeStyle = "#ef4444";
    mctx.lineWidth = 1.5;
    mctx.strokeRect(x1, y1, Math.max(4, x2 - x1), Math.max(4, y2 - y1));
    mctx.restore();
  }
}
