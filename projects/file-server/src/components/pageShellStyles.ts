/**
 * Why not express these rules as Tailwind utilities: `::-webkit-scrollbar`,
 * the `@supports selector()` fallback and the pseudo-element resets have no
 * utility form, and the platform scrollbar must be replaced once per document.
 */
export const pageShellStyles = `
.image-viewer-img {
  height: -webkit-fill-available;
  height: -moz-available;
  height: stretch;
}

.pdf-viewer-shell {
  min-height: 0;
}

.pdf-viewer-frame {
  display: block;
  min-height: min(72vh, 56rem);
}

@keyframes modal-enter {
  from {
    opacity: 0;
    transform: translateY(4px) scale(0.99);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.modal-enter {
  animation: modal-enter 0.15s ease-out;
}

@media (prefers-reduced-motion: reduce) {
  .modal-enter {
    animation: none;
  }
}

/* The native Windows scrollbar draws stepper arrows on a square track
   that runs into the rounded corners of the surface behind it. Paint a
   thin, buttonless scrollbar instead: transparent track, rounded
   slate-300 thumb, inset from the track ends so the thumb stays clear
   of those corners. */
*::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

*::-webkit-scrollbar-track {
  margin: 6px 0;
  background: transparent;
}

*::-webkit-scrollbar-corner {
  background: transparent;
}

*::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 9999px;
  background-color: #cbd5e1; /* slate-300 */
  background-clip: content-box;
}

*::-webkit-scrollbar-thumb:hover {
  background-color: #94a3b8; /* slate-400 */
}

*::-webkit-scrollbar-button {
  display: none;
  width: 0;
  height: 0;
}

/* Browsers without ::-webkit-scrollbar (Firefox) get the standard
   properties instead. */
@supports not selector(::-webkit-scrollbar) {
  * {
    scrollbar-width: thin;
    scrollbar-color: #cbd5e1 transparent;
  }
}
`
