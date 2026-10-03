"use client";

import { useEffect, useRef } from "react";

/** Decorative glow and parallax; stays in sync with device and accessibility preferences. */
export function StorySpotlight() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current?.parentElement;
    if (!host) return;
    const media = matchMedia("(min-width: 761px) and (pointer: fine) and (prefers-reduced-motion: no-preference) and (forced-colors: none)");
    let frame = 0;
    const move = (e: PointerEvent) => {
      if (!media.matches) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!media.matches) return;
        const r = host.getBoundingClientRect();
        if (!r.width || !r.height) return;
        host.style.setProperty("--mx", ((e.clientX - r.left) / r.width).toFixed(3));
        host.style.setProperty("--my", ((e.clientY - r.top) / r.height).toFixed(3));
        host.dataset.pointer = "on";
      });
    };
    const leave = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      delete host.dataset.pointer;
      host.style.removeProperty("--mx");
      host.style.removeProperty("--my");
    };
    const detach = () => {
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
    };
    const sync = () => {
      detach();
      leave();
      if (media.matches) {
        host.addEventListener("pointermove", move);
        host.addEventListener("pointerleave", leave);
      }
    };
    media.addEventListener("change", sync);
    sync();
    return () => {
      media.removeEventListener("change", sync);
      detach();
      leave();
    };
  }, []);
  return <div ref={ref} className="login-spotlight" aria-hidden="true" />;
}
