import { getInitialPageFromDOM, router, setupProgress, type Page } from "@inertiajs/core"
import { createRoot } from "hono/jsx/dom/client"

import { resolvePageComponent, type PageComponent } from "./pages"

const bootstrap = () => {
  const el = document.getElementById("app")
  const initialPage = getInitialPageFromDOM<Page>("app")

  if (!el) {
    throw new Error("Inertia root element was not found")
  }

  if (!initialPage) {
    throw new Error("Inertia initial page was not found")
  }

  const root = createRoot(el)

  const render = (Component: PageComponent, page: Page) => {
    root.render(Component(page.props))
  }

  router.init<PageComponent>({
    initialPage,
    resolveComponent: resolvePageComponent,
    swapComponent: async ({ component, page }) => {
      render(component, page)
    },
  })

  setupProgress()
  render(resolvePageComponent(initialPage.component), initialPage)
}

bootstrap()
