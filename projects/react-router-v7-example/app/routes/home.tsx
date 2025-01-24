import type { Route } from "./+types/home";
import { Welcome } from "~/components/welcome/welcome";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "New React Router App" },
    { name: "description", content: "Welcome to React Router!" },
  ];
}

export default function Page() {
  return <Welcome />;
}
