// Replaces the profile photo with a 3D gaussian-splat reconstruction of the same
// head, rendered with Spark (https://sparkjs.dev).
//
// Strictly a progressive enhancement: profile.png stays as the background of
// .profile-picture and is what you see if anything here declines to run --
// no WebGL2, no ES modules, CDN blocked, fetch failure, decode failure. The
// canvas only fades in once the splat is actually on screen, so a failure is
// invisible rather than a broken frame.
//
// Cost control, in rough order of how much it matters:
//   * nothing is fetched or allocated until the headshot scrolls into view
//   * the render loop stops when off screen or when the tab is hidden -- a splat
//     renderer re-sorts by depth every frame, so an idle loop is pure waste
//   * device pixel ratio is capped at 2 (a 160px box needs no more)
//
// Interaction: drag to rotate on desktop, device tilt on mobile, no zoom.
// Vertical touch drags are left to the page so scrolling still works.

import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

const SPLAT_URL = "david.spz";

// Tuned by hand against the live page. Angles in degrees, distances in the
// splat's own units.
const VIEW = {
  fit: 0.445,        // vertical extent of the head to fill the frame with
  targetY: -0.055,   // look-at height
  fov: 24,           // longer lens than default; less nose distortion
  baseYaw: 0,
  basePitch: 10,     // camera sits above eye level, looking slightly down
  yawAmp: 8,         // idle sweep, +/- degrees
  pitchAmp: 4,
  pitchSkew: 0.55,   // 0 = plain sine, 1 = fully lopsided drift
  period: 6,         // seconds per yaw cycle
};

// Head centre in splat-local coords, read off the file's own geometry: the neck
// is the narrowest horizontal slab, at y = -0.09, and the head sits above it.
const HEAD_X = -0.018;
const HEAD_Z = 0.05;

// The reconstruction was captured from a frontal arc, so there is no valid
// geometry behind the head. Keep the camera inside the observed cone.
const YAW_LIMIT = 42;
const PITCH_LIMIT = 22;

const host = document.querySelector(".profile-picture");
if (host && supported()) {
  start(host).catch(() => teardown());
}

function supported() {
  // WebGL2 is what Spark needs; probe without keeping the context around.
  try {
    const probe = document.createElement("canvas").getContext("webgl2");
    if (!probe) return false;
    probe.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

let canvas = null;

function teardown() {
  canvas?.remove();
  canvas = null;
}

async function start(host) {
  // Wait until the headshot is actually on screen before spending anything.
  await visible(host);

  canvas = document.createElement("canvas");
  canvas.className = "profile-splat";
  canvas.setAttribute("aria-hidden", "true");
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  const camera = new THREE.PerspectiveCamera(VIEW.fov, 1, 0.01, 100);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setClearColor(0xffffff, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const spark = new SparkRenderer({ renderer });
  scene.add(spark);

  const splat = new SplatMesh({ url: SPLAT_URL });
  scene.add(splat);
  await splat.initialized;

  resize();
  window.addEventListener("resize", resize, { passive: true });

  function resize() {
    const side = Math.max(host.clientWidth, 1);
    renderer.setSize(side, side, false);
    camera.aspect = 1;
    camera.updateProjectionMatrix();
  }

  // ---- input -------------------------------------------------------------
  // A user-driven offset on top of the idle orbit, eased back to rest when let go.
  const offset = { yaw: 0, pitch: 0 };
  const drag = { active: false, x: 0, y: 0 };

  canvas.addEventListener("pointerdown", (e) => {
    drag.active = true;
    drag.x = e.clientX;
    drag.y = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!drag.active) return;
    offset.yaw = clamp(offset.yaw + (e.clientX - drag.x) * 0.32, -YAW_LIMIT, YAW_LIMIT);
    // Vertical drags are only ours on a mouse; on touch the page keeps them for
    // scrolling (see touch-action in the stylesheet), and tilt supplies pitch.
    if (e.pointerType === "mouse") {
      offset.pitch = clamp(offset.pitch - (e.clientY - drag.y) * 0.28, -PITCH_LIMIT, PITCH_LIMIT);
    }
    drag.x = e.clientX;
    drag.y = e.clientY;
  });

  for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
    canvas.addEventListener(type, () => { drag.active = false; });
  }

  // Device tilt, relative to however the phone happens to be held. On iOS this
  // needs an explicit permission grant, which we deliberately do not prompt for
  // -- a modal dialog over a headshot is worse than no tilt, and dragging still
  // works there.
  const tilt = { on: false, yaw: 0, pitch: 0, baseGamma: null, baseBeta: null };

  window.addEventListener("deviceorientation", (e) => {
    if (e.gamma === null || e.beta === null) return;
    if (tilt.baseGamma === null) { tilt.baseGamma = e.gamma; tilt.baseBeta = e.beta; }
    tilt.on = true;
    tilt.yaw = clamp((e.gamma - tilt.baseGamma) * 0.9, -YAW_LIMIT, YAW_LIMIT);
    tilt.pitch = clamp(-(e.beta - tilt.baseBeta) * 0.5, -PITCH_LIMIT, PITCH_LIMIT);
  }, { passive: true });

  // ---- run only when it can be seen --------------------------------------
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let onScreen = true;
  let running = false;
  let clock = 0;
  let last = 0;

  new IntersectionObserver((entries) => {
    onScreen = entries[entries.length - 1].isIntersecting;
    sync();
  }, { rootMargin: "80px" }).observe(host);

  document.addEventListener("visibilitychange", sync);

  function sync() {
    const want = onScreen && !document.hidden;
    if (want === running) return;
    running = want;
    renderer.setAnimationLoop(want ? frame : null);
    last = 0;
  }

  function frame(now) {
    // Drive the orbit off elapsed time, not wall clock, so pausing does not
    // teleport the head on resume.
    if (last) clock += Math.min((now - last) / 1000, 0.1);
    last = now;

    if (!drag.active) {
      const k = Math.pow(0.02, 1 / 60);
      offset.yaw *= k;
      offset.pitch *= k;
    }

    let yaw = VIEW.baseYaw;
    let pitch = VIEW.basePitch;

    // Idle drift, suppressed for anyone who has asked for less motion. Their
    // own dragging and tilting still moves it -- that is user-initiated.
    if (!reduceMotion.matches) {
      const w = (2 * Math.PI) / VIEW.period;
      yaw += Math.sin(clock * w) * VIEW.yawAmp;

      // Two sines at an irrational frequency ratio, the second squared with its
      // sign kept. It lingers low and spikes up only occasionally, so the drift
      // never mirrors itself or visibly repeats.
      const a = Math.sin(clock * w * 0.618 + 1.1);
      const b = Math.sin(clock * w * 0.271 + 2.7);
      const skewed = 0.62 * a + 0.38 * b * b * Math.sign(b) + 0.22;
      pitch += ((1 - VIEW.pitchSkew) * a + VIEW.pitchSkew * skewed) * VIEW.pitchAmp;
    }

    yaw += offset.yaw + (tilt.on ? tilt.yaw : 0);
    pitch += offset.pitch + (tilt.on ? tilt.pitch : 0);

    const dist = (VIEW.fit / 2) / Math.tan(THREE.MathUtils.degToRad(VIEW.fov) / 2);
    const ry = THREE.MathUtils.degToRad(yaw);
    const rp = THREE.MathUtils.degToRad(pitch);

    // Camera orbits on the -Z side, the direction the face looks.
    camera.position.set(
      HEAD_X + dist * Math.cos(rp) * Math.sin(ry),
      VIEW.targetY + dist * Math.sin(rp),
      HEAD_Z - dist * Math.cos(rp) * Math.cos(ry),
    );
    camera.lookAt(HEAD_X, VIEW.targetY, HEAD_Z);

    renderer.render(scene, camera);
  }

  // First frame drawn before the fade, so the photo never crossfades to blank.
  frame(performance.now());
  canvas.classList.add("ready");
  sync();
}

function visible(el) {
  return new Promise((resolve) => {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); resolve(); }
    }, { rootMargin: "200px" });
    io.observe(el);
  });
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
