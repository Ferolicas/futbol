'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

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
  const [activeScene, setActiveScene] = useState(0);
  const [sceneCount, setSceneCount] = useState(0);

  const paintProgress = useCallback((requestedProgress) => {
    const scenes = scenesRef.current;
    if (scenes.length === 0) return;

    const progress = clamp(requestedProgress, 0, scenes.length - 1);
    const nearest = Math.round(progress);
    progressRef.current = progress;
    setActiveScene(nearest);

    scenes.forEach((scene, index) => {
      const distance = index - progress;
      const absoluteDistance = Math.abs(distance);
      const opacity = clamp(1 - absoluteDistance * 1.08, 0, 1);
      const shift = clamp(distance * 7, -10, 10);
      const scale = 1 - Math.min(absoluteDistance, 1) * 0.035;
      const blur = Math.min(absoluteDistance * 8, 10);
      const isActive = index === nearest;

      scene.classList.add('analysis-apple-scene');
      scene.classList.toggle('is-scene-active', isActive);
      scene.style.setProperty('--analysis-scene-opacity', opacity.toFixed(3));
      scene.style.setProperty('--analysis-scene-shift', `${shift.toFixed(3)}%`);
      scene.style.setProperty('--analysis-scene-scale', scale.toFixed(4));
      scene.style.setProperty('--analysis-scene-blur', `${blur.toFixed(2)}px`);
      scene.setAttribute('aria-hidden', isActive ? 'false' : 'true');
      if ('inert' in scene) scene.inert = !isActive;

      Array.from(scene.children).forEach((piece, pieceIndex) => {
        piece.classList.add('analysis-apple-piece');
        piece.style.setProperty('--analysis-piece-index', String(Math.min(pieceIndex, 10)));
      });
    });

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
    let scrollFrame;
    const syncScenes = () => {
      cancelAnimationFrame(syncFrame);
      syncFrame = requestAnimationFrame(() => {
        const nextScenes = Array.from(shell.querySelectorAll(sceneSelector));
        scenesRef.current = nextScenes;
        setSceneCount(nextScenes.length);
        if (nextScenes.length > 0) {
          paintProgress(clamp(progressRef.current, 0, nextScenes.length - 1));
        }
      });
    };

    const readNativeScroll = () => {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(() => {
        const scenes = scenesRef.current;
        if (scenes.length === 0) return;
        const maxScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
        const progress = (scroller.scrollTop / maxScroll) * Math.max(0, scenes.length - 1);
        paintProgress(progress);
      });
    };

    const onKeyDown = (event) => {
      const forward = ['ArrowDown', 'PageDown'].includes(event.key) || (event.key === ' ' && !event.shiftKey);
      const backward = ['ArrowUp', 'PageUp'].includes(event.key) || (event.key === ' ' && event.shiftKey);
      if (!forward && !backward && event.key !== 'Home' && event.key !== 'End') return;

      event.preventDefault();
      if (event.key === 'Home') scroller.scrollTo({ top: 0, behavior: 'auto' });
      else if (event.key === 'End') scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
      else scroller.scrollBy({ top: scroller.clientHeight * (forward ? .5 : -.5), behavior: 'auto' });
    };

    syncScenes();
    const observer = new MutationObserver(syncScenes);
    observer.observe(stage, { childList: true, subtree: true });
    scroller.addEventListener('scroll', readNativeScroll, { passive: true });
    scroller.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', readNativeScroll, { passive: true });

    return () => {
      cancelAnimationFrame(syncFrame);
      cancelAnimationFrame(scrollFrame);
      observer.disconnect();
      scroller.removeEventListener('scroll', readNativeScroll);
      scroller.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', readNativeScroll);
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
            <video autoPlay muted loop playsInline preload="auto" aria-label="CF Análisis">
              <source src="/logo-metalizado.webm" type="video/webm" />
            </video>
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
          <div
            className="analysis-native-scroll-spacer"
            style={{ height: `${Math.max(0, sceneCount - 1) * 48}dvh` }}
            aria-hidden="true"
          />
        </div>
      </section>
    </div>
  );
}
