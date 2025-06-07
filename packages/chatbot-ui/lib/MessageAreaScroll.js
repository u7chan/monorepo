import { j as jsxRuntimeExports } from "./MarkdownRenderer.js";
import { r as reactExports } from "./useTheme.js";
reactExports.forwardRef(
  function MessageAreaScroll2({ children, scrollContainerRef, onScroll }, ref) {
    return /* @__PURE__ */ jsxRuntimeExports.jsxs(
      "div",
      {
        ref: scrollContainerRef,
        className: "flex flex-1 flex-col overflow-y-auto p-4",
        onScroll,
        children: [
          children,
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { ref })
        ]
      }
    );
  }
);
//# sourceMappingURL=MessageAreaScroll.js.map
