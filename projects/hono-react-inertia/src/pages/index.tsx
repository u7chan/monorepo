import type { Page } from "@inertiajs/core"
import type { Child } from "hono/jsx"

import AboutPage from "./about"
import RootPage from "./root"
import UserShowPage, { type UserShowProps } from "./user-show"

export type PageComponent = (props: Page["props"]) => Child

const pages: Record<string, PageComponent> = {
  About: AboutPage,
  Root: RootPage,
  UserShow: (props) => <UserShowPage {...(props as unknown as UserShowProps)} />,
}

export const resolvePageComponent = (name: string) => {
  const component = pages[name]

  if (!component) {
    throw new Error(`Unknown page: ${name}`)
  }

  return component
}
