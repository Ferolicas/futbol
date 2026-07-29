'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import BrandLogoMedia from '../../../components/BrandLogoMedia';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export default function AnalysisSceneModal({
  children,
  onClose,
  sceneSelector,
  variant = 'football',
  bodyClassName = '',
  ariaLabel = 'Análisis completo',
}) {
  const shellRef = useRef(null);
  const stageRef = useRef(null);
  const scrollRef = useRef(null);
  const closeRef = useRef(null);
  const scenesRef = useRef([]);
  const progressRef = useRef(0);
  const activeSceneRef = useRef(-1);
  const touchYRef = useRef(null);
  const [activeScene, setActiveScene] = useState(0);
  const [sceneCount, setSceneCount] = useState(0);

  const paintProgress = useCallback((requestedProgress) => {
    const scenes = scenesRef.current;
    if (scenes.length === 0) return;

    const progress = clamp(requestedProgress, 0, scenes.length - 1);
    const nearest = Math.round(progress);
    progressRef.current = progress;

    if (nearest !== activeSceneRef.current) {
      activeSceneRef.current = nearest;
      setActiveScene(nearest);

      scenes.forEach((scene, index) => {
        const isActive = index === nearest;

        scene.classList.add('analysis-apple-scene');
        scene.classList.toggle('is-scene-active', isActive);
        scene.style.setProperty('--analysis-scene-opacity', isActive ? '1' : '0');
        scene.setAttribute('aria-hidden', isActive ? 'false' : 'true');
        if ('inert' in scene) scene.inert = !isActive;

        Array.from(scene.children).forEach((piece, pieceIndex) => {
          piece.classList.add('analysis-apple-piece');
          piece.style.setProperty('--analysis-piece-index', String(Math.min(pieceIndex, 10)));
        });
      });
    }

    const percent = scenes.length <= 1 ? 100 : (progress / (scenes.length - 1)) * 100;
    shellRef.current?.style.setProperty('--analysis-progress', `${percent.toFixed(2)}%`);
  }, []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus({ preventScroll: true });

    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose]);

  useEffect(() => {
    const shell = shellRef.current;
    const stage = stageRef.current;
    const scroller = scrollRef.current;
    if (!shell || !stage || !scroller) return undefined;

    let syncFrame;
    let pointerGestureActive = false;
    let pointerCaptured = false;
    let activePointerId = null;
    let pointerY = null;
    let touchMode = null;
    const userAgent = window.navigator.userAgent;
    const isAppleTouchDevice =
      /iPad|iPhone|iPod/.test(userAgent) ||
      (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
    const syncScenes = () => {
      cancelAnimationFrame(syncFrame);
      syncFrame = requestAnimationFrame(() => {
        const nextScenes = Array.from(shell.querySelectorAll(sceneSelector));
        scenesRef.current = nextScenes;
        activeSceneRef.current = -1;
        setSceneCount(nextScenes.length);
        if (nextScenes.length > 0) {
          paintProgress(clamp(progressRef.current, 0, nextScenes.length - 1));
        }
      });
    };

    const moveOuterScroll = (delta) => {
      const scenes = scenesRef.current;
      if (scenes.length <= 1) return;

      // El progreso es virtual: no depende del scrollTop nativo, que Safari
      // puede congelar mientras un gesto toca un hijo absoluto/scrollable.
      const sceneTravel = Math.max(96, scroller.clientHeight * .32);
      paintProgress(progressRef.current + delta / sceneTravel);
    };

    const routeScrollDelta = (delta) => {
      const active = scenesRef.current[Math.round(progressRef.current)];
      let remaining = delta;

      if (active) {
        const maxInnerScroll = active.scrollHeight - active.clientHeight;
        if (maxInnerScroll > 2 && delta > 0 && active.scrollTop < maxInnerScroll) {
          const consumed = Math.min(delta, maxInnerScroll - active.scrollTop);
          active.scrollTop += consumed;
          remaining -= consumed;
        } else if (maxInnerScroll > 2 && delta < 0 && active.scrollTop > 0) {
          const consumed = Math.max(delta, -active.scrollTop);
          active.scrollTop += consumed;
          remaining -= consumed;
        }
      }

      if (Math.abs(remaining) >= 1) moveOuterScroll(remaining);
    };

    const canUseNativeInnerScroll = (scene, delta) => {
      if (!scene) return false;
      const maxInnerScroll = scene.scrollHeight - scene.clientHeight;
      if (maxInnerScroll <= 2) return false;
      if (delta > 0) return scene.scrollTop < maxInnerScroll - 1;
      if (delta < 0) return scene.scrollTop > 1;
      return false;
    };

    const onWheel = (event) => {
      let delta = event.deltaY;
      if (event.deltaMode === 1) delta *= 24;
      if (event.deltaMode === 2) delta *= scroller.clientHeight;
      if (Math.abs(delta) < 1) return;

      event.preventDefault();
      routeScrollDelta(delta);
    };

    const onTouchStart = (event) => {
      if (pointerGestureActive) return;
      touchYRef.current = event.touches[0]?.clientY ?? null;
      touchMode = null;
    };

    const onTouchMove = (event) => {
      if (pointerGestureActive) return;
      const nextY = event.touches[0]?.clientY;
      if (nextY == null || touchYRef.current == null) return;
      const delta = touchYRef.current - nextY;
      touchYRef.current = nextY;
      if (Math.abs(delta) < 1) return;

      if (touchMode == null) {
        const active = scenesRef.current[Math.round(progressRef.current)];
        touchMode = canUseNativeInnerScroll(active, delta) ? 'native-inner' : 'virtual';
      }

      // En iPhone el contenido largo conserva durante todo el gesto el scroll
      // cinético nativo de WebKit. Al llegar al borde, un gesto nuevo entra en
      // modo virtual y cambia de escena sin mezclar ambos motores.
      if (touchMode === 'native-inner') return;

      if (event.cancelable) event.preventDefault();
      moveOuterScroll(delta);
    };

    const onTouchEnd = () => {
      touchYRef.current = null;
      touchMode = null;
    };

    const onPointerDown = (event) => {
      if (isAppleTouchDevice) return;
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      pointerGestureActive = true;
      pointerCaptured = false;
      activePointerId = event.pointerId;
      pointerY = event.clientY;
    };

    const onPointerMove = (event) => {
      if (!pointerGestureActive || event.pointerId !== activePointerId || pointerY == null) return;
      const delta = pointerY - event.clientY;
      pointerY = event.clientY;
      if (Math.abs(delta) < 1) return;

      if (!pointerCaptured) {
        try {
          scroller.setPointerCapture(event.pointerId);
          pointerCaptured = true;
        } catch {
          // El movimiento también se escucha en window, así que Safari
          // mantiene el gesto aunque rechace la captura explícita.
        }
      }
      if (event.cancelable) event.preventDefault();
      routeScrollDelta(delta);
    };

    const onPointerEnd = (event) => {
      if (event.pointerId !== activePointerId) return;
      try {
        if (pointerCaptured && scroller.hasPointerCapture(event.pointerId)) {
          scroller.releasePointerCapture(event.pointerId);
        }
      } catch {
        // La captura puede haberse liberado al cancelar el gesto.
      }
      pointerGestureActive = false;
      pointerCaptured = false;
      activePointerId = null;
      pointerY = null;
    };

    const onKeyDown = (event) => {
      const forward = ['ArrowDown', 'PageDown'].includes(event.key) || (event.key === ' ' && !event.shiftKey);
      const backward = ['ArrowUp', 'PageUp'].includes(event.key) || (event.key === ' ' && event.shiftKey);
      if (!forward && !backward && event.key !== 'Home' && event.key !== 'End') return;

      event.preventDefault();
      if (event.key === 'Home') paintProgress(0);
      else if (event.key === 'End') paintProgress(Math.max(0, scenesRef.current.length - 1));
      else moveOuterScroll(scroller.clientHeight * (forward ? .32 : -.32));
    };

    syncScenes();
    const observer = new MutationObserver(syncScenes);
    observer.observe(stage, { childList: true, subtree: true });
    scroller.addEventListener('wheel', onWheel, { passive: false, capture: true });
    scroller.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true });
    window.addEventListener('pointermove', onPointerMove, { passive: false, capture: true });
    window.addEventListener('pointerup', onPointerEnd, { passive: true, capture: true });
    window.addEventListener('pointercancel', onPointerEnd, { passive: true, capture: true });
    scroller.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    scroller.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    scroller.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
    scroller.addEventListener('touchcancel', onTouchEnd, { passive: true, capture: true });
    scroller.addEventListener('keydown', onKeyDown);

    return () => {
      cancelAnimationFrame(syncFrame);
      observer.disconnect();
      scroller.removeEventListener('wheel', onWheel, true);
      scroller.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerEnd, true);
      window.removeEventListener('pointercancel', onPointerEnd, true);
      scroller.removeEventListener('touchstart', onTouchStart, true);
      scroller.removeEventListener('touchmove', onTouchMove, true);
      scroller.removeEventListener('touchend', onTouchEnd, true);
      scroller.removeEventListener('touchcancel', onTouchEnd, true);
      scroller.removeEventListener('keydown', onKeyDown);
    };
  }, [paintProgress, sceneSelector]);

  const baseball = variant === 'baseball';

  return (
    <div
      className={`analysis-native-modal ${baseball ? 'is-baseball' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <button className="analysis-native-backdrop" onClick={onClose} aria-label="Cerrar análisis" />
      <section
        className={`analysis-native-shell ${baseball ? 'is-baseball' : ''}`}
        ref={shellRef}
      >
        <header className="analysis-native-header">
          <div className="analysis-native-brand is-logo-only">
            <BrandLogoMedia />
          </div>
          <button
            ref={closeRef}
            className="analysis-native-close"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <X size={18} aria-hidden="true" />
          </button>
          <span className="analysis-native-progress" aria-hidden="true">
            <i />
          </span>
        </header>

        <div
          ref={scrollRef}
          className={`analysis-native-body ${bodyClassName}`.trim()}
          aria-label={sceneCount > 0 ? `Contenido ${activeScene + 1} de ${sceneCount}` : 'Preparando análisis'}
          tabIndex={0}
        >
          <div className="analysis-native-fixed-stage">
            <div ref={stageRef} className="analysis-native-stage-content">
              {children}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
