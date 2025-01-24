import type { Route } from "./+types/home";
import { About } from "~/components/about/about";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "New React Router App" },
    { name: "description", content: "About" },
  ];
}

export default function Page() {
  return <About />;
}
