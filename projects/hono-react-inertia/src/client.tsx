import { getInitialPageFromDOM, router, setupProgress, type Page } from "@inertiajs/core"
import type { Child } from "hono/jsx"
import { createRoot } from "hono/jsx/dom/client"

import AboutPage from "./pages/about"
import RootPage from "./pages/root"
import UserShowPage, { type UserShowProps } from "./pages/user-show"

type PageComponent = (props: Page["props"]) => Child

const pages: Record<string, PageComponent> = {
  About: AboutPage,
  Root: RootPage,
  UserShow: (props) => <UserShowPage {...(props as unknown as UserShowProps)} />,
}

const el = document.getElementById("app")
const initialPage = getInitialPageFromDOM<Page>("app")

if (!el) {
  throw new Error("Inertia root element was not found")
}

if (!initialPage) {
  throw new Error("Inertia initial page was not found")
}

const root = createRoot(el)

const resolveComponent = (name: string) => {
  const page = pages[name as keyof typeof pages]

  if (!page) {
    throw new Error(`Unknown page: ${name}`)
  }

  return page
}

const render = (Component: PageComponent, page: Page) => {
  root.render(Component(page.props))
}

router.init<PageComponent>({
  initialPage,
  resolveComponent,
  swapComponent: async ({ component, page }) => {
    render(component, page)
  },
})

setupProgress()
render(resolveComponent(initialPage.component), initialPage)
