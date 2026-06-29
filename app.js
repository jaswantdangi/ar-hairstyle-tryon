/* =========================================================================
   AR Hairstyle Try-On — demo engine
   MediaPipe FaceMesh (tracking) + Three.js (PNG hairstyle overlay)
   Single-file vanilla JS port of the architecture in the implementation guide.
   ========================================================================= */

(() => {
  'use strict';

  // ----- DOM refs -----
  const els = {
    video:        document.getElementById('camera'),
    overlay:      document.getElementById('overlay'),
    stage:        document.getElementById('stage'),
    statusChip:   document.getElementById('statusChip'),
    faceHint:     document.getElementById('faceHint'),
    loading:      document.getElementById('loadingOverlay'),
    loadingText:  document.getElementById('loadingText'),
    errorOverlay: document.getElementById('errorOverlay'),
    errorTitle:   document.getElementById('errorTitle'),
    errorMessage: document.getElementById('errorMessage'),
    strip:        document.getElementById('hairstyleStrip'),
    btnCapture:   document.getElementById('btnCapture'),
    btnReset:     document.getElementById('btnReset'),
    btnCalib:     document.getElementById('btnCalib'),
    calib:        document.getElementById('calib'),
    cScale:       document.getElementById('cScale'),
    cOffY:        document.getElementById('cOffY'),
    cOffX:        document.getElementById('cOffX'),
    vScale:       document.getElementById('vScale'),
    vOffY:        document.getElementById('vOffY'),
    vOffX:        document.getElementById('vOffX'),
    captureOverlay: document.getElementById('captureOverlay'),
    captureImg:   document.getElementById('captureImg'),
    btnDownload:  document.getElementById('btnDownload'),
    btnCloseCapture: document.getElementById('btnCloseCapture'),
  };

  const CONFIDENCE_THRESHOLD = 0.5; // min detection score to show hairstyle

  // ----- App state -----
  const state = {
    hairstyles: [],
    selectedId: null,
    tracking: { detected: false, confidence: 0, x: 0, y: 0, scale: 1, rotationZ: 0 },
    three: null,   // { renderer, scene, camera, hairMesh, currentTexture }
    faceMesh: null,
    rafRunning: false,
  };

  /* ----------------------------------------------------------------------
     Error handling
     ---------------------------------------------------------------------- */
  function fatalError(title, message) {
    els.loading.hidden = true;
    els.loading.style.display = 'none';
    els.errorTitle.textContent = title;
    els.errorMessage.textContent = message;
    els.errorOverlay.hidden = false;
  }

  function setLoading(text) {
    if (text === null) { els.loading.style.display = 'none'; return; }
    els.loading.style.display = 'flex';
    els.loadingText.textContent = text;
  }

  function setStatus(text, cls) {
    els.statusChip.textContent = text;
    els.statusChip.className = 'status-chip' + (cls ? ' ' + cls : '');
  }

  /* ----------------------------------------------------------------------
     Environment checks
     ---------------------------------------------------------------------- */
  function checkEnvironment() {
    const isSecure = window.isSecureContext ||
      ['localhost', '127.0.0.1'].includes(location.hostname);
    if (!isSecure) {
      fatalError('HTTPS required',
        'Camera access only works over HTTPS or on localhost. Serve this demo over a secure connection.');
      return false;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      fatalError('Browser not supported',
        'Your browser does not support camera access (getUserMedia).');
      return false;
    }
    const testCanvas = document.createElement('canvas');
    const gl = testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
    if (!gl) {
      fatalError('WebGL not supported',
        'Your browser/device does not support WebGL, which is required to render the overlay.');
      return false;
    }
    if (typeof THREE === 'undefined') {
      fatalError('Failed to load Three.js', 'Could not load the 3D rendering library. Check your connection.');
      return false;
    }
    if (typeof FaceMesh === 'undefined') {
      fatalError('Failed to load face tracker', 'Could not load MediaPipe FaceMesh. Check your connection.');
      return false;
    }
    return true;
  }

  /* ----------------------------------------------------------------------
     Hairstyle assets — loaded from config/hairstyles.json
     ---------------------------------------------------------------------- */
  async function loadHairstyles() {
    try {
      const res = await fetch('config/hairstyles.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      state.hairstyles = await res.json();
    } catch (e) {
      console.error('Asset config load failed:', e);
      fatalError('Could not load hairstyles', 'The hairstyle configuration file is missing or invalid.');
      throw e;
    }
  }

  function renderStrip() {
    els.strip.innerHTML = '';

    // "None" option first
    const none = document.createElement('div');
    none.className = 'thumb none' + (state.selectedId === null ? ' active' : '');
    none.textContent = 'None';
    none.onclick = () => selectHairstyle(null);
    els.strip.appendChild(none);

    for (const h of state.hairstyles) {
      const t = document.createElement('div');
      t.className = 'thumb' + (state.selectedId === h.id ? ' active' : '');
      const img = document.createElement('img');
      img.src = h.thumbnailUrl || h.assetUrl;
      img.alt = h.name;
      img.onerror = () => { img.remove(); t.textContent = h.name; t.classList.add('none'); };
      const label = document.createElement('span');
      label.className = 'thumb-label';
      label.textContent = h.name;
      t.appendChild(img); t.appendChild(label);
      t.onclick = () => selectHairstyle(h.id);
      els.strip.appendChild(t);
    }
  }

  function selectedAsset() {
    return state.hairstyles.find(h => h.id === state.selectedId) || null;
  }

  function selectHairstyle(id) {
    state.selectedId = id;
    renderStrip();
    const asset = selectedAsset();
    if (asset) {
      // Seed calibration sliders from this asset's config
      els.cScale.value = asset.scaleFactor;
      els.cOffY.value  = asset.offsetY;
      els.cOffX.value  = asset.offsetX;
      syncCalibLabels();
      loadHairTexture(asset);
    } else {
      clearHairTexture();
    }
  }

  /* ----------------------------------------------------------------------
     Three.js scene  (HairstyleRendererService equivalent)
     ---------------------------------------------------------------------- */
  function initThree() {
    const renderer = new THREE.WebGLRenderer({
      canvas: els.overlay, alpha: true, antialias: true, preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Orthographic camera: a normalized -1..1 space mapped to the viewport,
    // so face-tracking coords (also normalized) map cleanly onto the plane.
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 5;

    const scene = new THREE.Scene();

    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, opacity: 1 });
    const hairMesh = new THREE.Mesh(geometry, material);
    hairMesh.visible = false;
    scene.add(hairMesh);

    state.three = { renderer, scene, camera, hairMesh, currentTexture: null, aspect: 1 };
    resizeRenderer();
    window.addEventListener('resize', resizeRenderer);
  }

  function resizeRenderer() {
    if (!state.three) return;
    const { renderer, camera } = state.three;
    const w = els.stage.clientWidth, h = els.stage.clientHeight;
    renderer.setSize(w, h, false);
    // Keep camera frustum at -1..1 vertically; widen horizontally by aspect
    const aspect = w / h;
    state.three.aspect = aspect;
    camera.left = -aspect; camera.right = aspect;
    camera.top = 1; camera.bottom = -1;
    camera.updateProjectionMatrix();
  }

  function loadHairTexture(asset) {
    clearHairTexture();
    setStatus('Loading style…');
    new THREE.TextureLoader().load(
      asset.assetUrl,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        const mat = state.three.hairMesh.material;
        mat.map = texture; mat.needsUpdate = true;
        state.three.currentTexture = texture;
        // Preserve PNG aspect ratio on the plane
        const img = texture.image;
        state.three.texAspect = img && img.height ? img.width / img.height : 1;
        setStatus(state.tracking.detected ? 'Tracking' : 'Find your face',
                  state.tracking.detected ? 'ok' : 'searching');
      },
      undefined,
      () => fatalError('Asset failed to load', 'Could not load hairstyle image: ' + asset.assetUrl)
    );
  }

  function clearHairTexture() {
    if (!state.three) return;
    const mat = state.three.hairMesh.material;
    if (state.three.currentTexture) { state.three.currentTexture.dispose(); state.three.currentTexture = null; }
    mat.map = null; mat.needsUpdate = true;
    state.three.hairMesh.visible = false;
  }

  /* ----------------------------------------------------------------------
     Transform: tracking state -> hair mesh  (Transform Logic in the guide)
     ---------------------------------------------------------------------- */
  function updateHairTransform() {
    const t = state.three;
    if (!t || !t.currentTexture) return;
    const tr = state.tracking;

    if (!tr.detected || tr.confidence < CONFIDENCE_THRESHOLD) {
      t.hairMesh.visible = false;
      return;
    }

    const scaleFactor = parseFloat(els.cScale.value);
    const offsetY     = parseFloat(els.cOffY.value);
    const offsetX     = parseFloat(els.cOffX.value);

    const baseScale = tr.scale * scaleFactor;
    const texAspect = t.texAspect || 1;

    t.hairMesh.visible = true;
    t.hairMesh.position.set(tr.x + offsetX, tr.y + offsetY, 0);
    // scale.x carries the texture aspect so the PNG isn't stretched
    t.hairMesh.scale.set(baseScale * texAspect, baseScale, 1);
    t.hairMesh.rotation.set(0, 0, tr.rotationZ);
  }

  /* ----------------------------------------------------------------------
     MediaPipe FaceMesh -> normalized tracking state
     (JeelizFaceTrackerService equivalent — we use MediaPipe here)
     ---------------------------------------------------------------------- */
  // Landmark indices: 10=top forehead, 152=chin, 234=right cheek, 454=left cheek
  function onFaceResults(results) {
    const faces = results.multiFaceLandmarks;
    if (!faces || faces.length === 0) {
      state.tracking.detected = false;
      state.tracking.confidence = 0;
      updateHint();
      return;
    }
    const lm = faces[0];

    // MediaPipe gives normalized [0,1] coords (x right, y down) on the *unmirrored* frame.
    // Our render space is -aspect..aspect (x) and 1..-1 (y), and the view is mirrored via CSS.
    const aspect = state.three.aspect;

    const top    = lm[10];   // forehead top
    const chin   = lm[152];
    const left   = lm[234];  // subject's right cheek
    const right  = lm[454];  // subject's left cheek

    const cx = (left.x + right.x) / 2;
    const cy = (top.y + chin.y) / 2;

    const faceWidth  = Math.hypot(right.x - left.x, right.y - left.y);
    const faceHeight = Math.hypot(chin.x - top.x, chin.y - top.y);

    // Map normalized [0,1] center to render coords.
    // x: 0..1 -> -aspect..aspect ; y flipped: 0..1 -> 1..-1
    const x = (cx * 2 - 1) * aspect;
    const y = -(cy * 2 - 1);

    // Scale: face width fraction of frame -> world units. faceWidth ~0..1.
    const scale = faceWidth * 2 * aspect;

    // Head roll: angle of the eye/cheek line. Negate for mirrored view.
    const roll = Math.atan2(right.y - left.y, right.x - left.x);

    state.tracking = {
      detected: true,
      confidence: 1, // FaceMesh doesn't expose a per-frame score; presence => confident
      x, y, scale,
      rotationZ: -roll,
      faceWidth, faceHeight,
    };
    updateHint();
  }

  function updateHint() {
    const ok = state.tracking.detected && state.tracking.confidence >= CONFIDENCE_THRESHOLD;
    els.faceHint.classList.toggle('hidden', ok);
    if (ok) setStatus('Tracking', 'ok');
    else setStatus('Find your face', 'searching');
  }

  /* ----------------------------------------------------------------------
     Camera + render loop  (CameraService + render loop)
     ---------------------------------------------------------------------- */
  async function startCamera() {
    setLoading('Requesting camera…');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
        fatalError('Camera permission denied',
          'Camera permission is required to try hairstyles. Please allow camera access and reload the page.');
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError' || err.name === 'OverconstrainedError') {
        fatalError('No camera found',
          'No camera was detected on this device. Open this page on a phone (or a laptop with a webcam) and allow camera access to try on hairstyles.');
      } else {
        fatalError('Camera error', err.message || String(err));
      }
      throw err;
    }
    state.stream = stream;

    const v = els.video;
    // iOS Safari needs these set as properties before play()
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.muted = true;
    v.srcObject = stream;

    // Wait for metadata, but don't hang if it already fired.
    await new Promise((resolve) => {
      if (v.readyState >= 1 && v.videoWidth > 0) return resolve();
      const done = () => { v.removeEventListener('loadedmetadata', done); resolve(); };
      v.addEventListener('loadedmetadata', done);
      // Safety timeout: proceed even if the event is flaky on some mobiles
      setTimeout(resolve, 2500);
    });

    // Try to play. On mobile this can reject if not from a gesture —
    // fall back to a tap-to-start overlay so the user gesture unblocks it.
    try {
      await v.play();
    } catch (e) {
      await waitForTapToStart();
      try { await v.play(); } catch (_) {}
    }
  }

  // Shows a tap prompt; resolves on first tap (provides the user gesture iOS wants).
  function waitForTapToStart() {
    return new Promise((resolve) => {
      setLoading(null);
      let tap = document.getElementById('tapStart');
      if (!tap) {
        tap = document.createElement('div');
        tap.id = 'tapStart';
        tap.style.cssText =
          'position:absolute;inset:0;z-index:30;display:flex;align-items:center;' +
          'justify-content:center;flex-direction:column;gap:14px;color:#fff;' +
          'background:rgba(11,13,18,0.85);font-size:16px;text-align:center;padding:24px;';
        tap.innerHTML = '<div style="font-size:40px">📷</div>' +
          '<div>Tap anywhere to start the camera</div>';
        els.stage.appendChild(tap);
      }
      tap.style.display = 'flex';
      const handler = () => {
        tap.removeEventListener('click', handler);
        tap.style.display = 'none';
        resolve();
      };
      tap.addEventListener('click', handler);
    });
  }

  function initFaceMesh() {
    const faceMesh = new FaceMesh({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/${file}`,
    });
    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: false,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    faceMesh.onResults(onFaceResults);
    state.faceMesh = faceMesh;
  }

  function startLoop() {
    if (state.rafRunning) return;
    state.rafRunning = true;

    let sending = false;
    let frames = 0;
    let trackerErr = '';
    const tick = async () => {
      if (!state.rafRunning) return;

      // Feed the latest video frame to FaceMesh (skip if previous still processing)
      if (!sending && els.video.readyState >= 2) {
        sending = true;
        try { await state.faceMesh.send({ image: els.video }); }
        catch (e) { trackerErr = (e && e.message) ? e.message : String(e); }
        sending = false;
      }

      updateHairTransform();
      state.three.renderer.render(state.three.scene, state.three.camera);

      if (state.debug && (++frames % 15 === 0)) updateDebug(trackerErr);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function updateDebug(trackerErr) {
    let d = document.getElementById('dbg');
    if (!d) {
      d = document.createElement('div');
      d.id = 'dbg';
      d.style.cssText = 'position:absolute;top:56px;left:8px;z-index:9;font:11px monospace;' +
        'color:#9effa0;background:rgba(0,0,0,0.6);padding:6px 8px;border-radius:8px;' +
        'white-space:pre;pointer-events:none;max-width:90%;';
      els.stage.appendChild(d);
    }
    const v = els.video;
    d.textContent =
      `video: ${v.videoWidth}x${v.videoHeight} ready=${v.readyState} paused=${v.paused}\n` +
      `face: ${state.tracking.detected ? 'YES' : 'no'} conf=${state.tracking.confidence}\n` +
      `THREE=${typeof THREE} FaceMesh=${typeof FaceMesh}\n` +
      `trackerErr: ${trackerErr || '—'}`;
  }

  /* ----------------------------------------------------------------------
     Capture  (CaptureService equivalent)
     ---------------------------------------------------------------------- */
  function capture() {
    const w = els.stage.clientWidth, h = els.stage.clientHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');

    // Mirror to match the on-screen selfie view
    ctx.save();
    ctx.translate(w, 0); ctx.scale(-1, 1);

    // 1) camera frame (object-fit: cover emulation)
    drawCover(ctx, els.video, w, h);
    // 2) overlay (Three.js canvas — same pixel space)
    ctx.drawImage(els.overlay, 0, 0, w, h);
    ctx.restore();

    const dataUrl = canvas.toDataURL('image/png');
    els.captureImg.src = dataUrl;
    els.btnDownload.href = dataUrl;
    els.captureOverlay.hidden = false;
  }

  // Emulate CSS object-fit: cover for the video frame
  function drawCover(ctx, video, w, h) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.max(w / vw, h / vh);
    const dw = vw * scale, dh = vh * scale;
    ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  /* ----------------------------------------------------------------------
     UI wiring
     ---------------------------------------------------------------------- */
  function syncCalibLabels() {
    els.vScale.textContent = parseFloat(els.cScale.value).toFixed(2);
    els.vOffY.textContent  = parseFloat(els.cOffY.value).toFixed(2);
    els.vOffX.textContent  = parseFloat(els.cOffX.value).toFixed(2);
  }

  function wireUI() {
    [els.cScale, els.cOffY, els.cOffX].forEach(s => s.addEventListener('input', syncCalibLabels));
    els.btnCalib.onclick = () => els.calib.classList.toggle('show');
    els.btnCapture.onclick = capture;
    els.btnReset.onclick = () => {
      selectHairstyle(null);
      els.calib.classList.remove('show');
    };
    els.btnCloseCapture.onclick = () => { els.captureOverlay.hidden = true; };
  }

  /* ----------------------------------------------------------------------
     Cleanup  (page destroy)
     ---------------------------------------------------------------------- */
  function cleanup() {
    state.rafRunning = false;
    if (state.stream) state.stream.getTracks().forEach(t => t.stop());
    if (state.faceMesh && state.faceMesh.close) try { state.faceMesh.close(); } catch (e) {}
    if (state.three) {
      clearHairTexture();
      state.three.hairMesh.geometry.dispose();
      state.three.hairMesh.material.dispose();
      state.three.renderer.dispose();
    }
  }
  window.addEventListener('beforeunload', cleanup);
  window.addEventListener('pagehide', cleanup);

  /* ----------------------------------------------------------------------
     Boot
     ---------------------------------------------------------------------- */
  async function main() {
    // Debug mode: open ...?debug=1  OR tap the status chip 3x
    state.debug = new URLSearchParams(location.search).has('debug');
    let chipTaps = 0;
    els.statusChip.addEventListener('click', () => {
      if (++chipTaps >= 3) { state.debug = true; }
    });

    if (!checkEnvironment()) return;
    wireUI();

    try {
      setLoading('Loading hairstyles…');
      await loadHairstyles();
      renderStrip();

      setLoading('Initializing renderer…');
      initThree();

      setLoading('Loading face tracker…');
      initFaceMesh();

      await startCamera();

      setLoading('Warming up…');
      startLoop();

      // Auto-select first hairstyle so the demo shows something immediately
      if (state.hairstyles.length) selectHairstyle(state.hairstyles[0].id);

      setLoading(null);
      setStatus('Find your face', 'searching');
    } catch (e) {
      console.error(e);
      // fatalError already shown in most paths
    }
  }

  main();
})();
